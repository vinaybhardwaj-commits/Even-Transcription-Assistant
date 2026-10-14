#!/usr/bin/env python3
"""LISTEN-E3-CARDIOLOGY steps 4 (sampling) + extraction. Run only after diarize_windows.py has
written all 10 out/diarize/<window_id>.json files.

Room centroid (no ground truth exists yet — that is the whole point of tonight): for each window,
the speaker_idx with the most total speech is treated as the provisional "dominant speaker" (in an
OPD encounter the doctor usually dominates airtime — a heuristic, not a label, stated here plainly
since the order names 'the current machine score against the room centroid' without pinning down
how that centroid is built). room_primary = mean of the 10 windows' dominant-speaker embeddings.
Every turn in every window (every speaker_idx, not just the dominant one) is then scored by cosine
against this one centroid.

Clip length: turns are eligible at >=1.5s. A turn <=8s is used whole (so natural clips run
1.5-8s); a turn >8s takes its middle 8s. This is a stated reading of '3-8s (for a longer turn take
the middle 8s)', not a settled spec — flagged in the report.
"""
import base64
import json
import math
import os
import random
import struct

import audio_source

OUT = os.path.expanduser("~/dev/_fable/e3kit/out")
DIARIZE_DIR = os.path.join(OUT, "diarize")
CLIPS_DIR = os.path.join(OUT, "listen_clips")
MIN_DUR_S = 1.5
CLIP_CAP_S = 8.0
CTX_S = 3.0
N_TOTAL = 150
N_REPEATS = 10
N_UNIQUE = N_TOTAL - N_REPEATS
BUCKETS = {"low": (-1.0, 0.55), "borderline": (0.55, 0.75), "high": (0.75, 1.01)}
PER_GROUP_CAP = 10  # per (window_id, speaker_idx). Raised from 6 after seeing the real data: EVERY
# high-scoring turn (score>=0.75) is speaker_idx 0 of one of the 6 productive windows (6 groups
# total) -- the room centroid separates "dominant speaker" from everyone else cleanly, with a real
# gap between ~0.50 and ~0.75 and ZERO turns landing in 0.55-0.75 (see report). A cap of 6 there
# isn't protecting cluster diversity (there is only one real high-scoring cluster per window); it
# was just under-filling the bucket. Low-bucket diversity across MANY real clusters is unaffected.
SEED = 23

os.makedirs(CLIPS_DIR, exist_ok=True)


def to_vec(b64):
    raw = base64.b64decode(b64)
    return struct.unpack("<%df" % (len(raw) // 4), raw)


def cos(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else None


def mean_vec(vs):
    n = len(vs); d = len(vs[0])
    return [sum(v[i] for v in vs) / n for i in range(d)]


def load_windows():
    windows = {}
    for fn in sorted(os.listdir(DIARIZE_DIR)):
        if not fn.endswith(".json"):
            continue
        wid = fn[:-5]
        j = json.load(open(os.path.join(DIARIZE_DIR, fn)))
        windows[wid] = j
    return windows


def window_start_ms(wid):
    import re
    m = re.search(r"_(\d{10,})_", wid)
    return int(m.group(1))


def window_session_id(wid):
    # bw_<suffix>_<ms>_primary -> bs_<suffix>
    parts = wid.split("_")
    return "bs_" + parts[1]


def build_centroid(windows):
    dom_vecs = []
    for wid, j in windows.items():
        speakers = j.get("speakers") or []
        if not speakers:
            continue
        dom = max(speakers, key=lambda s: s.get("total_speech_sec") or 0)
        dom_vecs.append(to_vec(dom["embedding_base64"]))
    if len(dom_vecs) < 2:
        raise RuntimeError("need >=2 windows with a dominant speaker to build a centroid; got %d" % len(dom_vecs))
    return mean_vec(dom_vecs)


def collect_turns(windows, centroid):
    turns = []
    for wid, j in windows.items():
        wstart = window_start_ms(wid)
        sid = window_session_id(wid)
        vecs = {s["idx"]: to_vec(s["embedding_base64"]) for s in (j.get("speakers") or [])}
        for seg in j.get("transcript_segments") or []:
            dur_s = (seg["end_ms"] - seg["start_ms"]) / 1000.0
            if dur_s < MIN_DUR_S or seg["speaker_idx"] not in vecs:
                continue
            score = cos(vecs[seg["speaker_idx"]], centroid)
            if dur_s <= CLIP_CAP_S:
                cs, ce = seg["start_ms"], seg["end_ms"]
            else:
                mid = (seg["start_ms"] + seg["end_ms"]) / 2
                cs, ce = mid - CLIP_CAP_S * 500, mid + CLIP_CAP_S * 500
            turns.append({
                "window_id": wid, "session_id": sid, "speaker_idx": seg["speaker_idx"],
                "score": round(score, 4), "start_ms": wstart + int(cs), "end_ms": wstart + int(ce),
                "dur_s": round((ce - cs) / 1000.0, 2), "embedding_base64": base64.b64encode(struct.pack("<%df" % len(vecs[seg["speaker_idx"]]), *vecs[seg["speaker_idx"]])).decode(),
            })
    return turns


def bucket_of(score):
    for name, (lo, hi) in BUCKETS.items():
        if lo <= score < hi:
            return name
    return "high"


def stratified_sample(turns, rng):
    by_bucket = {"low": [], "borderline": [], "high": []}
    for t in turns:
        by_bucket[bucket_of(t["score"])].append(t)
    for b in by_bucket:
        rng.shuffle(by_bucket[b])

    target = {"low": N_UNIQUE // 3, "borderline": N_UNIQUE // 3}
    target["high"] = N_UNIQUE - target["low"] - target["borderline"]

    chosen = []
    group_count = {}
    for bname, want in target.items():
        pool = by_bucket[bname]
        got = 0
        for t in pool:
            key = (t["window_id"], t["speaker_idx"])
            if group_count.get(key, 0) >= PER_GROUP_CAP:
                continue
            chosen.append(t); group_count[key] = group_count.get(key, 0) + 1; got += 1
            if got >= want:
                break
        if got < want:
            print("WARNING: bucket %s only had %d eligible after the per-group cap (wanted %d)" % (bname, got, want))
    return chosen


def finalize_order(chosen, rng):
    """Shuffle the unique clips, then insert each of the 10 repeats directly at a position after its
    original (with a gap of >=2 OTHER unique clips in between wherever the original isn't too close
    to the end) — a direct construction, not rejection sampling: sampling a fully random order and
    hoping all 10 'repeat must follow original' constraints hold by chance needs far more than a
    couple hundred tries (each constraint is independently ~50/50), which is what failed here first."""
    uniques = list(chosen)
    rng.shuffle(uniques)
    for i, t in enumerate(uniques):
        t["clip_id"] = "c%04d" % i
    index_of = {t["clip_id"]: i for i, t in enumerate(uniques)}

    repeats_src = rng.sample(uniques, min(N_REPEATS, len(uniques)))
    insert_after = {}  # unique-list index -> list of repeat dicts to place right after it
    for j, src in enumerate(repeats_src):
        rep = dict(src)
        rep["clip_id"] = "r%04d" % j
        rep["is_repeat_of"] = src["clip_id"]
        oi = index_of[src["clip_id"]]
        lo = min(oi + 2, len(uniques) - 1)
        target = rng.randint(lo, len(uniques) - 1)
        insert_after.setdefault(target, []).append(rep)

    all_clips = []
    for i, t in enumerate(uniques):
        all_clips.append(t)
        for rep in insert_after.get(i, []):
            all_clips.append(rep)

    pos = {c["clip_id"]: i for i, c in enumerate(all_clips)}
    for c in all_clips:
        if c.get("is_repeat_of"):
            assert pos[c["clip_id"]] > pos[c["is_repeat_of"]], "repeat landed before its original"
    return all_clips


def turn_key(session_id, start_ms, end_ms):
    """Stable, content-addressed filename key for a turn -- NOT the clip_id. Fix (23 Sep, Fable):
    the previous scheme keyed audio files by clip_id, and a clip_id's meaning (which turn it points
    at) can change between build_and_sample.py runs (a shuffle/ordering-logic change reassigns which
    turn gets called 'c0000'). extract_all() skipping a file that already exists then left stale
    audio under a reused clip_id name. Keying by the turn's own identity means the cache is correct
    no matter how clip_id assignment changes: same turn -> same file, always; a changed clip_id
    just points at a different (still correct) file, and a genuinely new turn gets a new file."""
    import hashlib
    h = hashlib.sha1(("%s|%d|%d" % (session_id, start_ms, end_ms)).encode()).hexdigest()[:16]
    return h


def extract_all(clips):
    for c in clips:
        key = turn_key(c["session_id"], c["start_ms"], c["end_ms"])
        c["audio_key"] = key
        main_path = os.path.join(CLIPS_DIR, "turn_%s.m4a" % key)
        ctx_path = os.path.join(CLIPS_DIR, "turn_%s.ctx.m4a" % key)
        if not os.path.exists(main_path):
            audio_source.extract_clip(c["session_id"], c["start_ms"], c["end_ms"], main_path, fmt="m4a")
        if not os.path.exists(ctx_path):
            audio_source.extract_clip(c["session_id"], c["start_ms"] - int(CTX_S * 1000), c["end_ms"] + int(CTX_S * 1000), ctx_path, fmt="m4a")


def main():
    rng = random.Random(SEED)
    windows = load_windows()
    print("windows loaded:", len(windows))
    centroid = build_centroid(windows)
    turns = collect_turns(windows, centroid)
    print("eligible turns (>=1.5s):", len(turns))
    from collections import Counter
    print("by bucket:", Counter(bucket_of(t["score"]) for t in turns))
    chosen = stratified_sample(turns, rng)
    print("chosen unique:", len(chosen))
    all_clips = finalize_order(chosen, rng)
    print("total with repeats:", len(all_clips))
    extract_all(all_clips)
    manifest = {"clips": [{k: c[k] for k in ("clip_id", "window_id", "session_id", "speaker_idx", "score", "start_ms", "end_ms", "is_repeat_of", "embedding_base64", "audio_key") if k in c} for c in all_clips]}
    json.dump(manifest, open(os.path.join(OUT, "clips_manifest.json"), "w"), indent=1)
    print("wrote", os.path.join(OUT, "clips_manifest.json"), "n=", len(all_clips))


if __name__ == "__main__":
    main()
