import numpy as np, soundfile as sf, scipy.signal as ss, json
fs=48000
sp,_=sf.read("speech.wav"); sp=sp[:,0]
nz,_=sf.read("ot/case_0745_hpf.wav", start=16000*1500, frames=16000*60)
nz=ss.resample_poly(nz,3,1)
lead=5*fs; tail=2*fs; L=lead+len(sp)+tail
nz=np.tile(nz,int(np.ceil(L/len(nz))))[:L]
act=np.abs(sp)>1e-4; ps=np.sqrt(np.mean(sp[act]**2)); pn=np.sqrt(np.mean(nz**2))
spf=np.zeros(L); spf[lead:lead+len(sp)]=sp
def noise(snr): return nz*(ps/pn)*10**(-snr/20)
takes=[]
def write(name,l,r,gain):
    pk=max(np.abs(l).max(),np.abs(r).max()); l=l/pk*0.6; r=r/pk*0.6
    sf.write(f"run4/{name}.wav",np.stack([l,r],1),fs,subtype="PCM_16"); takes.append([name,gain])
z=np.zeros(L)
write("spL_nzR_0", spf, noise(0), 41)
write("spR_nzL_0", noise(0), spf, 41)
write("both_0", spf+noise(0), spf+noise(0), 41)
write("spL_nzR_m5", spf, noise(-5), 41)
write("spR_nzL_m5", noise(-5), spf, 41)
for g in (31,41,51):
    m=spf+noise(10); write(f"both_10_g{g}", m, m, g)
t=np.arange(3*fs)/fs; tone=0.3*np.sin(2*np.pi*1000*t); gap=np.zeros(fs)
cl=np.concatenate([gap,tone,gap,0*tone,gap]); cr=np.concatenate([gap,0*tone,gap,tone,gap])
sf.write("run4/chanid.wav",np.stack([cl,cr],1),fs,subtype="PCM_16")
json.dump(takes,open("run4/takes.json","w")); print("ok",len(takes),L/fs)
