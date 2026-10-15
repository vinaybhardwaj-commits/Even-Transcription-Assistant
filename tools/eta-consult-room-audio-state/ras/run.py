"""Shadow run: classify every room, write JSONL per room-day under ~/eta-data/consult/audio-state/."""
import json, os, sys, collections
from .classify import build_chunks, classify_room, annotate_session_end, parse_ts, ist_day, VERSION
from .scan import CACHE, VI_CACHE, is_blind
from .hosts import macos26_rooms
from .blind import blind_room_days

TAPES = os.path.expanduser("~/eta-data/tapes")
PULL_LAG_S = 900.0
OUT = os.path.expanduser("~/eta-data/consult/audio-state")


def load_vi(path):
    vi = {}
    if os.path.exists(path):
        for l in open(path):
            x = json.loads(l)
            if "error" not in x:
                vi[x["id"]] = x
    return vi


def run(feat_path=CACHE, out=OUT, blind=None, vi_path=VI_CACHE, vi_rooms=None):
    blind = blind_room_days() if blind is None else blind
    feats = {}
    for l in open(feat_path):
        x = json.loads(l)
        feats[x["id"]] = x
    vi = load_vi(vi_path)
    vi_rooms = macos26_rooms() if vi_rooms is None else vi_rooms
    rows = collections.defaultdict(list)
    for l in open(os.path.join(TAPES, "manifest.jsonl")):
        r = json.loads(l)
        rows[r["room_id"]].append(r)
    os.makedirs(out, mode=0o700, exist_ok=True)
    os.chmod(out, 0o700)
    # blind room-days never reach the classifier as chunks; their manifest timing only sets the room's first day
    first = {room: min(ist_day(parse_ts(r["started_at"])) for r in rs) for room, rs in rows.items()}
    built = {room: build_chunks([r for r in rs if not is_blind(r, blind)], feats, vi) for room, rs in sorted(rows.items())}
    snapshot_end = max(c["end"] for cs in built.values() for c in cs)
    last_day = ist_day(snapshot_end)
    edge = snapshot_end - PULL_LAG_S   # unobserved starts at the data edge minus pull lag, never earlier than a room's last chunk
    per_room = {}
    for room, cs in built.items():
        bd = {d for (r, d) in blind if r == room}
        per_room[room] = (cs, classify_room(cs, first_day=first[room], last_day=last_day, blind_days=bd,
                                            cutoff=max(cs[-1]["end"] if cs else 0.0, edge),
                                            vi_enabled=room in vi_rooms))
    annotate_session_end(per_room)
    for fn in os.listdir(out):  # drop stale files from an earlier classifier version
        if fn.startswith("room_") and fn.endswith(".jsonl") and os.path.isfile(os.path.join(out, fn)):
            os.remove(os.path.join(out, fn))
    allint = {}
    for room, (_, ivs) in per_room.items():
        byday = collections.defaultdict(list)
        for iv in ivs:
            byday[iv["ist_day"]].append(iv)
        for day, lst in byday.items():
            fn = os.path.join(out, f"{room}_{day}.jsonl")
            with open(fn, "w") as f:
                for iv in lst:
                    rec = {"room_id": room, "ist_day": day, "state": iv["state"], "ts_start": iv["ts_start"],
                           "ts_end": iv["ts_end"], "evidence": iv["evidence"], "classifier_version": VERSION}
                    f.write(json.dumps(rec) + "\n")
            os.chmod(fn, 0o600)
        allint[room] = ivs
    return allint
