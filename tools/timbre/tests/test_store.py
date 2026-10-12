"""Timbre T-9 writer (tools/timbre/store.py) + migration 0155 CHECKs. All ids are synthetic.

The Postgres half starts a throwaway cluster with the local ``initdb`` (``/usr/lib/postgresql/*/bin``) or uses
``TIMBRE_TEST_PG_DSN``; it skips when neither exists.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from tools.timbre import store

ROOT = Path(__file__).resolve().parents[3]
MIG = ROOT / "db" / "migrations" / "0155_timbre_affect.sql"
DOWN = ROOT / "db" / "rollbacks" / "0155_timbre_affect.down.sql"
SHA = "a" * 40

CAL = {
    "version": "timbre-calib-v1",
    "min_n": 8,
    "iqr_floor": 0.001,
    "rooms": {"Room A": {"median": 0.4, "iqr": 0.1, "n": 20, "q1": 0.35, "q3": 0.45}},
    "doctors": {},
    "global": {"median": 0.4, "iqr": 0.1, "n": 40},
    "isotonic": {"increasing": True, "x": [-2.0, 0.0, 2.0], "y": [1.0, 3.0, 5.0]},
}


def _cal(target):
    blob = dict(CAL, score_col=store.ODYSSEY_COL if target == "arousal" else store.CLEF_COL)
    text = store.canonical_json(blob)
    return {"target": target, "score_col": blob["score_col"], "calib_version": "timbre-calib-v1", "min_n": 8,
            "fit_on": "gold_batches_1_2", "git_sha": SHA, "sha256": store.sha256_text(text), "payload": blob}


def _row(clip="clipA", start=10.0, **kw):
    base = {
        "window_id": f"{clip}_p{int(start * 1000):07d}", "clip_id": clip, "room": "Room A", "date": "2026-10-01",
        "doctor_uid8": "docAAAA1", "lang": "", "phase": "open", "start_s": start, "end_s": start + 5.0,
        "purity": 0.9, "pure_patient_s": 4.0, "patient_cosine": 0.5, "purity_embedding": 0.9, "purity_probs": None,
        "scorable": True, "reason": "", "arousal_raw": 0.42, "arousal_calibrated": 3.1, "arousal_calibration_level": "room",
        "valence_raw": 2.8, "valence_calibrated": 2.9, "valence_calibration_level": "room", "audeering_fallback": False,
        "arousal_source": "odyssey", "valence_status": "ok", store.ODYSSEY_COL: 0.42, store.AUDEERING_COL: np.nan,
        store.CLEF_COL: 2.8,
    }
    base.update(kw)
    return base


def _clips(*names, engine="segments"):
    return {n: {"clip_id": n, "consult_uid": f"uid_{n}", "cut_version": "sig:test", "t0_ms": 1_790_000_000_000,
                "ist_date": "2026-10-01", "room_label": "Room A", "doctor_uid8": "docAAAA1", "diarize_engine": engine}
            for n in names}


def _manifest(**kw):
    m = {
        "pipeline_version": "timbre-v1", "git_sha": SHA, "compute": "cpu_dev", "speaker_source": "segments",
        "arousal_model_id": "odyssey_wavlm_dim.v1", "arousal_model_rev": "r1", "fallback_model_id": "audeering_msp_dim.v1",
        "fallback_model_rev": "r2", "valence_model_id": "@cf/cloudflare/clef-omni", "clef_question_set": "timbre-clef-v1",
        "purity_rule_version": "purity-v1", "purity_rule_json": {"min_purity": 0.6}, "scope_json": {"dates": ["2026-10-01"]},
    }
    m.update(kw)
    return m


def _payload(rows, clips=None, **kw):
    sha = kw.pop("sha", None)
    frame = pd.DataFrame(rows)
    return store.build_payload(frame, _manifest(**kw), clips or _clips(*sorted(set(frame.clip_id))),
                               cal_a=_cal("arousal"), cal_v=_cal("valence"), input_sha256=sha or "f" * 64)


# ------------------------------------------------------------------------------------------------------------ pure


def test_window_key_and_abs_span():
    p = _payload([_row(start=12.3456)])
    w = p["windows"][0]
    assert w["window_key"] == "uid_clipA_p0012346"
    assert w["abs_start_ms"] == 1_790_000_000_000 + 12346
    assert w["abs_end_ms"] - w["abs_start_ms"] == 5000


def test_scorable_keeps_raw_and_calibrated():
    w = _payload([_row()])["windows"][0]
    assert w["scorable"] is True and w["unscorable_reason"] is None
    assert (w["arousal_raw"], w["arousal_calibrated"], w["valence_raw"], w["valence_calibrated"]) == (0.42, 3.1, 2.8, 2.9)
    assert w["arousal_model"] == "odyssey"


def test_model_error_mapping_for_arousal_none_and_clef_error():
    p = _payload([_row(start=1, arousal_source="none", arousal_raw=np.nan), _row(start=20, valence_status="error", valence_raw=np.nan)])
    for w in p["windows"]:
        assert w["scorable"] is False and w["unscorable_reason"] == "model_error"
        assert w["arousal_raw"] is None and w["valence_raw"] is None and w["arousal_calibrated"] is None
    assert p["consults"][0]["n_model_error"] == 2


def test_unscorable_carries_reason_and_no_scores():
    w = _payload([_row(scorable=False, reason="low_purity", arousal_raw=0.3)])["windows"][0]
    assert w["scorable"] is False and w["unscorable_reason"] == "low_purity"
    assert all(w[k] is None for k in ("arousal_raw", "arousal_calibrated", "valence_raw", "valence_calibrated", "arousal_calibration_level"))


def test_unknown_reason_refused():
    with pytest.raises(store.StoreError):
        _payload([_row(scorable=False, reason="sounds_happy")])


def test_audeering_fallback_model_label():
    w = _payload([_row(arousal_source="audeering", audeering_fallback=True)])["windows"][0]
    assert w["arousal_model"] == "audeering_fallback"


def test_uncalibrated_scorable_rows_are_filled_from_the_run_maps():
    w = _payload([_row(arousal_calibrated=np.nan, arousal_calibration_level="uncalibrated",
                       valence_calibrated=np.nan, valence_calibration_level="uncalibrated")])["windows"][0]
    assert w["scorable"] is True
    assert w["arousal_calibration_level"] == "room" and 1.0 <= w["arousal_calibrated"] <= 5.0


def test_consult_zero_scorable_is_null_never_neutral():
    p = _payload([_row(scorable=False, reason="no_voiceprint"), _row(start=30, scorable=False, reason="overlap")])
    c = p["consults"][0]
    assert c["n_scorable"] == 0 and c["scorable_pct"] == 0.0
    for k in ("arousal_median", "valence_median", "arousal_raw_median", "valence_raw_median", "valence_open", "arousal_raw_close"):
        assert c[k] is None
    assert sum(c[f"n_{r}"] for r in store.REASONS) == c["n_windows"] - c["n_scorable"]


def test_consult_raw_and_calibrated_medians_and_thirds():
    rows = [_row(start=s, arousal_raw=a, arousal_calibrated=a * 10, valence_raw=v, valence_calibrated=v)
            for s, a, v in ((1, 0.1, 2.0), (10, 0.2, 3.0), (20, 0.3, 4.0))]
    c = _payload(rows)["consults"][0]
    assert c["arousal_raw_median"] == pytest.approx(0.2) and c["arousal_median"] == pytest.approx(2.0)
    assert (c["arousal_raw_open"], c["arousal_raw_mid"], c["arousal_raw_close"]) == pytest.approx((0.1, 0.2, 0.3))
    assert c["scorable_pct"] == 100.0


def test_text_lane_off_drops_text_scores():
    w = _payload([_row(text_valence=4.0, text_status="ok")])["windows"][0]
    assert w["text_valence"] is None and w["text_status"] is None
    w = _payload([_row(text_valence=4.0, text_status="ok")], text_lane_on=True, text_question_set="timbre-text-v2")["windows"][0]
    assert w["text_valence"] == 4.0


def test_no_forbidden_fields_in_payload():
    p = _payload([_row()])
    keys = set(p["windows"][0]) | set(p["consults"][0]) | set(p["run"])
    for bad in ("transcript", "name", "url", "audio", "r2_key", "clip_path", "doctor_name"):
        assert not any(k == bad or k.endswith("_" + bad) for k in keys), bad
    assert "window_id" not in keys and "clip_id" not in keys


def test_manifest_and_clip_validation():
    with pytest.raises(store.StoreError):
        store.build_payload(pd.DataFrame([_row()]), _manifest(git_sha=""), _clips("clipA"))
    with pytest.raises(store.StoreError):
        store.build_payload(pd.DataFrame([_row(clip="other")]), _manifest(), _clips("clipA"))


def test_calibration_map_refuses_rows(tmp_path):
    f = tmp_path / "c.json"
    f.write_text(json.dumps({"window_ids": ["x"]}))
    with pytest.raises(store.StoreError):
        store.calibration_row(f, target="arousal", git_sha=SHA, fit_on="x")


def test_hmac_signature_is_stable():
    assert store.sign(b"{}", "s", 1) == store.sign(b"{}", "s", 1)
    assert store.sign(b"{}", "s", 1) != store.sign(b"{}", "s", 2)


def test_ts_and_python_statement_match():
    ts = (ROOT / "lib" / "room-access" / "timbre-ingest-sql.ts").read_text()
    assert store.ingest_statement("$1") in ts
    for stmt in store.resolve_statements("$1"):
        assert stmt in ts


# ------------------------------------------------------------------------------------------------------------ postgres


def _initdb():
    for d in sorted(glob.glob("/usr/lib/postgresql/*/bin"), reverse=True):
        if os.path.exists(os.path.join(d, "initdb")):
            return d
    return shutil.which("initdb") and os.path.dirname(shutil.which("initdb"))


@pytest.fixture(scope="module")
def pg():
    dsn = os.environ.get("TIMBRE_TEST_PG_DSN")
    tmp = None
    if not dsn:
        bindir = _initdb()
        if not bindir or not shutil.which("psql"):
            pytest.skip("no postgres server binaries")
        tmp = tempfile.mkdtemp(prefix="timbre-pg-")
        subprocess.run([f"{bindir}/initdb", "-D", f"{tmp}/d", "-U", "postgres", "-A", "trust"], check=True, capture_output=True)
        port = str(56000 + os.getpid() % 1000)
        subprocess.run([f"{bindir}/pg_ctl", "-D", f"{tmp}/d", "-o", f"-p {port} -k {tmp} -c listen_addresses=''", "-l", f"{tmp}/log", "start"],
                       check=True, capture_output=True)
        dsn = f"postgresql:///postgres?host={tmp}&port={port}&user=postgres"
        for _ in range(50):
            if subprocess.run(["psql", dsn, "-c", "select 1"], capture_output=True).returncode == 0:
                break
            time.sleep(0.2)
    else:
        bindir = None
    run = lambda sql: subprocess.run(["psql", dsn, "-qAt", "-v", "ON_ERROR_STOP=1"], input=sql, capture_output=True, text=True)
    run("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    run("""CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL);
CREATE TABLE eta_encounter_windows (id serial PRIMARY KEY, consult_key text, consult_uid text, room_id text, room_slug text, computed_at timestamptz DEFAULT now());
CREATE TABLE consult_index (consult_uid text PRIMARY KEY, room_id text NOT NULL, room_slug text NOT NULL);
CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz);
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date);
CREATE TABLE room_emotion_window (id text PRIMARY KEY);""")
    r = run(MIG.read_text())
    assert r.returncode == 0, r.stderr
    yield dsn, run
    if tmp and bindir:
        subprocess.run([f"{bindir}/pg_ctl", "-D", f"{tmp}/d", "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)


def _fails(run, sql):
    r = run(sql)
    return r.stderr if r.returncode else ""


def test_pg_migration_is_idempotent_and_self_records(pg):
    dsn, run = pg
    assert run(MIG.read_text()).returncode == 0
    assert run("SELECT count(*) FROM schema_migrations WHERE version = 155").stdout.strip() == "1"
    assert run("SELECT count(*) FROM pg_views WHERE viewname = 'affect_consult_latest'").stdout.strip() == "1"


def _seed_run(run):
    out = run("""INSERT INTO affect_calibration_map (target, score_col, calib_version, min_n, fit_on, git_sha, sha256, payload)
VALUES ('arousal','s','v',8,'f','%s','%s','{}') ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING id;""" % (SHA, "1" * 64))
    cid = out.stdout.strip()
    out = run("""INSERT INTO affect_run (pipeline_version, git_sha, compute, speaker_source, arousal_model_id, arousal_model_rev, fallback_model_id,
 fallback_model_rev, valence_model_id, clef_question_set, purity_rule_version, purity_rule_json, calibration_arousal_id, calibration_valence_id,
 scope_json, input_manifest_sha256, state) VALUES ('v','%s','cpu_dev','segments','a','r','f','r','v','q','p','{}',%s,%s,'{}','x','ok') RETURNING id;""" % (SHA, cid, cid))
    return out.stdout.strip()


W_COLS = "run_id, consult_uid, cut_version, window_key, start_ms, end_ms, diarize_engine, scorable, unscorable_reason, arousal_raw, arousal_calibrated, arousal_calibration_level, arousal_model, valence_raw, valence_calibrated, valence_calibration_level"


def test_pg_window_checks(pg):
    _, run = pg
    rid = _seed_run(run)
    ins = lambda key, vals: _fails(run, f"INSERT INTO affect_window ({W_COLS}) VALUES ({rid}, 'u', 'c', '{key}', 0, 10, 'segments', {vals});")
    assert ins("ok", "true, NULL, 0.4, 3.0, 'room', 'odyssey', 2.5, 2.6, 'room'") == ""
    assert "affect_window_scorable_chk" in ins("noav", "true, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL")
    assert "affect_window_unscorable_chk" in ins("noreason", "false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL")
    assert "affect_window_unscorable_chk" in ins("score", "false, 'low_purity', 0.4, NULL, NULL, NULL, NULL, NULL, NULL")
    assert "affect_window_reason_chk" in ins("badreason", "false, 'neutral', NULL, NULL, NULL, NULL, NULL, NULL, NULL")
    assert "affect_window_valence_range_chk" in ins("v9", "true, NULL, 0.4, 3.0, 'room', 'odyssey', 9, 2.6, 'room'")
    assert ins("me", "false, 'model_error', NULL, NULL, NULL, NULL, NULL, NULL, NULL") == ""


def test_pg_consult_reason_sum_check(pg):
    _, run = pg
    rid = _seed_run(run)
    base = f"INSERT INTO affect_consult (run_id, consult_uid, cut_version, ist_date, n_windows, n_scorable, scorable_pct, n_low_purity) VALUES ({rid}, 'u', "
    assert _fails(run, base + "'c1', '2026-10-01', 2, 1, 50, 1);") == ""
    assert "affect_consult_reasons_chk" in _fails(run, base + "'c2', '2026-10-01', 2, 1, 50, 0);")
    assert "affect_consult_unscorable_chk" in _fails(run, f"INSERT INTO affect_consult (run_id, consult_uid, cut_version, ist_date, n_windows, n_scorable, scorable_pct, n_low_purity, valence_raw_median) VALUES ({rid}, 'u', 'c3', '2026-10-01', 1, 0, 0, 1, 3.0);")


def test_pg_calibration_store_check(pg):
    _, run = pg
    q = "INSERT INTO affect_calibration_map (target, score_col, calib_version, min_n, fit_on, git_sha, sha256, payload, r2_key) VALUES ('valence','s','v',8,'f','%s','%s',%s,%s);"
    assert "affect_calibration_map_store_chk" in _fails(run, q % (SHA, "2" * 64, "'{}'", "'k'"))
    assert "affect_calibration_map_store_chk" in _fails(run, q % (SHA, "3" * 64, "NULL", "NULL"))
    assert _fails(run, q % (SHA, "4" * 64, "NULL", "'k'")) == ""


def test_pg_load_is_idempotent_and_latest_view(pg):
    dsn, run = pg
    run("INSERT INTO consult_index VALUES ('uid_clipL', 'room_x', 'room-x') ON CONFLICT DO NOTHING;"
        "INSERT INTO room VALUES ('room_x', 'room-x', 'Room X', NULL), ('room_y', 'room-y', 'Room Y', NULL);"
        "INSERT INTO room_day VALUES ('rd_1', 'room_y', '2026-10-01');"
        "INSERT INTO eta_encounter_windows (consult_key, consult_uid) VALUES ('uid_clipL@m1', 'uid_clipL');"
        "INSERT INTO bench_window VALUES ('bw_1', 'bs_1', 'rd_1', 1789999999000, 1790000900000);")
    rows = [_row(clip="clipL", start=1), _row(clip="clipL", start=30, scorable=False, reason="low_purity")]
    p1 = _payload(rows, clips=_clips("clipL"), sha="e" * 64)
    r1 = store.load_psql(p1, dsn)
    assert r1["inserted"] == 1 and r1["n_windows"] == 2 and r1["n_consults"] == 1
    r2 = store.load_psql(p1, dsn)
    assert r2["inserted"] == 0 and r2["run_id"] == r1["run_id"]
    got = run(f"SELECT encounter_consult_key, room_id, room_slug FROM affect_consult WHERE run_id = {r1['run_id']}").stdout.strip()
    assert got == "uid_clipL@m1|room_x|room-x"
    got = run(f"SELECT count(*) FROM affect_window WHERE run_id = {r1['run_id']} AND bench_window_id = 'bw_1' AND room_day_id = 'rd_1' AND session_id = 'bs_1'").stdout.strip()
    assert got == "2"
    # a consult with no consult_index / encounter row takes its room from the resolved room_day
    pm = _payload([_row(clip="clipM", start=2)], clips=_clips("clipM"), sha="c" * 64)
    rm = store.load_psql(pm, dsn)
    assert run(f"SELECT room_id, room_slug FROM affect_consult WHERE run_id = {rm['run_id']}").stdout.strip() == "room_y|room-y"
    p2 = _payload([_row(clip="clipL", start=1, valence_raw=4.0)], clips=_clips("clipL"), sha="d" * 64)
    r3 = store.load_psql(p2, dsn)
    assert r3["inserted"] == 1 and r3["run_id"] != r1["run_id"]
    latest = run("SELECT run_id, n_windows FROM affect_consult_latest WHERE consult_uid = 'uid_clipL'").stdout.strip()
    assert latest == f"{r3['run_id']}|1"
    assert run("SELECT count(*) FROM affect_calibration_map WHERE sha256 = '%s'" % _cal("arousal")["sha256"]).stdout.strip() == "1"


def test_pg_down_then_up_round_trips(pg):
    _, run = pg
    assert run(DOWN.read_text()).returncode == 0
    assert run("SELECT count(*) FROM pg_tables WHERE tablename LIKE 'affect_%'").stdout.strip() == "0"
    assert run("SELECT count(*) FROM schema_migrations WHERE version = 155").stdout.strip() == "0"
    assert run("SELECT count(*) FROM pg_tables WHERE tablename = 'room_emotion_window'").stdout.strip() == "1"
    assert run(MIG.read_text()).returncode == 0
    assert run("SELECT count(*) FROM pg_tables WHERE tablename LIKE 'affect_%'").stdout.strip() == "4"
