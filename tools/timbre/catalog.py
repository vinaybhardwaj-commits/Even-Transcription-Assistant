"""Stable model names, checkpoints, and licences. Importing this does not download weights."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    name: str
    model_id: str
    kind: str  # prosody | dimensional | embedding | categorical
    licence: str
    commercial_note: str
    # Minimum MemAvailable before this harness will try to load the weights.
    ram_gb: float
    extractor_version: str = "v1"
    # Short names accepted by --models.
    aliases: tuple[str, ...] = ()


SPECS: tuple[ModelSpec, ...] = (
    ModelSpec(
        name="egemaps_v02.v1",
        model_id="opensmile.FeatureSet.eGeMAPSv02",
        kind="prosody",
        licence="audEERING Research License (non-commercial). The Python package wraps that binary.",
        commercial_note="Commercial openSMILE licence is being procured by Vinay (Timbre T-12, architecture issue #81). Non-blocking for this offline harness.",
        ram_gb=0.4,
        aliases=("egemaps", "opensmile_egemaps"),
    ),
    ModelSpec(
        name="compare2016.v1",
        model_id="opensmile.FeatureSet.ComParE_2016",
        kind="prosody",
        licence="audEERING Research License (non-commercial). Same binary as eGeMAPS.",
        commercial_note="Same openSMILE commercial licence as eGeMAPS (T-12 / #81).",
        ram_gb=0.5,
        aliases=("compare", "compare2016", "opensmile_compare"),
    ),
    ModelSpec(
        name="audeering_msp_dim.v1",
        model_id="audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim",
        kind="dimensional",
        licence="CC-BY-NC-SA-4.0 (Hugging Face model card).",
        commercial_note="Research only. A commercial audEERING dimensional model is a separate licence Vinay is procuring (#81).",
        ram_gb=3.0,
        aliases=("audeering", "msp_dim"),
    ),
    ModelSpec(
        name="odyssey_wavlm_dim.v1",
        model_id="3loi/SER-Odyssey-Baseline-WavLM-Multi-Attributes",
        kind="dimensional",
        licence="MIT weights (model card). Trained on MSP-Podcast; the dataset's own terms are research / non-commercial.",
        commercial_note="Checkpoint id verified on Hugging Face. MSP-Podcast terms may still bind commercial use (#81).",
        ram_gb=3.5,
        aliases=("odyssey", "odyssey_wavlm"),
    ),
    ModelSpec(
        name="voxprofile_whisper_dim.v1",
        model_id="tiantiaf/whisper-large-v3-msp-podcast-emotion-dim",
        kind="dimensional",
        licence="OpenRAIL on the Hugging Face model card. The GitHub release repo has no SPDX licence. Trained on MSP-Podcast.",
        commercial_note="Not pip-installable. Adapter in extractors/voxprofile_dim.py, from github.com/tiantiaf0627/vox-profile-release. Upstream forward() hardcodes CUDA; the adapter takes --device. MSP-Podcast terms may still apply (#81).",
        ram_gb=12.0,
        aliases=("voxprofile", "vox", "vox_profile"),
    ),
    ModelSpec(
        name="emotion2vec_plus_large.v1",
        model_id="emotion2vec/emotion2vec_plus_large",
        kind="embedding",
        licence="Model card licence is 'other' (model-license, pointing at the FunASR repo). FunASR's code is MIT. Nine-class scores are stored only for comparison.",
        commercial_note="Attribution obligations called out in #81. Loaded via FunASR with hub='hf'.",
        ram_gb=4.0,
        aliases=("emotion2vec", "e2v"),
    ),
    ModelSpec(
        name="whisper_large_v3_encoder.v1",
        model_id="openai/whisper-large-v3",
        kind="embedding",
        licence="MIT (OpenAI Whisper).",
        commercial_note="Encoder mean-pool only. No decoder transcription is run.",
        ram_gb=8.0,
        aliases=("whisper", "whisper_encoder"),
    ),
    ModelSpec(
        name="wavlm_aniemore.v1",
        model_id="Aniemore/wavlm-emotion-v1-crosslingual",
        kind="categorical",
        licence="Hugging Face metadata says MIT. The model card says the licence follows microsoft/wavlm-large, which is MIT.",
        commercial_note="This is the ETA baseline that writes room_emotion_window (migration 0089). Production on the Mini serves the int8 subfolder; this harness loads the fp32 root of the same repo so transformers can run it without a quantisation runtime. Seven labels: anger, disgust, enthusiasm, fear, happiness, neutral, sadness.",
        ram_gb=3.5,
        aliases=("wavlm", "aniemore", "baseline"),
    ),
)

SPEC_BY_NAME: dict[str, ModelSpec] = {s.name: s for s in SPECS}
_ALIAS: dict[str, str] = {}
for _s in SPECS:
    _ALIAS[_s.name] = _s.name
    for _a in _s.aliases:
        _ALIAS[_a] = _s.name


class UnknownModel(ValueError):
    pass


def resolve_model_names(text: str) -> list[str]:
    """`--models all` or a comma-separated list of stable names or aliases."""
    raw = [p.strip() for p in (text or "").split(",") if p.strip()]
    if not raw or raw == ["all"]:
        return [s.name for s in SPECS]
    out: list[str] = []
    for item in raw:
        key = _ALIAS.get(item)
        if key is None:
            known = ", ".join(s.name for s in SPECS)
            raise UnknownModel(f"unknown model {item!r}. Known: {known}")
        if key not in out:
            out.append(key)
    return out
