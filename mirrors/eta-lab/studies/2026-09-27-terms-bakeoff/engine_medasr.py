"""medasr transcribe_chunk implementation (config = pinned_configs.MEDASR, hash e2b69f8a).

Runs inside an HF Job (l4x1), not this box - requires `transformers`, `torch`, `soundfile` for audio loading.
Confirmed (not guessed) that this box's stock transformers 4.48.2 cannot even load medasr's config
(AutoConfig.from_pretrained fails with "model type lasr_ctc" unrecognized) - the pinned unreleased git-commit
transformers is a hard requirement, first tested for real on the HF Job, not locally.

STEP0 facts this follows: mono 16kHz int16 input, no word-level timestamps (text-only per-call output - so each
chunk call returns exactly ONE local segment spanning the whole chunk, not word-level granularity), needs
transformers>=5.0.0 (model card recommends an unreleased git commit - pinned in the HF Job's PEP-723 deps, not
here).

Proactive fix applied before the first real run (whisper-med-merged's smoke test found the same bug class twice -
inputs left on CPU/wrong dtype while the model moved to cuda - so it's fixed here up front instead of waiting to
hit it again): transcribe_chunk moves every input tensor to model.device/model.dtype explicitly.
"""
import numpy as np


def load_model(revision):
    """Call once per HF Job, not per chunk - loading is the expensive part."""
    from transformers import AutoModelForCTC, AutoProcessor

    model_id = "google/medasr"
    processor = AutoProcessor.from_pretrained(model_id, revision=revision)
    model = AutoModelForCTC.from_pretrained(model_id, revision=revision)
    model.eval()
    return model, processor


def make_transcribe_chunk(model, processor, audio_array, sample_rate=16000):
    """audio_array: the FULL clip's mono 16kHz float32 waveform (loaded once by the caller). Returns a
    transcribe_chunk(t0, t1) closure matching chunked_runner.run_engine_for_track's expected signature - slices
    the pre-loaded array per call rather than re-reading the file per chunk."""
    import torch

    def transcribe_chunk(t0, t1):
        i0, i1 = int(t0 * sample_rate), int(t1 * sample_rate)
        chunk = audio_array[i0:i1]
        if chunk.size == 0:
            return []
        inputs = processor(chunk, sampling_rate=sample_rate, return_tensors="pt")
        model_dtype = next(model.parameters()).dtype
        inputs = {k: (v.to(device=model.device, dtype=model_dtype) if v.is_floating_point() else v.to(model.device))
                  for k, v in inputs.items()}
        with torch.no_grad():
            logits = model(**inputs).logits
        ids = torch.argmax(logits, dim=-1)
        text = processor.batch_decode(ids)[0].strip()
        if not text:
            return []
        return [{"t0": 0.0, "t1": t1 - t0, "text": text}]

    return transcribe_chunk


def load_audio(audio_path, sample_rate=16000):
    """int16 mono waveform per STEP0's documented input spec, converted to float32 in [-1, 1] for the model."""
    import soundfile as sf

    data, sr = sf.read(audio_path, dtype="int16")
    if sr != sample_rate:
        raise ValueError(f"expected {sample_rate}Hz audio, got {sr}Hz - resample before calling this")
    if data.ndim > 1:
        data = data.mean(axis=1).astype(np.int16)  # mono per STEP0 spec
    return (data.astype(np.float32) / 32768.0)
