"""Gateway configuration: built-in defaults merged with an optional JSON file."""
from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CONFIG_PATH = "~/.config/llm-pool/config.json"

DEFAULT_CONFIG = {
    "aws_daily_cap_usd": 500.0,
    "aws_daily_cap_warn_fraction": 0.8,
    "client_token_file": "~/.config/llm-pool/client.token",
    "ledger_file": "~/.config/llm-pool/spend.sqlite3",
    "default_max_tokens": 4096,
    "callers": {},
    "prices": {
        "opus": {"in_per_m": 15.0, "out_per_m": 75.0, "cache_read_fraction_of_in": 0.10},
        "sonnet": {"in_per_m": 3.0, "out_per_m": 15.0, "cache_read_fraction_of_in": 0.10},
        "haiku": {"in_per_m": 1.0, "out_per_m": 5.0, "cache_read_fraction_of_in": 0.10},
        "gemini": {"in_per_m": 1.25, "out_per_m": 10.0, "cache_read_fraction_of_in": 0.10},
    },
    "models": {
        "opus": {"provider": "bedrock", "model_id": "global.anthropic.claude-opus-5-5", "price": "opus"},
        "sonnet": {"provider": "bedrock", "model_id": "global.anthropic.claude-sonnet-5-5", "price": "sonnet"},
        "haiku": {"provider": "bedrock", "model_id": "global.anthropic.claude-haiku-5-5", "price": "haiku"},
        "gemini": {"provider": "vertex", "model_id": "gemini-2.5-pro", "price": "gemini"},
        "claude-opus-5-5": {"provider": "bedrock", "model_id": "global.anthropic.claude-opus-5-5", "price": "opus"},
        "claude-sonnet-5-5": {"provider": "bedrock", "model_id": "global.anthropic.claude-sonnet-5-5", "price": "sonnet"},
        "claude-haiku-5-5": {"provider": "bedrock", "model_id": "global.anthropic.claude-haiku-5-5", "price": "haiku"},
        "global.anthropic.claude-opus-5-5": {"provider": "bedrock", "model_id": "global.anthropic.claude-opus-5-5", "price": "opus"},
        "global.anthropic.claude-sonnet-5-5": {"provider": "bedrock", "model_id": "global.anthropic.claude-sonnet-5-5", "price": "sonnet"},
        "global.anthropic.claude-haiku-5-5": {"provider": "bedrock", "model_id": "global.anthropic.claude-haiku-5-5", "price": "haiku"},
        "global.anthropic.claude-opus-4-7": {"provider": "bedrock", "model_id": "global.anthropic.claude-opus-4-7", "price": "opus"},
        "global.anthropic.claude-sonnet-4-6": {"provider": "bedrock", "model_id": "global.anthropic.claude-sonnet-4-6", "price": "sonnet"},
        "gemini-2.5-pro": {"provider": "vertex", "model_id": "gemini-2.5-pro", "price": "gemini"},
    },
}

_BEDROCK_PROFILE_PREFIXES = ("global.", "apac.", "in.", "us.", "eu.", "jp.", "sa.")
_FAMILIES = ("opus", "sonnet", "haiku")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ModelSpec:
    requested: str
    provider: str
    model_id: str
    price_family: str


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def load_config(path: str | os.PathLike | None = None) -> dict:
    candidate = Path(path).expanduser() if path else Path(os.environ.get("LLM_POOL_CONFIG", DEFAULT_CONFIG_PATH)).expanduser()
    if not candidate.exists():
        return copy.deepcopy(DEFAULT_CONFIG)
    try:
        raw = json.loads(candidate.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"config file {candidate.name} is not readable JSON: {type(exc).__name__}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"config file {candidate.name} must hold a JSON object")
    merged = _deep_merge(DEFAULT_CONFIG, raw)
    _validate(merged)
    return merged


def _validate(config: dict) -> None:
    cap = config.get("aws_daily_cap_usd")
    if not isinstance(cap, (int, float)) or cap <= 0:
        raise ConfigError("aws_daily_cap_usd must be a positive number")
    if not isinstance(config.get("prices"), dict) or not config["prices"]:
        raise ConfigError("prices must map at least one price family")
    for family, entry in config["prices"].items():
        for field in ("in_per_m", "out_per_m"):
            if not isinstance(entry.get(field), (int, float)):
                raise ConfigError(f"prices.{family}.{field} must be a number")
    models = config.get("models")
    if not isinstance(models, dict):
        raise ConfigError("models must be an object")
    for name, entry in models.items():
        if entry.get("provider") not in ("bedrock", "vertex"):
            raise ConfigError(f"models.{name}.provider must be bedrock or vertex")
        if not isinstance(entry.get("model_id"), str) or not entry["model_id"]:
            raise ConfigError(f"models.{name}.model_id must be a non-empty string")
        if entry.get("price") not in config["prices"]:
            raise ConfigError(f"models.{name}.price family {entry.get('price')!r} is not in prices")
    warn = config.get("aws_daily_cap_warn_fraction")
    if not isinstance(warn, (int, float)) or not 0 < warn <= 1:
        raise ConfigError("aws_daily_cap_warn_fraction must be in (0, 1]")


def resolve_model(config: dict, name: str) -> ModelSpec | None:
    if not isinstance(name, str) or not name.strip():
        return None
    name = name.strip()
    entry = config["models"].get(name)
    if entry is not None:
        return ModelSpec(name, entry["provider"], entry["model_id"], entry["price"])
    if name.startswith(_BEDROCK_PROFILE_PREFIXES) and "anthropic.claude-" in name:
        for family in _FAMILIES:
            if f"claude-{family}" in name:
                return ModelSpec(name, "bedrock", name, family)
        return None
    if name.startswith("gemini"):
        return ModelSpec(name, "vertex", name, "gemini")
    return None


def list_models(config: dict) -> list[ModelSpec]:
    seen: dict[str, ModelSpec] = {}
    for name in sorted(config["models"]):
        spec = resolve_model(config, name)
        if spec is not None:
            seen[name] = spec
    return list(seen.values())
