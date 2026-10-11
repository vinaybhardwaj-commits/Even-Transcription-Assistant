"""tools/timbre/nightly.py — switch, plan/budget, inputs, manifest, run flow (pipeline + post faked). No network, no audio."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

from tools.timbre import nightly

BACKFILL_CAL = Path("/home/box/shared/timbre/v1/calib")


def consult(uid: str, t0: int, minutes: float = 5.0, **over) -> dict:
    row = {"consult_uid": uid, "cut_version": "sig:x", "t0_ms": t0, "t1_ms": t0 + int(minutes * 60_000), "clip_r2_key": f"clips/{uid}.ogg",
           "room_id": "room_fake", "room_slug": "opd-fake", "session_id": "sess_fake", "doctor_uid8": "docFAKE1", "minutes": minutes}
    row.update(over)
    return row


def test_switch_defaults_off_and_env_wins(tmp_path):
    assert nightly.load_config(None, env={})["enabled"] is False
    cfg_file = tmp_path / "c.json"
    cfg_file.write_text(json.dumps({"enabled": True, "compute": "hf_gpu"}))
    assert nightly.load_config(str(cfg_file), env={})["enabled"] is True
    assert nightly.load_config(str(cfg_file), env={"TIMBRE_NIGHTLY_ENABLED": "0"})["enabled"] is False
    assert nightly.load_config(None, env={"TIMBRE_NIGHTLY_ENABLED": "1", "TIMBRE_COMPUTE": "hf_gpu"})["compute"] == "hf_gpu"
    with pytest.raises(nightly.NightlyError):
        nightly.load_config(None, env={"TIMBRE_NIGHTLY_ENABLED": "maybe"})
    with pytest.raises(nightly.NightlyError):
        nightly.load_config(None, env={"TIMBRE_COMPUTE": "mac_mini"})


def test_disabled_run_does_nothing():
    called = []
    assert nightly.run("2026-10-10", nightly.load_config(None, env={}), fetch=lambda *a: called.append(a)) == 0
    assert called == []


def test_previous_ist_day():
    # 20:00 UTC on 10 Oct is 01:30 IST on 11 Oct -> the previous IST day is 10 Oct
    assert nightly.previous_ist_day(datetime(2026, 10, 10, 20, 0, tzinfo=timezone.utc)) == "2026-10-10"
    assert nightly.previous_ist_day(datetime(2026, 10, 10, 10, 0, tzinfo=timezone.utc)) == "2026-10-09"


def test_sign_get_matches_ts():
    # pinned in tests/unit/timbre-nightly.test.ts (lib/timbre/auth.ts::signTimbreGet)
    assert nightly.sign_get("/api/timbre/consults?date=2026-10-10", "k", 1_760_000_000) == "5346d1846297634db9b5a4542f28154aee72da55d1acddc0003b0af042b68065"


def test_plan_budget_is_time_ordered_and_partial():
    cfg = dict(nightly.DEFAULTS, budget_usd_daily=nightly.estimate_usd(300) * 2 + 1e-9, max_consults=10)
    kept, info = nightly.plan([consult("c3", 3000), consult("c1", 1000), consult("c2", 2000), consult("c0", 0, clip_r2_key=None)], cfg)
    assert [c["consult_uid"] for c in kept] == ["c1", "c2"]
    assert info["dropped_budget"] == 1 and info["skipped_unsealed_or_no_clip"] == 1
    # ~1k tokens per 10 s window at US$0.15/M: a 5-minute consult is 30 windows -> US$0.0045
    assert nightly.estimate_usd(300) == pytest.approx(0.0045)
    kept, info = nightly.plan([consult(f"c{i}", i) for i in range(5)], dict(nightly.DEFAULTS, max_consults=2))
    assert len(kept) == 2 and info["dropped_max"] == 3


def test_inputs_and_pipeline_cmd(tmp_path):
    cfg = dict(nightly.DEFAULTS, voiceprints="/vp.json", nemotron_dir="/nlp", calibration_arousal="/a.json", calibration_valence="/v.json")
    kept, _ = nightly.plan([consult("cu_fake_1", 1000)], cfg)
    sessions, clips = nightly.write_inputs(kept, "2026-10-10", tmp_path)
    frame = pd.read_csv(sessions, dtype=str)
    assert list(frame.columns) == ["clip_id", "room", "date", "duration_s", "lang", "phase", "doctor_uid8", "r2_key"]
    assert frame.iloc[0]["clip_id"] == "cu_fake_1" and frame.iloc[0]["duration_s"] == "300.000"
    clip = json.loads(clips.read_text().splitlines()[0])
    assert clip["consult_uid"] == "cu_fake_1" and clip["cut_version"] == "sig:x" and clip["ist_date"] == "2026-10-10"
    assert not ({"name", "text", "transcript", "patient"} & set(clip))
    cmd = nightly.pipeline_cmd(cfg, sessions, tmp_path / "out")
    assert cmd[2:4] == ["tools.timbre.pipeline", "score"] and "--r2" in cmd and "--text-lane" not in cmd
    assert cmd[cmd.index("--voiceprints") + 1] == "/vp.json" and cmd[cmd.index("--nemotron-dir") + 1] == "/nlp"
    assert not any("aniemore" in c.lower() or "wavlm_aniemore" in c.lower() for c in cmd)
    assert "--text-lane" in nightly.pipeline_cmd(dict(cfg, text_lane=True), sessions, tmp_path / "out")


@pytest.mark.skipif(not (BACKFILL_CAL / "odyssey_arousal.calib.json").is_file(), reason="needs the v1 calibration maps on the box")
def test_run_end_to_end_with_fake_pipeline(tmp_path, monkeypatch):
    """Fake pipeline writes windows.parquet; the real store builds the payload; the post is captured."""
    monkeypatch.setenv("TIMBRE_INGEST_SECRET", "k")
    monkeypatch.setenv("TIMBRE_GIT_SHA", "c" * 40)
    cfg = dict(nightly.DEFAULTS, enabled=True, prepare=False, app_url="https://app.test", workdir=str(tmp_path), compute="lab_gpu",
               calibration_arousal=str(BACKFILL_CAL / "odyssey_arousal.calib.json"), calibration_valence=str(BACKFILL_CAL / "clef_valence.calib.json"),
               budget_usd_daily=nightly.estimate_usd(300) * 1.5)

    def fake_pipeline(cmd, timeout, check):
        out = Path(cmd[cmd.index("--out") + 1])
        out.mkdir(parents=True)
        sample = pd.read_parquet("/workspace/timbre-go/backfill/scale-segments.windows.parquet").head(2).copy()
        sample["clip_id"] = "c1"
        sample["start_s"] = [0.0, 10.0]
        sample["end_s"] = [10.0, 20.0]
        sample.to_parquet(out / "windows.parquet")
        return SimpleNamespace(returncode=0)

    posted = {}
    body = {"ok": True, "consults": [consult("c1", 1000), consult("c2", 2000)], "withheld_blind": 1}
    rc = nightly.run("2026-10-10", cfg, runner=fake_pipeline, fetch=lambda *a: body, post=lambda p, url, s: posted.update(p=p, url=url) or {"ok": True, "inserted": 1})
    assert rc == 2  # c2 is over the budget -> partial, with an ALERT
    p = posted["p"]
    assert posted["url"] == "https://app.test/api/timbre/ingest"
    assert p["run"]["state"] == "partial" and p["run"]["compute"] == "lab_gpu" and p["run"]["git_sha"] == "c" * 40
    assert p["run"]["scope_json"]["withheld_blind_room_days"] == 1 and p["run"]["scope_json"]["dropped_budget"] == 1
    assert p["run"]["clef_question_set"] == "timbre-clef-v1" and p["run"]["text_lane_on"] is False
    assert {w["consult_uid"] for w in p["windows"]} == {"c1"}
    for w in p["windows"]:
        assert ("arousal_raw" in w) and ("arousal_calibrated" in w)


@pytest.mark.skipif(not Path("/workspace/timbre-go/backfill/scale-segments.windows.parquet").is_file(), reason="needs box backfill data")
def test_failed_pipeline_stores_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("TIMBRE_INGEST_SECRET", "k")
    cfg = dict(nightly.DEFAULTS, enabled=True, prepare=False, app_url="https://app.test", workdir=str(tmp_path))
    posted = []
    rc = nightly.run("2026-10-10", cfg, runner=lambda *a, **k: SimpleNamespace(returncode=3), fetch=lambda *a: {"ok": True, "consults": [consult("c1", 1)]}, post=lambda *a: posted.append(a))
    assert rc == 1 and posted == []


def test_prepared_parts_flow(tmp_path, monkeypatch):
    """prepare on: parts become pipeline clips with offset_ms and local audio; nothing prepared -> nothing scored, exit 0."""
    from tools.timbre.nightly_prepare import Prepared

    monkeypatch.setenv("TIMBRE_INGEST_SECRET", "k")
    cfg = dict(nightly.DEFAULTS, enabled=True, app_url="https://app.test", workdir=str(tmp_path))
    seen = {}

    def runner(cmd, timeout, check):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=5)

    def preparer(kept, prep):
        part = {**kept[0], "clip_id": "c1-s0", "offset_ms": 120_000, "duration_s": 60.0, "nemotron_ref": "bw_tok_0_primary.nlp"}
        return Prepared(clips=[part], no_diarization=["c2"])

    body = {"ok": True, "consults": [consult("c1", 1000), consult("c2", 2000)]}
    assert nightly.run("2026-10-10", cfg, runner=runner, fetch=lambda *a: body, preparer=preparer) == 1  # fake pipeline fails -> nothing stored
    cmd = seen["cmd"]
    assert "--r2" not in cmd and cmd[cmd.index("--audio-dir") + 1].endswith("/prep/audio") and cmd[cmd.index("--voiceprints") + 1].endswith("/prep/voiceprints.json")
    assert cmd[cmd.index("--embeddings-dir") + 1].endswith("/prep/emb") and cmd[cmd.index("--slot-embeddings-dir") + 1].endswith("/prep/slots")
    work = Path(cmd[cmd.index("--out") + 1]).parent
    clip = json.loads((work / "clips.jsonl").read_text().splitlines()[0])
    assert clip["clip_id"] == "c1-s0" and clip["consult_uid"] == "c1" and clip["offset_ms"] == 120_000 and clip["diarize_ref"] == "bw_tok_0_primary.nlp"
    assert pd.read_csv(work / "sessions.csv", dtype=str, keep_default_na=False).iloc[0]["r2_key"] == ""
    assert nightly.run("2026-10-10", cfg, runner=runner, fetch=lambda *a: body, preparer=lambda k, p: Prepared(no_diarization=["c1", "c2"])) == 0
