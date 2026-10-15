"""device_missing from kiosk-health events (step 3). FIXTURE-DRIVEN until consult-lead confirms a read path.

Nothing here is wired into ras.run or ras_write: the production pipeline never emits device_missing, and nothing
writes it to Neon. `kiosk_health_events` is not readable by eta_audio_writer; no other credential may be used.

Event shape expected by this mapping (adjust to the real columns when the read path exists):
    {"id": str, "ts": epoch s, "type": "usb_removed" | "usb_added" | "audio.devices" | "audio.error" | other,
     "device": str (usb_*), "devices": [str] (audio.devices), "error": str, "detail": str (audio.error)}
Device names are matched EXACTLY (case-folded, whitespace-collapsed); a configured name must be non-empty.
"""
from .classify import FULL_MS, SLIVER_S, iso

NOT_FOUND = "input device not found"


def norm(name):
    return " ".join(str(name).casefold().split())


def _matches(name, configured):
    """Exact normalised device-name match. Never empty, never substring."""
    return bool(name) and norm(name) == norm(configured)


def _opens(ev, configured):
    if ev["type"] == "usb_removed":
        return _matches(ev.get("device"), configured)
    if ev["type"] == "audio.error":
        return ev.get("error") == "start_failure" and NOT_FOUND in str(ev.get("detail", "")).lower()
    return False


def _closes(ev, configured):
    if ev["type"] == "usb_added":
        return _matches(ev.get("device"), configured)
    if ev["type"] == "audio.devices":
        return any(_matches(d, configured) for d in (ev.get("devices") or []))
    return False


def _order(configured):
    """Deterministic order: by second, openers before closers before others, then id."""
    def key(ev):
        pri = 0 if _opens(ev, configured) else 1 if _closes(ev, configured) else 2
        return (ev["ts"], pri, str(ev["id"]))
    return key


def device_missing_spans(events, configured_device, full_chunk_starts=(), horizon=None):
    """Spans [open, close) in which the configured input device is missing. Each outage gets its own span.

    Opens on usb_removed of the configured device, or audio.error start_failure with "input device not found".
    Closes on usb_added of it, an audio.devices listing it again, or the recorder producing a full chunk
    (a chunk of at least FULL_MS starting after the open). The full-chunk close is checked first at every event, so
    an outage that starts after the recorder recovered opens a NEW span. A repeat opening event while the same
    outage is still open is added to that span's ids. A span that closes at its own opening second (removed and
    added together) is no outage and is dropped. An unclosed span ends at `horizon` (None = open-ended).
    -> [{"a", "b", "kh_event_ids", "closed_by"}]"""
    if not configured_device or not str(configured_device).strip():
        raise ValueError("configured input device must be a non-empty exact name")
    full = sorted(full_chunk_starts)
    spans, cur = [], None

    def close(at, ids, by):
        if at > cur["a"]:
            spans.append({"a": cur["a"], "b": at, "kh_event_ids": ids, "closed_by": by})

    for ev in sorted(events, key=_order(configured_device)):
        if cur is not None:
            chunk = next((x for x in full if x > cur["a"] and x <= ev["ts"]), None)
            if chunk is not None:
                close(chunk, cur["ids"], "full_chunk")
                cur = None
        if cur is None:
            if _opens(ev, configured_device):
                cur = {"a": ev["ts"], "ids": [ev["id"]]}
        elif _opens(ev, configured_device):
            cur["ids"].append(ev["id"])
        elif _closes(ev, configured_device):
            close(ev["ts"], cur["ids"] + [ev["id"]], ev["type"])
            cur = None
    if cur is not None:
        chunk = next((x for x in full if x > cur["a"]), None)
        if chunk is not None and (horizon is None or chunk <= horizon):
            close(chunk, cur["ids"], "full_chunk")
        else:
            spans.append({"a": cur["a"], "b": horizon, "kh_event_ids": cur["ids"], "closed_by": None})
    return spans


def full_chunk_starts(chunks):
    """Start times (epoch) of full-length chunks, from classify.build_chunks output."""
    return [c["start"] for c in chunks if c["manifest_ms"] >= FULL_MS]


def _pieces(iv, spans):
    """[(a, b, span | None)] covering the interval; missing pieces under SLIVER_S are dropped back to recorder_off
    and leftover slivers join a neighbour, so no piece is under SLIVER_S."""
    pieces = [(iv["_a"], iv["_b"], None)]
    for sp in spans:
        hi = float("inf") if sp["b"] is None else sp["b"]
        nxt = []
        for a, b, tag in pieces:
            if tag is not None or b <= sp["a"] or a >= hi:
                nxt.append((a, b, tag))
                continue
            if a < sp["a"]:
                nxt.append((a, sp["a"], None))
            nxt.append((max(a, sp["a"]), min(b, hi), sp))
            if b > hi:
                nxt.append((hi, b, None))
        pieces = nxt
    pieces = [[a, b, (None if t is not None and b - a < SLIVER_S else t)] for a, b, t in pieces]

    def coalesce(ps):
        out = []
        for p in ps:
            if out and out[-1][2] is p[2]:
                out[-1][1] = p[1]
            else:
                out.append(p)
        return out
    pieces = coalesce(pieces)
    while len(pieces) > 1:                     # remaining slivers are plain pieces; fold them into a neighbour
        k = next((k for k, p in enumerate(pieces) if p[1] - p[0] < SLIVER_S), None)
        if k is None:
            break
        p = pieces.pop(k)
        if k > 0:
            pieces[k - 1][1] = p[1]
        else:
            pieces[0][0] = p[0]
        pieces = coalesce(pieces)
    return pieces


def apply_device_missing(intervals, spans):
    """recorder_off intervals inside a span become device_missing (evidence.kh_event_ids). Other intervals are
    untouched. An interval that straddles a span edge is split. No resulting piece is under SLIVER_S."""
    out = []
    for iv in intervals:
        if iv["state"] != "recorder_off":
            out.append(iv)
            continue
        pieces = _pieces(iv, spans)
        if all(t is None for _, _, t in pieces):
            out.append(iv)
            continue
        for a, b, t in pieces:
            ev = dict(iv["evidence"])
            if t is None:
                if a > iv["_a"]:
                    ev.pop("session_end", None)       # a stop tag belongs to the interval's own start
                out.append({**iv, "_a": a, "_b": b, "ts_start": iso(a), "ts_end": iso(b), "evidence": ev})
            else:
                ev.pop("session_end", None)
                ev.update({"kh_event_ids": list(t["kh_event_ids"]), "kh_span_closed_by": t["closed_by"]})
                out.append({**iv, "state": "device_missing", "_a": a, "_b": b, "ts_start": iso(a), "ts_end": iso(b),
                            "evidence": ev})
    return out


# ---- real kiosk_health_events rows -> events ---------------------------------------------------------------

def _clock_suspect(row):
    p = row.get("payload") or {}
    return bool(row.get("_clock_suspect") or (isinstance(p, dict) and p.get("_clock_suspect")))


def _names(lst):
    return [d.get("name") for d in lst or [] if isinstance(d, dict) and d.get("name")]


PLANNED_INITIATORS = {"steward", "fleet", "scheduled", "operator", "update", "steward_restart", "fleet_restart",
                      "scheduled_restart", "operator_restart", "fleet_update"}
PLANNED_KINDS = {"restart_requested", "restart.requested", "steward.restart_requested", "fleet.restart_requested"}


def _planned(kind, p):
    """A row that says a restart was asked for (steward / fleet / scheduled), not a power loss. The initiator or reason
    must EQUAL one of PLANNED_INITIATORS (case and surrounding space folded); "unscheduled power loss" and
    "ups_update_failed" are not planned. UNVALIDATED: the real kiosk_health_events rows carry no such marker yet, so
    this only fires once the kiosk or steward writes one."""
    if not isinstance(p, dict):
        return False
    who = [str(p.get(k)).strip().casefold() for k in ("initiator", "restart_initiator", "reason") if p.get(k)]
    return bool(p.get("planned") is True or p.get("planned_restart") is True or any(w in PLANNED_INITIATORS for w in who)
                or str(kind).strip().casefold() in PLANNED_KINDS)


def normalise_rows(rows):
    """Real kiosk_health_events rows ({id, room_id, ts (datetime|epoch), boot_id, kind, payload}) -> {room: [event]}.

    Rows whose clock is suspect (`_clock_suspect` on the row or in the payload) are skipped. audio.devices rows give
    one usb_removed / usb_added event per listed device (payload.usb_removed / usb_added, each with a "name") plus an
    audio.devices event whose `devices` are the names in payload.devices and payload.usb_audio (None when both are
    null, so it closes nothing). audio.error keeps `error` ("start_failure" when payload.start_failure is true,
    else its class) and `detail`. recorder.status keeps `session_open` and `state`."""
    out = {}
    for r in rows:
        if _clock_suspect(r):
            continue
        p = r.get("payload") or {}
        ts = r["ts"].timestamp() if hasattr(r["ts"], "timestamp") else float(r["ts"])
        base = {"id": r["id"], "ts": ts, "boot_id": r.get("boot_id")}
        if _planned(r["kind"], p):
            base["planned_restart"] = True
        evs = out.setdefault(r["room_id"], [])
        kind = r["kind"]
        if kind == "audio.devices":
            for d in _names(p.get("usb_removed")):
                evs.append({**base, "type": "usb_removed", "device": d})
            for d in _names(p.get("usb_added")):
                evs.append({**base, "type": "usb_added", "device": d})
            names = None
            if p.get("devices") is not None or p.get("usb_audio") is not None:
                names = _names(p.get("devices")) + _names(p.get("usb_audio"))
            evs.append({**base, "type": "audio.devices", "devices": names})
        elif kind == "audio.error":
            evs.append({**base, "type": "audio.error", "error": "start_failure" if p.get("start_failure") else p.get("class"),
                        "detail": p.get("detail"),
                        "device": p.get("device") or p.get("device_name")})
        elif kind == "recorder.status":
            evs.append({**base, "type": "recorder.status", "session_open": p.get("session_open"), "state": p.get("state")})
        else:
            evs.append({**base, "type": kind})
    for evs in out.values():
        evs.sort(key=lambda e: (e["ts"], str(e["id"])))
    return out
