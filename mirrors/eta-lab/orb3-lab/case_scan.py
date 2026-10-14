import json, numpy as np, datetime as dt, scipy.signal as ss, soundfile as sf
from faster_whisper import WhisperModel
from faster_whisper.vad import get_speech_timestamps, VadOptions
IST=dt.timezone(dt.timedelta(hours=5,minutes=30))
idx=json.load(open("ot_idx_today.json")); tape="/var/lib/room-recorder/tape/tape.pcm"
def off(h,m):
    t=dt.datetime(2026,10,5,h,m,tzinfo=IST).timestamp()*1e9; return [x for x in idx if x[0]>=t][0]
sos=ss.butter(4,100,"hp",fs=16000,output="sos")
m=WhisperModel("small",device="cpu",compute_type="int8")
for (h0,m0,h1,m1) in [(5,45,6,2),(7,45,9,5)]:
    a=off(h0,m0); b=off(h1,m1); t0=dt.datetime.fromtimestamp(a[0]/1e9,IST)
    with open(tape,"rb") as f: f.seek(a[1]); raw=f.read(b[1]-a[1])
    x=np.frombuffer(raw,dtype="<i2").astype(np.float32)/32768; y=ss.sosfilt(sos,x).astype(np.float32)
    sf.write(f"ot/case_{h0:02d}{m0:02d}_hpf.wav",y,16000)
    ts=get_speech_timestamps(y,VadOptions(threshold=0.4,min_speech_duration_ms=300,min_silence_duration_ms=600))
    sp=sum(t["end"]-t["start"] for t in ts)/16000
    print(f"window {h0:02d}:{m0:02d}-{h1:02d}:{m1:02d} len {len(y)/16000/60:.1f} min | VAD speech {sp/60:.1f} min in {len(ts)} regions",flush=True)
    # per-5-min speech minutes
    bins={}
    for t in ts:
        k=int(t["start"]/16000//300); bins[k]=bins.get(k,0)+(t["end"]-t["start"])/16000
    print("  speech sec per 5 min:", " ".join(f"{(t0+dt.timedelta(seconds=300*k)).strftime('%H:%M')}={v:.0f}" for k,v in sorted(bins.items())),flush=True)
    segs,info=m.transcribe(y,beam_size=5,condition_on_previous_text=False,vad_filter=True,vad_parameters=dict(threshold=0.4,min_silence_duration_ms=600))
    segs=list(segs)
    with open(f"ot/case_{h0:02d}{m0:02d}.txt","w") as o:
        for s in segs: o.write(f"{(t0+dt.timedelta(seconds=s.start)).strftime('%H:%M:%S')} lp={s.avg_logprob:.2f} nsp={s.no_speech_prob:.2f} {s.text.strip()}\n")
    good=[s for s in segs if s.avg_logprob>-0.8]; words=sum(len(s.text.split()) for s in segs)
    print(f"  whisper: lang {info.language} p={info.language_probability:.2f} segs {len(segs)} words {words} | confident segs (lp>-0.8) {len(good)} words {sum(len(s.text.split()) for s in good)}",flush=True)
print("CASE_SCAN_DONE")
