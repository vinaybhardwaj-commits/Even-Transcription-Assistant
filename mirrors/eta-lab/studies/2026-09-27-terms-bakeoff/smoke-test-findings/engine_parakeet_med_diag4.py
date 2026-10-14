"""Diagnostic v4 (final attempt under the debugging cap): bump max_symbols/max_symbols_per_step in the greedy
decoding config - the raw hypothesis in diag3 showed a well-formed, real 40-token sequence (real score, real
sub-word tokens) that just STOPS early, well before the audio's actual content ends. This is the classic symptom
of an RNNT/TDT greedy decode loop hitting a per-utterance or per-step symbol cap too small for this content."""
def load_model(revision, checkpoint_file):
    import nemo.collections.asr as nemo_asr
    from huggingface_hub import hf_hub_download
    from omegaconf import open_dict
    local_path = hf_hub_download(
        repo_id="yuriyvnv/parakeet-tdt-0.6b-EN-Medical", filename=checkpoint_file, revision=revision,
    )
    model = nemo_asr.models.ASRModel.restore_from(restore_path=local_path)
    decoding_cfg = model.cfg.decoding
    print(f"[diag4] decoding cfg before: {decoding_cfg}", flush=True)
    with open_dict(decoding_cfg):
        if "greedy" not in decoding_cfg or decoding_cfg.greedy is None:
            decoding_cfg.greedy = {}
        decoding_cfg.greedy.max_symbols = 200
        decoding_cfg.greedy.max_symbols_per_step = 10
    model.change_decoding_strategy(decoding_cfg)
    print(f"[diag4] decoding cfg after: {model.cfg.decoding}", flush=True)
    model.eval()
    return model

def make_transcribe_chunk(model, audio_path):
    def transcribe_chunk(t0, t1):
        hyps = model.transcribe([audio_path])
        hyp = hyps[0]
        print(f"[diag4] raw hyp: {hyp!r}"[:1500], flush=True)
        text = hyp if isinstance(hyp, str) else (getattr(hyp, "text", "") or "")
        text = text.strip()
        if not text:
            return []
        return [{"t0": 0.0, "t1": t1 - t0, "text": text}]
    return transcribe_chunk
