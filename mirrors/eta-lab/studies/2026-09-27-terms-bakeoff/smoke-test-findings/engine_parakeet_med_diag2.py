"""Diagnostic v2: explicit greedy_batch decoding strategy, keeping F3's attention fix."""
def load_model(revision, checkpoint_file):
    import nemo.collections.asr as nemo_asr
    from huggingface_hub import hf_hub_download
    from omegaconf import OmegaConf, open_dict
    local_path = hf_hub_download(
        repo_id="yuriyvnv/parakeet-tdt-0.6b-EN-Medical", filename=checkpoint_file, revision=revision,
    )
    model = nemo_asr.models.ASRModel.restore_from(restore_path=local_path)
    model.change_attention_model(self_attention_model="rel_pos_local_attn", att_context_size=[128, 128])
    model.change_subsampling_conv_chunking_factor(1)
    decoding_cfg = model.cfg.decoding
    with open_dict(decoding_cfg):
        decoding_cfg.strategy = "greedy_batch"
    model.change_decoding_strategy(decoding_cfg)
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
