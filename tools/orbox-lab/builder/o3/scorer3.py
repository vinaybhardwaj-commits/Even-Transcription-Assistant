# O3 scorer3: baseline settings, seeded sampling, per-segment temperature recorded. Lab venv only.
# Usage: python scorer3.py det <threads> <shift>   (run3 snr0 DFN micB, one fresh-process score, prints one JSON line)
#        python scorer3.py val <threads>            (run3 snr5 raw micA shift 0)
#        python scorer3.py shifts <threads>         (run3 snr5 raw micA, shifts 0..7, writes shifts3.jsonl)
import sys, os, re, json, time, hashlib, numpy as np, soundfile as sf, scipy.signal as ss, jiwer, ctranslate2
from faster_whisper import WhisperModel
SEED = 0
L = "/var/lib/orb3-lab/"; DEN = os.path.expanduser("~/orbox-lab/o1/den/"); F = 16000
ref = open(L + "speech_text.txt").read()
def norm(t): t = t.lower().replace("-", " "); t = re.sub(r"[^a-z0-9 ]", " ", t); return " ".join(t.split())   # as stress_score.py
sos = ss.butter(4, 80, "hp", fs=16000, output="sos")
def loadarr(x): x = ss.resample_poly(x, 1, 3); return ss.sosfilt(sos, x).astype(np.float32)               # as baseline load(), float64 in
def read48(arm, run, tag, mic):
    p = L + f"{run}/mic{mic}_{tag}.wav" if arm == "raw" else DEN + f"{arm}/{run}_mic{mic}_{tag}.wav"
    x, sr = sf.read(p, dtype="float64"); assert sr == 48000; return x
def make_model(threads): return WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=threads)
def score(m, x, start_s=0.0):
    ctranslate2.set_random_seed(SEED)                      # reseed before every call so a score does not depend on earlier calls
    segs, _ = m.transcribe(x[int(start_s * F):], language="en", beam_size=5, condition_on_previous_text=False, vad_filter=False)
    segs = list(segs); text = " ".join(s.text for s in segs)
    temps = [s.temperature for s in segs]
    return 100 * jiwer.wer(norm(ref), norm(text)), text, temps
def rec(tag, w, text, temps, **kw):
    return dict(tag=tag, wer=round(w, 2), text_sha=hashlib.sha256(text.encode()).hexdigest()[:12], nseg=len(temps),
                n_temp_gt0=int(sum(t > 0 for t in temps)), temps=temps, **kw)
if __name__ == "__main__":
    mode, th = sys.argv[1], int(sys.argv[2]); m = make_model(th); t0 = time.time()
    if mode == "det":
        s = int(sys.argv[3]); x = read48("dfn", "run3", "snr0", "B")[s:]
        w, text, temps = score(m, loadarr(x)); print(json.dumps(rec("dfn_snr0_B", w, text, temps, shift=s, threads=th, sec=round(time.time() - t0))))
    elif mode == "val":
        w, text, temps = score(m, loadarr(read48("raw", "run3", "snr5", "A"))); print(json.dumps(rec("raw_snr5_A", w, text, temps, shift=0, threads=th, sec=round(time.time() - t0))))
    elif mode == "shifts":
        x48 = read48("raw", "run3", "snr5", "A"); out = open("shifts3.jsonl", "a")
        for s in range(8):
            w, text, temps = score(m, loadarr(x48[s:])); r = rec("raw_snr5_A", w, text, temps, shift=s, threads=th, sec=round(time.time() - t0))
            out.write(json.dumps(r) + "\n"); out.flush(); print(json.dumps(r), flush=True)
        print("SHIFTS3_DONE", time.strftime("%H:%M:%S"))
