#!/usr/bin/env python3
"""
VAD-V3 production arm, parts (b) and (c) of Fable's 22:35 order.

(b) transcript WORD COUNT with --vad vs without, same model (large-v3-turbo),
    same decode flags (--no-speech-thold 0.7 --suppress-nst), whisper.cpp built
    with CUDA on the box T4 (never the Mini).
(c) hallucination on silent / near-silent windows WITHOUT --vad: words emitted
    in segments that do not overlap ANY pyannote.ai teacher speech, and
    segments that repeat verbatim >=3 times in a window.

COUNTS ONLY. Transcript JSON is parsed in memory and shredded immediately;
no text is printed, logged or saved (order: no transcript text in reports).

Assumption: language left at whisper-cli's default (en); the live server's
language setting was not visible from here.
"""
import argparse, json, os, subprocess, time, wave, collections

WB = "/home/eta/vad/work/whisper-cpp-prod/whisper.cpp"


def log(msg, lf):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if lf:
        open(lf, "a").write(line + "\n")


def teacher_ivs(path):
    segs = json.load(open(path))["output"]["diarization"]
    ivs = sorted((s["start"], s["end"]) for s in segs)
    m = []
    for s, e in ivs:
        if m and s <= m[-1][1]:
            m[-1] = (m[-1][0], max(m[-1][1], e))
        else:
            m.append((s, e))
    return m


def overlap(a0, a1, ivs):
    o = 0.0
    for s, e in ivs:
        if e <= a0:
            continue
        if s >= a1:
            break
        o += max(0.0, min(a1, e) - max(a0, s))
    return o


def transcribe(wav, vad, tmpdir, tag, gpu_lock, extra=()):
    base = os.path.join(tmpdir, tag)
    cmd = [f"{WB}/build-cuda/bin/whisper-cli", "-m", f"{WB}/models/ggml-large-v3-turbo.bin",
           "-f", wav, "-nth", "0.7", "-sns", "-oj", "-of", base, "-np"]
    cmd += list(extra)
    if vad:
        cmd += ["--vad", "-vm", f"{WB}/models/ggml-silero-v6.2.0.bin",
                "-vt", "0.5", "-vspd", "250", "-vsd", "100", "-vp", "30"]
    t0 = time.time()
    subprocess.run(["flock", "-w", "1800", gpu_lock] + cmd, capture_output=True, text=True, timeout=1900)
    wall = time.time() - t0
    jpath = base + ".json"
    try:
        segs = json.load(open(jpath))["transcription"]
        parsed = [(s["offsets"]["from"] / 1000.0, s["offsets"]["to"] / 1000.0, s["text"].strip()) for s in segs]
    finally:
        if os.path.exists(jpath):
            subprocess.run(["shred", "-u", jpath])
    return parsed, wall


def count(parsed, tivs):
    words = sum(len(t.split()) for _, _, t in parsed)
    in_speech = off_words = off_segs = 0
    for a, b, t in parsed:
        w = len(t.split())
        if overlap(a, b, tivs) > 0:
            in_speech += w
        else:
            off_words += w
            off_segs += 1
    norm = collections.Counter(t.lower() for _, _, t in parsed if t)
    repeated = sum(c for c in norm.values() if c >= 3)
    seen, distinct_words, distinct_in_speech = set(), 0, 0
    for a, b, t in parsed:
        k = t.lower()
        if not t or k in seen:
            continue
        seen.add(k)
        w = len(t.split())
        distinct_words += w
        if overlap(a, b, tivs) > 0:
            distinct_in_speech += w
    top_share = round(norm.most_common(1)[0][1] / max(1, len(parsed)), 3) if norm else 0.0
    return {"distinct_text_words": distinct_words, "distinct_text_words_in_teacher_speech": distinct_in_speech,
            "distinct_texts": len(norm), "top_text_segment_share": top_share,"words": words, "segments": len(parsed), "words_in_teacher_speech": in_speech,
            "off_speech_words": off_words, "off_speech_segments": off_segs,
            "segments_in_verbatim_repeat_groups_ge3": repeated}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--gate-json", required=True, help="production_gate_58.json, to pick windows")
    ap.add_argument("--tmpdir", required=True)
    ap.add_argument("--gpu-lock", default="/home/eta/gpu.lock")
    ap.add_argument("--n-loss", type=int, default=5)
    ap.add_argument("--n-ok", type=int, default=3)
    ap.add_argument("--n-quiet", type=int, default=4)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="gate_transcripts_results.json")
    a = ap.parse_args()
    os.makedirs(a.tmpdir, exist_ok=True)

    rows = json.load(open(a.gate_json))["rows"]
    busy = [r for r in rows if r["total_s"] >= 60]
    loss = sorted(busy, key=lambda r: -r["cut_pct"])[:a.n_loss]
    ok = sorted(busy, key=lambda r: r["cut_pct"])[:a.n_ok]
    quiet = sorted(rows, key=lambda r: r["total_s"])[:a.n_quiet]
    plan = [(r, "high_loss") for r in loss] + [(r, "low_loss") for r in ok] + [(r, "near_silent") for r in quiet]
    seen, sel = set(), []
    for r, k in plan:
        if r["wid"] not in seen:
            seen.add(r["wid"]); sel.append((r, k))
    log(f"{len(sel)} windows selected", a.log_file)

    out = []
    for i, (r, kind) in enumerate(sel):
        wid = r["wid"]
        wav = os.path.join(a.data_dir, wid + ".wav")
        tiv = teacher_ivs(os.path.join(a.ref_dir, wid + "_pyannote.json"))
        row = {"wid": wid, "kind": kind, "teacher_speech_s": round(sum(e - s for s, e in tiv), 1),
               "gate_cut_pct": round(r["cut_pct"], 2)}
        for mode, vad, extra in (("novad", False, ()), ("novad_mc0", False, ("-mc", "0")),
                                 ("vad", True, ()), ("vad_mc0", True, ("-mc", "0"))):
            parsed, wall = transcribe(wav, vad, a.tmpdir, f"{i}_{mode}", a.gpu_lock, extra)
            row[mode] = count(parsed, tiv)
            row[mode]["wall_s"] = round(wall, 1)
        out.append(row)
        log(f"[{i+1}/{len(sel)}] {wid} {kind} teacher={row['teacher_speech_s']}s "
            f"distinct-text words novad={row['novad']['distinct_text_words']} novad_mc0={row['novad_mc0']['distinct_text_words']} "
            f"vad={row['vad']['distinct_text_words']} vad_mc0={row['vad_mc0']['distinct_text_words']} "
            f"top-text share novad={row['novad']['top_text_segment_share']} novad_mc0={row['novad_mc0']['top_text_segment_share']}", a.log_file)

    tot = lambda m, k: sum(r[m][k] for r in out)
    summary = {"n_windows": len(out)}
    for m in ("novad", "novad_mc0", "vad", "vad_mc0"):
        summary[m] = {"raw_words": tot(m, "words"), "distinct_text_words": tot(m, "distinct_text_words"),
                      "distinct_text_words_in_teacher_speech": tot(m, "distinct_text_words_in_teacher_speech"),
                      "off_speech_words": tot(m, "off_speech_words"),
                      "mean_top_text_segment_share": round(sum(r[m]["top_text_segment_share"] for r in out) / len(out), 3)}
    json.dump({"rows": out, "summary": summary}, open(a.out, "w"), indent=2)
    log(f"SUMMARY {json.dumps(summary)}", a.log_file)


if __name__ == "__main__":
    main()
