"""consult_hold.py -- FR1 2.4 d' (Mini side), Round 2: the per-room `consult_open` hold carried in the control line. Behind the flag consult_open_publish (default false).
Contract: ~/oc/herdr-lead/CONTROL-CONSULT-OPEN-SHAPE-15OCT.md. true = a consult may be open in that room (the kiosk never reboots); false = no consult.
fable 16:51: the hold comes from LIVE sources and fails closed. A room is `false` ONLY if all of these hold:
  1. Pulse Presence is fresh (an extension event for the room's machine in the last 2 min) and no encounter is attached to any such event;
  2. the kiosk's own health line for the room is fresh (<= 2 min) and shows no activity (not capture_open with sound);
  3. the room has no open recorder session in the DB (bench_session, status recording or paused);
  4. (extra, may only force true) the hourly eta_encounter_windows table shows no open window for the room, when the room has a slug mapped.
Any source missing, stale (> 2 min), erroring or unmapped gives true. Sources 1, 3 and 4 are Neon reads with the read-only credential file the consult cutter uses
(read by path, never printed), one thread and one 5 s timeout per source. Every SQL string, table and field name below is INFERRED (copied from lib/rooms-live/read.ts
and tools/pulse-watch, not run on the Mini).
Source 2 reads the kiosk health lines the subscriber already stores (rms_dbfs_2s, zero_ratio, capture_open): they are local, 30 s fresh, and exist even when no recorder
session is open, so a room with a dead recorder still has a fresh quiet answer. Sources 3's session rows already carry the Rooms-board MIC line's level rows
(bench_level_sample has session_open = true only while a session is open), so a levels query would add nothing and is not made."""
import json, math, os, threading, time
from datetime import datetime, timedelta, timezone

CACHE_S, MAX_AGE_S, QUERY_TIMEOUT_S, STUCK_S, SINK_RETRY_S = 30, 120, 5, 1800, 300
OPEN_UNCLOSED_MAX_S, OPEN_CLOSED_GRACE_S = 4 * 3600, 120     # Rooms Live rule (pulse-watch occupancy.mjs) for the windows signal
SESSION_LOOKBACK_S = 7 * 86400                               # Rooms Live bounds open sessions to 7 days; an older row is never read as open
SILENCE_ZERO_RATIO = 0.98                                    # INFERRED: a health line with zero_ratio >= this (or no sound figure at all) is digital silence
DEFAULT_URL_FILE = "~/.config/eta-audio/db.url"
IST = timezone(timedelta(hours=5, minutes=30))
# INFERRED SQL (read-only session; %s are timestamptz / text[] parameters):
PRESENCE_SQL = ("SELECT p.machine, p.ts, p.payload->>'encounter_id' AS enc FROM pulse_presence_events p "
                "WHERE p.source = 'ext' AND p.machine = ANY(%s::text[]) AND p.ts > %s ORDER BY p.ts DESC LIMIT 2000")
SESSION_SQL = ("SELECT DISTINCT s.room_id FROM bench_session s "
               "WHERE s.room_id = ANY(%s::text[]) AND s.status IN ('recording', 'paused') AND s.started_at <= %s AND s.started_at > %s")
WIN_SQL = "SELECT room_slug, room_id, t_open, t_close FROM eta_encounter_windows WHERE room_slug IS NOT NULL AND t_open >= %s"


def _epoch(v):
    return None if v is None else (v.timestamp() if hasattr(v, "timestamp") else float(v))


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def window_open(t_open, t_close, now):
    """True (held) for anything that is not a clean finite epoch: NaN, bool, str, None. A future t_open is held."""
    if not _finite(t_open) or t_open > now:
        return True
    if t_close is not None and not _finite(t_close):
        return True
    if t_close is None:
        return now - t_open <= OPEN_UNCLOSED_MAX_S
    return now - t_close <= OPEN_CLOSED_GRACE_S


def _connect(path, timeout):
    import psycopg
    with open(os.path.expanduser(path)) as f:
        url = f.read().strip()
    c = psycopg.connect(url, connect_timeout=timeout, options=f"-c default_transaction_read_only=on -c statement_timeout={int(timeout * 1000)}")
    c.read_only = True
    return c


def pg_sources(url_file=None, timeout=QUERY_TIMEOUT_S):
    """-> {"presence": f, "session": f, "windows": f}; each f(now, arg) returns plain Python data and raises on any fault.
    presence(now, machine_keys) -> [(machine, ts_epoch, encounter_id|None)]; session(now, room_ids) -> {room_id of an open session};
    windows(now, None) -> [(room_slug, room_id, t_open_epoch, t_close_epoch|None)]."""
    path = url_file or DEFAULT_URL_FILE
    utc = timezone.utc

    def run(sql, params):
        c = _connect(path, timeout)
        try:
            return c.execute(sql, params).fetchall()
        finally:
            c.close()

    def presence(now, keys):
        rows = run(PRESENCE_SQL, (list(keys), datetime.fromtimestamp(now - MAX_AGE_S, utc)))
        return [(r[0], _epoch(r[1]), r[2]) for r in rows]

    def session(now, ids):
        rows = run(SESSION_SQL, (list(ids), datetime.fromtimestamp(now, utc), datetime.fromtimestamp(now - SESSION_LOOKBACK_S, utc)))
        return {r[0] for r in rows}

    def windows(now, _arg):
        rows = run(WIN_SQL, (datetime.fromtimestamp(now - OPEN_UNCLOSED_MAX_S, utc),))
        return [(r[0], r[1], _epoch(r[2]), _epoch(r[3])) for r in rows]
    return {"presence": presence, "session": session, "windows": windows}


def _shape_ok(name, v):
    """A source reply must have exactly the shape the code reads; anything else is a source error (true)."""
    try:
        if name == "presence":
            return isinstance(v, list) and all(isinstance(x, tuple) and len(x) == 3 for x in v)
        if name == "session":
            return isinstance(v, (set, frozenset)) and all(isinstance(x, str) for x in v)
        if name == "windows":
            return isinstance(v, list) and all(isinstance(x, tuple) and len(x) == 4 for x in v)
    except Exception:                      # noqa: BLE001
        return False
    return False


def _entry(v):
    """room_map value -> (machine_keys, bench_room_id, slug), each None when absent. A bare string is the old windows-slug form: live signals stay unmapped."""
    if isinstance(v, str):
        return None, None, (v or None)
    if not isinstance(v, dict):
        return None, None, None
    m = v.get("machine")
    keys = [m] if isinstance(m, str) and m else [x for x in m if isinstance(x, str) and x] if isinstance(m, list) else []
    rid, slug = v.get("room_id"), v.get("slug")
    return (keys or None), (rid if isinstance(rid, str) and rid else None), (slug if isinstance(slug, str) and slug else None)


class ConsultHold:
    def __init__(self, rooms, room_map, sources, clock=time.time, audit_path=None, sink=None, cache_s=CACHE_S, max_age_s=MAX_AGE_S, timeout_s=QUERY_TIMEOUT_S,
                 stuck_s=STUCK_S):
        self.rooms, self.map, self.src, self.clock, self.audit_path, self.sink = list(rooms), dict(room_map or {}), sources, clock, audit_path, sink
        self.cache_s, self.max_age_s, self.timeout_s, self.stuck_s = cache_s, max_age_s, timeout_s, stuck_s
        self.data = {}                    # source name -> (value, fetched_at) of its last good fetch
        self.err = {}                     # source name -> True while its latest attempt failed
        self.tried_at = None
        self.health = {}                  # room -> (ts, obj) of the newest kiosk health line (fed by the subscriber)
        self.err_since = None
        self.case_open = False
        self.sink_block_until = 0         # after a sink fault no sink call is tried again for SINK_RETRY_S, so a broken store cannot raise on every tick
        self.inflight = {}                # source name -> the fetch thread still running (a new fetch never starts while one is alive)
        self.last = {}                    # room -> (hold, reasons) for the audit line on change

    # ---- source 2 feed
    def note_health(self, room, obj, now=None):
        if isinstance(obj, dict):
            self.health[room] = (self.clock() if now is None else now, obj)

    # ---- the DB sources
    def _call(self, name, now, arg):
        t0 = self.inflight.get(name)
        if t0 is not None and t0.is_alive():
            return False, None            # the previous fetch is hung: do not pile another thread on it
        box = {}

        def run():
            try:
                box["v"] = self.src[name](now, arg)
            except BaseException as e:    # noqa: BLE001 -- any failure is a source error
                box["e"] = e
        t = threading.Thread(target=run, daemon=True)
        self.inflight[name] = t
        t.start(); t.join(self.timeout_s)
        if t.is_alive() or "e" in box or "v" not in box or not _shape_ok(name, box["v"]):
            return False, None            # timeout (the thread is abandoned), error, no value or a wrong shape
        return True, box["v"]

    def _refresh(self, now):
        if self.tried_at is not None and now - self.tried_at < self.cache_s:
            return
        self.tried_at = now
        keys = sorted({k for r in self.rooms for k in (_entry(self.map.get(r))[0] or [])})
        ids = sorted({i for r in self.rooms for i in [_entry(self.map.get(r))[1]] if i})
        for name, arg in (("presence", keys), ("session", ids), ("windows", None)):
            if name in ("presence",) and not keys or name == "session" and not ids:
                continue                  # nothing is mapped for this source: every room is already true as unmapped
            ok, v = self._call(name, now, arg)
            self.err[name] = not ok
            if ok:
                self.data[name] = (v, now)

    def _fresh(self, name, now):
        d = self.data.get(name)
        return d is not None and now - d[1] <= self.max_age_s

    # ---- per room
    def _room(self, r, now):
        keys, rid, slug = _entry(self.map.get(r))
        reasons = []
        if not keys or not rid:
            return True, ["no_mapping"]
        # 1. Pulse Presence
        if not self._fresh("presence", now):
            reasons.append("presence_down")
        else:
            rows = [x for x in self.data["presence"][0] if x[0] in keys and _finite(x[1]) and now - x[1] <= self.max_age_s]
            if not rows:
                reasons.append("presence_stale")                 # no fresh extension event for this room's machine: cannot say nobody is consulting
            elif any(isinstance(x[2], str) and x[2].strip() for x in rows):
                reasons.append("presence_consulting")
        # 2. the kiosk's own health line
        h = self.health.get(r)
        if h is None or now - h[0] > self.max_age_s:
            reasons.append("health_stale")
        elif self._active(h[1]):
            reasons.append("health_active")
        # 3. open recorder session
        if not self._fresh("session", now):
            reasons.append("session_down")
        elif rid in self.data["session"][0]:
            reasons.append("session_open")
        # 4. hourly windows: may only force true
        if not self._fresh("windows", now):
            reasons.append("windows_down")
        elif slug and any(w[0] == slug and window_open(w[2], w[3], now) for w in self.data["windows"][0]):
            reasons.append("windows_open")
        return (bool(reasons), reasons or ["clear"])

    @staticmethod
    def _active(obj):
        """A health line shows activity unless it is digital silence: capture_open false, or capture_open true with zero_ratio >= SILENCE_ZERO_RATIO.
        capture_open missing or not a bool, or true with a missing, non-numeric or NaN zero_ratio, counts as active (fail closed)."""
        if obj.get("capture_open") is False:
            return False
        if obj.get("capture_open") is not True:
            return True                   # missing or not a bool: unknown, so active
        zr = obj.get("zero_ratio")
        if _num(zr):
            return zr < SILENCE_ZERO_RATIO
        return True

    def hold(self, now=None):
        """-> {room: bool}, every room in rooms. NEVER raises: any fault anywhere in the hold path gives true for every room (a raise here would drop the control line
        for every room, which the kiosks read as a kill). One audit line per room whose hold or deciding signals changed; tracks the stuck-source case."""
        try:
            now = self.clock() if now is None else now
            self._refresh(now)
            out, why = {}, {}
            for r in self.rooms:
                try:
                    out[r], why[r] = self._room(r, now)
                except Exception:         # noqa: BLE001 -- one room's fault holds that room
                    out[r], why[r] = True, ["fault"]
            self._audit(out, why, now)
            self._stuck(any(not self._fresh(n, now) for n in ("presence", "session", "windows") if self._needed(n)), now)
            return out
        except Exception:                 # noqa: BLE001
            return {r: True for r in self.rooms}

    def _needed(self, name):
        if name == "windows":
            return True
        keyname = 0 if name == "presence" else 1
        return any(_entry(self.map.get(r))[keyname] for r in self.rooms)

    def _audit(self, out, why, now):
        for r in self.rooms:
            sig = (out[r], tuple(why[r]))
            if self.last.get(r) == sig:
                continue
            self.last[r] = sig
            if self.audit_path:
                try:
                    with open(self.audit_path, "a") as f:
                        f.write(json.dumps({"ts": int(now), "room": r, "consult_open": out[r], "why": why[r][0], "signals": why[r]}, sort_keys=True) + "\n")
                except Exception:         # noqa: BLE001 -- an audit write fault must never change the hold itself
                    pass

    def _sink(self, fn, now):
        """One guarded sink call. A fault is swallowed and blocks further sink calls for SINK_RETRY_S. -> True if the call went through."""
        if now < self.sink_block_until:
            return False
        try:
            fn(now)
            return True
        except Exception:                 # noqa: BLE001 -- a store or sink fault never reaches the control line
            self.sink_block_until = now + SINK_RETRY_S
            return False

    def _stuck(self, down, now):
        if not down:
            self.err_since = None
            if self.case_open and self.sink and self._sink(self.sink.consult_hold_source_up, now):
                self.case_open = False
            return
        if self.err_since is None:
            self.err_since = now
        if now - self.err_since >= self.stuck_s and not self.case_open and self.sink and self._sink(self.sink.consult_hold_source_down, now):
            self.case_open = True
