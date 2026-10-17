import pytest

from llm_pool.config import load_config
from llm_pool.pricing import PricingError, Usage, estimate_usd, price_for


@pytest.fixture
def config():
    return load_config("/nonexistent/llm-pool-config.json")


def test_seed_prices(config):
    assert price_for(config, "opus").in_per_m == 15.0
    assert price_for(config, "opus").out_per_m == 75.0
    assert price_for(config, "sonnet").in_per_m == 3.0
    assert price_for(config, "sonnet").out_per_m == 15.0
    assert price_for(config, "haiku").in_per_m == 1.0
    assert price_for(config, "haiku").out_per_m == 5.0
    assert price_for(config, "gemini").in_per_m == 1.25
    assert price_for(config, "gemini").out_per_m == 10.0


def test_cache_read_is_tenth_of_input(config):
    opus = price_for(config, "opus")
    assert opus.cache_read_per_m == pytest.approx(1.5)
    usage = Usage(input_tokens=1_000_000, output_tokens=0, cache_tokens=400_000)
    assert estimate_usd(opus, usage) == pytest.approx(9.6)


def test_estimate_exact_arithmetic(config):
    haiku = price_for(config, "haiku")
    assert estimate_usd(haiku, Usage(input_tokens=1_000_000, output_tokens=1_000_000)) == pytest.approx(6.0)
    assert estimate_usd(haiku, Usage(input_tokens=2_000, output_tokens=100)) == pytest.approx(0.0025)


def test_unknown_family_raises(config):
    with pytest.raises(PricingError):
        price_for(config, "nope")


def test_empty_usage_is_zero(config):
    assert estimate_usd(price_for(config, "opus"), Usage()) == 0.0


def test_usage_openai_shape():
    usage = Usage(input_tokens=10, output_tokens=4, cache_tokens=3)
    assert usage.to_openai() == {
        "prompt_tokens": 10,
        "completion_tokens": 4,
        "total_tokens": 14,
        "prompt_tokens_details": {"cached_tokens": 3},
    }


def test_usage_accumulates():
    usage = Usage(1, 2, 3)
    usage.add(Usage(10, 20, 30))
    assert (usage.input_tokens, usage.output_tokens, usage.cache_tokens) == (11, 22, 33)
