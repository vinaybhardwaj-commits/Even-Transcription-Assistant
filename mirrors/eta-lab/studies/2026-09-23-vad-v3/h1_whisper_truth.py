#!/usr/bin/env python3
"""
VAD-V3, H1 -- "the truth is wrong there". Whisper large-v3 on every disputed
span (pyannote.ai says speech, Silero says near-zero) plus the 3 controls.
Reports words/sec, no_speech_prob, avg_logprob per clip -- COUNTS ONLY, no
transcript text kept or printed (order's "not allowed" section).

Usage: python3 h1_whisper_truth.py --clips-dir ~/eta-lab-night/vad-v3/clips \
    --model large-v3 --out h1_results.json --log-file ~/eta-lab-night/logs/lab-mover.log
"""
import argparse, json, os, time, wave
import numpy as np
import whisper


def read_wav_float32(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    arr = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    assert sr == 16000, f"expected 16kHz, got {sr}"
    return arr


def log(msg, log_file):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if log_file:
        with open(log_file, "a") as fh:
            fh.write(line + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips-dir", required=True)
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--out", default="h1_results.json")
    ap.add_argument("--log-file", default=None)
    args = ap.parse_args()

    clips_dir = os.path.expanduser(args.clips_dir)
    manifest = json.load(open(os.path.join(clips_dir, "manifest.json")))

    log(f"loading whisper {args.model}", args.log_file)
    model = whisper.load_model(args.model)
    log("model loaded", args.log_file)

    rows = []
    for m in manifest:
        path = os.path.join(clips_dir, m["clip"])
        audio = read_wav_float32(path)
        t0 = time.time()
        result = model.transcribe(audio, language="en", word_timestamps=False, fp16=True)
        segs = result.get("segments", [])
        n_words = sum(len(s["text"].split()) for s in segs)
        avg_logprob = sum(s.get("avg_logprob", 0.0) for s in segs) / len(segs) if segs else None
        no_speech_probs = [s.get("no_speech_prob", 1.0) for s in segs]
        mean_no_speech = sum(no_speech_probs) / len(no_speech_probs) if no_speech_probs else 1.0
        row = {
            "clip": m["clip"], "wid": m["wid"], "kind": m["kind"], "dur_s": m["dur_s"],
            "silero_mean_prob": m["silero_mean_prob"],
            "n_segments": len(segs), "n_words": n_words,
            "words_per_sec": round(n_words / m["dur_s"], 3) if m["dur_s"] else 0,
            "mean_no_speech_prob": round(mean_no_speech, 4),
            "avg_logprob": round(avg_logprob, 4) if avg_logprob is not None else None,
            "whisper_says_speech": n_words > 0 and mean_no_speech < 0.5,
        }
        rows.append(row)
        log(f"{m['clip']} ({m['kind']}): words={n_words} wps={row['words_per_sec']} "
            f"no_speech={row['mean_no_speech_prob']} logprob={row['avg_logprob']} "
            f"whisper_says_speech={row['whisper_says_speech']} ({time.time()-t0:.1f}s)", args.log_file)

    disputed = [r for r in rows if r["kind"] == "disputed"]
    controls = [r for r in rows if r["kind"] == "control"]
    n_confirmed_speech = sum(1 for r in disputed if r["whisper_says_speech"])
    summary = {
        "n_disputed_clips": len(disputed),
        "n_whisper_confirms_speech": n_confirmed_speech,
        "n_whisper_confirms_not_speech": len(disputed) - n_confirmed_speech,
        "controls_all_confirm_speech": all(r["whisper_says_speech"] for r in controls),
        "verdict": ("H1 SUPPORTED (truth wrong on most disputed spans)"
                    if n_confirmed_speech < len(disputed) / 2
                    else "H1 NOT SUPPORTED (Whisper agrees pyannote.ai: real speech, Silero missed it)"),
    }
    json.dump({"rows": rows, "summary": summary}, open(args.out, "w"), indent=2)
    log(f"H1 SUMMARY: {summary}", args.log_file)


if __name__ == "__main__":
    main()
