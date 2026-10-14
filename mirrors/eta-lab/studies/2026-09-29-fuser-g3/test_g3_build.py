"""Synthetic fixtures only (invented consults/drugs/text). python3 -m pytest studies/2026-09-29-fuser-g3 -q"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g3_build as G  # noqa: E402

GEN = ["metformin", "amlodipine", "ferrous sulfate", "iron", "paracetamol"]


def seg(text, t0=1000, t1=4000):
    return {"text": text, "t0_ms": t0, "t1_ms": t1}


def test_render_canonical():
    assert G.render(None) == "(nothing)"
    assert G.render({"generic": "Ferrous  Sulfate", "dose_value": 200.0, "unit": "mg"}) == "ferrous sulfate 200 mg"
    assert G.render({"generic": "x", "dose_value": 0.5, "unit": "mg"}) == "x 0.5 mg"
    assert G.render({"generic": "x", "dose_value": None, "unit": ""}) == "x"


def test_extract_digits_words_and_unit_cue():
    ex = G.ReferenceExtractor(GEN)
    got = ex.extract([seg("take metformin 500 mg twice"), seg("amlodipine twenty one milligram"), seg("ferrous sulfate daily")])
    d = {e["generic"]: (e["dose_value"], e["unit"]) for e in got}
    assert d["metformin"] == (500.0, "mg") and d["amlodipine"] == (21.0, "mg") and d["ferrous sulfate"] == (None, "")


def test_number_without_unit_is_not_a_dose():
    ex = G.ReferenceExtractor(GEN)
    assert ex.extract([seg("metformin 2 times a day")])[0]["dose_value"] is None


def test_native_plugins_used_symmetrically():
    ex = G.ReferenceExtractor(GEN, native_drug=lambda t: "metformin" if t == "मेटफॉर्मिन" else None,
                              native_number=lambda toks, j: (500, 1) if toks[j] == "पाँचसौ" else None)
    e = ex.extract([seg("मेटफॉर्मिन पाँचसौ mg")])[0]
    assert (e["generic"], e["dose_value"], e["unit"]) == ("metformin", 500.0, "mg")


def _build(seed=1):
    ex = G.ReferenceExtractor(GEN)
    systems = {"v1": {"c1": [seg("metformin 500 mg"), seg("iron 100 mg", 9000, 12000)], "c2": [seg("amlodipine 5 mg")]},
               "cmp": {"c1": [seg("metformin 850 mg")], "c2": [seg("amlodipine 5 mg"), seg("ferrous sulfate 200 mg")]}}
    rx = {"c1": [{"rx_item_id": "r1", "generic": "Metformin"}, {"rx_item_id": "r2", "generic": "Aspirin"}],
          "c2": [{"rx_item_id": "r3", "generic": "Amlodipine"}]}
    return G.build_items(systems, rx, {"c1": 60000, "c2": 60000}, ex, rng=random.Random(seed))


def test_item_set_rules_and_fields():
    items, key, rep = _build()
    assert rep["rx_rendered_by_neither"] == 1            # aspirin: neither system rendered it
    kinds = sorted(k["kind"] for k in key.values())
    assert kinds == ["rx", "rx", "unlinked", "unlinked"]  # metformin, amlodipine; iron (v1 only), ferrous sulfate (cmp only)
    for it in items:
        assert set(it) == set(G.ITEM_FIELDS)
        assert it["audio_key"] == f"audio/{it['item_id']}.m4a"
        assert 0 <= it["span"]["t0_ms"] < it["span"]["t1_ms"] <= 60000


def test_ab_mapping_consistent_with_key():
    items, key, _ = _build()
    for it in items:
        k = key[it["item_id"]]
        v1s = G.render(k["v1"]); cs = G.render(k["cmp"])
        assert (it["A"], it["B"]) == ((v1s, cs) if k["A"] == "v1" else (cs, v1s))


def test_self_check_clean_and_items_carry_no_side_label():
    items, key, _ = _build()
    chk = G.self_check(items, key)
    assert chk["problems"] == []
    assert "v1" not in json.dumps(items) and "cmp" not in json.dumps(items)


def test_key_never_overwritten(tmp_path):
    items, key, _ = _build()
    G.write_outputs(items, key, str(tmp_path / "out"), str(tmp_path / "keys"), "run-x", {})
    try:
        G.write_outputs(items, key, str(tmp_path / "out"), str(tmp_path / "keys"), "run-x", {})
        assert False, "second write must refuse"
    except FileExistsError:
        pass
    assert oct(os.stat(tmp_path / "keys" / "key.json").st_mode)[-3:] == "600"


def test_fused_number_unit_is_a_dose():            # refuter-2 #6980 B2
    ex = G.ReferenceExtractor(GEN)
    e = ex.extract([seg("metformin 500mg daily")])[0]
    assert (e["dose_value"], e["unit"]) == (500.0, "mg")
    assert G.render(ex.extract([seg("metformin 500MG")])) == G.render(ex.extract([seg("metformin 500 mg")])) == "metformin 500 mg"


def test_unitless_number_does_not_stop_the_search():   # N4
    ex = G.ReferenceExtractor(GEN)
    e = ex.extract([seg("metformin 2 times 500 mg")])[0]
    assert (e["dose_value"], e["unit"]) == (500.0, "mg")


def test_all_distinct_doses_shown():               # B3
    ex = G.ReferenceExtractor(GEN)
    ents = ex.extract([seg("metformin 500 mg"), seg("metformin 650 mg"), seg("metformin 500 mg")])
    assert G.render(ents) == "metformin 500 mg; 650 mg"


def test_rerun_never_desyncs_items_and_key(tmp_path):   # B1
    items, key, _ = _build()
    out, keys = str(tmp_path / "out"), str(tmp_path / "keys")
    sha = G.write_outputs(items, key, out, keys, "run-x", {})
    before = open(os.path.join(out, "items.json"), "rb").read()
    items2, key2, _ = _build(seed=2)
    try:
        G.write_outputs(items2, key2, out, keys, "run-x", {})
        assert False
    except FileExistsError:
        pass
    assert open(os.path.join(out, "items.json"), "rb").read() == before
    assert json.load(open(os.path.join(keys, "key.json")))["items_sha256"] == sha


def test_ids_unique_and_spans_valid():             # N2, N3
    items, key, _ = _build()
    assert len({i["item_id"] for i in items}) == len(items)
    assert all(i["span"]["t0_ms"] < i["span"]["t1_ms"] for i in items)


def test_dose_search_stops_at_next_drug():         # refuter-2 #7015 B4
    ex = G.ReferenceExtractor(GEN)
    for text in ("paracetamol and metformin 500 mg", "paracetamol 2 times metformin 500 mg"):
        d = {e["generic"]: e["dose_value"] for e in ex.extract([seg(text)])}
        assert d == {"paracetamol": None, "metformin": 500.0}, (text, d)


def test_over_long_rendering_refused_not_truncated():
    ents = [{"generic": "metformin", "dose_value": v, "unit": "mg"} for v in range(100, 5000, 50)]
    try:
        G.render(ents)
        assert False
    except ValueError:
        pass


def test_s1_reader_pinned_and_reads_native_and_english_by_ear():
    import s1_numbers as N
    rd = N.make_reader(N.load_scorer())
    assert rd(["पाँच", "सौ", "mg"], 0) == (500.0, 2)          # native Hindi, 2-token join, longest wins
    assert rd(["फाइव", "हंड्रेड"], 0) == (500.0, 2)           # English-by-ear in Devanagari
    assert rd(["पचास"], 0) == (50.0, 1)
    assert rd(["दिन"], 0) is None                             # day cue is never a number
    assert rd(["नमस्ते"], 0) is None
    assert rd(["500"], 0) is None                             # digits are the caller's job


def test_extractor_with_s1_reader_reads_native_dose():
    import s1_numbers as N
    cs = N.load_scorer()
    ex = G.ReferenceExtractor(GEN, native_number=N.make_reader(cs), native_unit=N.make_unit_reader(cs))
    e = ex.extract([seg("metformin पाँच सौ मिलीग्राम")])[0]
    assert (e["dose_value"], e["unit"]) == (500.0, "mg")
    e = ex.extract([seg("metformin फाइव हंड्रेड एमजी")])[0]
    assert (e["dose_value"], e["unit"]) == (500.0, "mg")
    e = ex.extract([seg("metformin पाँच सौ mg")])[0]
    assert (e["dose_value"], e["unit"]) == (500.0, "mg")
