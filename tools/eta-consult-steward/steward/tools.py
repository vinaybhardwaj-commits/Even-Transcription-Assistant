"""Read-only tools. They return ids, counts and times only. No transcript text, no names.

Every returned field is on an allowlist. Index rows carry doctor_name; it is never copied out.
"""
from __future__ import annotations
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config

IST = timezone(timedelta(hours=5, minutes=30))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_ROWS = 60

INDEX_FIELDS = ("consult_uid", "ist_date", "room_id", "status", "boundary_source", "room_source",
                "minutes", "coverage", "close_reason", "quality", "flags", "voice_isolated", "doctor_identified",
                "doctor_split_failed", "pqm_step_uid", "span_start", "span_end", "cut_at")  # allowlist; values sanitised


CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")          # enum-style code, e.g. url_clear
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([+-]\d{2}:?\d{2}|Z)?$")
UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CODE_FIELDS = ("status", "boundary_source", "room_source", "close_reason", "quality")
TS_FIELDS = ("span_start", "span_end", "cut_at", "ts")
ID_FIELDS = ("consult_uid", "room_id", "pqm_step_uid")


ENUMS = {
    "status": {"cut", "skipped", "error", "deferred_long", "deferred", "planned", "ok", "warn", "alert", "nodata"},
    "boundary_source": {"pqm", "pulse", "hyp", "refined"},
    "room_source": {"schedule", "voice"},
    "close_reason": {"url_clear", "endConsult", "cap_90m", "next_open", "idle_timeout", "pqm"},
    "quality": {"unattributed", "clean", "multi_doctor", "unclosed", "suspect", "pqm"},
    "flags": {"start_at_tape_start", "start_at_previous_window_close", "end_capped_next_window", "search_tape_truncated",
              "end_floor_t_close", "end_capped_search", "end_estimated", "doctor_like_group", "doctor_cos_borderline",
              "doctor_split_failed", "tape_truncated", "search_capped_next_window", "pqm_timeout_3600"},
    "r2_status": {"mirrored", "pending", "pending_mirror", "pending_no_credential", "failed", "skipped"},
    # alert codes known from the cutter and relay; anything else is dropped (alerts are free text upstream)
    "alert": {"stall", "row_stuck", "r2_row_stuck", "r2_mirror_stalled", "r2_mirror_skipped", "prints_invalid",
              "dead_letter", "cutter_aborted", "mirror_stalled", "info", "warn", "warning", "alert", "error", "critical"},
}
ENUM_ALL = set().union(*ENUMS.values())


def enum(kind: str, v):
    """Only known enum values for that field pass; any other string is dropped."""
    return v if isinstance(v, str) and v in ENUMS.get(kind, ()) else None


def code(v):
    """Any known enum value from any field, else None (used where the field is not known, e.g. recon strings)."""
    return v if isinstance(v, str) and v in ENUM_ALL else None


def safe_scalar(k: str, v):
    if k in ID_FIELDS:
        return v if isinstance(v, str) and UID_RE.match(v) else None
    if k == "ist_date":
        return v if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", v) else None
    if k in TS_FIELDS:
        return v if isinstance(v, str) and TS_RE.match(v) else None
    if k in CODE_FIELDS:
        return enum(k, v)
    if k == "flags":
        return [c for c in (v if isinstance(v, list) else [])[:20] if enum("flags", c)]
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    return None


class ToolError(ValueError):
    pass


def _date(d: str) -> str:
    if not isinstance(d, str) or not DATE_RE.match(d):
        raise ToolError("date must be YYYY-MM-DD")
    return d


LABEL_RE = re.compile(r"^[A-Za-z0-9_ ()-]{1,40}$")


def _room(x: str) -> str:
    if not isinstance(x, str) or not LABEL_RE.match(x):
        raise ToolError("bad room")
    return x


def _id(x: str, what: str = "id") -> str:
    if not isinstance(x, str) or not ID_RE.match(x):
        raise ToolError(f"bad {what}")
    return x


def _load_index() -> dict[str, dict]:
    """Latest row per consult_uid wins (the index is append-only)."""
    p = config.index_path()
    rows: dict[str, dict] = {}
    if not p.exists():
        return rows
    with open(p) as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            uid = r.get("consult_uid")
            if uid:
                rows[uid] = r
    return rows


def room_labels() -> dict[str, str]:
    """room_id -> label ("OPD 5"). Read each call (small file)."""
    try:
        d = json.load(open(config.room_labels_path()))
        return {r["room_id"]: r["label"] for r in d.get("rooms", [])}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def label_of(room_id: str | None) -> str:
    if not room_id:
        return "no room"
    return room_labels().get(room_id) or f"unlisted room {room_id}"


def known_slugs() -> set[str]:
    """Every room slug in the index. Used by the output guard; never shown to the model."""
    return {r["room_slug"] for r in _load_index().values() if r.get("room_slug")}


def resolve_room(room: str) -> set[str]:
    """Accept a room_id, a label ("OPD 5") or a slug; return the matching room_ids."""
    ids = {room}
    low = room.strip().lower()
    for rid, lab in room_labels().items():
        if lab.lower() == low:
            ids.add(rid)
    for r in _load_index().values():
        if r.get("room_slug") == room and r.get("room_id"):
            ids.add(r["room_id"])
    return ids


def _clean(r: dict) -> dict:
    o = {}
    for k in INDEX_FIELDS:
        if k in r:
            v = safe_scalar(k, r[k])
            if v is not None:
                o[k] = v
    o["room_label"] = label_of(r.get("room_id"))
    r2 = r.get("r2")
    if isinstance(r2, dict):
        o["r2_status"] = enum("r2_status", r2.get("status"))
    return o


def _match_room(r: dict, ids: set[str] | None) -> bool:
    return not ids or r.get("room_id") in ids


def index_query(room: str | None = None, date: str | None = None, status: str | None = None) -> dict:
    if date:
        _date(date)
    ids = None
    if room:
        ids = resolve_room(_room(room))
    if status:
        _id(status, "status")
    rows = [r for r in _load_index().values()
            if _match_room(r, ids) and (not date or r.get("ist_date") == date) and (not status or r.get("status") == status)]
    rows.sort(key=lambda r: (r.get("span_start") or "", r.get("consult_uid") or ""))
    by_status = Counter(enum("status", r.get("status")) or "other" for r in rows)
    by_room = Counter(f"{label_of(r.get('room_id'))} ({r.get('room_id')})" for r in rows)
    return {"total": len(rows), "by_status": dict(by_status), "by_room": dict(by_room),
            "truncated": len(rows) > MAX_ROWS, "rows": [_clean(r) for r in rows[:MAX_ROWS]]}


def _encounters(date: str) -> list[dict]:
    p = config.encounters_path(date)
    if not p.exists():
        return []
    try:
        d = json.load(open(p))
    except ValueError:
        return []
    return d.get("encounters", []) if isinstance(d, dict) else []


def recon_get(date: str) -> dict:
    """The daily_recon output when present; otherwise a read-only reconstruction from the index and encounters.json."""
    _date(date)
    p = config.recon_dir() / f"{date}.json"
    if p.exists():
        try:
            return {"source": "recon", "date": date, "recon": _strip_recon(json.load(open(p)))}
        except ValueError:
            pass
    idx = [r for r in _load_index().values() if r.get("ist_date") == date]
    enc = _encounters(date)
    rooms: dict[str, dict] = {}
    for e in enc:
        k = e.get("room_id") or "unplaced"
        d = rooms.setdefault(k, {"visits": 0, "placed": 0, "cut": 0, "skipped": 0, "deferred": 0, "other": 0})
        d["visits"] += 1
        if e.get("room_id"):
            d["placed"] += 1
    for r in idx:
        k = r.get("room_id") or "unplaced"
        d = rooms.setdefault(k, {"visits": 0, "placed": 0, "cut": 0, "skipped": 0, "deferred": 0, "other": 0})
        s = r.get("status") or "other"
        key = "deferred" if s.startswith("deferred") else s if s in ("cut", "skipped") else "other"
        d[key] += 1
    for k, d in rooms.items():
        d["room_label"] = label_of(k) if k != "unplaced" else "unplaced (no room)"
    return {"source": "fallback_index_encounters", "date": date, "encounters_file": bool(enc),
            "index_rows": len(idx), "rooms": rooms}


RECON_KEYS = {"date", "ist_date", "version", "source", "computed_at", "rooms", "rows", "counts", "visits", "placed", "isolated",
              "isolated_pulse", "isolated_pqm", "not_isolated", "lane_sarvam", "lane_nemotron", "lane_role", "lane_parts",
              "rx_matched", "tape_hours", "status", "alerts", "code", "count", "cut", "skipped", "deferred", "other",
              "room_id", "total"}
ROOM_KEY_RE = re.compile(r"^room_[a-z0-9]{1,16}$")


def _strip_recon(obj, depth=0):
    """Allowlist: only known keys survive; strings must be enum codes, timestamps or room ids; no free text."""
    if depth > 6:
        return None
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in RECON_KEYS or ROOM_KEY_RE.match(str(k)) or re.match(r"^\d{4}-\d{2}-\d{2}$", str(k)):
                out[k] = _strip_recon(v, depth + 1)
        if "room_id" in out and isinstance(out["room_id"], str):
            out["room_label"] = label_of(out["room_id"])
        return out
    if isinstance(obj, list):
        return [_strip_recon(v, depth + 1) for v in obj[:MAX_ROWS]]
    if isinstance(obj, str):
        if code(obj) or TS_RE.match(obj) or ROOM_KEY_RE.match(obj) or re.match(r"^v?\d+(\.\d+){0,3}$", obj):
            return obj
        return "[omitted]"
    if isinstance(obj, (bool, int, float)) or obj is None:
        return obj
    return None


def lanes_for(consult_uid: str) -> dict:
    """Which lane artefacts exist for one consult. File presence only."""
    _id(consult_uid, "consult_uid")
    r = _load_index().get(consult_uid)
    if not r:
        return {"consult_uid": consult_uid, "found": False}
    d = config.clips_root() / (r.get("path") or "__none__")
    names = ("consult.flac", "doctor.flac", "others.flac", "timeline.json")
    present = {n: (d / n).exists() for n in names}
    out = {"consult_uid": consult_uid, "found": True, "status": enum("status", r.get("status")), "room_label": label_of(r.get("room_id")), "files": present,
           "r2_status": enum("r2_status", (r.get("r2") or {}).get("status"))}
    return out


def _ist_date_of(started_at: str) -> str | None:
    try:
        dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.astimezone(IST).strftime("%Y-%m-%d")


def tape_hours(room: str, date: str) -> dict:
    _date(date)
    _room(room)
    p = config.tapes_manifest()
    if not p.exists():
        return {"room": room, "date": date, "chunks": 0, "hours": 0.0, "manifest": False}
    # slug -> id via the index
    ids = resolve_room(room)
    ms = 0
    n = 0
    with open(p) as f:
        for line in f:
            try:
                c = json.loads(line)
            except ValueError:
                continue
            if c.get("room_id") in ids and _ist_date_of(c.get("started_at", "")) == date:
                ms += int(c.get("duration_ms") or 0)
                n += 1
    return {"room": room, "room_label": label_of(next(iter(ids & set(room_labels())), room)), "date": date, "chunks": n, "hours": round(ms / 3.6e6, 2), "manifest": True}


ALERT_CODE_FIELDS = ("code", "kind", "level", "severity")


def alerts_tail(n: int = 20) -> dict:
    n = max(1, min(int(n), 100))
    p = config.alerts_path()
    if not p.exists():
        return {"present": False, "alerts": []}
    lines = p.read_text().splitlines()[-n:]
    out = []
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        a = {}
        for k in ALERT_CODE_FIELDS:
            if enum("alert", r.get(k)):
                a[k] = r[k]
        if isinstance(r.get("ts"), str) and TS_RE.match(r["ts"]):
            a["ts"] = r["ts"]
        for k in ("room_id", "consult_uid"):
            v = safe_scalar(k, r.get(k))
            if v:
                a[k] = v
                if k == "room_id":
                    a["room_label"] = label_of(v)
        if isinstance(r.get("count"), int) and not isinstance(r.get("count"), bool):
            a["count"] = r["count"]
        out.append(a)
    return {"present": True, "alerts": out}


REGISTRY = {
    "recon_get": (recon_get, "Daily recon for an IST date (YYYY-MM-DD): per-room counts. Ids and counts only.",
                  {"date": {"type": "string"}}, ["date"]),
    "index_query": (index_query, "Query the clip index. Filters room (room_id or label such as 'OPD 5'), date, status. Returns counts and id rows.",
                    {"room": {"type": "string"}, "date": {"type": "string"}, "status": {"type": "string"}}, []),
    "lanes_for": (lanes_for, "Lane artefact presence for one consult_uid.",
                  {"consult_uid": {"type": "string"}}, ["consult_uid"]),
    "tape_hours": (tape_hours, "Hours of room tape pulled for a room (room_id or label such as 'OPD 5') on an IST date.",
                   {"room": {"type": "string"}, "date": {"type": "string"}}, ["room", "date"]),
    "alerts_tail": (alerts_tail, "Last n consult alerts (codes, rooms, counts).",
                    {"n": {"type": "integer"}}, []),
}


def call(name: str, args: dict) -> dict:
    if name not in REGISTRY:
        raise ToolError(f"unknown tool {name}")
    try:
        return REGISTRY[name][0](**(args or {}))
    except TypeError as e:
        raise ToolError(str(e))


def tool_config() -> dict:
    tools = [{"toolSpec": {"name": n, "description": desc,
                           "inputSchema": {"json": {"type": "object", "properties": props, "required": req}}}}
             for n, (_, desc, props, req) in REGISTRY.items()]
    return {"tools": tools}
