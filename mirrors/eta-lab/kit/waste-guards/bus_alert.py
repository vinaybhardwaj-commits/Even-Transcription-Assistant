#!/usr/bin/env python3
"""bus_alert.py -- one-shot bus post for the waste guards (455.A).

Speaks newline-JSON-RPC to the eta-bus MCP server on stdio (the SAME path panes
use: same identity rules, same secret scrubber, same receipts). Sender is
herdr-kit via ETA_BUS_AS -- guard scripts run outside a pane (launchd), so
identity comes from the documented no-pane env path (identity.mjs).

Usage: bus_alert.py SUBJECT BODY [RECIPIENT...]   (default recipient: fable)
"""
import json, os, subprocess, sys

SERVER = os.path.expanduser("~/dev/eta-bus-mcp/server.mjs")
NODE = "/opt/homebrew/bin/node"
SENDER = "herdr-kit"
MAX_BODY = 1500   # 455.A.5 hygiene: guard alerts are short by construction

def post(subject, body, to=("fable",)):
    body = body[:MAX_BODY]
    env = dict(os.environ, ETA_BUS_AS=SENDER)
    req = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
           "params": {"name": "bus_post", "arguments": {
               "to": list(to), "subject": subject[:110], "body": body}}}
    p = subprocess.run([NODE, SERVER], input=json.dumps(req) + "\n",
                       capture_output=True, text=True, timeout=60, env=env)
    for line in p.stdout.splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("id") == 1:
            err = e.get("error")
            if err:
                raise RuntimeError("bus_post refused: %s" % json.dumps(err)[:200])
            print("posted:", json.dumps(e.get("result", {}))[:120])
            return
    raise RuntimeError("no rpc reply: rc=%s err=%s" % (p.returncode, p.stderr[-200:]))

if __name__ == "__main__":
    subject, body = sys.argv[1], sys.argv[2]
    to = sys.argv[3:] or ["fable"]
    post(subject, body, to)
