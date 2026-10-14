"""Nightly selection, the off switch, and the ingest payload. Synthetic folders only. No model call."""
import json
import os
from pathlib import Path
from datetime import datetime, timezone

import pytest

from tools.eta2freescript import nightly
from tools.eta2freescript.nightly import NightlyError, backfill, hourly, load_index, main, fetch_day, consult_eligible, flag_enabled, include_sealed, jobs_to_rows, load_config, role_doc_from_feed, run, select_day
from tools.eta2freescript.store import payload_from_artifact, redact, sign

# 2026-10-05 04:30:00Z == 10:00 IST
T0 = 1_791_174_600_000
MARKER = "SYNTH_MARKER_NOT_A_NAME"


def _folder(root, uid, day_ms=T0, role_ok=True, transcript=True):
    d = root / uid
    d.mkdir()
    if transcript:
        (d / "transcript.json").write_text(json.dumps({
            "consult_uid": uid,
            "clip": {"t0_ms": day_ms, "t1_ms": day_ms + 60_000, "room_slug": "synth-room"},
            "language_code": "en-IN",
            "english_segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker_id": "0", "text": MARKER}],
        }))
    if role_ok:
        (d / "role.json").write_text(json.dumps({
            "layer": "role", "engine": "llm-roles", "status": "ok",
            "segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker": "0", "role": "doctor", "text": MARKER}],
        }))
    return d


def test_flag_on_by_default_and_zero_is_the_kill_switch():
    assert flag_enabled({}) is True
    assert flag_enabled({}, False) is False
    assert flag_enabled({}, True) is True
    assert flag_enabled({"ETA_FREESCRIPT": "0"}, True) is False
    assert flag_enabled({"ETA_FREESCRIPT": "1"}, False) is True
    with pytest.raises(NightlyError):
        flag_enabled({"ETA_FREESCRIPT": "maybe"}, True)


def test_load_config_defaults_on(tmp_path):
    cfg_path = tmp_path / "n.json"
    cfg_path.write_text(json.dumps({"enabled": False, "data": "x"}))
    assert load_config(str(cfg_path), {})["enabled"] is False
    assert load_config(str(cfg_path), {"ETA_FREESCRIPT": "1"})["enabled"] is True
    assert load_config(None, {})["enabled"] is True
    assert load_config(None, {"ETA_FREESCRIPT": "0"})["enabled"] is False


def test_select_day_needs_sarvam_and_role_track_and_drops_text(tmp_path):
    _folder(tmp_path, "synth-a")
    _folder(tmp_path, "synth-b", role_ok=False)
    (tmp_path / "synth-b").mkdir(exist_ok=True)
    (tmp_path / "synth-b" / "transcript.json").write_text("{}")
    _folder(tmp_path, "synth-c", day_ms=T0 + 86_400_000)
    rows = select_day(tmp_path, "2026-10-05")
    assert [r["uid"] for r in rows] == ["synth-a"]
    assert rows[0]["room_slug"] == "synth-room"
    assert MARKER not in json.dumps(rows)
    one = consult_eligible(tmp_path / "synth-a", "2026-10-05")
    assert set(one) == {"uid", "ist_date", "room_slug", "doctor_uid8", "job_id"}


def test_run_posts_redacted_artifact_and_stays_quiet_when_off(tmp_path, capsys):
    _folder(tmp_path, "synth-a")
    cfg = {"enabled": False, "data": str(tmp_path), "app_url": "https://app.test", "max_consults": 40}
    assert run(cfg, "2026-10-05", pending=False) == 0
    assert "disabled" in capsys.readouterr().out

    posted = {}

    def run_one(_uid):
        return {"final_valid": True, "final_errors": [], "artifact": {
            "schema_version": "eta.freescript.v0.2",
            "encounter": {"eta_encounter_id": "synth-a", "room": "synth-room",
                          "transcript": {"segment_count": 1, "segments": [{"text": MARKER}], "speaker_source": "role_track"}},
            "pulse_link": {"consult_uid": "synth-a"},
            "generator": {"code_sha256": "a" * 64, "prompt_sha256": "b" * 64, "model": "anthropic.claude"},
            "gp_extraction": {"medicines": []}, "completion_required": [], "note_text": "Medication:",
        }}

    def post(body):
        posted["body"] = body
        return {"ok": True, "inserted": 1, "run_id": 1}

    cfg["enabled"] = True
    assert run(cfg, "2026-10-05", run_one=run_one, post=post, pending=False) == 0
    body = posted["body"]
    assert body["consult_uid"] == "synth-a"
    assert body["validator"]["ok"] is True
    assert "segments" not in json.dumps(body["artifact"]["encounter"]["transcript"])
    assert MARKER not in json.dumps(body)
    out = capsys.readouterr().out
    assert MARKER not in out
    assert "posted" in out


def test_a_failed_artifact_is_posted_as_rejected_with_cost(tmp_path, capsys):
    _folder(tmp_path, "synth-a")
    posted = {}

    def run_one(_uid):
        return {"final_valid": False, "final_errors": ["FRX-A1 general_advice must be at most 300 characters and 5 items"],
                "cost_usd": 0.0123, "artifact": {
                    "schema_version": "eta.freescript.v0.2",
                    "encounter": {"eta_encounter_id": "synth-a", "room": "synth-room", "transcript": {"segment_count": 1}},
                    "pulse_link": {"consult_uid": "synth-a"},
                    "generator": {"code_sha256": "a" * 64, "prompt_sha256": "b" * 64, "model": "anthropic.claude"},
                    "gp_extraction": {}, "completion_required": [], "note_text": "Medication:",
                }}

    def post(body):
        posted["body"] = body
        return {"ok": True, "inserted": 1, "run_id": 2}

    cfg = {"enabled": True, "data": str(tmp_path), "app_url": "https://app.test", "max_consults": 40}
    assert run(cfg, "2026-10-05", run_one=run_one, post=post, pending=False) == 2
    body = posted["body"]
    assert body["validator"]["ok"] is False
    assert body["validator"]["errors"][0].startswith("FRX-A1")
    assert body["cost_usd"] == 0.0123
    out = capsys.readouterr().out
    assert "rejected" in out and "FRX-A1" not in out


def test_pending_consult_is_included_and_a_missing_folder_is_counted(tmp_path):
    _folder(tmp_path, "synth-a")
    rows, missing = jobs_to_rows(
        [{"job_id": "job_abc123", "consult_uid": "synth-a"}, {"job_id": "job_missing1", "consult_uid": "synth-nope"}],
        tmp_path)
    assert rows[0]["job_id"] == "job_abc123" and rows[0]["uid"] == "synth-a"
    assert missing == ["synth-nope"]
    assert MARKER not in json.dumps(rows)


def test_sealed_consult_is_included_once_a_role_track_is_filled(tmp_path):
    _folder(tmp_path, "synth-sealed", role_ok=False)
    role = {"layer": "role", "engine": "llm-roles", "status": "ok",
            "segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker": "0", "role": "doctor", "text": MARKER}]}
    rows, missing = include_sealed(tmp_path, "2026-10-05", ["synth-sealed", "synth-none"], lambda uid: role if uid == "synth-sealed" else None)
    assert [r["uid"] for r in rows] == ["synth-sealed"]
    assert missing == ["synth-none"]
    written = json.loads((tmp_path / "synth-sealed" / "role.json").read_text())
    assert MARKER not in json.dumps(written)
    assert "text" not in json.dumps(written["segments"])
    again, missing_again = include_sealed(tmp_path, "2026-10-05", ["synth-sealed"], lambda uid: role)
    assert [r["uid"] for r in again] == ["synth-sealed"] and missing_again == []


def test_role_feed_row_becomes_a_role_file_without_text():
    doc = role_doc_from_feed({
        "segments": [{"t0_ms": 1, "t1_ms": 2, "speaker": "0", "role": "doctor", "text": MARKER}],
        "flags": {"attender_present": False, "two_consults": False, "diar_partial": False},
    })
    assert doc["status"] == "ok" and doc["extras"]["two_consults"] == {"flag": False}
    assert MARKER not in json.dumps(doc)


def test_sign_matches_the_ts_construction():
    assert sign("{}", "s3cret", 1_759_000_000) == __import__("hmac").new(
        b"s3cret", b"1759000000.{}", __import__("hashlib").sha256).hexdigest()


def test_redact_keeps_the_note_and_drops_segments():
    art = redact({"note_text": "Medication:", "encounter": {"transcript": {"segment_count": 2, "segments": [{"text": MARKER}]}}})
    assert art["note_text"] == "Medication:"
    assert art["encounter"]["transcript"] == {"segment_count": 2}


def test_payload_omits_empty_optional_fields():
    art = {"schema_version": "eta.freescript.v0.2", "encounter": {"eta_encounter_id": "synth-a"},
           "pulse_link": {"consult_uid": "synth-a"}, "generator": {"code_sha256": "c" * 64, "prompt_sha256": "d" * 64},
           "completion_required": [{"kind": "exam_missing"}]}
    body = payload_from_artifact(art, ist_date="2026-10-05")
    assert body["version"] == "freescript-store-v1"
    assert "job_id" not in body and "prescription_uid" not in body
    assert len(body["input_sha256"]) == 64
    # ist date of the fixed instant, so a clock change in CI cannot drift the helper
    assert datetime.fromtimestamp(T0 / 1000, tz=timezone.utc).isoformat().startswith("2026-10-05")


# ---- skip-existing, hourly, backfill (bundle mode; HTTP and run_one mocked) ----

class _Resp:
    def __init__(self, body):
        import io
        self._b = io.BytesIO(json.dumps(body).encode())

    def read(self):
        return self._b.read()

    def __enter__(self): return self
    def __exit__(self, *a): return False


def _bcfg(tmp_path, **kw):
    return {"enabled": True, "app_url": "https://app.test", "max_consults": 40, "bundle_cmd": ["x", "{uid}", "{out}"],
            "bundle_cwd": str(tmp_path), "out": str(tmp_path / "keep"), **kw}


@pytest.fixture
def bundle_env(monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s3cret")
    monkeypatch.setenv("REB_INDEX_READ_TOKEN", "")
    ran = []

    own_day = {}  # uid -> the consult's own IST date, when it is not the run day

    def fake_rows(uids, day, cfg, tmp, fetch=None, outcomes=None, dates=None):
        bad = {"nl": "not_eligible:missing_layers", "nd": "not_eligible:not_this_day", "bf": "bundle_failed"}
        uids = [t for t in uids if not (t[0] in bad and outcomes is not None and outcomes.setdefault(t[0], bad[t[0]]))]
        if dates is not None:
            dates.update({u: own_day.get(u, day) for u, _, _ in uids})
        rows = [{"uid": u, "ist_date": own_day.get(u, day), "room_slug": "synth-room", "job_id": j, "doctor_uid8": None} for u, j, _ in uids]
        return rows, {u: object() for u, _, _ in uids}, {"bundle_failed": 0, "missing_layers": 0, "not_this_day": 0}

    monkeypatch.setattr(nightly, "bundle_rows", fake_rows)

    def run_one(uid):
        ran.append(uid)
        if uid == "boom":
            raise RuntimeError("synthetic")
        return {"final_valid": True, "final_errors": [], "cost_usd": 0.5, "artifact": {
            "schema_version": "eta.freescript.v0.2", "encounter": {"eta_encounter_id": uid},
            "pulse_link": {"consult_uid": uid}, "generator": {"code_sha256": "a" * 64, "prompt_sha256": "b" * 64},
            "completion_required": [], "note_text": "Medication:"}}

    run_one.own_day = own_day
    return ran, run_one


def _call(cfg, day, run_one, sealed, day_read, **kw):
    return run(cfg, day, run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, pending=kw.pop("pending", False),
               sealed=sealed, skip_existing=True, day_read=day_read, **kw)


def test_skip_existing_drops_ok_and_partial_and_keeps_rejected(tmp_path, bundle_env, capsys):
    ran, run_one = bundle_env
    stored = [{"consult_uid": "a", "state": "ok"}, {"consult_uid": "b", "state": "partial"}, {"consult_uid": "c", "state": "rejected"}]
    rc = _call(_bcfg(tmp_path), "2026-10-05", run_one, ["a", "b", "c", "d"], lambda *_: stored)
    assert rc == 0 and sorted(ran) == ["c", "d"]
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["skipped_existing"] == 2 and line["posted"] == 2 and line["cost_usd"] == 1.0


def test_skip_existing_applies_before_the_cap(tmp_path, bundle_env):
    ran, run_one = bundle_env
    stored = [{"consult_uid": "a", "state": "ok"}]
    assert _call(_bcfg(tmp_path, max_consults=1), "2026-10-05", run_one, ["a", "b"], lambda *_: stored) == 0
    assert ran == ["b"]


def test_day_read_down_uses_the_ledger_alone_and_continues(tmp_path, bundle_env, capsys):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    _ledger(cfg, [("a", "written", None, "x"), ("b", "skipped_existing", None, "x")])

    def boom(*_):
        raise OSError("down")

    assert _call(cfg, "2026-10-05", run_one, ["a", "b", "c"], boom) == 0
    assert ran == ["c"]
    line = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
    assert line["day_read_failed"] is True and line["skipped_existing"] == 2


def test_both_ledger_and_day_read_down_aborts_with_exit_1(tmp_path, bundle_env, capsys):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    (tmp_path / "keep").mkdir()
    (tmp_path / "keep" / "consult-state.jsonl").mkdir()  # a directory where the file should be: unreadable

    def boom(*_):
        raise OSError("down")

    out = {}
    assert _call(cfg, "2026-10-05", run_one, ["a"], boom, out=out) == 1
    assert ran == [] and out["fatal"] is True
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["ledger_unreadable"] is True


def test_skip_existing_without_out_is_a_config_error(tmp_path, bundle_env, capsys):
    ran, run_one = bundle_env
    out = {}
    assert _call(_bcfg(tmp_path, out=""), "2026-10-05", run_one, ["a"], lambda *_: [], out=out) == 1
    assert ran == [] and out["fatal"] is True and "config error" in capsys.readouterr().out


def _ledger(cfg, entries):
    """entries: (uid, state, artifact_id, code_sha)"""
    root = Path(cfg["out"])
    root.mkdir(parents=True, exist_ok=True)
    with open(root / "consult-state.jsonl", "a") as f:
        for uid, st, aid, sha in entries:
            f.write(json.dumps({"consult_uid": uid, "ist_date": "2026-10-05", "state": st, "artifact_id": aid,
                                "run_ts": "t", "code_sha256": sha}) + "\n")


def test_truncated_day_read_continues_and_skips_by_ledger(tmp_path, bundle_env, capsys):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    _ledger(cfg, [("old", "written", "9", "x")])
    assert _call(cfg, "2026-10-05", run_one, ["old", "listed", "new"],
                 lambda *_: ([{"consult_uid": "listed", "state": "ok", "run_id": 4}], True)) == 0
    assert ran == ["new"]
    line = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
    assert line["day_read_partial"] is True and line["skipped_existing"] == 2


def test_fetch_day_flags_withheld_blind_as_partial(monkeypatch):
    seen = {}
    monkeypatch.setattr(nightly.urllib.request, "urlopen", lambda req, timeout=0: _Resp(seen["body"]))
    seen["body"] = {"ok": True, "rows": [], "truncated": False, "withheld_blind": 3}
    assert fetch_day("https://app.test", "s", "2026-10-05") == ([], True)
    seen["body"] = {"ok": True, "rows": [], "truncated": False, "withheld_blind": 0}
    assert fetch_day("https://app.test", "s", "2026-10-05") == ([], False)


def test_blind_room_day_continues_end_to_end(tmp_path, bundle_env, capsys):
    ran, run_one = bundle_env
    assert _call(_bcfg(tmp_path), "2026-10-05", run_one, ["a"], lambda *_: ([], True)) == 0
    assert ran == ["a"]
    assert json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])["day_read_partial"] is True


def test_rejected_is_skipped_at_the_same_code_sha_and_retried_at_a_new_one(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    _ledger(cfg, [("r", "rejected", "5", "sha-A")])
    assert _call(cfg, "2026-10-05", run_one, ["r"], lambda *_: []) == 0
    assert ran == []
    last = [json.loads(l) for l in (tmp_path / "keep" / "consult-state.jsonl").read_text().splitlines()][-1]
    assert last["state"] == "rejected" and last["artifact_id"] == "5"  # still rejected, so a later code change still retries
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-B")
    assert _call(cfg, "2026-10-05", run_one, ["r"], lambda *_: []) == 0
    assert ran == ["r"]


def test_written_is_skipped_across_two_hourly_runs(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    kw = dict(run_one=run_one, post=lambda b: {"ok": True, "inserted": 1, "run_id": 11}, sealed=["a", "b"], pending=[],
              day_read=lambda *_: ([], True))  # the day read shows nothing: only the ledger can stop a rerun
    assert hourly(cfg, now=_ist(2026, 10, 14, 10, 5), **kw) == 0
    assert sorted(ran) == ["a", "b"]
    assert hourly(cfg, now=_ist(2026, 10, 14, 11, 5), **kw) == 0
    assert sorted(ran) == ["a", "b"]  # nothing ran twice
    states = [json.loads(l)["state"] for l in (tmp_path / "keep" / "consult-state.jsonl").read_text().splitlines()]
    assert states.count("written") == 2 and states.count("skipped_existing") == 2


def test_fetch_day_reports_truncation_as_partial_and_bad_bodies_as_failure(monkeypatch):
    import io

    class R(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False

    seen = {}

    def opener(req, timeout=0):
        seen["h"] = dict(req.header_items())
        return R(json.dumps(seen["body"]).encode())

    monkeypatch.setattr(nightly.urllib.request, "urlopen", opener)
    seen["body"] = {"ok": True, "rows": [{"consult_uid": "a", "state": "ok"}], "truncated": False}
    assert fetch_day("https://app.test", "s", "2026-10-05") == ([{"consult_uid": "a", "state": "ok"}], False)
    assert "X-freescript-signature" in seen["h"]
    seen["body"] = {"ok": True, "rows": [], "truncated": True}
    assert fetch_day("https://app.test", "s", "2026-10-05") == ([], True)
    seen["body"] = {"ok": False}
    with pytest.raises(NightlyError):
        fetch_day("https://app.test", "s", "2026-10-05")


def _ist(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=nightly.IST)


def test_hourly_runs_today_only_after_two_and_both_days_before_two(tmp_path, bundle_env, monkeypatch, capsys):
    ran, run_one = bundle_env
    days, pend = [], []
    real = nightly.run

    def spy(cfg, day, **kw):
        days.append(day)
        pend.append(kw.get("pending"))
        return real(cfg, day, **kw)

    monkeypatch.setattr(nightly, "run", spy)
    kw = dict(run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, sealed=["a"], day_read=lambda *_: [], pending=[])
    assert hourly(_bcfg(tmp_path), now=_ist(2026, 10, 14, 2, 5), **kw) == 0
    assert days == ["2026-10-14"]
    days.clear(); pend.clear()
    assert hourly(_bcfg(tmp_path), now=_ist(2026, 10, 14, 1, 59), **kw) == 0
    assert days == ["2026-10-14", "2026-10-13"]
    assert pend[0] == [] and pend[1] is False  # pending drained once
    lines = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    assert [l["date"] for l in lines[-2:]] == ["2026-10-14", "2026-10-13"]


def test_hourly_exit_is_the_worse_of_the_two_days(tmp_path, monkeypatch):
    codes = iter([2, 1])
    monkeypatch.setattr(nightly, "run", lambda cfg, day, **kw: next(codes))
    assert hourly(_bcfg(tmp_path), now=_ist(2026, 10, 14, 0, 30)) == 1
    codes = iter([1, 2])
    assert hourly(_bcfg(tmp_path), now=_ist(2026, 10, 14, 0, 30)) == 1
    codes = iter([0, 2])
    assert hourly(_bcfg(tmp_path), now=_ist(2026, 10, 14, 0, 30)) == 2


def test_backfill_is_newest_first_and_continues_on_exit_2(tmp_path, monkeypatch, capsys):
    seen = []

    def fake(cfg, day, **kw):
        seen.append(day)
        kw["out"].update(eligible=3, posted=1, skipped_existing=1, rejected=1, failed=0, missing_layers=0, bundle_failed=0, cost_usd=0.25)
        return 2

    monkeypatch.setattr(nightly, "run", fake)
    assert backfill(_bcfg(tmp_path), "2026-10-03", "2026-10-05") == 2
    assert seen == ["2026-10-05", "2026-10-04", "2026-10-03"]
    total = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert total == {"total": True, "days": 3, "eligible": 9, "written": 3, "skipped_existing": 3, "rejected": 3, "failed": 0,
                     "missing_layers": 0, "bundle_failed": 0, "attempts_exhausted": 0, "cost_unknown": 0, "cost_usd": 0.75}


def test_backfill_stops_on_a_fatal_exit_1_but_not_on_a_plain_one(tmp_path, monkeypatch):
    seen = []

    def fatal(cfg, day, **kw):
        seen.append(day)
        if day == "2026-10-04":
            kw["out"]["fatal"] = True
            return 1
        return 0

    monkeypatch.setattr(nightly, "run", fatal)
    assert backfill(_bcfg(tmp_path), "2026-10-01", "2026-10-05") == 1
    assert seen == ["2026-10-05", "2026-10-04"]
    seen.clear()
    monkeypatch.setattr(nightly, "run", lambda cfg, day, **kw: seen.append(day) or 1)  # exit 1 with nothing stored, not fatal
    backfill(_bcfg(tmp_path), "2026-10-04", "2026-10-05")
    assert seen == ["2026-10-05", "2026-10-04"]


def test_backfill_refuses_more_than_120_days(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(nightly, "run", lambda *a, **k: pytest.fail("must not run"))
    assert backfill(_bcfg(tmp_path), "2026-06-01", "2026-10-01") == 1  # 123 days
    assert "120" in capsys.readouterr().out
    seen = []
    monkeypatch.setattr(nightly, "run", lambda cfg, day, **kw: seen.append(day) or 0)
    assert backfill(_bcfg(tmp_path), "2026-06-04", "2026-10-01") == 0  # exactly 120 days
    assert len(seen) == 120


def test_hourly_and_backfill_need_bundle_mode(monkeypatch, capsys):
    monkeypatch.delenv("FREESCRIPT_BUNDLE_CMD", raising=False)
    assert main(["hourly"]) == 1
    assert main(["backfill", "--from", "2026-10-01", "--to", "2026-10-02"]) == 1
    assert capsys.readouterr().out.count("config error: hourly/backfill need bundle mode") == 2


def test_run_date_today_is_the_current_ist_day_and_max_consults_overrides(tmp_path, monkeypatch):
    monkeypatch.delenv("FREESCRIPT_BUNDLE_CMD", raising=False)
    got = {}
    monkeypatch.setattr(nightly, "run", lambda cfg, day, **kw: got.update(day=day, cap=cfg["max_consults"], skip=kw["skip_existing"]) or 0)
    # 2026-10-13 21:00Z is already 2026-10-14 in IST
    assert main(["run", "--date", "today", "--max-consults", "3", "--skip-existing"], now=datetime(2026, 10, 13, 21, 0, tzinfo=timezone.utc)) == 0
    assert got == {"day": "2026-10-14", "cap": 3, "skip": True}
    main(["run", "--date", "2026-10-01"], now=datetime(2026, 10, 13, 21, 0, tzinfo=timezone.utc))
    assert got["day"] == "2026-10-01" and got["skip"] is False


def _index(tmp_path):
    rows = [
        {"consult_uid": "u1", "ist_date": "2026-09-10", "minutes": 1.0, "secret_field": MARKER},
        {"consult_uid": "u1", "ist_date": "2026-09-10", "minutes": 5.5},        # last row wins
        {"consult_uid": "u2", "ist_date": "2026-09-10", "minutes": 4},
        {"consult_uid": "u2", "ist_date": "2026-09-10", "minutes": 1.9},        # last row wins, now too short
        {"consult_uid": "u3", "ist_date": "2026-09-11", "minutes": 2},          # boundary kept
        {"consult_uid": "u4", "ist_date": "2026-08-01", "minutes": 9},          # before range
        {"consult_uid": "u5", "ist_date": "2026-10-01", "minutes": 9},          # after range
    ]
    f = tmp_path / "index.jsonl"
    f.write_text("\n".join([json.dumps(r) for r in rows] + ["{not json", json.dumps({"consult_uid": "u6"}), json.dumps([1])]) + "\n")
    return f


def test_load_index_last_row_wins_filters_and_counts_malformed(tmp_path):
    by_day, bad = load_index(str(_index(tmp_path)), "2026-09-01", "2026-09-30")
    assert by_day == {"2026-09-10": ["u1"], "2026-09-11": ["u3"]}
    assert bad == 3


def test_backfill_from_index_uses_the_index_uids_not_the_sealed_feed(tmp_path, bundle_env, capsys):
    ran, run_one = bundle_env
    rc = backfill(_bcfg(tmp_path), "2026-09-09", "2026-09-11", uids_from_index=str(_index(tmp_path)), run_one=run_one,
                  post=lambda b: {"ok": True, "inserted": 1}, day_read=lambda *_: [{"consult_uid": "u3", "state": "ok"}])
    assert rc == 0 and ran == ["u1"]  # u3 already stored; no pending drain
    out = capsys.readouterr().out
    assert MARKER not in out and '"malformed": 3' in out
    total = json.loads(out.strip().splitlines()[-1])
    assert total["days"] == 3 and total["written"] == 1 and total["skipped_existing"] == 1


def test_consult_state_ledger_has_every_state(tmp_path, bundle_env):
    ran, run_one = bundle_env
    out = tmp_path / "keep"
    posts = {"rej": {"ok": True, "inserted": 1, "run_id": 7}, "okk": {"ok": True, "inserted": 1, "run_id": 8}}

    def run_one2(uid):
        log = run_one(uid)
        if uid == "rej":
            log = dict(log, final_valid=False, final_errors=["FRX-A1 x"])
        return log

    cur = {}

    def post(body):
        return posts.get(body["consult_uid"], {"ok": False})

    stored = [{"consult_uid": "have", "state": "ok", "run_id": 3}, {"consult_uid": "rej", "state": "rejected", "run_id": 2}]
    rc = run(_bcfg(tmp_path, out=str(out)), "2026-10-05", run_one=run_one2, post=post, pending=False, skip_existing=True,
             day_read=lambda *_: stored, sealed=["have", "rej", "okk", "boom", "nl", "nd", "bf", "pf"])
    assert rc == 2
    path = out / "consult-state.jsonl"
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    lines = [json.loads(l) for l in path.read_text().splitlines()]
    by = {l["consult_uid"]: l for l in lines}
    assert {k: by[k]["state"] for k in by} == {
        "have": "skipped_existing", "rej": "rejected", "okk": "written", "boom": "failed:RuntimeError",
        "nl": "not_eligible:missing_layers", "nd": "not_eligible:not_this_day", "bf": "bundle_failed", "pf": "post_failed"}
    assert by["have"]["artifact_id"] == "3" and by["rej"]["artifact_id"] == "7" and by["okk"]["artifact_id"] == "8"
    assert by["boom"]["artifact_id"] is None and by["nl"]["artifact_id"] is None
    for l in lines:
        assert set(l) == {"consult_uid", "ist_date", "state", "artifact_id", "run_ts", "code_sha256"} and l["code_sha256"] == nightly.current_code_sha() and l["ist_date"] == "2026-10-05"


def test_ledger_not_written_without_out_or_on_dry_run(tmp_path, bundle_env):
    ran, run_one = bundle_env
    kw = dict(run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, pending=False, sealed=["a"])
    run(_bcfg(tmp_path, out=""), "2026-10-05", **kw)
    run(_bcfg(tmp_path, out=str(tmp_path / "k")), "2026-10-05", dry_run=True, **kw)
    assert not (tmp_path / "k").exists() and not list(tmp_path.glob("**/consult-state.jsonl"))


# ---- fix round 2: lock, per-consult ledger, seed lines, post_failed repost, ledger failure, pending bypass, own date ----

def _lines(cfg):
    p = Path(cfg["out"]) / "consult-state.jsonl"
    rows = []
    for l in (p.read_text().splitlines() if p.exists() else []):
        try:
            r = json.loads(l)
        except ValueError:
            continue
        if isinstance(r, dict) and isinstance(r.get("consult_uid"), str):
            rows.append(r)
    return rows


def test_a_held_lock_prints_locked_and_runs_nothing(tmp_path, bundle_env, capsys):
    import fcntl
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    Path(cfg["out"]).mkdir(parents=True)
    fd = os.open(Path(cfg["out"]) / ".nightly.lock", os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # another process holds it
    try:
        kw = dict(run_one=run_one, post=lambda b: {"ok": True}, pending=False, sealed=["a"], day_read=lambda *_: [])
        assert run(cfg, "2026-10-05", skip_existing=True, **kw) == 0
        out = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
        assert len(out) == 1 and out[0]["locked"] is True
        assert hourly(cfg, now=_ist(2026, 10, 14, 0, 30), **kw) == 0
        assert backfill(cfg, "2026-10-04", "2026-10-05", **kw) == 0
        assert [json.loads(l)["locked"] for l in capsys.readouterr().out.splitlines() if l.startswith("{")] == [True, True]
        assert ran == [] and _lines(cfg) == []
    finally:
        os.close(fd)
    assert run(cfg, "2026-10-05", skip_existing=True, **kw) == 0  # the lock is free again
    assert ran == ["a"]


def test_the_lock_is_released_on_exit_and_a_nested_call_does_not_deadlock(tmp_path, bundle_env):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    kw = dict(run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, pending=False, sealed=["a"], day_read=lambda *_: [])
    assert hourly(cfg, now=_ist(2026, 10, 14, 0, 30), **kw) == 0  # hourly holds it and run takes it again
    assert not nightly._HELD_LOCKS
    with nightly.nightly_lock(cfg["out"]) as st:
        assert st == "ok"
    assert (Path(cfg["out"]) / ".nightly.lock").exists()


def test_the_ledger_is_written_per_consult_so_a_crash_keeps_what_was_done(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")

    def crashing(uid):
        if uid == "c":
            raise KeyboardInterrupt  # not an Exception: it ends the process, not the consult
        return run_one(uid)

    with pytest.raises(KeyboardInterrupt):
        _call(cfg, "2026-10-05", crashing, ["a", "b", "c", "d"], lambda *_: ([], True))
    assert [(l["consult_uid"], l["state"]) for l in _lines(cfg)] == [("a", "written"), ("b", "written")]
    assert not nightly._HELD_LOCKS
    ran.clear()
    assert _call(cfg, "2026-10-05", run_one, ["a", "b", "c", "d"], lambda *_: ([], True)) == 0
    assert ran == ["c", "d"]  # a and b are skipped by the ledger alone


def test_a_seed_line_skips_whatever_its_code_sha_and_extra_or_missing_fields(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-NEW")
    root = Path(cfg["out"])
    root.mkdir(parents=True)
    (root / "consult-state.jsonl").write_text("\n".join([
        json.dumps({"consult_uid": "s1", "state": "written", "code_sha256": "seed"}),  # no ist_date, run_ts, artifact_id
        json.dumps({"consult_uid": "s2", "state": "written", "code_sha256": "seed", "artifact_id": 5, "source": "store", "n": [1]}),
        json.dumps(["not", "a", "row"]), "not json at all", json.dumps({"consult_uid": 7, "state": "written"}), ""]) + "\n")
    assert _call(cfg, "2026-10-05", run_one, ["s1", "s2", "n1"], lambda *_: ([], True)) == 0
    assert ran == ["n1"]
    assert {l["consult_uid"]: l["state"] for l in _lines(cfg)[-3:]} == {"s1": "skipped_existing", "s2": "skipped_existing", "n1": "written"}


def test_ingest_down_for_three_hourly_runs_costs_one_bedrock_run(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    posts = []

    def keeping(uid):  # the real runner keeps the artifact and its validation file under out/<uid>
        log = run_one(uid)
        d = Path(cfg["out"]) / uid
        d.mkdir(parents=True, exist_ok=True)
        (d / "artifact.json").write_text(json.dumps(log["artifact"]))
        (d / "artifact.validation.json").write_text(json.dumps({"final_valid": True, "final_errors": [], "cost_usd": 0.5}))
        return log

    state = {"up": False}

    def post(body):
        posts.append(body["consult_uid"])
        if not state["up"]:
            raise ConnectionError("down")
        return {"ok": True, "inserted": 1, "run_id": 21}

    kw = dict(run_one=keeping, post=post, sealed=["a"], pending=[], day_read=lambda *_: ([], True))
    for h in (10, 11, 12):
        assert hourly(cfg, now=_ist(2026, 10, 14, h, 5), **kw) == 1
    assert ran == ["a"] and posts == ["a", "a", "a"]  # one Bedrock run, three POST attempts
    assert [l["state"] for l in _lines(cfg)] == ["post_failed"] * 3
    assert all(l["code_sha256"] == "sha-A" for l in _lines(cfg))
    state["up"] = True
    assert hourly(cfg, now=_ist(2026, 10, 14, 13, 5), **kw) == 0
    assert ran == ["a"] and posts[-1] == "a" and _lines(cfg)[-1]["state"] == "written" and _lines(cfg)[-1]["artifact_id"] == "21"
    assert hourly(cfg, now=_ist(2026, 10, 14, 14, 5), **kw) == 0  # written now: nothing posts again
    assert len(posts) == 4


def test_post_failed_without_a_kept_artifact_or_at_a_new_code_sha_reruns(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    _ledger(cfg, [("nokeep", "post_failed", None, "sha-A"), ("oldsha", "post_failed", None, "sha-0")])
    d = Path(cfg["out"]) / "oldsha"
    d.mkdir()
    (d / "artifact.json").write_text(json.dumps({"schema_version": "x"}))
    assert _call(cfg, "2026-10-05", run_one, ["nokeep", "oldsha"], lambda *_: ([], True)) == 0
    assert ran == ["nokeep", "oldsha"]


def test_a_ledger_write_failure_prints_the_flag_and_exits_1_fatal(tmp_path, bundle_env, monkeypatch, capsys):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    real = nightly.append_states

    def failing(root, lines):
        if any(l["consult_uid"] == "b" for l in lines):
            raise OSError(28, "no space")
        real(root, lines)

    monkeypatch.setattr(nightly, "append_states", failing)
    out = {}
    assert run(cfg, "2026-10-05", run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, pending=False, sealed=["a", "b", "c"],
               skip_existing=True, day_read=lambda *_: [], out=out) == 1
    line = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
    assert line["ledger_write_failed"] is True and out["fatal"] is True
    assert ran == ["a", "b"]  # it stops after the consult whose line could not be written
    # backfill stops on it
    seen = []
    monkeypatch.setattr(nightly, "append_states", failing)

    def fake_inner(cfg_, day, **kw):
        seen.append(day)
        kw["out"].update(fatal=True, ledger_write_failed=True)
        return 1

    monkeypatch.setattr(nightly, "run", fake_inner)
    assert backfill(cfg, "2026-10-03", "2026-10-05") == 1 and seen == ["2026-10-05"]


def test_a_pending_job_bypasses_skip_existing_and_its_ledger_line_has_the_job_id(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    _ledger(cfg, [("w", "written", "9", "sha-A"), ("other", "written", "8", "sha-A")])
    jobs = [{"consult_uid": "w", "job_id": "job-1"}]
    assert run(cfg, "2026-10-05", run_one=run_one, post=lambda b: {"ok": True, "inserted": 1, "run_id": 30}, pending=lambda *_: jobs,
               sealed=["other"], skip_existing=True, day_read=lambda *_: [{"consult_uid": "w", "state": "ok", "run_id": 9}]) == 0
    assert ran == ["w"]  # the sealed uid is skipped; the pending rerun is served
    by = {l["consult_uid"]: l for l in _lines(cfg)[2:]}
    assert by["w"]["state"] == "written" and by["w"]["job_id"] == "job-1" and by["w"]["artifact_id"] == "30"
    assert by["other"]["state"] == "skipped_existing" and "job_id" not in by["other"]


def test_the_ledger_ist_date_is_the_consults_own_day_not_the_run_day(tmp_path, bundle_env):
    ran, run_one = bundle_env
    run_one.own_day["old"] = "2026-09-30"
    cfg = _bcfg(tmp_path)
    assert run(cfg, "2026-10-05", run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, pending=lambda *_: [{"consult_uid": "old", "job_id": "j"}],
               sealed=["new"], skip_existing=True, day_read=lambda *_: []) == 0
    by = {l["consult_uid"]: l for l in _lines(cfg)}
    assert by["old"]["ist_date"] == "2026-09-30" and by["new"]["ist_date"] == "2026-10-05"


# ---- fix round 3: one attempt cap per (uid, code_sha256), counted from the box ledger ----

def _keeping(cfg, run_one):
    """The real runner keeps artifact.json for a valid run; a rejected run (pipeline writes none) keeps nothing."""
    def keeping(uid):
        log = run_one(uid)
        if log.get("final_valid"):
            d = Path(cfg["out"]) / uid
            d.mkdir(parents=True, exist_ok=True)
            (d / "artifact.json").write_text(json.dumps(log["artifact"]))
            (d / "artifact.validation.json").write_text(json.dumps({"final_valid": True, "final_errors": [], "cost_usd": 0.5}))
        return log
    return keeping


def _hours(cfg, hours, **kw):
    return [hourly(cfg, now=_ist(2026, 10, 14, h, 5), **kw) for h in hours]


def _states(cfg, uid):
    return [l["state"] for l in _lines(cfg) if l["consult_uid"] == uid]


def test_a_pending_job_with_ingest_down_costs_one_bedrock_call_then_reposts_then_is_served(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    state = {"up": False, "jobs": [{"consult_uid": "p", "job_id": "job-7"}]}
    posted = []

    def post(body):
        posted.append((body["consult_uid"], body.get("job_id")))
        if not state["up"]:
            raise ConnectionError("down")
        return {"ok": True, "inserted": 1, "run_id": 41}

    kw = dict(run_one=_keeping(cfg, run_one), post=post, sealed=[], pending=lambda *_: state["jobs"], day_read=lambda *_: ([], True))
    assert _hours(cfg, (10, 11, 12), **kw) == [1, 1, 1]
    assert ran == ["p"]  # one Bedrock call; the next two hours re-post the kept artifact
    assert posted == [("p", "job-7")] * 3  # the job id rides every re-post
    assert _states(cfg, "p") == ["post_failed"] * 3
    assert nightly.count_attempts(cfg["out"], "sha-A") == {"p": 1}  # a re-post is not an attempt
    state["up"] = True
    assert _hours(cfg, (13,), **kw) == [0]
    assert ran == ["p"] and _states(cfg, "p")[-1] == "written" and _lines(cfg)[-1]["job_id"] == "job-7" and posted[-1] == ("p", "job-7")


def test_a_repost_takes_the_job_id_from_the_ledger_when_the_job_is_no_longer_listed(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    d = Path(cfg["out"]) / "p"
    d.mkdir(parents=True)
    (d / "artifact.json").write_text(json.dumps(run_one("p")["artifact"]))
    ran.clear()
    root = Path(cfg["out"])
    (root / "consult-state.jsonl").write_text(json.dumps({"consult_uid": "p", "ist_date": "2026-10-14", "state": "post_failed", "artifact_id": None,
                                                         "run_ts": "t", "code_sha256": "sha-A", "job_id": "job-3"}) + "\n")
    got = []
    assert _hours(cfg, (10,), run_one=run_one, post=lambda b: got.append(b.get("job_id")) or {"ok": True, "inserted": 1, "run_id": 5},
                  sealed=["p"], pending=lambda *_: [], day_read=lambda *_: ([], True)) == [0]
    assert ran == [] and got == ["job-3"]


def test_rejected_with_ingest_down_costs_two_bedrock_calls_then_attempts_exhausted(tmp_path, bundle_env, monkeypatch, capsys):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")

    def rejected(uid):  # pipeline.py writes no artifact.json for a rejected result: nothing to re-post
        log = run_one(uid)
        log["final_valid"], log["final_errors"] = False, ["x"]
        return log

    def post(body):
        raise ConnectionError("down")

    kw = dict(run_one=rejected, post=post, sealed=["r"], pending=lambda *_: [], day_read=lambda *_: ([], True))
    capsys.readouterr()
    assert _hours(cfg, (10, 11, 12, 13), **kw)[:2] == [1, 1]
    assert ran == ["r", "r"]  # the cap: two Bedrock runs at this code sha
    assert _states(cfg, "r") == ["post_failed", "post_failed", "attempts_exhausted", "attempts_exhausted"]
    last = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
    assert last["attempts_exhausted"] == 1 and last["failed"] == 0


def test_a_raising_consult_over_three_hours_is_two_calls_then_exhausted_and_still_costs(tmp_path, bundle_env, monkeypatch, capsys):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    kw = dict(run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, sealed=["boom"], pending=lambda *_: [], day_read=lambda *_: ([], True))
    capsys.readouterr()
    _hours(cfg, (10, 11, 12), **kw)
    assert ran == ["boom", "boom"]
    assert _states(cfg, "boom") == ["failed:RuntimeError", "failed:RuntimeError", "attempts_exhausted"]
    outs = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    assert [o["failed"] for o in outs] == [1, 1, 0] and [o["attempts_exhausted"] for o in outs] == [0, 0, 1]


def test_a_new_code_sha_resets_the_attempt_count(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    sha = {"v": "sha-A"}
    monkeypatch.setattr(nightly, "current_code_sha", lambda: sha["v"])
    kw = dict(run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, sealed=["boom"], pending=lambda *_: [], day_read=lambda *_: ([], True))
    _hours(cfg, (10, 11, 12), **kw)
    assert ran == ["boom", "boom"]
    sha["v"] = "sha-B"
    _hours(cfg, (13, 14, 15), **kw)
    assert ran == ["boom"] * 4 and _states(cfg, "boom")[-1] == "attempts_exhausted"


def test_seed_lines_skip_and_never_count_as_attempts(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    _ledger(cfg, [("s", "written", "1", "seed"), ("s", "written", "1", "seed"), ("s", "written", "1", "seed")])
    assert nightly.count_attempts(cfg["out"], "sha-A") == {}
    assert _call(cfg, "2026-10-05", run_one, ["s", "n"], lambda *_: ([], True)) == 0
    assert ran == ["n"] and _states(cfg, "s")[-1] == "skipped_existing"


def test_the_cap_applies_to_a_pending_job_that_bypasses_skip_existing(tmp_path, bundle_env, monkeypatch, capsys):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    _ledger(cfg, [("w", "failed:RuntimeError", None, "sha-A"), ("w", "written", "9", "sha-A")])
    capsys.readouterr()
    assert run(cfg, "2026-10-05", run_one=run_one, post=lambda b: {"ok": True, "inserted": 1}, sealed=[],
               pending=lambda *_: [{"consult_uid": "w", "job_id": "job-1"}], skip_existing=True, day_read=lambda *_: []) == 0
    assert ran == []  # skip-existing would have been bypassed; the cap is not
    assert _lines(cfg)[-1]["state"] == "attempts_exhausted" and _lines(cfg)[-1]["job_id"] == "job-1" and _lines(cfg)[-1]["ist_date"] == "2026-10-05"
    assert json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])["attempts_exhausted"] == 1


def test_an_exhausted_uid_does_not_use_a_max_consults_slot(tmp_path, bundle_env, monkeypatch):
    ran, run_one = bundle_env
    cfg = _bcfg(tmp_path, max_consults=1)
    monkeypatch.setattr(nightly, "current_code_sha", lambda: "sha-A")
    _ledger(cfg, [("x", "rejected", "1", "sha-A"), ("x", "post_failed", None, "sha-A")])
    assert _call(cfg, "2026-10-05", run_one, ["x", "y"], lambda *_: ([], True)) == 0
    assert ran == ["y"]


def test_a_raise_reports_what_it_spent_and_an_unreadable_cost_is_counted(tmp_path):
    class Spent(RuntimeError):
        cost_usd = 0.25

    def run_one(uid):
        raise Spent("x") if uid == "a" else RuntimeError("y")

    s = nightly.execute([{"uid": "a"}, {"uid": "b"}], {"data": str(tmp_path), "out": str(tmp_path / "o"), "max_consults": 5}, dry_run=False,
                        run_one=run_one, post=lambda b: {"ok": True})
    assert s["failed"] == 2 and s["cost_usd"] == 0.25 and s["cost_unknown"] == 1


def test_the_bundle_runner_reads_a_raising_consults_cost_from_its_usage_lines(tmp_path):
    led = tmp_path / "usage.jsonl"
    led.write_text(json.dumps({"usd": 9.0}) + "\n")
    start = led.stat().st_size
    with open(led, "a") as f:
        f.write(json.dumps({"usd": 0.125}) + "\n" + json.dumps({"usd": 0.5}) + "\n")
    assert nightly._usd_between(led, start) == 0.625
    assert nightly._usd_between(led, led.stat().st_size) == 0.0
    with open(led, "a") as f:
        f.write("not json\n")
    assert nightly._usd_between(led, start) is None
