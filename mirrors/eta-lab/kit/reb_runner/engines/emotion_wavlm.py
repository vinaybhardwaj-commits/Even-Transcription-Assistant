"""HF-run engine for REB's emotion layer (REB-SPEC-v1.md section 3: "wavlm crosslingual per speaker
run"). Same model as the box :8086 Mini service (studies/2026-09-27-tone-emotion-validate/
emotion_suite.py): Aniemore/wavlm-emotion-v1-crosslingual, 7 labels — model id and label set are
kept identical to the Mini service so scores from this layer are directly comparable to what W45.2
already validated (arm 1's finding stands: negative-emotion labels are NOT to be reported as valid
from this model — see HANDOVER.md and RULINGS-2026-09-27.md #4506).

Runs on HF L4 GPU via hf-fleet (RULINGS 13:22: "diar/nemotron/emotion move to HF once up"; box T4 is
STT-only). This module loads the model in-process (unlike the box service, which is called over HTTP)
because an HF Job has no box replica to call. It never touches a REB root or calls write_track() —
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
LABELS = ("anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness")
MIN_SPEECH_S = 1.5


def expected_config():
    """The config dict (and its config_hash) a run of this engine WOULD use — computable with no
    model load, same purpose as whisper.expected_config: lets a caller check "does this track already
    exist?" before paying for a GPU run."""
    return {"backend": BACKEND, "min_speech_s": MIN_SPEECH_S}


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
    clip (eta-refuter #5410 B1). Diar segments are assumed already window-relative (no diar writer
    exists yet to verify against; re-check this assumption once one lands)."""
    if diar_segments:
        return [(s["t0_ms"], s["t1_ms"], s.get("speaker")) for s in diar_segments]
    return [(0, window_t1_ms - window_t0_ms, None)]


def load_model():
    """Loads the wavlm crosslingual pipeline once per process. Real transformers import is deferred
    to here so unit tests (and any code that only wants turns_from_diar_segments/build_track's shape)
    never need it installed."""
    from transformers import pipeline

    return pipeline("audio-classification", model=MODEL)


def score_clip(model, wav_path):
    """Runs the loaded wavlm pipeline over one wav file. Returns {"label": ..., "scores": {label:
    prob}}. `model` is whatever load_model() returned — kept as a plain argument (not a module-level
    global) so callers/tests can pass a fake without monkeypatching load_model's transformers import."""
    out = model(wav_path)  # transformers AudioClassificationPipeline shape: [{"label","score"}, ...]
    scores = {r["label"]: r["score"] for r in out}
    label = max(scores, key=scores.get)
    return {"label": label, "scores": scores}


def build_track(window_id, wav_path, window_t0_ms, window_t1_ms, diar_segments=None,
                 model=None, machine="hf-l4x1", slice_fn=None, score_fn=None):
    """Builds one REB emotion track dict for a window (does NOT write it — see module docstring).

    window_t0_ms/window_t1_ms are the window's own absolute (tape-clock) bounds, from the manifest —
    used only to size the no-diar fallback turn; every segment this function writes is WINDOW-RELATIVE
    (see turns_from_diar_segments's docstring).

    slice_fn(wav_path, t0_ms, t1_ms) -> clip_path cuts one turn's audio out of the window wav (t0_ms/
    t1_ms window-relative, i.e. valid offsets into wav_path itself); defaults to
    reb_runner.engines.audio_utils.slice_wav. score_fn(model, clip_path) -> {"label", "scores"}
    defaults to score_clip; both are injectable so tests never need ffmpeg or a real model.
    """
    from .audio_utils import slice_wav

    slice_fn = slice_fn or (lambda path, t0_ms, t1_ms: slice_wav(path, t0_ms / 1000.0, (t1_ms - t0_ms) / 1000.0))
    score_fn = score_fn or score_clip

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
            seg["value"] = score_fn(model, clip_path)
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
        "reason": None if scored else "every turn below min_speech_s",
        "segments": segments,
    }
