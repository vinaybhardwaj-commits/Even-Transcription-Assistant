"""parakeet-med transcribe_chunk implementation (config = pinned_configs.PARAKEET_MED, hash 312ad42b,
long_form="native" - no manual chunking, chunked_runner.run_engine_for_track calls this ONCE on the whole clip).

Runs inside an HF Job (l4x1), not this box - requires `nemo_toolkit[asr]`. NOT YET SMOKE-TESTED on GPU (same
caveat as engine_medasr.py - reviewable now, expect at least one iteration once actually run). This is the one W50
adapter with ZERO local verification of any kind (no NeMo installed on this box) - smoke-test it FIRST, and
specifically on the longest retained clip (up to 60min after the span cap), not a short one, per refuter-3's ask
(bus #4943 F3) - an OOM only shows up at length.

STEP0 facts this follows: use the SPECIFIC checkpoint file `parakeet-tdt-cv17_multimed_en-seed42.nemo` (the repo
ships two .nemo files; the OTHER one, without "cv17", is an earlier medical-only run the README itself says caused
catastrophic forgetting - never load it by mistake), not whatever `from_pretrained(repo_id)` would pick by default.
The README claims "same timestamps" as base Parakeet-TDT, but the first real smoke test found `timestamps=True`
unreliable on this specific checkpoint (see make_transcribe_chunk's docstring) - dropped, same one-segment-per-call
granularity as medasr now, not the finer-grained timing originally hoped for.

ADDENDUM-16 F3 (refuter-3, bus #4943): plain `model.transcribe([path])` on a 13-60min file uses NeMo's DEFAULT full
self-attention (O(n^2) memory in sequence length) and is likely to OOM on an L4 (24GB) at the long end of set (c)'s
span-capped consults - "native long-form" was a config LABEL, not yet real long-form-safe behaviour (the M2 class
of bug, again). Fixed: `load_model` now switches the encoder to NeMo's documented long-audio attention config
(limited local attention + subsampling conv chunking) BEFORE any transcription, matching the config's
`attention_model` field so the label and the behaviour agree.
"""


def load_model(revision, checkpoint_file):
    """Call once per HF Job. Downloads the SPECIFIC named checkpoint file and restores from it directly -
    `from_pretrained(repo_id)` alone is ambiguous between this repo's two .nemo files. Then switches to NeMo's
    documented long-audio attention setup (ADDENDUM-16 F3) so a 13-60min set-(c) clip doesn't OOM the L4 on full
    O(n^2) self-attention."""
    import nemo.collections.asr as nemo_asr
    from huggingface_hub import hf_hub_download

    local_path = hf_hub_download(
        repo_id="yuriyvnv/parakeet-tdt-0.6b-EN-Medical", filename=checkpoint_file, revision=revision,
    )
    model = nemo_asr.models.ASRModel.restore_from(restore_path=local_path)
    model.change_attention_model(self_attention_model="rel_pos_local_attn", att_context_size=[128, 128])
    model.change_subsampling_conv_chunking_factor(1)
    model.eval()
    return model


def make_transcribe_chunk(model, audio_path):
    """audio_path: path to the (already span-cropped) full clip - NeMo's own long-form transcribe handles buffering
    internally, so this is called exactly once with (0, duration_s) by run_engine_for_track for a "long_form":
    "native" config. One segment per call - smoke-test finding (see module docstring): timestamps=True produced an
    empty hypothesis for real audio on this checkpoint (y_sequence a zero-length tensor) and the original
    offsets-extraction code had a separate bug (hyp.timestamp is a dict with a "segment" KEY, not an object with a
    .segment ATTRIBUTE - getattr() on it always silently returned None). Rather than debug NeMo's timestamp
    internals further via paid GPU iteration, dropped timestamps entirely - same call shape that already works
    reliably for medasr and whisper-med-merged."""

    def transcribe_chunk(t0, t1):
        hyps = model.transcribe([audio_path])
        hyp = hyps[0]
        text = hyp if isinstance(hyp, str) else (getattr(hyp, "text", "") or "")
        text = text.strip()
        if not text:
            return []
        return [{"t0": 0.0, "t1": t1 - t0, "text": text}]

    return transcribe_chunk
