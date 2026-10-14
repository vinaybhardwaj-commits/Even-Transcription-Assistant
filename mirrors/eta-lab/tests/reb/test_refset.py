import json
import os

import pytest

from kit.reb import refset as rs
from kit.reb import sarvam_lane as sl
from .test_sarvam_lane import DATE, Env, FakeGW, make_row

LOOK = {}
ST = "2026-10-08"


def term(cat, *names, look=None):
    return rs.Term(cat, list(names)).with_synonyms(look or LOOK)


def found(t, text):
    return rs.term_found(t, rs.index_text(text))


def test_normalisation_and_content_words():
    assert rs.norm_text("Metformin-500 mg, Tab.") == "metformin 500 mg tab"
    assert rs.content_words("Metformin 500 mg Tablet", "drug") == ["metformin"]                  # number, unit and dose form all go
    assert rs.content_words("Tab Metformin 500mg", "drug") == ["metformin"]                      # 500mg is a dose token; the dose form goes
    assert rs.content_words("Diabetes of the kidney", "diagnosis") == ["diabetes", "kidney"]     # stopwords go
    assert rs.content_words("Tablet", "diagnosis") == ["tablet"] and rs.content_words("Tablet", "drug") == []


def test_edit_distance_rule_only_for_six_letter_words():
    assert rs.within_one("metformin", "metformine") and rs.within_one("metformin", "metphormin") is False
    assert rs.within_one("amlodipine", "amlodipin") and rs.within_one("abcdef", "abcdxf") and not rs.within_one("abcdef", "abcxxf")
    assert found(term("drug", "pantoprazole"), "he takes pantoprazol daily")                     # 11 letters, one deletion
    assert found(term("drug", "aspirin"), "he takes aspirn daily")                               # 7 letters: one deletion is accepted
    assert found(term("diagnosis", "asthma"), "he has asthmo")                                   # 6 letters is the lower bound for the fuzzy rule
    assert found(term("diagnosis", "asthma"), "he has asthma") and not found(term("drug", "ecg"), "ecq")      # a 3-letter word is exact only
    assert not found(term("diagnosis", "fever"), "he has fevor")                                  # 5 letters: exact only


def test_brand_or_generic_and_synonym_table():
    t = term("drug", "metformin 500 mg tablet", "glycomet")
    assert found(t, "take glycomet twice") and found(t, "take metformin twice") and not found(t, "take paracetamol twice")
    look, sha = rs.load_synonyms()
    assert len(sha) == 64 and "glucophage" in look["metformin"] and "high blood pressure" in look["hypertension"]
    t2 = rs.Term("drug", ["Metformin"]).with_synonyms(look)
    assert found(t2, "he is on glucophage")                                                        # a fixed synonym, not in the record term itself
    assert found(rs.Term("diagnosis", ["Hypertension"]).with_synonyms(look), "your high blood pressure is up")


def test_multi_word_span_of_20_words():
    t = term("diagnosis", "chest pain")
    assert found(t, "the chest has had a pain") and found(t, "pain in the chest")
    gap = " ".join(["x"] * 18)
    assert found(t, f"chest {gap} pain")                                                           # chest at 0, pain at 19: inside a 20-word window
    assert not found(t, f"chest {gap} x pain")                                                     # pain at 20: outside
    assert not found(t, "chest only here") and not found(t, "")
    assert rs.span_ok([[0], [19]]) and not rs.span_ok([[0], [20]]) and rs.span_ok([[5, 40], [41]]) and not rs.span_ok([[1], []])


def test_recall_math_and_counts():
    terms = [term("drug", "metformin"), term("drug", "glimepiride"), term("diagnosis", "hypertension"), term("investigation", "hba1c"), term("drug", "tablet")]
    texts = {"stt": "metformin and hypertension", "translate": "the hba1c test and glimepiride", "router": "tablet"}
    cats, miss = rs.score_consult(terms, texts)
    d = cats["drug"]
    assert d == {"terms": 3, "scorable": 2, "found_stt": 1, "found_translate": 1, "found_either": 2, "found_any": 2}           # 'tablet' alone is not scorable
    assert cats["diagnosis"]["found_stt"] == 1 and cats["investigation"]["found_translate"] == 1 and miss == []
    cats2, miss2 = rs.score_consult([term("drug", "glimepiride")], {"stt": "", "translate": "", "router": "glimepiride tablets"})
    assert cats2["drug"]["found_either"] == 0 and cats2["drug"]["found_any"] == 1 and miss2[0]["found_router"] is True         # only the router heard it
    assert rs.recall_of(d, "stt") == 0.5 and rs.recall_of(d, "either") == 1.0 and rs.recall_of(cats["drug"] | {"scorable": 0}, "either") is None


def test_recall0_reason_codes():
    cats0 = {c: {"terms": 0, "scorable": 0, "found_stt": 0, "found_translate": 0, "found_either": 0, "found_any": 0} for c in rs.CATEGORIES}
    assert rs.recall0_reason(None, cats0, {}) == "join_failed" and rs.recall0_reason({"terms": []}, cats0, {}) == "no_scored_category"      # rows existed, none scored
    c1 = {**cats0, "drug": {"terms": 1, "scorable": 0, "found_stt": 0, "found_translate": 0, "found_either": 0, "found_any": 0}}
    assert rs.recall0_reason({"terms": [1]}, c1, {"stt": "a", "translate": "b"}) == "no_scorable_terms"
    c2 = {**cats0, "drug": {"terms": 1, "scorable": 1, "found_stt": 0, "found_translate": 0, "found_either": 0, "found_any": 0}}
    assert rs.recall0_reason({"terms": [1]}, c2, {"stt": "", "translate": ""}) == "empty_track"                                            # BOTH empty
    assert rs.recall0_reason({"terms": [1]}, c2, {"stt": "", "translate": "text"}) == "all_missed"                                          # one source had text
    assert rs.recall0_reason({"terms": [1]}, c2, {"stt": "x", "translate": "y"}) == "all_missed"
    c3 = {**c2, "drug": {**c2["drug"], "found_either": 1}}
    assert rs.recall0_reason({"terms": [1]}, c3, {"stt": "x", "translate": "y"}) is None


def test_record_loader_formats_pairs_and_failures(tmp_path):
    p = tmp_path / "r.jsonl"
    rows = [{"consult_uid": "u1", "prescription_uid": "p1", "category": "drug", "term": "Metformin", "pair_id": "1"},
            {"consult_uid": "u1", "prescription_uid": "p1", "category": "drug", "term": "Glycomet", "pair_id": "1"},
            {"consult_uid": "u1", "prescription_uid": "p1", "category": "diagnosis", "term": "Diabetes", "alt_term": "type 2 diabetes;dm"},
            {"consult_uid": "u1", "prescription_uid": "p1", "category": "advice", "term": "rest"}]
    p.write_text("\n".join(json.dumps(r) for r in rows))
    rec = rs.load_record_terms(str(p))
    e = rec["u1"]
    assert len(e["terms"]) == 2 and e["prescriptions"] == {"p1"} and not e["any_draft"]                # the advice row is ignored; the pair is ONE drug
    assert found(e["terms"][0], "glycomet") and found(e["terms"][0], "metformin") and found(e["terms"][1], "type 2 diabetes")
    c = tmp_path / "r.csv"
    c.write_text("consult_uid,prescription_uid,category,term,is_draft\nu2,p9,drug,Aspirin,true\n")
    assert rs.load_record_terms(str(c))["u2"]["any_draft"] is True
    bad = tmp_path / "bad.jsonl"
    bad.write_text(json.dumps({"consult_uid": "u", "term": "x"}))
    with pytest.raises(ValueError):
        rs.load_record_terms(str(bad))


def test_join_check():
    def rec(n=1, draft=False, terms=True):
        return {"prescriptions": {f"p{i}" for i in range(n)}, "any_draft": draft, "terms": [1] if terms else []}
    ids = ["a", "b", "c"]
    ok, f = rs.join_check(ids, {"a": rec(), "b": rec(), "c": rec()}, n=3)
    assert ok and len(f["rows"]) == 3 and f["pool_without_rows"] == 0 and f["export_consults_outside_pool"] == 0
    ok, f = rs.join_check(ids, {"a": rec(), "b": rec()}, n=3)                                         # c has no terms: ordinary, not a join failure
    assert ok and f["pool_without_rows"] == 1 and sorted(r["consult_uid"] for r in f["rows"]) == ["a", "b"]
    assert not rs.join_check(ids, {"a": rec(), "b": rec(2), "c": rec()}, n=3)[0]                     # two prescriptions
    assert not rs.join_check(ids, {"a": rec(), "b": rec(draft=True), "c": rec()}, n=3)[0]            # a draft
    ok, f = rs.join_check(ids, {"a": rec(), "zzz": rec()}, n=3)                                       # an export consult that is not in the pool: the uids do not join
    assert not ok and f["export_consults_outside_pool"] == 1
    assert not rs.join_check(ids, {}, n=3)[0]                                                          # nothing joins at all


class ModeGW(FakeGW):
    """Different text for transcribe and translate."""
    def transcribe(self, path, params, sleep=None, on_start=None):
        raw, meta = super().transcribe(path, params, sleep, on_start)
        ents = [{"speaker_id": "0", "start": 1.0, "end": 20.0,
                 "transcript": "he takes glycomet daily and has hypertension" if params["mode"] == "transcribe" else "the hba1c report and metformin are discussed"}]
        raw["0.json"]["diarized_transcript"]["entries"] = ents
        return raw, meta


def make_env(tmp, date=ST):
    row = make_row(date=date)
    env = Env(tmp, [row])
    env.run(ModeGW(), date=date)
    return env, row


RECS = {"drug": ["Metformin", "Glycomet"], "dx": "Hypertension", "inv": "HbA1c", "miss": "Warfarin"}


def records_for(uid):
    p = "p1"
    return {uid: {"prescriptions": {p}, "any_draft": False, "terms": [
        rs.Term("drug", ["Metformin", "Glycomet"], p), rs.Term("diagnosis", ["Hypertension"], p), rs.Term("investigation", ["HbA1c"], p),
        rs.Term("drug", ["Warfarin"], p)]}}


def report(env, ids, recs, held=lambda d, r: False, **kw):
    return rs.run_report(ids, recs, root=env.root, is_held=held, index_path=env.index, clips_root=env.clips, **kw)


def test_run_report_end_to_end_no_text_in_results(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    R, misses = report(env, [uid], records_for(uid))
    p = R["per_consult"][0]
    assert R["counts"] == {"asked": 1, "scored": 1} and p["language_heard"] == "hi-IN" and p["english"] is False
    d = p["categories"]["drug"]
    assert d["scorable"] == 2 and d["found_stt"] == 1 and d["found_translate"] == 1 and d["found_either"] == 1          # glycomet/metformin in both, warfarin in none
    assert p["categories"]["diagnosis"]["found_stt"] == 1 and p["categories"]["investigation"]["found_translate"] == 1 and p["recall0_reason"] is None
    A = R["aggregates"]
    assert A["recall"]["indian_language"]["consults"] == 1 and A["recall"]["english"]["consults"] == 0
    assert A["recall"]["all"]["drug"]["either"]["median"] == 0.5 and A["never_said_aloud"]["drug"]["not_found_anywhere"] == 1
    dump = json.dumps(R)
    for secret in ("glycomet", "metformin", "warfarin", "hypertension", "hba1c", "daily"):
        assert secret not in dump.lower()                                                         # no record text, no transcript text
    assert misses[uid] == [{"category": "drug", "names": ["Warfarin"], "found_router": False}]     # the misses live in the separate (box-only) structure
    assert "Warfarin" not in rs.table(R)


def test_run_report_reason_codes_and_blind(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    R, _ = report(env, [uid], {})                                                                  # no rows in the record file
    assert R["per_consult"][0]["recall0_reason"] == "join_failed" and R["aggregates"]["recall0"]["by_reason"] == {"join_failed": 1}
    R, _ = report(env, [uid], {uid: {"prescriptions": {"p"}, "any_draft": False, "terms": [rs.Term("drug", ["Warfarin"])]}})
    assert R["per_consult"][0]["recall0_reason"] == "all_missed"
    R, _ = report(env, [uid], {uid: {"prescriptions": {"p"}, "any_draft": False, "terms": [rs.Term("drug", ["Tablet"])]}})
    assert R["per_consult"][0]["recall0_reason"] == "no_scorable_terms"
    R, _ = report(env, [uid], records_for(uid), held=lambda d, r: True)                           # blind: refused before any text is read
    assert R["counts"] == {"asked": 1, "blind_refused": 1} and R["per_consult"] == []
    R, _ = report(env, ["nope"], records_for(uid))
    assert R["counts"] == {"asked": 1, "not_a_cut_clip": 1}


def test_candidate_selection_rules_and_cap(tmp_path):
    rows = []
    for i in range(6):
        r = make_row(uid=f"u{i}", date=ST)
        r.update({"doctor_uid": "D1" if i < 4 else f"D{i}", "quality": "clean", "voice_isolated": False, "doctor_split_failed": False})
        rows.append(r)
    rows[1]["quality"] = "unattributed"
    rows[2]["doctor_split_failed"] = True
    rows[3]["minutes"] = 2.0
    env = Env(tmp_path, rows)
    env.run(ModeGW(), date=ST)
    cands, cnt = rs.eligible(sl.latest_rows(env.index), env.root, lambda d, r: False, clips_root=env.clips)
    assert sorted(c["consult_uid"] for c in cands) == ["u0", "u4", "u5"] and cnt["cutter_rules_fail"] == 3
    assert cnt["doctor_days"] == 3 and all(c["english"] is False for c in cands)                  # FakeGW hears hi-IN
    p1 = rs.pick(cands, 10, 8, 1)
    assert len(p1) == 3 and p1 == rs.pick(cands, 10, 8, 1) and len({c["_doctor_day"] for c in p1}) == 3
    assert all("_doctor_day" not in rs.public(c) for c in p1)
    blind, cnt2 = rs.eligible(sl.latest_rows(env.index), env.root, lambda d, r: True, clips_root=env.clips)
    assert blind == [] and cnt2["blind"] == 3


def test_pick_alternates_english_and_indian_and_respects_cap():
    c = [{"consult_uid": f"e{i}", "room_id": f"r{i % 2}", "english": True, "_doctor_day": (f"D{i}", "d")} for i in range(6)]
    c += [{"consult_uid": f"h{i}", "room_id": f"r{i % 2}", "english": False, "_doctor_day": (f"H{i}", "d")} for i in range(6)]
    p = rs.pick(c, 8, 1, 1)
    assert len(p) == 8 and sum(x["english"] for x in p) == 4
    same = [{"consult_uid": f"s{i}", "room_id": "r", "english": True, "_doctor_day": ("D", "d")} for i in range(5)]
    assert len(rs.pick(same, 4, 1, 1)) == 1 and len(rs.pick(same, 4, 1, 2)) == 2 and len(rs.pick(same, 4, 1, 99)) == 4


def test_cli_joincheck_exit_codes_and_private_files(tmp_path, capsys):
    ids = tmp_path / "ids.json"
    ids.write_text(json.dumps({"candidates": [{"consult_uid": "a"}, {"consult_uid": "b"}]}))
    rec = tmp_path / "rec.jsonl"
    rec.write_text("\n".join(json.dumps({"consult_uid": u, "prescription_uid": "p" + u, "category": "drug", "term": "Aspirin"}) for u in "ab"))
    assert rs.main(["joincheck", "--candidates", str(ids), "--record", str(rec)]) == 0
    rec.write_text(json.dumps({"consult_uid": "a", "prescription_uid": "pa", "category": "drug", "term": "Aspirin"}) + "\n"
                   + json.dumps({"consult_uid": "zzz", "prescription_uid": "pz", "category": "drug", "term": "Aspirin"}))
    assert rs.main(["joincheck", "--candidates", str(ids), "--record", str(rec)]) == 2                  # zzz is in the export but not among the consults: the uids do not join
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["ok"] is False
    out = tmp_path / "o.json"
    rs.write_private(str(out), "{}")
    assert oct(os.stat(out).st_mode & 0o777) == "0o600"


def test_final_selection_filters_cap_and_balance():
    def c(uid, room, en, dd):
        return {"consult_uid": uid, "room_id": room, "english": en, "_doctor_day": dd}
    pool = [c(f"a{i}", f"r{i % 2}", i % 2 == 0, ("D1", "d")) for i in range(5)]              # five consults of one doctor-day
    pool += [c(f"b{i}", "r0", False, ("D2", "d")) for i in range(2)] + [c("none", "r0", True, ("D3", "d")), c("two", "r0", True, ("D4", "d")), c("draft", "r0", True, ("D5", "d"))]

    def rec(prescriptions=1, draft=False):
        return {"prescriptions": {f"p{i}" for i in range(prescriptions)}, "any_draft": draft, "terms": [1]}
    records = {**{f"a{i}": rec() for i in range(5)}, "b0": rec(), "b1": rec(), "two": rec(2), "draft": rec(draft=True)}
    picked, cnt = rs.final_selection(pool, records, n=30, per_doctor_day=3, seed=8)
    assert cnt == {"pool": 10, "in_record_file": 9, "exactly_one_signed_prescription": 7, "with_scored_terms": 7, "after_per_doctor_day_cap": 5, "picked": 5,
                   "english_picked": cnt["english_picked"], "indian_language_picked": 5 - cnt["english_picked"]}
    ids = [x["consult_uid"] for x in picked]
    assert sum(1 for i in ids if i.startswith("a")) == 3 and sorted(i for i in ids if i.startswith("b")) == ["b0", "b1"]        # at most 3 of D1's five
    assert "none" not in ids and "two" not in ids and "draft" not in ids
    p2, _ = rs.final_selection(pool, records, n=2, per_doctor_day=3, seed=8)
    assert len(p2) == 2 and p2 == rs.final_selection(pool, records, n=2, per_doctor_day=3, seed=8)[0]                         # seeded
    # balance: English and Indian-language alternate while both exist
    pool2 = [c(f"e{i}", "r", True, (f"E{i}", "d")) for i in range(4)] + [c(f"h{i}", "r", False, (f"H{i}", "d")) for i in range(4)]
    recs2 = {x["consult_uid"]: rec() for x in pool2}
    pk, k2 = rs.final_selection(pool2, recs2, n=6, per_doctor_day=3, seed=1)
    assert k2["english_picked"] == 3 and k2["indian_language_picked"] == 3


def test_main_final_stops_on_a_join_gap_unless_accepted(tmp_path, monkeypatch, capsys):
    import types
    pool = [{"consult_uid": f"u{i}", "room_id": "r", "english": True, "_doctor_day": (f"D{i}", "d")} for i in range(5)]
    monkeypatch.setattr(rs, "eligible", lambda *a, **k: (pool, {}))
    monkeypatch.setattr(rs, "load_heldout", lambda: (lambda d, r: False))
    monkeypatch.setattr(rs.sl, "latest_rows", lambda *a, **k: {})
    rec = tmp_path / "rec.jsonl"
    rec.write_text(json.dumps({"consult_uid": "u0", "prescription_uid": "p", "category": "drug", "term": "Aspirin"}) + "\n"
                   + json.dumps({"consult_uid": "zzz", "prescription_uid": "pz", "category": "drug", "term": "Aspirin"}))              # zzz is not in the pool
    a = types.SimpleNamespace(record=str(rec), root=str(tmp_path), accept_join_gaps=False, pool_n=5, n=30, per_doctor_day=3, synonyms=rs.SYNONYMS_FILE,
                              out=str(tmp_path / "r.json"), misses=str(tmp_path / "m.json"))
    assert rs.main_final(a) == 2 and not os.path.exists(a.out)
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["join_check"] == "FAILED"


def test_number_words_and_digits_match():
    assert rs.norm_text("Type TWO diabetes, ten days") == "type 2 diabetes 10 days"
    t = term("diagnosis", "Type 2 diabetes")
    assert found(t, "he has type two diabetes") and found(t, "type 2 diabetes") and not found(t, "type three diabetes")


def test_advice_only_record_is_joined_but_has_no_scored_category(tmp_path):
    p = tmp_path / "r.jsonl"
    p.write_text(json.dumps({"consult_uid": "u1", "prescription_uid": "p1", "category": "advice", "term": "rest and fluids"}))
    rec = rs.load_record_terms(str(p))
    assert rec["u1"]["terms"] == [] and rec["u1"]["ignored_rows"] == 1 and rec["u1"]["prescriptions"] == {"p1"}
    ok, facts = rs.join_check(["u1"], rec, n=1)
    assert ok and facts["rows"][0]["scored_terms"] == 0                                           # it joined: not a join failure


def test_two_prescriptions_or_a_draft_are_excluded_and_counted_not_scored_silently(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    recs = records_for(uid)
    recs[uid]["prescriptions"] = {"p1", "p2"}
    R, _ = report(env, [uid], recs)
    assert R["counts"] == {"asked": 1, "join_excluded": 1} and R["per_consult"] == [] and R["join_excluded"] == [{"consult_uid": uid, "present": True, "prescriptions": 2, "any_draft": False}]
    recs = records_for(uid)
    recs[uid]["any_draft"] = True
    assert report(env, [uid], recs)[0]["counts"]["join_excluded"] == 1
    R, _ = report(env, [uid], records_for(uid))
    assert R["per_consult"][0]["join"] == {"present": True, "prescriptions": 1, "any_draft": False} and R["per_consult"][0]["empty_sources"] == []


def test_text_present_in_both_sources_all_missed_and_note_in_table(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    recs = {uid: {"prescriptions": {"p"}, "any_draft": False, "terms": [rs.Term("drug", ["Warfarin"])]}}
    R, _ = report(env, [uid], recs)
    assert R["per_consult"][0]["recall0_reason"] == "all_missed" and R["per_consult"][0]["empty_sources"] == []
    assert "stt-only recall is expected to be near 0" in rs.table(R) and "twenty one" in rs.table(R)


def test_pool_has_an_upper_date_bound(tmp_path):
    rows = []
    for i, d in enumerate(("2026-10-08", "2026-10-09", "2026-10-10")):
        r = make_row(uid=f"u{i}", date=d)
        r.update({"doctor_uid": f"D{i}", "quality": "clean", "voice_isolated": False, "doctor_split_failed": False})
        rows.append(r)
    env = Env(tmp_path, rows)
    for d in ("2026-10-08", "2026-10-09", "2026-10-10"):
        env.run(ModeGW(), date=d)
    cands, cnt = rs.eligible(sl.latest_rows(env.index), env.root, lambda d, r: False, clips_root=env.clips)
    assert sorted(c["consult_uid"] for c in cands) == ["u0", "u1"] and cnt["after_until_skipped"] == 1                        # the 10 Oct clip is out
    cands2, _ = rs.eligible(sl.latest_rows(env.index), env.root, lambda d, r: False, until="2026-10-10", clips_root=env.clips)
    assert len(cands2) == 3


def test_final_run_refuses_a_pool_that_is_not_the_expected_size(tmp_path, monkeypatch, capsys):
    import types
    pool = [{"consult_uid": f"u{i}", "room_id": "r", "english": True, "_doctor_day": (f"D{i}", "d")} for i in range(4)]
    monkeypatch.setattr(rs, "eligible", lambda *a, **k: (pool, {"eligible": 4}))
    monkeypatch.setattr(rs, "load_heldout", lambda: (lambda d, r: False))
    monkeypatch.setattr(rs.sl, "latest_rows", lambda *a, **k: {})
    rec = tmp_path / "rec.jsonl"
    rec.write_text("\n".join(json.dumps({"consult_uid": f"u{i}", "prescription_uid": f"p{i}", "category": "drug", "term": "Aspirin"}) for i in range(4)))
    a = types.SimpleNamespace(record=str(rec), root=str(tmp_path), accept_join_gaps=False, pool_n=53, n=30, per_doctor_day=3, synonyms=rs.SYNONYMS_FILE,
                              out=str(tmp_path / "r.json"), misses=str(tmp_path / "m.json"))
    assert rs.main_final(a) == 2 and not os.path.exists(a.out)
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["pool_check"] == "FAILED" and out["pool"] == 4 and out["expected"] == 53 and out["until"] == "2026-10-09"
    monkeypatch.setattr(rs, "run_report", lambda ids, recs, **k: ({"schema": "x", "counts": {}, "aggregates": {"recall0": {"by_reason": {}}}, "synonyms_sha256": "0" * 64,
                                                                   "per_consult": [], "join_excluded": []}, {}))
    monkeypatch.setattr(rs, "table", lambda R: "t")
    a.pool_n = 4                                                                               # told to expect 4: it runs and stores the scope
    assert rs.main_final(a) == 0
    assert json.load(open(a.out))["scope"] == {"since": "2026-10-08", "until": "2026-10-09", "pool": 4, "eligible_counts": {"eligible": 4}}


def test_loader_reads_the_exports_generic_and_brand_columns(tmp_path):
    c = tmp_path / "r.csv"
    c.write_text("consult_uid,prescription_uid,is_draft,uploaded_at,category,term,generic_name,brand_name,strength\n"
                 "u1,p1,false,2026-10-09T10:00:00+05:30,drug,Paracetamol 650 Mg,Paracetamol 650 Mg,DOLO 650MG TAB,650MG\n"
                 "u1,p1,false,2026-10-09T10:00:00+05:30,diagnosis,Acute Febrile Illness ( AFI ),,,\n")
    rec = rs.load_record_terms(str(c))["u1"]
    drug, dx = rec["terms"]
    assert found(drug, "give him dolo twice a day") and found(drug, "paracetamol is fine") and not found(drug, "give him crocin")          # brand OR generic
    assert drug.alts == [["paracetamol"], ["dolo"]] and found(dx, "this is an acute febrile illness") and found(dx, "probably AFI")
    assert rs.paren_parts("Acute Febrile Illness ( AFI )") == ["Acute Febrile Illness", "AFI"] and rs.paren_parts("Ascorbic Acid (Vit C) 500 Mg") == ["Ascorbic Acid 500 Mg", "Vit C"]
    assert rs.paren_parts("Plain term") == ["Plain term"] and rs.paren_parts("(x)") == ["x"]


def test_synonym_lookup_ignores_dose_words_and_the_v1_table_covers_the_export_terms():
    look, sha = rs.load_synonyms()
    t = rs.Term("drug", ["Paracetamol 650 Mg", "DOLO 650MG TAB"]).with_synonyms(look)
    assert found(t, "take crocin if there is fever") and found(t, "dolo is fine")                      # 'paracetamol 650 mg' reaches the paracetamol group
    ix = rs.Term("investigation", ["Glycosylated Haemoglobin (Hba1C) - Whole Blood"]).with_synonyms(look)
    assert found(ix, "check the hba1c") and found(ix, "get an a1c")
    dx = rs.Term("diagnosis", ["Adhesive capsulitis of shoulder"]).with_synonyms(look)
    assert found(dx, "this is a frozen shoulder") and not found(dx, "this is a frozen pipe")
    assert rs.Term("investigation", ["Pap Smear (Conventional Method)"]).with_synonyms(look).alts and len(sha) == 64


def test_dose_tokens_and_forms_with_other_units_are_not_content_words():
    for tok in ("120GM", "30GM", "60K", "3ML", "100gm", "5GM", "650MG", "2"):
        assert rs._DOSE_TOKEN.match(rs.norm_text(tok)), tok
    assert rs.content_words("LOX 2% JELLY 30GM GEL", "drug") == ["lox"] and rs.content_words("LACTIFIBER 120GM", "drug") == ["lactifiber"]
    assert rs.content_words("D RISE 60K CAP", "drug") == ["d", "rise"] and rs.content_words("Clotrimazole Powder 100gm Abzorb 100 Gm Powder", "drug") == ["clotrimazole", "abzorb"]
    assert rs.content_words("Cyanocobalamin 0.5 mg", "drug") == ["cyanocobalamin"]                         # the decimal point splits into two digit tokens, both dropped
    assert rs.content_words("Hip Pain 120", "diagnosis") == ["hip", "pain", "120"]                         # only drugs drop dose words and numbers
    assert found(rs.Term("drug", ["Lactulose 10 G/15 Ml", "LACTIFIBER 120GM"]), "he takes lactifiber at night")
