import numpy as np, scipy.io.wavfile as w, scipy.signal as ss, glob, json, sys
fs=48000
ref=w.read("testsig.wav")[1][:,0].astype(float)/32768
pink=np.load("pink.npy")
def load(p): return w.read(p)[1].astype(float)/32768
def db(x): return 20*np.log10(max(x,1e-9))
def rms(x): return np.sqrt(np.mean(x**2))
def offset(x):
    c=ss.correlate(x,ref,mode="valid",method="fft"); return int(np.argmax(np.abs(c)))
bands=[100,200,315,500,1000,2000,3150,4000,6300,8000,10000,12500,16000]
fP,Pref=ss.welch(pink,fs,nperseg=8192)
res={}
for p in sorted(glob.glob(sys.argv[1]+"/mic*_g*.wav")):
    name=p.split("/")[-1][:-4]; x=load(p); o=offset(x); s=lambda a,b:x[o+int(a*fs):o+int(b*fs)]
    nf=rms(s(0.3,1.8)); tone=rms(s(2.5,4.5)); clip=np.mean(np.abs(x)>=0.999)*100; pk=np.abs(x).max()
    f,P=ss.welch(s(17.2,26.8),fs,nperseg=8192); H=10*np.log10(P/Pref)
    def band(fc): m=(f>=fc/2**(1/6))&(f<fc*2**(1/6)); return float(np.mean(H[m]))
    r={b:band(b) for b in bands}; r1k=r[1000]; fr={b:round(r[b]-r1k,1) for b in bands}
    bw=max([b for b in bands if b>=1000 and fr[b]>-10],default=1000)
    res[name]=dict(offset_s=round(o/fs,3),noise_dbfs=round(db(nf),1),tone_dbfs=round(db(tone),1),snr_db=round(db(tone)-db(nf),1),peak_dbfs=round(db(pk),1),clip_pct=round(clip,3),fr=fr,bw_10db=bw,pink_dbfs=round(db(rms(s(17.2,26.8))),1))
print("%-10s %7s %7s %6s %6s %7s %6s  %s"%("rec","noise","tone1k","SNR","peak","clip%","bw","FR rel 1k: "+" ".join(str(b) for b in bands)))
for k,v in res.items(): print("%-10s %7.1f %7.1f %6.1f %6.1f %7.3f %6d  %s"%(k,v["noise_dbfs"],v["tone_dbfs"],v["snr_db"],v["peak_dbfs"],v["clip_pct"],v["bw_10db"]," ".join("%5.1f"%v["fr"][b] for b in bands)))
# inter-mic at each gain: delay via sweep xcorr, drift tone vs pink
for g in [21,31,41,51,62]:
    try: a=load(f"{sys.argv[1]}/micA_g{g}.wav"); b=load(f"{sys.argv[1]}/micB_g{g}.wav")
    except Exception: continue
    oa=res[f"micA_g{g}"]["offset_s"]; ob=res[f"micB_g{g}"]["offset_s"]
    def lag(t0,t1):
        A=a[int((oa+t0)*fs):int((oa+t1)*fs)]; B=b[int((ob+t0)*fs):int((ob+t1)*fs)]
        c=ss.correlate(A,B,mode="full",method="fft"); return (np.argmax(np.abs(c))-(len(B)-1))/fs*1000
    f,C=ss.coherence(a[int((oa+17.2)*fs):int((oa+26.8)*fs)],b[int((ob+17.2)*fs):int((ob+26.8)*fs)],fs,nperseg=4096)
    m=(f>300)&(f<4000)
    print(f"g{g}: capture-start skew {round((ob-oa)*1000,1)} ms | acoustic lag A-B tone {lag(2.5,4.5):.2f} ms, pink {lag(17.5,26.5):.2f} ms | coherence 300-4k {np.mean(C[m]):.2f}")
json.dump(res,open(sys.argv[1]+"/results.json","w"),indent=1)
