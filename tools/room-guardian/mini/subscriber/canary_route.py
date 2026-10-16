"""canary_route.py -- FR1-C5 (Mini side): the nightly Guardian canary events from the kiosk (topic kiosk/<room>/canary, one JSON line per run) become cases.
SHADOW: the Mini only ALERTS on a canary event. It takes no action of any kind (no play, no command, no reboot, no write to a kiosk); a canary line only ever opens or closes a case.
Line shape (kiosk lib/canary.sh canary_event): {"room_id", "install_id", "ts", "action": "canary", "night": "YYYYMMDD", "result", "mode", "pre_db", "burst_db", "rise_db", "volume", "output"}.
Validation is strict: exactly these keys (no more, no fewer), the types below, the result vocabulary, the room_id equals the topic room, no duplicate JSON keys. A line that fails gets
ONE audit line (<data>/<day>/<room>.canary-invalid.jsonl, the reason only) and never a case.
Results: pass closes the room's open canary cases and breaks the output_absent streak. no_local_rise opens canary_failed (URGENT, a V kind with the coreaudio window: the router
treats it like capture_dead). inconclusive:<why> opens canary_inconclusive (NORMAL tier, not V); inconclusive:output_absent on two consecutive nights also opens canary_output_absent
(URGENT, not V). would_do is stored and audited only, never a case. Each case kind opens at most once per room per night (the `night` key of the line), even after an ACK.
State (the nights already alerted and the last output_absent night) is kept in <data>/canary-state.json, so a restart neither re-opens a night nor forgets a streak."""
import json, math, os, re
from datetime import datetime, timedelta

KEYS = ("room_id", "install_id", "ts", "action", "night", "result", "mode", "pre_db", "burst_db", "rise_db", "volume", "output")
RESULTS = ("pass", "would_do", "no_local_rise")
WHY_RE = re.compile(r"^[a-z0-9_]{1,40}$")
NIGHT_RE = re.compile(r"^20[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$")
MODES = ("shadow", "heal")
STR_CAP = 200
CASE_KINDS = ("canary_failed", "canary_inconclusive", "canary_output_absent")
OUTPUT_ABSENT = "inconclusive:output_absent"


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _numnull(v):
    return v is None or _num(v)


def _strnull(v):
    return v is None or (isinstance(v, str) and len(v) <= STR_CAP)


def validate(obj, room):
    """-> (True, "") or (False, why). `why` is a fixed word, never the line's content."""
    if not isinstance(obj, dict):
        return False, "not_an_object"
    if set(obj) != set(KEYS):
        return False, "keys"
    if obj["room_id"] != room:
        return False, "room_mismatch"
    if obj["action"] != "canary":
        return False, "action"
    if not (isinstance(obj["night"], str) and NIGHT_RE.fullmatch(obj["night"])):
        return False, "night"
    if not _num(obj["ts"]) or obj["ts"] <= 0:
        return False, "ts"
    r = obj["result"]
    if not isinstance(r, str):
        return False, "result_type"
    if r not in RESULTS and not (r.startswith("inconclusive:") and WHY_RE.fullmatch(r[len("inconclusive:"):])):
        return False, "result"
    if obj["mode"] not in MODES:
        return False, "mode"
    if not _strnull(obj["install_id"]) or not _strnull(obj["output"]):
        return False, "string_field"
    if not all(_numnull(obj[k]) for k in ("pre_db", "burst_db", "rise_db", "volume")):
        return False, "number_field"
    return True, ""


def _next_night(night):
    return (datetime.strptime(night, "%Y%m%d") + timedelta(days=1)).strftime("%Y%m%d")


class CanaryRoute:
    def __init__(self, sink, state_path=None, audit_dir=None, clock=None):
        self.sink, self.state_path, self.audit_dir = sink, state_path, audit_dir
        self.state = {}                  # room -> {"opened": {kind: night}, "absent_night": night|None}
        if state_path and os.path.exists(state_path):
            try:
                with open(state_path) as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    for k, v in d.items():
                        if isinstance(v, dict) and isinstance(v.get("opened"), dict):
                            self.state[str(k)] = {"opened": {a: b for a, b in v["opened"].items() if a in CASE_KINDS and isinstance(b, str) and NIGHT_RE.fullmatch(b)},
                                                  "absent_night": v.get("absent_night") if isinstance(v.get("absent_night"), str) and NIGHT_RE.fullmatch(v["absent_night"]) else None}
            except (OSError, ValueError):
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

    def _open_once(self, room, kind, night, now):
        st = self.state.setdefault(room, {"opened": {}, "absent_night": None})
        if st["opened"].get(kind) == night:
            return False                 # this kind already opened for this room tonight (also after an ACK closed it)
        self.sink.canary_case(room, kind, now)
        st["opened"][kind] = night       # recorded only after the sink took it: a store fault is retried by the next line of the night
        return True

    def handle(self, room, raw_obj, dup, now, day_dir):
        """-> "invalid" | "stored" | "case" | "closed". Never raises on a bad line; a sink fault propagates to the caller (which logs it and keeps reading)."""
        ok, why = validate(raw_obj, room)
        if ok and dup:
            ok, why = False, "duplicate_keys"
        if not ok:
            self.audit_invalid(room, why, now, day_dir)
            return "invalid"
        res, night = raw_obj["result"], raw_obj["night"]
        st = self.state.setdefault(room, {"opened": {}, "absent_night": None})
        if res == "would_do":
            return "stored"              # stored in the stream file by the caller; no case
        if res == "pass":
            self.sink.canary_pass(room, now)
            st["absent_night"] = None
            self._save()
            return "closed"
        if res == "no_local_rise":
            opened = self._open_once(room, "canary_failed", night, now)
        else:
            opened = self._open_once(room, "canary_inconclusive", night, now)
            if res == OUTPUT_ABSENT:
                prev = st.get("absent_night")
                if prev is not None and _next_night(prev) == night:
                    opened = self._open_once(room, "canary_output_absent", night, now) or opened
                if prev is None or night >= prev:
                    st["absent_night"] = night
            else:
                st["absent_night"] = None
        self._save()
        return "case" if opened else "stored"
