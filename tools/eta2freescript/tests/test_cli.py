"""CLI: run / eval / aggregate / validate over the synthetic folder with the replay client."""
import json
import os
import subprocess
import sys

from conftest import CONSULTS, MODEL, ROOT

from tools.eta2freescript.__main__ import main


def test_run_eval_aggregate_validate(tmp_path, capsys):
    out = tmp_path / "out"
    assert main(["run", "--all", "--data", str(CONSULTS), "--client", "replay", "--replay", str(MODEL), "--out", str(out), "--workers", "1"]) == 0
    text = capsys.readouterr().out
    assert text.count("valid=True") == 3 and "roles=model_inferred" in text
    assert main(["eval", "--data", str(CONSULTS), "--client", "replay", "--replay", str(MODEL), "--out", str(out), "--workers", "1"]) == 0
    assert "3 rows" in capsys.readouterr().out
    assert main(["aggregate", "--out", str(out)]) == 0
    assert json.loads(capsys.readouterr().out)["all"]["consults"] == 3
    assert main(["validate", str(out / "synth-fever-dose" / "artifact.json"), str(out / "synth-fever-dose" / "artifact.v0.1.json")]) == 0


def test_run_single_consult_no_stage_b(tmp_path, capsys):
    out = tmp_path / "o"
    assert main(["run", "--consult", "synth-fever-dose", "--data", str(CONSULTS), "--replay", str(MODEL), "--out", str(out), "--no-stage-b"]) == 0
    assert "note=deterministic_fallback" in capsys.readouterr().out
    assert sorted(p.name for p in (out / "synth-fever-dose").iterdir()) == [
        "artifact.json", "artifact.v0.1.json", "artifact.validation.json", "encounter.json", "stageA.raw.txt"]


def test_missing_consult_is_reported_not_fatal(tmp_path, capsys):
    rc = main(["run", "--consult", "no-such-consult", "--data", str(CONSULTS), "--replay", str(MODEL), "--out", str(tmp_path)])
    assert rc == 1 and "ERROR FileNotFoundError" in capsys.readouterr().out


def test_phi_guard_refusal_exits_2(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("ETA2FS_BEDROCK_SONNET", "openai.gpt-oss-120b")
    assert main(["run", "--all", "--data", str(CONSULTS), "--client", "bedrock", "--out", str(tmp_path)]) == 2
    assert "PHI guard" in capsys.readouterr().err
    assert not any(tmp_path.iterdir())


def test_validate_rejects_a_bad_artifact(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"schema_version": "eta.freescript.v0.2"}))
    assert main(["validate", str(p)]) == 1


def test_module_entry_point(tmp_path):
    r = subprocess.run([sys.executable, "-m", "tools.eta2freescript", "--help"], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, "PYTHONPATH": str(ROOT)})
    assert r.returncode == 0 and "run" in r.stdout and "eval" in r.stdout
