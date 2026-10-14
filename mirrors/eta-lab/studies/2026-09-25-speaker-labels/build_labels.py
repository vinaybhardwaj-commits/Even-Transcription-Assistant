#!/usr/bin/env python3
"""337e: turn Nemotron turn JSONLs into per-window speaker-label files. BOX ONLY (0600), NO transcript text, NOT pushed anywhere (refuter-2 #2133: no approved vault kind; away order).
For each window in the given results JSONL(s) that has a vault run record under ~/eta-data/{hist,hist-mining}/runs: labels/<room>/<date>/<window>.json =
  {schema, run, window, room, date, record_path (relative to ~/eta-data), run_sha256 (sha256 of that record file's bytes), engine, engine_params, audio_s, n_speakers, n_turns, turns,
   letters {speaker id -> A/B/..}, segments [{idx (index into the record's segments list), speaker, purity, speech_s, coverage, unlabeled, mixed, sequence}], skipped_refused [idx...]}.
Only non-refused segments with end>start are labelled (same rule as score_reference.py). Turns are wall-clock seconds from the window start (Nemotron ran on the wall-clock window audio).
usage: build_labels.py <out_dir> <turns.jsonl>... [--limit N] ; prints counts only."""
import glob, hashlib, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import speaker_labels as S
HOME = os.path.expanduser("~/eta-data")
PARAMS = dict(model="nvidia/Nemotron-3-Diarization", config="offline spkcache 264 fifo 40 chunk 340 right-context 40 update 300", segment_rule=f"unlabeled<{S.MIN_SPEECH_S}s; mixed second>={S.MIXED_SECOND:.0%} and >=2s")


def index_records():
    """window_id -> record path (first run in sorted order that has segments; sorted so the choice is deterministic)."""
    seen = {}
    for root in ("hist", "hist-mining"):
        for p in sorted(glob.glob(f"{HOME}/{root}/runs/*/*/*/*.json")):
            wid = os.path.basename(p)[:-5]
            if wid not in seen: seen[wid] = p
    return seen


def label_window(rec_path, turns, audio_s=None):
    raw = open(rec_path, "rb").read(); rec = json.loads(raw)
    segs = rec["segments"]; keep = [i for i, x in enumerate(segs) if not x.get("refused") and x["end_s"] > x["start_s"]]
    turns = [tuple(t) for t in turns]
    out = S.assign([(segs[i]["start_s"], segs[i]["end_s"]) for i in keep], turns) if keep else []
    for o in out: o["idx"] = keep[o["idx"]]
    return dict(schema="diarlabels/1", run=rec["run_id"], window=rec["window_id"], room=rec["room_id"], date=rec["start"][:10], record_path=os.path.relpath(rec_path, HOME),
                run_sha256=hashlib.sha256(raw).hexdigest(), engine="nemotron-3", engine_params=PARAMS, audio_s=audio_s, n_speakers=len({s for _, _, s in turns}), n_turns=len(turns),
                turns=[[round(a, 3), round(b, 3), s] for a, b, s in turns], letters=S.letters(turns), segments=out,
                skipped_refused=sorted(set(range(len(segs))) - set(keep)))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument("out_dir"); ap.add_argument("turns", nargs="+"); ap.add_argument("--limit", type=int); a = ap.parse_args()
    out_dir = os.path.expanduser(a.out_dir); idx = index_records(); n = missing = 0
    for f in a.turns:
        for l in open(f):
            if a.limit and n >= a.limit: break
            j = json.loads(l); p = idx.get(j["window_id"])
            if not p: missing += 1; continue
            d = label_window(p, j["turns"], j.get("audio_s"))
            dst = os.path.join(out_dir, d["room"], d["date"], d["window"] + ".json"); os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
            with os.fdopen(os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh: json.dump(d, fh)
            n += 1
    print(f"labelled {n} windows, {missing} without a record")
