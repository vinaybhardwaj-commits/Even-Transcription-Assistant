#!/usr/bin/env python3
"""337c: cut the audio of individual hist segments so they can be re-transcribed on eta-lab-l4.

A hist record (~/eta-data/hist/runs/<run>/<room>/<date>/<window>.json) holds `segments` with window-relative
start_s/end_s and `cut.chunks_used` (the 5-minute webm chunks, with started_at and duration_ms). Window time zero is
record["start"]. A segment's absolute time is start + start_s; the chunk that holds it is the one whose
[started_at, started_at + duration) covers it. Chunk files are in the shared cache
~/eta-data/hist-mining/audio as `<r2_key with / replaced by __>`.

The window audio is rebuilt with fleet's full_audio.assemble (the pipeline's own placement: wall clock, gaps silent), and
the segment is sliced from it. Skips (chunk not cached, beyond window, too short) are counted and reported.

PATIENT AUDIO. Output goes under ~/eta-data (0700 dir, 0600 files). The manifest carries record path, segment index,
language tag and duration only. No text is read into any log line or printed.

  cut_segments.py sample --n 60 --seed 1 --out DIR [--langs kn,hi,ta,ml,und]   # stratified test sample
  cut_segments.py list FILE --out DIR         # FILE: jsonl of {"record": relpath, "idx": n} (the flagged list)
"""
import argparse, hashlib, json, os, random, re, sys, wave
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-surgery-review-v2"))
import full_audio as fa

RUNS = os.path.expanduser("~/eta-data/hist")   # record paths are relative to this: runs/<run>/<room>/<date>/<window>.json or out/<date>_<room>/<window>.json
CACHE = os.path.expanduser("~/eta-data/hist-mining/audio")


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()


def chunk_path(r2_key):
    return os.path.join(CACHE, r2_key.replace("/", "__"))


INDIC = {"kn", "hi", "ta", "ml", "bn", "gu", "te", "mr", "pa"}


def force_lang(rec, seg):
    """Language to force on the re-run: the segment's own Indic tag; else the window's dominant Indic language; else the
    commonest Indic tag among the window's segments; else None (auto). Returns (code_or_None, basis)."""
    if seg.get("lang") in INDIC:
        return seg["lang"], "segment"
    if seg.get("lang") == "en":   # only the timing/quality controls; large-v3 auto-detect calls Indian-accented English Hindi/Kannada with p=1
        return "en", "segment"
    if rec.get("dominant_language") in INDIC:
        return rec["dominant_language"], "window_dominant"
    cnt = {}
    for s in rec.get("segments") or []:
        if s.get("lang") in INDIC:
            cnt[s["lang"]] = cnt.get(s["lang"], 0) + 1
    if cnt:
        return max(cnt, key=cnt.get), "window_commonest"
    return None, "none"


def seg_id(record_rel, idx):
    return hashlib.sha1(record_rel.encode()).hexdigest()[:10] + f"_{idx:03d}"


def load(record_rel):
    with open(os.path.join(RUNS, record_rel)) as f:
        return json.load(f)


_CT = None


def chunk_times():
    """r2_key -> [started_at, ended_at] for records written before cut.chunks_used existed (only chunk_keys). Built once by a read-only
    bench_chunk query into ~/eta-data/readable-rerun/r1/chunk_times.json."""
    global _CT
    if _CT is None:
        p = os.path.expanduser("~/eta-data/readable-rerun/r1/chunk_times.json")
        _CT = json.load(open(p)) if os.path.exists(p) else {}
    return _CT


def window_pcm(rec):
    """The window's audio exactly as the pipeline built it: fleet's full_audio.assemble (chunks placed on the wall clock at
    their started_at, gaps silent, later chunk wins an overlap), 16 kHz mono s16. Segment start_s/end_s index into this.
    (A first version cut each segment with ffmpeg -ss per chunk; it disagreed with the stored text on a 12-segment English
    control, this assembly agrees, so the assembly is the timing reference.)"""
    cut = rec.get("cut") or {}
    sel, files = [], {}
    used = cut.get("chunks_used") or [{"r2_key": k, "started_at": chunk_times()[k][0], "ended_at": chunk_times()[k][1]}
                                      for k in (cut.get("chunk_keys") or []) if k in chunk_times()]
    for c in used:
        idx = int(re.search(r"chunk_(\d+)", c["r2_key"]).group(1))
        p = chunk_path(c["r2_key"])
        if not os.path.exists(p):
            return None, "chunk_not_cached"
        sel.append({"idx": idx, "started_at": c["started_at"], "ended_at": c["ended_at"], "r2_key": c["r2_key"]})
        files[idx] = p
    if not sel:
        return None, "no_chunks"
    fa.SR = 16000
    return fa.assemble(sel, files, fa.utc(rec["start"]), fa.utc(rec["end"])), None


def cut_one(rec, seg, out_wav, pcm):
    a = int(float(seg["start_s"]) * 16000) * 2
    b = int(float(seg["end_s"]) * 16000) * 2
    if b - a < 16000:            # < 0.5 s
        return "too_short"
    if b > len(pcm):
        return "beyond_window"
    with wave.open(out_wav, "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000); f.writeframes(pcm[a:b])
    os.chmod(out_wav, 0o600)
    return None


def all_segments():
    import glob
    for f in sorted(glob.glob(os.path.join(RUNS, "runs/*/*/*/*.json"))):
        if ".attempt" in f:
            continue
        rel = os.path.relpath(f, RUNS)
        try:
            rec = json.load(open(f))
        except Exception:
            continue
        for i, s in enumerate(rec.get("segments") or []):
            yield rel, rec, i, s


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    a = sub.add_parser("sample")
    a.add_argument("--n", type=int, default=60)
    a.add_argument("--seed", type=int, default=1)
    a.add_argument("--langs", default="kn,hi,ta,ml,und,te,bn,gu")
    a.add_argument("--min-s", type=float, default=3.0)
    a.add_argument("--max-s", type=float, default=25.0)
    a.add_argument("--out", required=True)
    b = sub.add_parser("list")
    b.add_argument("file")
    b.add_argument("--out", required=True)
    b.add_argument("--shard", default="0/1", help="k/n: take every n-th record (by sorted record path) starting at k")
    args = ap.parse_args()

    os.makedirs(args.out, mode=0o700, exist_ok=True)
    os.chmod(args.out, 0o700)
    todo = []
    if args.mode == "sample":
        langs = args.langs.split(",")
        pool = {l: [] for l in langs}
        for rel, rec, i, s in all_segments():
            l = s.get("lang")
            if l in pool and not s.get("refused") and args.min_s <= s["end_s"] - s["start_s"] <= args.max_s:
                pool[l].append((rel, i))
        rnd = random.Random(args.seed)
        per = max(1, args.n // len(langs))
        for l in langs:
            rnd.shuffle(pool[l])
            todo += pool[l][:per]
        print("pool sizes", {l: len(v) for l, v in pool.items()}, file=sys.stderr)
    else:
        k, n = (int(x) for x in args.shard.split("/"))
        meta = {}
        for l in open(args.file):
            j = json.loads(l)
            meta[(j["record"], int(j["idx"]))] = j
        recs = sorted({json.loads(l)["record"] for l in open(args.file)})
        mine = {r for i, r in enumerate(recs) if i % n == k}
        for line in open(args.file):
            j = json.loads(line)
            if j["record"] in mine:
                todo.append((j["record"], int(j["idx"])))

    todo.sort()   # one window assembly per record, not per segment
    meta = locals().get("meta", {})
    man, skipped = [], {}
    cache = {}
    for rel, i in todo:
        if cache.get("rel") != rel:
            cache = {"rel": rel, "rec": load(rel), "pcm": None, "why": None, "built": False}
        rec = cache["rec"]
        s = rec["segments"][i]
        sid = seg_id(rel, i)
        wav = os.path.join(args.out, sid + ".wav")
        if os.path.exists(wav):
            why = None
        else:
            if not cache["built"]:      # assemble the window only when a segment of it still needs cutting
                cache["pcm"], cache["why"] = window_pcm(rec); cache["built"] = True
            why = cache["why"] or cut_one(rec, s, wav, cache["pcm"])
        if why:
            skipped[why] = skipped.get(why, 0) + 1
            continue
        fl, basis = force_lang(rec, s)
        row = meta.get((rel, i))
        if row is not None:       # the flagged list's forced_language (split-speaker's: window/room-month Indic label) wins over my own guess
            fl, basis = row.get("forced_language"), "flagged_list:" + str(row.get("forced_language_source"))
        man.append({"id": sid, "record": rel, "idx": i, "lang": s.get("lang"), "engine": s.get("engine"),
                    "dur_s": round(s["end_s"] - s["start_s"], 2), "force_lang": fl, "force_basis": basis,
                    "flagged_id": row.get("id") if row else None, "flag_score": row.get("score") if row else None})
    with open(os.path.join(args.out, "manifest.jsonl"), "w") as f:
        for m in man:
            f.write(json.dumps(m) + "\n")
    os.chmod(os.path.join(args.out, "manifest.jsonl"), 0o600)
    print(json.dumps({"cut": len(man), "skipped": skipped}))


if __name__ == "__main__":
    main()
