"""Validate the model's final report: summary_md and items. Drops anything that fails the phi guard or the contract."""
from __future__ import annotations
import re
import uuid

from . import config, phi, tools

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _clean_args(t: str, args: dict) -> dict:
    out = {}
    for k, v in (args or {}).items():
        if k in ("consult_uid", "room_id", "room"):
            if isinstance(v, str) and ID_RE.match(v):
                out[k] = v
        elif k in ("date", "ist_date"):
            if isinstance(v, str) and DATE_RE.match(v):
                out[k] = v
        elif k == "lane":
            if v in config.LANES:
                out[k] = v
    return out


def slug_check(text: str, slugs: set[str], labels: set[str]) -> str:
    """Reject text containing a room slug (a slug is never a label)."""
    low = text.lower()
    for s in slugs:
        if s.lower() in low and s not in labels:
            raise phi.PhiGuardError("slug")
    return text


def validate(report: dict) -> tuple[str, list[dict], list[str]]:
    """Returns (summary_md, items, dropped_reasons). Summary that fails the guard raises."""
    slugs, labels = tools.known_slugs(), set(tools.room_labels().values())
    summary = str(report.get("summary_md", "")).strip()
    phi.check(summary)
    slug_check(summary, slugs, labels)
    items, dropped = [], []
    raw = report.get("findings") or report.get("items") or []
    if isinstance(raw, str):  # the model sometimes sends the array as a JSON string
        import json
        try:
            raw = json.loads(raw)
        except ValueError:
            dropped.append("items_not_json")
            raw = []
    if not isinstance(raw, list):
        dropped.append(f"items_type_{type(raw).__name__}")
        raw = []
    for it in raw[:30]:
        try:
            kind = it.get("kind")
            if kind not in config.ITEM_KINDS:
                raise ValueError("kind")
            title, body = str(it.get("title", ""))[:200], str(it.get("body_md", ""))[:2000]
            if not title:
                raise ValueError("title")
            phi.check(title)
            phi.check(body)
            slug_check(title + " " + body, slugs, labels)
            pa = it.get("proposed_action")
            if pa is not None:
                if kind == "question":
                    pa = None
                elif pa.get("type") not in config.ALLOWED_ACTIONS:
                    raise ValueError("action")
            if pa is not None:
                pa = {"type": pa["type"], "args": _clean_args(pa["type"], pa.get("args") or {})}
            ist_date = it.get("ist_date")
            room = it.get("room_id")
            uid = it.get("consult_uid")
            items.append({
                "id": str(uuid.uuid4()), "kind": kind,
                "ist_date": ist_date if isinstance(ist_date, str) and DATE_RE.match(ist_date) else None,
                "room_id": room if isinstance(room, str) and ID_RE.match(room) else None,
                "consult_uid": uid if isinstance(uid, str) and ID_RE.match(uid) else None,
                "title": title, "body_md": body, "proposed_action": pa, "state": "open"})
        except (phi.PhiGuardError, ValueError, AttributeError, KeyError) as e:
            dropped.append(f"{type(e).__name__}:{e}")
    return summary, items, dropped
