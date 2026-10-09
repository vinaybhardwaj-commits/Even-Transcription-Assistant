"""Closed consult windows from Neon eta_encounter_windows (READ-ONLY: SET default_transaction_read_only = on; the credential is read from a file and never printed or logged)."""
import datetime as dt, os
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
