"""room_windows.py: create the manifest-only ROOM WINDOWS for IST days after the hist windows end (ORDERS-PALIMPSEST-15A, architect rulings R1 #11556).

Why: the encounter layer (kit/reb/encounter.py) attaches one track to every room-window manifest of a day. Room windows were only ever made by the hist conversion (from_hist), which stopped after
7 Oct; since 8 Oct nothing created them, so the encounter step enumerated 0 windows. This job makes them from the TAPE MANIFEST (the lab mover's record of every primary room-tape chunk).

For every room and every IST 15-minute slot that a primary tape chunk of that room overlaps, on a PAST IST day (not today) from FIRST_DATE (2026-10-08) onward:
  window_id  c-<ist_date>_<room_id>_<HHMM>   (HHMM = the slot's IST start, as the hist windows)
  manifest   written with writer.write_manifest (create-only: an existing manifest is never touched; no index.jsonl line until a track is written), source_kind room_tape, clock tape_utc,
             t0_ms/t1_ms = the slot, audio {r2_key "tape:<room_id>", sha256 = sha256 of the sorted lines "<chunk r2_key> <size_bytes> <chunk sha256>" of the overlapping chunks (real and deterministic:
             it changes only if the set of chunks changes), sample_rate 0, duration_ms 900000, extras {n_chunks, covered_fraction, created_by "room_windows"}}.
  A slot that already has ANY window of that room-day overlapping it (a hist window, an orphan window) gets none (counted exists_overlap): never a second window for a slot.
The windows exist for the encounter layer and the viewer timeline. NO lane runs on them: window_lanes needs explicit window ids, and the S2 driver's census stops before 2026-10-02.
The held-out guard (from_hist.load_heldout, fail closed) is applied to every slot. Dry run by default (counts only). Idempotent.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
import sys

from . import sarvam_lane as sl
from . import writer
from .from_hist import IST, SEALED_WINDOWS, load_heldout, window_held

FIRST_DATE = "2026-10-08"
SLOT_MS = 15 * 60 * 1000
ROOM_LABELS = "/home/eta/oc/palimpsest/in/room-labels.json"
COUNTERS = ("chunks", "slots", "created", "would_create", "exists", "exists_overlap", "today_skipped", "before_first", "blind_refused", "sealed", "bad_chunk", "errors")


def iso_ms(s):
    return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def ist_date(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, IST).strftime("%Y-%m-%d")


def hhmm(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, IST).strftime("%H%M")


def load_chunks(tapes_manifest, cnt=None):
    """-> {room_id: [(start_ms, end_ms, r2_key, size, sha256)]} of the primary chunks. A malformed row is counted and skipped."""
    out = collections.defaultdict(list)
    for l in open(tapes_manifest):
        if not l.strip():
            continue
        try:
            r = json.loads(l)
            if r.get("source", "primary") != "primary":
                continue
            s = iso_ms(r["started_at"])
            out[r["room_id"]].append((s, s + int(r["duration_ms"]), str(r["r2_key"]), int(r["size_bytes"]), str(r["sha256"])))
        except (ValueError, KeyError, TypeError):
            if cnt is not None:
                cnt["bad_chunk"] += 1
    return out


def slots_of(chunks):
    """{slot_t0_ms: [chunks overlapping the slot]} for one room's chunks (slots are IST quarter-hours, which are also UTC quarter-hours)."""
    slots = collections.defaultdict(list)
    for c in chunks:
        t = (c[0] // SLOT_MS) * SLOT_MS
        while t < c[1]:
            slots[t].append(c)
            t += SLOT_MS
    return slots


def audio_sha(chunks):
    lines = sorted(f"{c[2]} {c[3]} {c[4]}" for c in chunks)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def covered_ms(chunks, t0, t1):
    iv = sorted((max(c[0], t0), min(c[1], t1)) for c in chunks if min(c[1], t1) > max(c[0], t0))
    tot, end = 0, None
    for a, b in iv:
        if end is None or a > end:
            tot += b - a
            end = b
        elif b > end:
            tot += b - end
            end = b
    return tot


def existing_spans(root, date, room):
    """The spans of every window manifest already in <root>/<date>/<room>/ (consult scopes under _consults are not room windows)."""
    d = os.path.join(root, date, room)
    out = []
    if os.path.isdir(d):
        for w in os.listdir(d):
            mp = os.path.join(d, w, "manifest.json")
            if not w.startswith("_") and os.path.exists(mp):
                try:
                    m = json.load(open(mp))
                    out.append((int(m["t0_ms"]), int(m["t1_ms"])))
                except (ValueError, KeyError, OSError):
                    pass
    return out


def make(root=None, tapes_manifest=None, write=False, today=None, first=FIRST_DATE, is_held=None, labels=None, dates=None):
    """-> counters (+ per_day {date: {"slots", "created"}}). Past IST days only."""
    root = root or sl.REB_ROOT
    tapes_manifest = tapes_manifest or os.path.join(sl.TAPES, "manifest.jsonl")
    today = today or datetime.datetime.now(IST).strftime("%Y-%m-%d")
    is_held = is_held or load_heldout()   # fail closed
    labels = labels if labels is not None else _labels()
    cnt = collections.Counter({k: 0 for k in COUNTERS})
    per_day = collections.defaultdict(lambda: collections.Counter())
    by_room = load_chunks(tapes_manifest, cnt)
    cnt["chunks"] = sum(len(v) for v in by_room.values())
    cache = {}
    for room, chunks in sorted(by_room.items()):
        for t0, cs in sorted(slots_of(chunks).items()):
            t1 = t0 + SLOT_MS
            date = ist_date(t0)
            cnt["slots"] += 1
            if date >= today:
                cnt["today_skipped"] += 1
                continue
            if date < first or (dates and date not in dates):
                cnt["before_first"] += 1
                continue
            wid = f"c-{date}_{room}_{hhmm(t0)}"
            if wid in SEALED_WINDOWS:
                cnt["sealed"] += 1
                continue
            if is_held(date, room) or window_held(is_held, room, t0, t1):
                cnt["blind_refused"] += 1
                continue
            if (date, room) not in cache:
                cache[(date, room)] = existing_spans(root, date, room)
            if os.path.exists(os.path.join(writer._window_dir(root, date, room, wid), "manifest.json")):
                cnt["exists"] += 1
                continue
            if any(a < t1 and b > t0 for a, b in cache[(date, room)]):
                cnt["exists_overlap"] += 1
                continue
            per_day[date]["slots"] += 1
            if not write:
                cnt["would_create"] += 1
                continue
            stub = {"window_id": wid, "room_id": room, "room_slug": labels.get(room, room), "ist_date": date, "t0_ms": t0, "t1_ms": t1, "clock": "tape_utc", "source_kind": "room_tape",
                    "audio": {"r2_key": f"tape:{room}", "sha256": audio_sha(cs), "sample_rate": 0, "duration_ms": SLOT_MS,
                              "extras": {"n_chunks": len(cs), "covered_fraction": round(covered_ms(cs, t0, t1) / SLOT_MS, 4), "created_by": "room_windows"}}}
            try:
                made = writer.write_manifest(root, date, room, wid, stub)
            except Exception:  # noqa: BLE001 - one bad slot never stops the run; counted
                cnt["errors"] += 1
                continue
            cnt["created" if made else "exists"] += 1
            if made:
                per_day[date]["created"] += 1
                cache[(date, room)].append((t0, t1))
    out = dict(cnt)
    out["per_day"] = {d: dict(c) for d, c in sorted(per_day.items())}
    return out


def _labels():
    try:
        return {r["room_id"]: r["label"] for r in json.load(open(ROOM_LABELS))["rooms"]}
    except (OSError, ValueError, KeyError):
        return {}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write", action="store_true", help="create the manifests (default: a dry run that counts)")
    ap.add_argument("--root")
    ap.add_argument("--first", default=FIRST_DATE, help="first IST date to make windows for (default 2026-10-08)")
    ap.add_argument("--date", action="append", help="only these IST dates (repeatable)")
    a = ap.parse_args(argv)
    res = make(a.root, write=a.write, first=a.first, dates=set(a.date) if a.date else None)
    print("room_windows " + ("write " if a.write else "dry-run ") + json.dumps(res, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
