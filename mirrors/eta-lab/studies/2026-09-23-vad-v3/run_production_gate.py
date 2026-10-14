#!/usr/bin/env python3
"""
VAD-V3 -- PRODUCTION arm: measure the ACTUAL live whisper-server VAD gate,
not an assumed one. Uses the real whisper.cpp binary + the real
silero-v6.2.0 ggml VAD model (Fable: byte-identical to the Mini's
for-tests-silero-v6.2.0-ggml.bin), with the Mini's exact production
defaults (threshold 0.5 / min_silence 100ms / pad 30ms / min_speech 250ms --
these ARE whisper.cpp's own defaults, passed explicitly here for the record).

Built and run on this box (never the Mini production server), per Fable's
order. Measures (a) only -- labelled-speech loss under production defaults,
scored against the pyannote.ai teacher exactly like every other arm tonight.
(b) and (c) are separate scripts (transcript word count, hallucination check)
since they need the full whisper-cli transcription path, not just VAD.

Usage: python3 run_production_gate.py --data-dir DATA_DIR --ref-dir REF_DIR \
    --whisper-vad-bin PATH --vad-model PATH --log-file LOG --out results.json
"""
import argparse, json, os, re, subprocess, time, wave

SEG_RE = re.compile(r"Speech segment \d+: start = ([\d.]+), end = ([\d.]+)")


def log(msg, log_file):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if log_file:
        with open(log_file, "a") as fh:
            fh.write(line + "\n")


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


def run_vad(binpath, vad_model, wav_path, threshold, min_speech_ms, min_silence_ms, pad_ms):
    cmd = [binpath, "-f", wav_path, "-vm", vad_model, "--no-prints",
           "-vt", str(threshold), "-vspd", str(min_speech_ms),
           "-vsd", str(min_silence_ms), "-vp", str(pad_ms)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    ivs = []
    for m in SEG_RE.finditer(out.stdout):
        start_cs, end_cs = float(m.group(1)), float(m.group(2))
        ivs.append((start_cs / 100.0, end_cs / 100.0))  # centiseconds -> seconds
    return ivs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--whisper-vad-bin", required=True)
    ap.add_argument("--vad-model", required=True)
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--min-speech-ms", type=int, default=250)
    ap.add_argument("--min-silence-ms", type=int, default=100)
    ap.add_argument("--pad-ms", type=int, default=30)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="production_gate_results.json")
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    ref_dir = os.path.abspath(args.ref_dir)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    log(f"{len(files)} windows, production defaults: "
        f"thresh={args.threshold} min_speech={args.min_speech_ms}ms "
        f"min_silence={args.min_silence_ms}ms pad={args.pad_ms}ms", args.log_file)

    rows = []
    for i, f in enumerate(files):
        wid = f[:-4]  # full stem: windows in the same room share a 2-token prefix
        wav_path = os.path.join(data_dir, f)
        ref_files = [r for r in os.listdir(ref_dir) if r.startswith(wid + "_") and r.endswith("_pyannote.json")]
        if not ref_files:
            continue
        pyannote_ivs = pyannote_merged_intervals(os.path.join(ref_dir, ref_files[0]))
        t0 = time.time()
        ivs = run_vad(args.whisper_vad_bin, args.vad_model, wav_path, args.threshold,
                      args.min_speech_ms, args.min_silence_ms, args.pad_ms)
        cut, total = cut_stats(pyannote_ivs, ivs)
        sent = sum(e - s for s, e in ivs)
        cut_pct = cut / total * 100 if total else 0.0
        with wave.open(wav_path, "rb") as w:
            dur_s = w.getnframes() / w.getframerate()
        rows.append({"wid": wid, "cut_pct": cut_pct, "sent_s": sent, "total_s": total, "dur_s": dur_s})
        log(f"[{i+1}/{len(files)}] {wid}: cut={cut_pct:.2f}% sent={sent:.0f}s ({time.time()-t0:.1f}s)", args.log_file)

    tot_c = sum(r["cut_pct"] / 100 * r["total_s"] for r in rows)
    tot_p = sum(r["total_s"] for r in rows)
    tot_s = sum(r["sent_s"] for r in rows)
    worst = max(rows, key=lambda r: r["cut_pct"])
    summary = {
        "overall_cut_pct": round(tot_c / tot_p * 100, 2) if tot_p else 0,
        "worst_window": worst["wid"], "worst_cut_pct": round(worst["cut_pct"], 2),
        "avg_sent_pct": round(tot_s / sum(r["dur_s"] for r in rows) * 100, 1) if rows else 0,
        "n_windows_over_2pct": sum(1 for r in rows if r["cut_pct"] > 2.0),
        "n_windows_over_10pct": sum(1 for r in rows if r["cut_pct"] > 10.0),
        "all_le_2pct": all(r["cut_pct"] <= 2.0 for r in rows),
    }
    json.dump({"rows": rows, "summary": summary}, open(args.out, "w"), indent=2)
    log(f"PRODUCTION GATE SUMMARY (measured, not assumed): {json.dumps(summary, indent=2)}", args.log_file)


if __name__ == "__main__":
    main()
