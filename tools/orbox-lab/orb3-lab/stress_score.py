import re, numpy as np, soundfile as sf, scipy.signal as ss, jiwer
from faster_whisper import WhisperModel
ref=open("speech_text.txt").read()
def norm(t): t=t.lower().replace("-"," "); t=re.sub(r"[^a-z0-9 ]"," ",t); return " ".join(t.split())
m=WhisperModel("small.en",device="cpu",compute_type="int8")
sos=ss.butter(4,80,"hp",fs=16000,output="sos")
def load(p):
    x,sr=sf.read(p); x=ss.resample_poly(x,1,3); return ss.sosfilt(sos,x).astype(np.float32)
def tx(x):
    segs,_=m.transcribe(x,language="en",beam_size=5,condition_on_previous_text=False,vad_filter=False); segs=list(segs)
    return " ".join(s.text for s in segs), (np.mean([s.avg_logprob for s in segs]) if segs else -9)
W=5*16000
print("SNR  | full A  full B | 5s-win A  5s-win B  best-of-2 | picked A%")
for snr in [20,10,5,0,-5]:
    a=load(f"run3/micA_snr{snr}.wav"); b=load(f"run3/micB_snr{snr}.wav"); n=min(len(a),len(b)); a,b=a[:n],b[:n]
    fa=jiwer.wer(norm(ref),norm(tx(a)[0])); fb=jiwer.wer(norm(ref),norm(tx(b)[0]))
    ta=[];tb=[];tbest=[];pick=0;k=0
    for i in range(0,n,W):
        sa,la=tx(a[i:i+W]); sb,lb=tx(b[i:i+W]); ta.append(sa); tb.append(sb)
        if la>=lb: tbest.append(sa); pick+=1
        else: tbest.append(sb)
        k+=1
    wa=jiwer.wer(norm(ref),norm(" ".join(ta))); wb=jiwer.wer(norm(ref),norm(" ".join(tb))); wbest=jiwer.wer(norm(ref),norm(" ".join(tbest)))
    print(f"{snr:+3d}  | {100*fa:5.1f}%  {100*fb:5.1f}% | {100*wa:6.1f}%  {100*wb:6.1f}%  {100*wbest:6.1f}%  | {100*pick/k:3.0f}%",flush=True)
print("STRESS_SCORE_DONE")
