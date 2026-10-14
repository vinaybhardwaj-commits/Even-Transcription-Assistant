#!/usr/bin/env python3
"""guards-main.py -- 455.A combined entrypoint for the launchd agent (V-run install).

One pass =
  1. context_watchdog pass (A.1): alert >150K-context sessions, dedup 4 h,
     post the handover/fresh-session command (never spawns a pane itself);
  2. token_budget.watch_pass (A.4): 80%/100% daily per-pane alerts;
  3. at the first pass on/after 08:00 IST each day: the cross-machine usage
     table posted to the bus (A.4's 08:00 requirement).
The loop sleeps to a 15-min cadence. --enforce posts to the bus; without it the
pass only prints (dry). A crash in one guard never blocks the others.
"""
import argparse, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import context_watchdog   # noqa: E402
import token_budget       # noqa: E402

TABLE_STATE = os.path.expanduser("~/dev/eta-lab/scratch/waste-guards-table.json")

def ist_daynum(now=None):
    return int((time.time() * 1000 + token_budget.IST_OFFSET_MS) // 86400000)

def table_pass(enforce, budget):
    today = ist_daynum()
    try:
        st = json.load(open(TABLE_STATE))
    except Exception:
        st = {"last_day": 0}
    if st.get("last_day", 0) >= today:
        return
    if time.localtime().tm_hour < 8 and time.gmtime().tm_hour < 2:
        # cheap guard: not yet 08:00 IST (02:30 UTC) in this pass
        if time.gmtime().tm_hour * 60 + time.gmtime().tm_min < 150:
            return
    day, tables = token_budget.all_machines_daily()
    t = token_budget.render_table(day, tables, budget)
    print(t)
    if enforce:
        try:
            token_budget.bus_alert.post("DAILY USAGE 08:00 IST", "```\n%s\n```" % t)
        except Exception as ex:
            print("table post failed: %s" % ex, file=sys.stderr)
    st["last_day"] = today
    os.makedirs(os.path.dirname(TABLE_STATE), exist_ok=True)
    json.dump(st, open(TABLE_STATE, "w"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enforce", action="store_true")
    ap.add_argument("--limit", type=int, default=150000)
    ap.add_argument("--budget", type=int, default=800000)
    ap.add_argument("--interval-min", type=int, default=15)
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()
    while True:
        try:
            context_watchdog.run_pass(limit=a.limit, enforce=a.enforce)
        except Exception as ex:
            print("watchdog pass failed: %s" % ex, file=sys.stderr)
        try:
            token_budget.watch_pass(a.budget, a.enforce)
        except Exception as ex:
            print("budget pass failed: %s" % ex, file=sys.stderr)
        try:
            table_pass(a.enforce, a.budget)
        except Exception as ex:
            print("table pass failed: %s" % ex, file=sys.stderr)
        if a.once:
            return
        time.sleep(a.interval_min * 60)

if __name__ == "__main__":
    main()
