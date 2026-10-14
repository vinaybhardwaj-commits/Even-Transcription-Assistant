"""Diagnostic v5 (final attempt): force fp32 throughout (no autocast/fp16) - decode-config knobs (diag4) had ZERO
effect on the truncated output, ruling those out; testing whether GPU mixed-precision numerics in the TDT
duration-prediction head is the cause instead."""
def load_model(revision, checkpoint_file):
    import nemo
    import torch
    print(f"[diag5] nemo version: {nemo.__version__}", flush=True)
    import nemo.collections.asr as nemo_asr
    from huggingface_hub import hf_hub_download
    local_path = hf_hub_download(
        repo_id="yuriyvnv/parakeet-tdt-0.6b-EN-Medical", filename=checkpoint_file, revision=revision,
    )
    model = nemo_asr.models.ASRModel.restore_from(restore_path=local_path)
    model = model.to(torch.float32)
    model.eval()
    return model

def make_transcribe_chunk(model, audio_path):
    def transcribe_chunk(t0, t1):
        hyps = model.transcribe([audio_path])
        hyp = hyps[0]
        print(f"[diag5] raw hyp: {hyp!r}"[:1000], flush=True)
        text = hyp if isinstance(hyp, str) else (getattr(hyp, "text", "") or "")
        text = text.strip()
        if not text:
            return []
        return [{"t0": 0.0, "t1": t1 - t0, "text": text}]
    return transcribe_chunk
