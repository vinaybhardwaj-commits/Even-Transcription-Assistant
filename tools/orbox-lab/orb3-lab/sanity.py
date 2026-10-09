import json, numpy as np, datetime as dt, scipy.signal as ss, soundfile as sf
IST=dt.timezone(dt.timedelta(hours=5,minutes=30))
idx=json.load(open("ot_idx_today.json")); tape="/var/lib/room-recorder/tape/tape.pcm"
def seg(h,m,s,dur):
    t=dt.datetime(2026,10,5,h,m,s,tzinfo=IST).timestamp()*1e9; r=[x for x in idx if x[0]>=t][0]
    with open(tape,"rb") as f: f.seek(r[1]); b=f.read(int(dur*16000*2))
    return np.frombuffer(b,dtype="<i2").astype(np.float32)/32768
for (h,m,s) in [(15,3,0),(14,58,5)]:
    x=seg(h,m,s,8); f,P=ss.welch(x,16000,nperseg=8192); print("%02d:%02d:%02d tone check: peak freq %.0f Hz, rms %.1f dBFS"%(h,m,s,f[np.argmax(P*(f>100))],20*np.log10(np.sqrt(np.mean(x**2)))),flush=True)
y,_=sf.read("ot/case_0745_hpf.wav"); n=len(y)//16000; r=np.sqrt((y[:n*16000].reshape(n,16000)**2).mean(1)); d=20*np.log10(r+1e-9)
print("07:45-09:05 HPF per-second level: p10 %.1f p50 %.1f p90 %.1f p99 %.1f max %.1f dBFS"%tuple(np.percentile(d,[10,50,90,99,100])),flush=True)
f,P=ss.welch(y,16000,nperseg=4096); tot=P.sum()
print("  bands:"," ".join(f"{lo}-{hi}Hz {100*P[(f>=lo)&(f<hi)].sum()/tot:.0f}%" for lo,hi in [(100,300),(300,1000),(1000,3000),(3000,8000)]))
print("  strongest freqs:", sorted(np.round(f[np.argsort(P)[-6:]])))
