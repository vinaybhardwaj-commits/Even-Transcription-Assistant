"""Shared audio-chunking helpers for engine writers that need to split long clips into <=N-second
pieces (whisper.py needed this for LID coverage; box_twin.py needs it for engines whose own server
doesn't chunk internally — see box_twin.py's docstring on why SraVaani specifically needs this and
IndicConformer doesn't). Extracted here (originally private to whisper.py) so it's not duplicated —
eta-refuter-2/3's #4914/#4916 review of box_twin.py's long-audio gap is what prompted the extraction.
"""
import subprocess
import tempfile

DEFAULT_MIN_TAIL_S = 1.0  # eta-refuter-3 #4806: a sub-1s tail chunk risks a sub-100ms clip reaching a
                           # server (untested whether any of them reject that); merge it into the
                           # previous chunk instead of sending it alone.


def slice_wav(wav_path, start_s, dur_s):
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    out.close()
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start_s), "-t", str(dur_s),
         "-i", wav_path, "-ac", "1", "-ar", "16000", out.name],
        check=True, capture_output=True, timeout=60,
    )
    return out.name


def probe_duration_s(wav_path):
    """Ground truth duration from the actual audio file, not whatever a manifest/caller claims
    (eta-refuter-3 #4806: a shorter-than-claimed file otherwise produces empty trailing chunks)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav_path],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    return float(out)


def plan_chunks(duration_s, chunk_s=30.0, min_tail_s=DEFAULT_MIN_TAIL_S):
    """[(start_s, dur_s), ...] covering [0, duration_s) in <=chunk_s pieces, with a final tail shorter
    than min_tail_s folded into the previous chunk instead of sent alone."""
    chunks = []
    t = 0.0
    while t < duration_s:
        dur = min(chunk_s, duration_s - t)
        chunks.append([t, dur])
        t += dur
    if len(chunks) >= 2 and chunks[-1][1] < min_tail_s:
        chunks[-2][1] += chunks[-1][1]
        chunks.pop()
    return [(t0, dur) for t0, dur in chunks]
