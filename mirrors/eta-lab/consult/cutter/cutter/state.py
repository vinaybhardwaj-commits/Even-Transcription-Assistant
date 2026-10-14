"""Why a window has no tape: reasons from room_audio_state (the ras writer's table): no_session / device_missing / power, else no_tape_unexplained. Read-only."""
from . import config as C
SQL = ("SELECT state, evidence, least(ts_end, %(b)s) - greatest(ts_start, %(a)s) AS overlap FROM room_audio_state "
       "WHERE room_id = %(room)s AND ts_end > %(a)s AND ts_start < %(b)s ORDER BY overlap DESC")

def reason_from_rows(rows):
    """rows: [(state, evidence dict, overlap)] dominant first. power if the evidence cause says so, device_missing, recorder_off -> no_session."""
    if not rows: return "no_tape_unexplained"
    state, ev = rows[0][0], (rows[0][1] or {})
    cause = ev.get("cause") if isinstance(ev, dict) else None
    if cause in ("power", "usb_power"): return "power"
    if state == "device_missing": return "device_missing"
    if state == "recorder_off": return "no_session"
    return f"no_tape_unexplained({state})"

def no_tape_reason(room_id, a, b, loader=None):
    import datetime as dt
    ta, tb = (dt.datetime.fromtimestamp(x, dt.timezone.utc) for x in (a, b))
    if loader is not None: return reason_from_rows(loader(SQL, dict(room=room_id, a=ta, b=tb)))
    from . import db
    with db.connect() as c:
        return reason_from_rows([(r[0], r[1], r[2]) for r in c.execute(SQL, dict(room=room_id, a=ta, b=tb)).fetchall()])
