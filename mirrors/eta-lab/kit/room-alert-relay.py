#!/usr/bin/env python3
"""room-alert-relay.py -- pull relay from the app's Room Watchdog alert outbox to the eta bus (herdr-kit; Fable ruling 137,
watchdog design rev 3 + eta-refuter #404/#409/#415/#422, scribe #419/#420).

WHAT: every POLL_INTERVAL s it calls the app's read-only MCP tool scribe_room_alerts over HTTPS (Bearer token from a FILE, never argv),
posts each new alert to the bus (BUS ONLY: no board sink), and writes a one-line last-poll file that conductor greps. It runs on the
Mini. It only makes OUTGOING calls, so the Mini's sshd cannot take it down.

CONTRACT (each line is a review finding):
  F3  before posting row <id> check bus_thread("room-alert-<id>") and skip if it exists (a thread GROUPS, it does not dedupe); post and
      dedupe go through the SAME store (the eta-bus MCP server over stdio, so its nudge wakes an idle conductor).
  F2/F7  process `new` then `late`, dedupe by id; advance the cursor to the highest id in `new` ONLY, after every post succeeded;
      new_truncated or late_truncated true = poll again immediately.
  F4  SILENT (a): the door cannot be read (network, non-200, auth, bad body, ok !== true, missing lists). Never "no new rows".
  F9  SILENT (b): the heartbeat is not provably healthy. Healthy is ONLY state == "ok" AND age_s a real number (bool rejected, finite,
      0 <= age_s <= 300). Missing, null, "none", "stale", NaN, a string: all SILENT.
  F8  single instance: a kernel flock held for the process's life (like pane-watch.py), not a pid check.
  F10 edge-triggered: a SILENT condition posts once when it starts, one recovery when it clears, and re-arms. On process START the
      current SILENT set is re-posted (loud beats lost), at most once per START_REPOST_MIN unless the set changed. Run under launchd
      with a ThrottleInterval so a crash loop stays bounded.
  F6(c) the last-poll file (bus/relay-room-alerts.last-poll, gitignored) is rewritten after every completed poll; conductor greps
      epoch= and posts if it is older than 10 minutes.
Room names may appear in bus messages (the bus is private and bus.db is gitignored); nothing here writes them to a tracked file.
"""
import fcntl, json, math, os, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
HOME = os.path.expanduser("~")
STATE_DIR = os.environ.get("RELAY_STATE_DIR", os.path.join(HOME, "dev/eta-lab/bus"))
LOCK_FILE = os.path.join(STATE_DIR, "relay-room-alerts.lock")
STATE_FILE = os.path.join(STATE_DIR, "relay-room-alerts.state.json")
LAST_POLL_FILE = os.path.join(STATE_DIR, "relay-room-alerts.last-poll")
TOKEN_FILE = os.environ.get("RELAY_TOKEN_FILE", os.path.join(HOME, ".claude/secrets/room_alerts_relay_token"))
MCP_URL = os.environ.get("RELAY_MCP_URL", "")           # e.g. https://<app host>/api/mcp  (public; not the token)
BUS_RUN = os.environ.get("RELAY_BUS_RUN", os.path.join(HOME, "dev/eta-bus-mcp/run.sh"))
BUS_AS = os.environ.get("RELAY_BUS_AS", "room-alert-relay")
BUS_TO = ["conductor"]
POLL_INTERVAL = int(os.environ.get("RELAY_POLL_INTERVAL", "60"))
LIMIT, SILENT_AGE_S = 50, 300
# Late-committer window (scribe #517): a row can commit late by about the cron's maxDuration (60 s), so a few minutes is enough at a 60 s poll.
# LOOKBACK_FIRST covers the very first poll; after that the window is LOOKBACK_BASE plus the gap since the last successful door read,
# so a relay that was down still covers rows that committed late just before it stopped. The tool's ceiling is 60 minutes (MAX_LOOKBACK_MINUTES).
LOOKBACK_FIRST, LOOKBACK_BASE, LOOKBACK_MAX = 10, 3, 60
START_REPOST_S = int(os.environ.get("RELAY_START_REPOST_S", str(30 * 60)))
MAX_PAGES = 20                                            # bounded "poll again immediately"
URGENT_KINDS = {"offline", "degraded", "fleet_outage"}


def log(msg):
    print(f"{datetime.now(IST).strftime('%H:%M:%S')} relay: {msg}", flush=True)


# ---------------------------------------------------------------- the door (HTTP MCP)
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse EVERY 3xx. urllib follows 301/302/303 (as a GET) to another host WITH the request's headers, which would hand the Bearer
    token to whoever answers there (eta-refuter #516, proven with a canary). Refusing makes it SILENT (a) before anything is re-sent."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DoorError(f"redirect ({code}) refused; the token is never re-sent")


def _post(url, headers, body, opener=None):
    """POST and return (status, raw). Raises DoorError with a token-free reason. Kept separate from http_door so the redirect
    handling can be tested against plain local servers; http_door adds the https-only rule."""
    opener = opener or urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with opener.open(req, timeout=40) as r:
            return r.status, r.read()
    except DoorError:
        raise
    except urllib.error.HTTPError as e:
        raise DoorError(f"http {e.code}")
    except Exception as e:
        raise DoorError(f"{e.__class__.__name__}")


def http_door(after_id, lookback_minutes=LOOKBACK_FIRST):
    """One tools/call of scribe_room_alerts. Returns the tool's decoded dict, or raises DoorError(reason)."""
    if not MCP_URL:
        raise DoorError("RELAY_MCP_URL not set")
    if not MCP_URL.lower().startswith("https://"):
        raise DoorError("RELAY_MCP_URL must be https:// (the Bearer token must never travel in cleartext)")   # refused BEFORE anything is sent
    try:
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
    except OSError as e:
        raise DoorError(f"token file unreadable: {e.__class__.__name__}")
    if not token:
        raise DoorError("token file empty")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": "scribe_room_alerts",
                                  "arguments": {"after_id": after_id, "lookback_minutes": int(lookback_minutes), "limit": LIMIT}}}).encode()
    status, raw = _post(MCP_URL, {"content-type": "application/json", "accept": "application/json", "authorization": f"Bearer {token}"}, body)
    if status != 200:
        raise DoorError(f"http {status}")
    try:
        rpc = json.loads(raw)
        res = rpc["result"]
        if res.get("isError"):
            raise DoorError("tool returned isError")
        data = json.loads(res["content"][0]["text"])
    except DoorError:
        raise
    except Exception:
        raise DoorError("response body not the expected JSON-RPC/tool shape")
    return data


class DoorError(Exception):
    pass


# ---------------------------------------------------------------- the bus (stdio MCP client)
class BusError(Exception):
    pass


class BusRefused(BusError):
    """The bus answered and REFUSED this content (tool-level isError, e.g. its secret filter). Deterministic: retrying cannot help.
    Everything else (timeout, server gone) is a plain BusError and must be retried with the cursor unmoved."""


class StdioBus:
    """The eta-bus MCP server over stdio, identity from ETA_BUS_AS (no HERDR_PANE_ID). One process per cycle, closed after."""
    def __init__(self, run=BUS_RUN, as_name=BUS_AS, timeout=60):
        env = dict(os.environ, ETA_BUS_AS=as_name)
        env.pop("HERDR_PANE_ID", None)
        self.p = subprocess.Popen(["/bin/sh", run], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
        self.timeout, self.n = timeout, 0
        self._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "room-alert-relay", "version": "1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, o):
        self.p.stdin.write(json.dumps(o) + "\n"); self.p.stdin.flush()

    def _rpc(self, method, params):
        import select
        self.n += 1; rid = self.n
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        end = time.time() + self.timeout
        while time.time() < end:
            r, _, _ = select.select([self.p.stdout], [], [], 1)
            if not r:
                continue
            line = self.p.stdout.readline()
            if not line:
                raise BusError("bus server closed")
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("id") == rid:
                if "error" in o:
                    raise BusError(str(o["error"])[:200])
                return o["result"]
        raise BusError(f"bus call {method} timed out")

    def _tool(self, name, args):
        res = self._rpc("tools/call", {"name": name, "arguments": args})
        text = (res.get("content") or [{}])[0].get("text", "")
        if res.get("isError"):
            raise BusRefused(text[:200])
        try:
            return json.loads(text)
        except ValueError:
            raise BusError("bus tool answer not JSON")

    def thread_exists(self, thread_id):
        return len(self._tool("bus_thread", {"thread_id": thread_id}).get("messages", [])) > 0

    def post(self, to, subject, body, priority, thread_id):
        self._tool("bus_post", {"to": to, "subject": subject, "body": body, "priority": priority, "thread_id": thread_id})

    def close(self):
        try:
            self.p.stdin.close(); self.p.wait(timeout=5)
        except Exception:
            self.p.kill()
        finally:
            try: self.p.stdout.close()
            except Exception: pass


# ---------------------------------------------------------------- health rules (pure)
def heartbeat_problem(hb):
    """None if PROVABLY healthy, else a reason string. Health is shown, never assumed (F9)."""
    if not isinstance(hb, dict):
        return "heartbeat missing or not an object"
    if hb.get("state") != "ok":
        return f"heartbeat state {hb.get('state')!r}"
    age = hb.get("age_s")
    if isinstance(age, bool) or not isinstance(age, (int, float)):
        return "heartbeat age_s is not a number"
    if not math.isfinite(age) or age < 0:
        return f"heartbeat age_s {age!r} is not a sane age"
    if age > SILENT_AGE_S:
        return f"heartbeat age_s {age} > {SILENT_AGE_S}"
    return None


def door_problem(data):
    """None if the outbox was provably read, else a reason. Only ok === true means read (F4)."""
    if not isinstance(data, dict) or data.get("ok") is not True:
        return "door answered without ok:true" + (f" ({str(data.get('error'))[:80]})" if isinstance(data, dict) and data.get("error") else "")
    for k in ("new", "late"):
        if not isinstance(data.get(k), list):
            return f"door answer has no '{k}' list"
        for row in data[k]:
            # a row with no integer id can never advance the cursor: fail loud instead of stalling silently
            if not isinstance(row, dict) or isinstance(row.get("id"), bool) or not isinstance(row.get("id"), int):
                return f"a row in '{k}' has no integer id"
    return None


def one_line(s, n):
    return " ".join(str(s).split())[:n]


# ---------------------------------------------------------------- the relay
class Relay:
    def __init__(self, door, bus_factory, state_dir=STATE_DIR, clock=time.time):
        self.door, self.bus_factory, self.clock = door, bus_factory, clock
        self.state_file = os.path.join(state_dir, "relay-room-alerts.state.json")
        self.last_poll_file = os.path.join(state_dir, "relay-room-alerts.last-poll")
        os.makedirs(state_dir, exist_ok=True)
        self.state = self._load()
        self.first_poll = True

    def _load(self):
        try:
            with open(self.state_file) as f:
                s = json.load(f)
            if isinstance(s, dict):
                s.setdefault("cursor", 0); s.setdefault("armed", {}); s.setdefault("start_posted", {"ts": 0, "set": []})
                return s
        except (OSError, ValueError):
            pass
        return {"cursor": 0, "armed": {}, "start_posted": {"ts": 0, "set": []}}

    def _save(self):
        tmp = self.state_file + f".tmp{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(self.state, f)
        os.replace(tmp, self.state_file)

    def _write_last_poll(self, status):
        now = int(self.clock())
        line = f"epoch={now} iso={datetime.fromtimestamp(now, IST).isoformat()} status={status} cursor={self.state['cursor']}\n"
        tmp = self.last_poll_file + f".tmp{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(line)
        os.replace(tmp, self.last_poll_file)

    def lookback_minutes(self):
        last = self.state.get("last_door_ok")
        if not isinstance(last, (int, float)) or last <= 0:
            return LOOKBACK_FIRST
        gap_min = max(0.0, (self.clock() - last) / 60.0)
        return int(min(LOOKBACK_MAX, max(LOOKBACK_BASE, math.ceil(gap_min) + LOOKBACK_BASE)))

    # -- SILENT edges (F10)
    def _silent_edges(self, bus, active):
        """active = {cond: reason}. Post on enter, recovery on clear; re-arm by dropping the entry."""
        armed = self.state["armed"]
        entered = []
        for cond, reason in active.items():
            if cond not in armed:
                entered.append(cond)
                armed[cond] = {"since": int(self.clock()), "reason": reason}
                self._say(bus, f"ROOM ALERT RELAY SILENT ({cond}): {one_line(reason, 70)}", f"The room alert relay cannot vouch for alerting. Condition {cond}: {reason}. Until this clears, absence of alerts means nothing.", "urgent", f"room-alert-silent-{cond}-{int(self.clock())}")
        for cond in list(armed):
            if cond not in active:
                since = armed.pop(cond)["since"]
                self._say(bus, f"ROOM ALERT RELAY recovered ({cond})", f"Condition {cond} cleared after {int(self.clock()) - since} s.", "normal", f"room-alert-recovered-{cond}-{int(self.clock())}")
        if self.first_poll:
            sp = self.state["start_posted"]; cur = sorted(active)
            if cur and (sorted(sp["set"]) != cur or self.clock() - sp["ts"] >= START_REPOST_S):
                if not entered:                       # conditions that entered on this very poll were just announced above
                    self._say(bus, f"ROOM ALERT RELAY started, still SILENT ({','.join(cur)})", "; ".join(f"{c}: {armed[c]['reason']}" for c in cur), "urgent", f"room-alert-start-{int(self.clock())}")
                self.state["start_posted"] = {"ts": int(self.clock()), "set": cur}
            elif not cur:
                self.state["start_posted"] = {"ts": 0, "set": []}
        self.first_poll = False

    def _say(self, bus, subject, body, priority, thread_id):
        try:
            bus.post(BUS_TO, subject[:120], body[:4000], priority, thread_id)
        except BusError as e:
            log(f"could not post SILENT/recovery note: {e}")

    # -- alert rows
    def _deliver(self, bus, row):
        rid = row.get("id")
        if not isinstance(rid, int) or isinstance(rid, bool):
            raise BusError("row without an integer id")
        tid = f"room-alert-{rid}"
        if bus.thread_exists(tid):
            return False
        kind = row.get("kind")
        subject = one_line(row.get("subject") or f"room alert {kind}", 110)
        body = str(row.get("body") or "")[:8000]
        room = row.get("room_name")
        body = (f"[{kind}{'; ' + str(room) if room else ''}; from {row.get('status_from')} to {row.get('status_to')}; outbox id {rid}]\n" + body)
        pri = "urgent" if kind in URGENT_KINDS else "normal"
        try:
            bus.post(BUS_TO, f"ROOM ALERT {kind}: {subject}"[:120], body, pri, tid)
        except BusRefused as e:
            # a poison row (e.g. the bus refuses its text) must not block the cursor forever: post a content-free note instead
            log(f"row {rid} refused by the bus ({one_line(e, 80)}); posting a content-free note")
            bus.post(BUS_TO, f"ROOM ALERT {kind} (outbox id {rid}, text withheld)"[:120], f"The bus refused the alert text. kind={kind} outbox id {rid}. Read it from the app outbox.", pri, tid)
        return True

    def poll_once(self):
        """One poll cycle, with the 'again immediately' pages. Returns the last-poll status string."""
        bus = None
        try:
            for _ in range(MAX_PAGES):
                active, again = {}, False
                try:
                    data = self.door(self.state["cursor"], self.lookback_minutes())
                except DoorError as e:
                    data, active["a"] = None, f"cannot read the door: {e}"
                else:
                    p = door_problem(data)
                    if p:
                        data, active["a"] = None, p
                    else:
                        self.state["last_door_ok"] = int(self.clock())
                if data is not None:
                    hp = heartbeat_problem(data.get("heartbeat"))
                    if hp:
                        active["b"] = hp
                    if data.get("late_truncated"):
                        # The late set has no cursor, so paging it makes no progress: rows behind the cursor may be unseen. Say so loudly.
                        active["c"] = "late set truncated: alerts committed late may be unseen"
                if bus is None:
                    bus = self.bus_factory()
                if data is not None:
                    seen = set()
                    new_ids = []
                    for row in data["new"] + data["late"]:
                        rid = row.get("id") if isinstance(row, dict) else None
                        if rid in seen:
                            continue
                        seen.add(rid)
                        self._deliver(bus, row)
                    for row in data["new"]:
                        new_ids.append(row["id"])
                    if new_ids:
                        self.state["cursor"] = max(self.state["cursor"], max(new_ids))     # AFTER every post succeeded
                    again = bool(data.get("new_truncated"))          # the cursor guarantees progress; late_truncated is SILENT (c) above
                self._silent_edges(bus, active)
                self._save()
                status = "OK" if not active else "SILENT:" + ",".join(sorted(active))
                self._write_last_poll(status)
                if not again:
                    return status
            return status + ",pages_capped"
        except BusError as e:
            self._save()
            self._write_last_poll("SILENT:bus")     # the bus itself is down: nothing can be posted; conductor sees the status / staleness
            log(f"bus error, cursor not advanced past unposted rows: {e}")
            return "SILENT:bus"
        finally:
            if bus is not None:
                try: bus.close()
                except Exception: pass


def take_lock(path=LOCK_FILE):
    """F8: a kernel flock held for the process's life. Returns the open file, or None if another relay holds it."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    f = open(path, "a+")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close(); return None
    f.seek(0); f.truncate(); f.write(str(os.getpid())); f.flush()   # pid only for humans
    return f


def main():
    lock = take_lock()
    if lock is None:
        log("another relay holds the lock; exiting"); return 0
    relay = Relay(http_door, StdioBus)
    log(f"started pid={os.getpid()} interval={POLL_INTERVAL}s cursor={relay.state['cursor']}")
    while True:
        try:
            log(f"poll: {relay.poll_once()}")
        except Exception as e:                       # never die silently between polls; the last-poll file just goes stale
            log(f"poll crashed: {e.__class__.__name__}: {one_line(e, 120)}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
