"""subscriber.py -- Mini subscriber for the Room Guardian pipe (FR-1 C4). Clock, source, sinks and the data dir are injected.

* Streams kiosk/<room>/health, heal, probe-reply, canary (FR1-C5, alerts only: see canary_route.py) -> JSONL under <data>/<YYYY-MM-DD>/<room>.<stream>.jsonl; days older than KEEP_DAYS are pruned.
* Quiet detection is HERE, not pipe `monitor` (R4): a room with no health line for QUIET_AFTER_S raises guardian_quiet once (edge), and a
  line after that closes it. A room is counted from process start, so a room that never speaks is quiet too.
* Strict validation (validate_heal) applies ONLY to heal messages that carry `kind` (coreaudio_scope). Any other heal message (today's R9 shape, including its
  layer "coreaudio" lines, no kind) is stored and handled as before: result escalated -> heal_escalated, ok/healed -> closes it, nothing else, never an invalid case.
  An in-scope line has a kind in HEAL_KINDS (capture_dead, capture_muted, coreaudio_heal_failed, recorder_disturbed; recorder_changed is an alias). It opens that
  kind's case ONLY when result is failed or escalated, or when result is absent (fail closed). result healed or would_do: stored, no case, no page. EXCEPT
  recorder_disturbed (and its alias recorder_changed): CA-C5 makes any recorder pid change top severity even if audio is back, so it opens its case for ANY
  result (healed, would_do, unknown, none) and even when the line fails validation (which then also opens heal_message_invalid). An unknown
  result (including the older "ok") fails validation: one heal_message_invalid case. Results healed / failed / escalated are also queued for the gating INBOX,
  whatever the action; would_do never is.
  An in-scope line (it has a kind) that fails the check (unknown kind or result, neither kind nor result, a contract field of the wrong type) is stored and opens ONE
  heal_message_invalid case per room. A line that is not JSON is logged to <room>.heal-invalid.jsonl only (it cannot be attributed to the coreaudio rule): no case.
* RECOVERY_LINES (4) consecutive health lines with a numeric zero_ratio < 0.05, all after the alert, close the room's open capture_dead, capture_muted and
  coreaudio_heal_failed cases. recorder_disturbed and heal_message_invalid close only on ACK.
* Every kind line with result healed / failed / escalated is queued as one record for INBOX-FROM-GATING.md (inbox_line);
  the router job appends it and raises heal_inbox_stuck if that has not happened within 5 min.
* Serves control: control_snapshot() = {"kill": bool, "modes": {room: "shadow"|"heal"}} from files; publish_control() sends it on topic
  guardian/control. Anything not exactly "heal" is "shadow". An unreadable or missing kill file is kill=true (fail safe).
Health/heal/probe lines are stored as received. Nothing here prints line content.
"""
import json, os, re, shutil, time
from datetime import datetime, timedelta, timezone
from canary_route import CanaryRoute

IST = timezone(timedelta(hours=5, minutes=30))
STREAMS = ("health", "heal", "probe-reply", "canary")
QUIET_AFTER_S, KEEP_DAYS = 120, 30
HEAL_KINDS = ("capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_disturbed")
KIND_ALIASES = {"recorder_changed": "recorder_disturbed"}        # accepted for now; the canonical name is the gate's (CA-C5)
RECOVERY_LINES = 4                                               # consecutive health lines under ZERO_RATIO_OK (CA-C5)
HEAL_ACTION = "coreaudiod_restart"
ALWAYS_OPEN_KIND = "recorder_disturbed"                         # opens its case whatever the result (CA-C5); recorder_changed is its alias
HEAL_RESULTS = ("healed", "failed", "escalated", "would_do")      # the contract set for a kind line; the older "ok" is NOT one of them
OPEN_RESULTS = ("failed", "escalated")                            # a kind line opens its case only on these (or when `result` is absent)
INBOX_RESULTS = ("healed", "failed", "escalated")                 # and is queued for the gating INBOX on these, whatever the action (never would_do)
ZERO_RATIO_OK = 0.05
RAW_CAP = 2000
# FR1 2.4 d' (guardian-lead): the kiosk sends NO `kind` on its USB lines; they are keyed on layer + action + reason + result (outside the strict coreaudio scope).
USB_LAYER = "usb"
USB_ESCALATIONS = {"usb_reboot_failed": "usb_reboot_failed", "usb_power_off_recurring": "usb_power_off_recurring", "usb_device_missing": "usb_device_missing"}
USB_REBOOT_ACTION, USB_REBOOT_REASON = "kiosk_reboot", "usb_power_off"


class _Dup(Exception):
    pass


def loads_dupcheck(raw):
    """json.loads that also reports duplicate keys in any object (S2). -> (obj, duplicate_found). The last value wins, as json.loads does."""
    found = []

    def hook(pairs):
        keys = [k for k, _ in pairs]
        if len(keys) != len(set(keys)):
            found.append(True)
        return dict(pairs)
    return json.loads(raw, object_pairs_hook=hook), bool(found)


def _w(v):
    return v.strip().lower() if isinstance(v, str) else ""


def usb_scope(obj):
    """A kiosk d' USB line: a dict with layer "usb" and NO `kind` key (a kind line is the strict coreaudio contract and is handled there)."""
    return isinstance(obj, dict) and "kind" not in obj and _w(obj.get("layer")) == USB_LAYER


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
    """CA-C6: the one-line HEAL record for INBOX-FROM-GATING.md, or None. Called for a valid kind line; queued when the result is healed / failed / escalated,
    WHATEVER the action (the contract names coreaudiod_restart for a restart attempt and escalate for escalate-only results; the action is not trusted as the
    gate, so a drifted action word cannot hide a heal). Never would_do, never a line without a result. Built only from the room slug, a fixed result word and numbers:
    no free text from the kiosk."""
    if not isinstance(obj, dict) or str(obj.get("result", "")).lower() not in INBOX_RESULTS:
        return None
    if obj.get("mode") == "shadow" or obj.get("shadow") is True:      # S6: a SHADOW kind line logs and opens its case as before but never queues an INBOX line
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
    word = res.lower() if re.fullmatch(r"[a-z0-9_]{1,32}", res, re.I) else "other"
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
# consult_open form (FR1 2.4 d', contract CONTROL-CONSULT-OPEN-SHAPE-15OCT): sorted keys put consult_open first. Used only when the flag consult_open_publish is on.
CONTROL_RE_V2 = re.compile(r'^\{"consult_open": \{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}, "kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$')
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
    if not (CONTROL_RE_V2 if isinstance(payload, dict) and "consult_open" in payload else CONTROL_RE).fullmatch(msg):
        raise ValueError("control payload is not the canonical form")
    return msg


def validate_rooms(rooms, consult_open=False):
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
        worst = {"kill": False, "modes": {r: "shadow" for r in rooms}, "ts": 10 ** 14}
        if consult_open:
            worst["consult_open"] = {r: False for r in rooms}      # "false" is the longer word
        canonical_control(worst)
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

    def open_rooms(self, kind):
        return [c["room_id"] for c in self.router.store.list_open() if c["kind"] == kind]

    def usb_case(self, room, kind, now):
        self._open(room, kind, now)

    def usb_device_back(self, room, now):
        self.router.close_room(None, room, "recovery", kind="usb_device_missing")

    def consult_hold_source_down(self, now):
        self._open("mini", "consult_hold_source_down", now)

    def consult_hold_source_up(self, now):
        self.router.close_room(None, "mini", "source recovered", kind="consult_hold_source_down")

    def start_day_failed(self, room, now):
        self._open(room, "start_day_failed", now)

    def canary_case(self, room, kind, now):
        self._open(room, kind, now)

    def canary_close(self, room, kind, now):
        """A canary pass closes this canary case of the room (CanaryRoute decides which kinds, by night)."""
        self.router.close_room(None, room, "canary pass", kind=kind)

    def capture_recovered(self, room, now):
        """Health zero_ratio back under 0.05: close the audio cases of this room. recorder_changed is NOT closed here (audio back says nothing about the recorder)."""
        kinds = {"capture_dead", "capture_muted", "coreaudio_heal_failed"}
        for k in {c["kind"] for c in self.router.store.list_open() if c["room_id"] == room and c["kind"] in kinds}:
            self.router.close_room(None, room, "recovery", kind=k)


class Subscriber:
    def __init__(self, data_dir, control_dir, rooms, sink, clock=time.time, quiet_after_s=QUIET_AFTER_S, quiet_seed=(), consult=None, start_day=None, usb_verify=None, usb_missing_seed=()):
        self.data, self.ctl, self.rooms, self.sink, self.clock, self.quiet_after = data_dir, control_dir, list(rooms), sink, clock, quiet_after_s
        self.consult, self.start_day = consult, start_day     # FR1 2.4 d': both None (off) unless their flag is on
        self.usb_verify = usb_verify                          # the F2 Mini verify (always on once a healed_pending line arrives)
        self.usb_missing = set(usb_missing_seed) & set(self.rooms)   # rooms with an open usb_device_missing case: closed by a health line with usb_mic_present true
        self.last_health = {}                                 # room -> (receive time, obj) of the newest health line
        self.canary = CanaryRoute(sink, os.path.join(data_dir, "canary-state.json"), data_dir, clock)     # FR1-C5: SHADOW, alerts only (see canary_route.py)
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
            obj, dup = loads_dupcheck(raw)
        except (TypeError, ValueError):
            if stream == "heal":              # a non-JSON heal line is logged only (own file, capped, JSON-quoted): no case
                self._log_invalid_heal(room, raw)
            elif stream == "canary":          # a non-JSON canary line is not stored; it gets one audit line (also a 5000-digit integer, which Python refuses)
                t = self.clock()
                self.canary.audit_invalid(room, "not_json", t, os.path.join(self.data, datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")))
            return False                      # not JSON: never stored in the stream file
        now = self.clock()
        day = datetime.fromtimestamp(now, IST).strftime("%Y-%m-%d")
        d = os.path.join(self.data, day)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{room}.{stream}.jsonl"), "a") as f:
            f.write(raw.rstrip("\n") + "\n")
        if stream == "heal":
            self._on_heal(room, obj, now, dup)
        if stream == "canary":
            self.canary.handle(room, obj, dup, now, d)      # the line is already stored above; this only validates it and opens or closes cases
        if stream == "health":
            if isinstance(obj, dict):
                self.last_health[room] = (now, obj)
            if self.usb_verify is not None:
                self.usb_verify.on_health(room, obj, now)
            if room in self.usb_missing and isinstance(obj, dict) and obj.get("usb_mic_present") is True:
                try:
                    self.sink.usb_device_back(room, now)
                    self.usb_missing.discard(room)
                except Exception:          # noqa: BLE001 -- retried on the next health line
                    pass
            if self.start_day is not None:
                try:                       # a start_day fault must never stop the rest of the health handling (zero_ratio, last_seen, the quiet edge)
                    self.start_day.on_health(room, obj, now)
                except Exception:          # noqa: BLE001
                    pass
            if self.consult is not None:
                try:
                    self.consult.note_health(room, obj, now)
                except Exception:          # noqa: BLE001
                    pass
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
    def _log_dup_keys(self, room, raw_obj, now):
        d = os.path.join(self.data, datetime.fromtimestamp(now, IST).strftime("%Y-%m-%d"))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{room}.heal-duplicate-keys.jsonl"), "a") as f:
            f.write(json.dumps({"ts": int(now), "room": room, "note": "duplicate JSON keys in a heal line; stored, no case"}) + "\n")

    def _on_heal(self, room, obj, now, dup=False):
        res = str(obj.get("result", "")).lower() if isinstance(obj, dict) else ""
        if dup and not coreaudio_scope(obj):
            try:                                           # S2: out of strict scope, a duplicate-key line is stored (above) plus one audit line, never a case
                self._log_dup_keys(room, obj, now)
            except OSError:
                pass
            return
        if not coreaudio_scope(obj):
            if usb_scope(obj) and self._on_usb(room, obj, now):
                return                       # R9 and every older heal shape: exactly the pre-coreaudio handling, never a new case
            line = r9_inbox_line(room, obj, now)           # (the one addition: a real R9 coreaudio heal action also goes to the gating INBOX)
            if line:
                self.sink.heal_action(room, line, now)
            if res == "escalated":
                self.sink.heal_escalated(room, now)
            elif res in ("ok", "healed"):
                self.sink.heal_resolved(room, now)
            return
        kind_raw = obj.get("kind")
        kind = KIND_ALIASES.get(kind_raw, kind_raw) if isinstance(kind_raw, str) else None
        always = kind == ALWAYS_OPEN_KIND                  # CA-C5: a recorder pid change is top severity "even if audio is back": its case opens for ANY result
        ok, _why = validate_heal(obj)
        if dup:
            ok = False                                     # S2: duplicate keys in a strict-scope line are an invalid heal line
        if not ok:
            if always:                                     # the recorder alert is never lost to a shape problem; the shape problem still surfaces as its own case
                self.ok_streak[room] = 0
                self.sink.heal_kind(room, kind, now)
            self.sink.heal_invalid(room, now)
            return
        line = inbox_line(room, obj, now)
        if line:
            self.sink.heal_action(room, line, now)
        if always or res in OPEN_RESULTS or not res:       # failed / escalated, or no result at all (cannot show it healed: fail closed to the kind's case)
            self.ok_streak[room] = 0                       # recovery must be seen AFTER the alert, so a good run before it cannot close it at once
            self.sink.heal_kind(room, kind, now)
        # healed / would_do (not recorder_disturbed): stored in the stream file, plus the INBOX line above for a real heal; no case, no page

    def _on_usb(self, room, obj, now):
        """FR1 2.4 d' routing of the kiosk's USB lines. -> True when the line was routed here, False to let the generic path handle it (so every other line keeps its
        old handling, and an unknown USB reason or result still reaches the generic heal_escalated case)."""
        action, reason, res = _w(obj.get("action")), _w(obj.get("reason")), _w(obj.get("result"))
        if action == "escalate" and res == "escalated" and reason in USB_ESCALATIONS:
            kind = USB_ESCALATIONS[reason]
            self.sink.usb_case(room, kind, now)
            if kind == "usb_device_missing":
                self.usb_missing.add(room)
            return True
        if action == USB_REBOOT_ACTION and reason == USB_REBOOT_REASON:
            if res == "reboot_issued":
                return True                                # stored only: the event can be lost to the shutdown; healed_pending is the one to key on
            if res == "reboot_failed":
                self.sink.usb_case(room, "usb_reboot_failed", now)
                return True
            if res == "healed_pending":
                if self.usb_verify is not None:
                    self.usb_verify.start(room, now)       # F2: the Mini-side 15 min verify
                if self.start_day is not None:             # only with start_day_after_boot on (the object exists only then)
                    h = self.last_health.get(room)
                    if h is not None:
                        try:
                            self.start_day.on_health(room, h[1], h[0])
                        except Exception:  # noqa: BLE001
                            pass
                return True
        return False

    def check_consult_stuck(self):
        """The loop thread opens / closes the consult_hold_source_down case (the refresher thread only records when the sources went down)."""
        if self.consult is not None:
            try:
                self.consult.check_stuck(self.clock())
            except Exception:                              # noqa: BLE001
                pass

    def check_usb_verify(self):
        if self.usb_verify is not None:
            try:
                self.usb_verify.check(self.clock())
            except Exception:                              # noqa: BLE001
                pass

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
        snap = {"kill": kill, "modes": modes}
        if self.consult is not None:                 # flag consult_open_publish: every room in rooms.json, fail closed (true) inside ConsultHold
            try:
                hold = self.consult.hold(self.clock())
                snap["consult_open"] = {r: hold.get(r, True) is not False for r in self.rooms}
            except Exception:              # noqa: BLE001 -- the hold path may never take the control line down: every room is held
                snap["consult_open"] = {r: True for r in self.rooms}
        return snap

    def check_start_day(self):
        if self.start_day is not None:
            try:
                self.start_day.check(self.clock())
            except Exception:              # noqa: BLE001
                pass

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
