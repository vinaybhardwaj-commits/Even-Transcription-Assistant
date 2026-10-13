"""subscriber.py -- Mini subscriber for the Room Guardian pipe (FR-1 C4). Clock, source, sinks and the data dir are injected.

* Streams kiosk/<room>/health, heal, probe-reply -> JSONL under <data>/<YYYY-MM-DD>/<room>.<stream>.jsonl; days older than KEEP_DAYS are pruned.
* Quiet detection is HERE, not pipe `monitor` (R4): a room with no health line for QUIET_AFTER_S raises guardian_quiet once (edge), and a
  line after that closes it. A room is counted from process start, so a room that never speaks is quiet too.
* Serves control: control_snapshot() = {"kill": bool, "modes": {room: "shadow"|"heal"}} from files; publish_control() sends it on topic
  guardian/control. Anything not exactly "heal" is "shadow". An unreadable or missing kill file is kill=true (fail safe).
Health/heal/probe lines are stored as received. Nothing here prints line content.
"""
import json, os, shutil, time
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
STREAMS = ("health", "heal", "probe-reply")
QUIET_AFTER_S, KEEP_DAYS = 120, 30
CONTROL_TOPIC = "guardian/control"


def parse_topic(topic):
    p = topic.split("/")
    if len(p) == 3 and p[0] == "kiosk" and p[2] in STREAMS and p[1] and all(ch.isalnum() or ch in "-_" for ch in p[1]):
        return p[1], p[2]
    return None


class SpoolSink:
    """guardian_quiet has NO server entry point from the Mini yet (flagged in README). Until one is named, alerts are spooled to JSONL so none is lost;
    a later sink posts them. open/close records carry room and seconds only."""
    def __init__(self, spool_dir):
        self.dir = spool_dir
        os.makedirs(spool_dir, exist_ok=True)

    def _w(self, rec):
        with open(os.path.join(self.dir, "guardian-alerts.jsonl"), "a") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")

    def guardian_quiet(self, room, quiet_s, now):
        self._w({"ts": int(now), "kind": "guardian_quiet", "room": room, "quiet_s": int(quiet_s)})

    def guardian_recovered(self, room, now):
        self._w({"ts": int(now), "kind": "guardian_recovered", "room": room})


class Subscriber:
    def __init__(self, data_dir, control_dir, rooms, sink, clock=time.time, quiet_after_s=QUIET_AFTER_S):
        self.data, self.ctl, self.rooms, self.sink, self.clock, self.quiet_after = data_dir, control_dir, list(rooms), sink, clock, quiet_after_s
        os.makedirs(data_dir, exist_ok=True)
        t0 = clock()
        self.last_seen = {r: t0 for r in self.rooms}
        self.quiet = set()

    # ---- ingest
    def on_line(self, topic, raw):
        pt = parse_topic(topic)
        if not pt:
            return False
        room, stream = pt
        try:
            json.loads(raw)
        except (TypeError, ValueError):
            return False                      # not JSON: dropped, never stored
        now = self.clock()
        day = datetime.fromtimestamp(now, IST).strftime("%Y-%m-%d")
        d = os.path.join(self.data, day)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{room}.{stream}.jsonl"), "a") as f:
            f.write(raw.rstrip("\n") + "\n")
        if stream == "health":
            self.last_seen[room] = now
            if room in self.quiet:
                self.quiet.discard(room)
                self.sink.guardian_recovered(room, now)
        return True

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
                shutil.rmtree(p)
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

    def publish_control(self, publish):
        snap = self.control_snapshot()
        publish(CONTROL_TOPIC, json.dumps(snap, sort_keys=True))
        return snap
