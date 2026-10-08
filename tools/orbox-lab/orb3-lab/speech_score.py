import sys, glob, re, numpy as np, soundfile as sf, scipy.signal as ss, jiwer
from faster_whisper import WhisperModel
ref=open("speech_text.txt").read()
def norm(t): t=t.lower().replace("-"," "); t=re.sub(r"[^a-z0-9 ]"," ",t); return " ".join(t.split())
m=WhisperModel("small.en",device="cpu",compute_type="int8")
def stt(x,sr):
    if sr!=16000: x=ss.resample_poly(x,16000,sr)
    segs,_=m.transcribe(x.astype(np.float32),language="en",beam_size=5,condition_on_previous_text=False,vad_filter=False)
    return " ".join(s.text for s in segs)
def db(v): return 20*np.log10(max(v,1e-9))
rows=[]
files=["speech_raw.wav"]+sorted(glob.glob("run2/mic*_g*.wav"))
for f in files:
    x,sr=sf.read(f); x=x[:,0] if x.ndim>1 else x
    nf=np.sqrt(np.mean(x[:int(0.8*sr)]**2)) if f!="speech_raw.wav" else 0
    sp=np.sqrt(np.mean(x[int(1.5*sr):]**2)); clip=np.mean(np.abs(x)>=0.999)*100
    v48=x
    v16=ss.resample_poly(x,16000,sr)                       # production-like 16 kHz tape
    w48=jiwer.wer(norm(ref),norm(stt(v48,sr))); w16=jiwer.wer(norm(ref),norm(stt(v16,16000)))
    rows.append((f.split("/")[-1][:-4],db(nf),db(sp),db(sp)-db(nf),clip,w48*100,w16*100))
    print("%-12s noise %6.1f  speech %6.1f  SNR %5.1f  clip %5.2f%%  WER48k %5.1f%%  WER16k %5.1f%%"%rows[-1],flush=True)
