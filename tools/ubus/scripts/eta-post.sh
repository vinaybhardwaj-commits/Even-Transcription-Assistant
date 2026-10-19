#!/bin/zsh
# ETA outbound adapter for ubus (gating-lead, 11 Oct 2026). Contract: scripts/eta-post.template.sh.
# stdin: one JSON object {as, to, subject, body, thread_id, reply_to, wake}
# stdout: one JSON object {id, thread_id}
# Posts through the existing eta-bus server (~/dev/eta-bus-mcp/run.sh) over stdio MCP, the same way the
# post-only door does. ubus never writes bus.db. Identity comes from ETA_BUS_AS, which ubus sets; only the
# two bridge identities are accepted. wake is always false. No keys or tokens here.
export PATH=/opt/homebrew/bin:/usr/bin:/bin
exec /usr/bin/python3 -I -c '
import sys, os, json, subprocess

def fail(msg):
    sys.stderr.write("eta-post: " + msg + "\n")
    sys.exit(1)

ALLOWED = {"ext-evenscribe-kiosk-bot", "ubus-bridge"}
who = os.environ.get("ETA_BUS_AS", "")
if who not in ALLOWED:
    fail("ETA_BUS_AS must be one of " + ",".join(sorted(ALLOWED)))

raw = sys.stdin.buffer.read(65537)
if len(raw) > 65536:
    fail("stdin too large")
try:
    msg = json.loads(raw.decode("utf-8"))
except Exception:
    fail("stdin is not one JSON object")
if not isinstance(msg, dict):
    fail("stdin is not one JSON object")

to = msg.get("to")
if isinstance(to, str):
    to = [to]
if not isinstance(to, list) or not to or not all(isinstance(t, str) and t for t in to):
    fail("to must be a non-empty list of names")
if any(t.lower() == "all" for t in to):
    fail("posting to all is not allowed from the bridge")

args = {"to": to, "subject": str(msg.get("subject") or ""), "body": str(msg.get("body") or ""), "wake": False}
if msg.get("thread_id") not in (None, ""):
    args["thread_id"] = str(msg["thread_id"])
if msg.get("reply_to") not in (None, ""):
    try:
        args["reply_to"] = int(msg["reply_to"])
    except Exception:
        fail("reply_to must be a message id")

payload = "\n".join(json.dumps(o) for o in [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "ubus-eta-post", "version": "1"}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "bus_post", "arguments": args}},
]) + "\n"
env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "HOME": os.environ.get("HOME", ""), "ETA_BUS_AS": who}
try:
    p = subprocess.run(["/bin/sh", "/Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh"], input=payload.encode("utf-8"),
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90, env=env)
except subprocess.TimeoutExpired:
    fail("eta-bus server timed out")

res = None
for line in p.stdout.decode("utf-8", "replace").splitlines():
    try:
        o = json.loads(line)
    except Exception:
        continue
    if isinstance(o, dict) and o.get("id") == 2:
        res = o
if res is None:
    fail("no answer from eta-bus server")
if "error" in res:
    fail("bus_post error: " + str(res["error"].get("message", ""))[:200])
r = res.get("result") or {}
if r.get("isError"):
    fail("bus_post refused: " + str((r.get("content") or [{}])[0].get("text", ""))[:200])
try:
    out = json.loads(r["content"][0]["text"])
except Exception:
    fail("unexpected bus_post result")
mid = out.get("id")
if mid is None:
    fail("bus_post returned no id")
thread = args.get("thread_id") or out.get("thread_id") or str(mid)
sys.stdout.write(json.dumps({"id": str(mid), "thread_id": str(thread)}) + "\n")
'
