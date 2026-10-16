"""CLEF-D2-R4: `nightly r4` — only the listed consults, scope_json, cost with role tokens, dry run, logs. Fakes only: the fetch, the
preparer (synthetic audio and probabilities), the Clef client, the pipeline runner and the store. No network, never real audio."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from tools.timbre import nightly, role_clef, store
from tools.timbre.audio import TARGET_SR, write_wav
from tools.timbre.nemotron_probs import pack_nlp
from tools.timbre.nightly_prepare import Prepared

DAY = "2026-10-10"
TOKENS_PER_CALL = 2000
PER_CLEF_USD = 0.15 / 1e6


def consult(uid: str, t0: int, minutes: float = 5.0) -> dict:
    return {"consult_uid": uid, "cut_version": "sig:x", "t0_ms": t0, "t1_ms": t0 + int(minutes * 60_000), "clip_r2_key": f"clips/{uid}.ogg",
            "room_id": "room_fake", "room_slug": "opd-fake", "session_id": "bs_fake", "doctor_uid8": "docFAKE1", "minutes": minutes}


def scene_files(prep: Path, clip_id: str):
    """40 s part: slot 0 and slot 1 each have 20 s of dominant speech."""
    n = 4000
    probs = np.full((n, 2), 0.02)
    probs[:1200, 0], probs[1200:2000, 1], probs[2000:2800, 0], probs[2800:, 1] = 0.95, 0.95, 0.95, 0.95
    (prep / "audio").mkdir(parents=True, exist_ok=True)
    (prep / "nlp").mkdir(parents=True, exist_ok=True)
    write_wav(prep / "audio" / f"{clip_id}.wav", (np.random.default_rng(3).standard_normal(40 * TARGET_SR) * 0.1).astype(np.float32))
    (prep / "nlp" / f"{clip_id}.nlp").write_bytes(pack_nlp(probs, frame_ms=10))


class FakeRole:
    def __init__(self):
        self.calls = 0

    def ask_role(self, snippets):
        self.calls += 1
        return ([0.8, 0.1, 0.05, 0.05] if self.calls % 2 == 1 else [0.1, 0.75, 0.1, 0.05]), TOKENS_PER_CALL


class Harness:
    def __init__(self, tmp_path, monkeypatch, uids=("c1", "c2", "c3"), listed=("c1", "c3"), **cfg_over):
        monkeypatch.setenv("TIMBRE_INGEST_SECRET", "k")
        monkeypatch.setenv("TIMBRE_GIT_SHA", "d" * 40)
        self.tmp = tmp_path
        tmp_path.mkdir(parents=True, exist_ok=True)
        self.cfg = dict(nightly.DEFAULTS, enabled=True, app_url="https://app.test", workdir=str(tmp_path / "work"), calibration_arousal="a.json", calibration_valence="v.json")
        self.cfg.update(cfg_over)
        self.consults_file = tmp_path / "consults.txt"
        self.consults_file.write_text("# no_voiceprint\n" + "\n".join(listed) + "\n\n", encoding="utf-8")
        self.body = {"ok": True, "consults": [consult(u, 1000 * (i + 1)) for i, u in enumerate(uids)], "withheld_blind": 0}
        self.prepared_for, self.cmds, self.posted, self.manifests = [], [], [], []
        self.role = FakeRole()
        self.preparer_calls = self.runner_calls = 0

        def build_from_files(windows, manifest, clips, consults=None):
            man = json.loads(Path(manifest).read_text())
            self.manifests.append(man)
            self.clip_rows = [json.loads(line) for line in Path(clips).read_text().splitlines()]
            return {"run": man, "windows": [{"consult_uid": r["consult_uid"]} for r in self.clip_rows]}

        monkeypatch.setattr(store, "build_from_files", build_from_files)

    def preparer(self, kept, prep):
        self.preparer_calls += 1
        self.prepared_for = [c["consult_uid"] for c in kept]
        clips = []
        for c in kept:
            cid = f"{c['consult_uid']}-s0"
            scene_files(prep, cid)
            clips.append({**c, "clip_id": cid, "offset_ms": 0, "duration_s": 40.0, "nemotron_ref": "bw_x_0_primary.nlp"})
        return Prepared(clips=clips)

    def runner(self, cmd, timeout, check):
        self.runner_calls += 1
        self.cmds.append(cmd)
        out = Path(cmd[cmd.index("--out") + 1])
        out.mkdir(parents=True)
        pd.DataFrame({"clip_id": ["x"]}).to_parquet(out / "windows.parquet")
        return SimpleNamespace(returncode=0)

    def go(self, **kw):
        return nightly.r4(DAY, self.cfg, str(self.consults_file), runner=self.runner, fetch=lambda *a: self.body,
                          post=lambda p, url, s: self.posted.append(p) or {"ok": True, "run_id": 7}, preparer=self.preparer, role_client=self.role, **kw)


def test_only_the_listed_consults_run(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch)
    assert h.go() == 0
    assert h.prepared_for == ["c1", "c3"]  # c2 is in the day but not in the file
    assert sorted({r["consult_uid"] for r in h.clip_rows}) == ["c1", "c3"]
    assert h.role.calls == 4  # one call per qualifying slot, two slots, two parts
    cmd = h.cmds[0]
    roles_path = Path(cmd[cmd.index("--clef-roles") + 1])
    roles = json.loads(roles_path.read_text())
    assert sorted(roles) == ["c1-s0", "c3-s0"] and all(r["decided"] and (r["doctor_slot"], r["patient_slot"]) == (0, 1) for r in roles.values())
    assert "--voiceprints" in cmd and "--r2" not in cmd  # the unchanged prepared-parts path


def test_scope_json_run_row_and_cost_include_role_tokens(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch)
    assert h.go() == 0
    man = h.manifests[0]
    assert man["scope_json"]["job"] == "timbre-r4-clefomni" and man["scope_json"]["role_source"] == "clef_omni"
    assert man["scope_json"]["requested"] == 2 and man["scope_json"]["role_decided"] == 2 and man["scope_json"]["role_calls"] == 4
    assert man["scope_json"]["role_input_tokens"] == 4 * TOKENS_PER_CALL
    assert man["speaker_source"] == "nemotron"  # affect_run.speaker_source stays within its CHECK
    valence_est = 2 * nightly.estimate_usd(300)
    assert man["cost_usd_est"] == pytest.approx(valence_est + 4 * TOKENS_PER_CALL * PER_CLEF_USD, abs=1e-6)
    assert man["gpu_seconds"] >= 0 and man["state"] == "ok"
    assert len(h.posted) == 1  # a new run is posted (affect_consult_latest moves for these consults only)


def test_dry_run_makes_no_calls(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch)
    assert h.go(dry_run=True) == 0
    assert h.role.calls == 0 and h.preparer_calls == 0 and h.runner_calls == 0 and h.posted == []


def test_no_ledger_is_written_and_run_pipeline_cmd_is_unchanged(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch)
    h.go()
    assert not list((tmp_path / "work").rglob("intraday-ledger.jsonl"))
    plain = nightly.pipeline_cmd(h.cfg, Path("s.csv"), Path("out"), Path("prep"))
    assert "--clef-roles" not in plain  # `run` / `intraday` never pass the flag


def test_exit_codes_and_alerts_match_run(tmp_path, monkeypatch, capsys):
    h = Harness(tmp_path, monkeypatch, budget_usd_daily=nightly.estimate_usd(300) * 1.5)
    assert h.go() == 2  # c3 over the daily budget -> partial, with an ALERT, like `run`
    assert "ALERT [timbre-r4-clefomni]" in capsys.readouterr().out and h.manifests[0]["state"] == "partial"
    h2 = Harness(tmp_path / "b", monkeypatch)
    h2.runner = lambda cmd, timeout, check: SimpleNamespace(returncode=3)
    assert h2.go() == 1 and h2.posted == []
    assert "ALERT [timbre-r4-clefomni] pipeline failed" in capsys.readouterr().out


def test_disabled_and_unprepared_configs(tmp_path, monkeypatch, capsys):
    h = Harness(tmp_path, monkeypatch, enabled=False)
    assert h.go() == 0 and h.preparer_calls == 0
    h = Harness(tmp_path / "b", monkeypatch, prepare=False)
    assert h.go() == 1 and "needs prepared Nemotron parts" in capsys.readouterr().out


def test_role_budget_caps_the_calls(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch)
    h.role.ask_role = lambda snippets: ([0.8, 0.1, 0.05, 0.05], 10_000_000)  # US$1.50 a call
    assert h.go() == 0
    roles = json.loads(Path(h.cmds[0][h.cmds[0].index("--clef-roles") + 1]).read_text())
    assert all(not r["decided"] for r in roles.values())
    # part 1 spends the budget (two US$1.50 calls, no decision); part 2 is stopped before its first call
    assert h.manifests[0]["scope_json"]["role_reasons"] == {"budget": 1, "doctor_margin": 1}
    assert h.manifests[0]["scope_json"]["role_calls"] == 2


def test_logs_carry_codes_and_counts_only(tmp_path, monkeypatch, capsys):
    h = Harness(tmp_path, monkeypatch)
    h.go()
    out = capsys.readouterr().out
    for bad in ("c1", "c3", "-s0", "docFAKE1", "room_fake", "opd-fake", "bs_fake", "clips/", "d" * 40):
        assert bad not in out
    assert "roles: parts=2 decided=2 calls=4" in out


def test_cli_requires_consults_and_respects_the_switch(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("TIMBRE_NIGHTLY_ENABLED", "0")
    with pytest.raises(SystemExit):
        nightly.main(["r4", "--date", DAY])
    f = tmp_path / "u.txt"
    f.write_text("c1\n")
    assert nightly.main(["r4", "--date", DAY, "--consults", str(f), "--dry-run"]) == 0
    assert "disabled" in capsys.readouterr().out


def test_consult_list_parsing(tmp_path):
    f = tmp_path / "u.txt"
    f.write_text("# header\nc2\n\n  c1  \nc2\n")
    assert nightly.read_consult_list(str(f)) == ["c2", "c1"]
