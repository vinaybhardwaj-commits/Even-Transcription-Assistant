# O2 noise-aware scorer. Lab venv only. Usage: python scorer2.py validate | python scorer2.py <shard> <nshards>
# Every input is read as float64 (raw and denoised). Perturbation = drop the first s samples at 48 kHz (s = 0..7), same s on both mics.
# Scoring path per copy = baseline path: resample_poly(1,3) -> 80 Hz HP -> float32 -> small.en int8 beam 5. Selector code is the O1 selector, unchanged.
import sys, os, json, time, numpy as np, soundfile as sf, scipy.signal as ss
sys.path.insert(0, os.path.expanduser("~/orbox-lab/o1")); from baseline_scorer import *
L = "/var/lib/orb3-lab/"; DEN = os.path.expanduser("~/orbox-lab/o1/den/")
FILES = [("run3", f"snr{s}") for s in (20, 10, 5, 0)] + [("run4", t) for t in ("spL_nzR_0", "spR_nzL_0", "both_0", "both_10_g41")]
SHIFTS = range(8)
W, H, XF = 2 * F, 1 * F, int(0.05 * F)
band = ss.butter(4, [300, 4000], "bp", fs=F, output="sos")
def window_snr(x, run):
    y = ss.sosfilt(band, x); starts = list(range(0, max(len(y) - W, 0) + 1, H))
    P = np.array([np.mean(y[s:s + W] ** 2) for s in starts])
    N = np.percentile(P, 10) if run == "run3" else np.mean(y[int(2.5 * F):int(6.0 * F)] ** 2)
    return 10 * np.log10(np.maximum(P - N, 1e-3 * N) / N)
def selector(a, b, run):
    n = min(len(a), len(b)); a, b = a[:n], b[:n]
    sa, sb = window_snr(a, run), window_snr(b, run); nw = len(sa)
    frac_a = float(np.mean(sa >= sb)); nb = int(np.ceil(n / H)); wB = np.zeros(n)
    for k in range(nb):
        idx = [i for i in (k - 1, k) if 0 <= i < nw]
        if np.mean(sb[idx]) > np.mean(sa[idx]): wB[k * H:(k + 1) * H] = 1.0
    wB = np.convolve(wB, np.ones(XF) / XF, mode="same")
    return ((1 - wB) * a + wB * b).astype(np.float32), frac_a
def wer_of(x, run): return wer_full(x) if run == "run3" else wer_run4(x)
def read48(arm, run, tag, mic):
    p = L + f"{run}/mic{mic}_{tag}.wav" if arm == "raw" else DEN + f"{arm}/{run}_mic{mic}_{tag}.wav"
    x, sr = sf.read(p, dtype="float64"); assert sr == 48000 and x.dtype == np.float64; return x
if sys.argv[1] == "validate":
    x = read48("raw", "run3", "snr5", "A"); a = loadarr(x); b = load(L + "run3/micA_snr5.wav")
    w = wer_full(a); print("validate run3 snr5 micA shift0 WER", round(w, 1), "bit-identical to baseline load():", bool(np.array_equal(a, b)))
    print("VALIDATE_PASS" if round(w, 1) == 59.9 else "VALIDATE_FAIL"); sys.exit()
shard, nsh = int(sys.argv[1]), int(sys.argv[2]); out = open(f"results2_{shard}.jsonl", "a"); job = 0
for run, tag in FILES:
    for arm in ("raw", "dfn"):
        x48 = {m: read48(arm, run, tag, m) for m in "AB"}; n48 = min(len(x48["A"]), len(x48["B"]))
        for s in SHIFTS:
            job += 1
            if (job - 1) % nsh != shard: continue
            t0 = time.time(); a, b = (loadarr(x48[m][:n48][s:]) for m in "AB")
            sel, fa = selector(a, b, run)
            r = dict(run=run, tag=tag, arm=arm, shift=s, A=wer_of(a, run), B=wer_of(b, run), sel=wer_of(sel, run), fracA=fa, sec=round(time.time() - t0))
            out.write(json.dumps(r) + "\n"); out.flush(); print(r, flush=True)
print("SCORE2_DONE", shard, time.strftime("%H:%M:%S"))
