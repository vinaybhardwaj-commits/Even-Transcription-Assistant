import numpy as np, soundfile as sf, scipy.signal as ss
sp,fs=sf.read("speech.wav"); sp=sp[:,0]
nz,nfs=sf.read("ot/case_0745_hpf.wav", start=16000*1500, frames=16000*60)   # 60 s of this morning's OT ambience (no speech by VAD)
nz=ss.resample_poly(nz,3,1); nz=np.tile(nz,int(np.ceil(len(sp)/len(nz))))[:len(sp)]
act=np.abs(sp)>1e-4; ps=np.sqrt(np.mean(sp[act]**2)); pn=np.sqrt(np.mean(nz**2))
for snr in [20,10,5,0,-5]:
    m=sp+nz*(ps/pn)*10**(-snr/20); m=m/np.abs(m).max()*0.6
    sf.write(f"run3/mix_snr{snr}.wav",np.stack([m,m],1),fs,subtype="PCM_16")
print("ok",len(sp)/fs)
