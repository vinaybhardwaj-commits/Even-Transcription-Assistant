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


def note_id(uid: str, note: str, seed: int = SEED) -> str:
    """Blinded id from (seed, uid, sha256 of the note). It carries no arm: byte-identical notes for a uid get the same id and so the same prompt."""
    return hashlib.sha256(f"{seed}{uid}{hashlib.sha256(note.encode()).hexdigest()}".encode()).hexdigest()[:10]


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


_OLD_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def _json_spans(t: str) -> list[tuple[int, int]]:
    """Balanced top-level {...} spans of t as (start, end_exclusive). Quotes and escapes count only inside a span; a brace that never
    balances is skipped, not allowed to swallow a later object."""
    spans, i, n = [], 0, len(t)
    while i < n:
        if t[i] != "{":
            i += 1
            continue
        depth, j, in_str, esc = 0, i, False, False
        end = None
        while j < n:
            c = t[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
            j += 1
        if end is None:
            i += 1
        else:
            spans.append((i, end))
            i = end
    return spans


def judge_pre_strip(raw: str) -> str:
    """The judge's old strict pre-strip: independent leading and trailing fence removal."""
    return _OLD_FENCE.sub("", raw)


def _in_array(raw: str, s0: int, e0: int) -> bool:
    """True when the span sits inside a JSON array: nearest non-space char before is `[` or `,`, or after is `]` or `,`."""
    before, after = raw[:s0].rstrip()[-1:], raw[e0:].lstrip()[:1]
    return before in ("[", ",") or after in ("]", ",")


def extract_object(text: str, pre_strip=judge_pre_strip) -> tuple[dict | None, dict]:
    """Tolerant extraction (lead ruling 14 Oct 2026). Strip one optional code fence; if what is left is itself a JSON object, use it.
    Else scan for balanced top-level {...} spans: exactly one that parses as a JSON object is used (tolerated); zero or 2+ is a failure.
    A reply that is valid JSON but not an object (a list, a string) is a failure. Returns (object|None, shape) where shape holds
    counts only: leading_chars, trailing_chars, fenced, n_spans, tolerated. `pre_strip` is the caller's OLD strict pre-strip: a reply it
    accepted is tolerated=False, anything else that parses is tolerated=True. A span inside a JSON array is a failure."""
    raw = (text or "").strip()
    t = pre_strip(raw)  # the caller's old strict parser: what it accepted is never "tolerated"
    info = {"leading_chars": 0, "trailing_chars": 0, "fenced": "```" in raw, "n_spans": 0, "tolerated": False}
    try:
        d = json.loads(t)
    except ValueError:
        d = None
    else:
        spans = _json_spans(t)
        info["n_spans"] = len(spans)
        if isinstance(d, dict):
            return d, info
        return None, info
    spans = _json_spans(raw)
    info["n_spans"] = len(spans)
    if len(spans) != 1:
        return None, info
    s0, e0 = spans[0]
    if _in_array(raw, s0, e0):
        return None, info
    info["leading_chars"], info["trailing_chars"] = s0, len(raw) - e0
    try:
        d = json.loads(raw[s0:e0])
    except ValueError:
        return None, info
    if not isinstance(d, dict):
        return None, info
    info["tolerated"] = True
    return d, info


def key_shape(got, expected) -> dict:
    """Counts and expected names only; no model-chosen string. missing_keys: expected names absent; extra_keys: how many unexpected."""
    got = set(got)
    return {"missing_keys": sorted(k for k in expected if k not in got), "extra_keys": len(got - set(expected))}


def parse_scores_ex(text: str) -> tuple[tuple[list[int], list[str]] | None, dict, dict]:
    """(result|None, shape, key_shape). Strict checks on the extracted object: exactly the 9 PDQI-9 integer keys, each 1-5."""
    d, info = extract_object(text)
    if d is None:
        return None, info, key_shape((), ())
    diff = key_shape(d, ITEM_KEYS)
    if diff["missing_keys"] or diff["extra_keys"] or any(isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 5 for v in d.values()):
        return None, info, diff
    return ([d[k] for k in ITEM_KEYS], list(ITEM_KEYS)), info, diff


def parse_scores(text: str) -> tuple[list[int], list[str]] | None:
    """One JSON object with exactly the 9 PDQI-9 integer keys, each 1-5 (tolerant of prose around a single object). Returns (scores in
    ITEM_KEYS order, keys) or None."""
    return parse_scores_ex(text)[0]


def uid_hash(uid: str) -> str:
    return hashlib.sha256(uid.encode()).hexdigest()[:12]


def last_usage(client: ModelClient, tag: str) -> tuple[int | None, str | None]:
    """(output tokens, stop reason) of the call just made, from the client's usage ledger, if it keeps one. Counts only."""
    path = getattr(getattr(client, "ledger", None), "path", None)
    try:
        if path and Path(path).exists():
            for ln in reversed(Path(path).read_text(encoding="utf-8").splitlines()):
                if not ln.strip():
                    continue
                rec = json.loads(ln)
                if rec.get("tag") == tag:
                    return rec.get("out"), rec.get("stop")
                if "tag" in rec:
                    break
    except (OSError, ValueError, AttributeError):
        pass
    return None, None


def log_shape(shape_log: Path | None, client: ModelClient, tag: str, *, prompt: str, judge: str, ref: str | None, arm: str, uid: str,
              info: dict, parse_ok: bool, keys: dict) -> None:
    """One line per reply to judge-shapes.jsonl. Shapes and counts only: no reply text, no prompt text."""
    if not shape_log:
        return
    out, stop = last_usage(client, tag)
    rec = {"prompt": prompt, "judge": judge, "ref": ref, "arm": arm, "uid_hash": uid_hash(uid), "out_tokens": out, "stop_reason": stop,
           "leading_chars": info["leading_chars"], "trailing_chars": info["trailing_chars"], "fenced": info["fenced"],
           "n_spans": info["n_spans"], "tolerated": info["tolerated"], "parse_ok": parse_ok,
           "missing_keys": keys["missing_keys"], "extra_keys": keys["extra_keys"]}
    p = Path(shape_log)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


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
               cache_dir: Path, render_version: str, shape_log: Path | None = None) -> dict:
    """One blinded call (plus one retry on a parse failure). Returns {scores|None, parse_failure, tolerated, cached, note_id}.
    `arm` is for the shape log only; neither the cache key nor the prompt carries it, so identical notes share one judgement.
    Only a parsed result is cached, so a rerun retries every failure."""
    nid = note_id(uid, note)
    key = (uid, judge, ref, frozen.pdqi9_sha(ref), hashlib.sha256(note.encode()).hexdigest(), render_version,
           hashlib.sha256(transcript.encode()).hexdigest() if ref == "transcript" else "")
    cp = cache_path(cache_dir, *key)
    if cp.exists():
        c = json.loads(cp.read_text(encoding="utf-8"))
        if not c.get("parse_failure"):  # an old-format failure record is a miss: re-call, overwrite only on success
            return {**c, "cached": True}
    system, user = build_prompt(frozen, ref, nid, note, transcript)
    rec = {"note_id": nid, "scores": None, "item_names": None, "parse_failure": True, "tolerated": False, "attempts": 0}
    for attempt in (1, 2):
        rec["attempts"] = attempt
        tag = f"pdqi9-v3:{judge}-{ref}:{uid}"
        parsed, info, diff = parse_scores_ex(client.chat(judge, user, system, max_tokens=1500, temperature=0.0, tag=tag))
        log_shape(shape_log, client, tag, prompt="pdqi9-v3", judge=judge, ref=ref, arm=arm, uid=uid, info=info, parse_ok=parsed is not None, keys=diff)
        if parsed:
            rec.update(scores=parsed[0], item_names=parsed[1], parse_failure=False, tolerated=info["tolerated"])
            break
    if not rec["parse_failure"]:
        _write_private(cp, rec)
    return {**rec, "cached": False}
