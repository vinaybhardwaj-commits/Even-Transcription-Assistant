"""Arch #91 PR-B: speech gate (on in the CLI) and doctor gate (off by default) before any paid Sarvam job."""
import json
import os

from kit.reb import sarvam_lane as sl
from .test_sarvam_lane import Env, FakeGW, make_row, tdir


def set_turns(env, row, turns, split_failed=None):
    p = os.path.join(env.clips, row["path"], "timeline.json")
    tl = json.load(open(p))
    tl["turns"] = turns
    if split_failed is not None:
        tl["doctor_split_failed"] = split_failed
    json.dump(tl, open(p, "w"))


def T(a, b, s="doctor"):
    return {"start_s": a, "end_s": b, "speaker": s}


def test_consult_speech_s_union_and_unknown():
    assert sl.consult_speech_s({"turns": [T(0, 10), T(5, 15), T(20, 22, "S1")]}) == 17.0
    assert sl.consult_speech_s({}) is None and sl.consult_speech_s({"turns": [], "doctor_split_failed": True}) is None
    assert sl.consult_speech_s({"turns": []}) == 0.0


def test_gate_reason_rules():
    row = make_row()
    quiet = {"turns": [T(0, 5)]}
    assert sl.gate_reason(row, quiet, None) is None                                   # no gate (library default): old behaviour
    assert sl.gate_reason(row, quiet, {"speech": True}) == "skipped_no_speech"
    assert sl.gate_reason(row, {"turns": [T(0, 10)]}, {"speech": True}) is None         # exactly SPEECH_MIN_S passes
    assert sl.gate_reason(row, {}, {"speech": True}) is None                             # speech unknown: send
    row2 = dict(row, doctor_identified=False)
    assert sl.gate_reason(row2, {"turns": [T(0, 60)]}, {"speech": True}) is None         # doctor gate off by default
    assert sl.gate_reason(row2, {"turns": [T(0, 60)]}, {"speech": True, "doctor": True}) == "skipped_doctor_unconfirmed"


def test_quiet_clip_is_not_sent_and_nothing_written(tmp_path):
    row = make_row()
    env = Env(tmp_path, [row])
    set_turns(env, row, [T(0, 3), T(4, 6, "S1")])
    gw = FakeGW()
    cnt = env.run(gw, date=row["ist_date"], speech_gate=True)
    assert cnt["skipped_no_speech"] == 1 and gw.calls == [] and cnt["written"] == 0
    assert not os.path.exists(tdir(env))
    cnt = env.run(gw, date=row["ist_date"])                                             # gate off: sent as before
    assert gw.calls and cnt["skipped_no_speech"] == 0


def test_failed_split_is_sent_even_with_no_turns(tmp_path):
    row = make_row()
    env = Env(tmp_path, [row])
    set_turns(env, row, [], split_failed=True)
    gw = FakeGW()
    env.run(gw, date=row["ist_date"], speech_gate=True)
    assert gw.calls


def test_require_doctor_gate(tmp_path):
    row = make_row(); row["doctor_identified"] = False
    env = Env(tmp_path, [row])
    set_turns(env, row, [T(0, 60)])
    gw = FakeGW()
    cnt = env.run(gw, date=row["ist_date"], speech_gate=True, require_doctor=True)
    assert cnt["skipped_doctor_unconfirmed"] == 1 and gw.calls == []
    env.run(gw, date=row["ist_date"], speech_gate=True)
    assert gw.calls


def test_cli_defaults(monkeypatch):
    seen = {}
    monkeypatch.setattr(sl, "run", lambda a, **k: seen.setdefault("a", a))
    monkeypatch.setattr(sl, "Gateway", lambda: None)
    sl.main(["--since", "2026-10-02", "--dry-run"])
    assert seen["a"].speech_gate is True and seen["a"].require_doctor is False
    seen.clear()
    sl.main(["--since", "2026-10-02", "--dry-run", "--no-speech-gate", "--require-doctor"])
    assert seen["a"].speech_gate is False and seen["a"].require_doctor is True
