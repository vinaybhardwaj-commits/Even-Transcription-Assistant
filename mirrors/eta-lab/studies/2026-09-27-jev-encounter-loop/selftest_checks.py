#!/usr/bin/env python3
"""Offline checks for the W44 Jev encounter-loop (lx). NOTHING here touches a database, the Mini, or a
real Jev call — every check runs on synthetic fixtures the test itself builds, or scores an
already-checked-in fixture with the REAL, unmodified fullday_score.py/e7_score.py. Run: python3
selftest_checks.py (see selftest.sh for the house-style wrapper). Development day for this fixture is
synthetic/25 Sep — never 26 Sep (README "Development-vs-exit-test day split").
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "2026-09-24-encounter-first"))
sys.path.insert(0, os.path.join(HERE, "..", "2026-09-24-voice-jev", "arms"))
import candidates as CAND
import chunker
import jev_client
import jev_loop_constants as K
import run_loop
import segmenter as S
import state_machine as SM

FAIL = []


def ok(name):
    print(f"  ok  {name}")


def fail(name, detail=""):
    print(f"  FAIL {name}: {detail}")
    FAIL.append(name)


def check(name, cond, detail=""):
    ok(name) if cond else fail(name, detail)


def _times(encs):
    """Strip back_to_back_start/end (and any other bookkeeping) down to just start_ms/end_ms, for
    tests that only care about where the boundaries landed, not the #4633 bias flags."""
    return [{"start_ms": e["start_ms"], "end_ms": e["end_ms"]} for e in encs]


def mk_turn(t0, t1, orig, role="clinician", speaker=0, source_ref=None):
    return {"start_ms": t0, "end_ms": t1, "orig": orig, "lang": "en", "speaker_idx": speaker, "role": role,
            "source_ref": source_ref or f"sess|{t0}|{t1}|-"}


# ---- T0: chunker groups turns without splitting one, silence gaps computed correctly ----
def test_chunker():
    turns = [mk_turn(0, 20_000, "a"), mk_turn(25_000, 70_000, "b"), mk_turn(80_000, 90_000, "c")]
    translations = {t["source_ref"]: t["orig"].upper() for t in turns}
    chunks, prev = chunker.build_chunks(turns, translations, "TestRoom", "2026-09-25", "rd1", target_ms=60_000)
    check("chunker: 2 chunks from 3 turns (60s target)", len(chunks) == 2, f"got {len(chunks)}")
    check("chunker: chunk0 spans turn0+turn1 (never splits a turn)",
          chunks[0]["start_ms"] == 0 and chunks[0]["end_ms"] == 70_000, chunks[0] if chunks else None)
    check("chunker: silence_before_ms None on the first chunk", chunks[0]["silence_before_ms"] is None)
    check("chunker: silence_after_ms = gap to the next chunk's first turn",
          chunks[0]["silence_after_ms"] == 80_000 - 70_000, chunks[0].get("silence_after_ms"))
    check("chunker: prev_texts[0] == '' , prev_texts[1] == chunk0.text", prev[0] == "" and prev[1] == chunks[0]["text"])
    turns2 = [mk_turn(0, 10_000, "x", source_ref="sr-missing")]
    chunks2, _ = chunker.build_chunks(turns2, {}, "TestRoom", "2026-09-25", "rd2")
    check("chunker: translation_missing=True with no translation entry", chunks2[0]["translation_missing"] is True)


# ---- T1: regex candidates ----
def test_candidates():
    opening = {"orig": "Please come in, sit down"}
    closing = {"orig": "Come back after 2 weeks, thank you"}
    neither = {"orig": "the BP reading is stable today"}
    check("candidates: opening phrase hits opening", CAND.hits(opening)["opening"] is True)
    check("candidates: opening phrase does not hit closing", CAND.hits(opening)["closing"] is False)
    check("candidates: closing phrase hits closing", CAND.hits(closing)["closing"] is True)
    check("candidates: neutral text hits neither", not CAND.hits(neither)["opening"] and not CAND.hits(neither)["closing"])


# ---- T2: state machine transitions on hand-crafted deterministic answers ----
def _ans(phase, phase_conf, opening_p, closing_p, present, new_patient=0.1):
    probs = {p: 0.01 for p in K.PHASE_OPTIONS}
    probs[phase] = 1 - 0.01 * (len(K.PHASE_OPTIONS) - 1)
    return {"phase": phase, "phase_confidence": phase_conf, "phase_probs": probs,
            "nouls": {"opening": opening_p, "closing": closing_p, "patient_present": present, "new_patient": new_patient}}


def test_state_machine():
    chunks = [{"start_ms": i * 60_000, "end_ms": (i + 1) * 60_000} for i in range(5)]
    cand_none = {"opening": False, "closing": False}
    answers = [
        _ans("between_patients_or_admin", 0.9, 0.0, 0.0, present=0.1),   # 0 BETWEEN: admin
        _ans("greeting_or_opening", 0.9, 0.9, 0.0, present=0.9),          # 1 opens
        _ans("history_taking", 0.8, 0.0, 0.0, present=0.9),               # 2 stays in
        _ans("closing_or_follow_up_instructions", 0.9, 0.0, 0.9, present=0.9),  # 3 closes
        _ans("between_patients_or_admin", 0.9, 0.0, 0.0, present=0.1),    # 4 BETWEEN again
    ]
    cands = [cand_none] * 5
    states, encounters = SM.run(chunks, answers, cands)
    check("state_machine: states = BETWEEN,IN,IN,IN,BETWEEN",
          states == ["BETWEEN", "IN_ENCOUNTER", "IN_ENCOUNTER", "IN_ENCOUNTER", "BETWEEN"], states)
    check("state_machine: exactly one encounter, chunk1 start to chunk3 end",
          _times(encounters) == [{"start_ms": 60_000, "end_ms": 240_000}], encounters)
    # translation_missing (answer=None) falls back to candidates only, and does not force a close by itself
    answers2 = [None, _ans("greeting_or_opening", 0.9, 0.9, 0.0, present=0.9), None]
    chunks2 = [{"start_ms": 0, "end_ms": 60_000}, {"start_ms": 60_000, "end_ms": 120_000}, {"start_ms": 120_000, "end_ms": 180_000}]
    cands2 = [{"opening": False, "closing": False}, {"opening": False, "closing": False}, {"opening": False, "closing": False}]
    _, enc2 = SM.run(chunks2, answers2, cands2)
    check("state_machine: no-answer chunk after opening stays IN_ENCOUNTER to the room-day end",
          _times(enc2) == [{"start_ms": 60_000, "end_ms": 180_000}], enc2)


def test_back_to_back(chunks_n=4):
    # S1 (eta-refuter-2 #4612): "take care ... next, please sit" — one chunk both closes and opens.
    chunks3 = [{"start_ms": i * 60_000, "end_ms": (i + 1) * 60_000} for i in range(chunks_n)]
    answers3 = [
        _ans("greeting_or_opening", 0.9, 0.9, 0.0, present=0.9),                        # 0 opens consult A
        _ans("closing_or_follow_up_instructions", 0.9, 0.9, 0.9, present=0.9),          # 1 closes A, opens B
        _ans("history_taking", 0.8, 0.0, 0.0, present=0.9),                             # 2 stays in B
        _ans("between_patients_or_admin", 0.9, 0.0, 0.0, present=0.1),                  # 3 closes B
    ]
    cands3 = [{"opening": False, "closing": False}] * chunks_n
    _, enc3 = SM.run(chunks3, answers3, cands3)
    check("state_machine (S1): a chunk that closes one encounter can also open the next in the same tick",
          _times(enc3) == [{"start_ms": 0, "end_ms": 120_000}, {"start_ms": 60_000, "end_ms": 240_000}], enc3)
    check("state_machine (#4633): back_to_back flags mark the shared-chunk boundary on both sides",
          enc3[0]["back_to_back_end"] is True and enc3[1]["back_to_back_start"] is True
          and enc3[0]["back_to_back_start"] is False and enc3[1]["back_to_back_end"] is False, enc3)
    snapped3 = SM.snap_boundaries(enc3, [], [], "2026-09-25")  # no levels: flags must survive the pass-through path
    check("snap_boundaries: back_to_back flags pass through untouched",
          snapped3[0]["back_to_back_end"] is True and snapped3[1]["back_to_back_start"] is True, snapped3)


def test_snap_guards():
    date = "2026-09-25"
    d0, _ = S.day_bounds(date)
    # one isolated active bin -> on-edge at d0+3.6e6, off-edge 10s later (segmenter bins at BIN_S=10s):
    # q20 comes from the one low sample (1.0), the one high sample (10.0) is the only bin >= 1.5*q20.
    edges_levels = [(d0, 1.0), (d0 + 3_600_005, 10.0)]
    # both raw edges sit a couple ms from the SAME on-edge (the off-edge is ~10s away, outside window_ms)
    # -> both snap to one point -> an inverted/zero-width span -> must fall back to the raw span, not that point.
    inverted_raw = [{"start_ms": d0 + 3_600_002, "end_ms": d0 + 3_600_004}]
    snapped = SM.snap_boundaries(inverted_raw, edges_levels, [], date, window_ms=100)
    check("snap guard: an inverting snap falls back to the raw (un-snapped) span",
          snapped[0]["start_ms"] == d0 + 3_600_002 and snapped[0]["end_ms"] == d0 + 3_600_004, snapped)

    # T2: two encounters a snap (or an upstream bug) left overlapping get clamped, not silently kept
    overlapping = [{"start_ms": 0, "end_ms": 1000}, {"start_ms": 500, "end_ms": 1500}]
    fixed = SM.snap_boundaries(overlapping, [], [], date)
    check("snap guard: an overlapping successor is clamped to its predecessor's end",
          fixed[1]["start_ms"] == 1000 and fixed[1]["end_ms"] == 1500, fixed)

    # T3: clamping that still can't produce a valid span fails loud, not silently
    unfixable = [{"start_ms": 0, "end_ms": 2000}, {"start_ms": 500, "end_ms": 1000}]
    raised = False
    try:
        SM.snap_boundaries(unfixable, [], [], date)
    except SystemExit as e:
        raised = "inverted/empty span" in str(e)
    check("snap guard: an unfixable clamp raises loudly instead of emitting a bad span", raised)


# ---- T3: boundary snapping to an acoustic activity edge ----
def test_snap():
    date = "2026-09-25"
    d0, _ = S.day_bounds(date)
    edge_t = d0 + 3600_000  # an activity edge 1h into the clinical day
    levels = [(edge_t - 2000, 0.1), (edge_t - 1000, 0.1), (edge_t, 5.0), (edge_t + 1000, 5.0), (edge_t + 2000, 5.0)]
    encounters = [{"start_ms": edge_t + 3000, "end_ms": edge_t + 4000}]  # start within window, end just outside it
    # (window=3200: start's 3000ms diff qualifies, end's 4000ms diff doesn't — this exercises an
    # independent single-side snap, distinct from test_snap_guards' both-sides-collapse case)
    snapped = SM.snap_boundaries(encounters, levels, [], date, window_ms=3200)
    check("snap: start within window snaps to the activity edge, end outside it is untouched",
          snapped[0]["start_ms"] == edge_t and snapped[0]["end_ms"] == edge_t + 4000, snapped)
    far = [{"start_ms": edge_t + 50_000, "end_ms": edge_t + 60_000}]  # far outside the window
    snapped2 = SM.snap_boundaries(far, levels, [], date, window_ms=5000)
    check("snap: a boundary outside the window is left unchanged",
          snapped2[0]["start_ms"] == edge_t + 50_000, snapped2)
    check("snap: no levels -> encounters pass through unchanged",
          SM.snap_boundaries(far, [], [], date)[0]["start_ms"] == edge_t + 50_000)


# ---- T4/T5: jev_client contract + the model-pin hard refusal (G4) ----
def test_jev_client():
    chunk = {"text": "how long have you had this pain", "translation_missing": False}
    a = jev_client.answer_chunk(chunk, "", backend="mock")
    check("jev_client: mock answer has phase/nouls/model", a and a["model"] == K.JEV_MODEL and set(K.NOULS) <= set(a["nouls"]))
    check("jev_client: a translation_missing chunk gets no Jev call (None)",
          jev_client.answer_chunk({"text": "", "translation_missing": True}, "", backend="mock") is None)

    drifted = jev_client.mock_call
    try:
        jev_client.mock_call = lambda state, qs: {**drifted(state, qs), "model": "jev-latest"}
        raised = False
        try:
            jev_client.answer_chunk(chunk, "", backend="mock")
        except SystemExit as e:
            raised = "model drift" in str(e)
        check("jev_client: G4 hard refusal on a model that isn't the pin", raised)
    finally:
        jev_client.mock_call = drifted


# ---- T6: PARTIAL COVERAGE threshold frozen at 20% (eta-refuter-2 #4464 G1) ----
def test_partial_coverage():
    def coverage_for(n_missing, n_total):
        turns = [mk_turn(i * 70_000, i * 70_000 + 65_000, f"t{i}") for i in range(n_total)]
        translations = {t["source_ref"]: (None if i < n_missing else "english") for i, t in enumerate(turns)}
        chunks, _ = chunker.build_chunks(turns, translations, "TestRoom", "2026-09-25", "rdX", target_ms=1)
        n_miss = sum(1 for c in chunks if c["translation_missing"])
        return "PARTIAL" if chunks and n_miss / len(chunks) > K.PARTIAL_COVERAGE_SHARE else "FULL"

    check("coverage: exactly 20% missing is FULL (frozen threshold is '> 20%', not '>= 20%')",
          coverage_for(1, 5) == "FULL", "1/5 = 20%")
    check("coverage: 21%+ missing is PARTIAL", coverage_for(3, 10) == "PARTIAL", "3/10 = 30%")


# ---- T7: G2 — e7_score.py's real (unmodified) split pairing is best-overlap, not first/last span ----
def test_split_pairing():
    e7_path = os.path.join(HERE, "..", "2026-09-23-e7-pqm-truth")
    sys.path.insert(0, e7_path)
    import e7_score as E7
    truth = [{"start_ms": 0, "end_ms": 600_000}]  # one 10-min consult
    # neither hyp contains the truth interval (that would trivially score frac=1.0 for both): staggered overlaps,
    # frac = overlap / shorter(truth_dur, hyp_dur) — b's overlap fraction (0.8) beats a's (0.75).
    hyps = [{"id": "a", "start_ms": -100_000, "end_ms": 300_000},   # overlap 300s / shorter(600,400)=400s = 0.75
            {"id": "b", "start_ms": 200_000, "end_ms": 700_000}]    # overlap 400s / shorter(600,500)=500s = 0.80
    s = E7.score_room_day(truth, hyps)
    check("split-pairing: e7_score picks the higher-overlap hyp (b, frac 0.80 > a's 0.75) for the error pair (e7_score.py:71)",
          s["start_errs_s"] and s["start_errs_s"][0] == 200.0 and s["end_errs_s"][0] == 100.0,
          (s["start_errs_s"], s["end_errs_s"]))
    check("split-pairing: this consult is correctly counted as a split (2 matching hyps)", s["splits"] == 1, s["splits"])


# ---- T8: end-to-end — run_loop's output shape scores cleanly through the REAL, unmodified harness ----
def test_end_to_end_score(tmpdir):
    from datetime import datetime
    date, room, rd_id, transcript = "2026-09-25", "TestRoom", "rd-e2e", "selftest-fixture"
    base = int(datetime.fromisoformat("2026-09-25T10:00:00+05:30").timestamp() * 1000)  # anchor chunks to the
    # same epoch the truth CSV's ISO timestamps resolve to — using unrelated epochs was T8's original bug.
    chunks = [{"start_ms": base + i * 60_000, "end_ms": base + (i + 1) * 60_000, "translation_missing": False}
              for i in range(5)]
    answers = [
        _ans("between_patients_or_admin", 0.9, 0.0, 0.0, present=0.1),
        _ans("greeting_or_opening", 0.9, 0.9, 0.0, present=0.9),
        _ans("history_taking", 0.8, 0.0, 0.0, present=0.9),
        _ans("closing_or_follow_up_instructions", 0.9, 0.0, 0.9, present=0.9),
        _ans("between_patients_or_admin", 0.9, 0.0, 0.0, present=0.1),
    ]
    cands = [{"opening": False, "closing": False}] * 5
    states, raw_enc = SM.run(chunks, answers, cands)
    encounters = SM.snap_boundaries(raw_enc, [], [], date)  # no level log in this fixture: pass-through
    result = {"chunks": chunks, "answers": answers, "encounters": encounters, "coverage": "FULL", "n_missing": 0,
              "meta_by_enc": [{"conf": 0.9, "phase_probs": None}]}
    out_dir = os.path.join(tmpdir, "out")
    tl_dir = os.path.join(tmpdir, "timeline")
    hyp_path, tl_path = run_loop.write_outputs(out_dir, tl_dir, room, date, rd_id, transcript, result)
    hyp = json.load(open(hyp_path))
    written = hyp["room_days"][rd_id]["encounters"]
    check("e2e: hyp-jevloop.json has the harness-required top-level keys",
          {"source", "room_days"} <= set(hyp) and _times(written) == _times(encounters), hyp)
    check("e2e: back_to_back_start/end recorded on every encounter (#4633, default False)",
          all({"back_to_back_start", "back_to_back_end"} <= set(e) for e in written), written)
    check("e2e: jev_model + constants_sha256 recorded (G4)",
          hyp.get("jev_model") == K.JEV_MODEL and hyp.get("constants_sha256"))
    tl_file = json.load(open(tl_path))
    check("e2e: timeline/<room>/<date>.json matches lab-viewer's TIMELINE-SHAPES.md (schema/detected.jev_loop)",
          tl_file.get("schema") == 1 and len(tl_file["detected"]["jev_loop"]) == len(encounters), tl_file)
    check("e2e: pqm_truth/cap_links are never written by lx (linker/cap's keys, TIMELINE-SHAPES.md)",
          "pqm_truth" not in tl_file and "cap_links" not in tl_file, tl_file)

    from datetime import datetime, timezone, timedelta
    ist = timezone(timedelta(hours=5, minutes=30))
    called = datetime.fromtimestamp((base + 70_000) / 1000, tz=ist).isoformat()
    completed = datetime.fromtimestamp((base + 230_000) / 1000, tz=ist).isoformat()
    truth_csv = os.path.join(tmpdir, "truth.csv")
    with open(truth_csv, "w") as f:
        f.write("room,date,token_uid,called_at,completed_at\n")
        f.write(f"{room},{date},tok1,{called},{completed}\n")
    score_md = os.path.join(tmpdir, "score.md")
    score_json = os.path.join(tmpdir, "score.json")
    scorer = os.path.join(HERE, "..", "2026-09-26-fullday-rescore", "fullday_score.py")
    r = subprocess.run([sys.executable, scorer, "--truth", truth_csv, "--hyp", hyp_path,
                        "--transcript", transcript, "--date", date, "--out", score_md, "--json", score_json],
                       capture_output=True, text=True)
    check("e2e: the REAL, unmodified fullday_score.py scores this hyp file cleanly (rc=0)",
          r.returncode == 0, r.stderr[-500:] if r.returncode else "")
    if r.returncode == 0:
        found = json.load(open(score_json))["arms"]["hyp-jevloop.json"]["found"]
        check("e2e: the synthetic consult is found (falls inside the detected encounter)", found == 1, found)


def main():
    test_chunker()
    test_candidates()
    test_state_machine()
    test_back_to_back()
    test_snap()
    test_snap_guards()
    test_jev_client()
    test_partial_coverage()
    test_split_pairing()
    with tempfile.TemporaryDirectory(prefix="lx-w44-selftest-") as t:
        test_end_to_end_score(t)
    if FAIL:
        print(f"SELFTEST_FAIL ({len(FAIL)} failed: {', '.join(FAIL)})")
        return 1
    print("SELFTEST_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
