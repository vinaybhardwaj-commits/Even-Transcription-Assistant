#!/usr/bin/env python3
"""token-budget.py -- 455.A.4: per-pane daily token budget + bus alerts + 08:00 IST table.

Budget basis (verified on live dbs 26 Sep): session.tokens_input+tokens_output+
tokens_cache_read is OpenCode's own cumulative rollup per session; the DAILY
spend per pane = delta of (input+output+cache_read) across a rolling IST-day
window using the message-level cost/token fields, which is what the meter's
money math already uses (fleet meter precedent). This script reports TOKENS
(not $) per pane per IST day, alerts at 80%/100% of the daily token budget,
and prints/posts the 08:00 IST cross-machine usage table.

Pane identity: herdr agent list maps pane -> session id (agent_session.value);
sessions not owned by a live pane report under their directory's last segment.

Usage:
  token-budget.py table                  # today's table, all machines, to stdout
  token-budget.py watch --budget 800000  # loop: 80%/100% bus alerts (state-deduped)
  token-budget.py post --budget 800000   # one pass of alerts, no loop
  token-budget.py table --post           # 08:00 IST cron: table to the bus
"""
import argparse, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oc_usage            # noqa: E402
import bus_alert           # noqa: E402

STATE = os.path.expanduser("~/dev/eta-lab/scratch/token-budget-state.json")
IST = time.timezone  # replaced below

try:
    from zoneinfo import ZoneInfo
    IST = ZoneInfo("Asia/Kolkata")
except Exception:
    IST = time.timezone

IST_OFFSET_MS = 5.5 * 3600 * 1000  # no DST in India

def ist_day_start_ms(now_ms=None):
    """UTC epoch ms of 00:00 IST today. IST = UTC+5:30 with no DST."""
    now_ms = now_ms or time.time() * 1000
    local = now_ms + IST_OFFSET_MS
    day_local = (local // 86400000) * 86400000
    return day_local - IST_OFFSET_MS

def daily_usage(machine, day_start_ms):
    """{pane_key: {'tokens': n, 'cost': $, 'sessions': [ids]}} for the IST day."""
    conn, _ = oc_usage.connect(machine)
    q = ("SELECT s.id, s.directory, substr(COALESCE(s.title,''),1,40),"
         " sum(COALESCE(json_extract(m.data,'$.tokens.input'),0))"
         " + sum(COALESCE(json_extract(m.data,'$.tokens.output'),0))"
         " + sum(COALESCE(json_extract(m.data,'$.tokens.cache.read'),0)),"
         " sum(COALESCE(json_extract(m.data,'$.cost'),0))"
         " FROM session s JOIN message m ON m.session_id=s.id"
         " WHERE json_extract(m.data,'$.role')='assistant' AND m.time_created>=?"
         " GROUP BY s.id")
    out = {}
    try:
        rows = conn.execute(q, (day_start_ms,))
    except Exception as ex:
        return {"__error__": str(ex)[:100]}
    for sid, d, title, tk, cost in rows:
        pane = "/".join(d.rstrip("/").split("/")[-2:]) or d  # last 2 segments: basenames collide across parents
        agg = out.setdefault(pane, {"tokens": 0, "cost": 0.0, "sessions": []})
        agg["tokens"] += int(tk or 0)
        agg["cost"] += float(cost or 0)
        agg["sessions"].append(sid[:18])
    return out

def all_machines_daily():
    day = ist_day_start_ms()
    tables = {}
    for m in oc_usage.machine_labels():
        try:
            tables[m] = daily_usage(m, day)
        except Exception as ex:
            tables[m] = {"__error__": str(ex)[:100]}
    return day, tables

def render_table(day, tables, budget=None):
    lines = ["455.A.4 daily usage (IST day starting %s)" %
             time.strftime("%Y-%m-%d %H:%M", time.gmtime(day / 1000))]
    total_tok = 0.0
    total_cost = 0.0
    for m, panes in sorted(tables.items()):
        lines.append("machine %s:" % m)
        if not panes or "__error__" in panes:
            lines.append("  (error: %s)" % panes.get("__error__", "no usage today"))
            continue
        for pane, agg in sorted(panes.items(), key=lambda x: -x[1]["tokens"]):
            mark = ""
            if budget and agg["tokens"] >= budget:
                mark = " [100%]"
            elif budget and agg["tokens"] >= 0.8 * budget:
                mark = " [80%]"
            lines.append("  %-28s %10s tok  $%6.2f  sess=%d%s"
                         % (pane[:28], format(int(agg["tokens"]), ","), agg["cost"],
                            len(agg["sessions"]), mark))
            total_tok += agg["tokens"]
            total_cost += agg["cost"]
    lines.append("TOTAL: %s tok, $%.2f" % (format(int(total_tok), ","), total_cost))
    return "\n".join(lines)

def watch_pass(budget, enforce):
    day, tables = all_machines_daily()
    st = {"day": day, "alerted80": {}, "alerted100": {}}
    try:
        prev = json.load(open(STATE))
        if prev.get("day") == day:
            st["alerted80"] = prev.get("alerted80", {})
            st["alerted100"] = prev.get("alerted100", {})
    except Exception:
        pass
    for m, panes in tables.items():
        for pane, agg in panes.items():
            if pane == "__error__":
                continue
            frac = agg["tokens"] / budget if budget else 0
            key = "%s:%s" % (m, pane)
            if frac >= 1.0 and not st["alerted100"].get(key):
                st["alerted100"][key] = 1
                if enforce:
                    bus_alert.post("TOKEN BUDGET 100%% %s %s" % (m, pane[:20]),
                                   "455.A.4: %s %s used %s tokens today (>= 100%% of %s). No new loops on this pane."
                                   % (m, pane, format(agg["tokens"], ","), format(budget, ",")))
            elif frac >= 0.8 and not (st["alerted100"].get(key) or st["alerted80"].get(key)):
                st["alerted80"][key] = 1
                if enforce:
                    bus_alert.post("TOKEN BUDGET 80%% %s %s" % (m, pane[:20]),
                                   "455.A.4: %s %s used %s tokens today (>= 80%% of %s)."
                                   % (m, pane, format(agg["tokens"], ","), format(budget, ",")))
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(st, open(STATE, "w"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["table", "watch", "post"])
    ap.add_argument("--budget", type=int, default=800000, help="tokens/pane/IST-day")
    ap.add_argument("--post", action="store_true", help="table cmd: also post to the bus")
    ap.add_argument("--interval-min", type=int, default=15)
    a = ap.parse_args()
    if a.cmd == "table":
        day, tables = all_machines_daily()
        t = render_table(day, tables, a.budget)
        print(t)
        if a.post:
            bus_alert.post("DAILY USAGE 08:00 IST", "```\n%s\n```" % t)
    elif a.cmd == "post":
        day, tables = all_machines_daily()
        t = render_table(day, tables, a.budget)
        bus_alert.post("DAILY USAGE 08:00 IST", "```\n%s\n```" % t)
    elif a.cmd == "watch":
        while True:
            watch_pass(a.budget, True)
            time.sleep(a.interval_min * 60)

if __name__ == "__main__":
    main()
