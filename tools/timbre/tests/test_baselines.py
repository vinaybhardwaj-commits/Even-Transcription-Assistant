"""Committed baselines are aggregates only: valid JSON, no window or clip ids, no free text from raters."""

from __future__ import annotations

import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parents[1] / "baselines"
# window_id = <clip_id>_p<7 digits>; clip ids look like YYYY-MM-DD_<ROOM>_<HHMM>_<8 chars>
_WINDOW = re.compile(r"_p\d{7}\b")
_CLIP = re.compile(r"\d{4}-\d{2}-\d{2}_[A-Za-z0-9]+_\d{4}_[A-Za-z0-9]{6,}")


def test_baselines_are_aggregate_only():
    files = sorted(BASE.glob("*.json"))
    assert files, "expected at least one locked baseline"
    for f in files:
        text = f.read_text(encoding="utf-8")
        data = json.loads(text)
        assert "NaN" not in text
        assert not _WINDOW.search(text), f"{f.name} contains a window id"
        assert not _CLIP.search(text), f"{f.name} contains a clip id"
        assert "notes" not in data
        models = data["evaluation"]["models"]
        assert models and all("model" in m for m in models)
        assert data["gold_set"]["n_usable_primary"] > 0
