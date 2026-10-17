"""Token price table and spend estimation (seed prices; see README for provenance)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Price:
    in_per_m: float
    out_per_m: float
    cache_read_per_m: float


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_tokens: int = 0
    # Billing-state flags set by the upstream adapters (not part of the token counts):
    # accepted = the provider took the call (so a 0 row would be wrong);
    # reported = the provider told us the real token usage.
    accepted: bool = field(default=False, compare=False, repr=False)
    reported: bool = field(default=False, compare=False, repr=False)

    def add(self, other: "Usage") -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_tokens += other.cache_tokens

    def to_openai(self) -> dict:
        return {
            "prompt_tokens": self.input_tokens,
            "completion_tokens": self.output_tokens,
            "total_tokens": self.input_tokens + self.output_tokens,
            "prompt_tokens_details": {"cached_tokens": self.cache_tokens},
        }


class PricingError(KeyError):
    pass


def price_for(config: dict, family: str) -> Price:
    try:
        entry = config["prices"][family]
    except KeyError as exc:
        raise PricingError(f"unknown price family {family!r}") from exc
    fraction = float(entry.get("cache_read_fraction_of_in", 0.1))
    return Price(
        in_per_m=float(entry["in_per_m"]),
        out_per_m=float(entry["out_per_m"]),
        cache_read_per_m=float(entry["in_per_m"]) * fraction,
    )


def estimate_usd(price: Price, usage: Usage) -> float:
    cache = max(int(usage.cache_tokens), 0)
    input_tokens = max(int(usage.input_tokens), 0)
    output_tokens = max(int(usage.output_tokens), 0)
    uncached = max(input_tokens - cache, 0)
    usd = (
        uncached * price.in_per_m
        + cache * price.cache_read_per_m
        + output_tokens * price.out_per_m
    ) / 1_000_000.0
    return round(usd, 6)


def reservation_usd(price: Price, input_tokens_upper: int, max_output_tokens: int) -> float:
    """Worst-case spend for one call: every input token uncached plus max_tokens of output."""
    usd = (max(int(input_tokens_upper), 0) * price.in_per_m + max(int(max_output_tokens), 0) * price.out_per_m) / 1_000_000.0
    return round(usd, 6)
