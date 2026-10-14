"""Closed consult windows from Neon eta_encounter_windows (READ-ONLY: SET default_transaction_read_only = on; the credential is read from a file and never printed or logged)."""
import datetime as dt, json, os
from . import config as C

COLS = ("id, consult_uid, machine, room_id, room_slug, t_open, t_close, close_reason, quality, resolver_version, computed_at, "
        "warehouse_doctor_uid, warehouse_doctor_name, consulting_doctor_uid, consulting_doctor_name, doctor_uid, display_name")
SQL = f"SELECT {COLS} FROM eta_encounter_windows WHERE t_open >= %s ORDER BY room_id, t_open, id"
ts = lambda d: None if d is None else d.timestamp()

def to_window(r):
    """DB row (dict) -> window dict (epoch seconds). Doctor identity = warehouse_doctor_uid, else consulting_doctor_uid."""
    doc = r.get("warehouse_doctor_uid") or r.get("consulting_doctor_uid")
    name = r.get("warehouse_doctor_name") if r.get("warehouse_doctor_uid") else r.get("consulting_doctor_name")
    return dict(id=r["id"], consult_uid=r["consult_uid"], machine=r["machine"], room_id=r["room_id"], room_slug=r["room_slug"], t_open=ts(r["t_open"]), t_close=ts(r["t_close"]),
                close_reason=r["close_reason"], quality=r["quality"], resolver_version=r["resolver_version"], computed_at=None if r["computed_at"] is None else r["computed_at"].isoformat(),
                doctor_uid=doc, doctor_name=name, doctor_source="warehouse_doctor_uid" if r.get("warehouse_doctor_uid") else ("consulting_doctor_uid" if doc else None))

def fetch(since_epoch, loader=None):
    """-> list of window dicts with t_open >= since_epoch. loader(sql, params) -> list of dict rows, injectable for tests."""
    since = dt.datetime.fromtimestamp(since_epoch, dt.timezone.utc)
    if loader is not None: rows = loader(SQL, (since,))
    else:
        from psycopg.rows import dict_row
        from . import db
        with db.connect(row_factory=dict_row) as c:
            rows = c.execute(SQL, (since,)).fetchall()
    return [to_window(r) for r in rows]

def by_room(windows):
    out = {}
    for w in windows: out.setdefault(w["room_id"], []).append(w)
    return out

FILE_KEYS = ("id", "consult_uid", "machine", "room_id", "room_slug", "t_open", "t_close", "close_reason", "quality", "resolver_version", "computed_at", "doctor_uid", "doctor_name", "doctor_source")
FILE_EXTRA = ("boundary_source", "room_source", "pqm_step_uid", "prio", "flags", "room_confidence", "pqm_called", "pqm_completed")                            # m3-17: only on file windows; the hourly (Neon) windows never carry them

def load_file(path):
    """m3-17: windows from a JSONL file (one window per line, the SAME shape as to_window: epoch-second t_open / t_close, plus the optional FILE_EXTRA keys). Fails loudly (ValueError) on a bad line,
    a missing key, a non-numeric or non-increasing time, or a duplicate id / consult_uid: a half-read input must not turn into a partial run."""
    out, ids, uids = [], set(), set()
    for n, l in enumerate(open(path), 1):
        if not l.strip(): continue
        try: w = json.loads(l)
        except ValueError: raise ValueError(f"{path}:{n}: not JSON")
        if not isinstance(w, dict): raise ValueError(f"{path}:{n}: not an object")
        miss = [k for k in FILE_KEYS if k not in w]
        if miss: raise ValueError(f"{path}:{n}: missing {miss}")
        extra = sorted(set(w) - set(FILE_KEYS) - set(FILE_EXTRA))
        if extra: raise ValueError(f"{path}:{n}: unknown keys {extra}")
        for k in ("t_open", "t_close"):
            if isinstance(w[k], bool) or not isinstance(w[k], (int, float)): raise ValueError(f"{path}:{n}: {k} must be epoch seconds")
        if not w["t_close"] > w["t_open"]: raise ValueError(f"{path}:{n}: t_close must be after t_open")
        if w["id"] in ids or w["consult_uid"] in uids: raise ValueError(f"{path}:{n}: duplicate id or consult_uid")
        ids.add(w["id"]); uids.add(w["consult_uid"]); out.append(w)
    return out
