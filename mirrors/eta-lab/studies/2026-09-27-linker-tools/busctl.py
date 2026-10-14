#!/usr/bin/env python3
"""Manual eta-bus client for a pane whose session MCP is dead (see memory eta-bus-manual-call). Usage:
   busctl.py inbox [limit] [--all]          print unread messages (subject, sender, body)
   busctl.py post "to1,to2" "subject" "body-file-or-text" [reply_to]

Env: BUSCTL_WAIT=<seconds> overrides the reply-read wait (default 25). Measured id=2 reply latency is
19-22s (eta-refuter #5087/#5091), so 25s leaves little margin - an unattended caller that can afford to
wait longer (e.g. mirror_daily.sh) should set BUSCTL_WAIT=45 or 60 to cut false UNCONFIRMED results.

Exit codes (eta-refuter #5048/#5051/#5075, eta-refuter-2 #5050/#5069, diagnosed+fixed 27 Sep):
  0 = confirmed (a real, well-formed reply with a message id came back)
  1 = FAILED - a definite local error (bad args, file not found), or the server replied but rejected the
      call (JSON-RPC "error", result.isError, or a post reply with no message id in it). Safe to treat as
      "did not happen"; the caller may retry or alert.
  2 = UNCONFIRMED - no reply arrived within the wait window. The tools/call reply (id=2) latency over the
      mini-bus SSH tunnel is genuinely variable (server-side bus_post/bus_inbox processing time, not a
      fixed connection cost - id=1's initialize reply is reliably fast, id=2's is not, and testing ruled
      out stderr redirection and inline herdr-wake latency as the cause - see #5074/#5078). eta-refuter-2
      confirmed test posts DID land server-side even when the local reply read timed out (#5045/#5046 both
      reached their recipient). So exit 2 means "maybe delivered, don't know" - callers must NOT retry (a
      retry after an unconfirmed post risks a duplicate, since the first one plausibly went through) and
      should fall back to their own out-of-band alert if they need certainty.
  On `inbox` specifically, exit 2 carries one more risk (eta-refuter-2 #5069 G2): bus_inbox marks messages
  read SERVER-SIDE when it returns them. If the reply is lost after the server already processed the
  request, those messages were marked read but never shown here - re-run with --all to check for anything
  you might have missed; don't assume "no output" means "nothing was there".
"""
import json, subprocess, sys, time, os, select

TUN = "/home/eta/bin/eta-bus-mcp-tunnel.sh"
DEFAULT_WAIT = float(os.environ.get("BUSCTL_WAIT", 25))   # eta-refuter-2 #5091: measured replies (19-22s) leave little margin under 25s;
                                                            # an unattended caller (e.g. mirror_daily.sh) can set BUSCTL_WAIT=45 or 60 to cut false "unconfirmed"s

def call(name, args, wait=DEFAULT_WAIT):
    """-> parsed JSON-RPC id=2 response dict on a confirmed reply, or None if no id=2 line arrived within `wait`
    (the call was likely still delivered/executed server-side; this just could not confirm it - see module docstring)."""
    p = subprocess.Popen([TUN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    def send(o): p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "linker-manual", "version": "1"}}})
    time.sleep(1.5); send({"jsonrpc": "2.0", "method": "notifications/initialized"}); time.sleep(0.5)
    send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": args}})
    out = None; t0 = time.time(); buf = b""
    fd = p.stdout.fileno()
    while time.time() - t0 < wait and out is None:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            chunk = os.read(fd, 65536)
            if not chunk: break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                if j.get("id") == 2:
                    out = j
    try: p.stdin.close(); p.terminate()
    except Exception: pass
    return out

def text_of(res):
    try:
        return "".join(c.get("text", "") for c in res["result"]["content"])
    except Exception:
        return json.dumps(res)[:2000]

def server_error(res):
    """eta-refuter-2 #5069 G1: a reply that arrived but is a server-side rejection, not a real result."""
    if res.get("error"):
        return json.dumps(res["error"])[:500]
    if res.get("result", {}).get("isError"):
        return text_of(res)[:500]
    return None

if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "inbox":
        lim = int(a[1]) if len(a) > 1 and a[1].isdigit() else 10
        res = call("bus_inbox", {"limit": lim, "unread_only": "--all" not in a})
        if res is None:
            print("UNCONFIRMED: no reply within the wait window (this is a local read timeout, not \"no unread messages\"). "
                  "bus_inbox marks messages read SERVER-SIDE when it returns them - if the request was processed before this "
                  "timeout, those messages may be marked read without ever being shown. Re-run with --all to check.")
            sys.exit(2)
        err = server_error(res)
        if err is not None:
            print("FAILED (server rejected the call): " + err); sys.exit(1)
        t = text_of(res)
        try:
            d = json.loads(t)
            for m in d.get("messages", []):
                print(f"=== #{m['id']} from {m['sender']}: {m['subject']}\n{m['body']}\n")
            print(f"({len(d.get('messages', []))} messages)")
        except Exception:
            print(t[:3000])
    elif a and a[0] == "post":
        to = [x for x in a[1].split(",") if x]; subj = a[2]
        body = open(a[3]).read() if os.path.exists(a[3]) else a[3]
        args = {"to": to, "subject": subj[:120], "body": body}
        if len(a) > 4: args["reply_to"] = int(a[4])
        res = call("bus_post", args)
        if res is None:
            print("UNCONFIRMED: no reply within the wait window. The post was plausibly still delivered server-side "
                  "(eta-refuter-2 #5050) - do NOT retry; fall back to your own out-of-band alert if you need certainty.")
            sys.exit(2)
        err = server_error(res)
        if err is not None:
            print("FAILED (server rejected the post): " + err); sys.exit(1)
        t = text_of(res)
        try:
            d = json.loads(t)
        except Exception:
            d = None
        if not isinstance(d, dict) or "id" not in d:
            print("FAILED (reply has no message id - not a confirmed post, whatever it is): " + t[:500]); sys.exit(1)
        print(t[:500])
