#!/usr/bin/env python3
"""test_blind_guard.py — regression test for runner.py's R3/W51 _blind() (eta-refuter #6982/#6974/#7029,
vj-refuter #7005). The guard is LOADED FROM runner.py's own source (sliced from 'def _blind(w):' to the
next statement and exec'd with the real heldout union injected), so a re-declared copy can never pass
while the real guard is broken — the exact failure mode of 9bb75cf5 (deleted `return any(...)`).
Run: python3 test_blind_guard.py        exit 0 = all pass.
Mutation check: python3 test_blind_guard.py --mutation   (tests a broken copy; must FAIL)."""
import datetime, hashlib, os, re, sys, tempfile

sys.path.insert(0, os.path.expanduser("~/eta-data/drtpqma"))
import heldout as H

RUNNER = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-bulk/runner.py")

def load_blind_from(src):
    """Slice runner.py's _blind(w) block and exec it with the real union + datetime injected."""
    lines = src.splitlines(keepends=True)
    start = next(i for i, l in enumerate(lines) if l.startswith("    def _blind(w):"))
    end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("    q = [w for w in own"))
    block = "".join(lines[start:end])
    indent = len(block) - len(block.lstrip())
    code = "\n".join(l[indent:] if l.strip() else "" for l in block.splitlines())
    union, _ = H.load_union()
    _heldout = H
    _dt = datetime.datetime; _td = datetime.timedelta
    _IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    ns = {"_heldout": _heldout, "_dt": _dt, "_td": _td, "_IST": _IST, "_union": union}
    exec(code, ns)
    return ns["_blind"]

def runner_source():
    return open(RUNNER, "rb").read().decode()

def run_cases(_blind):
    cases = [
        ({"room_id": "room_qyzghzaf", "start": "bad", "end": "2026-09-23T14:15:00+00:00"}, True, "parse error is fail-closed (eta-refuter #6974)"),
        ({"room_id": "room_qyzghzaf", "start": "2026-09-23T02:15:00+00:00", "end": "2026-09-23T02:30:00+00:00"}, True, "23 Sep OPD7 is held out (IST day of start)"),
        ({"room_id": "room_yh3etjpf", "start": "2026-09-22T14:00:00+00:00", "end": "2026-09-22T14:15:00+00:00"}, False, "22 Sep clean window"),
        ({"room_id": "room_qyzghzaf", "start": "2026-09-26T18:15:00+00:00", "end": "2026-09-26T18:30:00+00:00"}, False, "23:45-00:00 IST boundary window is CLEAN (end exclusive, r3 #6927)"),
        ({"room_id": "room_ux92qpws", "start": "2026-09-12T18:45:00+00:00", "end": "2026-09-12T19:00:00+00:00"}, True, "UTC 12 Sep evening = IST 13 Sep OPD4 held out (the 44-file gap class)"),
    ]
    fails = 0
    for w, want, why in cases:
        got = _blind(w)
        ok = got is want
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'}: {why} -> {got}")
    return fails

def main():
    src = runner_source()
    sha = hashlib.sha256(src.encode()).hexdigest()
    _blind = load_blind_from(src)
    print(f"runner.py sha16 at test time: {sha[:16]}")
    fails = run_cases(_blind)
    if "--mutation" in sys.argv:
        broken = re.sub(r"^\s*return any\(_heldout\.is_held_out\(_union, d, w\[.room_id.\]\) for d in days\)\s*$",
                        "        pass  # MUTATION: return deleted", src, flags=re.M)
        if broken == src:
            print("MUTATION-INJECTION FAILED: the return line was not found"); return 1
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write(broken); p = f.name
        mb = load_blind_from(open(p).read())
        os.unlink(p)
        mfails = run_cases(mb)
        print(f"MUTATION: broken guard {'caught (TESTS_OK)' if mfails else 'NOT caught — test is vacuous'}")
        return 0 if mfails else 1
    print("TESTS_OK" if fails == 0 else f"TESTS_FAILED ({fails})")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
