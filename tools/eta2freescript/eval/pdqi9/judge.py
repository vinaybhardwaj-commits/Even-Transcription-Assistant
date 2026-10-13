"""Frozen-file loading and PDQI-9 scoring. One note per call, blinded note ids, shuffled call order, cached per note.

The frozen prompts are loaded from a directory the caller names. Nothing here logs or stores prompt text, note text or
transcript text; the cache holds scores only.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path

from ...models import ModelClient

SEED = 20261012
JUDGES = ("opus", "sonnet")
REFS = ("transcript", "none")
ITEM_KEYS = ("up_to_date", "accurate", "thorough", "useful", "organized", "comprehensible", "succinct", "synthesized", "internally_consistent")
N_ITEMS = len(ITEM_KEYS)
FROZEN_FILES = ("pdqi9-judge-v3.system.txt", "pdqi9-ref-transcript-v3.txt", "pdqi9-ref-none-v3.txt", "pdqi9-user-v3.txt",
                "floor-items-v1.system.txt", "floor-missing-v1.system.txt", "split-v1.json")


class FrozenError(RuntimeError):
    pass


@dataclass
class Frozen:
    root: Path
    text: dict[str, str] = field(repr=False)
    hashes: dict[str, str]

    def prompt_sha(self, *names: str) -> str:
        return hashlib.sha256("".join(self.hashes[n] for n in names).encode()).hexdigest()

    def pdqi9_sha(self, ref: str) -> str:
        return self.prompt_sha("pdqi9-judge-v3.system.txt", f"pdqi9-ref-{ref}-v3.txt", "pdqi9-user-v3.txt")

    @property
    def split_path(self) -> Path:
        return self.root / "split-v1.json"


def _private(p: Path) -> None:
    mode = stat.S_IMODE(p.stat().st_mode)
    if mode & 0o077:
        raise FrozenError(f"{p.name} is group- or world-accessible (mode {mode:04o}); chmod it to owner-only")


def load_frozen(root: str | Path) -> Frozen:
    root = Path(root)
    if not root.is_dir():
        raise FrozenError("frozen dir is not a directory")
    _private(root)
    text, hashes = {}, {}
    for name in FROZEN_FILES:
        p = root / name
        if not p.is_file():
            raise FrozenError(f"frozen file missing: {name}")
        _private(p)
        raw = p.read_bytes()
        hashes[name] = hashlib.sha256(raw).hexdigest()
        text[name] = raw.decode("utf-8")
    for need, name in (("{{REFERENCE_RULE}}", "pdqi9-judge-v3.system.txt"),) + tuple((t, "pdqi9-user-v3.txt") for t in ("{{TRANSCRIPT_BLOCK}}", "{{NOTE_ID}}", "{{NOTE}}")):
        if need not in text[name]:
            raise FrozenError(f"{name} lacks the {need} slot")
    return Frozen(root, text, hashes)


def note_id(uid: str, arm: str, seed: int = SEED) -> str:
    return hashlib.sha256(f"{seed}{uid}{arm}".encode()).hexdigest()[:10]


def plan_calls(uids: list[str], arms: list[str], judges=JUDGES, refs=REFS, seed: int = SEED) -> list[tuple[str, str, str, str]]:
    """(uid, arm, judge, ref) in a reproducible shuffled order: arm order per consult, then the whole call list."""
    rng = random.Random(seed)
    calls = []
    for uid in sorted(uids):
        order = list(arms)
        rng.shuffle(order)
        calls += [(uid, arm, j, r) for arm in order for j in judges for r in refs]
    rng.shuffle(calls)
    return calls


def parse_scores(text: str) -> tuple[list[int], list[str]] | None:
    """Strict: one JSON object with exactly the 9 PDQI-9 integer keys, each 1-5. Returns (scores in ITEM_KEYS order, keys) or None."""
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    try:
        d = json.loads(t)
    except ValueError:
        return None
    if not isinstance(d, dict) or set(d) != set(ITEM_KEYS):
        return None
    if any(isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 5 for v in d.values()):
        return None
    return [d[k] for k in ITEM_KEYS], list(ITEM_KEYS)


def cache_path(cache_dir: Path, *key) -> Path:
    return Path(cache_dir) / (hashlib.sha256(json.dumps(key).encode()).hexdigest() + ".json")


def _write_private(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def build_prompt(frozen: Frozen, ref: str, nid: str, note: str, transcript: str) -> tuple[str, str]:
    system = frozen.text["pdqi9-judge-v3.system.txt"].replace("{{REFERENCE_RULE}}", frozen.text[f"pdqi9-ref-{ref}-v3.txt"].strip())
    user = (frozen.text["pdqi9-user-v3.txt"].replace("{{TRANSCRIPT_BLOCK}}", transcript if ref == "transcript" else "")
            .replace("{{NOTE_ID}}", nid).replace("{{NOTE}}", note))
    return system, user


def score_note(client: ModelClient, frozen: Frozen, *, uid: str, arm: str, judge: str, ref: str, note: str, transcript: str,
               cache_dir: Path, render_version: str) -> dict:
    """One blinded call (plus one retry on a parse failure). Returns {scores|None, parse_failure, cached, note_id}."""
    nid = note_id(uid, arm)
    key = (uid, arm, judge, ref, frozen.pdqi9_sha(ref), hashlib.sha256(note.encode()).hexdigest(), render_version,
           hashlib.sha256(transcript.encode()).hexdigest() if ref == "transcript" else "")
    cp = cache_path(cache_dir, *key)
    if cp.exists():
        return {**json.loads(cp.read_text(encoding="utf-8")), "cached": True}
    system, user = build_prompt(frozen, ref, nid, note, transcript)
    rec = {"note_id": nid, "scores": None, "item_names": None, "parse_failure": True, "attempts": 0}
    for attempt in (1, 2):
        rec["attempts"] = attempt
        parsed = parse_scores(client.chat(judge, user, system, max_tokens=1500, temperature=0.0, tag=f"pdqi9-v3:{judge}-{ref}:{uid}"))
        if parsed:
            rec.update(scores=parsed[0], item_names=parsed[1], parse_failure=False)
            break
    _write_private(cp, rec)
    return {**rec, "cached": False}
