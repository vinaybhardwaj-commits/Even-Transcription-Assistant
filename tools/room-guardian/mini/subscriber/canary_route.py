"""canary_route.py -- FR1-C5 (Mini side): the nightly Guardian canary events from the kiosk (topic kiosk/<room>/canary, one JSON line per run) become cases.
SHADOW: the Mini only ALERTS on a canary event. It takes no action of any kind (no play, no command, no reboot, no write to a kiosk); a canary line only ever opens or closes a case.
R16d (kiosk 257b23c1): the line also carries "slot" ("pm" 21:40 or "am" 07:20, or null), "pass_db", "plays" (0 to 2 measured plays, 7 numeric/bool-or-null members each) and "pass_db_band", appended after
"output". Both shapes are accepted. The Mini stores the line as sent (the plays array is in the stream file) and never recomputes the kiosk's verdict. The raw `night` field is the IST DATE of
the slot, so the 21:40 slot of date D and the 07:20 slot of D+1 are the same clinical night: every dedupe, streak, stale-night and pass rule here uses the IST 12:00-12:00 night of `ts`
(ist_night_of), and the `night` field is only checked to be within a day of it.
Line shape (kiosk lib/canary.sh canary_event): {"room_id", "install_id", "ts", "action": "canary", "night": "YYYYMMDD", "result", "mode", "pre_db", "burst_db", "rise_db", "volume", "output"}.
Validation is strict: exactly these keys (no more, no fewer), the types below, the result vocabulary, the room_id equals the topic room, no duplicate JSON keys. A line that fails gets
ONE audit line (<data>/<day>/<room>.canary-invalid.jsonl, the reason only). A `night` must be a real calendar date and the IST night of `ts` (12:00 to 12:00 IST) give or take one day and never a case.
Results: aborted:<why> (R16d-3, a play gate failed before play 1 or 2; eight fixed reasons) is a NORMAL-tier canary_inconclusive: never canary_failed, and neutral for the output_absent streak. pass (with a night not older than the night that opened the case) closes the room's open canary cases and breaks the output_absent streak. no_local_rise opens canary_failed (URGENT, a V kind with the coreaudio window: the router
treats it like capture_dead). inconclusive:<why> opens canary_inconclusive (NORMAL tier, not V); inconclusive:output_absent on two consecutive nights also opens canary_output_absent
(URGENT, not V). would_do is stored and gets one audit line (<room>.canary-audit.jsonl), never a case. A line whose ts is more than 36 h from the Mini clock (either direction; exactly 36 h acts) is stored and audited only, and moves no state. Each case kind opens at most once per room per night (the `night` key of the line), even after an ACK.
State (the nights already alerted and the last output_absent night) is kept in <data>/canary-state.json, so a restart neither re-opens a night nor forgets a streak."""
import json, math, os, re
from datetime import datetime, timedelta, timezone

KEYS = ("room_id", "install_id", "ts", "action", "night", "result", "mode", "pre_db", "burst_db", "rise_db", "volume", "output")             # the R15c / R16b line
KEYS_R16D = KEYS + ("slot", "pass_db", "plays", "pass_db_band")                                                                                # the R16d line: four fields appended after "output"
PLAY_KEYS = ("pre_db", "burst_db", "rise_db", "pre_db_band", "burst_db_band", "rise_db_band", "pass_broadband")
ABORT_WHY = ("outside_window", "consult_not_clear", "hid_unreadable", "hid_active", "recorder_failed", "recorder_busy", "not_recording", "tape_not_advancing")    # R16d-3, fixed by guardian-lead
SLOTS = ("pm", "am")                                                    # kiosk canary_slot_name; null outside both slots (a state_* refusal line)
RESULTS = ("pass", "would_do", "no_local_rise")
WHY_RE = re.compile(r"^[a-z0-9_]{1,40}$")
NIGHT_RE = re.compile(r"^[0-9]{8}$")          # the shape only; a real calendar date is checked with strptime (valid_night)
IST = timezone(timedelta(hours=5, minutes=30))
MODES = ("shadow", "heal")
STR_CAP = 200
TS_FAR_S = 36 * 3600                         # a line whose ts is further than this from the Mini clock is stored and audited only (never acted on)
CASE_KINDS = ("canary_failed", "canary_inconclusive", "canary_output_absent")
OUTPUT_ABSENT = "inconclusive:output_absent"


def _num(v):
    """A finite number that cannot overflow a float: an int beyond 2**63 (10**400 raises OverflowError in isfinite) is not a number here."""
    try:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return False
        if isinstance(v, int):
            return abs(v) < 2 ** 63
        return math.isfinite(v)
    except OverflowError:
        return False


def valid_night(night):
    """A real calendar date written YYYYMMDD (20260231 and 20250229 are refused)."""
    if not (isinstance(night, str) and NIGHT_RE.fullmatch(night)):
        return False
    try:
        datetime.strptime(night, "%Y%m%d")
        return True
    except ValueError:
        return False


def ist_night_of(ts):
    """The IST night a timestamp belongs to. The night runs 12:00 to 12:00 IST, so it is the date of (ts - 12 h) in IST. -> 'YYYYMMDD', or None for a ts out of range."""
    try:
        return (datetime.fromtimestamp(ts, IST) - timedelta(hours=12)).strftime("%Y%m%d")
    except (OverflowError, OSError, ValueError):
        return None


def _numnull(v):
    return v is None or _num(v)


def _strnull(v):
    return v is None or (isinstance(v, str) and len(v) <= STR_CAP)


def validate(obj, room):
    """-> (True, "") or (False, why). `why` is a fixed word, never the line's content."""
    if not isinstance(obj, dict):
        return False, "not_an_object"
    r16d = set(obj) == set(KEYS_R16D)
    if set(obj) != set(KEYS) and not r16d:
        return False, "keys"                      # exactly the R15c line or exactly the R16d line: no more, no fewer
    if obj["room_id"] != room:
        return False, "room_mismatch"
    if obj["action"] != "canary":
        return False, "action"
    if not valid_night(obj["night"]):
        return False, "night"
    if not _num(obj["ts"]) or obj["ts"] <= 0:
        return False, "ts"
    expect = ist_night_of(obj["ts"])
    if expect is None:
        return False, "ts"
    if abs((datetime.strptime(obj["night"], "%Y%m%d") - datetime.strptime(expect, "%Y%m%d")).days) > 1:
        return False, "night_ts"                 # the night must be the IST night of ts (12:00 to 12:00), give or take one day
    r = obj["result"]
    if not isinstance(r, str):
        return False, "result_type"
    aborted = r.startswith("aborted:")
    if aborted:
        if r[len("aborted:"):] not in ABORT_WHY:
            return False, "result"                # exactly the eight reasons guardian-lead fixed; anything else is invalid
    elif r not in RESULTS and not (r.startswith("inconclusive:") and WHY_RE.fullmatch(r[len("inconclusive:"):])):
        return False, "result"
    if obj["mode"] not in MODES:
        return False, "mode"
    if not _strnull(obj["install_id"]) or not _strnull(obj["output"]):
        return False, "string_field"
    if not all(_numnull(obj[k]) for k in ("pre_db", "burst_db", "rise_db", "volume")):
        return False, "number_field"
    if aborted and (not r16d or obj["slot"] not in SLOTS):
        return False, "slot"                      # an aborted line comes from the R16d kiosk and always names its committed slot, never null
    if r16d:
        if obj["slot"] is not None and obj["slot"] not in SLOTS:
            return False, "slot"
        if not _numnull(obj["pass_db"]) or not _numnull(obj["pass_db_band"]):
            return False, "number_field"
        plays = obj["plays"]
        if not isinstance(plays, list) or len(plays) > 2:
            return False, "plays"
        for pl in plays:
            if not isinstance(pl, dict) or set(pl) != set(PLAY_KEYS):
                return False, "plays"
            if not all(_numnull(pl[k]) for k in PLAY_KEYS[:6]) or not (pl["pass_broadband"] is None or isinstance(pl["pass_broadband"], bool)):
                return False, "plays"
    return True, ""


def _next_night(night):
    return (datetime.strptime(night, "%Y%m%d") + timedelta(days=1)).strftime("%Y%m%d")


class CanaryRoute:
    def __init__(self, sink, state_path=None, audit_dir=None, clock=None):
        self.sink, self.state_path, self.audit_dir, self.clock = sink, state_path, audit_dir, clock
        self.state = {}                  # room -> {"opened": {kind: night}, "absent_night": night|None}
        if state_path and os.path.exists(state_path):
            try:
                with open(state_path) as f:
                    d = json.load(f)
                if not isinstance(d, dict):
                    self._audit_state("file", "-")          # a state file that is not an object: dropped whole
                    d = {}
                limit = None                   # the newest night a genuine line can carry: the night of (clock + 36 h), plus the one day the night/ts rule allows
                if callable(clock):
                    n = ist_night_of(clock() + TS_FAR_S)
                    limit = _next_night(n) if n else None
                for k, v in d.items():
                    if not isinstance(v, dict):
                        self._audit_state("entry", k); continue
                    if not isinstance(v.get("opened"), dict):
                        self._audit_state("opened", k)      # the room's entry is kept without its opened nights (a valid absent_night survives)
                        v = dict(v, opened={})
                    opened = {}
                    for a, b in v["opened"].items():
                        if a in CASE_KINDS and valid_night(b) and (limit is None or b <= limit):
                            opened[a] = b
                        else:
                            self._audit_state("opened" if not (valid_night(b) and limit is not None and b > limit) else "opened_future", k)     # a stored night from a skewed clock must not silence the room
                    absent = v.get("absent_night")
                    if absent is not None and not (valid_night(absent) and (limit is None or absent <= limit)):
                        self._audit_state("absent_night" if not (valid_night(absent) and limit is not None and absent > limit) else "absent_night_future", k); absent = None
                    self.state[str(k)] = {"opened": opened, "absent_night": absent}
            except Exception:            # noqa: BLE001 -- a corrupt or poisoned state file never stops the subscriber: what cannot be read is dropped
                self._audit_state("file", "-")

    def _audit_state(self, field, room):
        """One audit line per stored value dropped on load (a night that is not a real date). Never raises."""
        if not self.audit_dir:
            return
        try:
            with open(os.path.join(self.audit_dir, "canary-state-audit.jsonl"), "a") as f:
                f.write(json.dumps({"event": "state_value_dropped", "field": field, "room": str(room)[:64]}, sort_keys=True) + "\n")
        except OSError:
            pass

    def _save(self):
        if not self.state_path:
            return
        try:
            tmp = f"{self.state_path}.tmp{os.getpid()}"
            with open(tmp, "w") as f:
                json.dump(self.state, f, sort_keys=True)
            os.replace(tmp, self.state_path)
        except OSError:                  # best effort: the in-memory state still dedupes in this process
            pass

    def audit_invalid(self, room, why, now, day_dir):
        try:
            os.makedirs(day_dir, exist_ok=True)
            with open(os.path.join(day_dir, f"{room}.canary-invalid.jsonl"), "a") as f:
                f.write(json.dumps({"ts": int(now), "room": room, "why": why}, sort_keys=True) + "\n")
        except OSError:
            pass

    def audit_would_do(self, room, night, now, day_dir):
        """One audit line per would_do (the line itself is stored in the stream file by the caller)."""
        self._audit_event(room, "would_do", night, now, day_dir)

    def _audit_event(self, room, event, night, now, day_dir, **kw):
        try:
            os.makedirs(day_dir, exist_ok=True)
            with open(os.path.join(day_dir, f"{room}.canary-audit.jsonl"), "a") as f:
                f.write(json.dumps(dict(kw, ts=int(now), room=room, event=event, night=night), sort_keys=True) + "\n")
        except OSError:
            pass

    def _open_once(self, room, kind, night, now, day_dir=None):
        """-> "opened", "same" (this kind already opened for this room tonight; also after an ACK closed it) or "stale". A night OLDER than the stored one is stored and audited only:
        it never opens, never folds into the open case and never moves the state, and the stored night never goes backwards."""
        st = self.state.setdefault(room, {"opened": {}, "absent_night": None})
        stored = st["opened"].get(kind)
        if stored is not None and night < stored:
            if day_dir:
                self._audit_event(room, "stale_night", night, now, day_dir, kind=kind, stored=stored)
            return "stale"
        if stored == night:
            return "same"
        self.sink.canary_case(room, kind, now)
        st["opened"][kind] = night if stored is None else max(stored, night)      # recorded only after the sink took it: a store fault is retried by the next line of the night
        return "opened"

    def handle(self, room, raw_obj, dup, now, day_dir):
        """-> "invalid" | "stored" | "case" | "closed". Never raises on a bad line; a sink fault propagates to the caller (which logs it and keeps reading)."""
        ok, why = validate(raw_obj, room)
        if ok and dup:
            ok, why = False, "duplicate_keys"
        if not ok:
            self.audit_invalid(room, why, now, day_dir)
            return "invalid"
        res = raw_obj["result"]
        # The clinical night: the IST 12:00-12:00 night of the line's ts, NOT the raw `night` field (R16d: `night` is the IST date of the slot, and the 21:40 slot of date D and
        # the 07:20 slot of date D+1 are the SAME night). Validation has already checked the field is within a day of it.
        night = ist_night_of(raw_obj["ts"])
        if abs(raw_obj["ts"] - now) > TS_FAR_S:
            # A ts more than 36 h from the Mini clock, in EITHER direction (exactly 36 h still acts; 36 h + 1 s does not): stored (by the caller) and audited ONLY. It never opens, folds,
            # closes or moves any state (opened, absent_night, the streak), so a kiosk with a skewed clock cannot freeze or mute the room. Runs before the stale-night check.
            self._audit_event(room, "ts_far", night, now, day_dir, line_ts=int(raw_obj["ts"]))
            return "stored"
        st = self.state.setdefault(room, {"opened": {}, "absent_night": None})
        if res == "would_do":
            self.audit_would_do(room, night, now, day_dir)
            return "stored"              # stored in the stream file by the caller; audited above; no case
        if res == "pass":
            closed = False
            for kind in CASE_KINDS:      # a pass closes a case only if its night is not older than the night that opened it (a replayed old pass cannot close today's case)
                opened_night = st["opened"].get(kind)
                if opened_night is None or night >= opened_night:
                    self.sink.canary_close(room, kind, now)
                    closed = True
            if st.get("absent_night") is None or night >= st["absent_night"]:
                st["absent_night"] = None
            self._save()
            return "closed" if closed else "stored"
        if res == "no_local_rise":
            opened = self._open_once(room, "canary_failed", night, now, day_dir) == "opened"
        else:
            r = self._open_once(room, "canary_inconclusive", night, now, day_dir)
            opened = r == "opened"
            if r == "stale":
                return "stored"          # a replayed older line moves nothing, not even the output_absent streak
            if res.startswith("aborted:"):
                pass                     # an aborted slot is neutral for the output_absent streak: it neither counts toward it nor breaks it
            elif res == OUTPUT_ABSENT:
                prev = st.get("absent_night")
                if prev is not None and _next_night(prev) == night:
                    opened = (self._open_once(room, "canary_output_absent", night, now, day_dir) == "opened") or opened
                if prev is None or night >= prev:
                    st["absent_night"] = night
            else:
                st["absent_night"] = None
        self._save()
        return "case" if opened else "stored"
