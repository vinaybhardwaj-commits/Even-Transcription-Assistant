"""CLEF-D2-R4: role_clef slot choice, the Clef call shape, and the per-clip pipeline override. Fakes only: synthetic audio and
probabilities, a faked Clef transport, no network, never real audio."""
from __future__ import annotations

import json
import logging

import numpy as np
import pandas as pd
import pytest

from tools.timbre import role_clef
from tools.timbre.audio import synth_speech, write_wav
from tools.timbre.extractors import clef_omni as clef
from tools.timbre.nemotron_probs import pack_nlp
from tools.timbre.pipeline import PipelineConfig, main, run_pipeline

FRAME_MS = 10.0
SR = 16_000


def scene(runs: dict[int, list[tuple[float, float]]], total_s: float = 40.0, n_slots: int = 3):
    """probs (frames, slots) with 0.95 on the owning slot for each (start_s, end_s) run, and a noise wav of total_s."""
    n = int(total_s * 1000 / FRAME_MS)
    probs = np.full((n, n_slots), 0.02)
    for slot, spans in runs.items():
        for a, b in spans:
            probs[int(a * 100): int(b * 100), :] = 0.02
            probs[int(a * 100): int(b * 100), slot] = 0.95
    wav = (np.random.default_rng(7).standard_normal(int(total_s * SR)) * 0.1).astype(np.float32)
    return probs, wav


class FakeRole:
    """ask_role returns the queued distributions in call order and records what it was sent."""

    def __init__(self, dists, tokens=1000):
        self.dists, self.tokens, self.sent = list(dists), tokens, []

    def ask_role(self, snippets):
        self.sent.append(snippets)
        return self.dists.pop(0), self.tokens


DOC = [0.8, 0.1, 0.05, 0.05]
PAT = [0.1, 0.75, 0.1, 0.05]
RUNS = {0: [(0, 12), (20, 28)], 1: [(12, 20), (28, 40)]}  # 20 s and 20 s; a third slot (2) has none


def test_clear_doctor_and_patient():
    probs, wav = scene(RUNS)
    fake = FakeRole([DOC, PAT])
    r = role_clef.decide_part("c-s0", wav, probs, FRAME_MS, fake)
    assert r == {"clip_id": "c-s0", "doctor_slot": 0, "patient_slot": 1, "decided": True, "reason_code": "decided", "n_calls": 2, "input_tokens": 2000}
    assert list(r) == ["clip_id", "doctor_slot", "patient_slot", "decided", "reason_code", "n_calls", "input_tokens"]  # nothing else leaves


def test_doctor_is_not_always_slot_zero_and_ties_are_deterministic():
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, FakeRole([PAT, DOC]))
    assert (r["doctor_slot"], r["patient_slot"]) == (1, 0)


def test_doctor_margin_below_threshold_is_undecided():
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, FakeRole([[0.7, 0.2, 0.05, 0.05], [0.55, 0.3, 0.1, 0.05]]))  # 0.70 vs 0.55: margin 0.15
    assert r["decided"] is False and r["reason_code"] == "doctor_margin" and r["doctor_slot"] is None and r["patient_slot"] is None
    assert role_clef.DOCTOR_MARGIN_MIN == 0.2


def test_thresholds_are_inclusive_at_the_edge():
    # the pair of (p_doctor, p_patient) per slot cannot sit on both edges in one distribution, so the edge is checked on choose_slots
    assert role_clef.choose_slots({0: 0.8, 1: 0.6}, {0: 0.1, 1: 0.6}) == (0, 1, "decided")  # margin 0.2 (float-safe), p_doctor 0.8, p_patient 0.6
    assert role_clef.choose_slots({0: 0.6, 1: 0.1}, {0: 0.3, 1: 0.6}) == (0, 1, "decided")  # p_doctor exactly 0.6
    assert role_clef.choose_slots({0: 0.8, 1: 0.61}, {0: 0.1, 1: 0.9})[2] == "doctor_margin"


def test_doctor_probability_below_floor_is_undecided():
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, FakeRole([[0.55, 0.3, 0.1, 0.05], [0.1, 0.8, 0.05, 0.05]]))
    assert r["decided"] is False and r["reason_code"] == "doctor_p_low"


def test_patient_probability_below_floor_is_undecided():
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, FakeRole([DOC, [0.1, 0.55, 0.3, 0.05]]))
    assert r["decided"] is False and r["reason_code"] == "patient_p_low" and r["patient_slot"] is None


def test_slot_with_under_six_seconds_is_skipped_and_one_call_per_slot():
    probs, wav = scene({0: [(5.6, 20)], 1: [(20, 40)], 2: [(0.0, 5.5)]})  # slot 2 has 5.5 s of dominant speech
    fake = FakeRole([DOC, PAT])
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, fake)
    assert r["n_calls"] == 2 and len(fake.sent) == 2 and r["decided"] is True  # the 5.5 s slot was never asked about
    assert set(role_clef.qualifying_slots(probs, FRAME_MS, wav)) == {0, 1}


def test_fewer_than_two_slots_makes_no_call():
    probs, wav = scene({0: [(0, 30)]})
    fake = FakeRole([])
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, fake)
    assert r["decided"] is False and r["reason_code"] == "slots_lt2" and r["n_calls"] == 0 and fake.sent == []


def test_snippets_are_3_at_most_4_to_10_s_and_spread():
    probs, wav = scene({0: [(0, 100)], 1: [(100, 130)]}, total_s=130.0)
    snips = role_clef.qualifying_slots(probs, FRAME_MS, wav)
    assert len(snips[0]) == 3 and len(snips[1]) == 3
    assert all(role_clef.SNIPPET_MIN_S <= len(s) / SR <= role_clef.SNIPPET_MAX_S + 1e-6 for s in snips[0] + snips[1])
    dom = role_clef.dominant_audio(probs, FRAME_MS, wav, 0)
    assert np.array_equal(snips[0][0], dom[: len(snips[0][0])])  # time order: the first snippet opens the slot's speech
    assert np.array_equal(snips[0][2], dom[int(round(2 * len(dom) / 3)): int(round(2 * len(dom) / 3)) + len(snips[0][2])])  # spread over the part
    probs, wav = scene({0: [(0, 6.5)], 1: [(7, 14)]}, total_s=14.0)
    assert [len(v) for v in role_clef.qualifying_slots(probs, FRAME_MS, wav).values()] == [1, 1]  # 6.5 s gives one snippet


def test_call_failure_is_no_decision():
    probs, wav = scene(RUNS)

    class Boom:
        def ask_role(self, snippets):
            raise clef.ClefHTTPError(500, "x")

    r = role_clef.decide_part("c", wav, probs, FRAME_MS, Boom())
    assert r["decided"] is False and r["reason_code"] == "call_failed" and r["n_calls"] == 1


def test_budget_stops_further_calls():
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, FakeRole([DOC, PAT], tokens=10_000_000), budget_left_usd=1.0)
    assert r["decided"] is False and r["reason_code"] == "budget" and r["n_calls"] == 1


# ------------------------------------------------------------------------------------------------ the Clef call itself


def role_response(dist, tokens=1234):
    return json.dumps({"success": True, "result": {"answers": {"role": {"probabilities": {str(i): p for i, p in enumerate(dist)}}}, "usage": {"input_tokens": tokens, "output_tokens": 5}}}).encode()


def test_one_request_per_slot_sends_only_state_question_and_audio(tmp_path, monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    monkeypatch.delenv("TIMBRE_CLEF_MOCK", raising=False)
    monkeypatch.setenv("CF_WORKERS_AI_TOKEN", "tok-fake")
    monkeypatch.setenv("CF_ACCOUNT_ID", "acct-fake")
    seen, dists = [], [DOC, PAT]

    def transport(prepared):
        seen.append(prepared.body)
        return clef.HttpResult(200, {}, role_response(dists[len(seen) - 1]))

    client = role_clef.RoleClient(transport=transport, cache_dir=tmp_path / "c", cost_log=tmp_path / "cost.jsonl")
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c-s0", wav, probs, FRAME_MS, client)
    assert (r["doctor_slot"], r["patient_slot"], r["n_calls"], r["input_tokens"]) == (0, 1, 2, 2468)
    assert len(seen) == 2  # exactly one request per qualifying slot
    for body in seen:
        assert set(body) == {"model", "state", "audio", "questions"}  # no text, transcript, id or name field
        assert body["state"] == "Clinic consultation audio. All clips are the same speaker. Decide who this speaker is."
        assert body["questions"] == {"role": {"type": "score", "instructions": "Who is this speaker?", "criteria": ["doctor", "patient", "attender or family", "other staff"]}}
        assert 1 <= len(body["audio"]) <= 3 and all(a.startswith("data:audio/wav;base64,") for a in body["audio"])
    cost = [json.loads(line) for line in (tmp_path / "cost.jsonl").read_text().splitlines()]
    assert len(cost) == 2 and all(c["billed"] and c["input_tokens"] == 1234 for c in cost)
    assert "tok-fake" not in (tmp_path / "cost.jsonl").read_text()


def test_clef_off_refuses_before_any_request(tmp_path, monkeypatch):
    monkeypatch.delenv("TIMBRE_CLEF", raising=False)
    called = []
    client = role_clef.RoleClient(transport=lambda p: called.append(p), cache_dir=tmp_path, cost_log=tmp_path / "cost.jsonl")
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, client)
    assert called == [] and r["decided"] is False and r["reason_code"] == "call_failed"


def test_mock_mode_makes_no_request(tmp_path, monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    monkeypatch.setenv("TIMBRE_CLEF_MOCK", "1")
    client = role_clef.RoleClient(transport=lambda p: pytest.fail("network"), cache_dir=tmp_path, cost_log=tmp_path / "cost.jsonl")
    probs, wav = scene(RUNS)
    r = role_clef.decide_part("c", wav, probs, FRAME_MS, client)
    assert r["n_calls"] == 2 and r["input_tokens"] == 0


def test_logs_carry_codes_and_counts_only(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    monkeypatch.setenv("CF_WORKERS_AI_TOKEN", "tok-fake")
    monkeypatch.setenv("CF_ACCOUNT_ID", "acct-fake")
    client = role_clef.RoleClient(transport=lambda p: clef.HttpResult(200, {}, role_response(DOC)), cache_dir=tmp_path, cost_log=tmp_path / "cost.jsonl")
    probs, wav = scene(RUNS)
    with caplog.at_level(logging.DEBUG):
        role_clef.decide_part("secret-clip-id-s0", wav, probs, FRAME_MS, client)
    text = "\n".join(r.getMessage() for r in caplog.records)
    for bad in ("secret-clip-id", "tok-fake", "acct-fake", "data:audio", "doctor", "patient"):
        assert bad not in text


def test_roles_file_keeps_only_decided_entries(tmp_path):
    path = tmp_path / "roles.json"
    role_clef.write_roles({"a": {"clip_id": "a", "doctor_slot": 0, "patient_slot": 1, "decided": True, "reason_code": "decided", "n_calls": 2, "input_tokens": 1},
                           "b": {"clip_id": "b", "doctor_slot": None, "patient_slot": None, "decided": False, "reason_code": "doctor_margin", "n_calls": 2, "input_tokens": 1}}, path)
    assert role_clef.load_roles(str(path)) == {"a": {"doctor_slot": 0, "patient_slot": 1}}


# ------------------------------------------------------------------------------------------------ pipeline override

N_FRAMES = 400  # 4 s at 10 ms, as tests/test_pipeline.py's Nemotron clip


class Fake:
    def __init__(self, arousal=0.3, valence=4.0):
        self.arousal, self.valence, self.n = arousal, valence, 0

    def extract(self, audio, sr):
        self.n += 1
        return {"status": "ok", "features": {"arousal": self.arousal, "valence": self.valence, "dominance": 0.0}}


def build_inputs(tmp_path):
    """clipA: doctor d0000001 HAS a centroid. clipB: doctor d0000002 has none (would be no_voiceprint). Same probs/embeddings:
    slot 0 first 0.5 s, slot 1 the rest; embeddings separate the two slots."""
    probs = np.zeros((N_FRAMES, 2))
    probs[:50, 0], probs[:50, 1], probs[50:, 0], probs[50:, 1] = 0.95, 0.05, 0.05, 0.95
    emb = np.zeros((N_FRAMES, 2))
    emb[:50, 1], emb[50:, 0] = 1.0, 1.0
    for d in ("nlp", "emb", "audio"):
        (tmp_path / d).mkdir(exist_ok=True)
    for clip in ("clipA", "clipB"):
        (tmp_path / "nlp" / f"{clip}.nlp").write_bytes(pack_nlp(probs, frame_ms=10))
        np.save(tmp_path / "emb" / f"{clip}.npy", emb)
        write_wav(tmp_path / "audio" / f"{clip}.wav", synth_speech(seconds=4.0))
    (tmp_path / "voiceprints.json").write_text(json.dumps({"d0000001": [0.0, 1.0]}), encoding="utf-8")
    (tmp_path / "sessions.csv").write_text(
        "clip_id,room,date,duration_s,doctor_uid8,lang,phase,r2_key\n"
        "clipA,room-a,2026-01-01,4.0,d0000001,en,consult,\nclipB,room-a,2026-01-01,4.0,d0000002,en,consult,\n", encoding="utf-8")


def run(tmp_path, out, **over):
    cfg = PipelineConfig(sessions_csv=str(tmp_path / "sessions.csv"), speaker="nemotron", nemotron_dir=str(tmp_path / "nlp"), audio_dir=str(tmp_path / "audio"),
                         voiceprints_path=str(tmp_path / "voiceprints.json"), embeddings_dir=str(tmp_path / "emb"), out=str(out),
                         odyssey=Fake(), audeering=Fake(), clef=Fake(valence=4.0), **over)
    return run_pipeline(cfg)


@pytest.fixture
def clef_on(monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")


def reasons(result):
    return dict(zip(result.windows["clip_id"], result.windows["reason"]))


def test_override_applies_only_to_a_would_be_no_voiceprint_clip(tmp_path, clef_on):
    build_inputs(tmp_path)
    base = run(tmp_path, tmp_path / "base")
    assert reasons(base) == {"clipA": "", "clipB": "no_voiceprint"}
    # clipA is given DELIBERATELY WRONG slots: a clip with a working centroid must be untouched by them
    roles = {"clipA": {"doctor_slot": 1, "patient_slot": 0}, "clipB": {"doctor_slot": 0, "patient_slot": 1}}
    with_roles = run(tmp_path, tmp_path / "roles", clef_roles=roles)
    assert reasons(with_roles) == {"clipA": "", "clipB": ""}
    a0 = base.windows[base.windows.clip_id == "clipA"].drop(columns=["window_id"], errors="ignore").reset_index(drop=True)
    a1 = with_roles.windows[with_roles.windows.clip_id == "clipA"].drop(columns=["window_id", "role_source"], errors="ignore").reset_index(drop=True)
    pd.testing.assert_frame_equal(a0, a1)
    b = with_roles.windows[with_roles.windows.clip_id == "clipB"].iloc[0]
    assert b["role_source"] == "clef_omni" and b["scorable"] and b["pure_patient_s"] == pytest.approx(3.5, abs=0.05)
    assert with_roles.windows.loc[with_roles.windows.clip_id == "clipA", "role_source"].isna().all()  # the centroid clip carries no marker


def test_undecided_or_missing_entry_keeps_no_voiceprint(tmp_path, clef_on):
    build_inputs(tmp_path)
    assert reasons(run(tmp_path, tmp_path / "o1", clef_roles={})) == {"clipA": "", "clipB": "no_voiceprint"}
    assert reasons(run(tmp_path, tmp_path / "o2", clef_roles={"clipB": {"doctor_slot": 0, "patient_slot": 0}})) == {"clipA": "", "clipB": "no_voiceprint"}  # same slot: no decision
    assert reasons(run(tmp_path, tmp_path / "o3", clef_roles={"clipB": {"doctor_slot": 0, "patient_slot": 9}})) == {"clipA": "", "clipB": "no_voiceprint"}  # stale slot


def test_without_clef_roles_output_is_byte_identical(tmp_path, clef_on):
    build_inputs(tmp_path)
    run(tmp_path, tmp_path / "a")
    run(tmp_path, tmp_path / "b", clef_roles={"not-a-clip-here": {"doctor_slot": 0, "patient_slot": 1}})  # nothing matches: nothing changes
    for name in ("windows.parquet", "consults.json"):
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()
    assert "role_source" not in pd.read_parquet(tmp_path / "a" / "windows.parquet").columns


def test_cli_flag_reads_the_roles_file(tmp_path, clef_on, monkeypatch):
    build_inputs(tmp_path)
    roles = tmp_path / "roles.json"
    role_clef.write_roles({"clipB": {"clip_id": "clipB", "doctor_slot": 0, "patient_slot": 1, "decided": True, "reason_code": "decided", "n_calls": 2, "input_tokens": 0},
                           "clipA": {"clip_id": "clipA", "doctor_slot": None, "patient_slot": None, "decided": False, "reason_code": "doctor_margin", "n_calls": 2, "input_tokens": 0}}, roles)
    monkeypatch.setattr("tools.timbre.pipeline._build", lambda name, device: Fake())
    main(["score", "--sessions", str(tmp_path / "sessions.csv"), "--audio-dir", str(tmp_path / "audio"), "--speaker", "nemotron", "--nemotron-dir", str(tmp_path / "nlp"),
          "--voiceprints", str(tmp_path / "voiceprints.json"), "--embeddings-dir", str(tmp_path / "emb"), "--out", str(tmp_path / "cli"), "--clef-roles", str(roles)])
    frame = pd.read_parquet(tmp_path / "cli" / "windows.parquet")
    assert dict(zip(frame.clip_id, frame.reason)) == {"clipA": "", "clipB": ""}
    assert frame.loc[frame.clip_id == "clipB", "role_source"].iloc[0] == "clef_omni"


def test_centroid_rejection_that_is_not_no_voiceprint_is_not_overridden(tmp_path, clef_on):
    """A clip WITH a centroid whose rejection maps to no_patient (only the doctor speaks) keeps that reason, roles or not."""
    build_inputs(tmp_path)
    probs = np.zeros((N_FRAMES, 2))
    probs[:, 0], probs[:, 1] = 0.95, 0.05
    emb = np.zeros((N_FRAMES, 2))
    emb[:, 1] = 1.0
    (tmp_path / "nlp" / "clipA.nlp").write_bytes(pack_nlp(probs, frame_ms=10))
    np.save(tmp_path / "emb" / "clipA.npy", emb)
    plain = run(tmp_path, tmp_path / "p")
    forced = run(tmp_path, tmp_path / "f", clef_roles={"clipA": {"doctor_slot": 0, "patient_slot": 1}})
    assert reasons(plain)["clipA"] == "no_patient" and reasons(forced)["clipA"] == "no_patient"
