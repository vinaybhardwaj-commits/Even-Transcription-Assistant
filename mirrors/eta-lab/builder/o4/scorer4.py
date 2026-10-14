# O4 scorer4: pure beam search, no temperature fallback, no sampling. Lab venv only.
# Usage: python scorer4.py one <variant V0|V1|V2> <arm raw|dfn> <run> <tag> <mic A|B> <shift> <threads> [ncalls]
#        python scorer4.py shifts <variant> <threads>      (run3 snr5 raw micA, shifts 0..7, one process)
# kwargs (faster-whisper 1.2.1 WhisperModel.transcribe signature, transcribe.py:757 repetition_penalty, :758 no_repeat_ngram_size, :759 temperature)
import sys, os, re, json, time, zlib, hashlib, numpy as np, soundfile as sf, scipy.signal as ss, jiwer
from collections import Counter
from faster_whisper import WhisperModel
L = "/var/lib/orb3-lab/"; DEN = os.path.expanduser("~/orbox-lab/o1/den/"); F = 16000
ref = open(L + "speech_text.txt").read()
def norm(t): t = t.lower().replace("-", " "); t = re.sub(r"[^a-z0-9 ]", " ", t); return " ".join(t.split())   # as stress_score.py
sos = ss.butter(4, 80, "hp", fs=16000, output="sos")
def loadarr(x): x = ss.resample_poly(x, 1, 3); return ss.sosfilt(sos, x).astype(np.float32)               # baseline load(), float64 in
def read48(arm, run, tag, mic):
    p = L + f"{run}/mic{mic}_{tag}.wav" if arm == "raw" else DEN + f"{arm}/{run}_mic{mic}_{tag}.wav"
    x, sr = sf.read(p, dtype="float64"); assert sr == 48000; return x
VARIANTS = {"V0": dict(), "V1": dict(no_repeat_ngram_size=3), "V2": dict(no_repeat_ngram_size=3, repetition_penalty=1.1)}
def is_loop(text):
    b = text.encode()
    if len(b) and len(b) / len(zlib.compress(b)) > 2.4: return True      # compression ratio of the segment text
    w = text.split(); c = Counter(tuple(w[i:i + 4]) for i in range(len(w) - 3))
    return bool(c) and max(c.values()) >= 4                               # any 4-gram repeated 4+ times
def make_model(threads): return WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=threads)
def score(m, x, variant, start_s=0.0):
    segs, _ = m.transcribe(x[int(start_s * F):], language="en", beam_size=5, condition_on_previous_text=False, vad_filter=False,
                           temperature=0.0, **VARIANTS[variant])
    segs = list(segs); text = " ".join(s.text for s in segs)
    return 100 * jiwer.wer(norm(ref), norm(text)), text, sum(is_loop(s.text) for s in segs), len(segs)
def loops_full(text):   # same detector on the whole transcript: catches repeats that span segments
    w = text.split(); c = Counter(tuple(w[i:i + 4]) for i in range(len(w) - 3)); return int(bool(c) and max(c.values()) >= 4)
def rec(w, text, loops, nseg, **kw):
    return dict(wer=round(w, 2), text_sha=hashlib.sha256(text.encode()).hexdigest()[:12], nseg=nseg, loops=loops, loops_full=loops_full(text), nwords=len(text.split()), **kw)
if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "one":
        v, arm, run, tag, mic, s, th = sys.argv[2:9]; n = int(sys.argv[9]) if len(sys.argv) > 9 else 1; s, th = int(s), int(th)
        m = make_model(th); x = loadarr(read48(arm, run, tag, mic)[s:])
        for call in range(n):
            t0 = time.time(); w, text, loops, nseg = score(m, x, v, 6.0 if run == "run4" else 0.0)
            print(json.dumps(rec(w, text, loops, nseg, variant=v, arm=arm, run=run, tag=tag, mic=mic, shift=s, threads=th, call=call, sec=round(time.time() - t0))), flush=True)
    elif mode == "shifts":
        v, th = sys.argv[2], int(sys.argv[3]); m = make_model(th); x48 = read48("raw", "run3", "snr5", "A")
        for s in range(8):
            w, text, loops, nseg = score(m, loadarr(x48[s:]), v)
            print(json.dumps(rec(w, text, loops, nseg, variant=v, mode="inproc", shift=s, threads=th)), flush=True)
