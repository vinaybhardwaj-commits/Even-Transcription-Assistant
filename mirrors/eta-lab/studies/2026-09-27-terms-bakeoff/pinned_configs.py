"""W50 terms bake-off: pre-registered configs for all 6 engines, with a hard assert-before-write guard (refuter-3,
bus #4912) against config drift between set (b) and set (c) writes.

v2 (ADDENDUM-12, refuter-3's L1-L4 / refuter-2's #4917/#4919): ADDENDUM-10's candidate configs were silent about
long-audio handling. Set (c)'s consult crops run 68s-21,407s (median 781s, 45 audio-hours over 99 consults) -
completely unlike clinical1's short stimuli - and none of medasr (CTC, no native long-form), sravaani's box-twin
(single-shot HTTP call, docstring says "<=35s clip"), or a naive whisper call handle that safely without a declared
chunk plan. Revised BEFORE any candidate write ever happened (no drift risk - nothing was written under the old
candidate hashes 69bde46b/9d23ef4f/41542eb5):
  - medasr, whisper-med-merged: chunk_s=30 added to their ONE canonical config (used on both sets - a no-op on
    clinical1's already-short clips, load-bearing on set (c)'s long crops).
  - parakeet-med: long_form="native" added - NeMo's own buffered/long-form transcribe path, not manual chunking,
    since that's exactly the capability its README advertises ("same long-form support" as base Parakeet).
  - sravaani is different: set (b) is ALREADY WRITTEN by reb's dev-ingest under cee5af35 (single-shot - correct for
    clinical1's short clips, can't be changed retroactively). Set (c) needs ITS OWN new config (chunk_s=30,
    genuinely a different, longer-audio-safe execution path) - so sravaani has two registered configs, one per set,
    tracked in SRAVAANI_BY_SET below, not one shared PINNED_CONFIGS entry.
  - whisper-auto/whisper-cap2: UNCHANGED hashes (4b67551a/c7bd317b) on both sets - reb confirmed the config dict is
    byte-identical between the dev-ingest runner (9402a6de) and current main (1ee3b4a4); only chunk PLANNING
    internals changed (ffprobe duration, tail-chunk merging, segment-end clamping), which live in the runner code,
    not the config dict. Per refuter-2's settled position (#4919, gates compare candidate-vs-baseline WITHIN a set,
    never across sets): set (c)'s whisper baselines run from main@1ee3b4a4 (the FIXED code) while set (b)'s came
    from dev-ingest@9402a6de (the pre-fix code) - same config_hash, different runner commit, LABELED per row in
    STEP 3 (RUNNER_LABELS below), not hidden behind one hash.

v3 (ADDENDUM-13/14/15): the "chunk_s=30 is a no-op on clinical1" claim above (line 10-11) was WRONG - 102/192
clinical1 stimuli exceed 30s (max 41.16s), verified - corrected in ADDENDUM-13, kept here only as the historical
record of what v2 said. RUNNER_LABELS["c"]["sravaani"] names main@a5def748 (reb's chunked box_twin fix, refuter-3
PASSed it at bus #4929/#4931/#4935, merged to main via e232f063) - not dev-ingest@9402a6de, which is single-shot
only and can't run the chunked config at all. Two notes from that review, both already satisfied by this file: N1
chunk_s must be a Python int (30, not 30.0 - the float hashes differently, e2140b72); N2 an engine call that raises
during dev_ingest writes NO track at all (not even "failed") and the window is marked done permanently, so an
ABSENT track (no file, not a status field) must be treated the same as failed/skipped/tape_gap in the
paired-exclusion rule (ADDENDUM-9 rule 3) - 0 cases as of the
review, re-check once ingest completes.

v4 (ADDENDUM-16, refuter-3's F1/F2 bus #4943): after the real transformers-based smoke test (whisper-tiny), refuter-3
independently tested (transformers 4.57.6, /home/eta/indic/.venv) and found HF's WhisperFeatureExtractor HARD-
TRUNCATES to exactly 30.0s regardless of input length (verified again here: a 31s tone's features are byte-identical
to the same tone truncated at 30.0s, and appending 4 more loud seconds changes nothing). whisper-med-merged's old
chunk_s=30 + tail-merge (up to +1.0s) could silently drop up to ~1s of audio at the end of a merged chunk - on
clinical1, 21/192 clips would have lost up to 0.82s (often the consult's Rx close, exactly where a drug is likely
named). Fixed: chunk_s=29 (worst-case merged chunk is now <30.0s, safely inside the truncation window) - NEW HASH
6858a1d1 (was 6fc0f7a5; nothing written under the old one). Also F2: the OLD config claimed temperature_inc=0.2 (a
fallback-decoding schedule) but engine_whisper_med_merged.py's actual generate() call was plain greedy with no
fallback logic - the config was describing behaviour the code didn't implement (the M2 class of bug again). Fixed by
REMOVING temperature_inc (matching what the code actually does - implementing the real multi-pass fallback was
judged not worth the added complexity/risk for this bake-off) rather than by implementing the fallback.
F3: parakeet-med's plain model.transcribe() on a 13-60min file uses NeMo's default FULL attention (O(n^2) memory),
likely to OOM on an L4 for the longer end of set (c)'s span-capped consults. Added `attention_model:
"rel_pos_local_attn_128_128"` to the config (engine_parakeet_med.py calls model.change_attention_model() with this
setting before transcribing) - NEW HASH 312ad42b (was 6e211483).

Fix (from v1, refuter-3 #4912): reuse_config(engine) returns the frozen dict; assert_pinned(engine, actual_config)
recomputes config_hash on whatever the engine code ACTUALLY built at write time and raises PinnedConfigMismatch if
it doesn't equal the pre-registered hash - refusing the write rather than silently drifting. Call this immediately
before every kit/reb write_track() call for these 6 engines.
"""
import json
import hashlib

# Verbatim from reb's live suite-clinical1 config (config_hash() verified to reproduce these exactly - ADDENDUM-10).
WHISPER_AUTO = {"language": "auto", "response_format": "verbose_json", "temperature": 0.0, "temperature_inc": 0.2}
WHISPER_CAP2 = {
    "language": "en", "response_format": "verbose_json", "temperature": 0.0, "temperature_inc": 0.2,
    "prompt": (
        "Clinical terms: hypertension, diabetes mellitus, tablet, capsule, mg, milligram, BP, blood pressure, "
        "ECG, echocardiogram, metformin, amlodipine, atorvastatin, telmisartan, HbA1c, creatinine, thyroid, TSH, "
        "prescription, follow-up, dosage, twice daily, once daily, before food, after food, OPD, consultation, "
        "symptoms, fever, cough, cold, chest pain, shortness of breath, angiography, stent, bypass."
    ),
    "prompt_source": "placeholder",
}

# sravaani: set-specific (see module docstring - set (b) is already written, single-shot; set (c) needs chunking).
SRAVAANI_SINGLE_SHOT = {"backend": "box-twin-cpu"}
SRAVAANI_CHUNKED = {"backend": "box-twin-cpu", "chunk_s": 30}
SRAVAANI_BY_SET = {"b": SRAVAANI_SINGLE_SHOT, "c": SRAVAANI_CHUNKED}
SRAVAANI_HASH_BY_SET = {"b": "cee5af35", "c": "b3584dd6"}

# Candidates, one canonical config each (used on both sets), HF revisions pinned live on 27 Sep 2026, long-audio
# handling declared (ADDENDUM-12, L3).
MEDASR = {
    "model": "google/medasr", "revision": "ae1e4845b4b07479735d93e1e591e566435b7104",
    "sample_rate": 16000, "audio_format": "mono_int16", "decoding": "greedy", "lm": "none",
    "chunk_s": 30, "chunk_overlap_s": 0,
}
PARAKEET_MED = {
    "model": "yuriyvnv/parakeet-tdt-0.6b-EN-Medical", "revision": "3d19bbf0eed105cfad19704e86c3bec2eefb53a8",
    "checkpoint_file": "parakeet-tdt-cv17_multimed_en-seed42.nemo", "decoding": "tdt_greedy", "sample_rate": 16000,
    "long_form": "native", "attention_model": "rel_pos_local_attn_128_128",  # ADDENDUM-16 F3
}
WHISPER_MED_MERGED = {
    "model": "taphuynh/whisper-large-en-medical-2607.26-merged",
    "revision": "cebe2b937072e6f1b62f8ef4bb9a1a001356bc27",
    "language": "en", "temperature": 0.0,  # ADDENDUM-16 F2: dropped temperature_inc
    "chunk_s": 29,  # ADDENDUM-16 F1: was 30
    "dtype": "fp32",  # ADDENDUM-19 R1 (refuter-3): the smoke-test dtype fix changes numerics, must be in the config
    # v5 (smoke test): dropped response_format="verbose_json" - it implied segment-level detail this engine no
    # longer produces (return_timestamps was removed, smoke-test finding 2 in engine_whisper_med_merged.py); one
    # segment per chunk now, matching medasr's granularity.
}

PINNED_CONFIGS = {
    "whisper-auto": WHISPER_AUTO,
    "whisper-cap2": WHISPER_CAP2,
    "medasr": MEDASR,
    "parakeet-med": PARAKEET_MED,
    "whisper-med-merged": WHISPER_MED_MERGED,
}

PINNED_HASHES = {
    "whisper-auto": "4b67551a",
    "whisper-cap2": "c7bd317b",
    "medasr": "e2b69f8a",
    "parakeet-med": "312ad42b",
    "whisper-med-merged": "80f60bd2",
}

# Which runner commit produced each engine's tracks, per set (ADDENDUM-12 L1) - config_hash is identical for whisper
# either way, so this is the thing that actually distinguishes set (b)'s dev-ingest run from set (c)'s fresh run;
# name it explicitly in STEP 3 rather than let one config_hash hide two different runner behaviors.
RUNNER_LABELS = {
    "b": {"whisper-auto": "dev-ingest@9402a6de", "whisper-cap2": "dev-ingest@9402a6de", "sravaani": "dev-ingest@9402a6de"},
    "c": {"whisper-auto": "main@1ee3b4a4", "whisper-cap2": "main@1ee3b4a4", "sravaani": "main@a5def748 (merged via e232f063)"},
}


def config_hash(config):
    """Byte-identical to kit/reb/writer.py's config_hash() - sha256 of sorted-key, no-whitespace JSON, first 8 hex."""
    body = json.dumps(config or {}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()[:8]


class PinnedConfigMismatch(Exception):
    pass


def reuse_config(engine, dataset_set=None):
    """-> the pre-registered config dict for `engine` (a fresh copy, safe to mutate by the caller). `sravaani` is
    set-specific (see module docstring) - pass dataset_set="b" or "c" for it; every other engine ignores dataset_set
    (one canonical config used on both sets)."""
    if engine == "sravaani":
        if dataset_set not in SRAVAANI_BY_SET:
            raise KeyError(f"sravaani needs dataset_set='b' or 'c' (got {dataset_set!r})")
        return dict(SRAVAANI_BY_SET[dataset_set])
    if engine not in PINNED_CONFIGS:
        raise KeyError(f"no pinned config for engine {engine!r} - not one of the 6 named in ADDENDUM-10/12")
    return dict(PINNED_CONFIGS[engine])


def assert_pinned(engine, actual_config, dataset_set=None):
    """Call this immediately before every kit/reb write_track() for one of the 6 W50 engines. Raises
    PinnedConfigMismatch (refusing the write) if whatever the engine code actually built at write time doesn't hash
    to the pre-registered value - e.g. if a real CAP-2 prompt file appears between set (b) and set (c) runs and
    reb's writer silently switches prompt_source from "placeholder" to "file". `sravaani` needs dataset_set='b' or
    'c' (different pre-registered hash per set, per ADDENDUM-12 L2)."""
    if engine == "sravaani":
        if dataset_set not in SRAVAANI_HASH_BY_SET:
            raise KeyError(f"sravaani needs dataset_set='b' or 'c' (got {dataset_set!r})")
        expected = SRAVAANI_HASH_BY_SET[dataset_set]
    else:
        expected = PINNED_HASHES.get(engine)
        if expected is None:
            raise KeyError(f"no pinned hash for engine {engine!r} - not one of the 6 named in ADDENDUM-10/12")
    actual = config_hash(actual_config)
    if actual != expected:
        raise PinnedConfigMismatch(
            f"{engine}: config_hash mismatch - expected {expected} (pre-registered), got {actual}. "
            f"Refusing to write; the engine's actual config drifted from what was pre-registered "
            f"(e.g. a CAP-2 prompt file appearing after the fact). Config as built: {actual_config!r}"
        )
