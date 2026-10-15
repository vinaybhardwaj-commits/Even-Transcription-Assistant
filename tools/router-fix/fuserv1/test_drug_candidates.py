#!/usr/bin/env python3
"""Tests for the 4 scenarios eta-refuter-2 #4740 asked for: (1) a drug word inside a longer phrase,
(2) two drugs in one slice, (3) a drug named only in the Indic track (must not match), (4) time
misalignment between tracks."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drug_candidates as dc  # noqa: E402
import lexicon  # noqa: E402
import tokenize_tracks as tt  # noqa: E402

RX_PATH = "/home/eta/eta-data/cap2/rx_history.jsonl"


@unittest.skipUnless(os.path.exists(RX_PATH), "rx_history.jsonl not available in this environment")
class DrugCandidates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lex = lexicon.load_lexicon(RX_PATH)

    def test_1_drug_word_isolated_inside_a_longer_phrase(self):
        w_seg = [{"t0_ms": 0, "t1_ms": 3800, "text": "tab Pantoprazole 40 mg twice a day", "words": [
            {"w": "tab", "t0_ms": 0, "t1_ms": 280}, {"w": "Pantoprazole", "t0_ms": 280, "t1_ms": 1550},
            {"w": "40", "t0_ms": 1550, "t1_ms": 1850}, {"w": "mg", "t0_ms": 1850, "t1_ms": 2150},
            {"w": "twice", "t0_ms": 2150, "t1_ms": 2600}, {"w": "a", "t0_ms": 2600, "t1_ms": 2750},
            {"w": "day", "t0_ms": 2750, "t1_ms": 3100}]}]
        i_seg = [{"t0_ms": 0, "t1_ms": 3600, "text": "टैब पैंटोप्राजोल चालीस मिलीग्राम", "words": [
            {"w": "टैब", "t0_ms": 80, "t1_ms": 380}, {"w": "पैंटोप्राजोल", "t0_ms": 380, "t1_ms": 1680},
            {"w": "चालीस", "t0_ms": 1680, "t1_ms": 2180}, {"w": "मिलीग्राम", "t0_ms": 2180, "t1_ms": 2980}]}]
        r = dc.find_drug_candidates(tt.tokenize_track(0, w_seg), tt.tokenize_track(1, i_seg), self.lex)
        matches = [c for c in r if c["match"] and c["match"].get("name") == "pantoprazole"]
        self.assertEqual(len(matches), 1)
        self.assertNotIn("टैब", matches[0]["indic_window"])
        self.assertNotIn("चालीस", matches[0]["indic_window"])
        # eta-refuter-2 #4811 F3: indic_tokens carries the ACTUAL matched token(s), not just rendered
        # text -- the validator needs real ids to require an exact-span citation, not a substring test.
        self.assertEqual([t["text"] for t in matches[0]["indic_tokens"]], ["पैंटोप्राजोल"])
        self.assertEqual(matches[0]["indic_tokens"][0]["id"], "1:0:1")

    def test_2_two_drugs_in_one_slice_both_found_independently(self):
        w_seg = [{"t0_ms": 0, "t1_ms": 3500, "text": "Metformin 500 mg and Glimepiride 1 mg", "words": [
            {"w": "Metformin", "t0_ms": 0, "t1_ms": 1000}, {"w": "500", "t0_ms": 1000, "t1_ms": 1400},
            {"w": "mg", "t0_ms": 1400, "t1_ms": 1700}, {"w": "and", "t0_ms": 1700, "t1_ms": 1900},
            {"w": "Glimepiride", "t0_ms": 1900, "t1_ms": 3000}, {"w": "1", "t0_ms": 3000, "t1_ms": 3200},
            {"w": "mg", "t0_ms": 3200, "t1_ms": 3500}]}]
        i_seg = [{"t0_ms": 0, "t1_ms": 3600, "text": "मेटफॉर्मिन पांच सौ मिलीग्राम और ग्लिमेपिराइड एक मिलीग्राम", "words": [
            {"w": "मेटफॉर्मिन", "t0_ms": 0, "t1_ms": 1100}, {"w": "पांच", "t0_ms": 1100, "t1_ms": 1300},
            {"w": "सौ", "t0_ms": 1300, "t1_ms": 1500}, {"w": "मिलीग्राम", "t0_ms": 1500, "t1_ms": 1800},
            {"w": "और", "t0_ms": 1800, "t1_ms": 2000}, {"w": "ग्लिमेपिराइड", "t0_ms": 2000, "t1_ms": 3100},
            {"w": "एक", "t0_ms": 3100, "t1_ms": 3300}, {"w": "मिलीग्राम", "t0_ms": 3300, "t1_ms": 3600}]}]
        r = dc.find_drug_candidates(tt.tokenize_track(0, w_seg), tt.tokenize_track(1, i_seg), self.lex)
        names = {c["match"]["name"] for c in r if c["match"] and c["match"].get("name")}
        self.assertEqual(names, {"metformin", "glimepiride"})

    def test_3_drug_named_only_in_indic_track_generates_no_candidate_at_all(self):
        # candidate generation is Whisper-driven (the two-witness scheme's first witness); a drug the
        # Indic track has but Whisper never capitalises produces no candidate -- correctly "not found",
        # never a false single-track match.
        w_seg = [{"t0_ms": 0, "t1_ms": 3000, "text": "take the medicine after food"}]
        i_seg = [{"t0_ms": 0, "t1_ms": 3000, "text": "मेटफॉर्मिन फ़ूड के बाद लीजिए"}]
        r = dc.find_drug_candidates(tt.tokenize_track(0, w_seg), tt.tokenize_track(1, i_seg), self.lex)
        self.assertEqual(r, [])

    def test_3b_drug_candidate_with_no_aligned_indic_tokens_is_single_witness_not_a_match(self):
        w_seg = [{"t0_ms": 0, "t1_ms": 2000, "text": "Metformin"}]
        r = dc.find_drug_candidates(tt.tokenize_track(0, w_seg), [], self.lex)
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["match"], {"single_witness": True})

    def test_4_time_misalignment_within_realistic_drift_still_matches(self):
        # same content as test 1, but every Indic timestamp shifted +80ms (a realistic engine-to-engine
        # drift, not a re-segmentation) -- majority overlap should absorb it.
        w_seg = [{"t0_ms": 0, "t1_ms": 3800, "text": "tab Pantoprazole 40 mg", "words": [
            {"w": "tab", "t0_ms": 0, "t1_ms": 280}, {"w": "Pantoprazole", "t0_ms": 280, "t1_ms": 1550},
            {"w": "40", "t0_ms": 1550, "t1_ms": 1850}, {"w": "mg", "t0_ms": 1850, "t1_ms": 2150}]}]
        shift = 80
        i_seg = [{"t0_ms": 0, "t1_ms": 3600, "text": "टैब पैंटोप्राजोल चालीस मिलीग्राम", "words": [
            {"w": "टैब", "t0_ms": 0 + shift, "t1_ms": 300 + shift},
            {"w": "पैंटोप्राजोल", "t0_ms": 300 + shift, "t1_ms": 1600 + shift},
            {"w": "चालीस", "t0_ms": 1600 + shift, "t1_ms": 2100 + shift},
            {"w": "मिलीग्राम", "t0_ms": 2100 + shift, "t1_ms": 2900 + shift}]}]
        r = dc.find_drug_candidates(tt.tokenize_track(0, w_seg), tt.tokenize_track(1, i_seg), self.lex)
        matches = [c for c in r if c["match"] and c["match"].get("name") == "pantoprazole"]
        self.assertEqual(len(matches), 1)

    def test_no_capitalised_word_gives_no_candidates(self):
        w_seg = [{"t0_ms": 0, "t1_ms": 1000, "text": "take this after food"}]
        self.assertEqual(dc.find_drug_candidates(tt.tokenize_track(0, w_seg), [], self.lex), [])

    def test_5_interpolated_indic_track_drug_1_2s_off_still_found(self):
        # lid-debug #4749/#4768 C1's own fixture request: SraVaani has NO word times (whole-segment
        # interpolation, tokenize_tracks marks every token interp=True), and its overall segment timing
        # is shifted so the drug word's interpolated span lands ~1.2 s away from Whisper's real-timed
        # span -- at tolerance 0 (majority overlap on the tight window) this would NOT overlap at all
        # and the match would silently fail. The widened, phonetic-witness-picks path must still find it.
        w_seg = [{"t0_ms": 0, "t1_ms": 3800, "text": "tab Pantoprazole 40 mg", "words": [
            {"w": "tab", "t0_ms": 0, "t1_ms": 280}, {"w": "Pantoprazole", "t0_ms": 280, "t1_ms": 1550},
            {"w": "40", "t0_ms": 1550, "t1_ms": 1850}, {"w": "mg", "t0_ms": 1850, "t1_ms": 2150}]}]
        # no "words" key at all -> tokenize_track interpolates evenly across [1200, 5200], so
        # "पैंटोप्राजोल" (the 2nd of 4 words) lands at [2200, 3200] -- ~1.2 s past Whisper's drug
        # span end (1550), no overlap whatsoever against the tight [280, 1550] window.
        i_seg = [{"t0_ms": 1200, "t1_ms": 5200, "text": "टैब पैंटोप्राजोल चालीस मिलीग्राम"}]
        w_toks = tt.tokenize_track(0, w_seg)
        i_toks = tt.tokenize_track(1, i_seg)
        self.assertTrue(all(t["interp"] for t in i_toks))  # sanity: this really exercises the interp path
        r = dc.find_drug_candidates(w_toks, i_toks, self.lex)
        matches = [c for c in r if c["match"] and c["match"].get("name") == "pantoprazole"]
        self.assertEqual(len(matches), 1)
        # the widened path's own winning n-gram, not the whole pool -- F3 needs this to be the EXACT
        # span that matched, never every token the wide window happened to touch.
        self.assertEqual([t["text"] for t in matches[0]["indic_tokens"]], ["पैंटोप्राजोल"])

    def test_5b_interpolated_side_does_not_widen_when_drug_is_far_away(self):
        # the widened window has a limit: a drug mentioned far outside INTERP_WIDEN_MS of the Whisper
        # span (a different sentence entirely) must still not be pulled in.
        w_seg = [{"t0_ms": 0, "t1_ms": 2000, "text": "Pantoprazole", "words": [
            {"w": "Pantoprazole", "t0_ms": 0, "t1_ms": 2000}]}]
        i_seg = [{"t0_ms": 20000, "t1_ms": 21000, "text": "पैंटोप्राजोल"}]
        r = dc.find_drug_candidates(tt.tokenize_track(0, w_seg), tt.tokenize_track(1, i_seg), self.lex)
        self.assertEqual(r[0]["match"], {"single_witness": True})

    def test_5c_widened_path_still_excludes_unrelated_drug_named_only_indic_side(self):
        # a second, DIFFERENT drug sitting in the widened pool must not get matched against a whisper
        # span for a drug that isn't it -- the phonetic witness threshold still has to clear.
        w_seg = [{"t0_ms": 0, "t1_ms": 1500, "text": "Pantoprazole", "words": [
            {"w": "Pantoprazole", "t0_ms": 0, "t1_ms": 1500}]}]
        i_seg = [{"t0_ms": 2200, "t1_ms": 3200, "text": "मेटफॉर्मिन"}]  # metformin, not pantoprazole
        r = dc.find_drug_candidates(tt.tokenize_track(0, w_seg), tt.tokenize_track(1, i_seg), self.lex)
        self.assertIsNone(r[0]["match"].get("name") if r[0]["match"] else None)


if __name__ == "__main__":
    unittest.main()
