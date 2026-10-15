"""tools/timbre/nightly.py intraday — ledger, cumulative budget, lock, versions, default date. Pipeline, post, fetch and preparer are
fakes (store.build_from_files is faked too, so no parquet, no calibration maps, no network, no audio)."""
from __future__ import annotations

import fcntl
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.timbre import nightly, store
from tools.timbre.nightly_prepare import Prepared

DAY = "2026-10-15"


def consult(uid: str, t0: int, minutes: float = 5.0, **over) -> dict:
    row = {"consult_uid": uid, "cut_version": "sig:x", "t0_ms": t0, "t1_ms": t0 + int(minutes * 60_000), "clip_r2_key": f"clips/{uid}.ogg",
           "room_id": "room_fake", "room_slug": "opd-fake", "session_id": "sess_fake", "doctor_uid8": "docFAKE1", "minutes": minutes}
    row.update(over)
    return row


class Rig:
    """Injected fakes; `no_diar` consults come back from the preparer as no_diarization."""

    def __init__(self, tmp_path, monkeypatch, **cfg_over):
        monkeypatch.setenv("TIMBRE_INGEST_SECRET", "k")
        monkeypatch.setenv("TIMBRE_GIT_SHA", "c" * 40)
        self.cfg = dict(nightly.DEFAULTS, enabled=True, app_url="https://app.test", workdir=str(tmp_path), **cfg_over)
        self.consults: list[dict] = []
        self.no_diar: set[str] = set()
        self.pipeline_rc = 0
        self.post_fails = False
        self.runs: list[list[str]] = []
        self.posted: list[dict] = []
        self.fetched: list[str] = []
        self.scored_in_run: list[list[str]] = []
        monkeypatch.setattr(store, "build_from_files", self._build)

    def _build(self, windows, manifest, clips, consults=None):
        uids = sorted({json.loads(l)["consult_uid"] for l in Path(clips).read_text().splitlines()})
        return {"run": json.loads(Path(manifest).read_text()), "windows": [{"consult_uid": u} for u in uids for _ in range(2)]}

    def runner(self, cmd, timeout, check):
        self.runs.append(cmd)
        if self.pipeline_rc == 0:
            out = Path(cmd[cmd.index("--out") + 1])
            out.mkdir(parents=True, exist_ok=True)
            (out / "windows.parquet").write_bytes(b"x")
        return SimpleNamespace(returncode=self.pipeline_rc)

    def fetch(self, app_url, day, secret):
        self.fetched.append(day)
        return {"ok": True, "consults": list(self.consults), "withheld_blind": 0}

    def post(self, payload, url, secret):
        if self.post_fails:
            raise RuntimeError("503")
        self.posted.append(payload)
        return {"ok": True, "inserted": len(payload["windows"]), "run_id": 7}

    def preparer(self, kept, prep):
        good = [{**c, "clip_id": c["consult_uid"] + "-s0", "offset_ms": 0} for c in kept if c["consult_uid"] not in self.no_diar]
        self.scored_in_run.append([c["consult_uid"] for c in good])
        return Prepared(clips=good, no_diarization=[c["consult_uid"] for c in kept if c["consult_uid"] in self.no_diar])

    def tick(self, day=DAY, cfg=None):
        return nightly.intraday(day, cfg or self.cfg, runner=self.runner, fetch=self.fetch, post=self.post, preparer=self.preparer)

    @property
    def ledger(self) -> list[dict]:
        p = Path(self.cfg["workdir"]) / "intraday-ledger.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.is_file() else []


@pytest.fixture
def rig(tmp_path, monkeypatch):
    return Rig(tmp_path, monkeypatch)


def test_ledgered_consults_are_skipped(rig):
    rig.consults = [consult("c1", 1000), consult("c2", 2000)]
    assert rig.tick() == 0
    assert [r["consult_uid"] for r in rig.ledger] == ["c1", "c2"]
    assert rig.tick() == 0  # nothing new: no second pipeline run
    assert len(rig.runs) == 1
    rig.consults.append(consult("c3", 3000))
    assert rig.tick() == 0
    assert len(rig.runs) == 2 and rig.scored_in_run[-1] == ["c3"]
    row = rig.ledger[0]
    assert set(row) == {"consult_uid", "ist_date", "pipeline_version", "valence_model_rev", "arousal_model_rev", "run_id", "windows", "cost_usd_est", "ts"}
    assert row["ist_date"] == DAY and row["run_id"] == 7 and row["windows"] == 2 and row["cost_usd_est"] == pytest.approx(0.0045)
    assert rig.posted[0]["run"]["scope_json"]["job"] == "timbre-intraday"


def test_ledger_row_only_on_ok_ingest(rig):
    rig.consults = [consult("c1", 1000)]
    rig.pipeline_rc = 3
    assert rig.tick() == 1 and rig.ledger == [] and rig.posted == []
    rig.pipeline_rc = 0
    rig.post_fails = True
    with pytest.raises(RuntimeError):  # main() turns this into one ALERT line and exit 1
        rig.tick()
    assert rig.ledger == []
    rig.post_fails = False
    assert rig.tick() == 0
    assert [r["consult_uid"] for r in rig.ledger] == ["c1"]


def test_not_ok_ingest_body_is_not_ledgered(rig):
    rig.consults = [consult("c1", 1000)]
    assert nightly.intraday(DAY, rig.cfg, runner=rig.runner, fetch=rig.fetch, post=lambda *a: {"ok": False}, preparer=rig.preparer) == 0
    assert rig.ledger == []


def test_no_diarization_not_ledgered_and_retried(rig):
    rig.consults = [consult("c1", 1000), consult("c2", 2000)]
    rig.no_diar = {"c2"}
    assert rig.tick() == 0
    assert [r["consult_uid"] for r in rig.ledger] == ["c1"]
    rig.no_diar = set()  # its Nemotron window landed
    assert rig.tick() == 0
    assert rig.scored_in_run[-1] == ["c2"] and [r["consult_uid"] for r in rig.ledger] == ["c1", "c2"]
    # clipless / unsealed consults are never ledgered either
    rig.consults.append(consult("c9", 9000, clip_r2_key=None))
    assert rig.tick() == 0 and "c9" not in {r["consult_uid"] for r in rig.ledger}


def test_all_no_diarization_writes_nothing(rig):
    rig.consults = [consult("c1", 1000)]
    rig.no_diar = {"c1"}
    assert rig.tick() == 0 and rig.ledger == [] and rig.runs == []


def test_cumulative_budget_across_ticks_is_partial_with_alert(rig, capsys):
    rig.cfg["budget_usd_daily"] = nightly.estimate_usd(300) * 2.5  # room for two 5-minute consults
    rig.consults = [consult("c1", 1000), consult("c2", 2000)]
    assert rig.tick() == 0
    rig.consults.append(consult("c3", 3000))
    capsys.readouterr()
    assert rig.tick() == 2  # 0.009 spent, 0.00225 left < 0.0045
    out = capsys.readouterr().out
    assert "ALERT [timbre-intraday]" in out and "PARTIAL" in out
    assert [r["consult_uid"] for r in rig.ledger] == ["c1", "c2"] and rig.runs and len(rig.runs) == 1
    # a later tick keeps alerting while the consult is unscored; another IST date has its own budget
    assert rig.tick() == 2 and len(rig.runs) == 1


def test_budget_partial_in_one_tick_scores_what_fits(rig, capsys):
    rig.cfg["budget_usd_daily"] = nightly.estimate_usd(300) * 1.5
    rig.consults = [consult("c1", 1000), consult("c2", 2000)]
    capsys.readouterr()
    assert rig.tick() == 2
    assert "ALERT [timbre-intraday]" in capsys.readouterr().out
    assert [r["consult_uid"] for r in rig.ledger] == ["c1"] and rig.posted[0]["run"]["state"] == "partial"


def test_other_date_budget_is_independent(rig):
    rig.cfg["budget_usd_daily"] = nightly.estimate_usd(300) * 1.5
    rig.consults = [consult("c1", 1000)]
    assert rig.tick(day="2026-10-14") == 0
    rig.consults = [consult("d1", 1000)]
    assert rig.tick(day=DAY) == 0  # 14 Oct's spend does not count against 15 Oct


def test_version_change_rescores(rig):
    rig.consults = [consult("c1", 1000)]
    assert rig.tick() == 0 and len(rig.runs) == 1
    assert rig.tick() == 0 and len(rig.runs) == 1
    for key, val in (("arousal_model_rev", "new-arousal"), ("valence_model_rev", "new-valence"), ("pipeline_version", "timbre-v2")):
        n = len(rig.runs)
        assert rig.tick(cfg=dict(rig.cfg, **{key: val})) == 0
        assert len(rig.runs) == n + 1, key
    assert len(rig.ledger) == 4


def test_busy_lock_exits_zero(rig, capsys):
    rig.consults = [consult("c1", 1000)]
    Path(rig.cfg["workdir"]).mkdir(parents=True, exist_ok=True)
    with (Path(rig.cfg["workdir"]) / "intraday.lock").open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert rig.tick() == 0
    assert "[timbre-intraday] busy" in capsys.readouterr().out
    assert rig.fetched == [] and rig.runs == [] and rig.ledger == []
    assert rig.tick() == 0 and rig.fetched == [DAY]  # lock released -> the next tick runs


def test_default_date_is_today_ist(monkeypatch):
    # 20:00 UTC on 14 Oct is 01:30 IST on 15 Oct
    assert nightly.today_ist(datetime(2026, 10, 14, 20, 0, tzinfo=timezone.utc)) == "2026-10-15"
    assert nightly.today_ist(datetime(2026, 10, 14, 10, 0, tzinfo=timezone.utc)) == "2026-10-14"
    seen = {}
    monkeypatch.setattr(nightly, "load_config", lambda path: dict(nightly.DEFAULTS))
    monkeypatch.setattr(nightly, "intraday", lambda day, cfg, dry_run=False: seen.update(day=day, dry=dry_run) or 0)
    assert nightly.main(["intraday"]) == 0 and seen["day"] == nightly.today_ist() and seen["dry"] is False
    assert nightly.main(["intraday", "--date", "2026-10-08", "--dry-run"]) == 0 and seen == {"day": "2026-10-08", "dry": True}


def test_disabled_fetches_nothing(rig, monkeypatch):
    rig.cfg["enabled"] = False
    assert rig.tick() == 0 and rig.fetched == [] and rig.runs == [] and not (Path(rig.cfg["workdir"]) / "intraday.lock").exists()
    monkeypatch.setenv("TIMBRE_NIGHTLY_ENABLED", "0")
    cfg = nightly.load_config(None)
    cfg["workdir"] = rig.cfg["workdir"]
    assert nightly.intraday(DAY, cfg, fetch=rig.fetch) == 0 and rig.fetched == []


def test_dry_run_scores_nothing(rig):
    rig.consults = [consult("c1", 1000)]
    assert nightly.intraday(DAY, rig.cfg, dry_run=True, runner=rig.runner, fetch=rig.fetch, post=rig.post, preparer=rig.preparer) == 0
    assert rig.runs == [] and rig.ledger == []


def test_torn_ledger_line_is_ignored(rig):
    rig.consults = [consult("c1", 1000)]
    assert rig.tick() == 0
    p = Path(rig.cfg["workdir"]) / "intraday-ledger.jsonl"
    p.write_text(p.read_text() + '{"consult_uid": "c2", "ist_da')
    assert nightly.read_ledger(p)[0]["consult_uid"] == "c1" and len(nightly.read_ledger(p)) == 1
