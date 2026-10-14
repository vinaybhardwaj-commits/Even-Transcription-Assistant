"""m3-08: per-clip tags for the macOS 26 Voice Isolation episode. OPD 4 and OPD 5 (macOS 26) recorded with Voice Isolation on from about 1 Oct 2026 until the night of 7 Oct (OPD 4 fixed 21:05, OPD 5 later): room noise between speech is exact digital zero and quiet speech may be missing.
consult_zero_ratio = fraction of exactly-zero samples in consult.flac (a loudnorm gain and the 16 kHz resample keep zeros at zero). voice_isolated = room is OPD 4/5 AND (clip start inside the episode OR vi_frame_share >= 0.10). vi_frame_share = share of 20 ms frames that are gated frames (audio-13 definition), measured on the cut audio BEFORE loudnorm (the gain would break the peak test)."""
import datetime as dt, re, subprocess
import numpy as np
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
EPISODE_FROM = dt.datetime(2026, 10, 1, 0, 0, tzinfo=IST).timestamp()
EPISODE_TO = dt.datetime(2026, 10, 7, 21, 30, tzinfo=IST).timestamp()
VI_SHARE_MIN = 0.10                                   # m3-08b (consult-lead 03:50): voice_isolated also when >= 10 % of the clip's 20 ms frames are gated frames; measured 08 Oct: OPD 4/5 clips min 0.137, 28 other-room clips all 0.000
SOURCE = "macos26_voice_isolation"
# per-frame definition = consult-audio audio-13 (ras/zeros.py): decoded 48 kHz mono s16, 20 ms frames (960 samples), zero_ratio = share of |s| <= 1, gated = zero_ratio >= 0.95 AND peak < 0.002 of full scale (<= 65)
SR, FRAME, VI_ZERO_RATIO, VI_GATED_PEAK, VI_SPEECH_PEAK = 48000, 960, 0.95, 65, 328

def parse_ist(s):
    """ISO string -> epoch; a naive string is read as IST (the index stores both forms), whatever the box TZ is."""
    d = dt.datetime.fromisoformat(s)
    return (d if d.tzinfo else d.replace(tzinfo=IST)).timestamp()

def is_macos26_room(room_slug): return re.match(r"opd-[45](-|$)", room_slug or "") is not None

def zero_ratio(path):
    """fraction of exactly-zero 16-bit samples of a decoded file, or None when it cannot be decoded."""
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], capture_output=True)
    if p.returncode != 0: return None
    x = np.frombuffer(p.stdout, dtype="<i2")
    return None if len(x) == 0 else round(float((x == 0).sum()) / len(x), 4)

def vi_frame_share(path, end_rel=None, coverage=1.0):
    """-> (share of gated 20 ms frames, share of speech frames (peak >= 0.01), n frames), or (None, None, 0) when it cannot be decoded. Same definition as audio-13 (ras/zeros.py vi_bins); a trailing partial frame is dropped. The planner zero-fills tape gaps, which would look like gated frames: (1 - coverage) of the frames are taken out of both the gated count and the total."""
    cmd = ["ffmpeg", "-v", "error"] + (["-t", f"{end_rel:.3f}"] if end_rel else []) + ["-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0: return None, None, 0
    a = np.frombuffer(p.stdout, dtype="<i2"); n = len(a) // FRAME
    if n == 0: return None, None, 0
    f = np.abs(a[:n * FRAME].astype(np.int32)).reshape(n, FRAME); zr = (f <= 1).mean(axis=1); pk = f.max(axis=1)
    g = int(((zr >= VI_ZERO_RATIO) & (pk <= VI_GATED_PEAK)).sum()); unc = min(g, int(round((1.0 - min(1.0, max(0.0, coverage))) * n))); m = n - unc
    return (round((g - unc) / m, 4) if m > 0 else None), round(float((pk >= VI_SPEECH_PEAK).sum()) / max(1, m), 4), int(m)

def tag(room_slug, start_epoch, zr, vi=None):
    """-> dict(consult_zero_ratio, vi_frame_share, voice_isolated, gating_source)."""
    v = is_macos26_room(room_slug) and ((EPISODE_FROM <= start_epoch <= EPISODE_TO) or (vi is not None and vi >= VI_SHARE_MIN))
    return dict(consult_zero_ratio=zr, vi_frame_share=vi, voice_isolated=bool(v), gating_source=SOURCE if v else None)

def tag_timeline(timeline, consult_flac, work_audio=None, end_rel=None):
    """compute the tags for a finished clip and put them into its timeline dict (written with timeline.json); -> the tag dict. work_audio = the cut audio before normalisation."""
    vi = vi_frame_share(work_audio, end_rel, timeline.get('tape_coverage') or 1.0)[0] if work_audio else None
    t = tag(timeline["window"]["room_slug"], dt.datetime.fromisoformat(timeline["span"]["start_utc"]).timestamp(), zero_ratio(consult_flac), vi)
    timeline.update(t); return t
