"""clip_lanes.py: the kept lab lanes (MedASR, Koyal, acoustics, Nemotron diarisation) on every cut CONSULT clip (ORDERS-PALIMPSEST-10A, V ruling L1).

Beside Sarvam, on the same audio: for each cut consult clip it runs ONE lane per process (the lanes need different Python environments, see clip_lane_engines.py) on
consult.flac and writes the track into reb/<ist_date>/<room_id>/_consults/<consult_uid>/ through writer.write_track. Pyannote is OUT of the stack (no new pyannote tracks).
Lab compute only: no Sarvam call, no network at inference (models load from the local HF cache), box T4 under ~/gpu.lock.

Lanes (layer.engine, version)               config
  acoustics   acoustics.room_profile_acoustics v1        {sr 48000, mute_min_ms 200, clip_thresh 0.999, quiet_frame_s 1}
  nemotron    diar.nemotron, version = rev[:8] (f667ed73)  stock nvidia/Nemotron-3-Diarization, offline 30.4 s setting
  koyal       stt.koyal box-t4-koyal-1                    ONE prompt per clip: Sarvam's language_code when it is hi/kn/ml/te; en-IN and anything else is skipped and counted
  medasr      stt.medasr box-t4-medasr-1                  the 30 s config of the hf-l4-medasr-1 lineage (terms.medasr is not part of this lane)
Segments are on TAPE time (clip span start + offset, ms). cfg8 = writer.config_hash(lane config + the clip's cutter signature), so a re-cut clip gets a new track and the
old one stays. Guards, in order, exactly as sarvam_lane: the latest cutter row must be status cut; heldout (day+room, then the clip span) before any audio is read; the clip is
opened and checked (bytes, FLAC magic, timeline); clips queued in the CONSULT re-cut queue are deferred; an existing track for the same cfg8 is skipped (idempotent).
--dry-run is the default: it decodes nothing and loads no model.
"""
import argparse
import collections
import contextlib
import datetime
import fcntl
import json
import os
import socket
import subprocess
import sys
import time

from . import clip_lane_engines as eng
from . import sarvam_lane as sl
from . import writer
from .from_hist import GuardUnavailable, OUT_DIR, REB_ROOT, load_heldout, window_held
from .schema import SCHEMA_VERSION
from .validate import validate_track

WORK_ROOT = os.path.expanduser("~/eta-data/clip-lanes-work")
GPU_LOCK = os.path.expanduser("~/gpu.lock")
MIN_FREE_VRAM_MIB = 2048
MACHINE = "box-clip-lanes"
LANES = {
    "acoustics": {"layer": "acoustics", "engine": "room_profile_acoustics", "version": "v1", "model": "dsp+silero_vad", "gpu": False},
    "nemotron": {"layer": "diar", "engine": "nemotron", "version": eng.NEMOTRON_REV[:8], "model": eng.NEMOTRON_REPO, "gpu": True},
    "koyal": {"layer": "stt", "engine": "koyal", "version": "box-t4-koyal-1", "model": eng.KOYAL_REPO, "gpu": True},
    "medasr": {"layer": "stt", "engine": "medasr", "version": "box-t4-medasr-1", "model": eng.MEDASR_REPO, "gpu": True},
}
COUNTERS = ("clips", "ok", "empty", "failed", "written", "would_write", "skipped_existing", "deferred_recut", "not_cut_refused", "blind_refused", "clip_mismatch", "skipped_language_en",
            "skipped_language_unsupported", "skipped_language_unknown", "errors", "audio_s")


# ---------------------------------------------------------------- helpers
def lang_base(code):
    return str(code).split("-")[0].lower() if code else None


def sarvam_language(root, row):
    """language_code of the clip's live ok Sarvam stt track (dominant by audio seconds for a split clip), or None. Read-only; the transcript text is not touched."""
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    try:
        m = json.load(open(os.path.join(wd, "manifest.json")))
    except (OSError, ValueError):
        return None
    best = None
    for e in m.get("tracks", []):
        if e.get("layer") == "stt" and e.get("engine") == sl.ENGINE and e.get("status") == "ok":
            p = os.path.join(root, e["path"])
            if os.path.exists(p) and (best is None or (e.get("finished_at") or "") >= (best[0] or "")):
                best = (e.get("finished_at"), p)
    if not best:
        return None
    t = json.load(open(best[1]))
    if (t.get("config") or {}).get("clip_signature") != row["signature"]:
        return None
    langs = collections.Counter()
    parts = (t.get("extras") or {}).get("parts")
    if parts:
        for p in parts:
            langs[p.get("language_code")] += p.get("audio_s") or 0
    else:
        for sg in t.get("segments", []):
            langs[sg.get("lang")] += (sg["t1_ms"] - sg["t0_ms"]) / 1000.0
    return langs.most_common(1)[0][0] if langs else None


def lane_config(lane, row, lang=None):
    sig = row["signature"]
    if lane == "acoustics":
        return {**eng.ACOUSTICS_CONFIG, "clip_signature": sig}
    if lane == "nemotron":
        return {**eng.NEMOTRON_ENGINE_CONFIG, "model": eng.NEMOTRON_REPO, "model_rev": eng.NEMOTRON_REV, "clip_signature": sig}
    if lane == "koyal":
        return {"engine": "koyal", "model": eng.KOYAL_REPO, "revision": eng.KOYAL_REV, "lang": eng.KOYAL_LANGS[lang], "mode": "offline", "att_context_size": [-1, -1],
                "decoder": "greedy", "prompt_mode": "langID", "chunk_s": eng.KOYAL_CHUNK_S, "overlap_s": 0, "device": "T4-box", "clip_signature": sig}
    if lane == "medasr":
        return {**eng.MEDASR_CONFIG, "clip_signature": sig}
    raise KeyError(lane)


def track_path(root, row, lane, cfg8):
    L = LANES[lane]
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    return os.path.join(wd, "tracks", writer.track_filename(L["layer"], L["engine"], L["version"], cfg8))


def build_track(lane, row, clip, config, status, reason, segments, extras):
    L = LANES[lane]
    t = {"schema": SCHEMA_VERSION, "window_id": "consult-" + row["consult_uid"], "layer": L["layer"], "engine": L["engine"], "model": L["model"], "version": L["version"],
         "config": config, "config_hash": writer.config_hash(config), "machine": MACHINE, "status": status, "reason": reason, "segments": segments,
         "extras": {"consult_uid": row["consult_uid"], "clip_signature": row["signature"], "audio_s": round((clip["span_end_ms"] - clip["span_start_ms"]) / 1000, 3), **extras}}
    validate_track(t)
    return t


def tape_segments(clip, items):
    """[(t0_s, t1_s, payload dict)] clip-relative seconds -> segments on tape time (span start + offset, ms)."""
    s0 = clip["span_start_ms"]
    return [{"t0_ms": s0 + int(round(a * 1000)), "t1_ms": s0 + int(round(max(a, b) * 1000)), **p} for a, b, p in items]


def acoustics_segments(clip, m):
    s0, dur = clip["span_start_ms"], m["dur_ms"]
    cfg = eng.ACOUSTICS_CONFIG
    segs = [{"t0_ms": s0, "t1_ms": s0 + dur, "value": m["level_dbfs"], "extras": {"metric": "level_dbfs"}},
            {"t0_ms": s0, "t1_ms": s0 + dur, "value": m["clip_share"], "extras": {"metric": "clip_share", "threshold": cfg["clip_thresh"]}}]
    if "noise_floor_dbfs" in m:
        segs.append({"t0_ms": s0, "t1_ms": s0 + dur, "value": m["noise_floor_dbfs"], "extras": {"metric": "noise_floor_dbfs", "basis": "quiet_frame_p10"}})
    if "snr_db" in m:
        segs.append({"t0_ms": s0, "t1_ms": s0 + dur, "value": m["snr_db"], "extras": {"metric": "snr_db"}})
    for a, b in m["mute_spans"]:
        segs.append({"t0_ms": s0 + a, "t1_ms": s0 + b, "value": round((b - a) / 1000.0, 3), "extras": {"metric": "mute_span"}})
    return segs


# ---------------------------------------------------------------- GPU manners (as the Nemotron shadow worker: wait for free VRAM, hold ~/gpu.lock per inference)
def nvidia_free_mib():
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=15)
        total, used = (int(x.strip()) for x in r.stdout.splitlines()[0].split(","))
        return total - used
    except Exception:  # noqa: BLE001
        return None


class GpuGate:
    def __init__(self, lock_path=GPU_LOCK, min_free_mib=MIN_FREE_VRAM_MIB, free_mib=nvidia_free_mib, sleep=time.sleep, poll_s=2.0, timeout_s=3600):
        self.lock_path, self.min_free, self.free_mib, self.sleep, self.poll_s, self.timeout_s = lock_path, min_free_mib, free_mib, sleep, poll_s, timeout_s

    @contextlib.contextmanager
    def hold(self):
        waited = 0.0
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600) if self.lock_path else None
        try:
            while True:
                free = self.free_mib()
                got = fd is None
                if fd is not None:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        got = True
                    except OSError:
                        got = False
                if got and (free is None or free >= self.min_free):
                    break
                if got and fd is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)   # the lock is only useful with the VRAM: let go while we wait for memory
                if waited >= self.timeout_s:
                    raise TimeoutError("GPU not available")
                self.sleep(self.poll_s)
                waited += self.poll_s
            yield
        finally:
            if fd is not None:
                with contextlib.suppress(OSError):
                    fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)


# ---------------------------------------------------------------- real runners (models load on first use, never in a dry run)
class RealRunner:
    """run(lane, row, clip, config, workdir) -> (status, reason, segments, extras). Loads the lane's model on first call."""

    def __init__(self, lane):
        self.lane, self.model = lane, None

    def _load(self):
        if self.model is None:
            self.model = {"nemotron": eng.Nemotron, "koyal": eng.Koyal, "medasr": eng.MedAsr}.get(self.lane, lambda: None)()
        return self.model

    def run(self, row, clip, config, workdir, lang=None):
        os.makedirs(workdir, exist_ok=True)
        flac = clip["path"]
        if self.lane == "acoustics":
            m = eng.acoustics_metrics(eng.decode_f32(flac, eng.SR48))
            if m["status"] != "ok":
                return "failed", m["reason"], [], {}
            return "ok", None, acoustics_segments(clip, m), {"zero_sample_share": m["zero_sample_share"]}
        x16 = eng.decode_f32(flac, eng.SR16)
        model = self._load()
        if self.lane == "nemotron":
            wav = eng.write_wav16(x16, os.path.join(workdir, "clip16k.wav"))
            turns = model.diarize(wav)
            segs = tape_segments(clip, [(a, b, {"speaker": sp}) for a, b, sp in turns])
            return ("ok" if segs else "empty"), (None if segs else "no speaker activity"), segs, {"n_speakers": len({s["speaker"] for s in segs}), "model_rev": eng.NEMOTRON_REV}
        if self.lane == "koyal":
            out = model.transcribe(x16, eng.KOYAL_LANGS[lang], workdir)
            segs = tape_segments(clip, [(a, b, {"text": t, "lang": eng.KOYAL_LANGS[lang]}) for a, b, t in out])
            return ("ok" if segs else "empty"), (None if segs else "no text"), segs, {"prompt_source": "sarvam_language_code", "prompt": eng.KOYAL_LANGS[lang],
                                                                                    "nemo_version": model.nemo_version, "nemo_sha256": model.nemo_sha256}
        if self.lane == "medasr":
            out = model.transcribe(x16, eng.MEDASR_CONFIG["chunk_s"])
            segs = tape_segments(clip, [(a, b, {"text": t}) for a, b, t in out])
            return ("ok" if segs else "empty"), (None if segs else "no text"), segs, {"runtime": model.runtime}
        raise KeyError(self.lane)


# ---------------------------------------------------------------- one clip
def retire(wd, work_root=WORK_ROOT):
    if wd and os.path.isdir(wd):
        dest = os.path.join(work_root, "_to_delete")
        os.makedirs(dest, exist_ok=True)
        base = os.path.join(dest, os.path.basename(wd) + time.strftime("-%Y%m%dT%H%M%S"))
        target, n = base, 0
        while os.path.exists(target):   # never overwrite or merge into an earlier spent dir: two runs in the same second get distinct names
            n += 1
            target = f"{base}-{n}"
        os.rename(wd, target)


def process_clip(lane, row, root, is_held, write, cnt, runner, gate, joblog, clips_root=sl.CLIPS, recut_pending=frozenset(), work_root=WORK_ROOT):
    cnt["clips"] += 1
    if row.get("consult_uid") in recut_pending:
        cnt["deferred_recut"] += 1
        return
    if row.get("status") != "cut":
        cnt["not_cut_refused"] += 1
        return
    try:
        if is_held(row["ist_date"], row["room_id"]):   # heldout first, before any audio is read
            cnt["blind_refused"] += 1
            return
        try:
            clip = sl.open_clip(row, clips_root)
        except sl.ClipRefused:
            cnt["clip_mismatch"] += 1
            return
        if window_held(is_held, row["room_id"], clip["span_start_ms"], clip["span_end_ms"]):
            cnt["blind_refused"] += 1
            return
        lang = None
        if lane == "koyal":   # one prompt per clip, from what Sarvam heard
            code = sarvam_language(root, row)
            base = lang_base(code)
            if code is None:
                cnt["skipped_language_unknown"] += 1
                return
            if base == "en":
                cnt["skipped_language_en"] += 1
                return
            if base not in eng.KOYAL_LANGS:
                cnt["skipped_language_unsupported"] += 1
                return
            lang = base
        config = lane_config(lane, row, lang)
        cfg8 = writer.config_hash(config)
        if os.path.exists(track_path(root, row, lane, cfg8)):
            cnt["skipped_existing"] += 1
            return
        dur = (clip["span_end_ms"] - clip["span_start_ms"]) / 1000
        if not write:
            cnt["would_write"] += 1
            cnt["audio_s"] += dur
            return
        wd = os.path.join(work_root, f"{row['consult_uid']}-{lane}")
        t = time.time()
        try:
            if LANES[lane]["gpu"]:
                with gate.hold():
                    status, reason, segs, extras = runner.run(row, clip, config, wd, lang)
            else:
                status, reason, segs, extras = runner.run(row, clip, config, wd, lang)
        finally:
            retire(wd, work_root)
        track = build_track(lane, row, clip, config, status, reason, segs, {**extras, **({"sarvam_language_code": sarvam_language(root, row)} if lane == "koyal" else {})})
        try:
            writer.write_track(root, row["ist_date"], row["room_id"], track["window_id"], track, manifest_stub=sl.manifest_stub(row, clip, root), config_hash=track["config_hash"])
            cnt["written"] += 1
            cnt["audio_s"] += dur
            cnt[status if status in ("ok", "empty") else "failed"] += 1   # "failed" = the engine reported a failed result (e.g. acoustics short_clip), recorded as evidence; "errors" = exceptions
        except writer.TrackExistsError:
            cnt["skipped_existing"] += 1
        joblog(consult_uid=row["consult_uid"], lane=lane, audio_s=round(dur, 1), wall_s=round(time.time() - t, 2), status=status, n_segments=len(segs))
    except GuardUnavailable:
        raise
    except Exception as e:   # noqa: BLE001 - one bad clip must not stop the run; counted by class only, nothing is written for it
        cnt["errors"] += 1
        cnt["error_" + type(e).__name__] += 1
        joblog(consult_uid=row.get("consult_uid"), lane=lane, error=type(e).__name__)


def run(args, lane, root=None, is_held=None, runner=None, gate=None, index_path=sl.CLIP_INDEX, clips_root=sl.CLIPS, log_dir=OUT_DIR, recut_pending=None, work_root=WORK_ROOT):
    root = root or REB_ROOT
    is_held = is_held or load_heldout()   # fail closed before anything is read
    recut_pending = sl.load_recut_pending() if recut_pending is None else recut_pending   # fail closed (GuardUnavailable) if the re-cut queue cannot be read
    runner = runner or RealRunner(lane)
    gate = gate or GpuGate()
    cnt = collections.Counter({k: 0 for k in COUNTERS})
    ts = time.strftime("%Y%m%dT%H%M%S")
    jpath = os.path.join(log_dir, f"clip-lanes-{lane}-{ts}.jsonl") if log_dir else None
    if jpath:
        os.makedirs(log_dir, exist_ok=True)

    def joblog(**k):   # counts and timings only: never transcript text
        if jpath:
            fd = os.open(jpath, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a") as f:
                f.write(json.dumps({"ts": time.strftime("%H:%M:%S"), **k}, sort_keys=True) + "\n")
    rows = sl.select(args, index_path)
    if getattr(args, "until", None):
        rows = [r for r in rows if r["ist_date"] <= args.until]
    limit = getattr(args, "limit", 0)
    done = 0
    for r in rows:
        if limit and done >= limit:
            cnt["limit_reached"] += 1
            continue
        before = cnt["written"] + cnt["would_write"]
        process_clip(lane, r, root, is_held, args.write, cnt, runner, gate, joblog, clips_root, recut_pending, work_root)
        done += (cnt["written"] + cnt["would_write"]) - before
    out = dict(cnt)
    out["audio_h"] = round(out.pop("audio_s") / 3600, 3)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lane", required=True, choices=sorted(LANES))
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--consult")
    g.add_argument("--date")
    g.add_argument("--since")
    ap.add_argument("--until", default=None, help="last ist_date included (inclusive)")
    ap.add_argument("--write", action="store_true", help="run the lane and write tracks (default: dry run: nothing is decoded, no model is loaded)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="at most N clips actually processed (skipped and refused clips do not count)")
    ap.add_argument("--root", help="REB root to write under (default ~/eta-data/reb); use a temp root for a smoke run")
    a = ap.parse_args(argv)
    if a.write and a.dry_run:
        ap.error("--write and --dry-run are exclusive")
    a.min_minutes, a.identified = 0, False
    print(json.dumps({"lane": a.lane, "write": a.write, "counts": run(a, a.lane, root=a.root)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
