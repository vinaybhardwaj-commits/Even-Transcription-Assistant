#!/usr/bin/env python3
"""W39 A2 step 1: pull each transcribed window's OWN audio clip from R2 (read-only key), compute
the same acoustic metrics chunk_metrics.py computes for the 5-min tape chunks (adapted for
arbitrary-duration clips), then DELETE the local audio (numbers only persist; the clip already
lives in R2/production, this script keeps no second copy). Read-only on R2 and Neon's metadata
export (work/window_transcript_meta.json). Output: JSONL, one row per window, resumable.
"""
import os, sys, json, subprocess, argparse, tempfile
import numpy as np
from scipy import signal
from multiprocessing import Pool

sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-27-room-acoustics"))
import chunk_metrics as cm  # reuse decode(), db(), hist(), get_vad(), NFFT, SR

META = os.path.expanduser("~/eta-data/acoustics/work/window_transcript_meta.json")
OUT = os.path.expanduser("~/eta-data/acoustics/work/window_acoustics.jsonl")
R2_KEY_PATH = os.path.expanduser("~/.claude/secrets/r2_audio_read")
BUCKET = "eta-audio"
_s3 = None

def r2():
    global _s3
    if _s3 is None:
        import boto3
        L = [l.strip() for l in open(R2_KEY_PATH) if l.strip()]
        _s3 = boto3.client("s3", aws_access_key_id=L[0], aws_secret_access_key=L[1], endpoint_url=L[2], region_name="auto")
    return _s3

def process(rec):
    row = {"subject_id": rec["subject_id"], "room_id": rec["room_id"]}
    tmp = tempfile.mktemp(prefix="w39_win_", suffix=os.path.splitext(rec["audio_r2_key"])[1] or ".webm")
    try:
        r2().download_file(BUCKET, rec["audio_r2_key"], tmp)
        try:
            x = cm.decode(tmp)
            p16 = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", tmp, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                                capture_output=True, timeout=300)
            x16 = np.frombuffer(p16.stdout, dtype=np.float32).copy()
        finally:
            try: os.remove(tmp)
            except OSError: pass
        N = len(x)
        row["n"] = N
        row["dur_s"] = round(N / cm.SR, 2)
        if N < cm.SR * 3:
            row["error"] = "short"; return row
        row["zero_sample_share"] = float((x == 0).mean())
        row["clip_share_999"] = float((np.abs(x) >= 0.999).mean())
        row["clip_share_98"] = float((np.abs(x) >= 0.98).mean())
        row["peak"] = float(np.abs(x).max())
        nf = N // cm.SR
        fr = x[: nf * cm.SR].reshape(nf, cm.SR).astype(np.float64)
        rms = (fr ** 2).mean(1)
        rdb = cm.db(rms)
        row["frame_zero_share"] = float((rms == 0).mean())
        import torch
        from silero_vad import get_speech_timestamps
        ts = get_speech_timestamps(torch.from_numpy(x16), cm.get_vad(), sampling_rate=16000, return_seconds=False)
        segs = [(t["start"], t["end"]) for t in ts]
        mask = np.zeros(nf * 100 + 100, bool)
        for s, e in segs: mask[s // 160: e // 160 + 1] = True
        m1 = mask[: nf * 100].reshape(nf, 100)
        dil = np.convolve(mask.astype(float), np.ones(61), "same") > 0
        d1 = dil[: nf * 100].reshape(nf, 100)
        speech_fr = m1.mean(1) >= 0.5
        quiet_fr = ~d1.any(1)
        row["vad_speech_s"] = round(float(sum(e - s for s, e in segs) / 16000), 2)
        row["n_frames"] = nf
        row["n_speech_frames"] = int(speech_fr.sum())
        row["n_quiet_frames"] = int(quiet_fr.sum())
        if quiet_fr.sum() >= 3:
            qv = rdb[quiet_fr]
            row["noise_p10_raw"] = float(np.percentile(qv, 10))
            row["noise_med_raw"] = float(np.median(qv))
        if speech_fr.sum() >= 2:
            sm = np.repeat(mask[: nf * 100], cm.SR // 100)
            xs = x[: nf * cm.SR]
            row["speech_dbfs"] = float(cm.db((xs[sm].astype(np.float64) ** 2).mean()))
            acc = np.zeros(cm.NFFT // 2 + 1); cnt = 0
            for s, e in segs:
                s48, e48 = s * 3, e * 3
                if e48 - s48 < cm.NFFT * 4: continue
                f, p = signal.welch(x[s48:e48], cm.SR, nperseg=cm.NFFT, noverlap=cm.NFFT // 2)
                acc += p * (e48 - s48); cnt += e48 - s48
            if cnt:
                row["psd_speech"] = (acc / cnt).tolist(); row["psd_speech_n"] = cnt
        return row
    except Exception as ex:
        row["error"] = str(ex)[:150]
        return row

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    recs = json.load(open(META))
    done = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            try: done.add(json.loads(l)["subject_id"])
            except Exception: pass
    todo = [r for r in recs if r["subject_id"] not in done]
    if a.limit: todo = todo[: a.limit]
    print(f"todo {len(todo)} of {len(recs)}", flush=True)
    with open(OUT, "a") as fo, Pool(a.workers) as pool:
        for i, row in enumerate(pool.imap_unordered(process, todo, chunksize=1)):
            fo.write(json.dumps(row) + "\n"); fo.flush()
            if i % 50 == 0: print(i, row.get("error", "ok"), flush=True)
    os.chmod(OUT, 0o640)

if __name__ == "__main__":
    main()
