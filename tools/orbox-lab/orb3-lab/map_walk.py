import numpy as np, soundfile as sf
p,fs=sf.read("run5/probe.wav"); p=p[:,0]; gap=np.zeros(15*fs)
w=np.concatenate([np.zeros(10*fs)]+[np.concatenate([p,gap]) for _ in range(20)])
sf.write("run5/room_probe_walk.wav",w,fs,subtype="PCM_16"); sf.write("run5/room_probe_single.wav",p,fs,subtype="PCM_16")
print("walk min",len(w)/fs/60)
