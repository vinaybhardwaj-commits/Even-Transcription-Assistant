#!/usr/bin/env python3
"""Score a recorded room SELF-TEST segment against the pack it played (W34.4). Runs on the box or c3, never on the Mini. Stdlib only (FFT reused from
kit/mic-selftest, PASSed). Reports numbers only (no transcript text).
  python3 score_selftest_room.py --pack DIR --recording rec.wav [--room NAME] [--json out.json]
Method (all offsets come from the pack manifest; the recording must contain the composite played once, in order):
  anchor      the app's play log (id -> file start time in the recording) if given (--play-log), else 1 kHz Goertzel over 50 ms frames -> first run of >= 1.2 s where
              the tone dominates = tone signal start; the following files follow at their durations + the app's inter-file gap (--gap-s, default 1.0)
  level_db    path gain speaker -> air -> mic from the SWEEP: recorded 300-4000 Hz band power over the sweep vs the reference sweep (noise-corrected); tone_level_db is the pure
              tone vs its reference, DIAGNOSTIC only (modal, +-10 dB between rooms)
  noise/SNR   median (and p10/p90) of 50 ms frame RMS over every silent window (FULL-BAND of the recording: a 16 kHz tape holds 1/3 of a white floor's power vs 48 kHz); snr_db = sweep band power vs the MEDIAN silence band power (300-4000 Hz)
  canary      matched filter (mic_selftest.ncc_profile, 16 kHz) of the pack's reference canary in a +-0.5 s window around each of the 3 plays; hit = NCC >= 0.15
              (mic_selftest.NCC_THRESHOLD); optional --stt-text adds mic_selftest.fuzzy_canary on an STT transcript
  rt60        Farina deconvolution of the log sweep (inverse filter, 16 kHz) -> impulse response -> Schroeder backward integration; T20 (-5..-25 dB) x 3, else T10 x 6;
              reliable only if the peak-to-noise range >= 35 dB, the EDC reaches -25 dB inside the noise-free part, the T20 line fit has r2 >= 0.95 and RT60 <= 3 s; also EDT-free C50 = 10 log10(E[0,50 ms] / E[50 ms, end])
  hygiene     clipping % (|x| >= 0.999), exact-zero share (mute signature)
LIMITS: RT60/C50 are broadband; the anchor assumes the composite was played as one file; a drifting sample clock over 74 s is not corrected."""
import argparse
import array
import cmath
import json
import math
import os
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "mic-selftest"))
import wavio  # noqa: E402
from mic_selftest import NCC_THRESHOLD, _fft, band_power, fuzzy_canary, ncc_profile  # noqa: E402

FS = 16000


def read_raw(path, sr=16000):
    """HEADERLESS little-endian int16 mono PCM (the Room Recorder's tape.pcm is 16 kHz) -> (floats, sr)."""
    a = array.array("h")
    with open(path, "rb") as f:
        raw = f.read()
    a.frombytes(raw[:len(raw) // 2 * 2])
    if struct.pack("=h", 1) != struct.pack("<h", 1):
        a.byteswap()
    return [v / 32768.0 for v in a], sr


def first_wall_ns(idx_path):
    """wall_ns of sample 0 from the recorder's tape.idx (scribe #4263: the record at byte_offset/samples 0 is the exact wall time of sample 0). JSON lines, or one JSON list/object;
    keys tried: wall_ns with byte_offset == 0 or samples/input_samples/frames == 0, else the record with the smallest byte_offset."""
    with open(idx_path) as f:
        txt = f.read()
    try:
        recs = json.loads(txt)
        recs = recs if isinstance(recs, list) else recs.get("records", [recs])
    except ValueError:
        recs = [json.loads(l) for l in txt.splitlines() if l.strip()]
    recs = [r for r in recs if isinstance(r, dict) and "wall_ns" in r]
    zero = [r for r in recs if r.get("byte_offset") == 0]
    if not zero:                                                       # refuter-2 #4272: an implicit fallback (missing key = 0) could silently pick the wrong record
        raise SystemExit("tape.idx: no record with explicit byte_offset == 0 (sample 0's wall time); refusing rather than guessing")
    if len(zero) > 1 and len({r["wall_ns"] for r in zero}) > 1:
        raise SystemExit("tape.idx: more than one byte_offset == 0 record with different wall_ns")
    return int(zero[0]["wall_ns"])


def read_any(path, raw_rate=None):
    """-> (mono float list, sr). 16-bit PCM WAV, mono or stereo (channels averaged); raw_rate (or a .pcm name) reads headerless int16 mono at that rate."""
    if raw_rate or path.endswith(".pcm"):
        return read_raw(path, raw_rate or 16000)
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit("need 16-bit PCM WAV")
    a = array.array("h")
    a.frombytes(raw)
    if struct.pack("=h", 1) != struct.pack("<h", 1):
        a.byteswap()
    if ch == 1:
        return [v / 32768.0 for v in a], sr
    return [sum(a[i:i + ch]) / (ch * 32768.0) for i in range(0, len(a) - ch + 1, ch)], sr


def _fir_lowpass(fc_norm, taps=31):
    m = taps // 2
    h = []
    for i in range(taps):
        k = i - m
        s = 2 * fc_norm if k == 0 else math.sin(2 * math.pi * fc_norm * k) / (math.pi * k)
        h.append(s * (0.54 - 0.46 * math.cos(2 * math.pi * i / (taps - 1))))
    g = sum(h)
    return [v / g for v in h]


def to16k(x, sr):
    """band-limit (windowed-sinc, 7.2 kHz) and resample to 16 kHz (linear interpolation of the filtered signal for non-integer ratios)."""
    if sr == FS:
        return list(x)
    h = _fir_lowpass(7200.0 / sr)
    m = len(h) // 2
    n = len(x)
    ratio = sr / FS
    out = []
    for j in range(int((n - 1) / ratio) + 1):
        p = j * ratio
        c = int(round(p))
        acc = 0.0
        for k, hv in enumerate(h):
            idx = c + k - m
            if 0 <= idx < n:
                acc += hv * x[idx]
        out.append(acc)
    return out


def _goertzel_power(seg, sr, f):
    w = 2 * math.pi * f / sr
    c = 2 * math.cos(w)
    s1 = s2 = 0.0
    for v in seg:
        s0 = v + c * s1 - s2
        s2, s1 = s1, s0
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / max(len(seg), 1) ** 2 * 4


def find_tone_start(x, sr, f=1000.0, frame_s=0.05, min_run_s=1.2, ratio_min=0.5):
    n = int(sr * frame_s)
    flags = []
    for i in range(0, len(x) - n + 1, n):
        seg = x[i:i + n]
        tot = sum(v * v for v in seg) / n
        flags.append(tot > 1e-8 and _goertzel_power(seg, sr, f) / tot >= ratio_min)
    need = int(min_run_s / frame_s)
    run = 0
    for i, fl in enumerate(flags):
        run = run + 1 if fl else 0
        if run >= need:
            return (i - run + 1) * frame_s
    return None


def rms_db(seg):
    return 20 * math.log10(max(wavio.rms(seg), 1e-9))


def frame_rms_p10(seg, sr, frame_s=0.1):
    n = int(sr * frame_s)
    v = sorted(wavio.rms(seg[i:i + n]) for i in range(0, len(seg) - n + 1, n))
    return v[max(0, int(0.1 * (len(v) - 1)))] if v else 0.0


def log_sweep16(f0, f1, dur, level_dbfs=-12.0):
    L = dur / math.log(f1 / f0)
    n = int(round(dur * FS))
    x = [math.sin(2 * math.pi * f0 * L * (math.exp(i / FS / L) - 1)) for i in range(n)]
    g = wavio.db(level_dbfs) / wavio.rms(x)
    return [v * g for v in x], L


def impulse_response(rec16, f0, f1, dur, lead=0):
    """Farina: IR = rec (*) inverse sweep (time-reversed sweep, -6 dB/oct amplitude); rec covers the sweep + its decay. -> (ir, index of the direct-sound peak)."""
    sw, L = log_sweep16(f0, f1, dur)
    n = len(sw)
    inv = [sw[n - 1 - i] * math.exp(-(i / FS) / L) for i in range(n)]
    size = 1
    while size < len(rec16) + n:
        size <<= 1
    fr = _fft([complex(v) for v in rec16] + [0j] * (size - len(rec16)))
    fi = _fft([complex(v) for v in inv] + [0j] * (size - n))
    ir = [v.real for v in _fft([a * b for a, b in zip(fr, fi)], invert=True)]
    lo = n - 1 + lead - int(0.05 * FS)                              # the direct sound sits at ~ len(sweep) - 1 + the lead-in + the path delay
    hi = min(len(ir), n - 1 + lead + int(0.5 * FS))
    peak = max(range(max(lo, 0), hi), key=lambda i: abs(ir[i]))
    return ir, peak


def decay_metrics(ir, peak, valid_s=3.0):
    """Decay from the Farina IR. Noise-aware (refuter-2 #4242 B1): the noise level is the MEDIAN smoothed IR energy of the last 25% of the valid window (robust to
    bursts); the IR is cut where its 15 ms smoothed energy first comes within 5 dB of that noise; edc_range_db = peak-to-noise dynamic range of the smoothed energy;
    T20 is a least-squares line through the EDC between -5 and -25 dB, and the result is `reliable` only if the range is >= 35 dB, the EDC reaches -25 dB inside the
    cut, the fit r2 >= 0.95 and RT60 <= 3 s. Otherwise rt60_s is still reported (T10 x 6 if -15 dB is reached) but reliable=False with the reason.
    -> dict(rt60_s, method, edc_range_db, r2, c50_db, reliable[, reason])."""
    h = ir[peak:peak + int(valid_s * FS)]
    e = [v * v for v in h]
    blk = int(0.005 * FS)
    if len(e) < 8 * blk or max(e) <= 0:
        return dict(rt60_s=None, method=None, edc_range_db=0.0, r2=None, c50_db=None, reliable=False, reason="no impulse response")
    nb = len(e) // blk
    bl = [sum(e[i * blk:(i + 1) * blk]) / blk for i in range(nb)]
    sm = [sum(bl[max(0, i - 1):i + 2]) / len(bl[max(0, i - 1):i + 2]) for i in range(nb)]           # 15 ms moving average
    db = [10 * math.log10(max(v, 1e-30)) for v in sm]
    tail = sorted(db[int(nb * 0.75):])
    noise_db = tail[len(tail) // 2]
    peak_db = max(db[:max(4, int(0.05 * FS / blk))])
    dyn = peak_db - noise_db
    cut = nb
    for i in range(int(0.05 * FS / blk), nb):
        if db[i] <= noise_db + 5.0:
            cut = i
            break
    seg = e[:cut * blk]
    tot = sum(seg)
    if tot <= 0 or cut < 4:
        return dict(rt60_s=None, method=None, edc_range_db=round(dyn, 1), r2=None, c50_db=None, reliable=False, reason="decay drowned in noise")
    edc, acc = [], tot
    for v in seg:
        edc.append(10 * math.log10(max(acc / tot, 1e-12)))
        acc -= v
    k50 = int(0.05 * FS)
    c50 = round(10 * math.log10(sum(seg[:k50]) / max(sum(seg[k50:]), 1e-30)), 2) if len(seg) > k50 and sum(seg[k50:]) > 0 else None

    def fit(lo_db, hi_db):
        pts = [(i / FS, v) for i, v in enumerate(edc) if hi_db <= v <= lo_db]
        if len(pts) < 20:
            return None
        n = len(pts)
        mt, mv = sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n
        sxx = sum((p[0] - mt) ** 2 for p in pts)
        sxy = sum((p[0] - mt) * (p[1] - mv) for p in pts)
        syy = sum((p[1] - mv) ** 2 for p in pts)
        if sxx <= 0 or syy <= 0 or sxy >= 0:
            return None
        slope = sxy / sxx
        return -60.0 / slope, (sxy * sxy) / (sxx * syy)
    f20, f10 = fit(-5, -25), fit(-5, -15)
    if f20:
        rt, r2 = f20
        why = []
        if dyn < 35: why.append("dynamic range %.0f dB < 35" % dyn)
        if r2 < 0.95: why.append("EDC not linear (r2 %.2f)" % r2)
        if rt > 3.0: why.append("RT60 > 3 s")
        out = dict(rt60_s=round(rt, 3), method="T20", edc_range_db=round(dyn, 1), r2=round(r2, 3), c50_db=c50, reliable=not why)
        if why:
            out["reason"] = "; ".join(why)
        return out
    if f10:
        rt, r2 = f10
        return dict(rt60_s=round(rt, 3), method="T10", edc_range_db=round(dyn, 1), r2=round(r2, 3), c50_db=c50, reliable=False, reason="EDC does not reach -25 dB inside the noise-free part")
    return dict(rt60_s=None, method=None, edc_range_db=round(dyn, 1), r2=None, c50_db=c50, reliable=False, reason="EDC does not reach -15 dB inside the noise-free part")


def play_log_from_manifest(app_manifest, rec_start_wall_ns):
    """The Room Recorder's per-run manifest.json (scribe #4251) lists each played file with start_wall_ns/end_wall_ns on the tape.idx wall clock. -> {stimulus id: start s on the
    recording clock}, given the wall_ns of the recording's first sample. Accepts a list under 'files' / 'stimuli' / 'played', entries keyed by 'id' (or 'file' = '<id>.wav')."""
    rows = None
    for k in ("files", "stimuli", "played"):
        if isinstance(app_manifest.get(k), list):
            rows = app_manifest[k]
            break
    if rows is None:
        raise SystemExit("app manifest has no files/stimuli/played list")
    out = {}
    for r in rows:
        sid = r.get("id") or os.path.splitext(os.path.basename(r.get("file", "")))[0]
        if sid and "start_wall_ns" in r:
            out[sid] = (int(r["start_wall_ns"]) - int(rec_start_wall_ns)) / 1e9
    return out


def timeline(man, t_tone_signal, gap_s, play_log=None):
    """-> {id: file start time (s) in the recording}. With a play log (the app's own clock) use it; else start from the detected tone (signal start - head padding)
    and add each file's duration plus the app's inter-file gap."""
    if play_log:
        return {k: float(v) for k, v in play_log.items()}
    t = t_tone_signal - man["stimuli"]["tone-1k"]["head_pad_s"]
    out = {}
    for sid in man["order"]:
        out[sid] = t
        t += man["stimuli"][sid]["duration_s"] + gap_s
    return out


def score(pack_dir, rec_path, stt_text=None, gap_s=1.0, play_log=None, raw_rate=None, app_manifest=None):
    man = wavio.jload(os.path.join(pack_dir, "selftest_pack.json"))
    x, sr = read_any(rec_path, raw_rate)
    st = man["stimuli"]
    out = dict(pack_id=man["pack_id"], pack_sha256=man["pack_sha256"], recording_sr=sr, recording_s=round(len(x) / sr, 2), gap_s=gap_s, play_log=bool(play_log))
    if app_manifest:                                                                  # the app's own run manifest: which pack, what volume, did it finish
        out["app"] = {k: app_manifest.get(k) for k in ("run_id", "room_slug", "outcome", "speaker_volume", "previous_speaker_volume", "mic_device_uid", "speaker_device_uid", "app_version")}
        ps = app_manifest.get("pack_sha256")
        out["app"]["pack_matches"] = None if ps is None else str(ps).startswith(man["pack_json_sha256"][:8]) or str(ps) == man["pack_json_sha256"]
    out["clipping_pct"] = round(100.0 * sum(1 for v in x if abs(v) >= 0.999) / max(len(x), 1), 4)
    out["exact_zero_share"] = round(sum(1 for v in x if v == 0.0) / max(len(x), 1), 4)
    t_tone = find_tone_start(x, sr, man["tone"]["freq_hz"])
    if t_tone is None and not play_log:
        out.update(aligned=False, reason="no 1 kHz tone found (speaker silent, mic muted or wrong device)", canary_hits=0, canary_total=3)
        out["noise_dbfs"] = round(20 * math.log10(max(frame_rms_p10(x, sr), 1e-9)), 1) if x else None
        return out
    start = timeline(man, t_tone, gap_s, play_log)
    out.update(aligned=True, tone_start_s=round(t_tone, 3) if t_tone is not None else None)
    if play_log and t_tone is not None:
        # the acoustic tone is the FINE alignment (refuter-2 #4272: a play log 0.5 s late silently ruined SNR/RT60): shift every logged time by the tone's offset from the log
        shift = (t_tone - man["stimuli"]["tone-1k"]["head_pad_s"]) - start["tone-1k"]
        out["align_shift_s"] = round(shift, 3)
        if abs(shift) <= 1.0:
            start = {k: v + shift for k, v in start.items()}
            if abs(shift) > 0.25:
                out["alignment_warning"] = "the play log was %.2f s off the acoustic tone; all times were shifted by it (check clocks / output latency)" % shift
        else:
            out["alignment_warning"] = "the tone was found %.2f s from the play log (> 1 s): log times NOT shifted, treat the scores as suspect" % shift

    def sig(sid, a=0.0, b=0.0):
        r = st[sid]
        return start[sid] + r["signal_start_s"] + a, start[sid] + r["signal_start_s"] + r["signal_dur_s"] + b

    def cut(a, b):
        i0, i1 = max(int(a * sr), 0), min(int(b * sr), len(x))
        return x[i0:i1] if i1 > i0 else []
    tone_seg = cut(*sig("tone-1k", 0.3, -0.3))
    tone_db = rms_db(tone_seg)
    out["tone_rms_dbfs"] = round(tone_db, 2)
    out["tone_level_db"] = round(tone_db - st["tone-1k"]["rms_dbfs"], 2)              # DIAGNOSTIC only: a pure tone sits on room modes (+-10 dB), not a path gain
    frames = []
    if start["tone-1k"] > 0.4:
        frames.append((0.0, start["tone-1k"] - 0.1))                                # recording lead-in before the tone file
    prev_end = None
    for sid in [k for k in man["order"] if k in start]:                              # a play log (or a short recording) may cover only some stimuli
        r = st[sid]
        a_, b_ = start[sid], start[sid] + r["duration_s"]
        frames.append((a_ + 0.02, a_ + r["head_pad_s"] - 0.02))                     # head/tail padding of every file is silence
        if r["tail_pad_s"] <= 0.5:
            frames.append((b_ - r["tail_pad_s"] + 0.02, b_ - 0.02))
        else:
            frames.append((b_ - r["tail_pad_s"] + 1.5, b_ - 0.02))                  # the long sweep tail: skip the first 1.5 s (room decay)
        if prev_end is not None and a_ - prev_end > 0.15:
            frames.append((prev_end + 0.05, a_ - 0.05))                             # the app's inter-file gap
        prev_end = b_
    vals, band_p = [], []
    for a_, b_ in frames:
        seg = cut(a_, b_)
        if len(seg) >= int(0.04 * sr):
            n = int(0.05 * sr)
            vals.extend(wavio.rms(seg[i:i + n]) for i in range(0, len(seg) - n + 1, n))
            if len(seg) >= int(0.3 * sr):
                band_p.append(band_power(seg, 300.0, 4000.0, sr))
    vals.sort()
    dbf = lambda v: round(20 * math.log10(max(v, 1e-9)), 2)
    q = lambda p: vals[int(p * (len(vals) - 1))] if vals else 0.0
    out["noise_dbfs"] = dbf(q(0.5))                                                  # MEDIAN of the silent frames (an intermittent-noise room is not hidden by a low percentile)
    out["noise_dbfs_p10"], out["noise_dbfs_p90"] = dbf(q(0.1)), dbf(q(0.9))
    # path gain + SNR from the SWEEP (broadband 300-4000 Hz energy), not from the pure tone (refuter-2 #4242 B2)
    ref_sw, _ = read_any(os.path.join(pack_dir, st["sweep"]["file"]))
    r0 = int(st["sweep"]["signal_start_s"] * 48000)
    ref_seg = ref_sw[r0:r0 + int(st["sweep"]["signal_dur_s"] * 48000)]
    rec_seg = cut(*sig("sweep"))
    if len(rec_seg) > int(4.0 * sr):
        p_ref = band_power(ref_seg, 300.0, 4000.0, 48000)
        p_rec = band_power(rec_seg, 300.0, 4000.0, sr)
        p_noise = sorted(band_p)[len(band_p) // 2] if band_p else 0.0
        p_sig = max(p_rec - p_noise, p_rec * 1e-3)
        out["level_db"] = round(10 * math.log10(max(p_sig, 1e-30) / max(p_ref, 1e-30)), 2)          # speaker -> air -> mic path gain, 300-4000 Hz
        out["snr_db"] = round(10 * math.log10(max(p_sig, 1e-30) / max(p_noise, 1e-30)), 2) if p_noise > 0 else None    # sweep band power vs MEDIAN silence band power
        if band_p:
            out["snr_db_p90_noise"] = round(10 * math.log10(max(p_sig, 1e-30) / max(sorted(band_p)[int(0.9 * (len(band_p) - 1))], 1e-30)), 2)
    else:
        out["level_db"], out["snr_db"] = None, None
        out["level_reason"] = "recording too short around the sweep"
    sp = []
    for sid in [k for k in man["order"] if k in start]:
        if sid.startswith(("ph", "canary")):
            seg = cut(*sig(sid))
            if seg:
                sp.append(20 * math.log10(max(wavio.rms_active(seg, sr, floor_db=-70), 1e-9)) - st[sid]["active_rms_dbfs"])
    if sp:
        out["speech_level_db"] = round(sum(sp) / len(sp), 2)                        # mean over speech clips: recorded active RMS vs reference active RMS
    ref, rsr = read_any(os.path.join(pack_dir, "ref", "canary_16k.wav"))
    peaks = []
    for i in (1, 2, 3):
        seg = to16k(cut(*sig("canary-%d" % i, -1.0, 1.0)), sr)
        prof = ncc_profile(seg, ref) if len(seg) >= len(ref) else []
        peaks.append(round(max(prof), 3) if prof else 0.0)
    out["canary_ncc_peaks"] = peaks
    out["canary_hits"] = sum(1 for p in peaks if p >= NCC_THRESHOLD)
    out["canary_total"] = 3
    if stt_text is not None:
        hit, ratio = fuzzy_canary(stt_text)
        out["stt_canary"] = dict(hit=bool(hit), ratio=ratio)
    a, b = sig("sweep", -0.3, 3.0)
    win = to16k(cut(a, b), sr)
    lead = int(0.3 * FS)
    if len(win) > lead + int(man["sweep"]["duration_s"] * FS):
        ir, peak = impulse_response(win, man["sweep"]["f0_hz"], man["sweep"]["f1_hz"], man["sweep"]["duration_s"], lead)
        out["decay"] = decay_metrics(ir, peak)
    else:
        out["decay"] = dict(rt60_s=None, reliable=False, reason="recording too short around the sweep")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", required=True)
    ap.add_argument("--recording", required=True)
    ap.add_argument("--room", default=None)
    ap.add_argument("--gap-s", type=float, default=1.0, help="the app's silence between files (nominal timeline when no play log)")
    ap.add_argument("--play-log", default=None, help="JSON {stimulus id: file start time in the recording, seconds}")
    ap.add_argument("--play-manifest", default=None, help="the Room Recorder run manifest.json (start_wall_ns per file); needs --rec-start-wall-ns")
    ap.add_argument("--rec-start-wall-ns", type=int, default=None, help="wall_ns of the recording's first sample (tape.idx clock)")
    ap.add_argument("--tape-idx", default=None, help="the recorder's tape.idx: wall_ns of sample 0 is read from it (instead of --rec-start-wall-ns)")
    ap.add_argument("--raw-rate", type=int, default=None, help="recording is HEADERLESS int16 mono PCM at this rate (tape.pcm = 16000); a .pcm file name implies 16000")
    ap.add_argument("--stt-text", default=None, help="file with an STT transcript of the recording (optional canary text check)")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    txt = None
    if a.stt_text:
        with open(a.stt_text) as f:
            txt = f.read()
    pl = None
    if a.play_log:
        with open(a.play_log) as f:
            pl = json.load(f)
    appman = None
    if a.play_manifest:
        start_ns = a.rec_start_wall_ns if a.rec_start_wall_ns is not None else (first_wall_ns(a.tape_idx) if a.tape_idx else None)
        if start_ns is None:
            raise SystemExit("--play-manifest needs --rec-start-wall-ns or --tape-idx")
        with open(a.play_manifest) as f:
            appman = json.load(f)
        pl = play_log_from_manifest(appman, start_ns)
    r = score(a.pack, a.recording, txt, a.gap_s, pl, a.raw_rate, appman)
    if a.room:
        r["room"] = a.room
    print(json.dumps(r, indent=1))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(r, f, indent=1)
        os.chmod(a.json, 0o600)
