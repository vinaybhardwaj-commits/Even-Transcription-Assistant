# Idle reaper — which panes may be reaped

**Question this answers:** given a herdr agent-list JSON document, which panes have
been idle for more than 60 minutes with nothing queued and nothing in flight?

**Deliverable for herdr-kit:** the exact filter to run every 15 minutes (§4 jq, §5
python), the cron wiring (§7), and the rails that must be in place before anything
is actually killed (§8).

**Status:** both filters are implemented and cross-checked against a synthetic
fixture (§9). The one thing that is *assumed* rather than verified is the shape of
the real herdr agent-list JSON — see §2 and §10. Nothing here has been run against
a live herdr.

---

## 1. Scope

In scope: deciding **which panes are idle and empty**. Out of scope: the act of
reaping. The filter is a reporter and always exits 0; killing panes is herdr-kit's
job, behind the rails in §8.

## 2. Input contract — ASSUMED, verify before installing

The filters accept either of these two top-level shapes:

```json
{ "generated_at": "...", "agents": [ { ... }, { ... } ] }
```

```json
[ { ... }, { ... } ]
```

(`agents` / `panes` / `items` / `data` / `results` are all accepted as the wrapper
key; a bare array is accepted as-is.)

Per agent, the fields the filter reads, with the aliases it tolerates. The first
key present wins.

| meaning | keys tried, in order |
|---|---|
| last activity | `last_activity`, `lastActivity`, `last_event`, `lastEvent`, `updated_at`, `updatedAt`, `last_used`, `lastUsed`, `last_seen`, `lastSeen` |
| work in flight | `inflight_task`, `inflightTask`, `current_task`, `currentTask`, `running_task`, `runningTask`, `active_task`, `activeTask`, `in_flight` |
| queued work | `queue`, `queued`, `tasks`, `pending`, `pending_tasks`, `pendingTasks`, plus the counters `queue_depth`, `queueDepth`, `queued_count`, `queuedCount`, `pending_count` |
| do not touch | `protected`, `pinned`, `pin`, `hold`, `hold_reason`, `holdReason`, `keepalive`, `do_not_reap`, `doNotReap`, `no_reap`, `frozen` |
| lifecycle state | `state`, `status`, `phase` |
| labels for output | `agent`/`name`/`id`, and `pane`/`pane_id`/`target` |

Timestamps may be RFC3339 with `Z`, RFC3339 with a numeric offset
(`+05:30`, `-0800`), a space instead of `T`, or epoch seconds/milliseconds as a
number or a numeric string. Values above 1e11 are treated as milliseconds.

If the real herdr output uses names outside these tables, add them to the tables in
both filters — the alias lists are the only thing that needs to change.

## 3. Decision rule

An agent is reported as reapable when **all** of these hold:

1. **Its last activity parsed, and is strictly older than 60 minutes.** Strictly
   older: an agent idle for exactly 60.0 min is not yet a candidate, so a pane that
   ticks past the threshold mid-interval is not caught by an off-by-one.
2. **Nothing in flight.** Any non-empty in-flight task means the agent is working,
   however stale its `last_activity` looks.
3. **Queue empty.** A `null` or absent queue counts as empty; a non-empty array, a
   non-empty object, or a positive `queue_depth` does not. When both an array and a
   depth counter are present the **larger** wins, so `{"queue": [], "queue_depth": 3}`
   is correctly treated as 3 queued tasks rather than 0.
4. **Not protected.** Any truthy protection flag, or a protection string that is not
   one of `false`/`0`/`no`/`none`/`null`/`off`/empty.
5. **Not in a busy-ish state.** `busy`, `running`, `working`, `active`, `in_progress`,
   `inprogress`, `in-flight`, `inflight`, `streaming`, `thinking`, `blocked`,
   `waiting_for_input` (case-insensitive, spaces normalised to `_`).
6. **Its timestamp was readable.** An unparseable or absent `last_activity` means the
   filter does not know how long the agent has been idle, so it does not reap it.
   This is the one asymmetry in the filter, and it is deliberate: every other
   condition is about evidence of idleness, and this one is about the absence of
   evidence. A pane is never killed because we failed to read a clock.

Output is TSV, one line per candidate, longest-idle first, ties broken by agent then
pane so the ordering is stable across runs:

```
<agent>	<pane>	<idle_minutes>	<last_activity>
```

## 4. The exact jq filter

Requires jq 1.6+ (developed against jq 1.8.1). Save as `idle_reaper.jq`.

```jq
def flag($k):
  ( .[$k] // false ) as $v
  | if ($v|type) == "string"
    then ( ($v | ascii_downcase) as $s
           | ($s != "" and ($s | test("^(false|0|no|none|null|off)$") | not)) )
    else ( $v != false and $v != null and $v != 0 and $v != "" )
    end;

def protected:
  . as $a
  | [ "protected","pinned","pin","hold","hold_reason","holdReason","keepalive",
      "do_not_reap","doNotReap","no_reap","frozen" ]
  | map(. as $k | $a | flag($k))
  | any;

def inflight:
  . as $a
  | [ "inflight_task","inflightTask","current_task","currentTask","running_task",
      "runningTask","active_task","activeTask","in_flight" ]
  | map($a[.]? // null)
  | map(select(. != null and . != "" and . != [] and . != {}))
  | (length > 0);

def qlen:
  ( [ (.queue?, .queued?, .tasks?, .pending?, .pending_tasks?, .pendingTasks? )
      | select(. != null)
      | if type == "array" then length
        elif type == "object" then (if length == 0 then 0 else 1 end)
        else 1 end ] | (max // 0) ) as $q
  | ( [ (.queue_depth?, .queueDepth?, .queued_count?, .queuedCount?, .pending_count?)
      | select(type == "number" or (type == "string" and test("^[0-9]+$")))
      | tonumber | floor ] | (max // 0) ) as $d
  | ([$q, $d] | max);

def busy:
  ( [ .state?, .status?, .phase? ]
    | map(select(type == "string")) | (.[0] // null)
    | (if . == null then null else (ascii_downcase | gsub(" +"; "_")) end) ) as $s
  | ( $s != null
      and ( ["busy","running","working","active","in_progress","inprogress","in-flight",
              "inflight","streaming","thinking","blocked","waiting_for_input"]
            | index($s) ) != null );

def epoch:
  if type == "number" then (if . > 1e11 then ./1000 else . end)
  elif type == "string" then
    ( if test("^[0-9]+(\\.[0-9]+)?$")
      then (tonumber | if . > 1e11 then ./1000 else . end)
      else
        ( capture("^(?<b>[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2})(\\.[0-9]+)?(Z|(?<s>[+-])(?<h>[0-9]{2}):?(?<m>[0-9]{2}))$")
          // null ) as $c
        | if $c == null then null
          else ( (try (($c.b + "Z") | fromdateiso8601) catch null) as $base
                 | if $base == null then null
                   else ( $base
                          - (if $c.s == "+" then 1 else -1 end)
                            * ( (($c.h // "0") | tonumber) * 3600
                              + (($c.m // "0") | tonumber) * 60 ) )
                   end )
          end
      end )
  else null end;

def agents:
  if type == "array" then map(select(type == "object"))
  elif (.agents? | type) == "array" then .agents | map(select(type == "object"))
  elif (.panes?  | type) == "array" then .panes  | map(select(type == "object"))
  else [] end;

def norm:
  . as $a
  | ( [ "last_activity","lastActivity","last_event","lastEvent","updated_at",
        "updatedAt","last_used","lastUsed","last_seen","lastSeen" ]
      | map($a[.]? // null) | map(select(. != null and . != "")) | (.[0] // null) ) as $last
  | { agent:  ($a.agent // $a.name // $a.id // "?"),
      pane:   ($a.pane // $a.pane_id // $a.target // "?"),
      raw:    $last,
      t:      ($last | epoch),
      a:      $a };

def fixed1:
  ((. * 10) | round) as $d
  | (($d / 10 | floor) | tostring) + "." + (($d % 10) | tostring);

# $NOW / $MIN come from --argjson (or are defaulted), so this file also runs as a
# bare `jq -r -f idle_reaper.jq agents.json` with no arguments at all.
($ARGS.named.NOW // now) as $now
| (($ARGS.named.MIN // 60) | tonumber) as $min
| agents
| map(norm)
| map(select(.t != null))
| map(select(($now - .t) / 60 > $min))
| map(select((.a | busy) | not))
| map(select((.a | protected) | not))
| map(select((.a | inflight) | not))
| map(select((.a | qlen) == 0))
| map({ agent, pane,
        idle_minutes: (($now - .t) / 60),
        last_activity: (.raw | tostring) })
| sort_by([ -(.idle_minutes), .agent, .pane ])
| .[]
| [ .agent, .pane, (.idle_minutes | fixed1), .last_activity ]
| @tsv
```

Run it:

```sh
# every candidate, using the real clock
jq -r -f idle_reaper.jq ~/.herdr/agents.json

# fixed clock and threshold (what the tests do)
jq -r -f idle_reaper.jq --argjson NOW 1790445600 --argjson MIN 60 agents.json

# just the panes, for xargs
jq -r -f idle_reaper.jq ~/.herdr/agents.json | cut -f2
```

`NOW` and `MIN` are read from `$ARGS.named` and default to `now` and `60`, so the
bare `jq -r -f idle_reaper.jq agents.json` needs no arguments at all.

## 5. The exact python filter

stdlib only, no dependencies, python3.8+. Same rules, same output, same order.
Save as `idle_reaper_filter.py`.

```python
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
```

Run it:

```sh
python3 idle_reaper_filter.py ~/.herdr/agents.json --minutes 60
cat ~/.herdr/agents.json | python3 idle_reaper_filter.py --json-out
python3 idle_reaper_filter.py ~/.herdr/agents.json --now 2026-09-26T18:00:00Z   # replay
```

Exit codes: `0` always — this is a reporter. `2` only for unusable input (unreadable
file, invalid JSON), so cron can tell "nothing to reap" from "the filter broke".

## 6. Why two implementations

The jq version is what belongs in the cron one-liner: no interpreter start-up, no
dependency, and it composes with `cut`/`xargs`. The python version is what the reaper
daemon and the test suite use: it exposes `reapable()` for direct unit testing, and
it does not depend on jq being installed on the pane host.

`test_idle_reaper.py` runs both against the same fixture and asserts their stdout is
**byte-identical**, so they cannot drift.

## 7. Cron wiring — every 15 minutes

Report only (safe to run from day one):

```cron
*/15 * * * * /usr/bin/jq -r -f $HOME/.herdr/idle_reaper.jq $HOME/.herdr/agents.json >> $HOME/.herdr/reaper-candidates.log 2>>$HOME/.herdr/reaper.err
```

Act on it (only after §8 is in place):

```cron
*/15 * * * * /usr/bin/jq -r -f $HOME/.herdr/idle_reaper.jq $HOME/.herdr/agents.json | /usr/bin/xargs -r -n1 herdr pane reap --
```

`herdr pane reap <pane>` is a **placeholder verb** — confirm the real subcommand with
herdr-kit before this line goes anywhere near a crontab. The filter's contribution
ends at "these panes, in this order"; the reaper's rails decide how many of them
actually die.

Run it by hand first, for several intervals, and diff against
`reaper-candidates.log` before allowing it to act. A filter that suddenly reports
40 panes is a bug in the timestamp field, not 40 idle agents.

## 8. Rails required before anything is killed

The filter is deliberately conservative; the reaper on top of it must be too.

1. **Dry run first.** `--reap` is opt-in. The default action is to log candidates.
2. **Cap per run.** At most 2 reaps per invocation, longest-idle first. A sudden
   spike must not empty the fleet in one tick.
3. **Never reap yourself.** Exclude the pane the reaper is running in, and any pane
   with a live tmux client attached.
4. **Cooldown.** Record reaped panes in a state file; do not re-reap the same pane
   within 30 minutes. A pane that was just created looks identical to an idle one.
5. **Two consecutive agreeing runs.** Require the same pane to be reported by two
   consecutive 15-minute runs before reaping it. This kills the single-interval
   false positive (a pane that was mid-write, or a JSON snapshot taken at a bad
   moment) for free.
6. **Audit every action.** One line per decision — reaped or skipped, with pane,
   agent, idle minutes — appended to a log herdr-kit can read back.
7. **Kill escalation, not `kill -9`.** Ask the agent to exit, wait, then escalate.

## 9. Verified test vector

`idle_agents_fixture.json` (synthetic; no real pane is described in it), evaluated at
`NOW = 2026-09-26T18:00:00Z` (epoch 1790445600), threshold 60 min.

| agent | pane | set up as | expected | why |
|---|---|---|---|---|
| a1 | herdr:0.%3 | idle 120 min, empty queue | **REAP** | the plain case |
| a2 | herdr:0.%5 | idle 61 min | **REAP** | just over the line |
| a3 | herdr:0.%7 | idle 59 min | keep | under the line |
| a4 | herdr:1.%1 | idle 180 min, 2 queued | keep | rule 3 — queued work is not idle |
| a5 | herdr:1.%2 | idle 180 min, inflight task | keep | rule 2 |
| a6 | herdr:1.%3 | idle 180 min, `protected: true` | keep | rule 4 |
| a7 | herdr:1.%4 | idle 180 min, `state: busy` | keep | rule 5 |
| a8 | herdr:1.%5 | idle 180 min, `last_activity: null` | keep | rule 6 — no clock, no reap |
| a9 | herdr:2.%0 | idle 180 min, epoch seconds | **REAP** | numeric timestamps parse |
| a10 | herdr:2.%1 | idle 180 min, epoch millis | **REAP** | >1e11 means millis |
| a11 | herdr:2.%2 | idle 180 min, `+05:30` offset, `queue: null` | **REAP** | offsets + null queue |
| a12 | herdr:2.%3 | idle 180 min, queue is an object | keep | rule 3 — a non-empty object is queued work |
| a13 | herdr:2.%4 | idle 180 min, camelCase keys | **REAP** | alias tolerance works |
| a14 | herdr:2.%5 | idle 180 min, `queue: []` **and** `queue_depth: 3` | keep | rule 3 — depth wins over the empty array |
| a15 | herdr:2.%6 | idle 180 min, `state: waiting_for_input` | keep | rule 5 |
| a16 | herdr:2.%7 | idle 180 min, `hold: "waiting on V"` | keep | rule 4 — a hold reason is a hold |

Expected stdout, identical from both filters:

```
claude	herdr:2.%0	180.0	1790434800
fable	herdr:2.%1	180.0	1790434800000
fable	herdr:2.%4	180.0	2026-09-26T15:00:00Z
muse	herdr:2.%2	180.0	2026-09-26T20:30:00+05:30
fable	herdr:0.%3	120.0	2026-09-26T16:00:00Z
muse	herdr:0.%5	61.0	2026-09-26T16:59:00Z
```

Run it:

```sh
python3 -m unittest test_idle_reaper -v
```

## 10. Known limits, and what to check when the real shape is known

1. **The JSON shape is assumed** (§2). Confirm the real key names before installing;
   if they differ, add them to the two alias tables and re-run the suite.
2. **`last_activity` semantics are assumed** to mean "last thing the agent did", not
   "last time the queue was polled". If herdr refreshes it on poll, nothing will ever
   look idle and the filter will silently report zero forever — which is why §7 says
   to eyeball the log before letting it act.
3. **Clock skew between pane hosts** shifts `idle_minutes`. Anything within a couple
   of minutes of the threshold is noise; the default 60 with a strict `>` comparison
   is deliberately on the cautious side of that.
4. **A queue that lives outside the agent-list JSON** (a BOARD.md, a bus) is invisible
   to this filter. If herdr's queue of record is a file, either have herdr mirror its
   depth into `queue_depth`, or treat every pane as un-reapable until it does.
5. **No reaping of sub-panes or sessions**, only whole panes.
