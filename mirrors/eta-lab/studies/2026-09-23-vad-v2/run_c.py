#!/usr/bin/env python3
"""
VAD v2, Arm C -- pyannote segmentation-3.0 as the VAD. Portable: box (cuda), Mini (mps),
orbox3 (cpu). Uses the pyannote.audio VoiceActivityDetection pipeline wrapping the
segmentation-3.0 model; scores each window's kept intervals against the pyannote.ai teacher.

Usage:
    python3 run_c.py --data-dir DATA_DIR --device {cpu,cuda,mps} \
        --log-file /path/to/lab-mover.log --out results.json
"""
import argparse, json, os, sys, time, wave


def read_wav_16k_mono(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    import numpy as np
    arr = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    return arr, sr


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="run_c_results.json")
    ap.add_argument("--min-duration-off", type=float, default=0.3)
    args = ap.parse_args()

    import torch
    # torch>=2.6 defaults torch.load(weights_only=True); the segmentation-3.0 checkpoint
    # carries a TorchVersion global not on the default allowlist. Allowlisting it (not
    # disabling weights_only entirely) is the narrow fix -- this is a HF-published,
    # widely-used checkpoint, not an arbitrary file.
    try:
        torch.serialization.add_safe_globals([torch.torch_version.TorchVersion])
    except Exception:
        pass

    from pyannote.audio import Model
    from pyannote.audio.pipelines import VoiceActivityDetection

    data_dir = os.path.abspath(args.data_dir)
    ref_dir = data_dir.rstrip("/") + "-ref"

    log(f"start data_dir={data_dir} device={args.device}", args.log_file)
    seg_model = Model.from_pretrained("pyannote/segmentation-3.0")
    seg_model.to(torch.device(args.device))
    pipe = VoiceActivityDetection(segmentation=seg_model)
    pipe.instantiate({"min_duration_on": 0.0, "min_duration_off": args.min_duration_off})
    log("model loaded", args.log_file)

    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    log(f"{len(files)} windows to score", args.log_file)
    rows = []
    for i, f in enumerate(files):
        wid = f.replace(".wav", "")
        wav_path = os.path.join(data_dir, f)
        ref_path = os.path.join(ref_dir, wid + "_pyannote.json")
        t0 = time.time()
        # Feed a raw waveform dict, not a path: pyannote.audio 4.x requires torchcodec for
        # file-path decoding, which isn't reliably installable across these three machines.
        # This bypasses the audio backend entirely -- same plain-wave-module reading used
        # by the other VAD scripts here.
        arr, sr = read_wav_16k_mono(wav_path)
        waveform = torch.from_numpy(arr).unsqueeze(0)  # (1, time)
        ann = pipe({"waveform": waveform, "sample_rate": sr})
        ivs = [(seg.start, seg.end) for seg in ann.get_timeline().support()]
        pyannote_ivs = pyannote_merged_intervals(ref_path)
        cut, total = cut_stats(pyannote_ivs, ivs)
        sent = sum(e - s for s, e in ivs)
        rows.append({"wid": wid, "pyannote_s": total, "cut_s": cut,
                      "cut_pct": cut / total * 100 if total else 0.0, "sent_s": sent})
        log(f"[{i+1}/{len(files)}] {wid}: cut={rows[-1]['cut_pct']:.2f}% sent={sent:.0f}s "
            f"({time.time()-t0:.1f}s)", args.log_file)

    tot_p = sum(r["pyannote_s"] for r in rows)
    tot_c = sum(r["cut_s"] for r in rows)
    tot_s = sum(r["sent_s"] for r in rows)
    worst = max(rows, key=lambda r: r["cut_pct"])
    summary = {"overall_cut_pct": tot_c / tot_p * 100 if tot_p else 0.0,
               "worst_window": worst["wid"], "worst_cut_pct": worst["cut_pct"],
               "overall_sent_pct": tot_s / (len(rows) * 1800) * 100,
               "avg_sent_s": tot_s / len(rows), "all_le_2pct": all(r["cut_pct"] <= 2.0 for r in rows)}
    json.dump({"rows": rows, "summary": summary}, open(args.out, "w"), indent=2)
    log(f"ARM C summary: {summary}", args.log_file)
    log(f"done, wrote {args.out}", args.log_file)


if __name__ == "__main__":
    main()
