"""start_day.py -- FR1 2.4 d' (Mini side): start_day once per boot after a kiosk reboot. Behind the flag start_day_after_boot (default false).
Trigger (per room, from the health line): boot_age_s < 600, usb_mic_present true, the recorder running, and no start_day sent for this boot.
Health-line fields: boot_age_s and usb_mic_present are the kiosk's (collect.sh health_line). The kiosk has NO `recorder_state` field: "recorder running" is read as
recorder_pid_age_s being a number (the field is empty when no recorder pid exists), and "started" as capture_open true. Both INFERRED, flagged in the report.
The sender is injected: sender(room) returns on success and raises on failure. No credential lives here. Once per boot: key = room + boot epoch (now - boot_age_s),
the same boot when two epochs are within BOOT_TOL_S. If the room is not capture_open within START_DEADLINE_S after the send, start_day_failed opens (URGENT, V kind)."""
import json, math, os, queue, subprocess, threading, time

BOOT_MAX_AGE_S, START_DEADLINE_S, BOOT_TOL_S, SINK_RETRY_S = 600, 600, 120, 300


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class ConfigError(Exception):
    pass


def command_sender(cmd, stderr=None, timeout=30, runner=subprocess.run):
    """sender(room) over the configured argv (router.json start_day_cmd): no shell, a 30 s timeout, exit 0 = sent. A room starting with '-' is refused so it can never be
    read as an option by the wrapper."""
    def send(room):
        if not isinstance(room, str) or not room or room.startswith("-"):
            raise ValueError("room slug not allowed as an argument")
        runner(list(cmd) + [room], check=True, timeout=timeout, stdout=subprocess.DEVNULL, stderr=stderr)
    return send


def build(flags, sink, home, clock=time.time, stderr=None, runner=subprocess.run, background=False):
    """-> StartDayAfterBoot for the flag-on case. Raises ConfigError (the subscriber then refuses to start) when router.json has no start_day_cmd."""
    cmd = flags.get("start_day_cmd") or []
    if not cmd:
        raise ConfigError("start_day_after_boot is true but router.json has no start_day_cmd")
    return StartDayAfterBoot(command_sender(cmd, stderr, runner=runner), os.path.join(home, "data", "start-day-state.json"), sink, clock,
                             os.path.join(home, "logs", "start-day-audit.jsonl"), background=background)


class StartDayAfterBoot:
    def __init__(self, sender, state_path=None, sink=None, clock=time.time, audit_path=None, background=False):
        self.sender, self.state_path, self.sink, self.clock, self.audit_path = sender, state_path, sink, clock, audit_path
        self.background = background is True          # True: the send runs in a worker thread (30 s sender timeout), so the loop never waits on it
        self._lock = threading.RLock()                # guards state and the state file; never held while the sender runs
        self._q, self._worker = queue.Queue(), None
        self.retry_at = {}                # room -> earliest time the failed-page sink call is tried again after a fault
        self.state = {}                   # room -> {"boot": epoch, "sent_at": t, "send_ok": bool, "started": bool, "failed": bool}
        if state_path and os.path.exists(state_path):
            try:
                with open(state_path) as f:
                    d = json.load(f)
                if isinstance(d, dict):    # an entry without a numeric boot and sent_at is corrupt and dropped, so it can never raise on a health line
                    self.state = {str(k): v for k, v in d.items() if isinstance(v, dict) and _num(v.get("boot")) and _num(v.get("sent_at"))}
            except (OSError, ValueError):
                pass

    def _save(self):
        """Best effort: a write fault is audited and never raises (the in-memory state still stops a second send in this process)."""
        if not self.state_path:
            return
        try:
            with self._lock:
                tmp = f"{self.state_path}.tmp{os.getpid()}"
                with open(tmp, "w") as f:
                    json.dump(self.state, f, sort_keys=True)
                os.replace(tmp, self.state_path)
        except Exception:                 # noqa: BLE001
            self._audit("-", "state_write_fault", self.clock())

    def _audit(self, room, event, now, **kw):
        if not self.audit_path:
            return
        try:
            with open(self.audit_path, "a") as f:
                f.write(json.dumps(dict(kw, ts=int(now), room=room, event=event), sort_keys=True) + "\n")
        except OSError:
            pass

    def on_health(self, room, obj, now=None):
        """Never raises: a fault is audited and the caller carries on with the rest of the health line."""
        try:
            self._on_health(room, obj, self.clock() if now is None else now)
        except Exception:                 # noqa: BLE001
            self._audit(room, "start_day_fault", self.clock())

    def _on_health(self, room, obj, now):
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
        if self.background:
            self._enqueue(room, boot, now)    # the loop never waits on the send
        else:
            self._send(room, boot, now)

    def _send(self, room, boot, now):
        ok = True
        try:
            self.sender(room)
        except Exception:                 # noqa: BLE001 -- a failed send is recorded and surfaces as start_day_failed after the deadline; never a second send for this boot
            ok = False
        with self._lock:
            st = self.state.get(room)
            if st is not None:
                st["send_ok"] = ok
        self._save()
        self._audit(room, "start_day_sent" if ok else "start_day_send_error", now, boot=boot)

    def _enqueue(self, room, boot, now):
        self._q.put((room, boot, now))
        if self._worker is None or not self._worker.is_alive():      # restarted if it ever died
            self._worker = threading.Thread(target=self._work, name="start-day-sender", daemon=True)
            self._worker.start()

    def _work(self):
        while True:
            try:
                room, boot, now = self._q.get(timeout=60)
            except queue.Empty:
                return                    # idle: the thread ends and the next send starts a new one
            try:
                self._send(room, boot, now)
            except BaseException:         # noqa: BLE001 -- the worker never dies on a fault
                pass

    def check(self, now=None):
        """Called every loop: a room still not started START_DEADLINE_S after its start_day opens start_day_failed once per boot."""
        now = self.clock() if now is None else now
        for room, st in list(self.state.items()):
            try:
                if st.get("started") or st.get("failed") or now - st["sent_at"] < START_DEADLINE_S or now < self.retry_at.get(room, 0):
                    continue
                st["failed"] = True
                self._audit(room, "start_day_failed", now, send_ok=bool(st.get("send_ok")))
                if self.sink:
                    try:
                        self.sink.start_day_failed(room, now)          # the page first, then the save: a state-write fault can never lose it
                    except Exception:  # noqa: BLE001 -- a sink or store fault is retried on the next check
                        st["failed"] = False
                        self.retry_at[room] = now + SINK_RETRY_S          # I-e: a broken store is retried (and audited) once per 5 min, not every loop
                        self._audit(room, "start_day_failed_sink_fault", now)
                        continue
                self._save()
            except Exception:             # noqa: BLE001
                self._audit(room, "start_day_fault", now)
