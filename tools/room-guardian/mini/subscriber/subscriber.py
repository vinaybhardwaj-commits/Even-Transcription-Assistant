"""subscriber.py -- Mini subscriber for the Room Guardian pipe (FR-1 C4). Clock, source, sinks and the data dir are injected.

* Streams kiosk/<room>/health, heal, probe-reply -> JSONL under <data>/<YYYY-MM-DD>/<room>.<stream>.jsonl; days older than KEEP_DAYS are pruned.
* Quiet detection is HERE, not pipe `monitor` (R4): a room with no health line for QUIET_AFTER_S raises guardian_quiet once (edge), and a
  line after that closes it. A room is counted from process start, so a room that never speaks is quiet too.
* Strict validation (validate_heal) applies ONLY to heal messages that carry `kind` (coreaudio_scope). Any other heal message (today's R9 shape, including its
  layer "coreaudio" lines, no kind) is stored and handled as before: result escalated -> heal_escalated, ok/healed -> closes it, nothing else, never an invalid case.
  An in-scope line has a kind in HEAL_KINDS (capture_dead, capture_muted, coreaudio_heal_failed, recorder_disturbed; recorder_changed is an alias) and opens that
  case. A line with action "coreaudiod_restart" and result healed/failed/escalated is also queued for the gating INBOX.
  An in-scope line (it has a kind) that fails the check (unknown kind or result, neither kind nor result, a contract field of the wrong type) is stored and opens ONE
  heal_message_invalid case per room. A line that is not JSON is logged to <room>.heal-invalid.jsonl only (it cannot be attributed to the coreaudio rule): no case.
* RECOVERY_LINES (4) consecutive health lines with a numeric zero_ratio < 0.05, all after the alert, close the room's open capture_dead, capture_muted and
  coreaudio_heal_failed cases. recorder_disturbed and heal_message_invalid close only on ACK.
* Every HEAL action line (action coreaudiod_restart, result healed / failed / escalated) is queued as one record for INBOX-FROM-GATING.md (inbox_line);
  the router job appends it and raises heal_inbox_stuck if that has not happened within 5 min.
* Serves control: control_snapshot() = {"kill": bool, "modes": {room: "shadow"|"heal"}} from files; publish_control() sends it on topic
  guardian/control. Anything not exactly "heal" is "shadow". An unreadable or missing kill file is kill=true (fail safe).
Health/heal/probe lines are stored as received. Nothing here prints line content.
"""
import json, os, re, shutil, time
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
STREAMS = ("health", "heal", "probe-reply")
QUIET_AFTER_S, KEEP_DAYS = 120, 30
HEAL_KINDS = ("capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_disturbed")
KIND_ALIASES = {"recorder_changed": "recorder_disturbed"}        # accepted for now; the canonical name is the gate's (CA-C5)
RECOVERY_LINES = 4                                               # consecutive health lines under ZERO_RATIO_OK (CA-C5)
HEAL_ACTION = "coreaudiod_restart"
HEAL_RESULTS = ("ok", "healed", "failed", "escalated", "would_do")
ZERO_RATIO_OK = 0.05
RAW_CAP = 2000


def coreaudio_scope(obj):
    """Strict validation applies ONLY to heal messages that carry a `kind` (the new coreaudio contract field). Every other heal message, including today's R9
    kiosk lines (heal.sh: {room_id, ts, action, layer, reason, before, after, result, shadow, target, severity}, which already use layer "coreaudio" with no kind),
    is stored and handled as before, never invalid. The layer alone decides nothing."""
    return isinstance(obj, dict) and "kind" in obj


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v


def _is_ratio_or_null(v):
    return v is None or (_is_num(v) and 0 <= v <= 1)


def _is_pid_or_null(v):
    return v is None or (isinstance(v, int) and not isinstance(v, bool) and v >= 0)


def validate_heal(obj):
    """Strict heal-line check for a coreaudio-scope message (see coreaudio_scope). Returns (True, None) or (False, reason); the reason is from a fixed set and
    never echoes line content. Contract fields (guardian-lead, 15 Oct): kind, result, mode, kill, control_age_s, guards, zero_ratio_before/after,
    coreaudiod_pid_before/after, recorder_pid_before/after. A field that is present must have the right type; none is required (the kiosk build is not out yet)."""
    if not isinstance(obj, dict):
        return False, "not_an_object"
    kind, res = obj.get("kind"), obj.get("result")
    if "kind" not in obj and "result" not in obj:
        return False, "no_kind_or_result"
    if "kind" in obj and (not isinstance(kind, str) or (kind not in HEAL_KINDS and kind not in KIND_ALIASES)):
        return False, "unknown_kind"
    if "result" in obj and (not isinstance(res, str) or res.lower() not in HEAL_RESULTS):
        return False, "unknown_result"
    if "mode" in obj and obj["mode"] not in ("shadow", "heal"):
        return False, "bad_mode"
    if "kill" in obj and not isinstance(obj["kill"], bool):
        return False, "bad_kill"
    if "control_age_s" in obj and not (obj["control_age_s"] is None or (_is_num(obj["control_age_s"]) and obj["control_age_s"] >= 0)):
        return False, "bad_control_age_s"
    if "guards" in obj and not isinstance(obj["guards"], dict):
        return False, "bad_guards"
    if any(k in obj and not _is_ratio_or_null(obj[k]) for k in ("zero_ratio_before", "zero_ratio_after")):
        return False, "bad_zero_ratio"
    if any(k in obj and not _is_pid_or_null(obj[k]) for k in ("coreaudiod_pid_before", "coreaudiod_pid_after", "recorder_pid_before", "recorder_pid_after")):
        return False, "bad_pid"
    return True, None


def _num(v):
    return f"{v:.4f}" if _is_num(v) and 0 <= v <= 1 else "?"


def inbox_line(room, obj, now):
    """CA-C6: the one-line HEAL action record for INBOX-FROM-GATING.md, or None. A HEAL action line is a valid heal line with action == coreaudiod_restart and
    result healed / failed / escalated (not would_do, not the older ok). Built only from the room slug, a fixed result word and numbers: no free text from the kiosk."""
    if not isinstance(obj, dict) or obj.get("action") != HEAL_ACTION or str(obj.get("result", "")).lower() not in ("healed", "failed", "escalated"):
        return None
    pb, pa = obj.get("recorder_pid_before"), obj.get("recorder_pid_after")
    if isinstance(pb, int) and isinstance(pa, int) and not isinstance(pb, bool) and not isinstance(pa, bool):
        same = "y" if pb == pa else "n"
    else:
        same = obj.get("recorder_pid_same")
        same = "y" if same is True else "n" if same is False else "?"
    when = datetime.fromtimestamp(now, IST).strftime("%d %b %H:%M")
    return (f"- {when} IST pico-router HEAL: room={room} result={str(obj['result']).lower()} "
            f"zero_ratio_before={_num(obj.get('zero_ratio_before'))} zero_ratio_after={_num(obj.get('zero_ratio_after'))} recorder_pid_same={same}")


def r9_inbox_line(room, obj, now):
    """CA-C6 for the kiosk's R9 coreaudio heal (heal.sh, no `kind`): a message with layer "coreaudio" AND action "heal" that is not a WOULD-DO / shadow line, so a
    real restart attempt (results ok, no_restart_seen). Same record as inbox_line; the numbers R9 does not send print `?`. The result is one lowercase word from the
    line ([a-z0-9_], at most 32) or `other`, and coreaudiod_pid_changed is read from the `after` text, so no free text from the kiosk reaches the file."""
    if not isinstance(obj, dict) or obj.get("layer") != "coreaudio" or obj.get("action") != "heal" or obj.get("shadow") is True:
        return None
    res = obj.get("result")
    if not isinstance(res, str) or res.upper().startswith("WOULD"):
        return None
    word = res if re.fullmatch(r"[a-z0-9_]{1,32}", res) else "other"
    after = obj.get("after") if isinstance(obj.get("after"), str) else ""
    changed = "y" if "coreaudiod_pid_changed=true" in after else "n" if "coreaudiod_pid_changed=false" in after else "?"
    when = datetime.fromtimestamp(now, IST).strftime("%d %b %H:%M")
    return (f"- {when} IST pico-router HEAL: room={room} result={word} zero_ratio_before=? zero_ratio_after=? recorder_pid_same=? coreaudiod_pid_changed={changed}")


def zero_ratio(obj):
    """The health line's zero_ratio (INFERRED field name) as a float in [0, 1], else None."""
    v = obj.get("zero_ratio") if isinstance(obj, dict) else None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v < 0 or v > 1:
        return None
    return float(v)
CONTROL_TOPIC = "guardian/control"
# FROZEN CONTRACT (see etc/README.md "Control topic contract"): the kiosk accepts only this exact form; anything else kills every kiosk.
# Changing any of it needs a coordinated kiosk release (guardian-lead) FIRST. Regex is the kiosk's, verbatim from FR1-C1-CONTROL-CC-KICKOFF "## R7".
CONTROL_RE = re.compile(r'^\{"kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$')
SLUG_RE = re.compile(r"[a-z0-9_-]{1,64}")
# The contract limit is 4096 (kiosk R8: payload line <= 4096, file <= 4096+17); the Mini caps itself at 4000 as extra margin.
CONTROL_MAX_BYTES, CONTROL_MAX_ROOMS = 4000, 64


def canonical_control(payload):
    """The one serialisation the Mini may publish: json.dumps(payload, sort_keys=True) with the default separators. Raises ValueError (and so
    nothing is published; kiosks go stale and kill) if the result is not exactly the frozen form, or is over 4000 bytes, or has a byte outside 0x20-0x7E."""
    msg = json.dumps(payload, sort_keys=True)
    if len(msg.encode("ascii", "replace")) > CONTROL_MAX_BYTES:
        raise ValueError("control payload over 4000 bytes")
    if any(not (0x20 <= ord(ch) <= 0x7E) for ch in msg):
        raise ValueError("control payload has a byte outside 0x20-0x7E")
    if not CONTROL_RE.fullmatch(msg):
        raise ValueError("control payload is not the canonical form")
    return msg


def validate_rooms(rooms):
    """Startup check for rooms.json: every slug ^[a-z0-9_-]{1,64}$, at most 64 distinct rooms, and the worst-case payload (every mode shadow, 15-digit ts)
    still within the contract (<= 4000 bytes). Returns an error string, or None."""
    if not isinstance(rooms, list):                  # a bare string would iterate as one room per character
        return f"rooms must be a JSON list, got {type(rooms).__name__}"
    bad = [r for r in rooms if not isinstance(r, str) or not SLUG_RE.fullmatch(r)]
    if bad:
        return f"{len(bad)} room slug(s) not matching [a-z0-9_-]{{1,64}}"
    if len(set(rooms)) != len(rooms):
        return "duplicate room slugs"
    if len(rooms) > CONTROL_MAX_ROOMS:
        return f"{len(rooms)} rooms; the control contract allows at most {CONTROL_MAX_ROOMS}"
    try:
        canonical_control({"kill": False, "modes": {r: "shadow" for r in rooms}, "ts": 10 ** 14})
    except ValueError as e:
        return f"worst-case control payload: {e}"
    return None


def parse_topic(topic):
    p = topic.split("/")
    if len(p) == 3 and p[0] == "kiosk" and p[2] in STREAMS and p[1] and all(ch.isalnum() or ch in "-_" for ch in p[1]):
        return p[1], p[2]
    return None


class RouterSink:
    """Hands Mini-detected alerts straight to the router (C4 R2 ruling 2): same case open / ack / re-page / close path and bus post format as server
    alerts, source=mini in the body. They never touch the server outbox. Case ids come from the store's local_seq counter (LOCAL_ID_BASE + seq).
    Phase 0 R2 (MF1): opening and closing a case only writes the store (the router job pages within one tick), so no bus is built here and a dead
    or paused ubus can never lose a case. bus_factory is kept in the signature for callers and is not used."""
    def __init__(self, router, bus_factory=None):
        self.router, self.bus_factory = router, bus_factory

    def open_quiet_rooms(self):
        return [c["room_id"] for c in self.router.store.list_open() if c["kind"] == "guardian_quiet"]

    def _open(self, room, kind, now):
        row = {"id": self.router.store.alloc_local_id(), "kind": kind, "room_ids": [room], "room_name": room}
        self.router.on_row(None, row)

    def guardian_quiet(self, room, quiet_s, now):
        self._open(room, "guardian_quiet", now)

    def guardian_recovered(self, room, now):
        self.router.close_room(None, room, "recovery", kind="guardian_quiet")

    def heal_escalated(self, room, now):
        self._open(room, "heal_escalated", now)

    def heal_resolved(self, room, now):
        self.router.close_room(None, room, "recovery", kind="heal_escalated")

    def heal_kind(self, room, kind, now):
        self._open(room, kind, now)

    def heal_action(self, room, line, now):
        self.router.store.add_inbox(line, now)          # durable queue; the router job appends it to the gating INBOX and alarms if it cannot

    def heal_invalid(self, room, now):
        self._open(room, "heal_message_invalid", now)

    def capture_recovered(self, room, now):
        """Health zero_ratio back under 0.05: close the audio cases of this room. recorder_changed is NOT closed here (audio back says nothing about the recorder)."""
        kinds = {"capture_dead", "capture_muted", "coreaudio_heal_failed"}
        for k in {c["kind"] for c in self.router.store.list_open() if c["room_id"] == room and c["kind"] in kinds}:
            self.router.close_room(None, room, "recovery", kind=k)


class Subscriber:
    def __init__(self, data_dir, control_dir, rooms, sink, clock=time.time, quiet_after_s=QUIET_AFTER_S, quiet_seed=()):
        self.data, self.ctl, self.rooms, self.sink, self.clock, self.quiet_after = data_dir, control_dir, list(rooms), sink, clock, quiet_after_s
        os.makedirs(data_dir, exist_ok=True)
        t0 = clock()
        self.last_seen = {r: t0 for r in self.rooms}
        self.ok_streak = {}                                # room -> consecutive health lines with zero_ratio < ZERO_RATIO_OK
        self.quiet = set(quiet_seed) & set(self.rooms)   # rooms whose guardian_quiet case is still open (R3): a restart must not forget them

    # ---- ingest
    def on_line(self, topic, raw):
        pt = parse_topic(topic)
        if not pt:
            return False
        room, stream = pt
        try:
            obj = json.loads(raw)
        except (TypeError, ValueError):
            if stream == "heal":              # a malformed heal line is logged (own file, capped, JSON-quoted) and raises the invalid case
                self._log_invalid_heal(room, raw)
            return False                      # not JSON: never stored in the stream file
        now = self.clock()
        day = datetime.fromtimestamp(now, IST).strftime("%Y-%m-%d")
        d = os.path.join(self.data, day)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{room}.{stream}.jsonl"), "a") as f:
            f.write(raw.rstrip("\n") + "\n")
        if stream == "heal":
            self._on_heal(room, obj, now)
        if stream == "health":
            zr = zero_ratio(obj)
            if zr is not None and zr < ZERO_RATIO_OK:
                self.ok_streak[room] = self.ok_streak.get(room, 0) + 1
                if self.ok_streak[room] >= RECOVERY_LINES:
                    self.sink.capture_recovered(room, now)
            else:
                self.ok_streak[room] = 0
            self.last_seen[room] = now
            if room in self.quiet:
                self.quiet.discard(room)
                self.sink.guardian_recovered(room, now)
        return True

    def _log_invalid_heal(self, room, raw):
        now = self.clock()
        d = os.path.join(self.data, datetime.fromtimestamp(now, IST).strftime("%Y-%m-%d"))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{room}.heal-invalid.jsonl"), "a") as f:
            f.write(json.dumps({"ts": int(now), "raw": str(raw)[:RAW_CAP]}) + "\n")

    # INFERRED heal record shape (FR-1 2.4 and SPEC-COREAUDIO-HEAL section 5/6): {"kind"?, "result"?, "action"?, ...}. Unverified against C1.1.
    def _on_heal(self, room, obj, now):
        res = str(obj.get("result", "")).lower() if isinstance(obj, dict) else ""
        if not coreaudio_scope(obj):                       # R9 and every older heal shape: exactly the pre-coreaudio handling, never a new case
            line = r9_inbox_line(room, obj, now)           # (the one addition: a real R9 coreaudio heal action also goes to the gating INBOX)
            if line:
                self.sink.heal_action(room, line, now)
            if res == "escalated":
                self.sink.heal_escalated(room, now)
            elif res in ("ok", "healed"):
                self.sink.heal_resolved(room, now)
            return
        ok, _why = validate_heal(obj)
        if not ok:
            self.sink.heal_invalid(room, now)
            return
        line = inbox_line(room, obj, now)
        if line:
            self.sink.heal_action(room, line, now)
        kind = KIND_ALIASES.get(obj.get("kind"), obj.get("kind"))
        if kind in HEAL_KINDS:
            self.ok_streak[room] = 0                       # recovery must be seen AFTER the alert, so a good run before it cannot close it at once
            self.sink.heal_kind(room, kind, now)
        elif res == "escalated":
            self.sink.heal_escalated(room, now)
        elif res in ("ok", "healed"):
            self.sink.heal_resolved(room, now)

    # ---- quiet detection
    def check_quiet(self):
        now, raised = self.clock(), []
        for room, seen in self.last_seen.items():
            if now - seen > self.quiet_after and room not in self.quiet:
                self.quiet.add(room)
                self.sink.guardian_quiet(room, now - seen, now)
                raised.append(room)
        return raised

    # ---- 30-day rotation
    def prune(self):
        cutoff = (datetime.fromtimestamp(self.clock(), IST) - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
        gone = []
        for name in sorted(os.listdir(self.data)):
            p = os.path.join(self.data, name)
            if len(name) == 10 and name[4] == "-" and name[7] == "-" and name < cutoff and os.path.isdir(p):
                os.makedirs(os.path.join(self.data, "_to_delete"), exist_ok=True)   # no hard deletes (G4): rotated days are moved aside
                shutil.move(p, os.path.join(self.data, "_to_delete", name))
                gone.append(name)
        return gone

    # ---- control
    def control_snapshot(self):
        kill = True
        try:
            with open(os.path.join(self.ctl, "kill-switch")) as f:
                kill = f.read().strip().lower() not in ("off", "0", "false")
        except OSError:
            pass
        modes = {}
        for r in self.rooms:
            m = "shadow"
            try:
                with open(os.path.join(self.ctl, "modes", r)) as f:
                    if f.read().strip().lower() == "heal":
                        m = "heal"
            except OSError:
                pass
            modes[r] = m
        return {"kill": kill, "modes": modes}

    def control_payload(self):
        """control_snapshot() plus ts = publish epoch seconds (int), so a consumer can reject replayed or stale control by payload time. Additive."""
        snap = self.control_snapshot()
        snap["ts"] = int(self.clock())
        canonical_control(snap)                      # contract self-check: raises before anything is published
        return snap

    def control_message(self):
        """The exact string to publish (no trailing newline; the caller adds one line terminator)."""
        return canonical_control(self.control_payload())

    def publish_control(self, publish):
        snap = self.control_payload()
        publish(CONTROL_TOPIC, canonical_control(snap))
        return snap
