"""Eval harness: judge (replayed), metrics rows, aggregate."""
import csv
import json

from conftest import CONSULTS, MODEL

from tools.eta2freescript.eval.aggregate import aggregate
from tools.eta2freescript.eval.judge import judge_one, metrics, norm_reference, prediction, write_rows
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient, ReplayClient


def test_judge_replay_metrics_and_aggregate(replay_out):
    out, logs = replay_out
    client = ReplayClient(MODEL)
    rows = []
    for uid, lg in logs.items():
        rec = judge_one(load_consult(CONSULTS, uid), lg["artifact"], client, out)
        assert (out / "eval" / "judge-v3" / f"{uid}.json").exists()
        rows.append(metrics(rec, lg["artifact"], lg))
    write_rows(rows, out / "eval" / "results.csv")
    by = {r["uid"]: r for r in rows}
    assert by["synth-fever-dose"]["drug_recall_strict"] == 1.0 and by["synth-fever-dose"]["dose_fields_matched"] == 3
    assert by["synth-boundary-knee"]["n_quarantined"] >= 1 and by["synth-boundary-knee"]["completion_needed"] == 3
    assert by["synth-cough-native"]["slots_captured"] == 1 and by["synth-cough-native"]["speaker_source"] == "model_inferred"
    assert all(r["artifact_valid"] for r in rows)
    (out / "usage.jsonl").write_text(json.dumps({"tag": "stageA-v2:x", "in": 1000, "out": 100, "usd": 0.0045, "secs": 2.0}) + "\n")
    h = aggregate(out)
    assert h["all"]["consults"] == 3 and h["all"]["signed_drugs"] == 5
    assert set(h["by_speaker_source"]) == {"role_track", "model_inferred"}
    assert h["cost"]["stageA-v2"]["calls"] == 1
    assert json.loads((out / "eval" / "headline.json").read_text())["all"]["consults"] == 3


def test_judge_is_cached_and_skips_unsigned(replay_out, tmp_path):
    out, logs = replay_out
    c = load_consult(CONSULTS, "synth-fever-dose")
    fake = FakeClient({"judge": json.dumps({"drugs_ref": []})})
    judge_one(c, logs[c.uid]["artifact"], fake, out)
    judge_one(c, logs[c.uid]["artifact"], fake, out)
    assert len(fake.calls) == 1
    judge_one(c, logs[c.uid]["artifact"], fake, out, force=True)
    assert len(fake.calls) == 2
    c.signed = None
    assert judge_one(c, logs[c.uid]["artifact"], fake, tmp_path / "fresh") is None


def test_prediction_and_reference_shapes(replay_out):
    _, logs = replay_out
    art = logs["synth-boundary-knee"]["artifact"]
    p = prediction(art)
    assert set(p) == {"gp_extraction", "kept_out", "completion_required", "clip_boundary"}
    assert all(k["k"] == i for i, k in enumerate(p["kept_out"]))
    assert norm_reference({"medicines": [], "_private": 1, "extra": 2}) == {"medicines": [], "extra": 2}


def test_write_rows_replaces_by_uid(tmp_path):
    p = tmp_path / "r.csv"
    write_rows([{"uid": "a", "x": 1}, {"uid": "b", "x": 2}], p)
    write_rows([{"uid": "a", "x": 9}], p)
    rows = {r["uid"]: r["x"] for r in csv.DictReader(open(p))}
    assert rows == {"a": "9", "b": "2"}
