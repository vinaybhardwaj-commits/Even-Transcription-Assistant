#!/usr/bin/env python3
"""mic_selftest.py <room>: prove a room microphone physically hears sound, without anyone in the room (rulings 368 + 369, INTERIM lab tool).

Run from the Mini only. Plays a fixed reference on the room Mac's own speaker with afplay: [3 chirps] [0.5 s] [the canary word 'supercalifragilisticexpialidocious',
rendered ONCE on the Mini with `say -v Rishi -r 150`, canary.wav] [0.5 s] [3 chirps]; a chirp is 400 ms, linear 1-3 kHz, 300 ms gaps. It pulls the tape tail (`tail -c`)
and looks for the whole reference with a normalised cross-correlation (matched filter), so a quiet chirp or word is still found.
Two results per run: (a) ACOUSTIC, now: detected, snr_db, lag_ms, plus a speech-band check on the word (300-3400 Hz vs the chirp band); (b) STT, deferred: when the
window is transcribed, `fuzzy_canary(text)` says whether the word came back (edit-distance ratio >= 0.6 on any spelling). A pass on (a) and a miss on (b) is an STT/routing
fault, not the mic. Every run logs its exact tape interval so selftest_filter.py can keep the canary and the chirps out of every patient record.

Modes (default is the first; nothing here touches a room without a named order):
  plan        (default, --dry-run)  offline: validates the table, the room-state file, the rate limit; writes the reference WAV to scratch; prints the exact remote commands. No network.
  --check-only --fable-order TEXT   read-only preconditions on the Mac (pgrep, stat, tail): interlock + speech-level rule + the dead-room rule. No sound.
  --live       --fable-order TEXT   the full run. Needs a room-state file that says recording, not paused, and a pre-registered calibration.json (see calibrate.py): without one, refuse.

HARD RULE (ruling 368 item 5): on a room Mac this tool runs only afplay, date, tail, stat, pgrep, scp and rm of its own /tmp/mic-selftest-*.wav. Never python3 or any dev tool
(a python3 call raised an Xcode install dialog on OPD 4's screen). `remote_check()` enforces the list on every command before it leaves the Mini.
Never changes the Mac's volume or any setting: afplay plays at the CURRENT output volume.

Output: one JSON line per run in scratch/mic-selftest.jsonl (--log overrides). Stdlib only.
"""
import argparse, calendar, cmath, hashlib, json, math, os, random, re, shlex, subprocess, sys, time, wave

SR = 16000                       # C270 tape: 16 kHz mono int16 little-endian, headerless (tape.pcm)
CHIRP_HZ = (1000.0, 3000.0)
CHIRP_MS, GAP_MS, N_CHIRPS = 400, 300, 3
AMPLITUDE = 0.5                  # of full scale; the Mac's own volume decides what the room hears
CHUNK_FULL_MS = 290_000          # a recorded chunk is 5 min; shorter ones (a session start or end) are not used by the chunk-rate gate
CHUNK_GATE_N = 2                 # the last two full chunks
CANARY_GAP_MS = 500              # [3 chirps] [0.5 s] [word] [0.5 s] [3 chirps]
CANARY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "canary.wav")
CANARY_SHA256 = "6101c99908207af0dd9fef88f87543743fe8a8c1285e49c6db828c286614d728"      # `say -v Rishi -r 150`, trimmed, peak 0.5, 16 kHz mono int16; rendered once, never re-rendered
CANARY_WORD = "supercalifragilisticexpialidocious"
FUZZY_MIN_RATIO = 0.6            # ruling 369 item 3
SPEECH_BAND = (300.0, 3400.0)
SPEECH_LOSS_MAX_DB = 10.0        # word-band SNR may fall this far below what the chirp-band SNR predicts before the mic counts as muffling speech (uncalibrated proposal)
# ---- pre-registered constants (radar-kit's proposal; UNCALIBRATED against real tape: read 1 h of tape before the first live run; both are refusal-side safe) ----
NCC_THRESHOLD = 0.15             # noise-only NCC peaks sit near 0.03-0.05 over a 16 s window; a -6 dB chirp gives about 0.45
SPEECH_RMS = 0.010               # full-scale RMS of a 1 s frame that counts as speech-level
SPEECH_FRAMES_MIN = 1            # refuse if this many 1 s frames in the look-back reach SPEECH_RMS (any single frame: the safe direction)
LOOKBACK_S = 300                 # "no speech-level signal in the last 5 min of tape"
RATE_LIMIT_S = 3600              # max 1 live run per room per hour
BEFORE_S, AFTER_S = 5, 6         # tape kept before the first sample of sound and after afplay returns

# Room -> Mac. Explicit. WARNING: two Macs are named <KIOSK_HOST> (OPD 3 = <TAILNET_IP>, OPD 4 = <TAILNET_IP> '(2)'); the interlock, not the name, tells them apart.
# Users are from docs/handoff of the ETA repo (11-12 Sep); only the two rooms named in ruling 368 are listed. Extend on an order.
# room_id is the vault room id that transcript segments carry (from lab-mover's tape manifest: r2 key slug opd-3-kjpf = room_87frpus9, opd-4-ortho-778q = room_ux92qpws).
ROOMS = {
    "opd3": {"ip": "<TAILNET_IP>", "user": "<KIOSK_HOST>", "label": "OPD 3 (<KIOSK_HOST>)", "room_id": "room_87frpus9"},
    "opd4": {"ip": "<TAILNET_IP>", "user": "<KIOSK_HOST>", "label": "OPD 4 (<KIOSK_HOST> (2))", "room_id": "room_ux92qpws"},
}
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LOG = os.path.join(HERE, "..", "..", "scratch", "mic-selftest.jsonl")


class Refuse(Exception):
    """A precondition failed. Nothing was played."""


# ------------------------------------------------------------------ reference signal
def load_canary():
    """The pre-rendered canary word as floats. Refuses if canary.wav is not the exact file this code was written for."""
    with open(CANARY_FILE, "rb") as f:
        data = f.read()
    if hashlib.sha256(data).hexdigest() != CANARY_SHA256:
        raise Refuse("canary.wav is not the rendered-once reference (sha256 mismatch)")
    with wave.open(CANARY_FILE, "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, SR):
            raise Refuse("canary.wav is not 16 kHz mono int16")
        raw = w.readframes(w.getnframes())
    return [int.from_bytes(raw[2 * i:2 * i + 2], "little", signed=True) / 32768.0 for i in range(len(raw) // 2)]


def chirp_train():
    """3 x 400 ms linear chirps (1-3 kHz), 300 ms gaps, 16 kHz, 10 ms raised-cosine edges. Floats in [-AMPLITUDE, AMPLITUDE]."""
    n = SR * CHIRP_MS // 1000
    gap = [0.0] * (SR * GAP_MS // 1000)
    f0, f1 = CHIRP_HZ
    k = (f1 - f0) / (CHIRP_MS / 1000.0)
    edge = SR // 100
    one = []
    for i in range(n):
        t = i / SR
        w = 1.0
        if i < edge:
            w = 0.5 - 0.5 * math.cos(math.pi * i / edge)
        elif i >= n - edge:
            w = 0.5 - 0.5 * math.cos(math.pi * (n - 1 - i) / edge)
        one.append(AMPLITUDE * w * math.sin(2 * math.pi * (f0 * t + 0.5 * k * t * t)))
    out = []
    for c in range(N_CHIRPS):
        out += one
        if c < N_CHIRPS - 1:
            out += gap
    return out


def layout():
    """Sample offsets inside the reference: (chirps1_end, word_start, word_end, chirps2_start, total)."""
    train = SR * (N_CHIRPS * CHIRP_MS + (N_CHIRPS - 1) * GAP_MS) // 1000
    gap = SR * CANARY_GAP_MS // 1000
    word = len(load_canary())
    return train, train + gap, train + gap + word, train + 2 * gap + word, 2 * train + 2 * gap + word


def make_reference():
    """[3 chirps] [0.5 s] [canary word] [0.5 s] [3 chirps]: the file played on every run, and the matched filter's template."""
    train = chirp_train()
    gap = [0.0] * (SR * CANARY_GAP_MS // 1000)
    return train + gap + load_canary() + gap + train


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(int(max(-1.0, min(1.0, s)) * 32767).to_bytes(2, "little", signed=True) for s in samples))


# ------------------------------------------------------------------ analysis (Mini only)
def pcm_to_floats(pcm):
    n = len(pcm) // 2
    return [int.from_bytes(pcm[2 * i:2 * i + 2], "little", signed=True) / 32768.0 for i in range(n)]


def _fft(a, invert=False):
    n = len(a)
    j = 0
    for i in range(1, n):                                   # bit-reversal permutation
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    length = 2
    while length <= n:
        ang = 2 * math.pi / length * (1 if invert else -1)
        roots = [cmath.exp(1j * ang * k) for k in range(length // 2)]
        half = length // 2
        for start in range(0, n, length):
            for k in range(half):
                u = a[start + k]
                v = a[start + k + half] * roots[k]
                a[start + k] = u + v
                a[start + k + half] = u - v
        length <<= 1
    if invert:
        for i in range(n):
            a[i] /= n
    return a


def ncc_profile(x, h):
    """Normalised cross-correlation of the reference h against every position of x. Returns a list: ncc[k] for k in 0..len(x)-len(h).
    Means are removed; a stretch with no energy gives 0 (never a division by zero)."""
    lx, lh = len(x), len(h)
    if lx < lh:
        return []
    mx = sum(x) / lx
    mh = sum(h) / lh
    xc = [v - mx for v in x]
    hc = [v - mh for v in h]
    n = 1
    while n < lx + lh:
        n <<= 1
    fx = _fft([complex(v) for v in xc] + [0j] * (n - lx))
    fh = _fft([complex(v) for v in hc] + [0j] * (n - lh))
    prod = [fx[i] * fh[i].conjugate() for i in range(n)]
    corr = _fft(prod, invert=True)
    eh = math.sqrt(sum(v * v for v in hc))
    csum = [0.0]
    for v in xc:
        csum.append(csum[-1] + v * v)
    out = []
    for k in range(lx - lh + 1):
        ex = math.sqrt(max(csum[k + lh] - csum[k], 0.0))
        den = ex * eh
        out.append(corr[k].real / den if den > 1e-12 else 0.0)
    return out


def _rms(v):
    return math.sqrt(sum(s * s for s in v) / len(v)) if v else 0.0


def band_power(x, lo, hi, sr=SR):
    """Mean power of x inside [lo, hi] Hz (Parseval on one FFT); the same units for any segment length, so a segment and a noise stretch compare."""
    n = 1
    while n < len(x):
        n <<= 1
    if not x:
        return 0.0
    m = sum(x) / len(x)
    f = _fft([complex(v - m) for v in x] + [0j] * (n - len(x)))
    k0, k1 = int(lo * n / sr), int(hi * n / sr)
    return 2.0 * sum(abs(f[k]) ** 2 for k in range(max(k0, 1), min(k1, n // 2) + 1)) / (n * len(x))


def _snr_db(p_seg, p_noise):
    return 10 * math.log10(max(p_seg - p_noise, 1e-18) / p_noise) if p_noise > 0 else None


def speech_band_check(x, idx, n_before, ref):
    """Does the word come through as well as the chirps? loss_db = (chirp-band SNR - word-band SNR) - the same gap in the reference itself.
    None when the noise stretch is exactly zero (no basis)."""
    c1, w0, w1, c2, total = layout()
    noise_seg = x[:n_before]
    pn_c = band_power(noise_seg, *CHIRP_HZ)
    pn_w = band_power(noise_seg, *SPEECH_BAND)
    if pn_c <= 0 or pn_w <= 0:
        return None
    chirp_rx = band_power(x[idx:idx + c1], *CHIRP_HZ)
    word_rx = band_power(x[idx + w0:idx + w1], *SPEECH_BAND)
    chirp_ref = band_power(ref[:c1], *CHIRP_HZ)
    word_ref = band_power(ref[w0:w1], *SPEECH_BAND)
    s_c, s_w = _snr_db(chirp_rx, pn_c), _snr_db(word_rx, pn_w)
    ref_gap = 10 * math.log10(chirp_ref / word_ref)
    loss = (s_c - s_w) - ref_gap
    return dict(chirp_snr_db=round(s_c, 1), word_snr_db=round(s_w, 1), loss_db=round(loss, 1), ok=bool(loss <= SPEECH_LOSS_MAX_DB or s_w >= 15.0))


def analyse(pcm, n_before, reference=None):
    """pcm = tape bytes. The first n_before samples are the tape BEFORE the sound was started. Returns the run result (no interpretation of the room)."""
    ref = reference or make_reference()
    x = pcm_to_floats(pcm)
    res = dict(detected=False, snr_db=None, lag_ms=None, ncc_peak=None, rms_before=None, rms_during=None, rms_after=None, speech_band_ok=None, notes=[])
    if not x or max(abs(s) for s in x) == 0.0:
        res["notes"].append("dead input")                    # every sample exactly 0: the input is dead, not merely quiet
        res["rms_before"] = res["rms_during"] = res["rms_after"] = 0.0
        res["ncc_peak"] = 0.0
        return res
    prof = ncc_profile(x, ref)
    lo = max(0, n_before - SR // 2)                          # the sound cannot start before the tape position where we started it
    win = prof[lo:] if lo < len(prof) else []
    if not win:
        res["notes"].append("tape too short")
        return res
    peak = max(win)
    idx = lo + win.index(peak)
    res["ncc_peak"] = round(peak, 4)
    res["detected"] = peak >= NCC_THRESHOLD
    before = x[:n_before]
    res["rms_before"] = round(_rms(before), 6)
    if res["detected"]:
        during = x[idx:idx + len(ref)]
        after = x[idx + len(ref):]
        pb = _rms(before) ** 2
        pd = _rms(during) ** 2
        res["lag_ms"] = round((idx - n_before) * 1000.0 / SR, 1)
        res["snr_db"] = round(10 * math.log10(max(pd - pb, 1e-12) / pb), 1) if pb > 0 else None
        sb = speech_band_check(x, idx, n_before, ref)
        res["speech_band"] = sb
        res["speech_band_ok"] = None if sb is None else sb["ok"]
    else:
        during = x[n_before:n_before + len(ref) + SR]
        after = x[n_before + len(ref) + SR:]
    res["rms_during"] = round(_rms(during), 6)
    res["rms_after"] = round(_rms(after), 6)
    return res


def speech_check(pcm, sr=SR, speech_rms=SPEECH_RMS):
    """Pre-registered rule: 1 s frames over the look-back; refuse if SPEECH_FRAMES_MIN or more reach speech_rms. Returns (ok, frames_over, frames, max_rms)."""
    x = pcm_to_floats(pcm)
    frames = [x[i:i + sr] for i in range(0, len(x) - sr + 1, sr)]
    rms = [_rms(f) for f in frames]
    over = sum(1 for r in rms if r >= speech_rms)
    return over < SPEECH_FRAMES_MIN, over, len(frames), (max(rms) if rms else 0.0)


def window_level(rms, quantile):
    """The quantile-th (nearest rank) of the 1 s frame RMS values; quantile 1.0 is the maximum."""
    s = sorted(rms)
    return s[min(len(s) - 1, max(0, int(math.ceil(quantile * len(s))) - 1))]


def dead_check(pcm, window_s, dead_rms_max, sr=SR, quantile=1.0):
    """Ruling 369 item 1: 'dead', no background noise at all, not merely quiet: the quantile-th (default: every, i.e. the max) of the 1 s frame RMS over the last window_s seconds
    is <= dead_rms_max. Fewer than window_s full seconds of tape is not dead (we did not see enough). Returns (ok, frames_seen, level)."""
    x = pcm_to_floats(pcm)
    frames = [x[i:i + sr] for i in range(0, len(x) - sr + 1, sr)][-window_s:]
    rms = [_rms(f) for f in frames]
    level = window_level(rms, quantile) if rms else 0.0
    return (len(frames) >= window_s and level <= dead_rms_max), len(frames), level


CHUNK_FRESH_S = 720              # the newer of the two chunks must have ended within 12 min of now (5-min chunks plus upload time)


def _to_epoch(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)", v)
        if m:
            base = calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S"))
            off = 0 if m.group(2) == "Z" else (1 if m.group(2)[0] == "+" else -1) * (int(m.group(2)[1:3]) * 3600 + int(m.group(2)[4:6]) * 60)
            return float(base - off)
    return None


def chunk_gate(chunks, max_bps, session_id, now, n=CHUNK_GATE_N, fresh_s=CHUNK_FRESH_S):
    """Independent second 'dead' gate on the recorded chunks (eta-refuter #2227 item 3, #2240): the last n FULL chunks (duration >= CHUNK_FULL_MS) must each run at <= max_bps
    bytes/second. A room with no background noise compresses to a fraction of an occupied room's rate (today: OPD 4 empty 892-1449 B/s, every occupied room >= 3500).
    It must be the room's CURRENT evidence, so each chunk carries {size_bytes, duration_ms, idx, session_id, ended_at} (from bench_chunk) and the gate refuses unless the whole
    list is in ascending idx order, the last n full chunks are consecutive idx of the current recording session, and the newest ended within fresh_s of now (and not in the
    future). Returns (ok, rates_bps, reason); reason is None when ok. Fewer than n full chunks is not ok (we did not see enough)."""
    good = []
    for c in chunks or []:
        if (isinstance(c, dict) and isinstance(c.get("size_bytes"), (int, float)) and isinstance(c.get("duration_ms"), (int, float)) and c["duration_ms"] > 0
                and isinstance(c.get("idx"), int) and not isinstance(c.get("idx"), bool) and isinstance(c.get("session_id"), str) and _to_epoch(c.get("ended_at")) is not None):
            good.append(c)
    idxs_all = [c["idx"] for c in good]
    if any(b <= a for a, b in zip(idxs_all, idxs_all[1:])):
        return False, [], "recent_chunks are not in ascending idx order"
    full = [c for c in good if c["duration_ms"] >= CHUNK_FULL_MS]
    last = full[-n:]
    if len(last) < n:
        return False, [], f"fewer than {n} full chunks"
    if any(c["session_id"] != session_id for c in last):
        return False, [], "a chunk belongs to another recording session"
    idxs = [c["idx"] for c in last]
    if idxs != list(range(idxs[0], idxs[0] + n)):
        return False, [], "the last full chunks are not consecutive"
    ended = _to_epoch(last[-1]["ended_at"])
    if now - ended > fresh_s:
        return False, [], f"the newest chunk ended {int(now - ended)} s ago (limit {fresh_s} s): stale room-state file"
    if ended - now > 60:
        return False, [], "the newest chunk ends in the future"
    rates = [c["size_bytes"] * 1000.0 / c["duration_ms"] for c in last]
    if not all(r <= max_bps for r in rates):
        return False, rates, f"chunk rates {[round(r) for r in rates]} B/s exceed the limit {max_bps}"
    return True, rates, None


# ------------------------------------------------------------------ STT result (deferred): did the canary come back as text?
def _lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# The Indic scripts sit in parallel Unicode blocks (ISCII order), so one Devanagari table covers them all: shift the code point, then transliterate.
INDIC_BLOCKS = (0x0900, 0x0980, 0x0A00, 0x0A80, 0x0B00, 0x0B80, 0x0C00, 0x0C80, 0x0D00)      # Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam
_DEV_VOWELS = {0x05: "a", 0x06: "a", 0x07: "i", 0x08: "i", 0x09: "u", 0x0A: "u", 0x0B: "ri", 0x0D: "e", 0x0E: "e", 0x0F: "e", 0x10: "ai", 0x11: "o", 0x12: "o", 0x13: "o", 0x14: "au"}
_DEV_CONS = {0x15: "k", 0x16: "kh", 0x17: "g", 0x18: "gh", 0x19: "n", 0x1A: "ch", 0x1B: "chh", 0x1C: "j", 0x1D: "jh", 0x1E: "n", 0x1F: "t", 0x20: "th", 0x21: "d", 0x22: "dh",
             0x23: "n", 0x24: "t", 0x25: "th", 0x26: "d", 0x27: "dh", 0x28: "n", 0x29: "n", 0x2A: "p", 0x2B: "ph", 0x2C: "b", 0x2D: "bh", 0x2E: "m", 0x2F: "y", 0x30: "r",
             0x31: "r", 0x32: "l", 0x33: "l", 0x34: "l", 0x35: "v", 0x36: "sh", 0x37: "sh", 0x38: "s", 0x39: "h"}
_DEV_MATRAS = {0x3E: "a", 0x3F: "i", 0x40: "i", 0x41: "u", 0x42: "u", 0x43: "ri", 0x45: "e", 0x46: "e", 0x47: "e", 0x48: "ai", 0x49: "o", 0x4A: "o", 0x4B: "o", 0x4C: "au"}
_DEV_SIGNS = {0x01: "n", 0x02: "n", 0x03: "h"}


def _dev_offset(ch):
    cp = ord(ch)
    for b in INDIC_BLOCKS:
        if b <= cp < b + 0x80:
            return cp - b
    return None


def indic_to_latin(word):
    """Rough phonetic Latin for a word in any of the nine Indic blocks. Not a scholarly transliteration: the long/short and retroflex/dental distinctions go, and that is
    what the fuzzy match wants (a speech engine spells a foreign word by ear)."""
    out = []
    inherent_last = False                                              # the last vowel emitted was a consonant's inherent 'a'
    i = 0
    n = len(word)
    while i < n:
        inherent_last = False
        o = _dev_offset(word[i])
        if o is None:
            out.append(word[i].lower() if word[i].isalpha() else "")
            i += 1
            continue
        if o in _DEV_CONS:
            out.append(_DEV_CONS[o])
            nxt = _dev_offset(word[i + 1]) if i + 1 < n else None
            if nxt in _DEV_MATRAS:
                out.append(_DEV_MATRAS[nxt])
                i += 2
                continue
            if nxt == 0x4D:                                            # virama: no vowel
                i += 2
                continue
            out.append("a")                                            # the inherent vowel
            inherent_last = True
        elif o in _DEV_VOWELS:
            out.append(_DEV_VOWELS[o])
        elif o in _DEV_SIGNS:
            out.append(_DEV_SIGNS[o])
        i += 1
    s = "".join(out)
    return s[:-1] if len(s) > 2 and inherent_last else s                    # a word-final inherent 'a' is not pronounced; an explicit vowel sign is


_SKELETON_RULES = (("ph", "f"), ("x", "ks"), ("q", "k"), ("c", "k"), ("w", "v"), ("z", "s"), ("h", ""), ("y", "i"), ("e", "a"), ("o", "u"))


def skeleton(text):
    """Letters only, folded to what a listener hears: c/k/q, ph/f, x/ks, w/v, s/z, no h, and three vowel classes (a/e, i/y, o/u); doubled letters collapse."""
    s = re.sub(r"[^a-z]", "", text.lower())
    for a, b in _SKELETON_RULES:
        s = s.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", s)


CANARY_SKELETON = skeleton(CANARY_WORD)


def _word_skeletons(text):
    """Skeleton per whitespace/punctuation-separated word; a word in an Indic script is transliterated first."""
    out = []
    for w in re.split(r"[\s,.;:!?()\[\]\"'/\\|-]+", text):
        if not w:
            continue
        if any(_dev_offset(ch) is not None for ch in w):
            w = indic_to_latin(w)
        sk = skeleton(w)
        if sk:
            out.append(sk)
    return out


def fuzzy_canary(text, min_ratio=FUZZY_MIN_RATIO):
    """(matched, best_ratio). Any spelling and any script: runs of up to 8 consecutive words are joined ('super cali fragilistic...' counts), folded to a phonetic skeleton
    (Indic scripts transliterated first), and matched by edit-distance ratio 1 - lev/max(len, len(canary)) >= min_ratio."""
    tokens = _word_skeletons(text)
    L = len(CANARY_SKELETON)
    best = 0.0
    for i in range(len(tokens)):
        joined = ""
        for j in range(i, min(i + 8, len(tokens))):
            joined += tokens[j]
            if len(joined) > 2 * L:
                break
            if len(joined) < 0.5 * L:
                continue
            best = max(best, 1 - _lev(joined, CANARY_SKELETON) / max(len(joined), L))
    return best >= min_ratio, round(best, 3)


def stt_result(text, engine, language):
    """The deferred half of a run's result: recorded next to the acoustic one when the window has been transcribed."""
    hit, ratio = fuzzy_canary(text)
    return dict(stt_heard=bool(hit), stt_ratio=ratio, engine=engine, language=language)


# ------------------------------------------------------------------ pre-registered calibration (ruling 369 item 1)
DEFAULT_CAL = os.path.join(HERE, "calibration.json")


def load_calibration(path=DEFAULT_CAL):
    """calibration.json must exist and say status 'preregistered' (written by calibrate.py from real tape and committed BEFORE any live run).
    Returns (dict, sha256). Anything missing refuses: no calibration, no live run and no check-only either."""
    if not os.path.exists(path):
        raise Refuse("no pre-registered calibration.json (dead-room threshold): run calibrate.py on real tape and commit it before any live run")
    with open(path, "rb") as f:
        raw = f.read()
    try:
        cal = json.loads(raw)
    except ValueError:
        raise Refuse("calibration.json is not JSON")
    for k in ("dead_rms_max", "dead_window_s", "speech_rms", "chunk_rate_max_bps", "source", "preregistered_at"):   # dead_quantile is optional (default 1.0: every frame)
        if k not in cal:
            raise Refuse(f"calibration.json lacks {k!r}")
    if cal.get("status") != "preregistered":
        raise Refuse("calibration.json is not marked status='preregistered'")
    if not (isinstance(cal["dead_rms_max"], (int, float)) and cal["dead_rms_max"] >= 0 and isinstance(cal["dead_window_s"], int) and cal["dead_window_s"] >= 1
            and isinstance(cal["speech_rms"], (int, float)) and cal["speech_rms"] > cal["dead_rms_max"]
            and isinstance(cal.get("dead_quantile", 1.0), (int, float)) and 0 < cal.get("dead_quantile", 1.0) <= 1
            and isinstance(cal["chunk_rate_max_bps"], (int, float)) and cal["chunk_rate_max_bps"] > 0):
        raise Refuse("calibration.json values are out of range (need 0 <= dead_rms_max < speech_rms, dead_window_s >= 1, 0 < dead_quantile <= 1, chunk_rate_max_bps > 0)")
    return cal, hashlib.sha256(raw).hexdigest()


def in_clinic_hours(now, cal):
    """clinic_hours_ist = ["HH:MM", "HH:MM"] in the calibration file; absent means every hour counts as clinic hours (the stricter reading)."""
    ch = cal.get("clinic_hours_ist")
    if not ch:
        return True
    t = time.gmtime(now + 5.5 * 3600)
    minutes = t.tm_hour * 60 + t.tm_min
    lo = int(ch[0][:2]) * 60 + int(ch[0][3:5])
    hi = int(ch[1][:2]) * 60 + int(ch[1][3:5])
    return lo <= minutes < hi


# ------------------------------------------------------------------ what may run on a room Mac
ALLOWED = ("afplay", "date", "tail", "stat", "pgrep", "rm")
WAV_RE = re.compile(r"^/tmp/mic-selftest-[0-9a-f]{8,32}\.wav$")
TAPE_RE = re.compile(r"^/[A-Za-z0-9_./ @:+=,-]+/tape\.pcm$")


def remote_check(argv):
    """Raises Refuse unless argv is one of the whitelisted room-Mac commands in exactly its whitelisted shape."""
    if not argv or argv[0] not in ALLOWED:
        raise Refuse(f"command not allowed on a room Mac: {argv[:1]}")
    p, a = argv[0], argv[1:]
    ok = (
        (p == "date" and a == ["+%s"])
        or (p == "pgrep" and a == ["-fl", "tapewriter record"])
        or (p == "stat" and len(a) == 3 and a[:2] == ["-f", "%z"] and TAPE_RE.match(a[2]) is not None)
        or (p == "tail" and len(a) == 3 and a[0] == "-c" and re.fullmatch(r"\+?[0-9]{1,12}", a[1]) is not None and TAPE_RE.match(a[2]) is not None)
        or (p == "afplay" and len(a) == 1 and WAV_RE.match(a[0]) is not None)
        or (p == "rm" and len(a) == 2 and a[0] == "-f" and WAV_RE.match(a[1]) is not None)
    )
    if not ok:
        raise Refuse(f"command shape not allowed on a room Mac: {argv}")
    return argv


def remote_line(argvs):
    """One ssh command string from several checked argv lists."""
    return " ; ".join(" ".join(shlex.quote(t) for t in remote_check(a)) for a in argvs)


def scp_check(argv, room):
    """scp of our own reference WAV to /tmp on the room Mac, nothing else."""
    dest = f"{room['user']}@{room['ip']}:"
    ok = (len(argv) == 4 and argv[0] == "scp" and argv[1] == "-q" and argv[3].startswith(dest)
          and WAV_RE.match(argv[3][len(dest):]) is not None and argv[2].endswith(".wav"))
    if not ok:
        raise Refuse(f"scp not allowed: {argv}")
    return argv


SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes"]


def real_runner(room, argvs, timeout=120):
    """(returncode, stdout bytes) of the checked remote command line over ssh."""
    cmd = SSH + [f"{room['user']}@{room['ip']}", remote_line(argvs)]
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return p.returncode, p.stdout


def real_scp(room, local, remote):
    argv = scp_check(["scp", "-q", local, f"{room['user']}@{room['ip']}:{remote}"], room)
    return subprocess.run(argv, capture_output=True, timeout=120).returncode


# ------------------------------------------------------------------ preconditions
def check_table(rooms=ROOMS):
    ips = [r["ip"] for r in rooms.values()]
    if len(set(ips)) != len(ips):
        raise Refuse("room table: two rooms share one tailnet IP")
    for name, r in rooms.items():
        if not r.get("ip") or not r.get("user"):
            raise Refuse(f"room table: {name} needs ip and user")
        if not re.fullmatch(r"room_[0-9a-z]{8}", r.get("room_id") or ""):
            raise Refuse(f"room table: {name} needs a vault room_id (room_xxxxxxxx): the self-test filter matches segments on it")
    ids = [r["room_id"] for r in rooms.values()]
    if len(set(ids)) != len(ids):
        raise Refuse("room table: two rooms share one room_id")


def check_room_state(state):
    """state comes from scribe_rooms (a JSON file the operator saves): recording, paused, recording_session_id. INFERRED schema: any missing field refuses."""
    for k in ("recording", "paused", "recording_session_id"):
        if k not in state:
            raise Refuse(f"room state lacks {k!r}")
    if state["recording"] is not True:
        raise Refuse("room is not recording")
    if state["paused"] is not False:
        raise Refuse("session is paused (or unknown)")
    if not isinstance(state["recording_session_id"], str) or not state["recording_session_id"]:
        raise Refuse("room state has no recording_session_id")


def check_rate_limit(log_path, room_name, now, limit=RATE_LIMIT_S):
    if not os.path.exists(log_path):
        return
    with open(log_path) as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("room") == room_name and r.get("mode") == "live" and r.get("played") and now - float(r.get("ts", 0)) < limit:
                raise Refuse(f"rate limit: {room_name} had a live run {int(now - float(r['ts']))} s ago (max 1 per {limit} s)")


def parse_tapewriter(text):
    """pgrep -fl output -> the --out dir of the ONE tapewriter record process. Zero or several processes refuse."""
    procs = [l for l in text.splitlines() if "tapewriter record" in l]
    if len(procs) != 1:
        raise Refuse(f"expected exactly one tapewriter record process, found {len(procs)}")
    m = re.search(r"--out (.+?)(?: --device |$)", procs[0])
    if not m:
        raise Refuse("tapewriter record has no --out")
    return m.group(1).strip()


def interlock(out_dir, session_id):
    """The tapewriter on THIS Mac must be writing to the session scribe_rooms reports for the room. INFERRED: the session id is a path component of the segment dir.
    No match refuses, which is also what happens if the layout does not embed the id (fail closed)."""
    if session_id not in [c for c in out_dir.split("/") if c]:
        raise Refuse("interlock: this Mac's tapewriter is not writing to the room's recording session (wrong Mac, or a session that does not match)")


# ------------------------------------------------------------------ the run
def log_result(path, rec):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def run(room_name, state, mode="plan", order=None, log_path=DEFAULT_LOG, rooms=ROOMS, runner=None, scp=None, now=None, sleep=time.sleep, workdir=None, ident=None,
        before_s=BEFORE_S, after_s=AFTER_S, lookback_s=LOOKBACK_S, cal_path=DEFAULT_CAL):
    """mode: plan | check | live. runner(room, argvs) -> (rc, stdout bytes); scp(room, local, remote) -> rc; both injectable. Returns the record that was logged."""
    now = time.time() if now is None else now
    rec = dict(ts=now, room=room_name, mode=mode, played=False, refused=None, order=order, detected=None)
    try:
        check_table(rooms)
        if room_name not in rooms:
            raise Refuse(f"unknown room {room_name!r}")
        room = rooms[room_name]
        if state.get("room_id") is not None and state["room_id"] != room["room_id"]:
            raise Refuse(f"room-state room_id {state['room_id']!r} does not match the table's {room['room_id']!r} for {room_name}")
        if mode in ("check", "live") and not (order and order.strip()):
            raise Refuse(f"--{mode if mode == 'live' else 'check-only'} needs --fable-order naming the Fable order")
        check_room_state(state)
        cal, cal_sha = None, None
        try:
            cal, cal_sha = load_calibration(cal_path)
        except Refuse as e:
            if mode != "plan":
                raise
            rec["calibration"] = "MISSING: " + str(e)
        rec["calibration_sha256"] = cal_sha
        rec["canary_sha256"] = CANARY_SHA256
        check_rate_limit(log_path, room_name, now)
        clinic = in_clinic_hours(now, cal) if cal else None
        if mode in ("check", "live") and clinic:
            # the chunk-rate gate needs no contact with the Mac at all: judge it first, from the operator's room-state file, so a stale file costs zero commands
            ok_chunks, rates, why = chunk_gate(state.get("recent_chunks"), cal["chunk_rate_max_bps"], state["recording_session_id"], now)
            rec["chunk_gate"] = dict(rates_bps=[round(r) for r in rates], limit_bps=cal["chunk_rate_max_bps"], n=CHUNK_GATE_N, ok=ok_chunks, reason=why)
            if not ok_chunks:
                raise Refuse(f"clinic hours and the recorded chunks do not read as dead: {why}")
        ident = ident or "%08x" % random.SystemRandom().getrandbits(32)
        wav_remote = f"/tmp/mic-selftest-{ident}.wav"
        wdir = workdir or os.path.dirname(os.path.abspath(log_path))          # the reference WAV goes to scratch, beside the log
        os.makedirs(wdir, exist_ok=True)
        wav_local = os.path.join(wdir, f"mic-selftest-{ident}.wav")
        write_wav(wav_local, make_reference())
        rec["wav_sha_len"] = os.path.getsize(wav_local)
        if mode == "plan":
            rec["plan"] = dict(host=f"{room['user']}@{room['ip']}", wav=wav_local, remote_wav=wav_remote,
                               reads=[["pgrep", "-fl", "tapewriter record"], ["stat", "-f", "%z", "<out>/tape.pcm"], ["tail", "-c", "<N>", "<out>/tape.pcm"]],
                               play=[["stat", "-f", "%z", "<out>/tape.pcm"], ["date", "+%s"], ["afplay", wav_remote], ["date", "+%s"], ["rm", "-f", wav_remote]])
            return rec
        runner = runner or real_runner
        rc, out = runner(room, [["pgrep", "-fl", "tapewriter record"]])
        out_dir = parse_tapewriter(out.decode("utf-8", "replace"))
        interlock(out_dir, state["recording_session_id"])
        rec["interlock"] = "ok"
        tape = out_dir.rstrip("/") + "/tape.pcm"
        rc, out = runner(room, [["stat", "-f", "%z", tape]])
        size0 = int(out.decode().strip())
        take = min(size0, lookback_s * SR * 2)
        if (size0 - take) % 2:
            take -= 1                                                # the pull must start on a sample boundary, whatever the tape size
        rc, pcm = runner(room, [["tail", "-c", str(take), tape]])
        ok, over, frames, mx = speech_check(pcm, speech_rms=cal["speech_rms"])
        rec["lookback"] = dict(frames=frames, frames_over=over, max_rms=round(mx, 5))
        if not ok:
            raise Refuse(f"speech-level signal in the last {lookback_s} s of tape ({over} of {frames} frames >= {cal['speech_rms']})")
        rec["clinic_hours"] = clinic
        if clinic:
            q = cal.get("dead_quantile", 1.0)
            dead, seen, level = dead_check(pcm, cal["dead_window_s"], cal["dead_rms_max"], quantile=q)
            rec["dead_check"] = dict(frames_seen=seen, level=round(level, 5), quantile=q, window_s=cal["dead_window_s"], limit=cal["dead_rms_max"])
            if not dead:
                raise Refuse(f"clinic hours and the room does not read as dead (the {q:.0%} level of 1 s RMS over the last {cal['dead_window_s']} s is {level:.4f}; limit {cal['dead_rms_max']})")
        if mode == "check":
            rec["detected"] = None
            return rec
        # ---- live: this is the only place that makes a sound
        scp = scp or real_scp
        if scp(room, wav_local, wav_remote) != 0:
            raise Refuse("scp of the reference failed")
        try:
            rc, out = runner(room, [["stat", "-f", "%z", tape], ["date", "+%s"], ["afplay", wav_remote], ["date", "+%s"], ["stat", "-f", "%z", tape]])
            rec["played"] = True
            lines = out.decode().split()
            b0, t_start, t_end = int(lines[0]), int(lines[1]), int(lines[2])
            rec["mac_start"], rec["mac_end"] = t_start, t_end
            # the exact tape interval of this run (ruling 369 item 4): what selftest_filter.py drops from every patient record
            rec["session"] = state["recording_session_id"]
            rec["tape_from_byte"] = b0
            rec["tape_to_byte"] = int(lines[3]) if len(lines) > 3 else None
            rec["selftest_epoch"] = [t_start - 2, t_end + 2]
            rec["run_id"] = ident
            rec["room_id"] = room["room_id"]                          # from the table, never from the room-state file: the filter matches segments on it
            rec["canary_id"] = "canary-" + CANARY_SHA256[:8]
            ist = 5.5 * 3600
            rec["tape_start_iso"] = time.strftime("%Y-%m-%dT%H:%M:%S+05:30", time.gmtime(t_start - 2 + ist))
            rec["tape_end_iso"] = time.strftime("%Y-%m-%dT%H:%M:%S+05:30", time.gmtime(t_end + 2 + ist))
            rec["date_ist"] = rec["tape_start_iso"][:10]
            sleep(after_s)
            rc, size1_out = runner(room, [["stat", "-f", "%z", tape]])
            size1 = int(size1_out.decode().strip())
            start = max(0, b0 - before_s * SR * 2)
            start -= start % 2                                       # int16 samples: never start the pull on an odd byte
            rc, pcm2 = runner(room, [["tail", "-c", "+%d" % (start + 1), tape]])
            res = analyse(pcm2, (b0 - start) // 2)
            rec.update(res)
        finally:
            try:
                runner(room, [["rm", "-f", wav_remote]])       # our own /tmp file, always
            except Exception as e:                              # noqa: BLE001 the run's result matters more than the cleanup message
                rec["cleanup_error"] = str(e)[:80]
        return rec
    except Refuse as e:
        rec["refused"] = str(e)
        return rec
    finally:
        try:
            log_result(log_path, rec)
        except OSError as e:
            print(f"warning: could not write the log: {e}", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("room", help="one of: " + ", ".join(sorted(ROOMS)))
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", help="the default: plan only, no network")
    g.add_argument("--check-only", action="store_true")
    g.add_argument("--live", action="store_true")
    ap.add_argument("--fable-order", help="text naming the Fable order that permits contacting the room (required for --check-only and --live)")
    ap.add_argument("--room-state", required=True, help="JSON from scribe_rooms for this room: recording, paused, recording_session_id")
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--calibration", default=DEFAULT_CAL)
    a = ap.parse_args(argv)
    mode = "live" if a.live else "check" if a.check_only else "plan"
    with open(a.room_state) as f:
        state = json.load(f)
    rec = run(a.room, state, mode=mode, order=a.fable_order, log_path=a.log, cal_path=a.calibration)
    print(json.dumps(rec, ensure_ascii=False))
    return 1 if rec.get("refused") else 0


if __name__ == "__main__":
    sys.exit(main())
