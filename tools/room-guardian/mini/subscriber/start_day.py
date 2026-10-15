"""start_day.py -- FR1 2.4 d' (Mini side): start_day once per boot after a kiosk reboot. Behind the flag start_day_after_boot (default false).
Trigger (per room, from the health line): boot_age_s < 600, usb_mic_present true, the recorder running, and no start_day sent for this boot.
Health-line fields: boot_age_s and usb_mic_present are the kiosk's (collect.sh health_line). The kiosk has NO `recorder_state` field: "recorder running" is read as
recorder_pid_age_s being a number (the field is empty when no recorder pid exists), and "started" as capture_open true. Both INFERRED, flagged in the report.
The sender is injected: sender(room) returns on success and raises on failure. No credential lives here. Once per boot: key = room + boot epoch (now - boot_age_s),
the same boot when two epochs are within BOOT_TOL_S. If the room is not capture_open within START_DEADLINE_S after the send, start_day_failed opens (URGENT, V kind)."""
import json, os, time

BOOT_MAX_AGE_S, START_DEADLINE_S, BOOT_TOL_S = 600, 600, 120


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v


class StartDayAfterBoot:
    def __init__(self, sender, state_path=None, sink=None, clock=time.time, audit_path=None):
        self.sender, self.state_path, self.sink, self.clock, self.audit_path = sender, state_path, sink, clock, audit_path
        self.state = {}                   # room -> {"boot": epoch, "sent_at": t, "send_ok": bool, "started": bool, "failed": bool}
        if state_path and os.path.exists(state_path):
            try:
                with open(state_path) as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    self.state = {str(k): v for k, v in d.items() if isinstance(v, dict)}
            except (OSError, ValueError):
                pass

    def _save(self):
        if not self.state_path:
            return
        tmp = f"{self.state_path}.tmp{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(self.state, f, sort_keys=True)
        os.replace(tmp, self.state_path)

    def _audit(self, room, event, now, **kw):
        if not self.audit_path:
            return
        try:
            with open(self.audit_path, "a") as f:
                f.write(json.dumps(dict(kw, ts=int(now), room=room, event=event), sort_keys=True) + "\n")
        except OSError:
            pass

    def on_health(self, room, obj, now=None):
        now = self.clock() if now is None else now
        if not isinstance(obj, dict):
            return
        st = self.state.get(room)
        boot_age = obj.get("boot_age_s")
        if st and not st.get("started") and not st.get("failed") and obj.get("capture_open") is True and _num(boot_age) and abs((now - boot_age) - st["boot"]) <= BOOT_TOL_S:
            st["started"] = True; self._save(); self._audit(room, "started", now)
        if not _num(boot_age) or boot_age < 0 or boot_age >= BOOT_MAX_AGE_S:
            return
        if obj.get("usb_mic_present") is not True or not _num(obj.get("recorder_pid_age_s")):
            return
        boot = int(now - boot_age)
        if st and abs(boot - st["boot"]) <= BOOT_TOL_S:
            return                        # start_day was already sent for this boot
        self.state[room] = {"boot": boot, "sent_at": int(now), "send_ok": False, "started": False, "failed": False}
        self._save()                      # written BEFORE the send: a crash mid-send never sends twice for one boot
        ok = True
        try:
            self.sender(room)
        except Exception:                 # noqa: BLE001 -- a failed send is recorded and surfaces as start_day_failed after the deadline; never a second send for this boot
            ok = False
        self.state[room]["send_ok"] = ok
        self._save()
        self._audit(room, "start_day_sent" if ok else "start_day_send_error", now, boot=boot)

    def check(self, now=None):
        """Called every loop: a room still not started START_DEADLINE_S after its start_day opens start_day_failed once per boot."""
        now = self.clock() if now is None else now
        for room, st in list(self.state.items()):
            if st.get("started") or st.get("failed") or now - st.get("sent_at", now) < START_DEADLINE_S:
                continue
            st["failed"] = True
            self._save()
            self._audit(room, "start_day_failed", now, send_ok=bool(st.get("send_ok")))
            if self.sink:
                self.sink.start_day_failed(room, now)
