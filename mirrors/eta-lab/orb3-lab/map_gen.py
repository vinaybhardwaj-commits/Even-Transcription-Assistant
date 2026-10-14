import numpy as np, soundfile as sf, scipy.signal as ss
fs=48000; T=2.0; f1,f2=200,7000
t=np.arange(int(T*fs))/fs; K=T/np.log(f2/f1)
sw=np.sin(2*np.pi*f1*K*(np.exp(t/K)-1)); fade=int(0.02*fs); w=np.ones_like(sw); w[:fade]=np.linspace(0,1,fade); w[-fade:]=np.linspace(1,0,fade); sw*=w
sp,_=sf.read("speech.wav"); sp=sp[:,0][:int(8*fs)]; sp=sp/np.abs(sp).max()
g=lambda s:np.zeros(int(s*fs))
probe=np.concatenate([g(1.0),0.9*sw,g(0.5),0.9*sp,g(0.5),0.9*sw,g(1.0)])
sf.write("run5/probe.wav",np.stack([probe,probe],1),fs,subtype="PCM_16")
sf.write("run5/probe_speech_src.wav",sp,fs,subtype="PCM_16")
np.save("run5/sweep16k.npy",ss.resample_poly(sw,1,3))
print("probe s",len(probe)/fs)
