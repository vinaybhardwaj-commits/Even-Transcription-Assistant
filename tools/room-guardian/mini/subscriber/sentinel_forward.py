"""sentinel_forward.py -- Sentinel S6 (Mini side): forward the latest kiosk health line per room to /api/kiosk-health as event kind
"sentinel" (source "mini_sentinel_forwarder"), so the room-sentinel state reaches Neon and Rooms Live. Behind the flag
sentinel_forward (default false): build_subscriber wires this in only when router.json has "sentinel_forward": true.

Post rule (per room): post when there is no stored post for the room, when the code CHANGED, or when the last successful post is
at least REFRESH_S old -- at most one post per 60 s otherwise. A post that is not 2xx does NOT count as posted: the room is marked
with an exponential backoff (BACKOFF_BASE_S doubling per consecutive failure, capped at BACKOFF_CAP_S = 5 min) and no retry may
start before next_retry, so a failing endpoint (a wrong-hash 401, a down relay) is never hammered -- at most ~7 attempts in the
first 5 minutes instead of one per 10 s health line. A code CHANGE always posts immediately (new state is not rate-limited away);
the backoff streak is per room and survives code changes. In background mode at most one pending post per room is queued
(latest line wins, replacing the queued body); the queue is bounded to MAX_PENDING rooms and an overflow DROPS THE OLDEST room,
counting the drop (persisted; never logged per item). Backoff progress is logged once per backoff STEP (when the interval
grows), one audit line, never per item. A health line with no code the server would accept (kiosk build predates Sentinel, or a
code word outside the 8-code set) posts nothing: an unknown code is a 400 on the server, and nothing is invented -- OK is never
sent for a line that does not say OK.

Credential: the SAME config/env as the mic-guard poller (tools/eta-micguard-poller/poll.py): token file env MICGUARD_TOKEN_FILE
(default ~/.claude/secrets/kiosk_health_ingest_token), URL env MICGUARD_INGEST_URL (default the prod kiosk-health endpoint). The
token is read at send time, never stored in state, and never logged: audit lines carry the room, the code word and the HTTP
status only. The machine field of the event is the room slug (the subscriber knows slugs, not Mac hostnames). Python 3 standard
library only.
"""
import json, math, os, queue, threading, time, urllib.error, urllib.request
from datetime import datetime, timezone

KIND = "sentinel"
SOURCE = "mini_sentinel_forwarder"
INSTALL_ID = "mini-sentinel-forwarder"
REFRESH_S = 60            # re-post an unchanged room at most once per this many seconds (unless the code changed)
POST_TIMEOUT_S = 10
BACKOFF_BASE_S = 5        # first retry wait after a failed post; doubles per consecutive failure (F1: no re-post storm)
BACKOFF_CAP_S = 300       # the backoff never waits longer than 5 minutes between attempts
MAX_PENDING = 16          # the background queue is bounded; an overflow drops the oldest room (drop-oldest, counted)
DEFAULT_URL = "https://www.evenscribe.app/api/kiosk-health"      # the apex 307-redirects, and urllib does not follow a POST redirect
DEFAULT_CRED_PATH = "~/.claude/secrets/kiosk_health_ingest_token"
CODES = ("MIC_DEAD_WEBCAM", "MIC_MUTED_TONOR", "DEVICE_MISSING", "RECORDER_DOWN", "PRESENCE_DEAD", "TAILNET_DOWN", "MIC_PERM", "OK")
MIC_CLASSES = ("webcam", "tonor", "unknown")
MODES = ("shadow", "heal")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _ratio(v):
    """A zero-ratio / peak value: a finite number in [0, 1], else None (never clamped, never invented)."""
    return v if _num(v) and 0 <= v <= 1 else None


def _word(v, mx=64):
    return v if isinstance(v, str) and 1 <= len(v) <= mx else None


def _first(obj, *keys):
    for k in keys:
        if k in obj:
            return obj[k]
    return None


def extract(obj):
    """A health line -> the sentinel payload, or None when the line carries no code the server would accept (absent, not a string,
    or outside the 8-code set). Fields the line does not carry become null / the fail-closed words, never guesses:
    mic_class "unknown", mode "shadow". Field names follow the Sentinel S2/S4 health line (zr, peak, mic_class, code); the
    kiosk's pre-S2 zero_ratio / zero_ratio_2s and peak_2s names are read as fallbacks so the forwarder works before and after."""
    if not isinstance(obj, dict):
        return None
    code = obj.get("code")
    if not isinstance(code, str) or code not in CODES:
        return None
    mc = obj.get("mic_class")
    if not isinstance(mc, str) or mc not in MIC_CLASSES:
        mc = "unknown"
    mode = obj.get("mode")
    if not isinstance(mode, str) or mode not in MODES:
        mode = "shadow"
    return {"code": code, "mic_class": mc,
            "zr": _ratio(_first(obj, "zr", "zero_ratio_2s", "zero_ratio")),
            "peak": _ratio(_first(obj, "peak", "peak_2s")),
            "last_action": _word(obj.get("last_action")),
            "last_result": _word(obj.get("last_result")),
            "mode": mode}


def should_post(prev, code, now_epoch):
    """prev: {"code": ..., "posted_at": ...} or None."""
    if not prev:
        return True
    if prev.get("code") != code:
        return True
    return now_epoch - int(prev.get("posted_at", 0)) >= REFRESH_S


def read_token(path):
    try:
        with open(os.path.expanduser(path)) as fh:
            t = fh.read().strip()
        return t or None
    except OSError:
        return None


def real_post(url, token, body_bytes, timeout=POST_TIMEOUT_S):
    req = urllib.request.Request(url, data=body_bytes, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


class SentinelForward:
    def __init__(self, poster, state_path=None, clock=time.time, audit_path=None, background=False, idle_s=30):
        self.poster, self.state_path, self.clock, self.audit_path = poster, state_path, clock, audit_path
        self.background = background is True          # True (live): the send runs in a worker thread (10 s poster timeout), so the loop never waits on it
        self._lock = threading.RLock()                # guards boot_epoch / seq / marks and the state file; never held while the poster runs
        self._q, self._worker, self.idle_s = queue.Queue(), None, idle_s
        self._wlock = threading.Lock()                # taken by _enqueue and by the worker's idle exit, so an item can never be queued for a worker that is leaving
        self.boot_epoch = int(clock())
        self.seq = 0
        self.drops = 0                                # queue overflow drops (drop-oldest); counted and persisted, never logged per item
        self.state = {}                               # room -> {"code","posted_at"} of the last SUCCESS + the failure streak
                                                 #     {"pending_code","fails","next_retry","backoff_s","attempted_at"} (F1)
        self._queued = {}                             # background mode: room -> (code, body, now); at most one pending post per room (latest wins)
        self._load()

    # ---- state (seq advances BEFORE the post, as the mic-guard poller does: never reused)
    def _load(self):
        if not self.state_path or not os.path.exists(self.state_path):
            return
        try:
            with open(self.state_path) as f:
                d = json.load(f)
            if isinstance(d, dict):
                if _num(d.get("boot_epoch")):
                    self.boot_epoch = int(d["boot_epoch"])
                if _num(d.get("seq")) and d["seq"] >= 0:
                    self.seq = int(d["seq"])
                if _num(d.get("drops")):
                    self.drops = int(d["drops"])
                rooms = d.get("rooms")
                if isinstance(rooms, dict):
                    for k, v in rooms.items():
                        if not isinstance(v, dict):
                            continue
                        # a valid entry has the last success (code+posted_at) or a live failure streak (pending_code+next_retry)
                        if not (isinstance(v.get("code"), str) and _num(v.get("posted_at"))) and not (isinstance(v.get("pending_code"), str) and _num(v.get("next_retry"))):
                            continue
                        e = {}
                        if isinstance(v.get("code"), str):
                            e["code"] = v["code"]
                        if _num(v.get("posted_at")):
                            e["posted_at"] = int(v["posted_at"])
                        if isinstance(v.get("pending_code"), str):
                            e["pending_code"] = v["pending_code"]
                        for key in ("fails", "next_retry", "backoff_s", "attempted_at"):
                            if _num(v.get(key)):
                                e[key] = int(v[key])
                        self.state[str(k)] = e
        except (OSError, ValueError):
            pass

    def _save(self):
        """Best effort: a write fault is audited and never raises (the in-memory state still stops a second post in this process)."""
        if not self.state_path:
            return
        try:
            with self._lock:
                d = {"boot_epoch": self.boot_epoch, "seq": self.seq, "drops": self.drops, "rooms": dict(self.state)}
                tmp = f"{self.state_path}.tmp{os.getpid()}"
                with open(tmp, "w") as f:
                    json.dump(d, f, sort_keys=True)
                os.replace(tmp, self.state_path)
        except Exception:                 # noqa: BLE001
            self._audit("-", "sentinel_state_write_fault", self.clock())

    def _audit(self, room, event, now, **kw):
        if not self.audit_path:
            return
        try:
            with self._lock:
                line = dict(kw, ts=int(now), room=room, event=event)
            os.makedirs(os.path.dirname(self.audit_path), exist_ok=True)
            with open(self.audit_path, "a") as f:
                f.write(json.dumps(line, sort_keys=True) + "\n")
        except OSError:
            pass

    # ---- health lines
    def on_health(self, room, obj, now=None):
        """Never raises: a fault is audited and the caller carries on with the rest of the health line."""
        try:
            self._on_health(room, obj, self.clock() if now is None else now)
        except Exception:                 # noqa: BLE001
            self._audit(room, "sentinel_forward_fault", self.clock())

    def _on_health(self, room, obj, now):
        payload = extract(obj)
        if payload is None:
            return
        with self._lock:
            st = self.state.get(room)
            pc = st.get("pending_code") if st else None       # the code of the last FAILED attempt (None: none pending)
            nr = st.get("next_retry") if st else None
            if pc == payload["code"] and nr is not None and now < int(nr):
                return                       # F1: backing off on exactly this code -- hold the line, no re-post
            if pc != payload["code"] and not should_post(st, payload["code"], now):
                return                       # same code as the last success, inside the refresh window, nothing pending
            # a code CHANGE always posts (new state is not rate-limited away), even mid-backoff
            self.seq += 1
            boot_id = str(self.boot_epoch)
            seq = self.seq
            self._save()                   # the seq is persisted BEFORE the post: a crash mid-send never reuses it
        ev = {"machine": room, "room_id": room, "install_id": INSTALL_ID, "boot_id": boot_id, "seq": seq,
              "source": SOURCE, "kind": KIND,
              "ts": datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "payload": payload}
        body = json.dumps({"events": [ev]}).encode("utf8")
        if self.background:
            self._enqueue(room, payload["code"], body, now)
        else:
            self._send(room, payload["code"], body, now)

    def _send(self, room, code, body, now):
        token = read_token(os.environ.get("MICGUARD_TOKEN_FILE", DEFAULT_CRED_PATH))
        if token is None:
            self._audit(room, "sentinel_no_token", now, code=code)     # nothing posted; the next line retries (a token appearing later unblocks it)
            return
        url = os.environ.get("MICGUARD_INGEST_URL", DEFAULT_URL)
        try:
            status = self.poster(url, token, body, POST_TIMEOUT_S)
        except Exception:                 # noqa: BLE001 -- a raising poster counts as a failed send
            status = 0
        if isinstance(status, int) and 200 <= status < 300:
            with self._lock:
                self.state[room] = {"code": code, "posted_at": int(now), "pending_code": None, "fails": 0,
                                    "next_retry": None, "backoff_s": 0, "attempted_at": int(now)}
            self._save()
            self._audit(room, "sentinel_forwarded", now, code=code, status=status)
        else:
            # F1: the failure is marked and the room backs off exponentially (5 s doubling, capped at 5 min); a code change
            # still posts immediately, a success clears the streak. Never the token in the audit.
            with self._lock:
                st = self.state.get(room) or {}
                fails = int(st.get("fails", 0)) + 1
                backoff = min(BACKOFF_CAP_S, BACKOFF_BASE_S * (2 ** (fails - 1)))
                self.state[room] = {"code": st.get("code"), "posted_at": st.get("posted_at"),
                                    "pending_code": code, "fails": fails, "next_retry": int(now) + backoff,
                                    "backoff_s": backoff, "attempted_at": int(now)}
                stepped = backoff != int(st.get("backoff_s", 0))
                self._save()
            if stepped:
                self._audit(room, "sentinel_backoff", now, code=code, fails=fails, backoff_s=backoff)  # one line per step, not per item
            self._audit(room, "sentinel_post_failed", now, code=code, status=status)

    # ---- background worker (same idle-exit pattern as start_day)
    def _queue_item(self, room, code, body, now):
        """One pending post per room: a newer line for a queued room REPLACES its body (latest wins). The queue is bounded to
        MAX_PENDING rooms; an overflow drops the OLDEST room and counts the drop (persisted; never logged per item)."""
        with self._wlock:
            if room in self._queued:
                self._queued[room] = (code, body, now)
                return
            if len(self._queued) >= MAX_PENDING:
                oldest = min(self._queued, key=lambda r: self._queued[r][2])
                del self._queued[oldest]
                self.drops += 1
                self._save()
            self._queued[room] = (code, body, now)

    def _enqueue(self, room, code, body, now):
        self._queue_item(room, code, body, now)
        with self._wlock:
            self._q.put(room)
            if self._worker is None or not self._worker.is_alive():    # restarted if it ever died or has gone idle
                self._worker = threading.Thread(target=self._work, name="sentinel-forwarder", daemon=True)
                self._worker.start()

    def _try_exit(self):
        """The idle exit, under the lock _enqueue takes: -> True (and the worker is cleared) only when nothing is queued."""
        with self._wlock:
            if self._q.empty():
                self._worker = None
                return True
            return False

    def _work(self):
        while True:
            try:
                room = self._q.get(timeout=self.idle_s)
            except queue.Empty:
                if self._try_exit():
                    return                # idle: the thread ends and the next send starts a new one
                continue                  # an item arrived while we were leaving: take it
            try:
                item = self._queued.pop(room, None)
                if item is not None:      # None: the item was dropped by the bound (or replaced and already consumed)
                    code, body, now = item
                    self._send(room, code, body, now)
            except BaseException:         # noqa: BLE001 -- the worker never dies on a fault
                pass


def build(flags, home, clock=time.time, poster=real_post, background=True):
    """-> SentinelForward for the flag-on case, exactly as the live process builds it (state under <home>/data, audit under <home>/logs)."""
    return SentinelForward(poster, os.path.join(home, "data", "sentinel-forward-state.json"), clock,
                           os.path.join(home, "logs", "sentinel-forward-audit.jsonl"), background=background)
