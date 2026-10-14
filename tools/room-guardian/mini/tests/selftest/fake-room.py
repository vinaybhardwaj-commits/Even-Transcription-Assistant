#!/usr/bin/env python3
"""fake-room.py -- Mini-side stand-in for a kiosk (Phase 0 self-test). Publishes one health JSON line every 10 s, one ssh per message
(like a kiosk script would), as pipe user `testroom`. Usage: fake-room.py <seconds>   Reads nothing from kiosks; touches no kiosk."""
import json, os, subprocess, sys, time
HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
end = time.time() + float(sys.argv[1])
n = 0
while time.time() < end:
    n += 1
    msg = json.dumps({"room": "testroom", "seq": n, "ts": int(time.time()), "fake": True})
    r = subprocess.run([f"{HOME}/scripts/pipe-ssh.sh", f"{HOME}/keys/testroom", "pub", "-c", "-b=false", "kiosk/testroom/health"], input=msg + "\n", text=True, timeout=20, capture_output=True)
    print(time.strftime("%H:%M:%S"), "pub", n, "rc", r.returncode, flush=True)
    time.sleep(10)
