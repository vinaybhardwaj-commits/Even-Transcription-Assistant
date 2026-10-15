#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eligibility as el  # noqa: E402


class Eligibility(unittest.TestCase):
    GOOD = {"fuser_code_sha": el.V0_LIB_PIN, "fuser_code_dirty": False, "reb_sha": el.REB_LIB_PIN,
            "etr_enabled": True}

    def test_good_config_is_eligible(self):
        self.assertEqual(el.eligibility(self.GOOD, expected_etr_enabled=True), (True, []))
        self.assertTrue(el.is_eligible(self.GOOD, expected_etr_enabled=True))

    def test_dirty_true_is_ineligible(self):
        ok, reasons = el.eligibility({**self.GOOD, "fuser_code_dirty": True}, expected_etr_enabled=True)
        self.assertFalse(ok)
        self.assertTrue(any("fuser_code_dirty" in r for r in reasons))

    def test_sha_none_is_ineligible(self):
        ok, reasons = el.eligibility({**self.GOOD, "fuser_code_sha": None}, expected_etr_enabled=True)
        self.assertFalse(ok)
        self.assertTrue(any("fuser_code_sha" in r for r in reasons))

    def test_a_different_CLEAN_sha_is_still_ineligible(self):
        # eta-refuter-2 #4734 E1: "any 40-hex sha" is not the rule -- it must be the frozen v0 pin.
        other_clean_sha = "b" * 40
        ok, reasons = el.eligibility({**self.GOOD, "fuser_code_sha": other_clean_sha}, expected_etr_enabled=True)
        self.assertFalse(ok)
        self.assertTrue(any("fuser_code_sha" in r for r in reasons))

    def test_suffixed_sha_is_ineligible(self):
        ok, _ = el.eligibility({**self.GOOD, "fuser_code_sha": el.V0_LIB_PIN + "+dirty"}, expected_etr_enabled=True)
        self.assertFalse(ok)

    def test_missing_keys_are_ineligible_not_a_crash(self):
        ok, reasons = el.eligibility({}, expected_etr_enabled=True)
        self.assertFalse(ok)
        self.assertEqual(len(reasons), 4)  # sha, dirty, reb_sha, etr_enabled

    def test_wrong_reb_sha_is_ineligible(self):
        ok, reasons = el.eligibility({**self.GOOD, "reb_sha": "0" * 40}, expected_etr_enabled=True)
        self.assertFalse(ok)
        self.assertTrue(any("reb_sha" in r for r in reasons))

    def test_wrong_arm_is_ineligible(self):
        ok, reasons = el.eligibility(self.GOOD, expected_etr_enabled=False)
        self.assertFalse(ok)
        self.assertTrue(any("etr_enabled" in r for r in reasons))

    def test_expected_etr_enabled_is_required_positionally_or_by_name(self):
        # eta-refuter-2 #4734 E2: no way to call the real check without stating the arm.
        with self.assertRaises(TypeError):
            el.eligibility(self.GOOD)

    def test_non_dict_config_does_not_raise(self):
        ok, reasons = el.eligibility(None, expected_etr_enabled=True)
        self.assertFalse(ok)
        self.assertIn("not a dict", reasons[0])
        ok2, _ = el.eligibility("garbage", expected_etr_enabled=True)
        self.assertFalse(ok2)

    def test_dev_only_check_skips_arm_but_still_checks_everything_else(self):
        ok, reasons = el.eligibility_dev_only(self.GOOD)
        self.assertTrue(ok)
        bad = {**self.GOOD, "fuser_code_dirty": True}
        ok2, reasons2 = el.eligibility_dev_only(bad)
        self.assertFalse(ok2)
        self.assertTrue(any("fuser_code_dirty" in r for r in reasons2))

    def test_dev_only_non_dict_does_not_raise(self):
        ok, reasons = el.eligibility_dev_only(None)
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
