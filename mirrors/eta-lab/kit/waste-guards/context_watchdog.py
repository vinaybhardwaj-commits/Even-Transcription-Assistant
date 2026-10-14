#!/usr/bin/env python3
"""context_watchdog.py -- 455.A.1. Every pass, NO model calls.

Reads every machine's opencode.db (read-only) for the last assistant tokens.total
per live session. Any session over --limit (default 150000) gets:
  1. a bus ALERT (once per 4 h per session; state in a small json file)
  2. the handover + fresh-session COMMAND posted for Fable to run -- per herdr-kit's
     standing never-spawn rule the watchdog never re-seats a pane itself; it posts
     the exact oc-switch/env-prefix command (the proven 432 pattern). For a Fable
     SERVER session (opencode serve on this Mini, dir _private/fable/*) the alert
     says only Fable/V can start its fresh session.
"""
import argparse, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oc_usage            # noqa: E402
import bus_alert           # noqa: E402

STATE = os.path.expanduser("~/dev/eta-lab/scratch/context-watchdog-state.json")
RE_ALERT_MS = 4 * 3600 * 1000

def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}

def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(st, open(STATE, "w"))

def is_fable_server(rec):
    return "/_private/fable/" in rec["dir"]

def handover_cmd(rec):
    if is_fable_server(rec):
        return ("FABLE-SERVER session (opencode serve on the Mini) - no pane command; "
                "Fable must start its own fresh session (the watchdog cannot re-seat it).")
    return ("fresh-session command (V or Fable runs it): "
            "herdr pane send-text <pane_id> \"OPENCODE_CONFIG=$HOME/oc/<name>/opencode.jsonc opencode -m <model>\" "
            "- the pane's own config keeps its identity; then paste HANDOVER from the old session's last output.")

def find_breaches(limit):
    out = []
    for m in oc_usage.machine_labels():
        try:
            conn, _ = oc_usage.connect(m)
            rows = oc_usage.latest_assistant_tokens(conn)
        except Exception:
            continue
        for sid, r in rows.items():
            if r["tokens_total"] >= limit:
                out.append(("%s:%s" % (m, sid), m, sid, r))
    return out

def run_pass(limit=150000, enforce=False):
    st = load_state()
    now = int(time.time() * 1000)
    fired = 0
    for key, m, sid, r in find_breaches(limit):
        if now - st.get(key, 0) < RE_ALERT_MS:
            continue
        st[key] = now
        fired += 1
        tag = "FABLE-SERVER " if is_fable_server(r) else ""
        subj = "CTX WATCHDOG %s%s %s at %dK" % (tag, m, r["dir"].split("/")[-1][:24], r["tokens_total"] // 1000)
        body = ("455.A.1 context watchdog: session %s (%s%s, '%s') last-assistant tokens.total=%d >= limit %d. %s"
                % (sid[:22], m, r["dir"], r["title"][:40], r["tokens_total"], limit, handover_cmd(r)))
        if enforce:
            try:
                bus_alert.post(subj, body)
            except Exception as ex:
                print("ALERT FAILED: %s" % ex, file=sys.stderr)
        print(subj)
    save_state(st)
    return fired

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=150000)
    ap.add_argument("--enforce", action="store_true", help="post alerts to the bus")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval-min", type=int, default=15)
    a = ap.parse_args()
    while True:
        n = run_pass(a.limit, a.enforce)
        if a.once:
            print(json.dumps({"breaches": n}))
            return
        time.sleep(a.interval_min * 60)

if __name__ == "__main__":
    main()
