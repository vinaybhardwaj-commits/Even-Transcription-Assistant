# Baseline scorer. Lines copied verbatim from /var/lib/orb3-lab/stress_score.py (norm, model, sos, load, tx) and run4_score.py (wer).
# Only changes: ref path is absolute; loadarr() is load() minus sf.read; wer_full/wer_run4 name the two scoring lines.
import re, numpy as np, soundfile as sf, scipy.signal as ss, jiwer
from faster_whisper import WhisperModel
ref=open("/var/lib/orb3-lab/speech_text.txt").read()
def norm(t): t=t.lower().replace("-"," "); t=re.sub(r"[^a-z0-9 ]"," ",t); return " ".join(t.split())
m=WhisperModel("small.en",device="cpu",compute_type="int8")
sos=ss.butter(4,80,"hp",fs=16000,output="sos")
def load(p):
    x,sr=sf.read(p); x=ss.resample_poly(x,1,3); return ss.sosfilt(sos,x).astype(np.float32)
def loadarr(x): x=ss.resample_poly(x,1,3); return ss.sosfilt(sos,x).astype(np.float32)
def tx(x):
    segs,_=m.transcribe(x,language="en",beam_size=5,condition_on_previous_text=False,vad_filter=False); segs=list(segs)
    return " ".join(s.text for s in segs), (np.mean([s.avg_logprob for s in segs]) if segs else -9)
F=16000
def wer_full(x): return 100*jiwer.wer(norm(ref),norm(tx(x)[0]))   # run3: whole file, as stress_score.py
def wer_run4(x):                                                    # run4: from 6 s, as run4_score.py
    segs,_=m.transcribe(x[int(6*F):],language="en",beam_size=5,condition_on_previous_text=False,vad_filter=False)
    return 100*jiwer.wer(norm(ref),norm(" ".join(s.text for s in segs)))
