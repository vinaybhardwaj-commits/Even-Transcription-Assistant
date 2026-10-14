#!/usr/bin/env python3
"""Tests for kit/check-silent-gate.py: the four ruling-40 cases plus the edge cases the gate must fail closed on.
Run: python3 kit/test_check_silent_gate.py"""
import os, subprocess, sys, tempfile, unittest

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-silent-gate.py")
F = lambda *lines: "Found %d silent-failure handler(s) -- x:\n" % len(lines) + "".join("  %s\n" % l for l in lines)
A = "lib/a.ts:9  try {} catch {}"          # one accepted finding (any line number)
B = "lib/b.ts:3  x.catch(() => {});"


def run(out, base_text, rc):
    with tempfile.TemporaryDirectory() as d:
        bp = os.path.join(d, "base.txt")
        if base_text is not None:
            with open(bp, "w") as f:
                f.write(base_text)
        p = subprocess.run([sys.executable, GATE, "--baseline", bp, "--rc", str(rc)], input=out, capture_output=True, text=True)
        return p.returncode, p.stdout


BASE = "# c\nlib/a.ts\ttry {} catch {}\n"


class Gate(unittest.TestCase):
    def test_control_accepted_stay_ok(self):
        self.assertEqual(run(F(A), BASE, 1)[0], 0)
    def test_line_number_shift_still_ok(self):
        self.assertEqual(run(F("lib/a.ts:400  try {} catch {}"), BASE, 1)[0], 0)
    def test_kill_new_finding_fails_and_is_named(self):
        rc, out = run(F(A, B), BASE, 1)
        self.assertEqual(rc, 1); self.assertIn("lib/b.ts", out)
    def test_multiset_second_copy_fails(self):
        self.assertEqual(run(F(A, A.replace(":9", ":20")), BASE, 1)[0], 1)
    def test_fixed_removed_finding_ok_with_notice(self):
        rc, out = run("OK -- no empty catch/.catch handlers in critical paths\n", BASE, 0)
        self.assertEqual(rc, 0); self.assertIn("no longer present", out)
    def test_absent_baseline_is_exit_3_even_on_a_clean_tree(self):
        self.assertEqual(run("OK -- clean\n", None, 0)[0], 3)
    def test_empty_baseline_makes_every_finding_new(self):
        self.assertEqual(run(F(A), "", 1)[0], 1)
    def test_nonzero_rc_without_list_is_2(self):
        self.assertEqual(run("TypeError: boom\n", BASE, 1)[0], 2)
    def test_rc0_with_a_findings_list_is_still_diffed(self):
        self.assertEqual(run(F(A, B), BASE, 0)[0], 1)
    def test_rc0_without_ok_line_is_not_clean(self):
        self.assertEqual(run("", BASE, 0)[0], 2)
    def test_header_count_mismatch_is_2(self):
        self.assertEqual(run("Found 2 silent-failure handler(s) -- x:\n  %s\n" % A, BASE, 1)[0], 2)
    def test_baseline_a_directory_is_3(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, GATE, "--baseline", d, "--rc", "0"], input="OK\n", capture_output=True, text=True)
            self.assertEqual(p.returncode, 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
