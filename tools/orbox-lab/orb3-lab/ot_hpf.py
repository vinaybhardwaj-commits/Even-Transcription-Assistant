import numpy as np, soundfile as sf, scipy.signal as ss
from faster_whisper import WhisperModel
m=WhisperModel("small",device="cpu",compute_type="int8")
sos=ss.butter(4,100,"hp",fs=16000,output="sos")
for tag in ["0915","0930","0800"]:
    x,fs=sf.read(f"ot/ot_{tag}.wav"); y=ss.sosfilt(sos,x); y=y/(np.abs(y).max()+1e-9)*0.5
    sf.write(f"ot/ot_{tag}_hpf.wav",y,fs)
    segs,info=m.transcribe(y.astype(np.float32),beam_size=5,condition_on_previous_text=False,vad_filter=True); segs=list(segs)
    words=sum(len(s.text.split()) for s in segs); lp=np.mean([s.avg_logprob for s in segs]) if segs else float("nan")
    print(f"{tag} HPF100+norm | lang {info.language} p={info.language_probability:.2f} | segs {len(segs)} words {words} avg_logprob {lp:.2f} low-conf {sum(s.avg_logprob<-1 for s in segs)}",flush=True)
    open(f"ot/ot_{tag}_hpf.txt","w").write("\n".join(f"[{s.start:.1f}] lp={s.avg_logprob:.2f} {s.text}" for s in segs))
