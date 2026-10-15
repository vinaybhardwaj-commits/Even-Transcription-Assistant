"""consult_hold.py -- FR1 2.4 d' (Mini side), Round 3: the per-room `consult_open` hold carried in the control line. Behind the flag consult_open_publish (default false).
Contract: ~/oc/herdr-lead/CONTROL-CONSULT-OPEN-SHAPE-15OCT.md. true = a consult may be open in that room (the kiosk never reboots); false = no consult.
The hold comes from LIVE sources and fails closed. A room is `false` ONLY if all of these hold:
  1. Pulse Presence: EVERY machine mapped to the room has a fresh heartbeat (an ext event in the last 2 min; one stale or absent machine holds the room) AND no
     mapped machine is consulting: its NEWEST encounter_open / encounter_close event within the last 4 h is not an open, and (post_open_overrides_url_close, default
     true) the newest POST-driven event (the one carrying an encounter_id) is not an open, whatever URL-driven events came after it. "Newest" is server insert order
     (id), not the doctor machine's clock. (The extension writes encounter_id only on the consult start/close POST event; heartbeats carry null, so
     "no encounter id on a heartbeat" says nothing. A consult is open when its encounter_open has no later encounter_close.)
  2. the kiosk's own health line for the room is fresh (<= 2 min, by the older of receive time and the line's own ts) and shows no activity;
  3. the room has no open recorder session in the DB (bench_session, status recording or paused), or with open_session_requires_levels true, none with level activity
     (bench_level_sample, session_open, zero_ratio not digital silence) in the last 2 min;
  4. (extra, OFF by default: config consult_windows_enabled, a literal true turns it on; it may only force true) the hourly eta_encounter_windows table shows no open
     window for the room, when the room has a slug mapped. When it is enabled, a windows read error or stale data (> 2 min) gives true (fable 17:16: any read error in
     the hold path holds the room). When it is off the windows query is not made at all.
Any source missing, stale (> 2 min), erroring (down at once, the last good answer is NOT kept) or unmapped gives true FOR THAT ROOM; a batched read that fails is retried
per room (within an 8 s budget) so one room's read error holds that room only. fable 17:16 ruled both recorder switches default TRUE (config keys, a literal false turns
one off): capture_closed_counts_quiet (a non-capturing recorder, capture_open false, is quiet) and open_session_requires_levels (an open session holds only with level
activity, zero_ratio < 0.98, in the last 2 min). The hourly windows signal is OFF by default (consult_windows_enabled) and may only force true.
The DB sources are Neon reads with the read-only credential file the consult cutter uses (read by path, never printed), one thread and one 5 s timeout per source.
Every SQL string, table, field and event name below is INFERRED (copied from lib/rooms-live/read.ts, tools/pulse-watch and extensions/pulse-presence/src/agent.js and
lib/events.js; not run on the Mini)."""
import json, math, os, threading, time
from datetime import datetime, timedelta, timezone

CACHE_S, MAX_AGE_S, QUERY_TIMEOUT_S, STUCK_S, SINK_RETRY_S = 30, 120, 5, 1800, 300
OPEN_UNCLOSED_MAX_S, OPEN_CLOSED_GRACE_S = 4 * 3600, 120     # Rooms Live rule (pulse-watch occupancy.mjs) for the windows signal
SESSION_LOOKBACK_S = 7 * 86400                               # Rooms Live bounds open sessions to 7 days; an older row is never read as open
SILENCE_ZERO_RATIO = 0.98                                    # INFERRED: a health line or level row with zero_ratio >= this is digital silence
ENC_LOOKBACK_S = 4 * 3600                                    # the windows' bound: the newest encounter_open/close is looked for within this long
LEVEL_FRESH_S = 120
FALLBACK_BUDGET_S = 8                                        # the per-room retry after a failed batched read stops after this long
DEFAULT_URL_FILE = "~/.config/eta-audio/db.url"
IST = timezone(timedelta(hours=5, minutes=30))
# INFERRED SQL (read-only session; %s are timestamptz / text[] parameters):
# Presence heartbeat freshness: the newest ext event of each machine (heartbeat, idle, active, ...). DISTINCT ON, so no LIMIT can cut a machine's row (refute I-c).
# "Newest" is by p.id (bigserial, server insert order, migration 0122), NOT p.ts: ts is the doctor machine's own clock (refute I-2). INFERRED that id is monotonic.
HB_SQL = ("SELECT DISTINCT ON (p.machine) p.machine, p.ts FROM pulse_presence_events p "
          "WHERE p.source = 'ext' AND p.machine = ANY(%s::text[]) AND p.ts > %s ORDER BY p.machine, p.id DESC")
# The newest encounter_open / encounter_close of each machine (any source: the URL-driven and the POST-driven one both write these event names).
ENC_SQL = ("SELECT DISTINCT ON (p.machine) p.machine, p.event, p.ts FROM pulse_presence_events p "
           "WHERE p.event IN ('encounter_open', 'encounter_close') AND p.machine = ANY(%s::text[]) AND p.ts > %s ORDER BY p.machine, p.id DESC")
# The newest POST-driven encounter event of each machine: the extension writes encounter_id only on the consult start/close POST event (URL-driven ones carry null).
# A consult start whose body did not parse carries no encounter_id but a reason 'body_<why>' (agent.js onCompleted, why from lib/body.js WHY: no_body, form_no_key,
# raw_missing, raw_file_only, too_large, not_json, json_no_key, bad_uid), so that also counts as POST-driven. The underscore is escaped and the % doubled (psycopg).
POST_SQL = ("SELECT DISTINCT ON (p.machine) p.machine, p.event, p.ts FROM pulse_presence_events p "
            "WHERE p.event IN ('encounter_open', 'encounter_close') AND ((p.payload->>'encounter_id' IS NOT NULL AND p.payload->>'encounter_id' <> '') "
            "OR p.payload->>'reason' LIKE 'body\\_%%') "
            "AND p.machine = ANY(%s::text[]) AND p.ts > %s ORDER BY p.machine, p.id DESC")
SESSION_SQL = ("SELECT DISTINCT s.room_id FROM bench_session s "
               "WHERE s.room_id = ANY(%s::text[]) AND s.status IN ('recording', 'paused') AND s.started_at > %s")
# Only used with open_session_requires_levels: the newest level row that is not digital silence (NULL, below 0.98, or out of range counts as activity).
LEVEL_SQL = ("SELECT l.room_id, max(l.sampled_at) FILTER (WHERE l.zero_ratio IS NULL OR l.zero_ratio < 0.98 OR l.zero_ratio > 1) AS last_active "
             "FROM bench_level_sample l WHERE l.room_id = ANY(%s::text[]) AND l.ist_date IN (%s::date, %s::date) AND l.sampled_at > %s AND l.session_open = true "
             "GROUP BY l.room_id")
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
    """-> {"presence": f, "session": f, "levels": f, "windows": f}; each f(now, arg) returns plain Python data and raises on any fault.
    presence(now, machine_keys) -> {"hb": [(machine, ts_epoch)], "enc": [(machine, event, ts_epoch)], "post": [(machine, event, ts_epoch)]}; session(now, room_ids) -> {room_id of an open session};
    levels(now, room_ids) -> [(room_id, last_active_epoch|None)]; windows(now, None) -> [(room_slug, room_id, t_open_epoch, t_close_epoch|None)]."""
    path = url_file or DEFAULT_URL_FILE
    utc = timezone.utc

    def run(*queries):
        c = _connect(path, timeout)
        try:
            return [c.execute(sql, params).fetchall() for sql, params in queries]
        finally:
            c.close()

    def presence(now, keys):
        hb, enc, post = run((HB_SQL, (list(keys), datetime.fromtimestamp(now - MAX_AGE_S, utc))),
                            (ENC_SQL, (list(keys), datetime.fromtimestamp(now - ENC_LOOKBACK_S, utc))),
                            (POST_SQL, (list(keys), datetime.fromtimestamp(now - ENC_LOOKBACK_S, utc))))
        return {"hb": [(r[0], _epoch(r[1])) for r in hb], "enc": [(r[0], r[1], _epoch(r[2])) for r in enc], "post": [(r[0], r[1], _epoch(r[2])) for r in post]}

    def session(now, ids):
        (rows,) = run((SESSION_SQL, (list(ids), datetime.fromtimestamp(now - SESSION_LOOKBACK_S, utc))))
        return {r[0] for r in rows}

    def levels(now, ids):
        today = datetime.fromtimestamp(now, IST).date()
        (rows,) = run((LEVEL_SQL, (list(ids), today, today - timedelta(days=1), datetime.fromtimestamp(now - LEVEL_FRESH_S, utc))))
        return [(r[0], _epoch(r[1])) for r in rows]

    def windows(now, _arg):
        (rows,) = run((WIN_SQL, (datetime.fromtimestamp(now - OPEN_UNCLOSED_MAX_S, utc),)))
        return [(r[0], r[1], _epoch(r[2]), _epoch(r[3])) for r in rows]
    return {"presence": presence, "session": session, "levels": levels, "windows": windows}


def _shape_ok(name, v):
    """Only the overall shape is checked here (a dict of two lists, a list, a set); anything else is a source error (true for every room that uses it).
    Rows are cleaned one by one in _clean, so one room's bad row holds that room only."""
    if name == "presence":
        return isinstance(v, dict) and isinstance(v.get("hb"), list) and isinstance(v.get("enc"), list) and isinstance(v.get("post", []), list)
    if name == "session":
        return isinstance(v, (set, frozenset))
    return name in ("levels", "windows") and isinstance(v, list)


def _clean(name, v):
    """-> (clean value, set of items (machine keys / room ids) whose row was malformed). A malformed row with a readable key holds that key's room; one with no
    readable key cannot be attributed and is dropped."""
    bad = set()

    def rows(lst, n):
        out = []
        for x in lst:
            if isinstance(x, (tuple, list)) and len(x) == n:
                out.append(tuple(x))
            elif isinstance(x, (tuple, list)) and x and isinstance(x[0], str):
                bad.add(x[0])
        return out
    if name == "presence":
        return {"hb": rows(v["hb"], 2), "enc": rows(v["enc"], 3), "post": rows(v.get("post", []), 3)}, bad
    if name == "session":
        return {x for x in v if isinstance(x, str)}, bad
    if name == "levels":
        return rows(v, 2), bad
    return rows(v, 4), bad


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
                 stuck_s=STUCK_S, capture_closed_counts_quiet=True, open_session_requires_levels=True, consult_windows_enabled=False,
                 post_open_overrides_url_close=True):
        self.rooms, self.map, self.src, self.clock, self.audit_path, self.sink = list(rooms), dict(room_map or {}), sources, clock, audit_path, sink
        self.cache_s, self.max_age_s, self.timeout_s, self.stuck_s = cache_s, max_age_s, timeout_s, stuck_s
        self.closed_quiet, self.need_levels = capture_closed_counts_quiet is not False, open_session_requires_levels is not False     # fable 17:16: default true, only a literal false turns one off
        self.data = {}                    # source name -> (value, fetched_at) of its last good fetch
        self.err = {}                     # source name -> True while its latest attempt failed
        self.tried_at = None
        self.health = {}                  # room -> (effective ts, obj) of the newest kiosk health line (fed by the subscriber)
        self.err_since = None
        self.case_open = False
        self.sink_block_until = 0         # after a sink fault no sink call is tried again for SINK_RETRY_S, so a broken store cannot raise on every tick
        self.post_override = post_open_overrides_url_close is not False   # default true; only a literal false turns it off
        self.windows_on = consult_windows_enabled is True                 # off unless the config says a literal true
        self.item_bad = {}                # source name -> set of items (machine keys / room ids) whose own read failed in the per-room retry
        self.inflight = {}                # source name -> the fetch thread still running (a new fetch never starts while one is alive)
        self.last = {}                    # room -> (hold, reasons) for the audit line on change

    # ---- source 2 feed
    def note_health(self, room, obj, now=None):
        """Freshness is the OLDER of the receive time and the line's own ts, so a delayed or replayed line cannot read fresh. A future ts counts as the receive time (note I-b)."""
        if isinstance(obj, dict):
            t = self.clock() if now is None else now
            ts = obj.get("ts")
            self.health[room] = (min(t, ts) if _finite(ts) else t, obj)

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
        todo = [("presence", keys), ("session", ids)] + ([("windows", None)] if self.windows_on else []) + ([("levels", ids)] if self.need_levels else [])
        for name, arg in todo:
            if name in ("presence", "session", "levels") and not arg:
                continue                  # nothing is mapped for this source: every room is already true as unmapped
            ok, v = self._call(name, now, arg)
            self.item_bad[name] = set()
            if ok:
                self.err[name] = False
                v, bad = _clean(name, v)
                self.item_bad[name] = bad
                self.data[name] = (v, now)
                continue
            self.err[name] = True
            if name == "windows" or len(arg) < 2:
                continue
            # one room's read error must hold that room only: retry each item on its own, within a short budget (the rest stay bad)
            t0, parts = time.monotonic(), []
            for item in arg:
                if time.monotonic() - t0 > FALLBACK_BUDGET_S:
                    self.item_bad[name].add(item); continue
                ok1, v1 = self._call(name, now, [item])
                if ok1:
                    v1, bad1 = _clean(name, v1)
                    self.item_bad[name] |= bad1
                    parts.append(v1)
                else:
                    self.item_bad[name].add(item)
            if parts:
                self.err[name] = False
                self.data[name] = (self._merge(name, parts), now)

    @staticmethod
    def _merge(name, parts):
        if name == "presence":
            return {"hb": [x for p in parts for x in p["hb"]], "enc": [x for p in parts for x in p["enc"]]}
        if name == "session":
            return set().union(*parts)
        return [x for p in parts for x in p]

    def _item_ok(self, name, items, now):
        """A source is usable for a room when it is fresh and none of the room's own items failed in the per-room retry."""
        return self._fresh(name, now) and not (self.item_bad.get(name, set()) & set(items))

    def _fresh(self, name, now):
        if self.err.get(name):
            return False                  # an erroring source is down at once; the last good answer is not kept (refute S-a)
        d = self.data.get(name)
        return d is not None and now - d[1] <= self.max_age_s

    # ---- per room
    def _room(self, r, now):
        keys, rid, slug = _entry(self.map.get(r))
        reasons = []
        if not keys or not rid:
            return True, ["no_mapping"]
        # 1. Pulse Presence: heartbeat fresh, and the newest encounter_open/close of the machine is not an open
        if not self._item_ok("presence", keys, now):
            reasons.append("presence_down")
        else:
            pdata = self.data["presence"][0]
            if not all(any(x[0] == k and _finite(x[1]) and now - x[1] <= self.max_age_s for x in pdata["hb"]) for k in keys):
                reasons.append("presence_stale")                 # a mapped machine with no fresh extension event: cannot say nobody is consulting (map only machines in use)
            if any(x[0] in keys and x[1] != "encounter_close" for x in pdata["enc"]):
                reasons.append("presence_consulting")            # newest is an open (or anything that is not a close, or an unreadable ts): a consult is running
            elif self.post_override and any(x[0] in keys and x[1] != "encounter_close" for x in pdata.get("post", [])):
                reasons.append("presence_consulting")            # the newest POST-driven event is an open: a later URL-driven close does not end the consult
        # 2. the kiosk's own health line
        h = self.health.get(r)
        if h is None or now - h[0] > self.max_age_s:
            reasons.append("health_stale")
        elif self._active(h[1]):
            reasons.append("health_active")
        # 3. open recorder session (with open_session_requires_levels: only with level activity in the last 2 min)
        if not self._item_ok("session", [rid], now):
            reasons.append("session_down")
        elif rid in self.data["session"][0]:
            if not self.need_levels:
                reasons.append("session_open")
            elif not self._item_ok("levels", [rid], now):
                reasons.append("levels_down")
            elif any(x[0] == rid and x[1] is not None and (not _finite(x[1]) or now - x[1] <= LEVEL_FRESH_S) for x in self.data["levels"][0]):
                reasons.append("session_open")                   # level activity in the last 2 min (an unreadable time counts as activity)
        # 4. hourly windows: may only force true
        if self.windows_on and slug:
            if not self._fresh("windows", now) or slug in self.item_bad.get("windows", set()):
                reasons.append("windows_down")                   # enabled: a read error or stale data holds the room (fable 17:16)
            elif any(w[0] == slug and window_open(w[2], w[3], now) for w in self.data["windows"][0]):
                reasons.append("windows_open")
        return (bool(reasons), reasons or ["clear"])

    def _active(self, obj):
        """A health line shows activity unless it is digital silence. capture_open false is unknown (active) unless capture_closed_counts_quiet is on; capture_open true
        is quiet only with a finite zero_ratio in 0..1 that is >= SILENCE_ZERO_RATIO. Anything else (missing, non-bool, NaN, inf, out of range, str) is active."""
        co = obj.get("capture_open")
        if co is False:
            return not self.closed_quiet
        if co is not True:
            return True
        zr = obj.get("zero_ratio")
        if _finite(zr) and 0 <= zr <= 1:
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
            self._stuck(any((not self._fresh(n, now)) or bool(self.item_bad.get(n)) for n in ("presence", "session", "levels", "windows") if self._needed(n)), now)
            return out
        except Exception:                 # noqa: BLE001
            return {r: True for r in self.rooms}

    def _needed(self, name):
        if name == "windows":
            return self.windows_on
        if name == "levels" and not self.need_levels:
            return False
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


def build(flags, rooms, sink, home, clock=time.time, sources=None):
    """-> ConsultHold for the flag-on case, exactly as run_subscriber.main() builds it: every switch comes from the router.json flags (ubus_bus.load_cfg). `sources`
    is injectable for tests; the default is the read-only Neon sources."""
    return ConsultHold(rooms, flags.get("consult_room_map"), sources if sources is not None else pg_sources(flags.get("consult_db_url_file")), clock,
                       audit_path=os.path.join(home, "logs", "consult-hold-audit.jsonl"), sink=sink,
                       capture_closed_counts_quiet=flags.get("capture_closed_counts_quiet") is not False,
                       open_session_requires_levels=flags.get("open_session_requires_levels") is not False,
                       consult_windows_enabled=flags.get("consult_windows_enabled") is True,
                       post_open_overrides_url_close=flags.get("post_open_overrides_url_close") is not False)
