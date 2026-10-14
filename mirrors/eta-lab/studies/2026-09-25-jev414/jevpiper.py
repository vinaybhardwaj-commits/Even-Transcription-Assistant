#!/usr/bin/env python3
"""r414.2 pipe: one batch file -> even-jev MCP over `ssh mini run.sh` -> answers file.
Prints ONLY ids/counts/usage; never state text, never the key (run.sh loads it itself).
Usage: jevpiper.py <batch.json> <answers.json> [--model jev-latest]
"""
import json, subprocess, sys

HOST = "mini"
CMD = "/Users/vinaybhardwaj/dev/even-jev-mcp/run.sh"


def main():
    bpath, apath = sys.argv[1], sys.argv[2]
    model = "jev-latest"
    if "--model" in sys.argv:
        model = sys.argv[sys.argv.index("--model") + 1]
    b = json.load(open(bpath))
    frames = [
        {"jsonrpc": "2.0", "id": 0, "method": "initialize",
         "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "split-speaker-jevpiper", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": "jev_ask",
                    "arguments": {"state": b["state"], "questions": b["questions"],
                                  "model": model}}},
    ]
    payload = "".join(json.dumps(f, ensure_ascii=False) + "\n" for f in frames)
    p = subprocess.run(["ssh", HOST, CMD], input=payload, capture_output=True,
                       text=True, timeout=300)
    if p.returncode != 0:
        sys.exit(f"ssh/run.sh exit {p.returncode}: {p.stderr[-300:]}")
    resp = None
    for line in p.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("id") == 1 and "result" in d:
            resp = d["result"]
        elif d.get("id") == 1 and "error" in d:
            sys.exit(f"mcp error: {json.dumps(d['error'])[:300]}")
    if resp is None:
        sys.exit("no id:1 response on stdout")
    if resp.get("isError"):
        sys.exit(f"tool error: {json.dumps(resp)[:300]}")
    body = json.loads(resp["content"][0]["text"])
    answers = body.get("answers", {})
    with open(apath, "w", 0o600) as f:
        json.dump({"answers": answers}, f, ensure_ascii=False)
    missing = [k for k in b["questions"] if k not in answers]
    u = body.get("usage", {})
    print(f"{b['set']} b{b['batch']:02d}: asked {len(b['questions'])} answered "
          f"{len(answers)} missing={missing or 'none'} in={u.get('input_tokens')} "
          f"lat={body.get('latency_ms')}ms")
    if missing:
        sys.exit(1)


if __name__ == "__main__":
    main()
