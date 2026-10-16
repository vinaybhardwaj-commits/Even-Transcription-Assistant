"""End to end: the publisher's REAL control_message() goes to the REAL kiosk bash parser (killswitch.sh), sourced from git at the kiosk shas below into a temp dir
(never vendored into the repo). Run under `env -i bash -p`. CTRL_HOLD must be `clear` for a room whose consult_open is false and `set` otherwise; kill, modes and the
fleet verdict must parse exactly as the old form does. A sha that no local repo holds is skipped (the skip names it), so the suite stays portable.
Shas: 81d48a63 = R16b, 5d970126 = R15c (what OPD 6 runs). Extra repos to search: GUARDIAN_KIOSK_REPOS (colon separated paths)."""
import os, re, subprocess, sys, tempfile, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber"))
import subscriber as sb

KIOSK_SHAS = ("81d48a63", "5d970126")
KS_PATH = "tools/room-guardian/kiosk/lib/killswitch.sh"
HARNESS = r'''
STATE_DIR=$1; GUARDIAN_ROOM=$2; CONTROL_LAST=$STATE_DIR/control.last; KS=$3
G_WC=/usr/bin/wc; G_TR=/usr/bin/tr; G_TAIL=/usr/bin/tail; G_SED=/usr/bin/sed; G_CAT=/bin/cat; G_MKDIR=/bin/mkdir; G_DATE=/bin/date
CONTROL_STALE_S=90; CONTROL_SKEW_S=30; CONTROL_MAX_BYTES=4096
now_epoch() { /bin/date +%s; }
. "$KS"
GUARDIAN_CONTROL_SUB_CMD=x
consult_hold_clear; echo "CLEAR_RC=$?"
rm -f "$STATE_DIR/control_latch"
control_parse; echo "RC=$? FLEET=$CTRL_FLEET MODE=$CTRL_MODE WHY=$CTRL_WHY HOLD=$CTRL_HOLD"
'''


def _repo_dirs():
    out = []
    try:
        out.append(subprocess.run(["git", "-C", HERE, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=20).stdout.strip())
    except Exception:                    # noqa: BLE001
        pass
    out += [p for p in os.environ.get("GUARDIAN_KIOSK_REPOS", "").split(":") if p]
    return [p for p in out if p]


def kiosk_source(sha):
    for d in _repo_dirs():
        r = subprocess.run(["git", "-C", d, "show", f"{sha}:{KS_PATH}"], capture_output=True, timeout=20)
        if r.returncode == 0 and r.stdout:
            return r.stdout
    return None


class Clk:
    def __call__(self): return time.time()


class Sink:
    def guardian_quiet(self, *a): pass
    def guardian_recovered(self, *a): pass


class Hold:
    def __init__(self, m): self.m = m
    def hold(self, now=None): return dict(self.m)


class KioskParserE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(); cls.ks = {}
        for sha in KIOSK_SHAS:
            src = kiosk_source(sha)
            if src is not None:
                p = os.path.join(cls.tmp.name, f"killswitch-{sha}.sh"); open(p, "wb").write(src); cls.ks[sha] = p

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def msg(self, rooms, holds, kill, heal=()):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        open(os.path.join(t.name, "kill-switch"), "w").write("on\n" if kill else "off\n")
        os.makedirs(os.path.join(t.name, "modes"))
        for r in heal: open(os.path.join(t.name, "modes", r), "w").write("heal")
        consult = Hold(holds) if holds is not None else None
        return sb.Subscriber(os.path.join(t.name, "d"), t.name, rooms, Sink(), Clk(), consult=consult).control_message()

    def parse(self, ks, msg, room):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        with open(os.path.join(d.name, "control.last"), "w") as f: f.write(f"{int(time.time())}\n{msg}\n")
        r = subprocess.run(["env", "-i", "/bin/bash", "-p", "-c", HARNESS, "h", d.name, room, ks], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr[:300])
        kv = dict(re.findall(r"(\w+)=(\S*)", r.stdout)); return kv

    def each_sha(self):
        for sha in KIOSK_SHAS:
            if sha not in self.ks:
                continue
            yield sha, self.ks[sha]

    def test_at_least_one_kiosk_sha_is_available_or_skip(self):
        if not self.ks: self.skipTest(f"no local repo holds {KIOSK_SHAS}; set GUARDIAN_KIOSK_REPOS")

    def test_new_form_clears_exactly_the_rooms_mapped_false_and_kill_and_modes_match_the_old_form(self):
        if not self.ks: self.skipTest(f"no local repo holds {KIOSK_SHAS}")
        cases = 0
        for n in (0, 1, 64):
            rooms = sorted((f"opd-{i}" if i % 2 else f"r{i}_x") for i in range(n))
            for pattern in ("all_false", "all_true", "mixed"):
                holds = {r: (False if pattern == "all_false" else True if pattern == "all_true" else i % 2 == 0) for i, r in enumerate(rooms)}
                heal = rooms[::3]
                for kill in (False, True):
                    new, old = self.msg(rooms, holds, kill, heal), self.msg(rooms, None, kill, heal)
                    self.assertTrue(new.startswith('{"consult_open": ')); self.assertNotIn("consult_open", old)
                    probe = rooms if n <= 1 else rooms[:3] + rooms[-3:]                     # 64 rooms: first, last and a spread; the room key regexes see all 64
                    for sha, ks in self.each_sha():
                        for room in probe:
                            a, b = self.parse(ks, new, room), self.parse(ks, old, room)
                            for k in ("FLEET", "MODE", "WHY"):
                                self.assertEqual(a[k], b[k], (sha, n, pattern, kill, room, k))   # kill and modes parse as in the old form
                            self.assertEqual(b["HOLD"], "set"); self.assertEqual(b["CLEAR_RC"], "1")   # the old form never clears
                            want_clear = (not kill) and holds[room] is False
                            self.assertEqual(a["HOLD"], "clear" if want_clear else "set", (sha, n, pattern, kill, room))
                            self.assertEqual(a["CLEAR_RC"], "0" if want_clear else "1", (sha, n, pattern, kill, room))
                            if not kill: self.assertEqual(a["MODE"], "heal" if room in heal else "shadow")
                            cases += 1
        self.assertGreaterEqual(cases, 42 * len(self.ks))

    def test_a_room_not_in_the_line_is_held_and_an_empty_line_is_valid(self):
        if not self.ks: self.skipTest(f"no local repo holds {KIOSK_SHAS}")
        for sha, ks in self.each_sha():
            self.assertEqual(self.parse(ks, self.msg(["opd-1"], {"opd-1": False}, False), "opd-9")["HOLD"], "set")
            e = self.msg([], {}, False); self.assertEqual(e[:20], '{"consult_open": {},')
            r = self.parse(ks, e, "opd-1"); self.assertEqual((r["FLEET"], r["WHY"], r["HOLD"]), ("on", "ok", "set"))


if __name__ == "__main__":
    unittest.main()
