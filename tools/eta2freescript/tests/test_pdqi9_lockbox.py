"""Lockbox rule, fail-closed tuning guard and eligibility. Synthetic uids only."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from test_pdqi9_harness import RX, _argv, make_frozen, responder

from tools.eta2freescript.eval.pdqi9 import eligibility, run, splits
from tools.eta2freescript.models import FakeClient

U1, U2 = "synth-fever-dose", "synth-cough-native"


def sha(u):
    return hashlib.sha256(u.encode("utf-8")).hexdigest()


def rule(tmp_path, **kw):
    d = {"version": 1, "uid_sha256": [], "date_from": "2026-10-14", "date_to": "2026-10-16", **kw}
    p = tmp_path / "rule.json"
    p.write_text(json.dumps(d), encoding="utf-8")
    return p


def setup(tmp_path, dates):
    arts = tmp_path / "arts"
    arts.mkdir()
    for u, d in dates.items():
        enc = {"visit_date_ist": d} if d else {}
        (arts / f"{u}.json").write_text(json.dumps({"encounter": enc}), encoding="utf-8")
    arm = tmp_path / "arm.jsonl"
    arm.write_text("\n".join(json.dumps({"uid": u, "prescription": RX}) for u in dates) + "\n", encoding="utf-8")
    return arts, ",".join([str(arm)] * 3), make_frozen(tmp_path / "frozen")


def go(tmp_path, dates, monkeypatch, rule_path, capsys):
    if rule_path is None:
        monkeypatch.delenv(splits.RULE_ENV, raising=False)
    else:
        monkeypatch.setenv(splits.RULE_ENV, str(rule_path))
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    arts, arms, fdir = setup(tmp_path, dates)
    fc = FakeClient(responder)
    rc = run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc)
    assert len(fc.calls) == 0 or rc == 0
    return rc, fc, capsys.readouterr().out


def assert_nothing_written(tmp_path, fc):
    assert not fc.calls
    assert not (tmp_path / "out").exists()
    assert not (tmp_path / "SCOREBOARD.md").exists() and not list(tmp_path.glob("SCOREBOARD*"))


def test_clean_tuning_set_passes(tmp_path, monkeypatch, capsys):
    rc, fc, out = go(tmp_path, {U1: "2026-10-12", U2: "2026-10-13"}, monkeypatch, rule(tmp_path, uid_sha256=[sha("other")]), capsys)
    assert rc == 0 and fc.calls and "lockbox_guard" not in out


def test_abort_on_hash_hit(tmp_path, monkeypatch, capsys):
    rc, fc, out = go(tmp_path, {U1: "2026-10-12", U2: "2026-10-13"}, monkeypatch, rule(tmp_path, uid_sha256=[sha(U2)]), capsys)
    assert rc != 0 and "lockbox_guard: abort n_hash=1 n_date=0 n_nodate=0" in out
    assert U1 not in out and U2 not in out
    assert_nothing_written(tmp_path, fc)


def test_abort_on_date_in_range_inclusive(tmp_path, monkeypatch, capsys):
    for d in ("2026-10-14", "2026-10-16"):
        t = tmp_path / d
        t.mkdir()
        rc, fc, out = go(t, {U1: "2026-10-12", U2: d}, monkeypatch, rule(t), capsys)
        assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=1 n_nodate=0" in out and U2 not in out
        assert_nothing_written(t, fc)


@pytest.mark.parametrize("bad", [None, "2026-13-45", "yesterday"])
def test_abort_on_missing_or_bad_date(tmp_path, monkeypatch, capsys, bad):
    rc, fc, out = go(tmp_path, {U1: "2026-10-12", U2: bad}, monkeypatch, rule(tmp_path), capsys)
    assert rc != 0 and "n_nodate=1" in out and U2 not in out
    assert_nothing_written(tmp_path, fc)


def test_abort_on_uid_with_no_artifact(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(splits.RULE_ENV, str(rule(tmp_path)))
    arts, arms, fdir = setup(tmp_path, {U1: "2026-10-12", U2: "2026-10-12"})
    (arts / f"{U2}.json").unlink()
    fc = FakeClient(responder)
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc) != 0
    assert "n_nodate=1" in capsys.readouterr().out
    assert_nothing_written(tmp_path, fc)


def _bad_rules(tmp_path):
    ok = {"version": 1, "uid_sha256": [], "date_from": "2026-10-14", "date_to": "2026-10-16"}
    cases = {
        "missing_key": {k: v for k, v in ok.items() if k != "date_to"},
        "extra_key": {**ok, "x": 1},
        "bad_version": {**ok, "version": 2},
        "upper_hex": {**ok, "uid_sha256": [sha("a").upper()]},
        "short_hex": {**ok, "uid_sha256": ["ab"]},
        "not_list": {**ok, "uid_sha256": sha("a")},
        "bad_date": {**ok, "date_from": "2026-02-30"},
        "date_format": {**ok, "date_from": "2026-1-4"},
        "reversed": {**ok, "date_from": "2026-10-17"},
        "not_dict": [1],
    }
    paths = {}
    for k, v in cases.items():
        p = tmp_path / f"{k}.json"
        p.write_text(json.dumps(v), encoding="utf-8")
        paths[k] = p
    (tmp_path / "junk.json").write_text("{nope", encoding="utf-8")
    paths["junk"] = tmp_path / "junk.json"
    paths["absent"] = tmp_path / "absent.json"
    paths["directory"] = tmp_path
    return paths


@pytest.mark.parametrize("name", ["missing_key", "extra_key", "bad_version", "upper_hex", "short_hex", "not_list", "bad_date", "date_format",
                                  "reversed", "not_dict", "junk", "absent", "directory", "unset"])
def test_abort_on_missing_invalid_or_unreadable_rule(tmp_path, monkeypatch, capsys, name):
    rules = tmp_path / "rules"
    rules.mkdir()
    p = None if name == "unset" else _bad_rules(rules)[name]
    work = tmp_path / "work"
    work.mkdir()
    rc, fc, out = go(work, {U1: "2026-10-12"}, monkeypatch, p, capsys)
    assert rc != 0 and out.startswith("lockbox_guard: abort rule_")
    assert_nothing_written(work, fc)


def test_lockbox_candidate_run_skips_the_date_guard_but_needs_a_valid_rule(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    monkeypatch.setenv(splits.LEDGER_ENV, str(tmp_path / "led.jsonl"))
    monkeypatch.setenv(splits.RULE_ENV, str(rule(tmp_path, uid_sha256=[sha("synth-boundary-knee")])))
    arts, arms, fdir = setup(tmp_path, {"synth-boundary-knee": "2026-10-15"})
    fc = FakeClient(responder)
    argv = _argv(tmp_path, arms, arts, fdir, tmp_path / "out", ["--lockbox", "--candidate", "c1"])
    assert run.main(argv, client=fc) == 0 and fc.calls
    monkeypatch.delenv(splits.RULE_ENV)
    fc2 = FakeClient(responder)
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out2", ["--lockbox", "--candidate", "c2"]), client=fc2) != 0
    assert not fc2.calls and len((tmp_path / "led.jsonl").read_text().splitlines()) == 1


# ---- eligibility ------------------------------------------------------------------------------------------------

def row(**kw):
    return {"consult_uid": "synth-1", "ist_date": "2026-10-15", "has_text_layer": True, "has_role_layer": True, "transcript_seconds": 120,
            "rx_signed": True, "doctor_is_test": False, "artifact_written": True, "artifact_final_valid": True, **kw}


@pytest.mark.parametrize("kw,code", [
    ({}, "ok"), ({"has_text_layer": False}, "no_text"), ({"has_role_layer": False}, "no_role"), ({"transcript_seconds": 119.9}, "short_clip"),
    ({"rx_signed": False}, "no_signed_rx"), ({"doctor_is_test": True}, "test_doctor"), ({"artifact_written": False}, "no_artifact"),
    ({"artifact_final_valid": False}, "ok"), ({"transcript_seconds": 120}, "ok"),
    ({"has_text_layer": False, "has_role_layer": False, "rx_signed": False}, "no_text"),
])
def test_eligible_reason_codes(kw, code):
    assert eligibility.eligible(row(**kw)) == (code == "ok", code)


@pytest.mark.parametrize("bad", [{"has_text_layer": 1}, {"rx_signed": None}, {"transcript_seconds": "200"}, {"transcript_seconds": True},
                                 {"ist_date": "15-10-2026"}, {"consult_uid": ""}, {"artifact_final_valid": "yes"}])
def test_ill_typed_field_raises(bad):
    with pytest.raises((ValueError, TypeError)):
        eligibility.eligible(row(**bad))


@pytest.mark.parametrize("field", list(row()))
def test_missing_field_raises(field):
    r = row()
    del r[field]
    with pytest.raises((ValueError, TypeError)):
        eligibility.eligible(r)


def test_select_is_deterministic_sorted_and_date_bounded():
    rows = [row(consult_uid="c", ist_date="2026-10-16"), row(consult_uid="a", ist_date="2026-10-14"), row(consult_uid="b", ist_date="2026-10-15"),
            row(consult_uid="early", ist_date="2026-10-13"), row(consult_uid="late", ist_date="2026-10-17"),
            row(consult_uid="x", ist_date="2026-10-15", rx_signed=False), row(consult_uid="a", ist_date="2026-10-14")]
    assert eligibility.select(rows, "2026-10-14", "2026-10-16") == ["a", "b", "c"]
    assert eligibility.select(list(reversed(rows)), "2026-10-14", "2026-10-16") == ["a", "b", "c"]
    assert eligibility.select([], "2026-10-14", "2026-10-16") == []
    with pytest.raises(ValueError):
        eligibility.select([{"consult_uid": "z"}], "2026-10-14", "2026-10-16")
