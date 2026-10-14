"""HF-run engine for REB's emotion layer (REB-SPEC-v1.md section 3: "wavlm crosslingual per speaker
run"). Same model as the box :8086 Mini service (studies/2026-09-27-tone-emotion-validate/
emotion_suite.py): Aniemore/wavlm-emotion-v1-crosslingual, 7 labels — model id and label set are
kept identical to the Mini service so scores from this layer are directly comparable to what W45.2
already validated (arm 1's finding stands: negative-emotion labels are NOT to be reported as valid
from this model — see HANDOVER.md and RULINGS-2026-09-27.md #4506).

Runs on HF L4 GPU via hf-fleet (RULINGS 13:22: "diar/nemotron/emotion move to HF once up"; box T4 is
STT-only). Scoring itself lives in hf_emotion_job.py (standalone script, loads the model in-process). This
module only defines the track shape. It never touches a REB root or calls write_track() —
per kit/reb_runner/DESIGN.md #2 ("the box is the SOLE process that calls write_track()"), a remote
(HF) worker only computes and hands back a track body; box-side code (hf_emotion_collect.py) is what
commits it.

Shadow only, never surfaced (V's gate on W45.4, HANDOVER.md W45.4) — this engine only ever produces a
REB track dict; nothing here pushes to the lab viewer or any clinician-facing surface.

Per speaker turn where a diar track exists for the window (Fable's T-REB order, 28 Sep): the caller
supplies the turn list (built from the window's diar track — see hf_emotion_manifest.py). No diar
track -> caller passes a single turn covering the whole window.

min_speech_s gate: inherited from the box service (W45.2 handover finding — one-sentence clips under
1.5s were unscorable there, run 1 of the synthetic suite). A turn shorter than MIN_SPEECH_S is not
sent to the model; its segment still exists (so the turn isn't silently missing from the track) but
carries extras.skipped_short=True instead of a value.
"""
import os

from reb.writer import config_hash

MODEL = "Aniemore/wavlm-emotion-v1-crosslingual"
VERSION = "v1"
BACKEND = "hf-l4x1"
SUBFOLDER = "int8"  # the box :8086 Mini service loads this subfolder (app.py load_wavlm: int8 -> fp8 -> root)
REVISION = "a08f2a01c0ebf3611f5720ee46438226aa913ae7"  # hub sha, 29 Sep 2026
LABELS = ("anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness")
MIN_SPEECH_S = 1.5
DIAR_OVERSHOOT_MS = 1000


def expected_config():
    """The config dict (and its config_hash) a run of this engine WOULD use — computable with no
    model load, same purpose as whisper.expected_config: lets a caller check "does this track already
    exist?" before paying for a GPU run."""
    return {"backend": BACKEND, "min_speech_s": MIN_SPEECH_S, "subfolder": SUBFOLDER, "revision": REVISION}


def turns_from_diar_segments(diar_segments, window_t0_ms, window_t1_ms):
    """[(t0_ms, t1_ms, speaker), ...] from a diar track's segments (each REB segment has
    t0_ms/t1_ms and, for the diar layer, a speaker field), or one whole-window turn (speaker=None) if
    diar_segments is empty/None.

    window_t0_ms/window_t1_ms are the window's own (absolute, tape-clock) bounds — used ONLY to
    compute the fallback turn's duration. Every returned turn, diar or fallback, is WINDOW-RELATIVE
    (0-based within the window's wav file), matching the convention whisper.py's segments already use
    (chunk offset within the window, not absolute tape time) — REB-SPEC's "every segment carries
    t0_ms/t1_ms on [the tape] clock" is true at the manifest/window level, not per segment, and the
    fallback previously returned the window's ABSOLUTE bounds directly, which both misaligned the
    written segment against every other layer's segments AND (worse) got handed straight to slice_fn
    as a wav-file offset in seconds — for a real epoch t0 (~1.79e12 ms), that's ~56 years into a 300s
    clip (eta-refuter #5410 B1). Diar segments are window-relative (verified by eta-refuter #5659 on
    19 real pyannote-local-twin tracks)."""
    if diar_segments:
        dur = window_t1_ms - window_t0_ms
        turns = []
        for s in diar_segments:
            t0, t1 = s["t0_ms"], s["t1_ms"]
            if dur < t1 <= dur + DIAR_OVERSHOOT_MS:
                t1 = dur  # diarizer rounding at the window edge
            if not (0 <= t0 <= t1 <= dur):
                raise ValueError(f"diar segment {t0}-{t1} outside window-relative [0, {dur}]")
            turns.append((t0, t1, s.get("speaker")))
        return turns
    return [(0, window_t1_ms - window_t0_ms, None)]


def build_track(window_id, wav_path, window_t0_ms, window_t1_ms, diar_segments=None,
                 model=None, machine="hf-l4x1", slice_fn=None, score_fn=None):
    """Builds one REB emotion track dict for a window (does NOT write it — see module docstring).

    window_t0_ms/window_t1_ms are the window's own absolute (tape-clock) bounds, from the manifest —
    used only to size the no-diar fallback turn; every segment this function writes is WINDOW-RELATIVE
    (see turns_from_diar_segments's docstring).

    slice_fn(wav_path, t0_ms, t1_ms) -> clip_path cuts one turn's audio out of the window wav (t0_ms/
    t1_ms window-relative, i.e. valid offsets into wav_path itself); defaults to
    reb_runner.engines.audio_utils.slice_wav. score_fn(model, clip_path) -> {"label", "scores"} or None
    (None = no audio for that turn); the real scores come from hf_emotion_job.py via
    hf_emotion_collect.track_from_scores.
    """
    from .audio_utils import slice_wav

    slice_fn = slice_fn or (lambda path, t0_ms, t1_ms: slice_wav(path, t0_ms / 1000.0, (t1_ms - t0_ms) / 1000.0))
    if score_fn is None:
        raise ValueError("score_fn is required: scoring runs in hf_emotion_job.py, not in this module")

    turns = turns_from_diar_segments(diar_segments, window_t0_ms, window_t1_ms)
    config = expected_config()
    segments = []
    for t0_ms, t1_ms, speaker in turns:
        seg = {"t0_ms": t0_ms, "t1_ms": t1_ms}
        if speaker is not None:
            seg["speaker"] = speaker
        if (t1_ms - t0_ms) / 1000.0 < MIN_SPEECH_S:
            seg["extras"] = {"skipped_short": True}
            segments.append(seg)
            continue
        clip_path = slice_fn(wav_path, t0_ms, t1_ms)
        try:
            value = score_fn(model, clip_path)
            if value is None:  # scorer had no audio for this turn (tape gap): keep the turn, say why
                seg["extras"] = {"skipped_no_audio": True}
            elif "skipped" in value:  # every piece failed the silence gate: no label, say why
                seg["extras"] = {"skipped_silence": True}
            else:
                seg["value"] = value
        finally:
            if clip_path != wav_path:
                try:
                    os.unlink(clip_path)
                except OSError:
                    pass
        segments.append(seg)

    scored = any("value" in s for s in segments)
    config_h = config_hash(config)
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": "emotion", "engine": "wavlm",
        "model": MODEL, "version": VERSION, "config": config, "config_hash": config_h,
        "machine": machine, "status": "ok" if scored else "empty",
        "reason": None if scored else "no turn scored (below min_speech_s, silent, or no audio)",
        "segments": segments,
    }
