"""subscriber.py -- Mini subscriber for the Room Guardian pipe (FR-1 C4). Clock, source, sinks and the data dir are injected.

* Streams kiosk/<room>/health, heal, probe-reply -> JSONL under <data>/<YYYY-MM-DD>/<room>.<stream>.jsonl; days older than KEEP_DAYS are pruned.
* Quiet detection is HERE, not pipe `monitor` (R4): a room with no health line for QUIET_AFTER_S raises guardian_quiet once (edge), and a
  line after that closes it. A room is counted from process start, so a room that never speaks is quiet too.
* A heal line is validated strictly (validate_heal). Valid lines route as follows (INFERRED shape, see COREAUDIO-HEAL-MINI-15OCT.md):
  a `kind` in HEAL_KINDS (capture_dead, capture_muted, coreaudio_heal_failed, recorder_changed) opens that case; no `kind` and result "escalated" or "failed"
  with action "coreaudiod_restart" opens coreaudio_heal_failed; no `kind` and result "escalated" otherwise raises heal_escalated (older rule);
  result "ok"/"healed" without a kind closes heal_escalated; "healed", "would_do" and a "failed" without that action are logged only.
  Anything else (not an object, unknown kind, unknown result, neither kind nor result, not JSON) is stored/logged and opens ONE heal_message_invalid case.
* A health line with a numeric zero_ratio < 0.05 closes open capture_dead, capture_muted and coreaudio_heal_failed cases for that room.
* Serves control: control_snapshot() = {"kill": bool, "modes": {room: "shadow"|"heal"}} from files; publish_control() sends it on topic
  guardian/control. Anything not exactly "heal" is "shadow". An unreadable or missing kill file is kill=true (fail safe).
Health/heal/probe lines are stored as received. Nothing here prints line content.
"""
import json, os, re, shutil, time
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
STREAMS = ("health", "heal", "probe-reply")
QUIET_AFTER_S, KEEP_DAYS = 120, 30
HEAL_KINDS = ("capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_changed")
HEAL_RESULTS = ("ok", "healed", "failed", "escalated", "would_do")
ZERO_RATIO_OK = 0.05
RAW_CAP = 2000


def validate_heal(obj):
    """Strict heal-line check. Returns (True, None) or (False, reason); the reason is from a fixed set and never echoes line content."""
    if not isinstance(obj, dict):
        return False, "not_an_object"
    kind, res = obj.get("kind"), obj.get("result")
    if "kind" not in obj and "result" not in obj:
        return False, "no_kind_or_result"
    if "kind" in obj and (not isinstance(kind, str) or kind not in HEAL_KINDS):
        return False, "unknown_kind"
    if "result" in obj and (not isinstance(res, str) or res.lower() not in HEAL_RESULTS):
        return False, "unknown_result"
    return True, None


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
                self.sink.capture_recovered(room, now)
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
        self.sink.heal_invalid(room, now)

    # INFERRED heal record shape (FR-1 2.4 and SPEC-COREAUDIO-HEAL section 5/6): {"kind"?, "result"?, "action"?, ...}. Unverified against C1.1.
    def _on_heal(self, room, obj, now):
        ok, _why = validate_heal(obj)
        if not ok:
            self.sink.heal_invalid(room, now)
            return
        res = str(obj.get("result", "")).lower()
        if obj.get("kind") in HEAL_KINDS:
            self.sink.heal_kind(room, obj["kind"], now)
        elif res in ("escalated", "failed") and obj.get("action") == "coreaudiod_restart":
            self.sink.heal_kind(room, "coreaudio_heal_failed", now)
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
