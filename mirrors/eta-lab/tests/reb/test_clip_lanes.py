import fcntl
import json
import os
import types

import pytest

from kit.reb import clip_lane_engines as eng
from kit.reb import clip_lanes as cl
from kit.reb import sarvam_lane as sl
from kit.reb.from_hist import GuardUnavailable
from .test_sarvam_lane import DATE, SIG, SPAN_START_MS, UID, Env, FakeGW, make_row, tdir


class LangGW(FakeGW):
    def __init__(self, lang="hi-IN", **k):
        super().__init__(**k)
        self.lang = lang

    def transcribe(self, path, params, sleep=None, on_start=None):
        raw, meta = super().transcribe(path, params, sleep, on_start)
        raw["0.json"]["language_code"] = self.lang
        return raw, meta


class FakeRunner:
    """Scripted per-lane output; records every call. Creates the work dir like the real runner so the move-not-delete can be checked."""
    def __init__(self, status="ok", segs=None, raises=None):
        self.calls, self.status, self.raises = [], status, raises
        self.segs = segs if segs is not None else cl.tape_segments({"span_start_ms": 0}, [(1.5, 4.0, {"text": "synthetic one"})])

    def run(self, row, clip, config, workdir, lang=None):
        self.calls.append((row["consult_uid"], lang, config))
        os.makedirs(workdir, exist_ok=True)
        open(os.path.join(workdir, "scratch.wav"), "wb").write(b"x")
        if self.raises:
            raise self.raises
        segs = cl.tape_segments(clip, [(1.5, 4.0, {"speaker": "speaker_0"}), (5.0, 9.25, {"speaker": "speaker_1"})])
        return self.status, None if self.status == "ok" else "r", segs if self.status == "ok" else [], {"note": "meta"}


class Gate:
    def __init__(self):
        self.holds = 0

    def hold(self):
        import contextlib

        @contextlib.contextmanager
        def cm():
            self.holds += 1
            yield
        return cm()


def make(tmp, lang="hi-IN", date=DATE, row=None):
    row = row or make_row(date=date)
    env = Env(tmp, [row])
    env.run(LangGW(lang=lang), date=date)
    return env, row


def go(env, lane, runner=None, write=True, held=lambda d, r: False, gate=None, recut=frozenset(), **kw):
    a = types.SimpleNamespace(consult=None, date=None, since=DATE, until=None, write=write, limit=0, min_minutes=0, identified=False, **kw)
    runner = runner or FakeRunner()
    gate = gate or Gate()
    cnt = cl.run(a, lane, root=env.root, is_held=held, runner=runner, gate=gate, index_path=env.index, clips_root=env.clips, log_dir=str(env.root) + "-logs", recut_pending=recut,
                 work_root=str(env.root) + "-work")
    return cnt, runner, gate


def role_tracks(env, lane):
    L = cl.LANES[lane]
    return sorted(n for n in os.listdir(tdir(env)) if n.startswith(f"{L['layer']}.{L['engine']}__"))


def test_nemotron_track_on_tape_time_with_provenance_and_signature_in_cfg8(tmp_path):
    env, row = make(tmp_path)
    cnt, runner, gate = go(env, "nemotron")
    assert cnt["written"] == 1 and cnt["ok"] == 1 and cnt["audio_h"] == 0.083 and gate.holds == 1
    names = role_tracks(env, "nemotron")
    assert names == [f"diar.nemotron__f667ed73__{sl.writer.config_hash(cl.lane_config('nemotron', row))}.json"]
    t = json.load(open(os.path.join(tdir(env), names[0])))
    assert (t["layer"], t["engine"], t["version"], t["model"], t["status"], t["window_id"]) == ("diar", "nemotron", "f667ed73", "nvidia/Nemotron-3-Diarization", "ok", "consult-" + UID)
    assert t["segments"][0] == {"t0_ms": SPAN_START_MS + 1500, "t1_ms": SPAN_START_MS + 4000, "speaker": "speaker_0"}               # span start + offset
    assert t["config"]["clip_signature"] == SIG and t["config"]["model_rev"] == eng.NEMOTRON_REV and t["config"]["latency"] == "offline_30.4s"
    assert t["extras"]["consult_uid"] == UID and t["extras"]["clip_signature"] == SIG and "text" not in json.dumps(t["segments"])


def test_idempotent_and_a_recut_clip_gets_a_new_track(tmp_path):
    env, row = make(tmp_path)
    go(env, "medasr")
    cnt, runner, _ = go(env, "medasr")
    assert cnt["written"] == 0 and cnt["skipped_existing"] == 1 and runner.calls == []
    recut = dict(row, signature=[1.0, "url_clear", "DOC1"])
    with open(env.index, "a") as f:
        f.write(json.dumps(recut) + "\n")
    os.makedirs(os.path.join(env.clips, recut["path"]), exist_ok=True)
    cnt, runner, _ = go(env, "medasr")
    assert cnt["written"] == 1 and len(role_tracks(env, "medasr")) == 2                                                          # new signature = new cfg8 = a second track; the old one stays


def test_dry_run_is_the_default_behaviour_nothing_decoded_no_model(tmp_path):
    env, row = make(tmp_path)
    cnt, runner, gate = go(env, "koyal", write=False)
    assert cnt["would_write"] == 1 and cnt["written"] == 0 and runner.calls == [] and gate.holds == 0 and role_tracks(env, "koyal") == []


def test_blind_deferred_not_cut_and_mismatch_are_refused_before_any_run(tmp_path):
    env, row = make(tmp_path)
    cnt, runner, _ = go(env, "acoustics", held=lambda d, r: True)
    assert cnt["blind_refused"] == 1 and runner.calls == []
    cnt, runner, _ = go(env, "acoustics", recut=frozenset({UID}))
    assert cnt["deferred_recut"] == 1 and runner.calls == []
    open(os.path.join(env.clips, row["path"], "consult.flac"), "wb").write(b"fLaC" + b"\0" * 10)                             # bytes differ from the cutter row
    cnt, runner, _ = go(env, "acoustics")
    assert cnt["clip_mismatch"] == 1 and runner.calls == []
    assert role_tracks(env, "acoustics") == []


def test_koyal_one_prompt_per_clip_from_the_sarvam_language(tmp_path):
    env, row = make(tmp_path, lang="kn-IN")
    cnt, runner, _ = go(env, "koyal")
    assert cnt["written"] == 1 and runner.calls[0][1] == "kn"
    t = json.load(open(os.path.join(tdir(env), role_tracks(env, "koyal")[0])))
    assert t["config"]["lang"] == "kn-IN" and t["config"]["prompt_mode"] == "langID" and t["config"]["revision"] == eng.KOYAL_REV and t["extras"]["sarvam_language_code"] == "kn-IN"
    assert (t["engine"], t["version"], t["layer"]) == ("koyal", "box-t4-koyal-1", "stt")
    for code, key in (("en-IN", "skipped_language_en"), ("ta-IN", "skipped_language_unsupported"), ("bn-IN", "skipped_language_unsupported")):
        e2, _ = make(tmp_path / code, lang=code)
        c2, r2, _ = go(e2, "koyal")
        assert c2[key] == 1 and c2["written"] == 0 and r2.calls == []
    e3 = Env(tmp_path / "nolang", [make_row()])                                                                                 # no Sarvam track at all
    c3, r3, _ = go(e3, "koyal")
    assert c3["skipped_language_unknown"] == 1 and r3.calls == []
    assert eng.KOYAL_LANGS == {"hi": "hi-IN", "kn": "kn-IN", "ml": "ml-IN", "te": "te-IN"}


def test_only_gpu_lanes_take_the_gpu_gate(tmp_path):
    env, row = make(tmp_path)
    for lane, expect in (("acoustics", 0), ("nemotron", 1), ("medasr", 1)):
        _, _, gate = go(env, lane)
        assert gate.holds == expect, lane


def test_failed_inference_writes_nothing_and_counts_by_class_the_workdir_is_moved(tmp_path):
    env, row = make(tmp_path)
    cnt, runner, _ = go(env, "nemotron", runner=FakeRunner(raises=RuntimeError("CUDA out of memory")))
    assert cnt["errors"] == 1 and cnt["written"] == 0 and role_tracks(env, "nemotron") == []
    work = str(env.root) + "-work"
    failed = os.listdir(os.path.join(work, "failed"))
    assert len(failed) == 1 and failed[0].startswith(f"{UID}-nemotron-") and os.path.exists(os.path.join(work, "failed", failed[0], "scratch.wav"))      # the failed clip's decode, MOVED to failed/
    assert not any(n.startswith("scratch-") for n in os.listdir(work)) and not os.path.exists(os.path.join(work, "_to_delete"))                     # and no scratch left behind
    logs = open(os.path.join(str(env.root) + "-logs", os.listdir(str(env.root) + "-logs")[0])).read()
    assert "RuntimeError" in logs and '"msg": "CUDA out of memory"' in logs                                                    # class, location and a message only if it matches a torch shape (decoded text never passes; see the test below)
    cnt, _, _ = go(env, "nemotron", runner=FakeRunner(status="empty"))
    assert cnt["empty"] == 1 and cnt["written"] == 1                                                                           # an empty result is recorded evidence


def test_until_limit_and_guard_failure(tmp_path, monkeypatch):
    rows = [make_row(uid=f"u{i}", date=d) for i, d in enumerate(("2026-10-06", "2026-10-07", "2026-10-08"))]
    env = Env(tmp_path, rows)
    for d in ("2026-10-06", "2026-10-07", "2026-10-08"):
        env.run(LangGW(), date=d)
    a = types.SimpleNamespace(consult=None, date=None, since="2026-10-06", until="2026-10-07", write=False, limit=0, min_minutes=0, identified=False)
    cnt = cl.run(a, "acoustics", root=env.root, is_held=lambda d, r: False, runner=FakeRunner(), gate=Gate(), index_path=env.index, clips_root=env.clips, log_dir=None,
                 recut_pending=frozenset())
    assert cnt["would_write"] == 2 and cnt["clips"] == 2
    a.until, a.limit = None, 1
    cnt = cl.run(a, "acoustics", root=env.root, is_held=lambda d, r: False, runner=FakeRunner(), gate=Gate(), index_path=env.index, clips_root=env.clips, log_dir=None,
                 recut_pending=frozenset())
    assert cnt["would_write"] == 1 and cnt["limit_reached"] == 2

    def boom():
        raise GuardUnavailable("none")
    monkeypatch.setattr(cl, "load_heldout", boom)
    with pytest.raises(GuardUnavailable):
        cl.run(a, "acoustics", root=env.root, index_path=env.index, clips_root=env.clips, log_dir=None, recut_pending=frozenset())


def test_gpu_gate_waits_for_the_lock_and_for_free_vram(tmp_path):
    lock = str(tmp_path / "gpu.lock")
    sleeps, state = [], {"free": [1000, 1000, 4000], "i": 0}

    def free():
        v = state["free"][min(state["i"], 2)]
        state["i"] += 1
        return v
    g = cl.GpuGate(lock_path=lock, min_free_mib=2048, free_mib=free, sleep=sleeps.append, poll_s=1.0)
    with g.hold():
        pass
    assert len(sleeps) == 2                                                                                                    # waited twice for VRAM, then took the lock
    other = os.open(lock, os.O_RDWR | os.O_CREAT)
    fcntl.flock(other, fcntl.LOCK_EX)
    freed = []

    def sleep2(s):
        freed.append(s)
        if len(freed) == 2:
            fcntl.flock(other, fcntl.LOCK_UN)                                                                                  # the other holder lets go
    g2 = cl.GpuGate(lock_path=lock, min_free_mib=0, free_mib=lambda: 9999, sleep=sleep2, poll_s=1.0)
    with g2.hold():
        pass
    assert len(freed) == 2
    g3 = cl.GpuGate(lock_path=lock, min_free_mib=2048, free_mib=lambda: 10, sleep=lambda s: None, poll_s=1.0, timeout_s=3)
    with pytest.raises(TimeoutError):
        with g3.hold():
            pass
    os.close(other)


def test_acoustics_segments_tape_time_and_helpers():
    clip = {"span_start_ms": 1000}
    segs = cl.acoustics_segments(clip, {"dur_ms": 60000, "level_dbfs": -40.0, "clip_share": 0.0, "noise_floor_dbfs": -50.0, "snr_db": 10.0, "mute_spans": [(2000, 2500)]})
    assert [(s["extras"]["metric"], s["t0_ms"], s["t1_ms"]) for s in segs] == [("level_dbfs", 1000, 61000), ("clip_share", 1000, 61000), ("noise_floor_dbfs", 1000, 61000),
                                                                                ("snr_db", 1000, 61000), ("mute_span", 3000, 3500)]
    assert segs[-1]["value"] == 0.5 and cl.lang_base("hi-IN") == "hi" and cl.lang_base(None) is None
    assert eng.find_mute_spans.__doc__ and cl.LANES["nemotron"]["version"] == "f667ed73"
    with pytest.raises(SystemExit):
        cl.main(["--lane", "koyal", "--since", DATE, "--write", "--dry-run"])


def test_medasr_loads_offline_whatever_the_environment_says(monkeypatch):
    import sys
    import types as ty
    seen = []

    class Auto:
        @classmethod
        def from_pretrained(cls, repo, **kw):
            seen.append((repo, kw))
            o = cls()
            o.device = "cpu"
            return o

        def eval(self):
            return self

        def to(self, d):
            return self

        def parameters(self):
            return iter([ty.SimpleNamespace(dtype="f32")])
    fake_tf = ty.ModuleType("transformers")
    fake_tf.AutoProcessor = fake_tf.AutoModelForCTC = Auto
    fake_tf.__version__ = "5.17.0"
    fake_torch = ty.ModuleType("torch")
    fake_torch.__version__ = "2.14.0"
    monkeypatch.setitem(sys.modules, "transformers", fake_tf)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")                                                        # an environment that would allow the hub
    eng.MedAsr()
    assert len(seen) == 2 and all(kw == {"revision": eng.MEDASR_REV, "local_files_only": True} for _, kw in seen) and {r for r, _ in seen} == {"google/medasr"}


def test_a_failed_engine_result_is_counted_as_failed_not_as_an_error(tmp_path):
    env, row = make(tmp_path)

    class Short(FakeRunner):
        def run(self, row, clip, config, workdir, lang=None):
            os.makedirs(workdir, exist_ok=True)
            return "failed", "short_clip", [], {}
    cnt, _, _ = go(env, "acoustics", runner=Short())
    assert cnt["failed"] == 1 and cnt["errors"] == 0 and cnt["written"] == 1


def error_lines(env):
    logdir = str(env.root) + "-logs"
    return [json.loads(l) for f in os.listdir(logdir) if f.endswith(".jsonl") for l in open(os.path.join(logdir, f)) if '"error"' in l]


def test_error_line_keeps_a_torch_shape_but_never_a_decoded_english_or_hindi_sentence(tmp_path):
    env, row = make(tmp_path)
    cnt, _, _ = go(env, "medasr", runner=FakeRunner(raises=RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 14.58 GiB total)")))
    (line,) = error_lines(env)
    assert cnt["errors"] == 1 and line["msg"] == "CUDA out of memory. Tried to allocate 2.00 GiB" and "msg_len" not in line
    assert set(line) == {"ts", "consult_uid", "lane", "error", "where", "where_kit", "msg"}
    assert line["where"].endswith(":run") and line["where_kit"].startswith("clip_lanes.py:")
    env2, _ = make(tmp_path / "b")
    sentence = "the patient takes metformin five hundred twice daily and \u0939\u093f\u0902\u0926\u0940"
    go(env2, "medasr", runner=FakeRunner(raises=RuntimeError(sentence)))
    (line2,) = error_lines(env2)
    assert line2["msg"] == "unclassified" and line2["msg_len"] == len(sentence) and "metformin" not in json.dumps(line2) and line2["error"] == "RuntimeError"
    env3, _ = make(tmp_path / "c")
    go(env3, "medasr", runner=FakeRunner(raises=ValueError("CUDA error: an illegal memory access was encountered")))
    go(env3, "medasr", runner=FakeRunner(raises=ValueError("CUDA error: the patient is on insulin")))
    l3 = error_lines(env3)
    assert l3[0]["msg"] == "CUDA error: an illegal memory access was encountered" and l3[1]["msg"] == "unclassified"            # a known shape only; a free sentence after the prefix is not copied


def test_no_expected_but_got_shape_so_free_words_there_are_never_copied(tmp_path):
    probe = "Expected input amlodipine five mg twice daily but got chest pain since two days and fever"
    assert cl._safe_msg(RuntimeError(probe)) == {"msg": "unclassified", "msg_len": len(probe)}
    assert cl._safe_msg(RuntimeError("Expected hidden[0] size (1, 4, 256), got [1, 4, 128]")) == {"msg": "unclassified", "msg_len": 52}


def test_medasr_chunk_bounds_fold_a_tiny_tail_into_the_chunk_before_it():
    sr, cs = eng.SR16, 30 * eng.SR16
    assert eng.MedAsr.chunk_bounds(60 * sr, cs) == [(0, cs), (cs, 2 * cs)]                                      # exact multiple: unchanged
    assert eng.MedAsr.chunk_bounds(60 * sr + int(0.137 * sr), cs) == [(0, cs), (cs, 2 * cs + int(0.137 * sr))]    # a 137 ms tail (one of the five failed clips) joins the last chunk
    assert eng.MedAsr.chunk_bounds(60 * sr + int(0.172 * sr), cs)[-1] == (2 * cs, 2 * cs + int(0.172 * sr))          # 172 ms worked in the 10A run: stays its own chunk, existing tracks unchanged
    assert eng.MedAsr.chunk_bounds(60 * sr + 2 * sr, cs) == [(0, cs), (cs, 2 * cs), (2 * cs, 2 * cs + 2 * sr)]    # a 2 s tail stays its own chunk (as the 359 existing tracks)
    assert eng.MedAsr.chunk_bounds(10 * sr, cs) == [(0, 10 * sr)] and eng.MedAsr.chunk_bounds(0, cs) == []



# ---------------------------------------------------------------- architect #11496: one scratch per lane, not a retired dir per clip
def many(tmp, n):
    rows = [make_row(uid=f"u{i}", date=DATE) for i in range(n)]
    env = Env(tmp, rows)
    env.run(LangGW(lang="hi-IN"), date=DATE)
    return env


def test_many_clips_leave_one_scratch_dir_per_lane_run(tmp_path):
    env = many(tmp_path, 8)
    cnt, runner, _ = go(env, "nemotron")
    assert cnt["written"] == 8 and len(runner.calls) == 8
    work = str(env.root) + "-work"
    moved = os.listdir(os.path.join(work, "_to_delete"))
    assert len(moved) == 1 and moved[0].startswith("scratch-") and os.path.exists(os.path.join(work, "_to_delete", moved[0], "scratch.wav"))        # 8 clips -> 1 dir
    assert sorted(os.listdir(work)) == ["_to_delete"]
    cnt2, _, _ = go(env, "nemotron")                                                                                                               # a rerun is skip-existing: nothing is decoded, no scratch is made
    assert cnt2["skipped_existing"] == 8 and len(os.listdir(os.path.join(work, "_to_delete"))) == 1


def test_failed_clips_keep_scratch_up_to_the_cap(tmp_path):
    env = many(tmp_path, 8)
    cnt, runner, _ = go(env, "nemotron", runner=FakeRunner(raises=RuntimeError("CUDA out of memory")))
    assert cnt["errors"] == 8 and cnt["written"] == 0
    work = str(env.root) + "-work"
    assert len(os.listdir(os.path.join(work, "failed"))) == cl.FAILED_KEEP == 5                       # 8 failures keep 5
    assert sorted(os.listdir(work)) == ["failed"] or all(n in ("failed", "_to_delete") or n.startswith("scratch-") for n in os.listdir(work))
    assert sum(1 for dp, _, fs in os.walk(work) for f in fs) <= cl.FAILED_KEEP + 1                    # the 5 kept + at most the last un-keepable scratch: bounded whatever the count


# ---- 16A: stt segments carry lang; extras.source_language is the clip's Sarvam language code
def _real_stt_segments(monkeypatch, lane, lang=None):
    monkeypatch.setattr(eng, "decode_f32", lambda *a, **k: [0.0] * 16)
    r = cl.RealRunner(lane)
    r.model = types.SimpleNamespace(transcribe=lambda *a: [(1.0, 2.0, "one"), (3.0, 4.5, "two")], runtime="fake", nemo_version="n", nemo_sha256="s")
    status, _, segs, _ = r.run({}, {"path": "x.flac", "span_start_ms": 0, "span_end_ms": 6000}, {}, "/tmp/never-used-" + lane, lang)
    return status, segs


def test_medasr_segments_say_en_and_koyal_segments_say_their_language(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    status, segs = _real_stt_segments(monkeypatch, "medasr")
    assert status == "ok" and len(segs) == 2 and all(s["lang"] == "en" and s["text"] for s in segs)
    status, segs = _real_stt_segments(monkeypatch, "koyal", "kn")
    assert status == "ok" and len(segs) == 2 and all(s["lang"] == "kn-IN" for s in segs)


@pytest.mark.parametrize("lane,code", [("medasr", "hi-IN"), ("koyal", "kn-IN"), ("medasr", "en-IN")])
def test_stt_tracks_carry_extras_source_language_from_sarvam(tmp_path, lane, code):
    env, _ = make(tmp_path, lang=code)
    cnt, _, _ = go(env, lane)
    if cnt["written"] == 0:                                       # koyal skips en-IN by design
        assert lane == "koyal" and code == "en-IN"
        return
    t = json.load(open(os.path.join(tdir(env), role_tracks(env, lane)[0])))
    assert t["extras"]["source_language"] == code


def test_medasr_source_language_is_null_when_sarvam_has_no_track(tmp_path):
    env = Env(tmp_path / "nolang", [make_row()])
    cnt, _, _ = go(env, "medasr")
    assert cnt["written"] == 1
    t = json.load(open(os.path.join(tdir(env), role_tracks(env, "medasr")[0])))
    assert "source_language" in t["extras"] and t["extras"]["source_language"] is None
