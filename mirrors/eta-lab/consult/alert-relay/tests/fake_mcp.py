#!/usr/bin/python3
"""A stand-in for the eta-bus MCP server (stdio JSON-RPC). Env: FAKE_LOG = file that gets one JSON line per bus_post;
FAKE_MODE = ok | iserror | rpcerror | silent | die."""
import json, os, sys
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "die":
    sys.exit(255)
for l in sys.stdin:
    m = json.loads(l)
    if m.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "fake"}}}), flush=True)
    elif m.get("method") == "tools/call":
        if mode == "silent":
            continue
        if mode == "rpcerror":
            print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32000, "message": os.environ.get("FAKE_TEXT", "nope")}}), flush=True)
        elif mode == "iserror":
            print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"isError": True, "content": [{"type": "text", "text": os.environ.get("FAKE_TEXT", "unknown recipient")}]}}), flush=True)
        else:
            with open(os.environ["FAKE_LOG"], "a") as f:
                f.write(json.dumps({"name": m["params"]["name"], "arguments": m["params"]["arguments"], "pane": os.environ.get("HERDR_PANE_ID")}) + "\n")
            print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text", "text": "{\"id\":1}"}]}}), flush=True)
