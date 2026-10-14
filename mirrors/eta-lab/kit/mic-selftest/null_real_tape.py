"""null_real_tape.py: the detection null distribution on REAL room tape (eta-refuter #2204 item 4). Numbers only.

  python3 null_real_tape.py TAPES_DIR [--windows 200] [--seconds 16] [--seed 20260925]

Picks N random windows (seeded) of real recorded audio from lab-mover's chunks (webm/opus decoded to 16 kHz), runs the same search analyse() runs (peak normalised cross-correlation
against the reference; the first 2 s of each window play the part of the 'before' stretch and the search starts 0.5 s before its end), and prints one JSON object: per-window numbers
(room_id, started_at, offset_s, rms, ncc_peak) and a summary (n, max, p99, p99.9, at-or-above the threshold). No audio, no text and no file path leave the process.
These windows are ordinary tape (empty rooms, speech, noise), NOT tape with the reference in it, so every peak is a false-positive candidate.
"""
import argparse, json, math, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mic_selftest as M
import tape_stats as T


def window_peak(pcm_window, n_before=2 * M.SR, ref=None):
    x = M.pcm_to_floats(pcm_window)
    if not x or max(abs(v) for v in x) == 0.0:
        return 0.0, 0.0
    prof = M.ncc_profile(x, ref or M.make_reference())
    lo = max(0, n_before - M.SR // 2)
    win = prof[lo:]
    return (max(win) if win else None), M._rms(x)


def run(tapes_dir, n, seconds, seed, decode=T.decode):
    with open(os.path.join(tapes_dir, "manifest.jsonl")) as f:
        metas = [json.loads(l) for l in f if l.strip()]
    metas = [m for m in metas if os.path.isfile(os.path.join(tapes_dir, m["path"]))]
    rng = random.Random(seed)
    ref = M.make_reference()
    rows = []
    for _ in range(n):
        m = rng.choice(metas)
        pcm = decode(os.path.join(tapes_dir, m["path"]))
        secs = len(pcm) // (2 * M.SR)
        if secs < seconds:
            continue
        off = rng.randrange(0, secs - seconds + 1)
        peak, rms = window_peak(pcm[off * M.SR * 2:(off + seconds) * M.SR * 2], ref=ref)
        rows.append(dict(room_id=m["room_id"], started_at=m["started_at"], offset_s=off, rms=round(rms, 6), ncc_peak=round(peak, 4)))
    return rows


def summarise(rows):
    peaks = sorted(r["ncc_peak"] for r in rows)
    pick = lambda q: peaks[min(len(peaks) - 1, int(math.ceil(q * len(peaks))) - 1)]
    return dict(n=len(peaks), threshold=M.NCC_THRESHOLD, max=peaks[-1], p99=pick(0.99), p999=pick(0.999), p50=pick(0.5),
                at_or_above_threshold=sum(1 for v in peaks if v >= M.NCC_THRESHOLD), margin_to_threshold=round(M.NCC_THRESHOLD - peaks[-1], 4))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("tapes_dir")
    ap.add_argument("--windows", type=int, default=200)
    ap.add_argument("--seconds", type=int, default=16)
    ap.add_argument("--seed", type=int, default=20260925)
    a = ap.parse_args(argv)
    rows = run(a.tapes_dir, a.windows, a.seconds, a.seed)
    print(json.dumps(dict(summary=summarise(rows), windows=rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
