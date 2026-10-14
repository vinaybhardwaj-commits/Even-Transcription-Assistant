# /// script
# requires-python = ">=3.10"
# dependencies = ["torch==2.6.0", "transformers==5.17.0", "av>=12", "numpy"]  # torch/transformers = the box :8086 Mini service venv
# ///
"""Runs ON an HF Job (l4x1, uv image, no ffmpeg). Standalone: imports nothing from this repo.
Scores each manifest turn with the wavlm crosslingual model and appends one line per window to
out.jsonl: {"window_id", "turns": [{"t0_ms","t1_ms","label","scores"} | {"t0_ms","t1_ms","skipped":"no_audio"|"silence"}],
"n_chunks"}, or {"window_id","missing_audio":true,"turns":[]} when the audio file is absent.
It does NOT build REB track bodies or touch a REB root: the box-side hf_emotion_collect.py builds and
commits the tracks (kit/reb_runner/DESIGN.md #2), so the track shape lives in one place.

    hf jobs uv run --flavor l4x1 --timeout 1h --secrets HF_TOKEN \
      -v hf://buckets/vrbeven/reb-backfill-26sep-audio:/mnt/audio:ro -v hf://buckets/<out>:/mnt/out \
      hf_emotion_job.py <manifest.json> /mnt/audio /mnt/out/emotion-26sep.jsonl --ext webm

Turn times in the manifest are window-relative ms (offsets into the window's audio). Turns shorter
than MIN_SPEECH_S are not scored (build_track marks them skipped_short). A turn longer than
CHUNK_S is scored in <=CHUNK_S pieces and the class probabilities are averaged, weighted by piece
length (a 900 s whole-window fallback turn would not fit one wavlm forward pass).
"""
import argparse
import json
import os
import shutil
import time

MODEL = "Aniemore/wavlm-emotion-v1-crosslingual"  # keep equal to engines/emotion_wavlm.MODEL
SUBFOLDER = "int8"  # keep equal to engines/emotion_wavlm.SUBFOLDER (what the Mini service loads)
REVISION = "a08f2a01c0ebf3611f5720ee46438226aa913ae7"  # keep equal to engines/emotion_wavlm.REVISION
MIN_SPEECH_S = 1.5  # keep equal to engines/emotion_wavlm.MIN_SPEECH_S
CHUNK_S = 30.0
SR = 16000
# Silence gate: same thresholds/logic as the Mini service (~/eta-emotion/app.py audio_energy + silence_skip_reason)
SILENCE_RMS = 0.008
SILENCE_MAX_ABS = 0.02
SPEECH_ABS = 0.02


def _decode_ffmpeg(src):
    """Fallback for hosts without PyAV (the box); the HF image has no ffmpeg and uses PyAV."""
    import subprocess

    import numpy as np

    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         check=True, capture_output=True, timeout=300).stdout
    return np.frombuffer(raw, dtype="float32").copy()


def decode_to_16k_mono(src):
    try:
        import av
    except ImportError:
        return _decode_ffmpeg(src)
    import numpy as np

    container = av.open(src)
    stream = next(s for s in container.streams if s.type == "audio")
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=SR)
    chunks = []
    for frame in container.decode(stream):
        for rframe in resampler.resample(frame):
            chunks.append(rframe.to_ndarray().reshape(-1))
    for rframe in resampler.resample(None):  # flush the last few ms
        chunks.append(rframe.to_ndarray().reshape(-1))
    container.close()
    return np.concatenate(chunks).astype("float32") if chunks else np.zeros(0, dtype="float32")


def chunk_bounds(n_samples, chunk=int(CHUNK_S * SR), min_tail=SR):
    bounds, i = [], 0
    while i < n_samples:
        bounds.append([i, min(i + chunk, n_samples)])
        i += chunk
    if len(bounds) >= 2 and bounds[-1][1] - bounds[-1][0] < min_tail:
        bounds[-2][1] = bounds[-1][1]
        bounds.pop()
    return bounds


def load_classifier(device):
    """Same load as the Mini service (~/eta-emotion/app.py load_wavlm): AutoFeatureExtractor +
    AutoModelForAudioClassification from the int8 subfolder, softmax over the logits (all 7 labels)."""
    import torch
    from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

    feat = AutoFeatureExtractor.from_pretrained(MODEL, subfolder=SUBFOLDER, revision=REVISION)
    model = AutoModelForAudioClassification.from_pretrained(MODEL, subfolder=SUBFOLDER, revision=REVISION)
    model.eval().to(device)
    id2label = {int(k): v for k, v in model.config.id2label.items()}

    def classify(samples):
        x = feat(samples, sampling_rate=SR, return_tensors="pt", padding=True)
        x = {k: v.to(device) for k, v in x.items()}
        with torch.no_grad():
            probs = torch.nn.functional.softmax(model(**x).logits, dim=-1)[0].float().cpu().numpy()
        return {id2label[i]: float(probs[i]) for i in range(len(id2label))}

    return classify


def audio_energy(samples):
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return {"rms": 0.0, "max_abs": 0.0, "speech_s_est": 0.0}
    hop = int(0.02 * SR)
    a = np.abs(x)
    active = sum(len(a[i:i + hop]) for i in range(0, x.size, hop) if a[i:i + hop].max() >= SPEECH_ABS)
    return {"rms": float(np.sqrt(np.mean(np.square(x)))), "max_abs": float(a.max()), "speech_s_est": active / SR}


def silence_skip_reason(energy):
    if energy["rms"] < SILENCE_RMS and energy["max_abs"] < SILENCE_MAX_ABS:
        return "near_silent"
    if energy["speech_s_est"] < MIN_SPEECH_S:
        return "insufficient_speech"
    return None


def score_samples(classify, samples):
    """(label, {label: prob}, n_scored, n_skipped) for one turn, or (None, None, 0, n_skipped) when every
    piece was gated out. Pieces (<=CHUNK_S) failing the Mini service's silence gate are NOT classified and
    do not enter the length-weighted mean of class probabilities."""
    total, weight, skipped = {}, 0, 0
    bounds = chunk_bounds(len(samples))
    for a, b in bounds:
        piece = samples[a:b]
        if silence_skip_reason(audio_energy(piece)):
            skipped += 1
            continue
        w = b - a
        for label, p in classify(piece).items():
            total[label] = total.get(label, 0.0) + p * w
        weight += w
    if not weight:
        return None, None, 0, skipped
    scores = {k: v / weight for k, v in total.items()}
    return max(scores, key=scores.get), scores, len(bounds) - skipped, skipped


def index_audio(audio_dir, ext):
    """{window_id: path} for every <window_id>.<ext> under audio_dir, flat (HF bucket) or nested
    (hist-bulk's local windows-reb/<date>/<room>/<window>.webm)."""
    idx, suffix = {}, "." + ext
    for root, _dirs, files in os.walk(audio_dir):
        for name in files:
            if name.endswith(suffix):
                idx[name[: -len(suffix)]] = os.path.join(root, name)
    return idx


def done_ids(out_path):
    """Window ids already in out.jsonl. An unparseable line (a kill mid-write) is ignored: that
    window is simply redone."""
    done = set()
    if os.path.exists(out_path):
        with open(out_path) as f:
            for line in f:
                try:
                    done.add(json.loads(line)["window_id"])
                except (ValueError, KeyError):
                    pass
    return done


def ensure_trailing_newline(path):
    """So a resumed append never glues a new record onto a truncated last line."""
    if os.path.exists(path) and os.path.getsize(path):
        with open(path, "rb+") as f:
            f.seek(-1, 2)
            if f.read(1) != b"\n":
                f.write(b"\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("audio_dir")
    ap.add_argument("out")
    ap.add_argument("--ext", default="webm")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--threads", type=int, default=None, help="torch CPU threads (box runs: 2)")
    args = ap.parse_args()

    import torch

    windows = json.load(open(args.manifest))[: args.limit]
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    # Work on local disk (appending to a FUSE-mounted bucket is unverified); copy to args.out
    # periodically and at the end. A resume starts from whatever was last copied.
    work = "/tmp/emotion-work.jsonl"
    if os.path.exists(args.out):
        shutil.copyfile(args.out, work)
    ensure_trailing_newline(work)
    done = done_ids(work)

    def append(rec):
        with open(work, "a") as f:
            f.write(json.dumps(rec) + "\n")

    def publish():
        if os.path.exists(work):
            shutil.copyfile(work, args.out)

    audio = index_audio(args.audio_dir, args.ext)
    if args.threads:
        torch.set_num_threads(args.threads)
    clf = load_classifier(torch.device("cuda" if torch.cuda.is_available() else "cpu"))

    t_start, n, missing = time.time(), 0, 0
    for w in windows:
        wid = w["window_id"]
        if wid in done:
            continue
        path = audio.get(wid)
        if path is None:
            missing += 1
            print(f"[hf-emotion-job] MISSING audio for {wid}", flush=True)
            append({"window_id": wid, "missing_audio": True, "turns": []})
            continue
        samples = decode_to_16k_mono(path)
        turns, n_chunks = [], 0
        for t0_ms, t1_ms, _speaker in w["turns"]:
            if (t1_ms - t0_ms) / 1000.0 < MIN_SPEECH_S:
                continue
            seg = samples[int(t0_ms * SR / 1000): int(t1_ms * SR / 1000)]
            if len(seg) == 0:  # audio shorter than the turn's span (tape gap / short cut)
                turns.append({"t0_ms": t0_ms, "t1_ms": t1_ms, "skipped": "no_audio"})
                continue
            label, scores, k, ns = score_samples(clf, seg)
            n_chunks += k
            if label is None:
                turns.append({"t0_ms": t0_ms, "t1_ms": t1_ms, "skipped": "silence", "n_pieces_skipped": ns})
                continue
            turns.append({"t0_ms": t0_ms, "t1_ms": t1_ms, "label": label, "scores": scores,
                          "n_pieces_scored": k, "n_pieces_skipped": ns})
        append({"window_id": wid, "turns": turns, "n_chunks": n_chunks})
        n += 1
        if n % 25 == 0:
            publish()
            print(f"[hf-emotion-job] {n} windows in {time.time() - t_start:.0f}s", flush=True)
    publish()
    print(f"[hf-emotion-job] done: {n} windows, {missing} missing audio, {time.time() - t_start:.0f}s", flush=True)


if __name__ == "__main__":
    main()
