"""Diagnostic v3: pass pre-loaded audio array instead of a file path, plain greedy (no attention change,
no decoding-strategy override) - isolating whether NeMo's file-based Lhotse dataloader path is the problem."""
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
    import soundfile as sf
    import numpy as np
    data, sr = sf.read(audio_path, dtype="float32")
    print(f"[diag3] loaded audio: shape={data.shape} sr={sr} dtype={data.dtype} max_abs={np.abs(data).max():.4f}", flush=True)

    def transcribe_chunk(t0, t1):
        hyps = model.transcribe([data])
        print(f"[diag3] raw hyps: {hyps!r}"[:2000], flush=True)
        hyp = hyps[0]
        text = hyp if isinstance(hyp, str) else (getattr(hyp, "text", "") or "")
        text = text.strip()
        if not text:
            return []
        return [{"t0": 0.0, "t1": t1 - t0, "text": text}]
    return transcribe_chunk
