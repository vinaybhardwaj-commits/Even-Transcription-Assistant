"""whisper-med-merged transcribe_chunk implementation (config = pinned_configs.WHISPER_MED_MERGED, hash 6858a1d1).

Runs inside an HF Job (l4x1), not this box - requires `transformers`, `torch`. Core inference path (generate() call
shape, output_offsets decoding) WAS smoke-tested for real against openai/whisper-tiny on this box (ADDENDUM-15) -
the full merged 3GB checkpoint itself has not been loaded yet.

STEP0 open question this resolves defensively: the repo's model.safetensors is ~2x base whisper-large-v3-turbo's
size despite `library_name: peft` tags and a PeftModel usage snippet in its card - consistent with a full fp32
merged checkpoint, not a small LoRA adapter, but never actually verified which loading path works. load_model()
tries the direct (merged-checkpoint) path FIRST and only falls back to the PeftModel(base + adapter) path if that
raises - whichever one actually works gets logged, closing the open question empirically instead of guessing.

ADDENDUM-16 F1/F2 (refuter-3, bus #4943, independently re-verified on this box):
F1: HF's WhisperFeatureExtractor hard-truncates to exactly 30.0s of audio regardless of input length (confirmed: a
31s tone's features are byte-identical to that same tone truncated at 30.0s). The pinned config's chunk_s dropped
from 30 to 29 so a tail-merged chunk (up to +1.0s) never reaches 30.0s and silently loses its ending - fixed in
pinned_configs.py, not here; this file's chunking is entirely governed by chunked_runner.run_engine_for_track via
the config, so no code change was needed here for F1, only the config value.
F2: the OLD config claimed temperature_inc=0.2 (a fallback-decoding schedule escalating temperature on a bad
decode), but the generate() call below has never implemented that fallback - plain greedy every time. Fixed by
REMOVING temperature_inc from the config to match what this code actually does, rather than implementing the real
multi-pass fallback (judged not worth the added complexity for this bake-off).

SMOKE TEST FINDINGS (27 Sep, real HF Job runs on l4x1, iterated live rather than guessed):
1. The "merged" loading path IS the one that works (confirmed for real - loading_path="merged" in the job log,
resolving the STEP0 open question empirically), but the raw checkpoint has an internal dtype inconsistency -
generate() raised "Input type (float) and bias type (c10::Half) should be the same", i.e. some of the checkpoint's
own layers were saved in fp16 while the rest (and the processor's default fp32 input features) are fp32 - almost
certainly an artifact of however the LoRA merge that produced this "-merged" checkpoint was done. Fixed by forcing
the WHOLE model to one uniform dtype right after loading, and moving the input tensor to the model's own device
explicitly (was previously left on CPU, a separate latent bug that would have surfaced as a device-mismatch error
once the dtype issue was fixed). ADDENDUM-19 (refuter-3's R1): this changes real numerics, so it's now a genuine
config field (`"dtype": "fp32"`, pinned_configs.WHISPER_MED_MERGED) that `load_model` actually reads - not a
hardcoded value the config stays silent about (the same "config label vs. real behaviour" class of bug fixed
throughout this bake-off, applied to itself).
2. With that fixed, generate(..., return_timestamps=True) ran for real (multi-second wall time, not an instant
crash) but then batch_decode(..., output_offsets=True) raised `KeyError: 0` inside transformers' own internal
timestamp/alignment-head extraction - not reproducible against openai/whisper-tiny (a clean official
generation_config.json), so almost certainly triggered by something in THIS checkpoint's own bundled
generation_config.json (custom fine-tunes sometimes ship one missing/incompatible alignment_heads or similar
timestamp-extraction metadata). Rather than keep guessing at transformers internals via paid GPU trial-and-error,
DROPPED return_timestamps=True entirely and fell back to ONE segment per chunk call (local t0=0, t1=chunk duration) -
the same granularity already accepted for medasr (STEP0: no word-level timestamps at all). A real, declared
trade-off (this engine loses within-chunk segment timing), not a silent one, and far more robust than continuing to
chase an internal HF timestamp-alignment bug specific to one checkpoint's metadata.
"""


_DTYPE_MAP = {"fp32": "float32", "fp16": "float16", "bf16": "bfloat16"}


def load_model(revision, dtype="fp32"):
    """Call once per HF Job. `dtype` comes from pinned_configs.WHISPER_MED_MERGED["dtype"] - a real config field
    this function reads, not a hardcoded value (ADDENDUM-19 R1: the fp32 cast changes real numerics, so it belongs
    in the config, not silently baked into code). Returns (model, processor, loading_path) - loading_path is
    "merged" or "peft_adapter", logged so STEP0's open question is answered by this run, not left open forever."""
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    model_id = "taphuynh/whisper-large-en-medical-2607.26-merged"
    processor = WhisperProcessor.from_pretrained(model_id, revision=revision)
    try:
        model = WhisperForConditionalGeneration.from_pretrained(model_id, revision=revision)
        loading_path = "merged"
    except Exception:
        from peft import PeftModel

        base = WhisperForConditionalGeneration.from_pretrained("openai/whisper-large-v3-turbo")
        model = PeftModel.from_pretrained(base, model_id, revision=revision)
        loading_path = "peft_adapter"
    # smoke-test finding: force UNIFORM dtype across every parameter - the raw checkpoint has an internal fp16/fp32
    # inconsistency (some layers saved in fp16) that raises a dtype-mismatch error inside generate() otherwise.
    torch_dtype = getattr(torch, _DTYPE_MAP[dtype])
    model = model.to(torch_dtype)
    model.eval()
    return model, processor, loading_path


def make_transcribe_chunk(model, processor, audio_array, sample_rate=16000, language="en"):
    """audio_array: the FULL clip's mono 16kHz float32 waveform (loaded once by the caller, sliced per chunk call -
    same pattern as engine_medasr.py). Uses forced English decoding (per the pinned config's language="en"), greedy
    (temperature=0.0, no fallback schedule - ADDENDUM-16 F2). One segment per chunk call, no within-chunk
    timestamps - smoke-test finding 2 (module docstring): this checkpoint's own generation_config triggers a
    KeyError inside transformers' timestamp-alignment internals, so return_timestamps is not used here."""
    import torch

    def transcribe_chunk(t0, t1):
        i0, i1 = int(t0 * sample_rate), int(t1 * sample_rate)
        chunk = audio_array[i0:i1]
        if chunk.size == 0:
            return []
        inputs = processor(chunk, sampling_rate=sample_rate, return_tensors="pt")
        # smoke-test finding 1: input_features must be moved to the model's own device+dtype explicitly - it was
        # left on CPU/fp32-vs-fp16-mismatched here before.
        input_features = inputs["input_features"].to(device=model.device, dtype=model.dtype)
        # modern transformers generate() takes language/task directly - the older get_decoder_prompt_ids() +
        # forced_decoder_ids= pattern is legacy and generate() no longer accepts forced_decoder_ids explicitly
        # (verified against the installed transformers version's actual signature before writing this).
        with torch.no_grad():
            generated = model.generate(input_features, language=language, task="transcribe")
        text = processor.batch_decode(generated, skip_special_tokens=True)[0].strip()
        if not text:
            return []
        return [{"t0": 0.0, "t1": t1 - t0, "text": text}]

    return transcribe_chunk
