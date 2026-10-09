# Fleet Board check for the palimpsest hourly job (herdr-lead 09 Oct, palimpsest-architect #10352).
# Runs ON the box via `ssh e2e-lab python3 - < this file`. Counts only, one line out.
import json, os, subprocess
from datetime import datetime, timedelta, timezone
H = os.path.expanduser("~/eta-data/reb/_hourly")
def act(u):
    return subprocess.run(["systemctl", "--user", "is-active", u], capture_output=True, text=True).stdout.strip()
timer, svc = act("palimpsest-hourly.timer"), act("palimpsest-hourly.service")
last = ""
try:
    with open(os.path.join(H, "runs.jsonl"), "rb") as f:
        f.seek(0, 2); f.seek(max(0, f.tell() - 65536))
        lines = [l for l in f.read().decode("utf-8", "replace").splitlines() if l.strip()]
    d = json.loads(lines[-1])
    sv = (d.get("steps") or {}).get("sarvam") or {}
    try:
        ts = (datetime.strptime(str(d.get("ts")), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
              .astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%H:%M IST"))
    except Exception:
        ts = "?"
    causes = d.get("causes") or []
    ok = sv.get("ok")
    last = "last %s %s · sarvam %s clips ok, %s failed, %s throttled · recut queue %s" % (
        ts, "ok" if not causes else "CAUSES " + ",".join(map(str, causes))[:30],
        ok // 2 if isinstance(ok, int) else "?",   # runs.jsonl ok counts tracks: stt + diar per clip (#10370)
        sv.get("failed", "?"), sv.get("throttled", "?"), sv.get("deferred_recut", "?"))
except Exception:
    last = "no runs.jsonl line"
alarms = os.path.exists(os.path.join(H, "ALARMS.log")) and os.path.getsize(os.path.join(H, "ALARMS.log")) > 0
state = "running" if svc == "active" else ("timer on" if timer == "active" else "timer OFF")
print("%s · %s%s" % (state, last, " · ALARMS.log not empty" if alarms else ""))
