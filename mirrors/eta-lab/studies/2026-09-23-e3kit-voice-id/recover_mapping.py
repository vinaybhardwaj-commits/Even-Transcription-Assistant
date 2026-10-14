#!/usr/bin/env python3
"""Recovery after the stale-audio bug (Fable, 23 Sep): clips_manifest.json no longer matches the
audio on disk (extract_all skips a file that already exists, so a manifest rewrite after audio had
already been extracted left stale filename->turn mappings). Rebuilds the full 618-turn candidate
universe (deterministic: diarize output + centroid math, no RNG), extracts EVERY candidate turn
with the exact same ffmpeg path as audio_source.extract_clip, and matches each of the 104 files on
disk by exact byte hash first (m4a/AAC encoding of the same input+args is deterministic, so a true
match is byte-identical), falling back to duration match only where no byte match exists. Writes
out/recovered_mapping.json. Does not touch answers.json/answers_log.json/progress.json."""
import hashlib
import json
import os

import audio_source
import build_and_sample as B

OUT = os.path.expanduser("~/dev/_fable/e3kit/out")
CLIPS_DIR = os.path.join(OUT, "listen_clips")
CANDIDATE_DIR = os.path.join(OUT, "recovery_candidates")
os.makedirs(CANDIDATE_DIR, exist_ok=True)


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    windows = B.load_windows()
    centroid = B.build_centroid(windows)
    turns = B.collect_turns(windows, centroid)
    print("candidate turn universe:", len(turns))

    # Extract every candidate turn's MAIN clip once, hash it.
    hash_to_turns = {}
    for i, t in enumerate(turns):
        cand_path = os.path.join(CANDIDATE_DIR, "cand_%04d.m4a" % i)
        if not os.path.exists(cand_path):
            audio_source.extract_clip(t["session_id"], t["start_ms"], t["end_ms"], cand_path, fmt="m4a")
        h = sha256(cand_path)
        t["_cand_idx"] = i
        t["_hash"] = h
        hash_to_turns.setdefault(h, []).append(t)
    print("distinct audio hashes among candidates:", len(hash_to_turns))

    # Hash every on-disk listening clip (main .m4a only; .ctx.m4a follows once the main is placed).
    on_disk = sorted(f for f in os.listdir(CLIPS_DIR) if f.endswith(".m4a") and ".ctx." not in f)
    print("on-disk main clips:", len(on_disk))

    unique_map, ambiguous, unmapped = {}, {}, []
    for fn in on_disk:
        clip_id = fn[:-4]
        h = sha256(os.path.join(CLIPS_DIR, fn))
        matches = hash_to_turns.get(h, [])
        if len(matches) == 1:
            unique_map[clip_id] = matches[0]
        elif len(matches) > 1:
            ambiguous[clip_id] = matches  # identical audio genuinely exists at >1 candidate turn (real duplicate content)
        else:
            unmapped.append(clip_id)

    print("mapped uniquely:", len(unique_map))
    print("ambiguous (byte-identical to >1 candidate):", len(ambiguous))
    print("unmapped (no byte match to any candidate):", len(unmapped))
    if unmapped:
        print("  unmapped ids:", unmapped)

    out = {
        "unique": {cid: {k: t[k] for k in ("session_id", "window_id", "speaker_idx", "score", "start_ms", "end_ms", "dur_s")} for cid, t in unique_map.items()},
        "ambiguous": {cid: [{k: t[k] for k in ("session_id", "window_id", "speaker_idx", "score", "start_ms", "end_ms", "dur_s")} for t in ts] for cid, ts in ambiguous.items()},
        "unmapped": unmapped,
    }
    json.dump(out, open(os.path.join(OUT, "recovered_mapping.json"), "w"), indent=1)
    print("wrote", os.path.join(OUT, "recovered_mapping.json"))


if __name__ == "__main__":
    main()
