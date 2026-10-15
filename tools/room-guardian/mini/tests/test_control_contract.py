"""Frozen control-topic contract (guardian-lead R7). The kiosk accepts ONLY the exact canonical payload; these tests pin the Mini side to it.
KIOSK_RE is copied verbatim from ~/oc/guardian-lead/FR1-C1-CONTROL-CC-KICKOFF-14-OCT-2026.md, section "## R7". Changing the contract needs a coordinated
kiosk release first."""
import json, os, re, sys, tempfile, time, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "subscriber"))
import subscriber as sb

KIOSK_RE = r'^\{"kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$'


class Sink:
    def guardian_quiet(self, *a): pass
    def guardian_recovered(self, *a): pass


class ControlContract(unittest.TestCase):
    def mk(self, rooms, kill, modes=None, clock=time.time):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        open(os.path.join(t.name, "kill-switch"), "w").write("on\n" if kill else "off\n")
        os.makedirs(os.path.join(t.name, "modes"))
        for r, m in (modes or {}).items():
            open(os.path.join(t.name, "modes", r), "w").write(m)
        return sb.Subscriber(os.path.join(t.name, "data"), t.name, rooms, Sink(), clock)

    def published(self, s):
        """The string as published: control_message() is what run_subscriber hands to the pipe (one line is added by the caller)."""
        return s.control_message()

    def test_module_regex_is_the_kiosk_regex_verbatim(self):
        self.assertEqual(sb.CONTROL_RE.pattern, KIOSK_RE)

    def test_0_1_5_64_rooms_both_kill_values_match_the_kiosk_regex_exactly(self):
        for n in (0, 1, 5, 64):
            rooms = [f"opd-{i}" if i % 2 else f"r{i}_x" for i in range(n)]
            modes = {r: ("heal" if i % 3 == 0 else "shadow") for i, r in enumerate(rooms)}
            for kill in (True, False):
                s = self.mk(rooms, kill, modes)
                msg = self.published(s)
                self.assertTrue(re.fullmatch(KIOSK_RE, msg), (n, kill, msg[:80]))
                self.assertEqual(json.loads(msg)["kill"], kill)
                self.assertEqual(len(json.loads(msg)["modes"]), n)
                self.assertLessEqual(len(msg.encode()), 4000)
                self.assertTrue(all(0x20 <= b <= 0x7E for b in msg.encode()))
                self.assertNotIn("\n", msg)
                self.assertEqual(msg, json.dumps(json.loads(msg), sort_keys=True))            # default separators ', ' and ': '
                self.assertEqual(list(json.loads(msg)), ["kill", "modes", "ts"])             # key order kill, modes, ts

    def test_ts_is_positive_integer_no_leading_zero(self):
        s = self.mk(["r1"], True)
        ts = json.loads(self.published(s))["ts"]
        self.assertIsInstance(ts, int); self.assertGreater(ts, 0)
        self.assertRegex(self.published(s), r'"ts": [1-9][0-9]{0,14}\}$')

    def test_mini_can_never_produce_a_mode_other_than_shadow_or_heal(self):
        junk = {"r1": "heal\nextra", "r2": "Heal", "r3": " heal ", "r4": "", "r5": "off", "r6": "HEALX", "r7": "heal", "r8": "\x00heal"}
        s = self.mk(list(junk), False, junk)
        modes = json.loads(self.published(s))["modes"]
        self.assertTrue(set(modes.values()) <= {"shadow", "heal"})
        for r in ("r2", "r3", "r7"):                                                           # the file content, stripped and case-folded, is exactly "heal"
            self.assertEqual(modes[r], "heal", r)
        for r in ("r1", "r4", "r5", "r6", "r8"):
            self.assertEqual(modes[r], "shadow", r)

    def test_kiosk_regex_fails_for_any_other_mode_value(self):
        good = '{"kill": true, "modes": {"r1": "shadow"}, "ts": 1791960000}'
        self.assertTrue(re.fullmatch(KIOSK_RE, good))
        for bad_mode in ("off", "Heal", "SHADOW", "", "heal ", "healx", "shadow2", "kill", "null"):
            self.assertIsNone(re.fullmatch(KIOSK_RE, good.replace('"shadow"', f'"{bad_mode}"')), bad_mode)
        for bad in ('{"kill": true, "modes": {"R1": "shadow"}, "ts": 1791960000}',          # uppercase slug
                    '{"kill": true, "modes": {"r 1": "shadow"}, "ts": 1791960000}',        # space
                    '{"kill": true, "modes": {"r1": "shadow"}, "ts": 0}',                  # ts 0
                    '{"kill": true, "modes": {"r1": "shadow"}, "ts": 01791960000}',        # leading zero
                    '{"kill":true,"modes":{"r1":"shadow"},"ts":1791960000}',                # compact separators
                    '{"modes": {"r1": "shadow"}, "kill": true, "ts": 1791960000}',          # key order
                    '{"kill": "true", "modes": {}, "ts": 1791960000}',
                    good + "\n"):
            self.assertIsNone(re.fullmatch(KIOSK_RE, bad), bad)
        rooms65 = ", ".join(f'"r{i}": "shadow"' for i in range(65))
        self.assertIsNone(re.fullmatch(KIOSK_RE, '{"kill": true, "modes": {' + rooms65 + '}, "ts": 1791960000}'))

    def test_canonical_control_refuses_anything_off_contract(self):
        ok = {"kill": True, "modes": {"r1": "shadow"}, "ts": 1791960000}
        self.assertEqual(sb.canonical_control(ok), '{"kill": true, "modes": {"r1": "shadow"}, "ts": 1791960000}')
        for bad in ({"kill": True, "modes": {"r1": "off"}, "ts": 1791960000},                # other mode
                    {"kill": True, "modes": {"R1": "shadow"}, "ts": 1791960000},             # slug outside the pattern
                    {"kill": True, "modes": {"r 1": "heal"}, "ts": 1791960000},
                    {"kill": True, "modes": {"r" * 65: "heal"}, "ts": 1791960000},           # slug too long
                    {"kill": True, "modes": {f"r{i}": "shadow" for i in range(65)}, "ts": 1791960000},   # 65 rooms
                    {"kill": True, "modes": {}, "ts": 0}, {"kill": True, "modes": {}, "ts": -5},
                    {"kill": True, "modes": {}, "ts": 1791960000.5}, {"kill": 1, "modes": {}, "ts": 1791960000},
                    {"kill": True, "modes": {"é": "heal"}, "ts": 1791960000},           # non-ASCII
                    {"kill": True, "modes": {}, "ts": 1791960000, "extra": 1}):
            with self.assertRaises(ValueError, msg=str(bad)[:60]):
                sb.canonical_control(bad)

    def test_over_4000_bytes_is_refused_even_though_the_regex_allows_64_long_slugs(self):
        rooms = [f"{i:02d}" + "x" * 62 for i in range(64)]                                    # 64 rooms, 64-char slugs
        self.assertEqual(len(set(rooms)), 64)
        payload = {"kill": True, "modes": {r: "shadow" for r in rooms}, "ts": 1791960000}
        self.assertGreater(len(json.dumps(payload, sort_keys=True).encode()), 4000)
        self.assertTrue(re.fullmatch(KIOSK_RE, json.dumps(payload, sort_keys=True)))           # the regex alone would pass it
        with self.assertRaises(ValueError):
            sb.canonical_control(payload)
        self.assertIn("4000", sb.validate_rooms(rooms))

    @staticmethod
    def payload_of_len(target):
        """A contract-valid payload (<= 64 rooms, slugs [a-z0-9]{1,64}) whose json.dumps is exactly `target` bytes."""
        for k in range(1, 65):
            for last in range(1, 65):
                rooms = [f"{i:02d}" + "x" * 62 for i in range(k - 1)] + [f"{k - 1:02d}" + "y" * (last - 2 if last > 2 else 0)][:1]
                rooms[-1] = (f"{k - 1:02d}" + "y" * 62)[:max(last, 2)]
                if len(set(rooms)) != len(rooms):
                    continue
                p = {"kill": True, "modes": {r: "shadow" for r in rooms}, "ts": 1791960000}
                if len(json.dumps(p, sort_keys=True).encode()) == target:
                    return p
        raise AssertionError(f"no payload of {target} bytes")

    def test_cap_boundary_3999_and_4000_pass_4001_is_refused(self):
        for n, ok in ((3999, True), (4000, True), (4001, False)):
            p = self.payload_of_len(n)
            self.assertEqual(len(json.dumps(p, sort_keys=True).encode()), n)
            self.assertTrue(re.fullmatch(KIOSK_RE, json.dumps(p, sort_keys=True)), n)         # the regex alone accepts all three
            if ok:
                self.assertEqual(len(sb.canonical_control(p).encode()), n)
            else:
                with self.assertRaises(ValueError):
                    sb.canonical_control(p)
        self.assertEqual(sb.CONTROL_MAX_BYTES, 4000)

    def test_largest_publishable_payload_fits_the_kiosk_4096_line_cap_with_margin(self):
        p = self.payload_of_len(4000)
        control_last = len(("9" * 15) + "\n") + len(sb.canonical_control(p)) + 1               # receive-epoch line + payload + payload newline
        self.assertLessEqual(control_last, 4096)

    def test_validate_rooms_refuses_slugs_and_counts_the_kiosk_would_reject(self):
        self.assertIsNone(sb.validate_rooms([]))
        self.assertIsNone(sb.validate_rooms([f"r{i}" for i in range(64)]))
        for bad in (["OPD6"], ["opd 6"], ["opd.6"], [""], ["a" * 65], ["r1", "r1"], ["é"], [3], [f"r{i}" for i in range(65)]):
            self.assertIsNotNone(sb.validate_rooms(bad), bad)

    def test_rooms_must_be_a_list_not_a_bare_string_or_other_type(self):
        for bad in ("opd6", "r1", "", {"r1": "shadow"}, None, 6, ("r1",), True):
            err = sb.validate_rooms(bad)
            self.assertIsNotNone(err, repr(bad)); self.assertIn("list", err)
        self.assertIsNone(sb.validate_rooms(["opd6"]))

    def test_control_payload_raises_before_publish_when_a_bad_room_is_configured(self):
        s = self.mk(["OPD6"], True)
        with self.assertRaises(ValueError):
            s.control_payload()
        sent = []
        with self.assertRaises(ValueError):
            s.publish_control(lambda t, m: sent.append(m))
        self.assertEqual(sent, [])                                                             # nothing reached the pipe


if __name__ == "__main__":
    unittest.main()
