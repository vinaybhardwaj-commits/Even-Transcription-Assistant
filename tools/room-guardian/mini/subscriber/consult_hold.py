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
lib/events.js; not run on the Mini).

consult_live (S3 / plan gap G1, spec SENTINEL-CONSULT-OPEN-SPEC-17OCT, BINDING): the affirmative per-room consult signal for the Sentinel MIC_DEAD_WEBCAM
trigger. The WIRE map (live() -> {room: True|False}, joined to the control line only behind the flag consult_live_publish, default false) carries only
PRESENT rooms — an ABSENT room is unknown and is never true. Per-room rule (evaluated on the same presence read the hold uses, no audio input):
  - DB error, query timeout (any of the hold's sources down, stale or item-bad) or a snapshot older than LIVE_SNAPSHOT_MAX_AGE_S (60 s): the WHOLE map is
    absent; the consult_open hold keeps its fail-closed behaviour unchanged;
  - the room is not in consult_room_map, or the map entry is malformed: absent (source unmapped);
  - NO mapped machine has a fresh Presence heartbeat (<= max_age_s; with several machines ALL must be fresh): absent (source presence_stale);
  - newest POST-driven event across the room's machines is an encounter_open within OPEN_UNCLOSED_MAX_S and not in the future: TRUE (source post_open,
    confidence high) — it survives a later URL-driven close, as the hold's post_override;
  - no POST-driven event, and the newest URL-driven event (the room's newest enc row, visible whenever no POST row is newer) is an encounter_open within
    OPEN_UNCLOSED_MAX_S and not in the future: TRUE (source url_open, confidence MEDIUM);
  - newest deciding event is a close: FALSE (source post_close / url_close, confidence high);
  - fresh heartbeat and no open within the window (an open older than OPEN_UNCLOSED_MAX_S, a future open, or no event at all): FALSE (source no_event,
    confidence medium).
The STATUS RECORD (bench and audit only, NEVER the wire) is written to <home>/state/consult_live.jsonl whenever the hold is built — before the wire flag is
ever on, so the spec's bench day runs status-file-only — one line per room per CHANGE of {room_id, consult_live, source, event_ts, confidence}, with ts =
evaluation time (UTC ISO 8601), event_ts = the deciding row's ts (or null) and hb_age_s = the age of the oldest fresh-mapped-machine heartbeat (or null).
Metadata only: no encounter ids, no patient fields, no doctor names. heal_eligible() is the S5 consumer gate: a status entry may drive a heal only as a
high-confidence post_open true; a medium-confidence entry (url_open / no_event) NEVER may. The map is computed with the same refresh the hold uses; in
background mode live() only reads the refresher's snapshot (the publish thread never blocks), and a snapshot older than LIVE_SNAPSHOT_MAX_AGE_S (or none)
gives an empty map plus a snapshot_stale status record for every room."""
import json, math, os, re, threading, time
from datetime import datetime, timedelta, timezone

CACHE_S, MAX_AGE_S, QUERY_TIMEOUT_S, STUCK_S, SINK_RETRY_S = 30, 120, 5, 1800, 300
OPEN_UNCLOSED_MAX_S, OPEN_CLOSED_GRACE_S = 4 * 3600, 120     # Rooms Live rule (pulse-watch occupancy.mjs) for the windows signal
SESSION_LOOKBACK_S = 7 * 86400                               # Rooms Live bounds open sessions to 7 days; an older row is never read as open
SILENCE_ZERO_RATIO = 0.98                                    # INFERRED: a health line or level row with zero_ratio >= this is digital silence
ENC_LOOKBACK_S = 4 * 3600                                    # the windows' bound: the newest encounter_open/close is looked for within this long
LEVEL_FRESH_S = 120
FALLBACK_BUDGET_S = 8                                        # the per-room retry after a failed batched read stops after this long
SNAPSHOT_MAX_AGE_S = 90                                      # the publish thread serves a snapshot at most this old (older or none = every room true); normally <= ~50 s (20 s refresh + 30 s wait). 90 per fable DPM-6; the health/heartbeat age rule (MAX_AGE_S) stays 120
LIVE_SNAPSHOT_MAX_AGE_S = 60                                 # spec (SENTINEL-CONSULT-OPEN-SPEC-17OCT §2): a consult_live snapshot older than this makes the WHOLE map absent (snapshot_stale). The hold keeps its own 90 s.
LIVE_STATE_REL = ("state", "consult_live.jsonl")             # the consult_live status record (bench and audit only, not the wire), relative to GUARDIAN_HOME
REFRESH_BUDGET_S = 20                                        # one WHOLE refresh (every source plus every retry) is bounded to this, well under the 30 s publish period
PRESENCE_KEYS = ("hb", "enc", "post")                        # the batched Presence value always has all three; a value missing one is a source error
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
# raw_missing, raw_file_only, too_large, not_json, json_no_key, bad_uid), so that also counts as POST-driven. The match is token-wise, because reason can hold several
# comma-separated tokens (e.g. 'absent_401,body_raw_missing'): the regex `(^|,)body_` matches a token that STARTS with body_, never 'nobody_x' or 'x_body_y'.
POST_SQL = ("SELECT DISTINCT ON (p.machine) p.machine, p.event, p.ts FROM pulse_presence_events p "
            "WHERE p.event IN ('encounter_open', 'encounter_close') AND ((p.payload->>'encounter_id' IS NOT NULL AND p.payload->>'encounter_id' <> '') "
            "OR p.payload->>'reason' ~ '(^|,)body_') "
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


def _iso_utc(v):
    """epoch -> UTC ISO 8601 (seconds, Z) for the status record, or None for None / a non-finite value."""
    if not _finite(v):
        return None
    return datetime.fromtimestamp(v, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def heal_eligible(rec):
    """The Sentinel S5 consumer gate (spec): a consult_live status entry may drive a MIC_DEAD_WEBCAM heal ONLY as a high-confidence post_open true. A
    medium-confidence entry (url_open / no_event) NEVER may, and a false or an absent (null) entry never may. When unsure, no heal."""
    return bool(isinstance(rec, dict) and rec.get("consult_live") is True and rec.get("source") == "post_open" and rec.get("confidence") == "high")


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
    # NO `options=` startup parameter: against the live Neon endpoint a connect carrying it hangs (probe 16 Oct 2026: 121 s, then a timeout; the same URL without it connects in
    # 0.3 s). Read-only is enforced per transaction instead (c.read_only = True makes psycopg open each transaction READ ONLY) and the statement timeout is a SET LOCAL
    # inside that same transaction (see pg_sources.run), which also holds through a pooler.
    c = psycopg.connect(url, connect_timeout=timeout)
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
            with c.transaction():
                c.execute(f"SET LOCAL statement_timeout = {int(timeout * 1000)}")
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
        return isinstance(v, dict) and all(isinstance(v.get(k), list) for k in PRESENCE_KEYS)
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
        return {"hb": rows(v["hb"], 2), "enc": rows(v["enc"], 3), "post": rows(v["post"], 3)}, bad
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
                 post_open_overrides_url_close=True, background=False, refresh_budget_s=REFRESH_BUDGET_S, snapshot_max_age_s=SNAPSHOT_MAX_AGE_S,
                 live_state_path=None, live_snapshot_max_age_s=LIVE_SNAPSHOT_MAX_AGE_S):
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
        self.budget, self.snap_max_age = refresh_budget_s, snapshot_max_age_s
        self.background = background is True      # True: hold() only READS the last snapshot; a refresher thread computes it (never on the publish thread)
        self._snap = None                 # (out dict, computed_at) of the last completed computation
        self._live = {}                   # room -> True/False of the last computation (the consult_live WIRE map); a room absent here is unknown — never true
        self._live_records = {}           # room -> the last computed status record {room_id, consult_live, source, event_ts, hb_age_s, confidence}
        self._snap_live = None            # (wire map, records, computed_at) of the last completed computation, for live() in background mode
        self.live_state_path = live_state_path     # the consult_live status record file (bench/audit only); None disables writing (tests, probe)
        self.live_snap_max_age = live_snapshot_max_age_s
        self._live_lock = threading.Lock()
        self._last_live_rec = {}          # room -> last written record signature (hb_age_s excluded: an age drift is not a status change)
        self._thread, self._stop = None, threading.Event()

    # ---- source 2 feed
    def note_health(self, room, obj, now=None):
        """Freshness is the OLDER of the receive time and the line's own ts, so a delayed or replayed line cannot read fresh. A future ts counts as the receive time (note I-b)."""
        if isinstance(obj, dict):
            t = self.clock() if now is None else now
            ts = obj.get("ts")
            self.health[room] = (min(t, ts) if _finite(ts) else t, obj)

    # ---- the DB sources
    def _call(self, name, now, arg, timeout=None):
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
        t.start(); t.join(self.timeout_s if timeout is None else max(0.0, timeout))
        if t.is_alive() or "e" in box or "v" not in box or not _shape_ok(name, box["v"]):
            return False, None            # timeout (the thread is abandoned), error, no value or a wrong shape
        return True, box["v"]

    def _refresh(self, now):
        if self.tried_at is not None and now - self.tried_at < self.cache_s:
            return
        self.tried_at = now
        t_begin = time.monotonic(); deadline = t_begin + self.budget
        left = lambda: deadline - time.monotonic()
        keys = sorted({k for r in self.rooms for k in (_entry(self.map.get(r))[0] or [])})
        ids = sorted({i for r in self.rooms for i in [_entry(self.map.get(r))[1]] if i})
        todo = [("presence", keys), ("session", ids)] + ([("windows", None)] if self.windows_on else []) + ([("levels", ids)] if self.need_levels else [])
        for name, arg in todo:
            if name in ("presence", "session", "levels") and not arg:
                continue                  # nothing is mapped for this source: every room is already true as unmapped
            self.item_bad[name] = set()
            if left() <= 0:               # the whole-refresh budget is spent: this source is down for this round (true), not waited for
                self.err[name] = True
                if arg:
                    self.item_bad[name] = set(arg)
                continue
            ok, v = self._call(name, now, arg, min(self.timeout_s, left()))
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
                if time.monotonic() - t0 > FALLBACK_BUDGET_S or left() <= 0:
                    self.item_bad[name].add(item); continue
                ok1, v1 = self._call(name, now, [item], min(self.timeout_s, left()))
                if ok1:
                    v1, bad1 = _clean(name, v1)
                    self.item_bad[name] |= bad1
                    parts.append(v1)
                else:
                    self.item_bad[name].add(item)
            if parts:
                self.err[name] = False
                self.data[name] = (self._merge(name, parts), now)
        self.tried_at = max(now, self.clock())      # the cache age counts from the refresh END, so a slow refresh never makes the next one start at once

    @staticmethod
    def _merge(name, parts):
        """Merge the per-item replies. Every key of the batched shape is carried (hb, enc AND post); a part missing one is already refused by _shape_ok."""
        if name == "presence":
            return {k: [x for p in parts for x in p[k]] for k in PRESENCE_KEYS}
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

    def _absent_rec(self, r, source):
        """The absent (null) status record for a room: never true, no event, no confidence. room_id is the bench id of the map entry (null when unmapped)."""
        _keys, rid, _slug = _entry(self.map.get(r))
        return {"room_id": rid, "consult_live": None, "source": source, "event_ts": None, "hb_age_s": None, "confidence": None}

    def _room_live_rec(self, r, now, whole_fault):
        """consult_live status for one room (spec §2): {room_id, consult_live true/false/null, source, event_ts, hb_age_s, confidence}. true = post_open
        (high) or url_open (MEDIUM); false = post_close / url_close (high) or no_event (medium — includes an open older than OPEN_UNCLOSED_MAX_S with no
        close, a future open, and no event at all); null = ABSENT (unmapped / presence_stale / db_error), never true. Uses ONLY the presence source: the
        kiosk health line, the recorder session, the levels and the windows play no part. Machine match is EXACT string equality (CONSUL4 vs CONSUL4-2).
        With several machines ALL must have a fresh heartbeat; the newest deciding row across the room's machines (one newest per machine per query)
        decides; a POST open survives a later URL close (post_override). A future ts is never affirmed."""
        if whole_fault:
            return self._absent_rec(r, "db_error")       # any DB error / timeout / stale source: the whole map is absent (source stamped per room)
        keys, _rid, _slug = _entry(self.map.get(r))
        if not keys:
            return self._absent_rec(r, "unmapped")       # not mapped, or a malformed entry: absent; the other rooms are still decided
        if not self._item_ok("presence", keys, now):
            return self._absent_rec(r, "db_error")       # this room's presence read failed in the per-room retry
        pdata = self.data["presence"][0]
        hb_ts = {}
        for x in pdata["hb"]:
            if x[0] in keys and _finite(x[1]):
                hb_ts.setdefault(x[0], x[1])             # one row per machine (DISTINCT ON); a duplicate cannot make a machine fresh
        if len(hb_ts) != len(keys) or any(now - t > self.max_age_s for t in hb_ts.values()):
            ages = [now - t for t in hb_ts.values()]
            return {**self._absent_rec(r, "presence_stale"), "hb_age_s": (max(ages) if ages else None)}   # a machine with no ext event in the window: absent
        rec = {"room_id": _rid, "consult_live": False, "source": "no_event", "event_ts": None,
               "hb_age_s": max(now - t for t in hb_ts.values()), "confidence": "medium"}
        posts = [x for x in pdata.get("post", []) if x[0] in keys and x[1] in ("encounter_open", "encounter_close") and _finite(x[2])]
        encs = [x for x in pdata.get("enc", []) if x[0] in keys and x[1] in ("encounter_open", "encounter_close") and _finite(x[2])]
        lp = max(posts, key=lambda x: x[2], default=None)
        le = max(encs, key=lambda x: x[2], default=None)
        if lp is not None and lp[1] == "encounter_open" and 0 <= now - lp[2] <= OPEN_UNCLOSED_MAX_S:
            rec.update(consult_live=True, source="post_open", confidence="high", event_ts=lp[2])
        elif lp is not None and lp[1] == "encounter_close":
            rec.update(consult_live=False, source="post_close", confidence="high", event_ts=lp[2])
        elif le is not None and le[1] == "encounter_open" and 0 <= now - le[2] <= OPEN_UNCLOSED_MAX_S:
            rec.update(consult_live=True, source="url_open", confidence="medium", event_ts=le[2])
        elif le is not None and le[1] == "encounter_close":
            rec.update(consult_live=False, source="url_close", confidence="high", event_ts=le[2])
        return rec

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

    def compute(self, now=None):
        """-> {room: bool}, every room in rooms: refresh the sources (cached 30 s from the refresh end), then decide each room. ALSO decides consult_live
        for every room from the same presence read (spec §2), fills self._live (the WIRE map: only present rooms) and self._live_records (the status
        records), and writes the status record file (one line per room per change). ANY DB error / timeout / stale source takes the WHOLE consult_live map
        away (every room absent, source db_error); consult_open keeps its fail-closed hold unchanged. NEVER raises: any fault anywhere in the hold path
        gives true for every room (and an empty consult_live map). One audit line per room whose hold or deciding signals changed; tracks the
        stuck-source case. This can take up to the refresh budget, so in the live process it only ever runs on the refresher thread (background mode),
        never on the publish thread."""
        try:
            now = self.clock() if now is None else now
            self._refresh(now)
            whole_fault = any(not self._fresh(n, now) or bool(self.item_bad.get(n)) for n in ("presence", "session", "levels", "windows") if self._needed(n))
            out, why, live, records = {}, {}, {}, {}
            for r in self.rooms:
                try:
                    out[r], why[r] = self._room(r, now)
                except Exception:         # noqa: BLE001 -- one room's fault holds that room
                    out[r], why[r] = True, ["fault"]
                try:
                    records[r] = self._room_live_rec(r, now, whole_fault)
                except Exception:         # noqa: BLE001 -- one room's live fault makes that room absent, never false
                    records[r] = self._absent_rec(r, "db_error")
                if records[r]["consult_live"] in (True, False):
                    live[r] = records[r]["consult_live"]
            self._live, self._live_records = live, records
            self._write_live_records(records, now)
            self._audit(out, why, now)
            self._track_down(whole_fault, now)
            return out
        except Exception:                 # noqa: BLE001
            try:
                now = self.clock()
            except Exception:             # noqa: BLE001
                now = time.time()
            self._live = {}
            self._live_records = {r: self._absent_rec(r, "db_error") for r in self.rooms}
            self._write_live_records(self._live_records, now)
            return {r: True for r in self.rooms}

    def _write_live_records(self, records, now):
        """The consult_live status record (spec §1: bench and audit only, NEVER the wire): one line per room per CHANGE of
        {room_id, consult_live, source, event_ts, confidence} (hb_age_s is context and does not trigger a line by itself). Metadata only: no encounter
        ids, no patient fields, no doctor names. A write fault is swallowed — it must never reach the control line."""
        if not self.live_state_path:
            return
        for r in self.rooms:
            rec = records.get(r)
            if not isinstance(rec, dict):
                continue
            sig = {k: rec.get(k) for k in ("room_id", "consult_live", "source", "event_ts", "confidence")}
            if self._last_live_rec.get(r) == sig:
                continue
            self._last_live_rec[r] = sig
            line = {"room_id": rec.get("room_id"), "consult_live": rec.get("consult_live"), "source": rec.get("source"), "ts": _iso_utc(now),
                    "event_ts": _iso_utc(rec.get("event_ts")), "hb_age_s": rec.get("hb_age_s"), "confidence": rec.get("confidence")}
            with self._live_lock:
                try:
                    d = os.path.dirname(self.live_state_path)
                    if d:
                        os.makedirs(d, exist_ok=True)
                    with open(self.live_state_path, "a") as f:
                        f.write(json.dumps(line, sort_keys=True) + "\n")
                except Exception:         # noqa: BLE001
                    pass

    def hold(self, now=None):
        """-> {room: bool}, every room. Synchronous (compute) unless background mode, where this only READS the last snapshot and never blocks: no snapshot yet, or one
        older than max_age_s (the refresher is slow, dead or failing), means true for every room. NEVER raises, so the control line is always published."""
        try:
            now = self.clock() if now is None else now
            if not self.background:
                out = self.compute(now)
                self.check_stuck(now)         # synchronous mode: one thread, so the case is opened here; in background mode the LOOP thread calls check_stuck (housekeeping)
                return out
            self.start()                  # a no-op while the refresher thread is alive; restarts it if it died
            snap = self._snap
            if snap is None or not _finite(snap[1]) or now - snap[1] > self.snap_max_age:
                return {r: True for r in self.rooms}
            return {r: snap[0].get(r, True) is not False for r in self.rooms}
        except Exception:                 # noqa: BLE001
            return {r: True for r in self.rooms}

    def live(self, now=None):
        """-> {room: True|False} with only PRESENT rooms (the consult_live WIRE map): a stale, unknown, unmapped or DB-errored room is ABSENT, never true;
        any DB error gives an empty map. NEVER raises, so the control line is always published. Synchronous (compute) unless background mode, where this
        only READS the refresher's live snapshot (never blocks): no snapshot yet, or one older than live_snapshot_max_age_s (60 s per spec), gives an
        empty map (absent = unknown = never true) and a snapshot_stale status record for every room."""
        try:
            now = self.clock() if now is None else now
            if not self.background:
                self.compute(now)
                return {r: v for r, v in self._live.items() if v is True or v is False}
            self.start()                 # a no-op while the refresher thread is alive; restarts it if it died
            snap = self._snap_live
            if snap is None or not _finite(snap[2]) or now - snap[2] > self.live_snap_max_age:
                self._write_live_records({r: self._absent_rec(r, "snapshot_stale") for r in self.rooms}, now)
                return {}
            return {r: v for r, v in snap[0].items() if v is True or v is False}
        except Exception:                 # noqa: BLE001
            return {}

    # ---- the background refresher
    def start(self):
        if self._stop.is_set():
            return
        t = self._thread
        if t is not None and t.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="consult-hold-refresher", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            try:
                out = self.compute(self.clock())
                self._snap = (out, self.clock())      # computed_at is the END of the computation
                self._snap_live = (dict(self._live), dict(self._live_records), self._snap[1])
            except BaseException:         # noqa: BLE001 -- the refresher never dies on a fault: every room is held, and consult_live absent, until the next good round
                self._snap = ({r: True for r in self.rooms}, self.clock())
                self._snap_live = ({}, {}, self.clock())
            self._stop.wait(self.cache_s)

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

    def _track_down(self, down, now):
        """Record only (called from compute, which runs on the refresher thread): when the sources went down, or None once they are all up. NO sink or store call here: the
        case store is a sqlite3 connection owned by the loop thread and raises ProgrammingError from any other thread (refute R7-M1)."""
        if not down:
            self.err_since = None
        elif self.err_since is None:
            self.err_since = now

    def check_stuck(self, now=None):
        """Called on the LOOP thread (housekeeping): opens consult_hold_source_down once when the sources have been down for stuck_s, closes it when they are up again.
        A store fault is swallowed and retried once per 5 min (never raises)."""
        try:
            now = self.clock() if now is None else now
            since = self.err_since
            if since is None:
                if self.case_open and self.sink and self._sink(self.sink.consult_hold_source_up, now):
                    self.case_open = False
                return
            if now - since >= self.stuck_s and not self.case_open and self.sink and self._sink(self.sink.consult_hold_source_down, now):
                self.case_open = True
        except Exception:                 # noqa: BLE001
            pass


def build(flags, rooms, sink, home, clock=time.time, sources=None, background=False, live_state_path=None):
    """-> ConsultHold for the flag-on case, exactly as run_subscriber.main() builds it: every switch comes from the router.json flags (ubus_bus.load_cfg). `sources`
    is injectable for tests; the default is the read-only Neon sources. background=True (run_subscriber) computes the hold on a refresher thread, off the
    publish thread. The consult_live status record (bench/audit only, written BEFORE the wire flag is ever on, per the spec's rollout) goes to
    <home>/state/consult_live.jsonl unless live_state_path says otherwise (None disables it: probe, tests)."""
    if live_state_path is None:
        live_state_path = os.path.join(home, *LIVE_STATE_REL)
    return ConsultHold(rooms, flags.get("consult_room_map"), sources if sources is not None else pg_sources(flags.get("consult_db_url_file")), clock,
                       audit_path=os.path.join(home, "logs", "consult-hold-audit.jsonl"), sink=sink,
                       capture_closed_counts_quiet=flags.get("capture_closed_counts_quiet") is not False,
                       open_session_requires_levels=flags.get("open_session_requires_levels") is not False,
                       consult_windows_enabled=flags.get("consult_windows_enabled") is True,
                       post_open_overrides_url_close=flags.get("post_open_overrides_url_close") is not False, background=background,
                       live_state_path=live_state_path)


# ---- one-shot probe: `python3 consult_hold.py --probe <router.json-like file>`
def _redactor(url_file):
    """-> f(text) that removes the DB URL, its user, password and host from any error text before it is printed. A URL file that cannot be read redacts nothing (nothing is known)."""
    secrets = set()
    try:
        from urllib.parse import urlparse, unquote
        with open(os.path.expanduser(url_file or DEFAULT_URL_FILE)) as f:
            url = f.read().strip()
        u = urlparse(url)
        host_as_written = u.netloc.rsplit("@", 1)[-1].split(":")[0]      # urlparse().hostname is lower-cased; libpq prints the host as written
        for s in (url, u.password, unquote(u.password or ""), u.username, u.hostname, host_as_written, host_as_written.split(".")[0], re.sub(r"-pooler$", "", host_as_written.split(".")[0], flags=re.I), u.netloc):
            if s and len(s) >= 3:
                secrets.add(s)
    except Exception:                      # noqa: BLE001
        pass

    def red(text):
        text = str(text)
        for s in sorted(secrets, key=len, reverse=True):
            text = re.sub(re.escape(s), "<redacted>", text, flags=re.I)           # any case
        return text
    return red


PROBE_ROOM_RE = re.compile(r"^[a-z0-9_-]{1,64}$")          # the room slug rule of the control line (subscriber SLUG_RE)


def probe(cfg_path, sources=None, clock=time.time, timeout_s=None):
    """ONE compute with background off, through build(). -> a JSON-able dict. Never publishes, never writes the audit file (audit_path and sink are cleared after build), never prints the
    DB URL or a credential (error text is redacted). Prints machine keys, room ids, slugs, counts, event names and booleans only: no names, no ages, no timestamps.
    The rooms are the keys of consult_room_map. The kiosk health line comes from the live subscriber and the probe has none, so `health_stale` is always among the reasons;
    `db_hold` is the hold with that one reason left out (what the DB sources alone say)."""
    with open(cfg_path) as f:
        flags = json.load(f)
    if not isinstance(flags, dict) or not isinstance(flags.get("consult_room_map"), dict):
        raise ValueError("the config needs a consult_room_map object")
    rooms = sorted(flags["consult_room_map"])
    if not all(isinstance(r, str) and PROBE_ROOM_RE.fullmatch(r) for r in rooms):
        raise ValueError("consult_room_map has a key that is not a room slug [a-z0-9_-]{1,64}")     # the key is not echoed: the live subscriber could never publish that room
    red = _redactor(flags.get("consult_db_url_file"))
    errors, returned = [], set()
    real = sources if sources is not None else pg_sources(flags.get("consult_db_url_file"))

    def wrap(name):
        def f(now, arg):
            try:
                v = real[name](now, arg)
                returned.add(name)
                return v
            except BaseException as e:     # noqa: BLE001 -- recorded verbatim (redacted), then re-raised so ConsultHold treats it as a source error
                errors.append({"source": name, "arg_count": len(arg) if arg is not None else 0, "error": f"{type(e).__name__}: {red(e)}"})
                raise
        return f
    h = build(flags, rooms, None, "/nonexistent-probe-home", clock, sources={n: wrap(n) for n in ("presence", "session", "levels", "windows")}, background=False)
    h.audit_path, h.sink = None, None
    h.live_state_path = None                 # the probe never writes the status record (and must not create the probe home)
    if timeout_s is not None:
        h.timeout_s = timeout_s            # test seam; the CLI always uses the live default
    now = clock()
    out = h.compute(now)
    for n in ("presence", "session", "levels", "windows"):
        if h.err.get(n) and not any(e["source"] == n for e in errors):       # a failed source with no exception: it timed out (no answer) or answered with a wrong shape
            errors.append({"source": n, "arg_count": 0, "error": "wrong_shape: the source answered with a value of the wrong shape" if n in returned else "timeout: no answer within the source timeout"})
    rooms_out = {}
    for r in rooms:
        keys, rid, slug = _entry(h.map.get(r))
        _hold, why = h._room(r, now)
        rec = {"hold": out[r], "reasons": why, "db_hold": bool([x for x in why if x != "health_stale"]) if why != ["clear"] else False,
               "machine": keys, "room_id": rid, "slug": slug, "rows": {}}
        pd = (h.data.get("presence") or ({}, 0))[0]
        if keys and pd:
            rec["rows"]["presence"] = {"hb": sum(1 for x in pd["hb"] if x[0] in keys), "enc": sum(1 for x in pd["enc"] if x[0] in keys), "post": sum(1 for x in pd["post"] if x[0] in keys),
                                       "enc_newest": {x[0]: x[1] for x in pd["enc"] if x[0] in keys}, "post_newest": {x[0]: x[1] for x in pd["post"] if x[0] in keys}}
        sd_ = h.data.get("session")
        if rid and sd_:
            rec["rows"]["session"] = {"open": 1 if rid in sd_[0] else 0}
        ld = h.data.get("levels")
        if rid and ld:
            rec["rows"]["levels"] = {"rows": sum(1 for x in ld[0] if x[0] == rid), "active_recent": any(x[0] == rid and x[1] is not None and (not _finite(x[1]) or now - x[1] <= LEVEL_FRESH_S) for x in ld[0])}
        wd = h.data.get("windows")
        if h.windows_on and slug and wd:
            rec["rows"]["windows"] = {"rows": sum(1 for x in wd[0] if x[0] == slug)}
        rooms_out[r] = rec
    return {"rooms": rooms_out, "source_errors": {n: bool(h.err.get(n)) for n in ("presence", "session", "levels", "windows") if n in h.err},
            "item_bad": {n: sorted(v) for n, v in h.item_bad.items() if v}, "errors": errors,
            "switches": {"capture_closed_counts_quiet": h.closed_quiet, "open_session_requires_levels": h.need_levels, "consult_windows_enabled": h.windows_on, "post_open_overrides_url_close": h.post_override}}


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "--probe":
        try:
            print(json.dumps(probe(sys.argv[2]), sort_keys=True, indent=1))
        except Exception as e:             # noqa: BLE001
            try:
                with open(sys.argv[2]) as f:
                    url_file = json.load(f).get("consult_db_url_file")
            except Exception:              # noqa: BLE001
                url_file = None
            print(f"probe failed: {type(e).__name__}: {_redactor(url_file if isinstance(url_file, str) else None)(e)}", file=sys.stderr); sys.exit(2)
    else:
        print("usage: consult_hold.py --probe <router.json-like file>", file=sys.stderr); sys.exit(64)
