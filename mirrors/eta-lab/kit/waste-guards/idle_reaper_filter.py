#!/usr/bin/env python3
"""List herdr panes that are idle past a threshold with no queued work.

Reads a herdr agent-list JSON document (file argument or stdin) and prints one
TSV line per reapable pane:

    <agent>\t<pane>\t<idle_minutes>\t<last_activity>

This is the reference implementation of the filter specified in
idle-reaper-spec.md; the jq one-liner in that spec is a line-for-line equivalent
and test_idle_reaper.py asserts the two agree on the shipped fixture.

An agent is reapable when ALL of these hold:
  * its last activity is strictly older than --minutes (default 60)
  * it has nothing in flight (no inflight/current/running task)
  * its queue is empty (absent, null or [])
  * it is not protected (protected/pinned/hold/keepalive/do_not_reap)
  * it is not in a busy-ish state (busy/running/working/active/...)
  * its last-activity timestamp actually parsed -- unknown means DO NOT REAP

Exit codes: 0 always (this is a reporter, not a gate), 2 on unusable input.
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import re
import sys

DEFAULT_MINUTES = 60

LAST_KEYS = ("last_activity", "lastActivity", "last_event", "lastEvent", "updated_at",
             "updatedAt", "last_used", "lastUsed", "last_seen", "lastSeen")
INFLIGHT_KEYS = ("inflight_task", "inflightTask", "current_task", "currentTask",
                 "running_task", "runningTask", "active_task", "activeTask", "in_flight")
QUEUE_KEYS = ("queue", "queued", "tasks", "pending", "pending_tasks", "pendingTasks")
DEPTH_KEYS = ("queue_depth", "queueDepth", "queued_count", "queuedCount", "pending_count")
PROTECT_KEYS = ("protected", "pinned", "pin", "hold", "hold_reason", "holdReason",
                "keepalive", "do_not_reap", "doNotReap", "no_reap", "frozen")
STATE_KEYS = ("state", "status", "phase")
BUSY_STATES = {"busy", "running", "working", "active", "in_progress", "inprogress",
               "in-flight", "inflight", "streaming", "thinking", "blocked", "waiting_for_input"}

_OFFSET = re.compile(r"^(?P<base>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.\d+)?"
                     r"(?P<sign>[+-])(?P<hh>\d{2}):?(?P<mm>\d{2})$")
_PLAIN = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$")


def parse_ts(value):
    """RFC3339 / ISO-8601 (Z or +hh:mm offset) or epoch seconds/millis -> float
    seconds, or None if it cannot be read."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value / 1000.0 if value > 1e11 else float(value)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if re.fullmatch(r"\d+(\.\d+)?", text):
        num = float(text)
        return num / 1000.0 if num > 1e11 else num
    m = _OFFSET.match(text)
    if m:
        base = dt.datetime.strptime(m.group("base").replace(" ", "T"), "%Y-%m-%dT%H:%M:%S")
        secs = calendar.timegm(base.timetuple())
        delta = int(m.group("hh")) * 3600 + int(m.group("mm")) * 60
        return secs - delta if m.group("sign") == "+" else secs + delta
    if _PLAIN.match(text):
        # drop any fractional seconds: strptime does not want them, and the
        # sub-second part is irrelevant to a 60-minute threshold
        try:
            base = dt.datetime.strptime(re.sub(r"\.\d+", "", text.replace(" ", "T").rstrip("Z")),
                                        "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return None
        return calendar.timegm(base.timetuple())
    return None


def _first(agent, keys):
    for k in keys:
        if k in agent and agent[k] not in (None, ""):
            return agent[k]
    return None


def _queue_len(agent):
    """0 only when nothing at all is queued.

    Both the queue collection and any explicit depth counter are consulted and
    the larger wins, so `{"queue": [], "queue_depth": 3}` counts as 3 -- an
    empty array must not short-circuit a depth that says otherwise."""
    best = 0
    for k in QUEUE_KEYS:
        if k not in agent:
            continue
        q = agent[k]
        if q is None:
            continue
        if isinstance(q, (list, tuple)):
            best = max(best, len(q))
        elif isinstance(q, dict):
            best = max(best, 1 if q else 0)   # any non-empty object == queued work
        else:
            best = max(best, 1)
    for k in DEPTH_KEYS:
        v = agent.get(k)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)) and v > 0:
            best = max(best, int(v))
        elif isinstance(v, str) and v.strip().isdigit():
            best = max(best, int(v.strip()))
    return best


def _protected(agent):
    for k in PROTECT_KEYS:
        v = agent.get(k)
        if isinstance(v, str):
            if v.strip().lower() in ("", "false", "0", "no", "none", "null", "off"):
                continue
            return True
        if v:
            return True
    return False


def _busy(agent):
    state = _first(agent, STATE_KEYS)
    if isinstance(state, str) and state.strip().lower().replace(" ", "_") in BUSY_STATES:
        return True
    return False


def agents_of(doc):
    if isinstance(doc, list):
        return [a for a in doc if isinstance(a, dict)]
    if isinstance(doc, dict):
        for key in ("agents", "panes", "items", "data", "results"):
            v = doc.get(key)
            if isinstance(v, list):
                return [a for a in v if isinstance(a, dict)]
        if doc.get("id") or doc.get("agent") or doc.get("pane"):
            return [doc]
    return []


def reapable(doc, now, minutes=DEFAULT_MINUTES):
    out = []
    for agent in agents_of(doc):
        raw_last = _first(agent, LAST_KEYS)
        last = parse_ts(raw_last)
        if last is None:
            continue                      # unknown activity -> never reap
        idle_min = (now - last) / 60.0
        if idle_min <= minutes:
            continue
        if _busy(agent) or _protected(agent):
            continue
        if _first(agent, INFLIGHT_KEYS) not in (None, "", [], {}):
            continue
        if _queue_len(agent) > 0:
            continue
        out.append({
            "agent": str(agent.get("agent") or agent.get("name") or agent.get("id") or "?"),
            "pane": str(agent.get("pane") or agent.get("pane_id") or agent.get("target") or "?"),
            "idle_minutes": round(idle_min, 1),
            # full precision kept for ordering only (sort must match the jq
            # implementation, which orders on the unrounded value); dropped
            # before the rows are returned so the row schema is unchanged.
            "_idle_full": idle_min,
            "last_activity": raw_last if isinstance(raw_last, str) else str(raw_last),
        })
    out.sort(key=lambda r: (-r["_idle_full"], r["agent"], r["pane"]))
    for r in out:
        del r["_idle_full"]
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="idle-reaper-filter", description=__doc__.splitlines()[0])
    ap.add_argument("json", nargs="?", help="herdr agent list JSON; omit or use - for stdin")
    ap.add_argument("--minutes", type=float, default=DEFAULT_MINUTES,
                    help="idle threshold in minutes (default %d)" % DEFAULT_MINUTES)
    ap.add_argument("--now", help="override 'now' (ISO-8601 or epoch) -- for tests and replays")
    ap.add_argument("--json-out", action="store_true", help="emit a JSON array instead of TSV")
    args = ap.parse_args(argv)

    if args.json and args.json != "-":
        try:
            with open(args.json) as fh:
                doc = json.load(fh)
        except OSError as exc:
            print("idle-reaper-filter: %s" % exc, file=sys.stderr)
            return 2
        except ValueError as exc:
            print("idle-reaper-filter: %s is not valid JSON: %s" % (args.json, exc), file=sys.stderr)
            return 2
    else:
        try:
            doc = json.load(sys.stdin)
        except ValueError as exc:
            print("idle-reaper-filter: stdin is not valid JSON: %s" % exc, file=sys.stderr)
            return 2

    now = parse_ts(args.now) if args.now else None
    if now is None:
        now = dt.datetime.now(dt.timezone.utc).timestamp()

    rows = reapable(doc, now, args.minutes)
    if args.json_out:
        json.dump(rows, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        for r in rows:
            print("%s\t%s\t%.1f\t%s" % (r["agent"], r["pane"], r["idle_minutes"], r["last_activity"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
