"""Tests for the assert-before-write config guard (refuter-3, bus #4912) and the set-specific sravaani split +
long-audio-aware candidate configs (ADDENDUM-12, refuter-3's L1-L4)."""
import pytest

from pinned_configs import (
    PINNED_HASHES, SRAVAANI_HASH_BY_SET, RUNNER_LABELS, reuse_config, assert_pinned, config_hash,
    PinnedConfigMismatch,
)


def test_shared_pinned_configs_reproduce_their_named_hash():
    for engine, expected in PINNED_HASHES.items():
        assert config_hash(reuse_config(engine)) == expected, engine


def test_sravaani_configs_reproduce_their_per_set_hash():
    for dataset_set, expected in SRAVAANI_HASH_BY_SET.items():
        assert config_hash(reuse_config("sravaani", dataset_set=dataset_set)) == expected, dataset_set


def test_sravaani_set_b_and_c_are_genuinely_different_configs():
    b = reuse_config("sravaani", dataset_set="b")
    c = reuse_config("sravaani", dataset_set="c")
    assert b != c
    assert "chunk_s" not in b  # set (b): single-shot, already written by reb's dev-ingest, unchanged
    assert c["chunk_s"] == 30  # set (c): chunked for long consult crops


def test_sravaani_requires_dataset_set():
    with pytest.raises(KeyError):
        reuse_config("sravaani")
    with pytest.raises(KeyError):
        assert_pinned("sravaani", {"backend": "box-twin-cpu"})


def test_candidates_declare_long_audio_handling():
    medasr = reuse_config("medasr")
    assert medasr["chunk_s"] == 30
    parakeet = reuse_config("parakeet-med")
    assert parakeet["long_form"] == "native"
    whisper_med = reuse_config("whisper-med-merged")
    assert whisper_med["chunk_s"] == 29  # ADDENDUM-16 F1: was 30
    assert whisper_med["dtype"] == "fp32"  # ADDENDUM-19 R1: real numerics, must be in the config


# --- ADDENDUM-16 (refuter-3's F1/F2/F3, bus #4943) ---

def test_whisper_med_merged_chunk_s_stays_under_the_30s_feature_extractor_truncation():
    """F1: HF's WhisperFeatureExtractor hard-truncates at 30.0s (verified independently, see ADDENDUM-16). A
    tail-merged chunk's duration is chunk_s + tail, where tail is always STRICTLY less than DEFAULT_MIN_TAIL_S (the
    merge condition), so the true worst case never reaches chunk_s + DEFAULT_MIN_TAIL_S - checking that bound is
    <= 30.0 (not < 30.0) is correct and matches the verified fact that audio AT exactly 30.0s is still preserved,
    only content strictly beyond it is dropped."""
    from chunked_runner import DEFAULT_MIN_TAIL_S
    config = reuse_config("whisper-med-merged")
    assert config["chunk_s"] + DEFAULT_MIN_TAIL_S <= 30.0


def test_whisper_med_merged_config_has_no_undelivered_temperature_fallback():
    """F2: the config must not claim a decoding behaviour (temperature_inc fallback) the code doesn't implement."""
    config = reuse_config("whisper-med-merged")
    assert "temperature_inc" not in config
    assert config["temperature"] == 0.0


def test_parakeet_med_config_declares_its_long_form_attention_setting():
    """F3: "long_form": "native" alone was a label with no OOM-safe behaviour behind it - the config must also name
    the actual attention setting the adapter switches to before transcribing."""
    config = reuse_config("parakeet-med")
    assert config["attention_model"] == "rel_pos_local_attn_128_128"


def test_reuse_config_returns_a_mutable_copy_not_the_shared_dict():
    a = reuse_config("whisper-auto")
    a["language"] = "en"  # mutate the copy
    b = reuse_config("whisper-auto")
    assert b["language"] == "auto"  # the pinned original is untouched


def test_assert_pinned_passes_for_the_real_config():
    assert_pinned("whisper-cap2", reuse_config("whisper-cap2"))  # must not raise
    assert_pinned("sravaani", reuse_config("sravaani", dataset_set="c"), dataset_set="c")  # must not raise


def test_assert_pinned_catches_the_exact_drift_scenario_refuter3_described():
    """If the real CAP-2 prompt file appears and reb's writer silently switches prompt_source to "file", the
    resulting config hashes differently - assert_pinned must refuse the write, not silently accept it."""
    drifted = reuse_config("whisper-cap2")
    drifted["prompt"] = "a completely different, real clinical vocabulary list"
    drifted["prompt_source"] = "file"
    with pytest.raises(PinnedConfigMismatch):
        assert_pinned("whisper-cap2", drifted)


def test_assert_pinned_catches_wrong_set_sravaani_config():
    """Writing set (c)'s chunked sravaani config under dataset_set="b" (or vice versa) must be refused - they are
    genuinely different pre-registered configs, not interchangeable."""
    with pytest.raises(PinnedConfigMismatch):
        assert_pinned("sravaani", reuse_config("sravaani", dataset_set="c"), dataset_set="b")


def test_assert_pinned_unknown_engine_raises():
    with pytest.raises(KeyError):
        assert_pinned("not-a-real-engine", {})


def test_chunk_s_is_an_int_not_a_float():
    """refuter-3's N1 (bus #4929): chunk_s=30.0 hashes differently (e2140b72) from chunk_s=30 (b3584dd6 for
    sravaani-on-(c)) - assert_pinned would fail-safe-refuse a float, but at the cost of a wasted run. Confirm every
    declared chunk_s is a real int."""
    for engine in ("medasr", "whisper-med-merged"):
        assert isinstance(reuse_config(engine)["chunk_s"], int)
    assert isinstance(reuse_config("sravaani", dataset_set="c")["chunk_s"], int)


def test_set_c_sravaani_runner_label_names_the_merged_commit():
    """refuter-3 PASSed reb/box-twin-chunking at a5def748 (bus #4929/#4931/#4935), since merged to main via
    e232f063 - dev-ingest@9402a6de is single-shot only and cannot run set (c)'s chunked sravaani config at all, so
    the label must name the merged commit, not the pre-merge branch sha."""
    assert RUNNER_LABELS["c"]["sravaani"] == "main@a5def748 (merged via e232f063)"
