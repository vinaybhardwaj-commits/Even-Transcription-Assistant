import re, json, numpy as np, soundfile as sf, scipy.signal as ss, jiwer
from faster_whisper import WhisperModel
ref=open("speech_text.txt").read()
def norm(t): t=t.lower().replace("-"," "); t=re.sub(r"[^a-z0-9 ]"," ",t); return " ".join(t.split())
m=WhisperModel("small.en",device="cpu",compute_type="int8")
F=16000; sos=ss.butter(4,80,"hp",fs=F,output="sos")
def raw(p): x,_=sf.read(p); return x
def prep(x): return ss.sosfilt(sos,ss.resample_poly(x,1,3)).astype(np.float32)
def db(p): return 10*np.log10(p+1e-20)
def pw(x,a,b): return np.mean(x[int(a*F):int(b*F)]**2)
def wer(x):
    segs,_=m.transcribe(x[int(6*F):],language="en",beam_size=5,condition_on_previous_text=False,vad_filter=False)
    return 100*jiwer.wer(norm(ref),norm(" ".join(s.text for s in segs)))
# channel id: 1 kHz band level per mic for L-only (1-4 s) and R-only (5-8 s), recording offset 1.5 s
bp=ss.butter(4,[900,1100],"bp",fs=F,output="sos")
print("CHANNEL COUPLING (1 kHz, dBFS)  L-speaker  R-speaker")
for mic in "AB":
    x=ss.sosfilt(bp,ss.resample_poly(raw(f"run4/mic{mic}_chanid.wav"),1,3))
    print(f"mic{mic}                            {db(pw(x,2.8,5.2)):6.1f}    {db(pw(x,6.8,9.2)):6.1f}",flush=True)
takes=json.load(open("run4/takes.json"))
print("\ntake            gain | noise A/B dBFS | SNRest A/B dB | clip% A/B | <20Hz% A/B | WER A   WER B   WER pick(SNR)  WER sum")
for name,g in takes:
    ra=raw(f"run4/micA_{name}.wav"); rb=raw(f"run4/micB_{name}.wav")
    clip=[100*np.mean(np.abs(r)>=0.999) for r in (ra,rb)]
    inf=[]
    for r in (ra,rb):
        f,P=ss.welch(r,48000,nperseg=65536); inf.append(100*P[f<20].sum()/P.sum())
    a=prep(ra); b=prep(rb); n=min(len(a),len(b)); a,b=a[:n],b[:n]
    na,nb=pw(a,2.5,6.0),pw(b,2.5,6.0); sa,sb=pw(a,7,48),pw(b,7,48)
    snra=db(max(sa-na,1e-12)/na); snrb=db(max(sb-nb,1e-12)/nb)
    wa=wer(a); wb=wer(b); wp=wa if snra>=snrb else wb
    # delay-and-sum: align b to a (±40 ms), equalise noise, weight by sqrt(linear SNR)
    seg=slice(int(7*F),int(48*F)); c=ss.correlate(a[seg],b[seg],mode="full",method="fft"); mid=len(b[seg])-1
    lag=int(np.argmax(c[mid-640:mid+641]))-640; bs=np.roll(b,lag)
    wA=np.sqrt(10**(snra/10))/np.sqrt(na); wB=np.sqrt(10**(snrb/10))/np.sqrt(nb)
    s=(wA*a+wB*bs); s=(s/np.abs(s).max()*0.5).astype(np.float32); ws=wer(s)
    print(f"{name:15s} {g:3d} | {db(na):6.1f}/{db(nb):6.1f} | {snra:5.1f}/{snrb:5.1f} | {clip[0]:4.2f}/{clip[1]:4.2f} | {inf[0]:3.0f}/{inf[1]:3.0f} | {wa:5.1f}  {wb:5.1f}  {wp:5.1f}({'A' if snra>=snrb else 'B'})  {ws:5.1f} lag{lag}",flush=True)
print("RUN4_SCORE_DONE")
