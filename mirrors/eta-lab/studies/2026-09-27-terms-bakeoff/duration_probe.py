"""Ground-truth audio duration - not whatever a manifest/caller claims (same rationale as reb's
kit/reb_runner/engines/audio_utils.py:probe_duration_s: a shorter-than-claimed file otherwise produces empty
trailing chunks).

v2 (smoke test, 27 Sep): the first HF Job run crashed with FileNotFoundError('ffprobe') - the job's minimal
`ghcr.io/astral-sh/uv:python3.12-bookworm` image has no system ffmpeg/ffprobe binary at all, unlike this box.
Switched to `soundfile.info()` (pure Python, already a declared dependency everywhere this module is used, reads
the WAV/FLAC/OGG header directly with no subprocess or system binary) as the primary path - covers every W50 input
format (all clinical1/set-(c) audio is 16kHz mono WAV). Falls back to ffprobe only if soundfile can't open the file
(e.g. a container format soundfile doesn't support), so this still works on a box that DOES have ffmpeg for a
format soundfile doesn't."""
import subprocess


def probe_duration_s(audio_path):
    try:
        import soundfile as sf
        return sf.info(audio_path).duration
    except Exception:
        pass
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio_path],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    return float(out)
