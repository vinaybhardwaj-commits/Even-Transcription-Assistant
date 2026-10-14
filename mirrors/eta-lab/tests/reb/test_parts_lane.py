import json
import os
import types

import numpy as np
import pytest

from kit.reb import parts_lane as pl
from kit.reb import parts_tag as pt
from kit.reb import sarvam_lane as sl
from kit.reb import writer
from .test_sarvam_lane import DATE, UID, Env, FakeGW, make_row, tdir

TEXTS = ["So what is the problem? How long has the fever been there?", "I have fever since two days and my knee pain is bad", "Take this tablet twice daily and come back after five days"]
ENTRIES = [{"speaker_id": "0", "start": 1.5, "end": 30.0, "transcript": TEXTS[0]},
           {"speaker_id": "1", "start": 31.0, "end": 60.0, "transcript": TEXTS[1]},
           {"speaker_id": "0", "start": 65.0, "end": 95.0, "transcript": TEXTS[2]}]
CONF = {"history": "high", "exam": "low", "order": "high", "medicine": "high", "followup": "low", "advice": "high"}


def write_config(path, conf=CONF, version="t1", tc=0.5, tj=0.5):
    parts = {p: {"rule": {"type": "or", "tc": tc, "tj": tj}, "tj_only": 0.4, "confidence": c} for p, c in conf.items()}
    path.write_text(json.dumps({"version": version, "parts": parts}))
    return str(path)


class Clef:
    def __init__(self, fail=False):
        self.calls, self.fail = 0, fail

    def __call__(self, wav):
        self.calls += 1
        if self.fail:
            raise RuntimeError("clef down")
        return {p: (0.9 if p == "history" else 0.0) for p in CONF}


class Jev:
    def __init__(self, fail=False):
        self.calls, self.states, self.fail = 0, [], fail

    def __call__(self, prev, cur):
        self.calls += 1
        self.states.append((prev, cur))
        if self.fail:
            raise RuntimeError("jev down")
        return {p: (0.9 if p in ("history", "medicine") else 0.0) for p in CONF}


@pytest.fixture(autouse=True)
def fake_audio(monkeypatch):
    monkeypatch.setattr(pt, "_decode", lambda path: np.zeros(16000 * 300, dtype=np.int16))   # the 5-minute fixture clip
    saved = pt.CONFIG
    yield
    pt.CONFIG = saved


def make(tmp, rows=None, entries=ENTRIES, with_stt=True):
    rows = rows or [make_row()]
    env = Env(tmp, rows)
    if with_stt:
        for r in rows:
            env.run(FakeGW(entries=entries), date=r["ist_date"])
    return env, rows


def ctx_for(tmp, conf=CONF, clef=None, jev=None, cap=5.0, usd=0.0012, version="t1", name="parts_config.json", spend_dir=None, preflight=lambda: True):
    cfg_path = write_config(tmp / name, conf, version)
    cfg, sha, ver = pl.load_config(cfg_path)
    spend = pl.Spend(str(spend_dir or tmp / "spend"), cap=cap)
    return pl.Ctx(cfg, sha, ver, spend, clef_fn=clef or Clef(), jev_fn=jev or Jev(), jev_model="fake-jev", usd_per_call=usd, preflight=preflight), sha


def go(env, ctx, write=True, held=lambda d, r: False, limit=0, since=DATE):
    a = types.SimpleNamespace(consult=None, date=None, since=since, write=write, limit=limit, min_minutes=0, identified=False)
    return pl.run(a, root=env.root, is_held=held, ctx=ctx, index_path=env.index, clips_root=env.clips)


def the_tracks(env, date=DATE, uid=UID):
    d = tdir(env, uid=uid, date=date)
    return [json.load(open(os.path.join(d, n))) for n in sorted(os.listdir(d)) if n.startswith("parts.clef-jev")]


# ---------------------------------------------------------------- pins and config
def test_vendored_tagger_is_the_pinned_file(monkeypatch):
    assert pl.verify_vendored() == pl.PARTS_TAG_SHA256 and pl.PARTS_TAG_SHA256.startswith("af1a3bcd0d4dd615")
    monkeypatch.setattr(pl, "PARTS_TAG_SHA256", "0" * 64)
    with pytest.raises(pl.ConfigError):
        pl.verify_vendored()


def test_config_fails_closed(tmp_path):
    with pytest.raises(pl.ConfigError):
        pl.load_config(str(tmp_path / "nope.json"))
    (tmp_path / "bad.json").write_text("{not json")
    with pytest.raises(pl.ConfigError):
        pl.load_config(str(tmp_path / "bad.json"))
    with pytest.raises(pl.ConfigError):   # a part is missing: the tagger would silently use its built-in rule for it
        pl.load_config(write_config(tmp_path / "short.json", {k: v for k, v in CONF.items() if k != "exam"}))
    with pytest.raises(pl.ConfigError):   # confidence must be high | low, from the file
        pl.load_config(write_config(tmp_path / "conf.json", {**CONF, "exam": "medium"}))
    with pytest.raises(pl.ConfigError):
        pl.load_config(write_config(tmp_path / "noconf.json", {**CONF, "exam": None}))


def test_load_config_installs_the_tagger_config_and_returns_the_sha(tmp_path):
    import hashlib
    p = write_config(tmp_path / "c.json")
    cfg, sha, ver = pl.load_config(p)
    assert sha == hashlib.sha256(open(p, "rb").read()).hexdigest() and ver == "t1"
    assert pt.CONFIG is cfg and set(pt.CONFIG) == set(pt.RULES)   # never the built-in fallback


def test_run_without_a_config_never_reads_a_clip(tmp_path):
    env, _ = make(tmp_path)
    a = types.SimpleNamespace(consult=None, date=None, since=DATE, write=True, limit=0, min_minutes=0, identified=False, config=str(tmp_path / "missing.json"))
    with pytest.raises(pl.ConfigError):
        pl.run(a, root=env.root, is_held=lambda d, r: False, index_path=env.index, clips_root=env.clips)


# ---------------------------------------------------------------- the track
def test_track_shape_and_no_text(tmp_path):
    env, _ = make(tmp_path)
    ctx, sha = ctx_for(tmp_path)
    cnt = go(env, ctx)
    assert cnt["written"] == 1 and cnt["errors"] == 0 and cnt["clef_calls"] == 10 and cnt["jev_calls"] == 3
    (t,) = the_tracks(env)
    assert (t["layer"], t["engine"], t["version"]) == ("parts", "clef-jev", "v0-provisional") and t["status"] == "ok"
    assert t["window_id"] == "consult-" + UID
    for s in t["segments"]:
        assert set(s) == {"t0_ms", "t1_ms", "part", "score", "source", "confidence"}
        assert s["part"] in CONF and s["confidence"] == CONF[s["part"]] and s["source"] in ("clef", "jev", "clef+jev") and 0 <= s["score"] <= 1
        assert s["t1_ms"] - s["t0_ms"] == 30000
    assert {s["part"] for s in t["segments"]} == {"history", "medicine"}
    base = sl._ist_ms(make_row()["span_start"])
    assert [(x["t0_ms"] - base) % 30000 for x in t["segments"]] == [0] * len(t["segments"]) and t["segments"][0]["t0_ms"] >= base   # tape clock: span start + 30 s bins
    blob = json.dumps(t)
    for text in TEXTS:   # no text, ever
        assert text not in blob and text.split()[0] + " " + text.split()[1] not in blob
    assert '"text"' not in blob
    ex = t["extras"]
    assert ex["calls"] == {"clef": 10, "jev": 3} and ex["degraded"] is False and ex["cost_usd"] == pytest.approx(10 * 0.0012)
    assert ex["parts_tag_sha256"] == pl.PARTS_TAG_SHA256 and ex["parts_config_sha256"] == sha
    assert t["config"]["parts_config_sha256"] == sha and t["config"]["parts_tag_sha256"] == pl.PARTS_TAG_SHA256


def test_confidence_comes_from_the_config_not_the_code(tmp_path):
    env, _ = make(tmp_path)
    flipped = {**CONF, "history": "low", "medicine": "low"}
    ctx, _ = ctx_for(tmp_path, conf=flipped)
    go(env, ctx)
    (t,) = the_tracks(env)
    assert {s["confidence"] for s in t["segments"]} == {"low"}


def test_config_sha_is_in_the_cfg8_so_a_new_config_is_a_new_track(tmp_path):
    env, _ = make(tmp_path)
    ctx1, sha1 = ctx_for(tmp_path, version="t1", name="a.json")
    ctx2, sha2 = ctx_for(tmp_path, conf={**CONF, "exam": "high"}, version="t2", name="b.json")
    assert sha1 != sha2
    assert go(env, ctx1)["written"] == 1
    assert go(env, ctx2)["written"] == 1      # same stt, new config sha: a second track, the first stays
    ts = the_tracks(env)
    assert len(ts) == 2 and ts[0]["config_hash"] != ts[1]["config_hash"]
    assert {t["config"]["parts_config_sha256"] for t in ts} == {sha1, sha2}


def test_rerun_is_skipped_before_any_call(tmp_path):
    env, _ = make(tmp_path)
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev)
    go(env, ctx)
    calls = (clef.calls, jev.calls)
    cnt = go(env, ctx)
    assert cnt["skipped_existing"] == 1 and cnt["written"] == 0 and (clef.calls, jev.calls) == calls
    assert len(the_tracks(env)) == 1


# ---------------------------------------------------------------- skips and failures
def test_no_stt_is_skipped_and_counted(tmp_path):
    env, _ = make(tmp_path, with_stt=False)
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev)
    cnt = go(env, ctx)
    assert cnt["no_stt"] == 1 and cnt["written"] == 0 and clef.calls == 0 and jev.calls == 0


def test_stt_without_text_is_skipped(tmp_path):
    env, _ = make(tmp_path, entries=[{"speaker_id": "0", "start": 1.0, "end": 2.0, "transcript": "   "}])
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev)
    cnt = go(env, ctx)
    assert cnt["no_text"] == 1 and clef.calls == 0 and jev.calls == 0 and cnt["written"] == 0


def test_clef_failure_goes_jev_only_and_is_marked_degraded(tmp_path):
    env, _ = make(tmp_path)
    clef = Clef(fail=True)
    ctx, _ = ctx_for(tmp_path, clef=clef)
    cnt = go(env, ctx)
    assert cnt["written"] == 1 and cnt["degraded"] == 1 and cnt["errors"] == 0 and cnt["clef_errors"] >= 1 and clef.calls <= 3   # 3 failed windows in a row drops CLEF for the clip
    (t,) = the_tracks(env)
    assert t["extras"]["degraded"] is True and t["segments"] and {s["source"] for s in t["segments"]} == {"jev"}
    assert t["extras"]["cost_usd"] == 0.0 and ctx.spend.spent() == 0.0   # failed CLEF calls are not charged
    assert t["config"]["clef_mode"] == "jev-only"                         # CLEF died mid-clip: the track is the Jev-only one, in its own cfg8


def test_every_jev_call_failing_writes_nothing(tmp_path):
    env, _ = make(tmp_path)
    ctx, _ = ctx_for(tmp_path, jev=Jev(fail=True))
    cnt = go(env, ctx)
    assert cnt["errors"] == 1 and cnt["written"] == 0 and the_tracks_dir_empty(env)


def the_tracks_dir_empty(env):
    return not [n for n in os.listdir(tdir(env)) if n.startswith("parts.")]


def test_budget_stop_makes_no_call_and_leaves_the_rest(tmp_path):
    rows = [make_row(uid="UIDA"), make_row(uid="UIDB")]
    env, _ = make(tmp_path, rows=rows)
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev, cap=0.005)      # one clip needs ~10 x 0.0012 = 0.012
    cnt = go(env, ctx)
    assert cnt["budget_stopped"] == 1 and cnt["written"] == 0 and clef.calls == 0 and jev.calls == 0
    assert cnt["clips"] == 1                                         # the run stopped at the first clip


def test_spend_is_persisted_across_runs_and_caps_the_day(tmp_path):
    rows = [make_row(uid="UIDA"), make_row(uid="UIDB")]
    env, _ = make(tmp_path, rows=rows)
    clef = Clef()
    ctx, _ = ctx_for(tmp_path, clef=clef, cap=0.02)                  # one clip costs 0.012; a second would pass 0.02
    cnt = go(env, ctx)
    assert cnt["written"] == 1 and cnt["budget_stopped"] == 1 and clef.calls == 10
    assert ctx.spend.spent() == pytest.approx(0.012)
    again, _ = ctx_for(tmp_path, clef=clef, cap=0.02, name="parts_config.json")   # a new process, same day, same spend dir
    assert again.spend.spent() == pytest.approx(0.012)
    assert go(env, again)["budget_stopped"] == 1 and clef.calls == 10


def test_spend_is_per_ist_day(tmp_path):
    day1 = pl.Spend(str(tmp_path / "s"), cap=1.0, now=lambda: 1_800_000_000)
    day1.add(0.5)
    assert day1.spent() == 0.5 and not day1.room_for(0.6) and day1.room_for(0.5)
    day2 = pl.Spend(str(tmp_path / "s"), cap=1.0, now=lambda: 1_800_000_000 + 86400)
    assert day2.spent() == 0.0
    assert oct(os.stat(day1._path()).st_mode & 0o777) == "0o600"


def test_dry_run_calls_nothing_and_writes_nothing(tmp_path):
    env, _ = make(tmp_path)
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev)
    cnt = go(env, ctx, write=False)
    assert cnt["would_write"] == 1 and cnt["written"] == 0 and cnt["est_clef_calls"] == 10 and clef.calls == 0 and jev.calls == 0
    assert the_tracks_dir_empty(env) and ctx.spend.spent() == 0.0 and cnt["cost_usd"] == 0.0


def test_heldout_clip_is_refused_before_its_text_is_read(tmp_path):
    env, _ = make(tmp_path)
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev)
    cnt = go(env, ctx, held=lambda d, r: True)
    assert cnt["blind_refused"] == 1 and cnt["written"] == 0 and clef.calls == 0 and jev.calls == 0


def test_limit_caps_the_clips_sent(tmp_path):
    rows = [make_row(uid="UIDA"), make_row(uid="UIDB")]
    env, _ = make(tmp_path, rows=rows)
    ctx, _ = ctx_for(tmp_path)
    cnt = go(env, ctx, limit=1)
    assert cnt["written"] == 1 and cnt["limit_reached"] == 1


def test_jev_fn_sends_the_taggers_questions_through_the_client_and_no_key(tmp_path):
    seen = []

    class Client:
        model = "m"

        def _post(self, body):
            seen.append(body)
            return {"answers": {ty: {"noul": 0.25} for ty in pt.TYPES}}
    out = pl.make_jev_fn(Client())(["A: hi"], ["B: there"])
    assert out == {ty: 0.25 for ty in pt.TYPES}
    body = seen[0]
    assert body["state"].endswith("[Now] B: there") and "[Earlier] A: hi" in body["state"] and set(body["questions"]) == set(pt.TYPES)
    assert "key" not in json.dumps(body).lower().replace("keyword", "")


# ---------------------------------------------------------------- follow-up: clef_mode, preflight, cost
class PartialClef:
    """Answers the first n calls, then fails every call."""

    def __init__(self, n):
        self.n, self.calls = n, 0

    def __call__(self, wav):
        self.calls += 1
        if self.calls > self.n:
            raise RuntimeError("clef down")
        return {p: (0.9 if p == "history" else 0.0) for p in CONF}


def test_preflight_ok_when_the_helper_imports_and_the_env_file_is_readable(tmp_path, monkeypatch):
    import sys
    d = tmp_path / "clefdir"
    d.mkdir()
    envf = d / "clef.env"
    envf.write_text("SECRET=1")
    (d / "clef.py").write_text(f"ENV_FILE = {str(envf)!r}\n")
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.delitem(sys.modules, "clef", raising=False)
    opened = []
    real_open = open
    monkeypatch.setattr("builtins.open", lambda f, *a, **k: (opened.append(str(f)), real_open(f, *a, **k))[1])
    assert pl.clef_preflight(str(d)) is True
    assert str(envf) not in opened                                 # os.access only: the credential file is never opened
    monkeypatch.setattr(os, "access", lambda p, m: False)
    monkeypatch.delitem(sys.modules, "clef", raising=False)
    assert pl.clef_preflight(str(d)) is False                      # imports, but the env file is not readable by this process (the missing-group case)


def test_preflight_fails_when_the_helper_cannot_be_imported(tmp_path, monkeypatch):
    import sys
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.delitem(sys.modules, "clef", raising=False)
    assert pl.clef_preflight(str(tmp_path / "nothing-here")) is False


def test_failed_preflight_runs_jev_only_with_no_clef_call_and_its_own_cfg8(tmp_path):
    env, _ = make(tmp_path)
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev, preflight=lambda: False)
    cnt = go(env, ctx)
    assert cnt["written"] == 1 and cnt["clef_calls"] == 0 and clef.calls == 0 and jev.calls == 3 and cnt["degraded"] == 1
    assert cnt["clef_preflight_failed"] == 1 and cnt["clef_preflight_ok"] == 0 and cnt["est_clef_calls"] == 0
    (t,) = the_tracks(env)
    assert t["config"]["clef_mode"] == "jev-only" and t["extras"]["degraded"] is True and {s["source"] for s in t["segments"]} == {"jev"} and t["extras"]["cost_usd"] == 0.0
    assert go(env, ctx)["skipped_existing"] == 1 and jev.calls == 3          # the jev-only cfg8 is what a jev-only rerun checks: no second Jev spend


def test_later_run_with_clef_working_writes_a_new_track_beside_the_jev_only_one(tmp_path):
    env, _ = make(tmp_path)
    bad, _ = ctx_for(tmp_path, preflight=lambda: False)
    good, _ = ctx_for(tmp_path, clef=Clef(), preflight=lambda: True)
    assert go(env, bad)["written"] == 1
    cnt = go(env, good)
    assert cnt["written"] == 1 and cnt["skipped_existing"] == 0 and cnt["clef_preflight_ok"] == 1 and cnt["clef_calls"] == 10
    ts = the_tracks(env)
    assert sorted(t["config"]["clef_mode"] for t in ts) == ["clef+jev", "jev-only"] and len({t["config_hash"] for t in ts}) == 2
    assert {s["source"] for t in ts if t["config"]["clef_mode"] == "clef+jev" for s in t["segments"]} & {"clef", "clef+jev"}
    assert [t for t in ts if t["config"]["clef_mode"] == "jev-only"][0]["extras"]["degraded"] is True   # the earlier track stays as it was


def test_clef_working_track_is_clef_plus_jev_and_undegraded(tmp_path):
    env, _ = make(tmp_path)
    ctx, _ = ctx_for(tmp_path)
    go(env, ctx)
    (t,) = the_tracks(env)
    assert t["config"]["clef_mode"] == "clef+jev" and t["extras"]["degraded"] is False


def test_cost_counts_only_answered_clef_calls(tmp_path):
    env, _ = make(tmp_path)
    clef = PartialClef(2)                                           # 2 answers, then 3 failures in a row -> CLEF dropped for the clip
    ctx, _ = ctx_for(tmp_path, clef=clef)
    cnt = go(env, ctx)
    assert cnt["clef_calls"] == 5 and cnt["clef_errors"] == 3 and cnt["degraded"] == 1
    assert ctx.spend.spent() == pytest.approx(2 * 0.0012) and cnt["cost_usd"] == pytest.approx(2 * 0.0012)
    (t,) = the_tracks(env)
    assert t["extras"]["cost_usd"] == pytest.approx(2 * 0.0012) and t["config"]["clef_mode"] == "jev-only"


def test_all_failed_clef_calls_cost_nothing_and_do_not_use_up_the_cap(tmp_path):
    rows = [make_row(uid="UIDA"), make_row(uid="UIDB")]
    env, _ = make(tmp_path, rows=rows)
    ctx, _ = ctx_for(tmp_path, clef=Clef(fail=True), cap=0.02)
    cnt = go(env, ctx)
    assert cnt["written"] == 2 and cnt["clef_errors"] == 6 and cnt["cost_usd"] == 0.0 and cnt["budget_stopped"] == 0


def test_dry_run_reports_the_mode_without_a_call(tmp_path):
    env, _ = make(tmp_path)
    clef, jev = Clef(), Jev()
    ctx, _ = ctx_for(tmp_path, clef=clef, jev=jev, preflight=lambda: False)
    cnt = go(env, ctx, write=False)
    assert cnt["clef_mode"] == "jev-only" and cnt["would_write"] == 1 and cnt["clef_preflight_failed"] == 1 and clef.calls == 0 and jev.calls == 0
