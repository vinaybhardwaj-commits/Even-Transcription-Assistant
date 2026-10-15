"""consult_hold.py -- FR1 2.4 d' (Mini side): the per-room `consult_open` hold carried in the control line. Behind the flag consult_open_publish (default false).
Contract: ~/oc/herdr-lead/CONTROL-CONSULT-OPEN-SHAPE-15OCT.md. true = a consult window is open in that room (the kiosk never reboots); false = no open window.
FAIL CLOSED: a query error or timeout, data older than MAX_AGE_S, a room with no mapping, no data or an ambiguous mapping, all give true for the affected rooms.
Source: Target A eta_encounter_windows, read-only (the same Neon credential file the consult cutter uses, read by path, never printed). Every SQL string below is INFERRED."""
import json, os, threading, time

CACHE_S, MAX_AGE_S, QUERY_TIMEOUT_S, STUCK_S = 60, 120, 5, 1800
OPEN_UNCLOSED_MAX_S, OPEN_CLOSED_GRACE_S = 4 * 3600, 120     # Rooms Live rule (pulse-watch occupancy.mjs): unclosed within 4 h, or closed within the last 2 min
MAP_LOOKBACK_S = 30 * 86400
# INFERRED SQL (read-only session; parameters are timestamptz):
WIN_SQL = "SELECT room_slug, room_id, t_open, t_close FROM eta_encounter_windows WHERE room_slug IS NOT NULL AND t_open >= %s"
MAP_SQL = "SELECT DISTINCT room_slug, room_id FROM eta_encounter_windows WHERE room_slug IS NOT NULL AND t_open >= %s"
DEFAULT_URL_FILE = "~/.config/eta-audio/db.url"


def _epoch(v):
    return None if v is None else (v.timestamp() if hasattr(v, "timestamp") else float(v))


def pg_loader(url_file=None, timeout=QUERY_TIMEOUT_S):
    """-> loader(now) returning (windows, known): windows = [(room_slug, room_id, t_open_epoch, t_close_epoch|None)], known = [(room_slug, room_id)].
    Read-only at connect time; the credential file is read here and never logged."""
    import datetime as dt
    path = os.path.expanduser(url_file or DEFAULT_URL_FILE)

    def load(now):
        import psycopg
        with open(path) as f:
            url = f.read().strip()
        c = psycopg.connect(url, connect_timeout=timeout, options=f"-c default_transaction_read_only=on -c statement_timeout={int(timeout * 1000)}")
        try:
            c.read_only = True
            utc = dt.timezone.utc
            w = c.execute(WIN_SQL, (dt.datetime.fromtimestamp(now - OPEN_UNCLOSED_MAX_S, utc),)).fetchall()
            m = c.execute(MAP_SQL, (dt.datetime.fromtimestamp(now - MAP_LOOKBACK_S, utc),)).fetchall()
        finally:
            c.close()
        return [(r[0], r[1], _epoch(r[2]), _epoch(r[3])) for r in w], [(r[0], r[1]) for r in m]
    return load


def window_open(t_open, t_close, now):
    if t_open is None:
        return True                                   # an unreadable row cannot show the room is free
    if t_open > now:
        return True
    if t_close is None:
        return now - t_open <= OPEN_UNCLOSED_MAX_S
    return now - t_close <= OPEN_CLOSED_GRACE_S


class ConsultHold:
    def __init__(self, rooms, room_map, loader, clock=time.time, audit_path=None, sink=None, cache_s=CACHE_S, max_age_s=MAX_AGE_S, timeout_s=QUERY_TIMEOUT_S,
                 stuck_s=STUCK_S):
        self.rooms, self.map, self.loader, self.clock, self.audit_path, self.sink = list(rooms), dict(room_map or {}), loader, clock, audit_path, sink
        self.cache_s, self.max_age_s, self.timeout_s, self.stuck_s = cache_s, max_age_s, timeout_s, stuck_s
        self.data = None                  # (windows, known, fetched_at) of the last good fetch
        self.tried_at = None
        self.err_since = None             # first moment the source was down (error, timeout or stale); None while it is healthy
        self.case_open = False
        self.last = {}                    # room -> (hold, why), for the audit line on change

    def _fetch(self, now):
        box = {}

        def run():
            try:
                box["v"] = self.loader(now)
            except BaseException as e:    # noqa: BLE001 -- any failure is a source error
                box["e"] = e
        t = threading.Thread(target=run, daemon=True)
        t.start(); t.join(self.timeout_s)
        if t.is_alive():
            return None                   # timeout: the thread is abandoned (daemon)
        if "e" in box:
            return None
        v = box.get("v")
        if not (isinstance(v, tuple) and len(v) == 2):
            return None
        return v

    def _refresh(self, now):
        if self.tried_at is not None and now - self.tried_at < self.cache_s:
            return
        self.tried_at = now
        v = self._fetch(now)
        if v is not None:
            self.data = (list(v[0]), list(v[1]), now)

    def hold(self, now=None):
        """-> {room: bool}, every room in rooms. Writes an audit line per room whose hold or reason changed and tracks the stuck-source case."""
        now = self.clock() if now is None else now
        self._refresh(now)
        down = self.data is None or now - self.data[2] > self.max_age_s
        out, why = {}, {}
        if down:
            for r in self.rooms:
                out[r], why[r] = True, "source_down"
        else:
            windows, known, _ = self.data
            for r in self.rooms:
                slug = self.map.get(r)
                if not isinstance(slug, str) or not slug:
                    out[r], why[r] = True, "no_mapping"; continue
                ids = {rid for s, rid in known if s == slug}
                if len(ids) > 1:
                    out[r], why[r] = True, "ambiguous"; continue
                if not ids:
                    out[r], why[r] = True, "no_data"; continue
                rows = [w for w in windows if w[0] == slug]
                if len({w[1] for w in rows}) > 1:
                    out[r], why[r] = True, "ambiguous"; continue
                opened = any(window_open(w[2], w[3], now) for w in rows)
                out[r], why[r] = opened, "open_window" if opened else "clear"
        self._audit(out, why, now)
        self._stuck(down, now)
        return out

    def _audit(self, out, why, now):
        for r in self.rooms:
            if self.last.get(r) == (out[r], why[r]):
                continue
            self.last[r] = (out[r], why[r])
            if self.audit_path:
                try:
                    with open(self.audit_path, "a") as f:
                        f.write(json.dumps({"ts": int(now), "room": r, "consult_open": out[r], "why": why[r]}, sort_keys=True) + "\n")
                except OSError:
                    pass                  # an audit write fault must never change the hold itself

    def _stuck(self, down, now):
        if not down:
            self.err_since = None
            if self.case_open and self.sink:
                self.sink.consult_hold_source_up(now)
            self.case_open = False
            return
        if self.err_since is None:
            self.err_since = now
        if now - self.err_since >= self.stuck_s and not self.case_open and self.sink:
            self.sink.consult_hold_source_down(now)
            self.case_open = True
