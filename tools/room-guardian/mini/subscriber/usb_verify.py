"""usb_verify.py -- FR1 2.4 d' (Mini side): the F2 Mini-side verify after a kiosk reboot. The kiosk emits `kiosk_reboot` / `healed_pending` once it has verified the device
is back, the recorder runs with one tapewriter and the boot is newer than the reboot (guardian-lead report F2). start_day accepted, a fresh tape piece and zero_ratio are
checked HERE, within 15 min: the room must show capture_open true, a fresh piece (advancing data across two health lines, see below) and zero_ratio < 0.98. Otherwise
usb_reboot_failed opens (source mini_verify; the case store has no source column, so the source goes to the audit line). The state is on disk, so a subscriber restart
keeps a verify in progress.
INFERRED: the health-line fields are the kiosk's own (collect.sh health_line): capture_open (bool), zero_ratio (number 0..1), pending_piece_count and rms_dbfs_2s (numbers).
guardian-lead's kickoff gives no field for "a fresh tape piece"; it is approximated as: two qualifying health lines at least ADVANCE_MIN_S apart whose pending_piece_count or
rms_dbfs_2s differ. UNVERIFIED against a real kiosk."""
import json, math, os, time

VERIFY_S, ADVANCE_MIN_S, ZERO_RATIO_MAX, SINK_RETRY_S = 900, 30, 0.98, 300


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _qualifies(obj):
    """capture_open true and a finite zero_ratio in 0..1 below ZERO_RATIO_MAX. Anything else (missing, str, NaN, out of range) does not qualify."""
    zr = obj.get("zero_ratio")
    return obj.get("capture_open") is True and _finite(zr) and 0 <= zr <= 1 and zr < ZERO_RATIO_MAX


class UsbVerify:
    def __init__(self, sink=None, state_path=None, clock=time.time, audit_path=None):
        self.sink, self.state_path, self.clock, self.audit_path = sink, state_path, clock, audit_path
        self.retry_at = {}
        self.state = {}                   # room -> {"started_at", "deadline", "first": {...}|None, "ok": bool, "failed": bool}
        if state_path and os.path.exists(state_path):
            try:
                with open(state_path) as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    self.state = {str(k): v for k, v in d.items() if isinstance(v, dict) and _finite(v.get("started_at")) and _finite(v.get("deadline"))}
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
        except Exception:                 # noqa: BLE001 -- best effort; the in-memory state still runs this process
            self._audit("-", "state_write_fault", self.clock())

    def _audit(self, room, event, now, **kw):
        if not self.audit_path:
            return
        try:
            with open(self.audit_path, "a") as f:
                f.write(json.dumps(dict(kw, ts=int(now), room=room, event=event), sort_keys=True) + "\n")
        except Exception:                 # noqa: BLE001
            pass

    def pending(self, room):
        st = self.state.get(room)
        return bool(st) and not st.get("ok") and not st.get("failed")

    def start(self, room, now=None):
        """A `healed_pending` line: begin the 15 min verify. A second line while one is pending keeps the first (its clock is not reset)."""
        now = self.clock() if now is None else now
        if self.pending(room):
            return False
        self.state[room] = {"started_at": now, "deadline": now + VERIFY_S, "first": None, "ok": False, "failed": False}
        self._save(); self._audit(room, "verify_started", now)
        return True

    def on_health(self, room, obj, now=None):
        """Never raises."""
        try:
            now = self.clock() if now is None else now
            if not self.pending(room) or not isinstance(obj, dict) or not _qualifies(obj):
                return
            st = self.state[room]
            snap = {"at": now, "pieces": obj.get("pending_piece_count") if _finite(obj.get("pending_piece_count")) else None,
                    "rms": obj.get("rms_dbfs_2s") if _finite(obj.get("rms_dbfs_2s")) else None}
            first = st.get("first")
            if not isinstance(first, dict) or not _finite(first.get("at")):
                st["first"] = snap; self._save(); return
            if now - first["at"] >= ADVANCE_MIN_S and (snap["pieces"] != first.get("pieces") or snap["rms"] != first.get("rms")) and (snap["pieces"] is not None or snap["rms"] is not None):
                st["ok"] = True; self._save(); self._audit(room, "verify_ok", now)
        except Exception:                 # noqa: BLE001
            pass

    def check(self, now=None):
        """Called every loop: a verify not satisfied by its deadline opens usb_reboot_failed once, with source mini_verify in the audit line."""
        now = self.clock() if now is None else now
        for room, st in list(self.state.items()):
            try:
                if st.get("ok") or st.get("failed") or now < st["deadline"] or now < self.retry_at.get(room, 0):
                    continue
                st["failed"] = True
                self._audit(room, "verify_failed", now, source="mini_verify", seen_qualifying=isinstance(st.get("first"), dict))
                if self.sink:
                    try:
                        self.sink.usb_case(room, "usb_reboot_failed", now)
                    except Exception:     # noqa: BLE001 -- a store fault is retried once per 5 min
                        st["failed"] = False
                        self.retry_at[room] = now + SINK_RETRY_S
                        self._audit(room, "verify_failed_sink_fault", now)
                        continue
                self._save()
            except Exception:             # noqa: BLE001
                self._audit(room, "verify_fault", now)
