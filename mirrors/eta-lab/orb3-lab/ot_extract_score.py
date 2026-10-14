import json, numpy as np, datetime as dt, scipy.signal as ss, soundfile as sf
from faster_whisper import WhisperModel
IST=dt.timezone(dt.timedelta(hours=5,minutes=30))
idx=json.load(open("ot_idx_today.json")); tape="/var/lib/room-recorder/tape/tape.pcm"
def extract(hh,mm,secs=180):
    t0=dt.datetime(2026,10,5,hh,mm,tzinfo=IST).timestamp()*1e9
    r=[x for x in idx if x[0]>=t0][0]; off=r[1]
    with open(tape,"rb") as f: f.seek(off); b=f.read(secs*16000*2)
    return np.frombuffer(b,dtype="<i2").astype(np.float32)/32768
m=WhisperModel("small",device="cpu",compute_type="int8")
bands=[(80,300),(300,1000),(1000,2000),(2000,4000),(4000,8000)]
for hh,mm in [(8,0),(9,15),(9,30),(10,15),(11,15)]:
    x=extract(hh,mm); tag=f"{hh:02d}{mm:02d}"; sf.write(f"ot/ot_{tag}.wav",x,16000)
    f,P=ss.welch(x,16000,nperseg=4096); tot=P.sum()
    bshare=" ".join(f"{lo}-{hi}:{100*P[(f>=lo)&(f<hi)].sum()/tot:.0f}%" for lo,hi in bands)
    segs,info=m.transcribe(x,beam_size=5,condition_on_previous_text=False,vad_filter=True)
    segs=list(segs); words=sum(len(s.text.split()) for s in segs)
    lp=np.mean([s.avg_logprob for s in segs]) if segs else float("nan")
    ns=np.mean([s.no_speech_prob for s in segs]) if segs else float("nan")
    low=sum(1 for s in segs if s.avg_logprob<-1.0)
    print(f"{tag} rms {20*np.log10(np.sqrt(np.mean(x**2))+1e-9):.1f}dBFS clip {100*np.mean(np.abs(x)>=0.999):.2f}% | spectrum {bshare} | lang {info.language} p={info.language_probability:.2f} | segs {len(segs)} words {words} avg_logprob {lp:.2f} low-conf segs {low} no_speech {ns:.2f}",flush=True)
    with open(f"ot/ot_{tag}.txt","w") as o:
        for s in segs: o.write(f"[{s.start:6.1f}-{s.end:6.1f}] lp={s.avg_logprob:.2f} {s.text}\n")
