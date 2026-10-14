#!/usr/bin/env python3
"""
M4 + M5 from eta-refuter-2's review. Seed fixed (20260924). Audio stays LOCAL (--pack-dir is outside git).

M4  Cut-span audit: take regions the frozen candidate U(S_all3,W0)+pad1.0s CUTS where pyannote.ai says
    silence (>= 3 s), sample clips at random, run whisper.cpp large-v3-turbo (-mc 0) on each, and count
    words. Speech pyannote.ai MISSED shows up as speech-like output inside a cut span. Counts only;
    transcript JSON is shredded. Also runs the same on clips from KEPT teacher-silence spans as a baseline.
M5  Listening pack v2: random offsets, stratified by window, shuffled, opaque ids, three answers +
    "can't tell". Content: disputed spans (teacher speech, Silero-base silent), M4 clips, positive
    controls (teacher speech Silero keeps), negative controls (teacher silence, all arms silent).
    The answer key is written to a separate file the listener never sees.
"""
import argparse, collections, json, os, random, subprocess, sys, wave
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_ensembles import merge, union, pad  # noqa: E402

WB = "/home/eta/vad/work/whisper-cpp-prod/whisper.cpp"
SR = 16000


def teacher(path):
    return merge([(s["start"], s["end"]) for s in json.load(open(path))["output"]["diarization"]])


def complement(ivs, dur):
    out, t = [], 0.0
    for s, e in merge(ivs):
        if s > t:
            out.append((t, s))
        t = max(t, e)
    if t < dur:
        out.append((t, dur))
    return out


def intersect(a, b):
    out, i, j = [], 0, 0
    a, b = merge(a), merge(b)
    while i < len(a) and j < len(b):
        s, e = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if e > s:
            out.append((s, e))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def cut_clip(wav_path, start, dur, out_path):
    with wave.open(wav_path, "rb") as w:
        sr = w.getframerate(); w.setpos(int(start * sr)); raw = w.readframes(int(dur * sr))
    with wave.open(out_path, "wb") as o:
        o.setnchannels(1); o.setsampwidth(2); o.setframerate(sr); o.writeframes(raw)


def draw(rng, spans, clip_s):
    s, e = spans
    L = min(clip_s, e - s)
    off = rng.uniform(s, e - L)
    return off, L


def whisper_counts(clip, tmp, gpu_lock):
    base = os.path.join(tmp, "audit")
    subprocess.run(["flock", "-w", "1800", gpu_lock, f"{WB}/build-cuda/bin/whisper-cli", "-m", f"{WB}/models/ggml-large-v3-turbo.bin",
                    "-f", clip, "-nth", "0.7", "-sns", "-mc", "0", "-oj", "-of", base, "-np"], capture_output=True, text=True, timeout=1900)
    jp = base + ".json"
    try:
        segs = [s["text"].strip() for s in json.load(open(jp))["transcription"]]
    finally:
        if os.path.exists(jp):
            subprocess.run(["shred", "-u", jp])
    c = collections.Counter(t.lower() for t in segs if t)
    distinct_words = sum(len(t.split()) for t in c)
    return {"segments": len(segs), "distinct_text_words": distinct_words,
            "top_text_share": round(c.most_common(1)[0][1] / max(1, len(segs)), 2) if c else 0.0}


def load_sets(specs):
    wins = []
    for name, cache, data, ref in specs:
        for f in sorted(os.listdir(cache)):
            wid = f[:-5]
            c = json.load(open(os.path.join(cache, f)))
            A = {k: [tuple(x) for x in v] for k, v in c["arms"].items()}
            wins.append({"set": name, "wid": wid, "dur": c["dur"], "A": A, "wav": os.path.join(data, wid + ".wav"),
                         "teacher": teacher(os.path.join(ref, wid + "_pyannote.json"))})
    return wins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gpu-lock", default="/home/eta/gpu.lock")
    ap.add_argument("--n-m4", type=int, default=40)
    a = ap.parse_args()
    rng = random.Random(20260924)
    R = "/home/eta/vad/work/vad-v3-rerun"
    wins = load_sets([
        ("58", f"{R}/ens_cache_58", "/home/eta/vad/work/vad-v3-58/data", "/home/eta/vad/work/vad-v3-58/data-ref"),
        ("bake20", f"{R}/ens_cache_bake20", "/home/eta/eta-data/diar-lab/data/bake20", "/home/eta/eta-data/diar-lab/data/bake20-ref"),
    ])
    tmp = os.path.join(a.pack_dir, "tmp"); os.makedirs(tmp, exist_ok=True)
    m4dir = os.path.join(a.pack_dir, "m4_clips"); os.makedirs(m4dir, exist_ok=True)

    # ---- M4: candidate cuts inside teacher silence
    cand_cut, kept_sil = [], []
    for w in wins:
        keep = pad(union(w["A"]["S_all3"], w["A"]["W0"]), 1.0, w["dur"])
        silence = complement(w["teacher"], w["dur"])
        for s, e in intersect(complement(keep, w["dur"]), silence):
            if e - s >= 3.0:
                cand_cut.append((w, (s, e)))
        for s, e in intersect(keep, silence):
            if e - s >= 3.0:
                kept_sil.append((w, (s, e)))
    m4 = []
    for label, pool, n in (("cut_by_candidate", cand_cut, a.n_m4), ("kept_teacher_silence", kept_sil, 15)):
        for w, span in rng.sample(pool, min(n, len(pool))):
            off, L = draw(rng, span, 6.0)
            cid = f"m4_{len(m4):03d}"
            path = os.path.join(m4dir, cid + ".wav")
            cut_clip(w["wav"], off, L, path)
            m4.append({"id": cid, "group": label, "set": w["set"], "wid": w["wid"], "start_s": round(off, 2), "dur_s": round(L, 2),
                       **whisper_counts(path, tmp, a.gpu_lock)})
    summ = {}
    for g in ("cut_by_candidate", "kept_teacher_silence"):
        rows = [r for r in m4 if r["group"] == g]
        summ[g] = {"n_clips": len(rows), "pool_spans": len(cand_cut if g == "cut_by_candidate" else kept_sil),
                   "clips_0_words": sum(r["distinct_text_words"] == 0 for r in rows),
                   "clips_1_to_5_words": sum(1 <= r["distinct_text_words"] <= 5 for r in rows),
                   "clips_ge6_words": sum(r["distinct_text_words"] >= 6 for r in rows)}

    # ---- M5 listening pack
    pack = os.path.join(a.pack_dir, "clips"); os.makedirs(pack, exist_ok=True)
    items = []

    def add(kind, w, s, e, clip_s=10.0):
        off, L = draw(rng, (s, e), clip_s)
        items.append({"kind": kind, "set": w["set"], "wid": w["wid"], "start_s": round(off, 2), "dur_s": round(L, 2), "_wav": w["wav"], "_off": off, "_len": L})

    disputed = []  # teacher speech AND S_base silent, >= 3 s
    for w in wins:
        for s, e in intersect(w["teacher"], complement(w["A"]["S_base"], w["dur"])):
            if e - s >= 3.0:
                disputed.append((w, (s, e)))
    by_w = collections.defaultdict(list)
    for w, sp in disputed:
        by_w[w["wid"]].append((w, sp))
    wids = sorted(by_w); rng.shuffle(wids)
    for i in range(16):  # round-robin over windows => stratified, not "longest spans"
        wid = wids[i % len(wids)]
        w, sp = rng.choice(by_w[wid]); add("disputed_span", w, *sp)
    for r in [r for r in m4 if r["group"] == "cut_by_candidate" and r["distinct_text_words"] >= 6][:6]:
        w = next(x for x in wins if x["wid"] == r["wid"]); add("m4_cut_speechlike", w, r["start_s"], r["start_s"] + r["dur_s"])
    for r in rng.sample([r for r in m4 if r["group"] == "cut_by_candidate" and r["distinct_text_words"] < 6], 3):
        w = next(x for x in wins if x["wid"] == r["wid"]); add("m4_cut_random", w, r["start_s"], r["start_s"] + r["dur_s"])
    pos = [(w, sp) for w in wins for sp in intersect(w["teacher"], w["A"]["S_base"]) if sp[1] - sp[0] >= 10]
    for w, sp in rng.sample(pos, 5):
        add("control_positive", w, *sp)
    neg = [(w, sp) for w in wins for sp in intersect(complement(w["teacher"], w["dur"]), complement(w["A"]["S_base"], w["dur"])) if sp[1] - sp[0] >= 10]
    for w, sp in rng.sample(neg, 5):
        add("control_negative", w, *sp)
    rng.shuffle(items)
    key = []
    for i, it in enumerate(items):
        cid = f"c{i+1:02d}"
        cut_clip(it["_wav"], it["_off"], it["_len"], os.path.join(pack, cid + ".wav"))
        key.append({"id": cid, **{k: v for k, v in it.items() if not k.startswith("_")}})
    json.dump(key, open(os.path.join(a.pack_dir, "ANSWER_KEY_DO_NOT_SHOW.json"), "w"), indent=1)
    json.dump({"ids": [k["id"] for k in key]}, open(os.path.join(pack, "manifest.json"), "w"))
    json.dump({"seed": 20260924, "m4_summary": summ, "m4_clips": m4, "pack_counts": dict(collections.Counter(k["kind"] for k in key))},
              open(a.out, "w"), indent=2)
    print(json.dumps({"m4_summary": summ, "pack_counts": dict(collections.Counter(k["kind"] for k in key))}, indent=1))


if __name__ == "__main__":
    main()
