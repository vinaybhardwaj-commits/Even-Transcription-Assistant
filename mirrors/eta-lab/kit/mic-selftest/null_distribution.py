"""null_distribution.py: how often does noise alone reach the detection threshold? (eta-refuter's W21 check 2). Stdlib only, slow (~3 s per seed).

  python3 null_distribution.py [--white 200] [--banded 100] [--seconds 12]

For each seed: a noise-only tape (no reference in it), the same search analyse() uses (peak normalised cross-correlation over the reference), and the peak is recorded.
Two families: 'white' (Gaussian, random level) and 'banded' (random-phase sinusoids 1-3 kHz, the reference's own band: the hardest noise for this filter).
Prints one JSON object: per family n, the threshold, max, p99, p50, the number of seeds at or above the threshold (the false-positive count) and the margin to the threshold.
"""
import argparse, cmath, json, math, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mic_selftest as M


def white(n, seed):
    r = random.Random(seed)
    sigma = 10 ** r.uniform(-3, -1.3)                     # 0.001 .. 0.05 full scale
    return [r.gauss(0, sigma) for _ in range(n)]


def banded(n, seed, parts=40):
    r = random.Random(seed)
    sigma = 10 ** r.uniform(-3, -1.3)
    rot = [(cmath.exp(1j * 2 * math.pi * r.uniform(*M.CHIRP_HZ) / M.SR), cmath.exp(1j * r.uniform(0, 2 * math.pi)), r.expovariate(1.0)) for _ in range(parts)]
    out = []
    zs = [z for _, z, _ in rot]
    ws = [w for w, _, _ in rot]
    amps = [a for _, _, a in rot]
    for _ in range(n):
        v = 0.0
        for k in range(parts):
            zs[k] *= ws[k]
            v += amps[k] * zs[k].real
        out.append(v)
    rms = math.sqrt(sum(v * v for v in out) / n)
    return [v * sigma / rms for v in out]


def peak(x, n_before):
    prof = M.ncc_profile(x, M.make_reference())
    lo = max(0, n_before - M.SR // 2)
    return max(prof[lo:])


def summarise(name, peaks):
    s = sorted(peaks)
    pick = lambda q: s[min(len(s) - 1, int(math.ceil(q * len(s))) - 1)]
    return dict(family=name, n=len(s), threshold=M.NCC_THRESHOLD, max=round(s[-1], 4), p99=round(pick(0.99), 4), p50=round(pick(0.5), 4),
                at_or_above_threshold=sum(1 for v in s if v >= M.NCC_THRESHOLD), margin_to_threshold=round(M.NCC_THRESHOLD - s[-1], 4))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--white", type=int, default=200)
    ap.add_argument("--banded", type=int, default=100)
    ap.add_argument("--seconds", type=int, default=12)
    a = ap.parse_args(argv)
    n = a.seconds * M.SR
    out = []
    if a.white:
        out.append(summarise("white", [peak(white(n, s), 2 * M.SR) for s in range(1, a.white + 1)]))
    if a.banded:
        out.append(summarise("banded_1_3kHz", [peak(banded(n, 1000 + s), 2 * M.SR) for s in range(1, a.banded + 1)]))
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
