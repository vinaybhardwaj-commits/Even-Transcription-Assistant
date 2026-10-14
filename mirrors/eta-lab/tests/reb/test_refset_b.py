import json

import pytest

from kit.reb import jev_client as jc
from kit.reb import refset as rs
from kit.reb import refset_b as rb
from .test_refset import ModeGW, make_env, records_for, report  # noqa: F401  (fixtures: a synthetic consult with different stt and translate text)


class FakeJev:
    model, model_id = "jev-latest", "fake-1"

    def __init__(self, answers=None, boom=None):
        self.requests, self.answers, self.boom = [], answers or {}, boom

    def choose_many(self, state, questions):
        self.requests.append((state, questions))
        if self.boom:
            raise self.boom
        out = {}
        for k, (q, options, escape) in questions.items():
            kind = next((v for needle, v in self.answers.items() if needle.lower() in q.lower()), "not_mentioned")
            out[k] = {"mentioned": {"mentioned": 0.95, "not_mentioned": 0.03, "cannot_tell": 0.02}, "not_mentioned": {"mentioned": 0.02, "not_mentioned": 0.96, "cannot_tell": 0.02},
                      "unsure": {"mentioned": 0.5, "not_mentioned": 0.3, "cannot_tell": 0.2}}[kind]
        return out


def run(env, uid, recs, jev, held=lambda d, r: False):
    return rb.run_b([uid], recs, jev, root=env.root, is_held=held, index_path=env.index, clips_root=env.clips)


def test_verdict_thresholds_are_in_code_and_inclusive_at_0_80():
    assert rb.verdict({"mentioned": 0.80, "not_mentioned": 0.1}) == "mentioned"
    assert rb.verdict({"mentioned": 0.79, "not_mentioned": 0.2}) == "cannot_tell"
    assert rb.verdict({"mentioned": 0.1, "not_mentioned": 0.80}) == "not_mentioned"
    assert rb.verdict({"mentioned": 0.5, "not_mentioned": 0.3, "cannot_tell": 0.2}) == "cannot_tell" and rb.verdict({}) == "cannot_tell"
    assert (rb.MENTIONED_P, rb.NOT_MENTIONED_P) == (0.80, 0.80)


def test_state_marks_its_source_and_prefers_the_translation():
    stt = {"segments": [{"t0_ms": 2, "t1_ms": 3, "speaker": "1", "text": "native b"}, {"t0_ms": 0, "t1_ms": 1, "speaker": "0", "text": "native a"}, {"t0_ms": 4, "t1_ms": 5, "speaker": "0", "text": " "}]}
    tr = {"segments": [{"t0_ms": 0, "t1_ms": 1, "speaker": "0", "text": "english a"}]}
    s, src = rb.build_state(stt, tr)
    assert src == "translate" and s == "Source: English translation (Sarvam)\n[0] english a"
    s, src = rb.build_state(stt, None)
    assert src == "stt" and s == "Source: original-language transcript (Sarvam)\n[0] native a\n[1] native b"            # time order; blank segments dropped
    assert rb.display_name(rs.Term("drug", ["Paracetamol 650 Mg", "DOLO 650MG TAB", "paracetamol 650 mg"])) == "Paracetamol 650 Mg (also written as: DOLO 650MG TAB)"
    assert rb.display_name(rs.Term("diagnosis", ["Hip Pain"])) == "Hip Pain"


def test_one_request_per_consult_one_question_per_term_and_the_per_term_comparison(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    jev = FakeJev({"glycomet": "mentioned", "hypertension": "mentioned", "hba1c": "mentioned", "warfarin": "not_mentioned"})
    R, dis = run(env, uid, records_for(uid), jev)
    assert len(jev.requests) == 1 and len(jev.requests[0][1]) == 4                                                          # ONE request, 4 terms
    state, qs = jev.requests[0]
    assert state.startswith("Source: English translation (Sarvam)\n[0] ") and "hba1c report and metformin" in state
    q = qs["t0"][0]
    assert "Metformin" in q and "Glycomet" in q and "or a clear equivalent" in q and "same test without its qualifier" in q and qs["t0"][1:] == (["mentioned", "not_mentioned"], "cannot_tell")
    p = R["per_consult"][0]
    assert p["text_source"] == "translate" and [t["b"] for t in p["terms"]] == ["mentioned", "mentioned", "mentioned", "not_mentioned"]
    assert [(t["a_stt"], t["a_translate"]) for t in p["terms"]] == [(True, True), (True, False), (False, True), (False, False)]
    A = R["aggregates"]["agreement_per_term"]
    assert A["drug"]["both_found"] == 1 and A["drug"]["neither"] == 1 and A["drug"]["terms"] == 2
    assert A["diagnosis"]["both_found"] == 1 and A["investigation"]["both_found"] == 1
    assert R["aggregates"]["never_said_aloud"]["drug"] == {"terms": 2, "b_not_mentioned": 1, "b_not_mentioned_and_a_not_found_anywhere": 1, "b_cannot_tell": 0,
                                                           "share_b_not_mentioned": 0.5, "share_both_say_absent": 0.5}
    assert R["aggregates"]["recall"]["all"]["drug"]["matcher_b_mentioned"]["median"] == 0.5 and R["aggregates"]["recall"]["all"]["drug"]["matcher_a_either"]["median"] == 0.5
    assert dis == {}                                                                                                          # A and B agree on every term
    assert R["judge"] == {"configured": "jev-latest", "reported": "fake-1"} and R["counts"] == {"asked": 1, "scored": 1}


def test_disagreements_go_to_the_separate_file_with_names_never_into_the_results(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    jev = FakeJev({"warfarin": "mentioned", "glycomet": "not_mentioned", "hypertension": "unsure", "hba1c": "mentioned"})       # B finds what A missed, misses what A found, and is unsure on one
    R, dis = run(env, uid, records_for(uid), jev)
    cells = R["aggregates"]["agreement_per_term"]
    assert cells["drug"]["b_only"] == 1 and cells["drug"]["a_only_b_not_mentioned"] == 1 and cells["diagnosis"]["a_only_b_cannot_tell"] == 1
    assert sorted((d["category"], d["a_found"], d["b"]) for d in dis[uid]) == [("drug", False, "mentioned"), ("drug", True, "not_mentioned")]      # cannot_tell is not a disagreement
    assert {"Warfarin", "Metformin"} <= {n for d in dis[uid] for n in d["names"]}
    dump = json.dumps(R).lower()
    for secret in ("warfarin", "metformin", "glycomet", "hypertension", "hba1c", "discussed"):
        assert secret not in dump                                                                                             # no record names, no transcript text in the results


def test_guards_blind_join_exclusion_no_terms_and_jev_errors_send_nothing_or_count(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    jev = FakeJev()
    R, _ = run(env, uid, records_for(uid), jev, held=lambda d, r: True)
    assert R["counts"] == {"asked": 1, "blind_refused": 1} and jev.requests == []
    recs = records_for(uid)
    recs[uid]["prescriptions"] = {"p1", "p2"}
    R, _ = run(env, uid, recs, jev)
    assert R["counts"] == {"asked": 1, "join_excluded": 1} and jev.requests == []
    R, _ = run(env, uid, {}, jev)
    assert R["counts"] == {"asked": 1, "no_terms": 1} and jev.requests == []
    R, _ = run(env, "nope", records_for(uid), jev)
    assert R["counts"] == {"asked": 1, "not_a_cut_clip": 1} and jev.requests == []
    R, _ = run(env, uid, records_for(uid), FakeJev(boom=jc.JevError("input_too_large", 400)))
    assert R["counts"] == {"asked": 1, "b_errors": 1, "b_error_input_too_large": 1} and R["per_consult"] == []


def test_terms_a_cannot_score_are_still_asked_and_reported_apart(tmp_path):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    recs = {uid: {"prescriptions": {"p"}, "any_draft": False, "terms": [rs.Term("drug", ["Tablet"]), rs.Term("drug", ["Glycomet"])]}}
    jev = FakeJev({"tablet": "mentioned", "glycomet": "mentioned"})
    R, _ = run(env, uid, recs, jev)
    assert len(jev.requests[0][1]) == 2 and R["aggregates"]["b_on_terms_a_cannot_score"]["drug"] == {"terms": 1, "b_mentioned": 1, "b_not_mentioned": 0, "b_cannot_tell": 0}
    assert R["aggregates"]["agreement_per_term"]["drug"]["terms"] == 1                                                         # the denominator is A's scorable terms
    assert "recall" in rb.table(R).lower() and "Glycomet" not in rb.table(R)
