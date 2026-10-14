"""Stdlib audio helpers: 16 kHz mono int16 WAV (C270 convention). Signals are lists of floats in [-1, 1] until written."""
import array
import hashlib
import math
import random
import struct
import wave

SR = 16000


def write_wav(path, x, sr=SR):
    a = array.array("h", (max(-32768, min(32767, int(round(v * 32767)))) for v in x))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(a.tobytes() if struct.pack("=h", 1) == struct.pack("<h", 1) else _swap(a))
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _swap(a):
    b = array.array("h", a)
    b.byteswap()
    return b.tobytes()


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("not mono int16: " + path)
        sr = w.getframerate()
        a = array.array("h")
        a.frombytes(w.readframes(w.getnframes()))
    if struct.pack("=h", 1) != struct.pack("<h", 1):
        a.byteswap()
    return [v / 32767.0 for v in a], sr


def db(x):
    return 10 ** (x / 20.0)


def rms(x):
    return math.sqrt(sum(v * v for v in x) / len(x)) if x else 0.0


def rms_active(x, sr=SR, frame=0.02, floor_db=-50):
    """RMS over frames louder than floor_db: the speech level used for SNR mixing."""
    n = int(sr * frame)
    fr = [x[i:i + n] for i in range(0, len(x) - n + 1, n)]
    thr = db(floor_db)
    act = [v for f in fr if rms(f) > thr for v in f]
    return rms(act)


def silence(sec, sr=SR):
    return [0.0] * int(round(sec * sr))


def tone(freq, sec, level_dbfs, sr=SR):
    a = db(level_dbfs) * math.sqrt(2)          # level_dbfs is RMS dBFS, so the peak is sqrt(2) higher
    n = int(round(sec * sr))
    return [a * math.sin(2 * math.pi * freq * i / sr) for i in range(n)]


def sweep(f0, f1, sec, level_dbfs, sr=SR):
    a = db(level_dbfs) * math.sqrt(2)
    n = int(round(sec * sr))
    k = (f1 - f0) / sec
    return [a * math.sin(2 * math.pi * (f0 * (i / sr) + 0.5 * k * (i / sr) ** 2)) for i in range(n)]


def dither(sec, level_dbfs, seed, sr=SR):
    rnd = random.Random(seed)
    a = db(level_dbfs) * math.sqrt(3)          # uniform noise: rms = peak / sqrt(3)
    return [rnd.uniform(-a, a) for _ in range(int(round(sec * sr)))]


def fade(x, ms=5, sr=SR):
    n = min(len(x) // 2, int(sr * ms / 1000))
    y = list(x)
    for i in range(n):
        g = i / n
        y[i] *= g
        y[-1 - i] *= g
    return y


def resample_linear(x, sr_in, sr_out=SR):
    if sr_in == sr_out:
        return list(x)
    n = int(len(x) * sr_out / sr_in)
    out = []
    for i in range(n):
        p = i * sr_in / sr_out
        j = int(p)
        f = p - j
        b = x[j + 1] if j + 1 < len(x) else x[j]
        out.append(x[j] * (1 - f) + b * f)
    return out


def mix_at_snr(speech, bed, snr_db):
    """bed scaled so rms_active(speech)/rms(bed) = snr_db; bed is looped/trimmed to len(speech). Result is clipped to +-1."""
    if not bed:
        return list(speech)
    b = (bed * (len(speech) // len(bed) + 1))[:len(speech)]
    sp, br = rms_active(speech), rms(b)
    g = 0.0 if br == 0 else sp / (br * db(snr_db))
    return [max(-1.0, min(1.0, s + g * v)) for s, v in zip(speech, b)]


# ------------------------------------------------------------------ noise beds (synthesised, deterministic per seed)
def bed(kind, sec, seed, sr=SR, speech_pool=None):
    n = int(round(sec * sr))
    rnd = random.Random(seed)
    if kind == "fan":            # low-passed noise + blade-pass hum
        y, s = [], 0.0
        for i in range(n):
            s += 0.05 * (rnd.uniform(-1, 1) - s)
            y.append(s + 0.3 * math.sin(2 * math.pi * 120 * i / sr))
    elif kind == "ac_hum":       # 50 Hz mains harmonics
        y = [sum(math.sin(2 * math.pi * 50 * h * i / sr) / h for h in (1, 2, 3, 5)) for i in range(n)]
    elif kind == "babble":       # overlapped, offset copies of speech clips (no intelligible single talker)
        y = [0.0] * n
        pool = speech_pool or [tone(220 + 40 * k, 1.0, -30) for k in range(6)]
        for k in range(6):
            c = pool[k % len(pool)]
            off = rnd.randrange(0, max(1, n - len(c)))
            for i, v in enumerate(c[:n - off]):
                y[off + i] += v
    elif kind == "door":         # decaying noise thumps at random times
        y = [0.0] * n
        for _ in range(max(1, int(sec // 4))):
            t0 = rnd.randrange(0, max(1, n - sr // 2))
            for i in range(min(sr // 4, n - t0)):
                y[t0 + i] += rnd.uniform(-1, 1) * math.exp(-i / (sr * 0.03))
    elif kind == "phone_ring":   # 440+480 Hz ring bursts (2 s on, 4 s off)
        y = [0.0] * n
        for i in range(n):
            if (i / sr) % 6 < 2:
                y[i] = 0.5 * (math.sin(2 * math.pi * 440 * i / sr) + math.sin(2 * math.pi * 480 * i / sr))
    else:
        raise ValueError("unknown bed " + kind)
    return y


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def jload(path):
    import json
    with open(path) as f:
        return json.load(f)
