#!/usr/bin/env python3
"""
VAD-V3 candidate: Whisper's own no_speech_prob per 30s chunk, as a VAD
signal (not a transcription -- counts/probabilities only, per the order's
"no transcript text" rule). Uses a small model (not large-v3, which is
reserved for H1's truth-check on gcp-l4) so this is CPU-feasible on a
light machine like air. A chunk with no_speech_prob < threshold is "speech".

Usage: python3 run_whisper_nospeech.py --data-dir DATA_DIR --ref-dir REF_DIR \
    --model small --log-file LOG --out results.json
"""
import argparse, json, os, time, wave
import numpy as np
import whisper

CHUNK_S = 30.0
THRESHOLDS = [0.3, 0.5, 0.7]  # no_speech_prob below this = keep as speech



def _dur(path):
    with wave.open(path, "rb") as _w:
        return _w.getnframes() / _w.getframerate()


def log(msg, log_file):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if log_file:
        with open(log_file, "a") as fh:
            fh.write(line + "\n")


def read_wav_float32(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    arr = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    return arr, sr


def pyannote_merged_intervals(ref_path):
    d = json.load(open(ref_path))
    segs = d["output"]["diarization"]
    ivs = sorted((s["start"], s["end"]) for s in segs)
    merged = []
    for s, e in ivs:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def cut_stats(pyannote_ivs, keep_ivs):
    total = sum(e - s for s, e in pyannote_ivs)
    if total == 0:
        return 0.0, 0.0
    cut = 0.0
    for ps, pe in pyannote_ivs:
        covered = 0.0
        for ss, se in keep_ivs:
            if se <= ps:
                continue
            if ss >= pe:
                break
            covered += max(0.0, min(pe, se) - max(ps, ss))
        cut += max(0.0, (pe - ps) - covered)
    return cut, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="whisper_nospeech_results.json")
    args = ap.parse_args()

    log(f"loading whisper {args.model}", args.log_file)
    model = whisper.load_model(args.model)
    log("model loaded", args.log_file)

    data_dir = os.path.abspath(args.data_dir)
    ref_dir = os.path.abspath(args.ref_dir)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    log(f"{len(files)} windows x {CHUNK_S}s chunks x {len(THRESHOLDS)} thresholds", args.log_file)

    per_window_chunks = {}  # wid -> list of (start_s, end_s, no_speech_prob)
    for i, f in enumerate(files):
        wid = f[:-4]  # full stem: windows in the same room share a 2-token prefix
        arr, sr = read_wav_float32(os.path.join(data_dir, f))
        t0 = time.time()
        result = model.transcribe(arr, language="en", word_timestamps=False, fp16=False,
                                   condition_on_previous_text=False)
        chunks = []
        for seg in result.get("segments", []):
            chunks.append((seg["start"], seg["end"], seg.get("no_speech_prob", 1.0)))
        per_window_chunks[wid] = chunks
        log(f"[{i+1}/{len(files)}] {wid} done, {len(chunks)} segments ({time.time()-t0:.1f}s)", args.log_file)

    results = {t: [] for t in THRESHOLDS}
    for f in files:
        wid = f[:-4]  # full stem: windows in the same room share a 2-token prefix
        ref_files = [r for r in os.listdir(ref_dir) if r.startswith(wid + "_") and r.endswith("_pyannote.json")]
        if not ref_files or wid not in per_window_chunks:
            continue
        pyannote_ivs = pyannote_merged_intervals(os.path.join(ref_dir, ref_files[0]))
        for thresh in THRESHOLDS:
            ivs = [(s, e) for s, e, p in per_window_chunks[wid] if p < thresh]
            cut, total = cut_stats(pyannote_ivs, ivs)
            sent = sum(e - s for s, e in ivs)
            results[thresh].append({"wid": wid, "cut_pct": cut / total * 100 if total else 0,
                                     "sent_s": sent, "total_s": total, "dur_s": _dur(os.path.join(data_dir, f))})

    summary = {}
    for thresh, rows in results.items():
        if not rows:
            continue
        tot_c = sum(r["cut_pct"] / 100 * r["total_s"] for r in rows)
        tot_p = sum(r["total_s"] for r in rows)
        tot_s = sum(r["sent_s"] for r in rows)
        worst = max(rows, key=lambda r: r["cut_pct"])
        summary[f"nospeech_lt_{thresh}"] = {
            "overall_cut_pct": round(tot_c / tot_p * 100, 2) if tot_p else 0,
            "worst_window": worst["wid"], "worst_cut_pct": round(worst["cut_pct"], 2),
            "avg_sent_pct": round(tot_s / sum(r["dur_s"] for r in rows) * 100, 1),
            "all_le_2pct": all(r["cut_pct"] <= 2.0 for r in rows),
        }
    json.dump({"rows": results, "summary": summary}, open(args.out, "w"), indent=2)
    log(f"WHISPER-NOSPEECH SUMMARY: {json.dumps(summary, indent=2)}", args.log_file)


if __name__ == "__main__":
    main()
