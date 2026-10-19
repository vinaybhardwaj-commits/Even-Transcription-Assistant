#!/usr/bin/env python3
"""MiniBot 12 Oct 2026: interim server-side expiry until ubus is restarted with STALE_GONE_MS.
Marks presence='gone' + closed=1 (soft, same as ubus_unregister; the running server re-derives presence
from heartbeat age every tick, so closed=1 is the only flag that sticks; same as the server's own reap; re-register revives) for rows with
closed=0, presence='stale', runtime not grok/cowork, no heartbeat for >12h, and whose handle is not a
live Herdr agent (names from /tmp/_fleet.json + local sessions). Hourly LaunchAgent."""
import datetime as dt, json, sqlite3, subprocess, time, os
names = set()
try: names |= {a["name"] for a in json.load(open("/tmp/_fleet.json"))["agents"]}
except Exception: pass
for s in ("default", "orch"):
    try:
        o = subprocess.run(["/opt/homebrew/bin/herdr", "--session", s, "agent", "list"], capture_output=True, text=True, timeout=15).stdout
        names |= {a["name"] for a in json.loads(o)["result"]["agents"]}
    except Exception: pass
if not names:
    print(time.strftime("%F %T"), "no herdr names; skip (fail safe)"); raise SystemExit
cut = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%S")
c = sqlite3.connect(os.path.expanduser("~/dev/ubus/data/ubus.db"), timeout=10)
rows = [h for (h,) in c.execute("select handle from agents where closed=0 and presence='stale' and runtime not in ('grok','cowork') and capabilities_json not like ? and coalesce(last_heartbeat_at,registered_at) < ?", ('%"system":true%', cut)) if h not in names]
c.executemany("update agents set presence='gone', closed=1 where handle=? and closed=0 and presence='stale'", [(h,) for h in rows]); c.commit()
print(time.strftime("%F %T"), "expired", len(rows), rows[:20])
