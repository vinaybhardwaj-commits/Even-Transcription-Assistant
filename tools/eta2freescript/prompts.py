"""Versioned prompt files, JSON parsing of model output, and content hashes for the artifact header."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

PKG = Path(__file__).resolve().parent
PROMPTS = PKG / "prompts"


def prompt_path(name: str) -> Path:
    p = PROMPTS / f"{name}.md"
    if not p.exists():
        raise FileNotFoundError(f"no prompt {name!r} in {PROMPTS}")
    return p


def load_prompt(name: str) -> tuple[str, str]:
    """(system, user-template) from a prompt file split on its `## SYSTEM` / `## USER` headings."""
    txt = prompt_path(name).read_text(encoding="utf-8")
    system = txt.split("## SYSTEM", 1)[1].split("## USER", 1)[0].strip()
    user = txt.split("## USER", 1)[1].strip()
    return system, user


def parse_json(text: str) -> dict:
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    return json.loads(t[t.index("{"): t.rindex("}") + 1])


def clean_text(text: str) -> str:
    return re.sub(r"^```[a-z]*\s*|\s*```$", "", text.strip()).strip()


def sha(*paths: Path) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update(Path(p).read_bytes())
    return h.hexdigest()


def code_paths() -> list[Path]:
    return sorted(list(PKG.glob("*.py")) + list(PKG.glob("v10/*.py")))
