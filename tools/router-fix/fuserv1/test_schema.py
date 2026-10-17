#!/usr/bin/env python3
"""ADDENDUM-7 fixtures F1-F7 (+ schema-structure and V4-scope checks). Offline only."""
import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schema as sc  # noqa: E402
import validator as v  # noqa: E402

GOOD = {
    "copies": [{"pos": 0, "refs": ["0:0:1"]}],
    "norms": [{"pos": 1, "refs": ["0:0:2"], "w": "40", "rule": "number_digits"}],
    "gens": [{"pos": 3, "w": "है", "reason": "connective"}],
    "conflicts": [{"pos": 2, "kind": "dose_disagreement", "options": [{"refs": ["0:0:3"]}, {"refs": ["1:0:3"]}]}],
    "en_clauses": [{"text": "Pantoprazole 40 mg", "native_pos": [0, 1]}],
    "entities": [{"kind": "dose", "value": "40", "unit": "", "native_pos": [1]}],
}


def _with(**kw):
    d = copy.deepcopy(GOOD)
    d.update(kw)
    return d


class SchemaStructure(unittest.TestCase):
    def test_every_object_closed_and_fully_required(self):
        def walk(node):
            if isinstance(node, dict):
                if node.get("type") == "object":
                    self.assertIs(node.get("additionalProperties"), False)
                    self.assertEqual(sorted(node["required"]), sorted(node["properties"]))
                    for child in node["properties"].values():
                        walk(child)
                elif node.get("type") == "array":
                    walk(node["items"])
        walk(sc.SLICE_RESPONSE_SCHEMA)
        self.assertEqual(sc.SLICE_RESPONSE_SCHEMA["required"], list(sc.ARRAYS))

    def test_no_oneof_anyof(self):
        self.assertNotIn("oneOf", str(sc.SLICE_RESPONSE_SCHEMA))
        self.assertNotIn("anyOf", str(sc.SLICE_RESPONSE_SCHEMA))

    def test_norm_w_min_length_and_conflict_min_options(self):
        props = sc.SLICE_RESPONSE_SCHEMA["properties"]
        self.assertEqual(props["norms"]["items"]["properties"]["w"]["minLength"], 1)
        self.assertEqual(props["conflicts"]["items"]["properties"]["options"]["minItems"], 2)


class Shape(unittest.TestCase):
    def test_good_passes(self):
        self.assertTrue(sc.check_shape(GOOD)[0])

    def test_not_a_dict_fails(self):
        self.assertFalse(sc.check_shape([1])[0])

    def test_F7_missing_any_of_six_arrays_rejected(self):
        for key in sc.ARRAYS:
            bad = copy.deepcopy(GOOD)
            del bad[key]
            self.assertFalse(sc.check_shape(bad)[0], key)
            bad = _with(**{key: "nope"})
            self.assertFalse(sc.check_shape(bad)[0], key)


class Normalise(unittest.TestCase):
    def test_F6_round_trip_matches_hand_built_flat_items(self):
        flat, dropped, stats = sc.normalise_items(GOOD)
        self.assertEqual(dropped, [])
        self.assertEqual(flat["native_items"], [
            {"kind": "copy", "refs": ["0:0:1"]},
            {"kind": "norm", "refs": ["0:0:2"], "w": "40", "rule": "number_digits"},
            {"kind": "conflict", "options": [{"refs": ["0:0:3"]}, {"refs": ["1:0:3"]}], "conflict_kind": "dose_disagreement"},
            {"kind": "gen", "w": "है", "reason": "connective"},
        ])
        self.assertEqual(flat["en_clauses"], [{"text": "Pantoprazole 40 mg", "native_idx": [0, 1]}])
        self.assertEqual(flat["entities"], [{"kind": "dose", "value": "40", "unit": "", "native_items": [1]}])
        self.assertEqual((stats["dup_pos"], stats["pos_gaps"], stats["out_of_order"]), (0, 0, 0))

    def test_F1_norm_without_w_dropped_rest_kept(self):
        bad = _with(norms=[{"pos": 1, "refs": ["0:0:2"], "rule": "number_digits"}])
        flat, dropped, _ = sc.normalise_items(bad)
        self.assertEqual([d["reason"] for d in dropped], ["norm_missing_w"])
        self.assertTrue(dropped[0]["clinical"])
        self.assertEqual(len(flat["native_items"]), 3)
        # the dose entity cited pos 1, which did not survive: linked to nothing (V5 drops it as unlinked)
        self.assertEqual(flat["entities"][0]["native_items"], [])

    def test_norm_with_empty_w_is_missing_w(self):
        bad = _with(norms=[{"pos": 1, "refs": ["0:0:2"], "w": "  ", "rule": "lexicon_generic"}])
        self.assertEqual(sc.normalise_items(bad)[1][0]["reason"], "norm_missing_w")

    def test_F2_norm_carrying_conflict_fields_is_bad_item_shape(self):
        bad = _with(norms=[{"pos": 1, "refs": ["0:0:2"], "rule": "number_digits", "options": [], "conflict_kind": "x"}])
        flat, dropped, _ = sc.normalise_items(bad)
        self.assertEqual([d["reason"] for d in dropped], ["bad_item_shape"])
        self.assertEqual(len(flat["native_items"]), 3)

    def test_F3_duplicate_pos_drops_all_sharing_it(self):
        bad = _with(gens=[{"pos": 0, "w": "है", "reason": "r"}])  # same pos as the copy
        flat, dropped, stats = sc.normalise_items(bad)
        self.assertEqual(sorted(d["reason"] for d in dropped), ["dup_pos", "dup_pos"])
        self.assertEqual(stats["dup_pos"], 1)
        self.assertEqual(len(flat["native_items"]), 2)

    def test_F4_conflict_with_one_option_dropped(self):
        bad = _with(conflicts=[{"pos": 2, "kind": "k", "options": [{"refs": ["0:0:3"]}]}])
        flat, dropped, _ = sc.normalise_items(bad)
        self.assertEqual([d["reason"] for d in dropped], ["conflict_lt2"])
        self.assertFalse(dropped[0]["clinical"])

    def test_F5_entity_or_clause_citing_unknown_pos_is_unlinked(self):
        bad = _with(entities=[{"kind": "dose", "value": "40", "unit": "", "native_pos": [99]}],
                    en_clauses=[{"text": "x", "native_pos": [0, 99]}])
        flat, _, _ = sc.normalise_items(bad)
        self.assertEqual(flat["entities"][0]["native_items"], [])
        self.assertEqual(flat["en_clauses"][0]["native_idx"], [])
        self.assertEqual(v.validate_entities(flat["entities"], {}, {})["dropped"][0]["reason"], "unlinked_native_item")

    def test_bad_rule_extra_field_and_non_dict_items(self):
        bad = _with(copies=[{"pos": 0, "refs": ["0:0:1"], "w": "x"}, "junk"],
                    norms=[{"pos": 1, "refs": ["0:0:2"], "w": "40", "rule": "nope"}])
        _, dropped, _ = sc.normalise_items(bad)
        self.assertEqual([d["reason"] for d in dropped], ["bad_item_shape"] * 3)

    def test_bool_and_negative_pos_rejected(self):
        bad = _with(copies=[{"pos": True, "refs": ["0:0:1"]}, {"pos": -1, "refs": ["0:0:1"]}])
        _, dropped, _ = sc.normalise_items(bad)
        self.assertEqual([d["reason"] for d in dropped], ["bad_item_shape"] * 2)

    def test_pos_stats_gaps_and_out_of_order(self):
        r = _with(copies=[{"pos": 5, "refs": ["0:0:1"]}, {"pos": 2, "refs": ["0:0:5"]}])
        _, _, stats = sc.normalise_items(r)
        self.assertEqual(stats["out_of_order"], 1)
        self.assertEqual(stats["pos_gaps"], 2)  # used pos {1,2,3,5} -> missing 0 and 4

    def test_bad_entity_and_clause_shapes_counted(self):
        r = _with(en_clauses=[{"text": "ok", "native_pos": [1]}, "junk", {"native_pos": [1]}],
                  entities=[{"kind": "bogus", "value": "x", "unit": "", "native_pos": [1]}, 5,
                            {"kind": "drug", "value": "amox", "unit": "", "native_pos": [1]}])
        flat, _, stats = sc.normalise_items(r)
        self.assertEqual(stats["bad_clause_shape"], 2)
        self.assertEqual(stats["bad_entity_shape"], 2)
        self.assertEqual(len(flat["en_clauses"]), 1)
        self.assertEqual(len(flat["entities"]), 1)

    def test_gaps_allowed_and_sorted_by_pos(self):
        r = {"copies": [{"pos": 7, "refs": ["0:0:1"]}, {"pos": 2, "refs": ["0:0:0"]}], "norms": [], "gens": [],
             "conflicts": [], "en_clauses": [], "entities": []}
        flat, dropped, _ = sc.normalise_items(r)
        self.assertEqual(dropped, [])
        self.assertEqual([i["refs"] for i in flat["native_items"]], [["0:0:0"], ["0:0:1"]])

    def test_pre_dropped_counts_toward_validate_slice_fallback(self):
        bad = _with(norms=[{"pos": 1, "refs": ["0:0:2"], "rule": "number_digits"}])
        flat_reply, pre, _ = sc.normalise_items(bad)
        flat = {"0:0:1": {"id": "0:0:1", "text": "a", "engine": "sravaani", "citable": True},
                "0:0:2": {"id": "0:0:2", "text": "b", "engine": "sravaani", "citable": True},
                "0:0:3": {"id": "0:0:3", "text": "c", "engine": "sravaani", "citable": True},
                "1:0:3": {"id": "1:0:3", "text": "d", "engine": "indic-ctc-hi", "citable": True}}
        out = v.validate_slice(flat_reply, flat, {}, None, {}, {}, pre)
        self.assertEqual(out["outcome"], "fallback")
        self.assertIn("norm_missing_w", out["reasons"])


def _tok(engine, text="x", detected=None, tid="0:0:0"):
    return {"id": tid, "text": text, "engine": engine, "citable": True, "lid_detected": detected}


class V4Scope(unittest.TestCase):
    def _gate(self, engine, detected, p_en=0.2):
        flat = {"0:0:0": _tok(engine, "10", detected)}
        return v.check_v4_whisper_gate({"refs": ["0:0:0"]}, flat, "10", p_en, {}, {})

    def test_forced_en_low_pen_unanchored_still_rejected(self):
        self.assertEqual(self._gate("whisper-forced-en", "hi"), (False, "whisper_low_pen_unanchored"))

    def test_cap2_low_pen_unanchored_still_rejected(self):
        self.assertFalse(self._gate("whisper-cap2", None)[0])

    def test_auto_detected_en_unanchored_rejected(self):
        self.assertFalse(self._gate("whisper-auto", "en")[0])

    def test_auto_unknown_detection_treated_as_gated(self):
        self.assertFalse(self._gate("whisper-auto", None)[0])

    def test_auto_detected_indic_is_not_gated(self):
        self.assertEqual(self._gate("whisper-auto", "hi"), (True, ""))

    def test_mixed_refs_gated_if_any_token_gated(self):
        flat = {"0:0:0": _tok("whisper-auto", "ये", "hi", "0:0:0"), "0:0:1": _tok("whisper-auto", "ten", "en", "0:0:1")}
        ok, _ = v.check_v4_whisper_gate({"refs": ["0:0:0", "0:0:1"]}, flat, "ये ten", 0.2, {}, {})
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
