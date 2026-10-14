# O1 scoring: raw / DeepFilterNet / RNNoise x micA / micB / selector. Usage: python score.py <shard> <nshards>
# Writes results_<shard>.jsonl in cwd. Baseline functions come from baseline_scorer.py (sha256 printed in the report).
import sys, os, json, time, numpy as np, soundfile as sf, scipy.signal as ss
sys.path.insert(0, "."); from baseline_scorer import *
L = "/var/lib/orb3-lab/"; DEN = os.path.expanduser("~/orbox-lab/o1/den/")
FILES = [("run3", f"snr{s}") for s in (20, 10, 5, 0)] + [("run4", t) for t in ("spL_nzR_0", "spR_nzL_0", "both_0", "both_10_g41")]
W, H, XF = 2 * F, 1 * F, int(0.05 * F)          # 2 s windows, 50% overlap, 50 ms crossfade
band = ss.butter(4, [300, 4000], "bp", fs=F, output="sos")
def window_snr(x, run):
    y = ss.sosfilt(band, x); starts = list(range(0, max(len(y) - W, 0) + 1, H))
    P = np.array([np.mean(y[s:s + W] ** 2) for s in starts])
    N = np.percentile(P, 10) if run == "run3" else np.mean(y[int(2.5 * F):int(6.0 * F)] ** 2)
    return 10 * np.log10(np.maximum(P - N, 1e-3 * N) / N)
def selector(a, b, run):
    n = min(len(a), len(b)); a, b = a[:n], b[:n]
    sa, sb = window_snr(a, run), window_snr(b, run); nw = len(sa)
    frac_a = float(np.mean(sa >= sb))
    nb = int(np.ceil(n / H)); wB = np.zeros(n)
    for k in range(nb):                             # 1 s block k is covered by windows k-1 and k
        idx = [i for i in (k - 1, k) if 0 <= i < nw]
        if np.mean(sb[idx]) > np.mean(sa[idx]): wB[k * H:(k + 1) * H] = 1.0
    wB = np.convolve(wB, np.ones(XF) / XF, mode="same")   # 50 ms linear crossfade centred on each switch
    return ((1 - wB) * a + wB * b).astype(np.float32), frac_a
def wer_of(x, run): return wer_full(x) if run == "run3" else wer_run4(x)
def audio(arm, run, tag, mic):
    if arm == "raw": return load(L + f"{run}/mic{mic}_{tag}.wav")
    x, _ = sf.read(DEN + f"{arm}/{run}_mic{mic}_{tag}.wav", dtype="float32"); return loadarr(x)
shard, nsh = int(sys.argv[1]), int(sys.argv[2])
out = open(f"results_{shard}.jsonl", "a")
for j, (run, tag) in enumerate(FILES):
    if j % nsh != shard: continue
    for arm in ("raw", "dfn", "rnn"):
        t0 = time.time(); a, b = audio(arm, run, tag, "A"), audio(arm, run, tag, "B")
        n = min(len(a), len(b)); a, b = a[:n], b[:n]
        s, fa = selector(a, b, run)
        r = dict(run=run, tag=tag, arm=arm, A=wer_of(a, run), B=wer_of(b, run), sel=wer_of(s, run), fracA=fa, sec=round(time.time() - t0))
        out.write(json.dumps(r) + "\n"); out.flush(); print(r, flush=True)
print("SCORE_DONE", shard)
