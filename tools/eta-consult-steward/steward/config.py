"""Paths and settings. Everything overridable by env so tests and the box use the same code."""
from __future__ import annotations
import os
from pathlib import Path

ALLOWED_ACTIONS = ("recut", "rerun_lane", "retry_pull", "rerun_recon")
ITEM_KINDS = ("suggestion", "question")  # 'action' is phase 3 and never produced here
LANES = ("sarvam", "nemotron", "role", "parts")

# Default model id: the global Sonnet inference profile eta2freescript uses. Override with STEWARD_MODEL_ID.
DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-5-5"
# USD per 1M tokens (input, output), list prices.
PRICE_IN, PRICE_OUT = 3.0, 15.0


def data_root() -> Path:
    return Path(os.environ.get("STEWARD_DATA_ROOT", str(Path.home() / "eta-data")))


def consult_dir() -> Path:
    return data_root() / "consult"


def index_path() -> Path:
    return Path(os.environ.get("STEWARD_INDEX", str(consult_dir() / "clips" / "index.jsonl")))


def recon_dir() -> Path:
    return Path(os.environ.get("STEWARD_RECON_DIR", str(consult_dir() / "recon")))


def encounters_path(date: str) -> Path:
    return Path(os.environ.get("STEWARD_ENC_ROOT", str(data_root() / "drtpqma"))) / date / "encounters.json"


def tapes_manifest() -> Path:
    return Path(os.environ.get("STEWARD_TAPES", str(data_root() / "tapes" / "manifest.jsonl")))


def alerts_path() -> Path:
    return Path(os.environ.get("STEWARD_ALERTS", str(consult_dir() / "ALERTS.jsonl")))


def clips_root() -> Path:
    return Path(os.environ.get("STEWARD_CLIPS", str(consult_dir() / "clips")))


def out_root() -> Path:
    return Path(os.environ.get("STEWARD_OUT", str(consult_dir() / "steward")))


def home_dir() -> Path:
    return Path(os.environ.get("STEWARD_HOME", str(Path.home() / "oc" / "consult" / "steward")))


def model_id() -> str:
    return os.environ.get("STEWARD_MODEL_ID") or os.environ.get("BEDROCK_MODEL_ID") or DEFAULT_MODEL_ID


MAX_RUN_CAP = 2.00
MAX_DAILY_CAP = 10.00
MAX_OUT_TOKENS = 4000
REPORT_OUT_TOKENS = 8000
CHARS_PER_TOKEN = 2.0  # worst-case prompt estimate (measured 2.24-2.28 on real data)


def parse_cap(value, ceiling: float, name: str) -> float:
    """A cap must be a finite number with 0 < cap <= ceiling. Anything else is refused."""
    import math
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name}: not a number")
    if not math.isfinite(v) or v <= 0 or v > ceiling:
        raise ValueError(f"{name}: must be finite, > 0 and <= {ceiling}")
    return v


def daily_cap_usd() -> float:
    return parse_cap(os.environ.get("STEWARD_DAILY_CAP_USD", "5"), MAX_DAILY_CAP, "daily cap")


def ledger_path() -> Path:
    """One fixed ledger, independent of --out / STEWARD_OUT. STEWARD_LEDGER exists for tests only."""
    return Path(os.environ.get("STEWARD_LEDGER", str(Path.home() / "eta-data" / "consult" / "steward" / "ledger.jsonl")))


def room_labels_path() -> Path:
    return Path(os.environ.get("STEWARD_ROOM_LABELS", str(Path.home() / "oc" / "palimpsest" / "in" / "room-labels.json")))


def run_cap_usd() -> float:
    return parse_cap(os.environ.get("STEWARD_RUN_CAP_USD", "1.0"), MAX_RUN_CAP, "run cap")
