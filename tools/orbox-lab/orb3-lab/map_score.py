import sys, os, re, datetime, numpy as np, soundfile as sf, scipy.signal as ss, jiwer
from faster_whisper import WhisperModel
F=16000; START=datetime.datetime.strptime(sys.argv[1],"%H:%M:%S"); LIMIT=float(sys.argv[2]) if len(sys.argv)>2 else 1e9
def load(p):
    n=min((os.path.getsize(p)-44)//2, int(LIMIT*48000))
    x,_=sf.read(p,frames=n); return ss.resample_poly(x,1,3)
A=load("run5/micA_map.wav"); B=load("run5/micB_map.wav"); n=min(len(A),len(B)); A,B=A[:n],B[:n]
sw=np.load("run5/sweep16k.npy"); L=len(sw); T=L/F
inv=sw[::-1]*np.exp(-np.arange(L)/F*np.log(7000/200)/T); inv/=np.abs(np.fft.rfft(ss.fftconvolve(sw,inv))).max()
hp=ss.butter(4,80,"hp",fs=F,output="sos"); bp=ss.butter(4,[300,4000],"bp",fs=F,output="sos")
A=ss.sosfilt(hp,A); B=ss.sosfilt(hp,B); Ab=ss.sosfilt(bp,A); Bb=ss.sosfilt(bp,B)
IR={m:ss.oaconvolve(x,inv) for m,x in (("A",A),("B",B))}
def peaks(ir):
    e=np.abs(ir); thr=np.median(e)*40
    p,_=ss.find_peaks(e,height=thr,distance=int(4*F)); return p
cand=sorted(set([int(p) for m in "AB" for p in peaks(IR[m])]))
starts=[]
for p in cand:
    for m in "AB":
        e=np.abs(IR[m]); q=p+int(11.0*F)
        if q+200<len(e) and e[q-160:q+160].max()>np.median(e)*20:
            s=p-(L-1)
            if not any(abs(s-x)<F for x in starts): starts.append(s)
            break
m=WhisperModel("small.en",device="cpu",compute_type="int8")
def norm(t): t=t.lower().replace("-"," "); t=re.sub(r"[^a-z0-9 ]"," ",t); return " ".join(t.split())
def tx(x):
    segs,_=m.transcribe(x.astype(np.float32),language="en",beam_size=5,condition_on_previous_text=False,vad_filter=False); return " ".join(s.text for s in segs)
src,_=sf.read("run5/probe_speech_src.wav"); ref=norm(tx(ss.resample_poly(src,1,3)))
db=lambda p:10*np.log10(p+1e-20)
print("ref:",ref); print("room noise 300-4k Hz, median 1 s level: A %.1f  B %.1f dBFS"%tuple(db(np.median([np.mean(x[i:i+F]**2) for i in range(0,len(x)-F,F)])) for x in (Ab,Bb)))
print("\n#  time      | level A/B dB | SNR A/B dB | DRR A/B dB | WER A/B %   | TDOA A-B ms | louder")
for k,s in enumerate(sorted(starts)):
    row={}
    for mname,x,xb in (("A",A,Ab),("B",B,Bb)):
        ir=IR[mname]; w=ir[s+L-1-int(0.05*F):s+L-1+int(0.4*F)]; pk=int(np.argmax(np.abs(w))); d=int(0.0025*F)
        direct=np.sum(w[max(0,pk-d):pk+d]**2); late=np.sum(w[pk+d:]**2)
        nz=np.mean(xb[max(0,s-int(0.9*F)):s-int(0.1*F)]**2); spp=np.mean(xb[s+int(2.5*F):s+int(10.5*F)]**2)
        seg=x[s+int(2.3*F):s+int(10.8*F)]; seg=seg/(np.abs(seg).max()+1e-9)*0.5
        row[mname]=dict(lvl=db(np.abs(w[pk])**2),snr=db(max(spp-nz,1e-12)/nz),drr=db(direct/late),wer=100*jiwer.wer(ref,norm(tx(seg))),pk=s+L-1-int(0.05*F)+pk)
    t=(START+datetime.timedelta(seconds=s/F)).strftime("%H:%M:%S"); a,b=row["A"],row["B"]
    print(f"{k:<2d} {t}  | {a['lvl']:5.1f}/{b['lvl']:5.1f} | {a['snr']:5.1f}/{b['snr']:5.1f} | {a['drr']:5.1f}/{b['drr']:5.1f} | {a['wer']:5.1f}/{b['wer']:5.1f} | {(a['pk']-b['pk'])/F*1000:7.2f}     | {'A' if a['lvl']>b['lvl'] else 'B'} by {abs(a['lvl']-b['lvl']):.1f} dB",flush=True)
print("MAP_SCORE_DONE")
