#!/usr/bin/env python3
"""idle-reaper.py -- 455.A.3: stop panes idle > 60 min with no queued task.

Idle = herdr agent_status is done/idle AND the pane's opencode session
(time_updated from the machine's opencode.db, matched via herdr agent list's
agent_session.value) has been quiet > --idle-minutes (default 60). "No queued
task" = pane-watch's order queue for that agent is empty
(orders/queue/<machine-or-default>:<agent>/ has no NNN-*.md) AND the input box
holds no draft (screen check like restart-box-pane.py).

Default: DRY RUN - prints what it would stop. --stop actually sends /exit to the
pane via herdr pane send-text (the pane quits opencode; the TAB stays). Never
touches a pane that is working, blocked, named herdr-kit/minibot/Fable-server, or
that has a queued order.

Runs on the Mini (local herdr session); box panes are out of scope for v1 (the
box herdr carries no session ids - restart-box-pane.py precedent) - flagged.
"""
import argparse, glob, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oc_usage  # noqa: E402

PROTECTED = {"herdr-kit", "minibot", "fable", "conductor", "lab-mover", "pane-watch"}

def sh(cmd, timeout=60):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True,
                          text=True, timeout=timeout)

def herdr_json(*args):
    p = sh(["herdr", *args])
    try:
        return json.loads(p.stdout)["result"]
    except Exception:
        return {}

def queue_empty(agent, machine="default"):
    d = os.path.expanduser("~/dev/eta-lab/orders/queue/%s:%s" % (machine, agent))
    if not os.path.isdir(d):
        return True
    return not glob.glob(os.path.join(d, "*.md"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--idle-minutes", type=int, default=60)
    ap.add_argument("--stop", action="store_true", help="actually send /exit")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval-min", type=int, default=15)
    a = ap.parse_args()

    while True:
        now = time.time() * 1000
        candidates = []
        agents = herdr_json("agent", "list").get("agents", [])
        # session -> last activity, per machine db (mini only for v1)
        try:
            conn, _ = oc_usage.connect("mini")
            # last message activity per session (user OR assistant) = the pane's last heartbeat
            q = ("SELECT s.id, max(m.time_updated) FROM session s JOIN message m ON m.session_id=s.id"
                 " WHERE s.time_archived IS NULL GROUP BY s.id")
            last_act = {r[0]: int(r[1] or 0) for r in conn.execute(q)}
        except Exception as ex:
            print("db unavailable: %s" % ex, file=sys.stderr)
            last_act = {}
        for ag in agents:
            name = ag.get("name") or ""
            status = (ag.get("agent_status") or "").lower()
            if name in PROTECTED or status not in ("done", "idle"):
                continue
            if ag.get("agent") != "opencode":
                continue
            raw = ag.get("agent_session")
            sid = ""
            if isinstance(raw, dict):
                sid = raw.get("value") or ""
            elif isinstance(raw, str):
                m = re.search(r"'value': '(ses_[^']+)'", raw)
                sid = m.group(1) if m else ""
            idle_min = None
            if sid and sid in last_act and last_act[sid]:
                idle_min = (now - last_act[sid]) / 60000.0
            if idle_min is not None and idle_min < a.idle_minutes:
                continue
            if not queue_empty(name):
                continue
            candidates.append((name, ag.get("pane_id"), idle_min))
        for name, pane, idle in candidates:
            line = "REAPER would stop %s (%s) idle %.0f min" % (name, pane, idle or -1)
            print(line)
            if a.stop:
                sh(["herdr", "pane", "send-text", pane, "/exit"])
                sh(["herdr", "pane", "send-keys", pane, "Return"])
                print("  -> /exit sent")
        if not candidates:
            print("reaper: nothing to stop")
        if a.once:
            return
        time.sleep(a.interval_min * 60)

if __name__ == "__main__":
    main()
