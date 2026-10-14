"""Lockbox rule, fail-closed tuning guard and eligibility. Synthetic uids only."""
from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from test_pdqi9_harness import CONSULTS, RX, make_frozen, responder
from test_pdqi9_harness import _argv as _harness_argv

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


IST = timezone(timedelta(hours=5, minutes=30))


GOOD_DAYS = {"2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"}


def ms(day, hour=11):
    y, m, d = map(int, day.split("-"))
    return int(datetime(y, m, d, hour, tzinfo=IST).timestamp() * 1000)


def _argv(tmp_path, arms, arts, fdir, out, extra=()):
    """The harness argv, with the consults folder this test built (clip dates matching the artifacts) when there is one."""
    a = _harness_argv(tmp_path, arms, arts, fdir, out, extra)
    c = tmp_path / "consults"
    if c.exists():
        a[a.index("--consults") + 1] = str(c)
    return a


def make_consults(tmp_path, clips):
    """Copy the synthetic consult fixtures; set each uid's clip.t0_ms (None removes it). Only uids in clips are copied."""
    for u, t0 in clips.items():
        if not (CONSULTS / u).is_dir():
            continue
        shutil.copytree(CONSULTS / u, tmp_path / "consults" / u)
        f = tmp_path / "consults" / u / "transcript.json"
        j = json.loads(f.read_text(encoding="utf-8"))
        if t0 is None:
            j["clip"].pop("t0_ms", None)
        else:
            j["clip"]["t0_ms"] = t0
        f.write_text(json.dumps(j), encoding="utf-8")


def setup(tmp_path, dates, clips=None):
    arts = tmp_path / "arts"
    arts.mkdir()
    for u, d in dates.items():
        enc = {"visit_date_ist": d} if d else {}
        (arts / f"{u}.json").write_text(json.dumps({"encounter": enc}), encoding="utf-8")
    make_consults(tmp_path, clips if clips is not None else {u: ms(d) for u, d in dates.items() if d in GOOD_DAYS})
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


def _b0(tmp_path, uid, enc):
    d = tmp_path / "arts" / "b0"
    d.mkdir(exist_ok=True)
    (d / f"{uid}.json").write_text(json.dumps({"encounter": enc}), encoding="utf-8")


def _run_with_b0(tmp_path, monkeypatch, capsys, b0_enc):
    monkeypatch.setenv(splits.RULE_ENV, str(rule(tmp_path)))
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    arts, arms, fdir = setup(tmp_path, {U1: "2026-10-12", U2: "2026-10-12"})
    if b0_enc is not None:
        _b0(tmp_path, U2, b0_enc)
    fc = FakeClient(responder)
    rc = run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc)
    return rc, fc, capsys.readouterr().out


def test_abort_when_bn_clean_but_b0_in_range(tmp_path, monkeypatch, capsys):
    rc, fc, out = _run_with_b0(tmp_path, monkeypatch, capsys, {"visit_date_ist": "2026-10-15"})
    assert rc != 0 and "n_hash=0 n_date=1" in out and U2 not in out
    assert_nothing_written(tmp_path, fc)


def test_abort_when_artifact_dates_differ(tmp_path, monkeypatch, capsys):
    rc, fc, out = _run_with_b0(tmp_path, monkeypatch, capsys, {"visit_date_ist": "2026-10-13"})
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=0 n_nodate=1" in out and U2 not in out
    assert_nothing_written(tmp_path, fc)


def test_abort_when_present_b0_has_no_date(tmp_path, monkeypatch, capsys):
    rc, fc, out = _run_with_b0(tmp_path, monkeypatch, capsys, {})
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=0 n_nodate=1" in out and U2 not in out
    assert_nothing_written(tmp_path, fc)


def test_b0_absent_and_matching_b0_pass(tmp_path, monkeypatch, capsys):
    rc, fc, out = _run_with_b0(tmp_path, monkeypatch, capsys, None)
    assert rc == 0 and fc.calls and "lockbox_guard" not in out
    t = tmp_path / "again"
    t.mkdir()
    rc, fc, out = _run_with_b0(t, monkeypatch, capsys, {"visit_date_ist": "2026-10-12"})
    assert rc == 0 and fc.calls


def test_guard_turns_recursion_and_unencodable_uid_into_clean_abort(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(splits.RULE_ENV, str(rule(tmp_path)))
    arts = tmp_path / "arts"
    arts.mkdir()
    (arts / "deep.json").write_text("[" * 100000 + "]" * 100000, encoding="utf-8")
    bad = "synth-\ud800"
    assert run.lockbox_guard(["deep", bad], arts, False) == 1
    out = capsys.readouterr().out
    assert out.strip() == "lockbox_guard: abort n_hash=1 n_date=0 n_nodate=2"


def test_rule_with_duplicate_keys_or_non_int_version_is_invalid(tmp_path):
    base = '"uid_sha256": [], "date_from": "2026-10-14", "date_to": "2026-10-16"'
    for name, text in {
        "dupe": '{"version": 1, "version": 1, ' + base + "}",
        "dupe_other": '{"version": 1, ' + base + ', "date_to": "2026-10-16"}',
        "float": '{"version": 1.0, ' + base + "}",
        "bool": '{"version": true, ' + base + "}",
        "deep": "[" * 100000,
    }.items():
        p = tmp_path / f"{name}.json"
        p.write_text(text, encoding="utf-8")
        with pytest.raises(splits.LockboxRuleError) as e:
            splits.LockboxRule.load(p)
        assert e.value.code == "rule_invalid", name


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


# ---- clip date of the consult input -----------------------------------------------------------------------------

def _consult_run(tmp_path, monkeypatch, capsys, art_day, clip):
    monkeypatch.setenv(splits.RULE_ENV, str(rule(tmp_path)))
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    arts, arms, fdir = setup(tmp_path, {U1: art_day}, clips={U1: clip})
    fc = FakeClient(responder)
    rc = run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc)
    return rc, fc, capsys.readouterr().out


def test_consult_clip_in_range_aborts_though_artifacts_say_earlier(tmp_path, monkeypatch, capsys):
    rc, fc, out = _consult_run(tmp_path, monkeypatch, capsys, "2026-10-12", ms("2026-10-15"))
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=1 n_nodate=1" in out and U1 not in out
    assert_nothing_written(tmp_path, fc)


def test_consult_clip_date_converted_to_ist(tmp_path, monkeypatch, capsys):
    # 13 Oct 20:00 UTC is 14 Oct 01:30 IST, which is in range; artifacts agreeing on 13 Oct are still wrong
    t = int(datetime(2026, 10, 13, 20, tzinfo=timezone.utc).timestamp() * 1000)
    rc, fc, out = _consult_run(tmp_path, monkeypatch, capsys, "2026-10-13", t)
    assert rc != 0 and "n_date=1" in out
    assert_nothing_written(tmp_path, fc)


def test_consult_clip_differing_from_artifacts_aborts(tmp_path, monkeypatch, capsys):
    rc, fc, out = _consult_run(tmp_path, monkeypatch, capsys, "2026-10-12", ms("2026-10-11"))
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=0 n_nodate=1" in out
    assert_nothing_written(tmp_path, fc)


@pytest.mark.parametrize("clip", [None, "x", 1.5, True, 10**30, -10**30, [1]])
def test_consult_clip_missing_or_invalid_aborts(tmp_path, monkeypatch, capsys, clip):
    rc, fc, out = _consult_run(tmp_path, monkeypatch, capsys, "2026-10-12", clip)
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=0 n_nodate=1" in out
    assert_nothing_written(tmp_path, fc)


def test_consult_transcript_missing_or_unreadable_aborts(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(splits.RULE_ENV, str(rule(tmp_path)))
    arts, _, _ = setup(tmp_path, {U1: "2026-10-12"})
    t = tmp_path / "consults" / U1 / "transcript.json"
    t.write_text("{", encoding="utf-8")
    assert run.lockbox_guard([U1], arts, False, str(tmp_path / "consults")) == 1
    t.unlink()
    assert run.lockbox_guard([U1], arts, False, str(tmp_path / "consults")) == 1
    assert capsys.readouterr().out.count("n_nodate=1") == 2


def test_consult_clip_matching_artifact_date_passes(tmp_path, monkeypatch, capsys):
    rc, fc, out = _consult_run(tmp_path, monkeypatch, capsys, "2026-10-12", ms("2026-10-12"))
    assert rc == 0 and fc.calls and "lockbox_guard" not in out


def _bundle_run(tmp_path, monkeypatch, capsys, art_day, bundle):
    from tools.eta2freescript import ingest
    monkeypatch.setenv(splits.RULE_ENV, str(rule(tmp_path)))
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    arts, arms, fdir = setup(tmp_path, {U1: art_day})
    b = tmp_path / "bundles"
    b.mkdir()
    if bundle is not None:
        (b / f"{U1}.json").write_text(json.dumps(bundle), encoding="utf-8")
    monkeypatch.setattr(ingest, "load_bundle", lambda x, english="auto", use_role_track=True: ingest.load_consult(CONSULTS, U1), raising=False)
    argv = _harness_argv(tmp_path, arms, arts, fdir, tmp_path / "out")
    i = argv.index("--consults")
    argv[i:i + 2] = ["--bundles", str(b)]
    fc = FakeClient(responder)
    rc = run.main(argv, client=fc)
    return rc, fc, capsys.readouterr().out


def manifest(day):
    return {"manifest": {"t0_ms": ms(day), "t1_ms": ms(day) + 60000}}


def test_bundle_clip_in_range_aborts_though_artifacts_say_earlier(tmp_path, monkeypatch, capsys):
    rc, fc, out = _bundle_run(tmp_path, monkeypatch, capsys, "2026-10-12", manifest("2026-10-15"))
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=1 n_nodate=1" in out and U1 not in out
    assert_nothing_written(tmp_path, fc)


def test_bundle_cutter_span_in_range_aborts(tmp_path, monkeypatch, capsys):
    b = {"source": "cutter", "cutter_row": {"span_start": "2026-10-15 11:00:00", "span_end": "2026-10-15 11:05:00"}}
    rc, fc, out = _bundle_run(tmp_path, monkeypatch, capsys, "2026-10-12", b)
    assert rc != 0 and "n_date=1" in out
    assert_nothing_written(tmp_path, fc)


@pytest.mark.parametrize("bundle", [None, {}, {"manifest": {}}, {"manifest": {"t0_ms": "x", "t1_ms": 1}}, {"manifest": {"t0_ms": ms("2026-10-12")}},
                                    {"source": "cutter"}, {"source": "cutter", "cutter_row": {"span_start": "bad", "span_end": "bad"}}])
def test_bundle_clip_missing_or_invalid_aborts(tmp_path, monkeypatch, capsys, bundle):
    rc, fc, out = _bundle_run(tmp_path, monkeypatch, capsys, "2026-10-12", bundle)
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=0 n_nodate=1" in out
    assert_nothing_written(tmp_path, fc)


def test_bundle_clip_differing_from_artifacts_aborts(tmp_path, monkeypatch, capsys):
    rc, fc, out = _bundle_run(tmp_path, monkeypatch, capsys, "2026-10-12", manifest("2026-10-11"))
    assert rc != 0 and "lockbox_guard: abort n_hash=0 n_date=0 n_nodate=1" in out
    assert_nothing_written(tmp_path, fc)


def test_bundle_clip_matching_artifact_date_passes(tmp_path, monkeypatch, capsys):
    rc, fc, out = _bundle_run(tmp_path, monkeypatch, capsys, "2026-10-12", manifest("2026-10-12"))
    assert rc == 0 and fc.calls and "lockbox_guard" not in out


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
