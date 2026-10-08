import numpy as np, scipy.io.wavfile as w
fs=48000; seg=[]
def sil(s): return np.zeros(int(fs*s))
t=np.arange(int(fs*3))/fs; tone=0.1*np.sin(2*np.pi*1000*t)            # -20 dBFS
T=10; f1,f2=20,20000; t=np.arange(int(fs*T))/fs; K=T/np.log(f2/f1)
sweep=0.25*np.sin(2*np.pi*f1*K*(np.exp(t/K)-1))                        # -12 dBFS ESS
fade=int(0.05*fs); sweep[:fade]*=np.linspace(0,1,fade); sweep[-fade:]*=np.linspace(1,0,fade)
rng=np.random.default_rng(1); wn=rng.standard_normal(fs*10); F=np.fft.rfft(wn); fr=np.fft.rfftfreq(len(wn),1/fs); F[1:]/=np.sqrt(fr[1:]); F[0]=0
pink=np.fft.irfft(F); pink=pink/np.abs(pink).max()*0.25
x=np.concatenate([sil(2),tone,sil(1),sweep,sil(1),pink,sil(5)])
np.save("sweep.npy",sweep); np.save("pink.npy",pink)
w.write("testsig.wav",fs,(np.stack([x,x],1)*32767).astype(np.int16)); print("testsig %.1fs"%(len(x)/fs))
