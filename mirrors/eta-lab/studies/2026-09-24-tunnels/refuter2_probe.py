#!/usr/bin/env python3
"""eta-refuter-2 tunnel probe: status + /health identity per hostname. No secrets. usage: probe.py <label> host..."""
import sys, json, hashlib, urllib.request, urllib.error, time
out = {"label": sys.argv[1], "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "hosts": {}}
VOLATILE = {"uptime", "uptime_s", "ts", "time", "now", "timestamp", "requests", "queue", "in_flight", "load"}
for h in sys.argv[2:]:
    r = {}
    for path in ("/", "/health"):
        try:
            with urllib.request.urlopen(urllib.request.Request(f"https://{h}{path}", headers={"User-Agent": "eta-refuter-2-probe"}), timeout=15) as resp:
                code, body, srv = resp.status, resp.read(65536), resp.headers.get("server")
        except urllib.error.HTTPError as e:
            code, body, srv = e.code, e.read(65536), e.headers.get("server")
        except Exception as e:
            code, body, srv = f"ERR {type(e).__name__}", b"", None
        ent = {"status": code, "server": srv, "len": len(body)}
        try:
            j = json.loads(body)
            if isinstance(j, dict):
                stable = {k: v for k, v in j.items() if k not in VOLATILE}
                ent["keys"] = sorted(j); ent["stable_sha"] = hashlib.sha256(json.dumps(stable, sort_keys=True).encode()).hexdigest()[:12]
        except Exception:
            ent["body_sha"] = hashlib.sha256(body).hexdigest()[:12]
        r[path] = ent
    out["hosts"][h] = r
print(json.dumps(out, indent=1))
