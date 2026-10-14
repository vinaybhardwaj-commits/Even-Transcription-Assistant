"""Diagnostic-only variant: same as engine_parakeet_med.py but WITHOUT the change_attention_model/
change_subsampling_conv_chunking_factor calls, to isolate whether the F3 local-attention fix is
causing the early-truncation bug seen on a 23s clip (which doesn't need OOM protection at all)."""
def load_model(revision, checkpoint_file):
    import nemo.collections.asr as nemo_asr
    from huggingface_hub import hf_hub_download
    local_path = hf_hub_download(
        repo_id="yuriyvnv/parakeet-tdt-0.6b-EN-Medical", filename=checkpoint_file, revision=revision,
    )
    model = nemo_asr.models.ASRModel.restore_from(restore_path=local_path)
    model.eval()
    return model

def make_transcribe_chunk(model, audio_path):
    def transcribe_chunk(t0, t1):
        hyps = model.transcribe([audio_path])
        hyp = hyps[0]
        text = hyp if isinstance(hyp, str) else (getattr(hyp, "text", "") or "")
        text = text.strip()
        if not text:
            return []
        return [{"t0": 0.0, "t1": t1 - t0, "text": text}]
    return transcribe_chunk
