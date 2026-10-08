#!/usr/bin/env python3
"""Tail the alert spool and print each NEW alert line (stdout lines = events for a Monitor / bus relay). The systemd units cannot post to the bus themselves (the bus client is bound to an agent pane), so an agent session runs this and posts each line to consult-lead and fable.
  alert_watch.py            only alerts appended after it starts
  alert_watch.py --all      replay the whole spool first"""
import json, os, sys, time
P = os.path.expanduser("~/eta-data/consult/ALERTS.jsonl")
def main():
    pos = 0 if "--all" in sys.argv else (os.path.getsize(P) if os.path.exists(P) else 0)
    while True:
        if os.path.exists(P) and os.path.getsize(P) > pos:
            with open(P) as fh:
                fh.seek(pos)
                for l in fh:
                    if not l.endswith("\n"): break
                    pos += len(l.encode())
                    try: r = json.loads(l); print(f"{r.get('at')} {r.get('source')}: {r.get('alert')}", flush=True)
                    except Exception: print(l.strip(), flush=True)
        elif os.path.exists(P) and os.path.getsize(P) < pos: pos = 0
        time.sleep(5)
if __name__ == "__main__": main()
