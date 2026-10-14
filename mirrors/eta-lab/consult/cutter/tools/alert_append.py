#!/usr/bin/env python3
"""append one alert line to the spool (used by the systemd OnFailure unit): alert_append.py "ALERT ..." """
import json, os, sys, time
p = os.path.expanduser("~/eta-data/consult/ALERTS.jsonl"); os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True); fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
with os.fdopen(fd, "a") as fh: fh.write(json.dumps(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), source="systemd", alert=" ".join(sys.argv[1:]) or "ALERT (no text)")) + "\n")
