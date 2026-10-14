"""W50 terms bake-off: the actual chunking/stitching code that HONOURS a config's `chunk_s` (refuter-3's M2, bus
#4927) - ADDENDUM-12 declared `chunk_s`/`long_form` as config fields, which are only labels until something reads
them and behaves accordingly. This is that something, shared by every engine that needs it (medasr,
whisper-med-merged, sravaani on set (c)) so the chunking logic itself is written once, tested once, and reviewed
once - not reimplemented per engine with its own bugs.

Also wires refuter-3's other M2 ask directly: assert_pinned() runs on the config the runner ACTUALLY received,
inside run_engine_for_track() itself, before any transcription happens - so a caller can't accidentally skip the
guard by calling the model directly and writing around this module.

v2 (ADDENDUM-15, refuter-2's T1 bus #4934 / refuter-3's T1 bus #4936): v1's chunk_windows had NO tail merge -
chunk_windows(60.001, 30) produced a 1ms final chunk, chunk_windows(90.2, 30) a 0.2s one, and ~half of clinical1's
192 stimuli (median 30.45s, max 41.16s) would end in a sub-second final chunk under the old code - exactly the "1ms
tail" failure mode reb already fixed once in their own whisper runner (kit/reb_runner/engines/audio_utils.py,
plan_chunks(), reb/box-twin-chunking@d0b65cdf), which CTC/whisper models tend to hallucinate on with too little
context. Fixed by replicating reb's exact algorithm (verified against the same probes: (60.001,30)->2 windows,
(90.2,30)->3 windows) rather than inventing a different one, so candidates and reb's baselines chunk identically -
refuter-2's other explicit ask. Vendored rather than imported (audio_utils.py lives on an unmerged branch; the
algorithm is ~10 lines, pure, easy to keep byte-for-byte identical and cite).
"""
from pinned_configs import assert_pinned

DEFAULT_MIN_TAIL_S = 1.0  # matches reb's kit/reb_runner/engines/audio_utils.py DEFAULT_MIN_TAIL_S exactly


def chunk_windows(duration_s, chunk_s, overlap_s=0.0, min_tail_s=DEFAULT_MIN_TAIL_S):
    """-> [(t0, t1), ...] GLOBAL-second windows covering [0, duration_s], stride = chunk_s - overlap_s. A final
    window shorter than `min_tail_s` is folded into the previous window instead of sent alone (reb's
    audio_utils.plan_chunks algorithm, replicated - see module docstring). duration_s <= 0 -> no windows.
    Examples (verified against reb's own probes): chunk_windows(60.001, 30) -> 2 windows (the 0.001s tail merges
    into the second); chunk_windows(90.2, 30) -> 3 windows (the 0.2s tail merges into the third)."""
    if duration_s <= 0:
        return []
    if chunk_s <= overlap_s:
        raise ValueError(f"chunk_s ({chunk_s}) must exceed overlap_s ({overlap_s})")
    stride = chunk_s - overlap_s
    windows = []
    t0 = 0.0
    while t0 < duration_s:
        t1 = min(t0 + chunk_s, duration_s)
        windows.append([t0, t1])
        if t1 >= duration_s:
            break
        t0 += stride
    if len(windows) >= 2 and (windows[-1][1] - windows[-1][0]) < min_tail_s:
        windows[-2][1] = windows[-1][1]
        windows.pop()
    return [(a, b) for a, b in windows]


def run_engine_for_track(engine, config, duration_s, transcribe_chunk, dataset_set=None):
    """The one place chunk_s is actually honoured. `transcribe_chunk(t0, t1)` is the caller's model call for one
    window (or the whole clip, for a native-long-form engine) - it returns a list of LOCAL segments (dicts with at
    least "t0"/"t1" keys, relative to the chunk's own start), which this function CLAMPS to the chunk's own local
    duration (a model over/undershooting its own window is a real failure mode reb also guards against for
    whisper - "clamp to chunk end") and then shifts to the full clip's global timeline, concatenating in order.
    - Refuses (PinnedConfigMismatch, from pinned_configs) if `config` doesn't hash to the pre-registered value for
      `engine` (and `dataset_set`, for sravaani) - runs on the config THIS CALL actually received, not a
      hypothetical one, so a config that drifted before reaching here is still caught.
    - If `config` has "chunk_s": splits into chunk_windows(duration_s, chunk_s, config.get("chunk_overlap_s", 0))
      (tail-merged, see chunk_windows), calls transcribe_chunk once per window, clamps+shifts+concatenates.
    - Else (e.g. parakeet-med's "long_form":"native"): calls transcribe_chunk(0, duration_s) exactly once - the
      engine's own model handles the full clip.
    -> (windows, global_segments): `windows` is the list of (t0,t1) pairs actually used (a single (0,duration_s)
    tuple for a native-long-form engine), `global_segments` is the concatenated, globally-timestamped result.
    """
    assert_pinned(engine, config, dataset_set=dataset_set)
    if "chunk_s" in config:
        windows = chunk_windows(duration_s, config["chunk_s"], config.get("chunk_overlap_s", 0.0))
    else:
        windows = [(0.0, duration_s)] if duration_s > 0 else []
    segments = []
    for (t0, t1) in windows:
        chunk_dur = t1 - t0
        for seg in transcribe_chunk(t0, t1):
            local_t0 = max(0.0, min(seg["t0"], chunk_dur))
            local_t1 = max(local_t0, min(seg["t1"], chunk_dur))
            segments.append({**seg, "t0": local_t0 + t0, "t1": local_t1 + t0})
    return windows, segments
