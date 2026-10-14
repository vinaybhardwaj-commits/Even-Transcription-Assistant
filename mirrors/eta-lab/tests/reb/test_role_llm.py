"""role.llm-roles v1 (Arch #91): pure parts, guards, no text in tracks, idempotence, dry run makes no call, budget stop, flags."""
import json
import os
import types

import pytest

from kit.reb import role_llm as rl
from kit.reb.from_hist import GuardUnavailable
from .test_sarvam_lane import DATE, SPAN_START_MS, UID, Env, FakeGW, make_row, tdir

ENTRIES = [{"speaker_id": "0", "start": 0.0, "end": 60.0, "transcript": "synthetic doctor words"},
           {"speaker_id": "1", "start": 60.0, "end": 100.0, "transcript": "synthetic patient words"},
           {"speaker_id": "2", "start": 100.0, "end": 105.0, "transcript": "synthetic family words"}]


class FakeClient:
    def __init__(self, resp=None, exc=None):
        self.calls, self.resp, self.exc = [], resp, exc

    def role(self, lines, hints):
        self.calls.append((lines, hints))
        if self.exc:
            raise self.exc
        return self.resp if self.resp is not None else {"map": {"0": "D", "1": "P", "2": "A"}, "fix": [[2, "S"]], "attender_present": True,
                                                        "model_id": "sonnet-test", "usage": {"in_tok": 100, "out_tok": 10}, "cost_usd": 0.00045, "cache_hit": False}


def set_timeline(env, row, turns=None, identified=True):
    p = os.path.join(env.clips, row["path"], "timeline.json")
    tl = json.load(open(p))
    tl["doctor_identified"] = identified
    tl["turns"] = turns if turns is not None else [{"start_s": 0.0, "end_s": 50.0, "speaker": "doctor"}, {"start_s": 60.0, "end_s": 100.0, "speaker": "S1"}]
    json.dump(tl, open(p, "w"))


def env_with_sarvam(tmp, row=None):
    row = row or make_row()
    env = Env(tmp, [row])
    env.run(FakeGW(entries=ENTRIES), date=row["ist_date"])
    set_timeline(env, row, identified=bool(row.get("doctor_identified")))
    return env, row


def go(env, client, write=True, held=lambda d, r: False, **kw):
    a = types.SimpleNamespace(**{"consult": None, "date": None, "since": DATE, "write": write, "min_minutes": 0, "identified": False,
                                 "consult_list": None, "require_doctor": False, "limit": 0, **kw})
    return rl.run(a, client=client, root=env.root, is_held=held, index_path=env.index, clips_root=env.clips)


def role_tracks(env):
    return [json.load(open(os.path.join(tdir(env), n))) for n in os.listdir(tdir(env)) if n.startswith("role.llm-roles")]


def test_request_lines_hints_and_text_cap():
    stt = {"segments": [{"t0_ms": SPAN_START_MS + 1000, "t1_ms": SPAN_START_MS + 61000, "speaker": "0", "text": "x" * 500},
                        {"t0_ms": SPAN_START_MS + 61000, "t1_ms": SPAN_START_MS + 70000, "speaker": "1", "text": " hi "}]}
    diar = {"segments": [{"t0_ms": s["t0_ms"], "t1_ms": s["t1_ms"], "speaker": s["speaker"]} for s in stt["segments"]]}
    tl = {"turns": [{"start_s": 1.0, "end_s": 31.0, "speaker": "doctor"}]}
    lines, hints = rl.build_request(stt, diar, tl, SPAN_START_MS)
    assert lines == [[1.0, "0", "x" * 300], [61.0, "1", "hi"]]
    assert hints["0"]["talk_s"] == 60.0 and hints["0"]["doc_share"] == 0.5 and hints["1"]["doc_share"] == 0.0


def test_check_response_rejects_junk_and_bounds_fixes():
    for bad in (None, {}, {"map": []}, {"map": {"0": "X"}}):
        with pytest.raises(ValueError):
            rl.check_response(bad)
    mp, fx, att = rl.check_response({"map": {"0": "D", 1: "P", "2": "Z"}, "fix": [[0, "A"], ["x", "P"], [1, "Q"], [2]] + [[3, "S"]] * 50})
    assert mp == {"0": "D", "1": "P"} and fx[0] == (0, "A") and len(fx) <= 40 and att is None


def test_apply_roles_map_then_fixes_on_text_lines_only():
    segs = [{"speaker": "0", "text": "a"}, {"speaker": "1", "text": ""}, {"speaker": "9", "text": "c"}]
    assert rl.apply_roles(segs, {"0": "D", "1": "P"}, [(1, "A"), (0, "S"), (7, "P")]) == ["staff", "patient", "unknown"]


def test_two_consults_flag():
    one = {"turns": [{"start_s": 0, "end_s": 100, "speaker": "doctor"}, {"start_s": 10, "end_s": 50, "speaker": "S1"},
                     {"start_s": 300, "end_s": 400, "speaker": "doctor"}, {"start_s": 310, "end_s": 350, "speaker": "S1"}]}
    assert rl.two_consults(one)["flag"] is False                      # same visitor after the gap: one consult with a pause
    two = {"turns": [{"start_s": 0, "end_s": 100, "speaker": "doctor"}, {"start_s": 10, "end_s": 50, "speaker": "S1"},
                     {"start_s": 300, "end_s": 400, "speaker": "doctor"}, {"start_s": 310, "end_s": 350, "speaker": "S2"}]}
    r = rl.two_consults(two)
    assert r["flag"] is True and r["gap_at_s"] == 200.0
    short = {"turns": [{"start_s": 0, "end_s": 30, "speaker": "doctor"}, {"start_s": 5, "end_s": 20, "speaker": "S1"},
                       {"start_s": 300, "end_s": 400, "speaker": "doctor"}, {"start_s": 310, "end_s": 350, "speaker": "S2"}]}
    assert rl.two_consults(short)["flag"] is False                    # < 60 s of doctor before the gap


def test_diar_coverage():
    tl = {"turns": [{"start_s": 0, "end_s": 100, "speaker": "doctor"}]}
    d = {"segments": [{"t0_ms": SPAN_START_MS, "t1_ms": SPAN_START_MS + 50000, "speaker": "0"}]}
    assert rl.diar_coverage(d, tl, SPAN_START_MS) == 0.5 and rl.diar_coverage(d, {"turns": []}, SPAN_START_MS) is None


def test_track_roles_and_no_text(tmp_path):
    env, row = env_with_sarvam(tmp_path)
    before = sorted(os.listdir(tdir(env)))
    c = FakeClient()
    cnt = go(env, c)
    assert cnt["written"] == 1 and cnt["calls"] == 1 and cnt["clips_attender"] == 1 and cnt["roles_doctor"] == 1 and cnt["roles_attender"] == 1
    lines, hints = c.calls[0]
    assert [l[2] for l in lines] == ["synthetic doctor words", "synthetic patient words", "synthetic family words"]
    assert hints["0"]["doc_share"] == round(50 / 60, 4)
    [t] = role_tracks(env)
    assert (t["layer"], t["engine"], t["version"], t["status"], t["window_id"]) == ("role", "llm-roles", "v1", "ok", "consult-" + UID)
    assert [(s["speaker"], s["role"]) for s in t["segments"]] == [("0", "doctor"), ("1", "patient"), ("2", "staff")]   # fix on line 2
    assert set(t["segments"][0]) == {"t0_ms", "t1_ms", "speaker", "role"} and t["segments"][0]["t0_ms"] == SPAN_START_MS
    assert "synthetic" not in json.dumps(t)                                         # no transcript text anywhere in the track
    assert t["extras"]["map"] == {"0": "doctor", "1": "patient", "2": "attender"} and t["extras"]["n_fix"] == 1
    assert t["config"]["rule"]["prompt_sha256"] == rl.PROMPT_SHA and t["extras"]["diar_partial"] is False
    assert sorted(set(os.listdir(tdir(env))) - set(before)) == [n for n in os.listdir(tdir(env)) if n.startswith("role.")]


def test_idempotent_and_new_timeline_new_track(tmp_path):
    env, row = env_with_sarvam(tmp_path)
    c = FakeClient()
    go(env, c)
    cnt = go(env, c)
    assert cnt["skipped_existing"] == 1 and cnt["calls"] == 0 and len(c.calls) == 1
    set_timeline(env, row, turns=[{"start_s": 0.0, "end_s": 55.0, "speaker": "doctor"}])
    assert go(env, c)["written"] == 1 and len(role_tracks(env)) == 2


def test_dry_run_makes_no_call_and_writes_nothing(tmp_path):
    env, row = env_with_sarvam(tmp_path)
    before = sorted(os.listdir(tdir(env)))
    c = FakeClient()
    cnt = go(env, c, write=False)
    assert cnt["would_write"] == 1 and c.calls == [] and sorted(os.listdir(tdir(env))) == before


def test_require_doctor_flag_default_off(tmp_path):
    row = make_row(); row["doctor_identified"] = False
    env, row = env_with_sarvam(tmp_path, row)
    c = FakeClient()
    assert go(env, c, require_doctor=True)["skipped_doctor_unconfirmed"] == 1 and c.calls == []
    assert go(env, c)["written"] == 1                                              # default: unconfirmed doctor still gets roles


def test_budget_stop_and_service_error_write_nothing(tmp_path):
    env, row = env_with_sarvam(tmp_path)
    cnt = go(env, FakeClient(exc=rl.BudgetExhausted("x")))
    assert cnt["budget_stopped"] == 1 and cnt["written"] == 0 and not role_tracks(env)
    cnt = go(env, FakeClient(exc=rl.ServiceError("http_502")))
    assert cnt["service_errors"] == 1 and cnt["written"] == 0 and not role_tracks(env)


def test_bad_response_writes_nothing(tmp_path):
    env, row = env_with_sarvam(tmp_path)
    cnt = go(env, FakeClient(resp={"map": {"0": "nonsense"}}))
    assert cnt["bad_response"] == 1 and cnt["written"] == 0 and not role_tracks(env)


def test_limit_caps_calls(tmp_path):
    env, row = env_with_sarvam(tmp_path)
    c = FakeClient()
    a = types.SimpleNamespace(consult=None, date=None, since=DATE, write=True, min_minutes=0, identified=False, consult_list=None, require_doctor=False, limit=1)
    cnt = {k: 0 for k in rl.COUNTERS}; cnt["calls"] = 1
    import collections
    cnt = collections.Counter(cnt)
    rl.process(row, env.root, lambda d, r: False, True, cnt, c, a, env.clips)
    assert cnt["limit_reached"] == 1 and c.calls == []


def test_guards_blind_signature_and_no_sarvam(tmp_path):
    env, row = env_with_sarvam(tmp_path)
    c = FakeClient()
    assert go(env, c, held=lambda d, r: True)["blind_refused"] == 1 and c.calls == []
    recut = dict(row, signature=[1.0, "url_clear", "DOC1"])
    with open(env.index, "a") as f:
        f.write(json.dumps(recut) + "\n")
    assert go(env, c)["signature_mismatch"] == 1 and c.calls == []
    env2 = Env(tmp_path / "b", [make_row()])
    assert go(env2, c)["no_sarvam"] == 1


def test_guard_unavailable_is_fatal(tmp_path, monkeypatch):
    env, row = env_with_sarvam(tmp_path)

    def boom():
        raise GuardUnavailable("no guard")
    monkeypatch.setattr(rl, "load_heldout", boom)
    a = types.SimpleNamespace(consult=None, date=None, since=DATE, write=True, min_minutes=0, identified=False, consult_list=None, require_doctor=False, limit=0)
    with pytest.raises(GuardUnavailable):
        rl.run(a, client=FakeClient(), root=env.root, index_path=env.index, clips_root=env.clips)


def test_readers_see_the_role_track(tmp_path):
    from kit.reb import consult
    env, row = env_with_sarvam(tmp_path)
    go(env, FakeClient())
    got = consult(UID, root=env.root).tracks(layer="role")
    assert [g.engine for g in got] == ["llm-roles"] and got[0].status == "ok"


def test_http_client_maps_429_to_budget(monkeypatch):
    import urllib.error
    import urllib.request

    def fake(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 429, "x", {}, None)
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    with pytest.raises(rl.BudgetExhausted):
        rl.HttpClient("http://127.0.0.1:9/role").role([[0, "0", "t"]], {})
