# Denoise 48 kHz lab files with DeepFilterNet3 and RNNoise. Output: ~/orbox-lab/o1/den/<arm>/<name>.wav (48 kHz mono float).
import sys, os, types, time, json, numpy as np, soundfile as sf
# torchaudio>=2.9 removed torchaudio.backend; df.io only imports AudioMetaData from it.
m = types.ModuleType("torchaudio.backend"); c = types.ModuleType("torchaudio.backend.common")
c.AudioMetaData = type("AudioMetaData", (), {}); m.common = c
sys.modules["torchaudio.backend"] = m; sys.modules["torchaudio.backend.common"] = c
import torch
L = "/var/lib/orb3-lab/"; OUT = os.path.expanduser("~/orbox-lab/o1/den/")
FILES = [f"run3/mic{m_}_snr{s}.wav" for s in (20, 10, 5, 0) for m_ in "AB"] + \
        [f"run4/mic{m_}_{t}.wav" for t in ("spL_nzR_0", "spR_nzL_0", "both_0", "both_10_g41") for m_ in "AB"]
def dfn():
    from df.enhance import enhance, init_df
    model, st, _ = init_df()
    def f(x):
        assert st.sr() == 48000
        y = enhance(model, st, torch.from_numpy(x.astype(np.float32))[None])
        return y[0].numpy()
    return f
def rnn():
    from pyrnnoise import RNNoise
    def f(x):
        r = RNNoise(48000); pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)[None]
        out = [fr for _, fr in r.denoise_chunk(pcm, partial=True)]
        y = np.concatenate([np.asarray(o).reshape(-1) for o in out]).astype(np.float32) / 32767
        return y
    return f
arms = {"dfn": dfn, "rnn": rnn}
for arm in sys.argv[1:]:
    os.makedirs(OUT + arm, exist_ok=True); f = arms[arm](); t0 = time.time()
    for p in FILES:
        x, sr = sf.read(L + p, dtype="float32"); assert sr == 48000 and x.ndim == 1
        y = f(x); n = min(len(x), len(y))
        print(arm, p, len(x), len(y), f"rms in {np.sqrt(np.mean(x**2)):.4f} out {np.sqrt(np.mean(y[:n]**2)):.4f}", flush=True)
        sf.write(OUT + arm + "/" + p.split("/")[0] + "_" + os.path.basename(p), y, 48000, subtype="FLOAT")
    print(arm, "seconds", round(time.time() - t0), flush=True)
