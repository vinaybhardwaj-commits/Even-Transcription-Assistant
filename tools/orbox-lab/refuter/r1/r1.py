# R1 refuter scorer, written from the method text in ORDERS-O1 (not from the builder's files).
# Usage: python r1.py <job>   jobs: base pert arm rnn audit
import os, sys, re, json, ctypes, numpy as np, soundfile as sf, scipy.signal as ss, jiwer
LAB = "/var/lib/orb3-lab/"; DEN = os.environ.get("ORB_LAB_DEN", "<orb3 lab den dir>/"); FS = 16000
REF = open(LAB + "speech_text.txt").read()

def clean(t):
    t = t.lower().replace("-", " ")
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    return " ".join(t.split())

HP = ss.butter(4, 80, btype="highpass", fs=FS, output="sos")
def prep(x48):                      # 48 kHz -> 16 kHz, 80 Hz 4th-order HPF, float32
    return ss.sosfilt(HP, ss.resample_poly(x48, 1, 3)).astype(np.float32)

_model = None
def asr(x16, start_s=0.0):
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=4)
    segs, _ = _model.transcribe(x16[int(start_s * FS):], language="en", beam_size=5,
                                condition_on_previous_text=False, vad_filter=False)
    return " ".join(s.text for s in segs)

def wer(x16, start_s=0.0): return round(100 * jiwer.wer(clean(REF), clean(asr(x16, start_s))), 1)

def read(p, dtype="float64"):
    x, sr = sf.read(p, dtype=dtype); assert sr == 48000 and x.ndim == 1, (p, sr, x.shape); return x

def pair(pa, pb, dtype="float64"):  # run3 scoring truncates A/B to common length (as stress_score.py)
    a, b = prep(read(pa, dtype)), prep(read(pb, dtype)); n = min(len(a), len(b)); return a[:n], b[:n]

# --- independent selector: 2 s windows, 1 s hop, 300-4000 Hz band power, noise floor = 10th pct (run3)
BP = ss.butter(4, [300, 4000], btype="bandpass", fs=FS, output="sos")
def snr_track(x):
    y = ss.sosfilt(BP, x).astype(np.float64)
    pw = np.array([np.mean(y[i:i + 2 * FS] ** 2) for i in range(0, len(y) - 2 * FS + 1, FS)])
    nf = np.percentile(pw, 10)
    return 10 * np.log10(np.clip(pw - nf, 1e-3 * nf, None) / nf)
def select(a, b):
    sa, sb = snr_track(a), snr_track(b); nwin = len(sa); n = len(a)
    useb = np.zeros(n)
    for blk in range(int(np.ceil(n / FS))):          # 1 s block covered by windows blk-1 and blk
        w = [i for i in (blk - 1, blk) if 0 <= i < nwin]
        if sb[w].mean() > sa[w].mean(): useb[blk * FS:(blk + 1) * FS] = 1
    xf = int(0.05 * FS); useb = np.convolve(useb, np.ones(xf) / xf, mode="same")
    return ((1 - useb) * a + useb * b).astype(np.float32), float((sa >= sb).mean()), nwin

# --- own RNNoise loop straight on the C library (480-sample frames, int16-scaled float)
def rnnoise(x48):
    lib = ctypes.CDLL(os.environ.get("PYRNNOISE_LIB", "librnnoise.so"))
    lib.rnnoise_create.restype = ctypes.c_void_p; lib.rnnoise_create.argtypes = [ctypes.c_void_p]
    lib.rnnoise_destroy.argtypes = [ctypes.c_void_p]
    lib.rnnoise_process_frame.restype = ctypes.c_float
    lib.rnnoise_process_frame.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_float)]
    N = lib.rnnoise_get_frame_size(); st = lib.rnnoise_create(None)
    x = np.clip(x48, -1, 1) * 32768.0; n = len(x); x = np.pad(x, (0, -n % N)).astype(np.float32)
    out = np.zeros_like(x); vad = []
    for i in range(0, len(x), N):
        fi = np.ascontiguousarray(x[i:i + N]); fo = np.zeros(N, np.float32)
        vad.append(lib.rnnoise_process_frame(st, fo.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
                                             fi.ctypes.data_as(ctypes.POINTER(ctypes.c_float))))
        out[i:i + N] = fo
    lib.rnnoise_destroy(st)
    return (out[:n] / 32768.0).astype(np.float64), N, float(np.mean(vad))

def rms(x): return float(np.sqrt(np.mean(np.asarray(x, np.float64) ** 2)))
def emit(**k): print(json.dumps(k), flush=True)

job = sys.argv[1]
A5, B5 = LAB + "run3/micA_snr5.wav", LAB + "run3/micB_snr5.wav"
if job == "base":
    a, b = pair(A5, B5); emit(check=1, file="run3 snr5", A=wer(a), B=wer(b), exp=[59.9, 49.6])
elif job == "pert":
    a, _ = pair(A5, B5); emit(check=7, pert="none", A=wer(a))
    x = read(A5)
    a1 = prep(x[1:]); emit(check=7, pert="shift +1 sample @48k", A=wer(a1))
    emit(check=7, pert="gain +0.1 dB", A=wer(prep(x * 10 ** (0.1 / 20))))
    emit(check=7, pert="gain -0.1 dB", A=wer(prep(x * 10 ** (-0.1 / 20))))
    emit(check=7, pert="float32 read+resample", A=wer(prep(read(A5, "float32"))))
elif job == "arm":
    a, b = pair(DEN + "dfn/run3_micA_snr20.wav", DEN + "dfn/run3_micB_snr20.wav", "float32")
    emit(check=2, cell="run3 snr20 DFN micA", A=wer(a), reported=37.2)
    a, b = pair(LAB + "run3/micA_snr20.wav", LAB + "run3/micB_snr20.wav")
    s, fa, nw = select(a, b)
    emit(check=2, cell="run3 snr20 raw selector", sel=wer(s), fracA=round(fa, 2), nwin=nw, reported=[24.8, 0.36])
elif job == "rnn":
    sp, sr = sf.read(LAB + "speech.wav"); assert sr == 48000; sp = sp[:, 0]   # stereo source; channel 0
    emit(check=6, what="clean speech.wav no denoise", wer=wer(prep(sp)))
    y, N, v = rnnoise(sp)
    emit(check=6, what="clean speech.wav own RNNoise", frame=N, vad=round(v, 2), rms_in=round(rms(sp), 4), rms_out=round(rms(y), 4), wer=wer(prep(y)))
    x = read(LAB + "run3/micA_snr20.wav"); y, N, v = rnnoise(x)
    bld = read(DEN + "rnn/run3_micA_snr20.wav")
    lags = range(-960, 961); seg = slice(48000, 48000 * 40)
    c = [np.corrcoef(y[seg], np.roll(bld, -L)[seg])[0, 1] for L in (0, 480, -480)]
    emit(check=6, what="run3 snr20 A own RNNoise", vad=round(v, 2), rms_in=round(rms(x), 4), rms_out=round(rms(y), 4),
         rms_builder=round(rms(bld), 4), corr_vs_builder_lag0_480_m480=[round(t, 4) for t in c], wer=wer(prep(y)))
elif job == "audit":
    import os
    for arm in ("dfn", "rnn"):
        for f in sorted(os.listdir(DEN + arm)):
            run, rest = f.split("_", 1); src = LAB + run + "/" + rest
            i, o = sf.info(src), sf.info(DEN + arm + "/" + f)
            emit(check=4, arm=arm, file=f, sr_in=i.samplerate, sr_out=o.samplerate, n_in=i.frames, n_out=o.frames,
                 ch_out=o.channels, ok=(i.samplerate == o.samplerate and i.frames == o.frames and o.channels == 1))
emit(done=job)
