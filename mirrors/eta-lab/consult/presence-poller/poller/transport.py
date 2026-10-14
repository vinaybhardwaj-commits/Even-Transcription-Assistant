import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from calendar import timegm

MAX_AGE_S = 24 * 3600


def _parse_ts(ts):
    return timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ"))


def drop_expired(events, now=None):
    now = now if now is not None else time.time()
    keep = []
    for e in events:
        try:
            if now - _parse_ts(e["ts"]) <= MAX_AGE_S:
                keep.append(e)
        except (KeyError, ValueError):
            pass
    return keep


def load_spool(path):
    try:
        with open(path) as f:
            return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError:
        return []
    except ValueError:
        return []


def save_spool(path, events):
    if not events:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        for e in events:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


MAX_ITEMS = 200            # server MAX_ITEMS per POST (app/api/presence/route.ts)
MAX_BODY_CHARS = 900_000   # server limit is 1,000,000; stay under it
MAX_POSTS_PER_CALL = 100   # one call cannot loop forever (24 h of spool is ~65 chunks)
DRAIN_BUDGET_S = 15        # a tick may spend about this long posting; the rest of the spool waits for the next tick
POST_TIMEOUT_S = 15
SYSTEMIC_DROPS = 3         # this many single-item drops in a row with no success = the server rejects everything: stop
# 4xx that mean "not this item's fault": keep the data and retry later (bad token, wrong route, throttling).
RETRY_4XX = (401, 403, 404, 408, 425, 429)


class Verdict(str):
    """A post() result. The string is the verdict; .detail is a short, secret-free description for the log."""
    detail = ""

    def __new__(cls, verdict, detail=""):
        v = str.__new__(cls, verdict)
        v.detail = detail
        return v


_URL_RE = re.compile(r"https?://\S+")


def scrub(text, token=None):
    """Remove anything secret from a log line: the token, and every URL (a URL may carry a query)."""
    text = _URL_RE.sub("<url>", str(text))
    if token:
        text = text.replace(token, "<token>")
    return text.replace("\n", " ")[:300]


def log_line(data_dir, line):
    """One line to <data_dir>/poller.log, UTC-stamped. Never raises."""
    try:
        os.makedirs(data_dir, exist_ok=True)
        with open(os.path.join(data_dir, "poller.log"), "a") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + line + "\n")
    except OSError:
        pass


def body_of(events):
    return json.dumps(events, separators=(",", ":"))


def http_post(url, token, events, timeout=15):
    """POST an array of events. Returns a Verdict: 'ok' (2xx: delivered, rejected>0 still counts),
    'split' (413: too big, split and retry, never drop), 'drop' (other 4xx: this chunk holds a poison item),
    'retry' (5xx, 3xx, 401/403/404/408/425/429, network, timeout). .detail names the HTTP code or exception class."""
    req = urllib.request.Request(
        url, data=body_of(events).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Verdict("ok" if 200 <= r.status < 300 else "retry", f"HTTP {r.status}")
    except urllib.error.HTTPError as e:
        if e.code == 413:
            return Verdict("split", "HTTP 413")
        if 400 <= e.code < 500 and e.code not in RETRY_4XX:
            return Verdict("drop", f"HTTP {e.code}")
        return Verdict("retry", f"HTTP {e.code}")
    except Exception as e:  # network, timeout, TLS: kept, and now visible in the log
        return Verdict("retry", f"{type(e).__name__}: {scrub(e, token)}")


def write_jsonl(data_dir, events, now=None):
    os.makedirs(data_dir, exist_ok=True)
    day = time.strftime("%Y-%m-%d", time.gmtime(now if now is not None else time.time()))
    with open(os.path.join(data_dir, day + ".jsonl"), "a") as f:
        for e in events:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")


def take_chunk(events, limit=MAX_ITEMS, max_chars=MAX_BODY_CHARS):
    """The oldest events that fit one POST: at most `limit` items and `max_chars` body characters (at least one item)."""
    chunk, size = [], 2
    for e in events[:limit]:
        n = len(json.dumps(e, separators=(",", ":"))) + 1
        if chunk and size + n > max_chars:
            break
        chunk.append(e)
        size += n
    return chunk


DEAD_LETTER_MAX_AGE_S = 7 * 24 * 3600
DEAD_LETTER_MAX_BYTES = 5_000_000


def write_dead_letter(data_dir, event, now=None):
    """A dropped item is kept in dropped.jsonl as {"dropped_at", "event"} (nothing the server refuses is deleted without
    a copy). The file is bounded: at most 7 days and 5 MB, oldest lines dropped first."""
    now = now if now is not None else time.time()
    path = os.path.join(data_dir, "dropped.jsonl")
    try:
        lines = []
        try:
            with open(path) as f:
                lines = [l for l in f.read().splitlines() if l.strip()]
        except FileNotFoundError:
            pass
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        lines.append(json.dumps({"dropped_at": stamp, "event": event}, separators=(",", ":")))
        keep = []
        for l in lines:
            try:
                if now - _parse_ts(json.loads(l)["dropped_at"]) <= DEAD_LETTER_MAX_AGE_S:
                    keep.append(l)
            except (KeyError, ValueError, TypeError):
                pass
        size = sum(len(l) + 1 for l in keep)
        while keep and size > DEAD_LETTER_MAX_BYTES:
            size -= len(keep.pop(0)) + 1
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write("".join(l + "\n" for l in keep))
        os.replace(tmp, path)
    except OSError:
        pass


def call_with_deadline(fn, seconds):
    """Run fn() in a worker thread and give up after `seconds` of wall clock, whatever the socket does (a reply trickled
    one byte at a time, or DNS, can outlast a socket timeout). The abandoned worker is a daemon and finishes on its own.
    Returns fn()'s result, re-raises its exception, or raises TimeoutError."""
    box = {}

    def work():
        try:
            box["v"] = fn()
        except BaseException as e:  # carried back to the caller
            box["e"] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        raise TimeoutError(f"POST exceeded {seconds:.0f} s wall clock, abandoned")
    if "e" in box:
        raise box["e"]
    return box["v"]


def spool_stats(data_dir, now=None):
    """(count, age in seconds of the oldest event) of the spool; (0, 0) when empty."""
    now = now if now is not None else time.time()
    events = load_spool(os.path.join(data_dir, "spool.jsonl"))
    ages = []
    for e in events:
        try:
            ages.append(now - _parse_ts(e["ts"]))
        except (KeyError, ValueError, TypeError):
            pass
    return len(events), int(max(ages)) if ages else 0


def deliver(new_events, data_dir, url=None, token=None, post=http_post, now=None, attempt=True,
            budget_s=DRAIN_BUDGET_S, clock=time.monotonic):
    """Post spool + new events, oldest first, in chunks of <= MAX_ITEMS items and <= MAX_BODY_CHARS body characters.
    Each chunk leaves the spool the moment it is accepted. A 413 splits the chunk and retries; it never drops data.
    Another poison-type 4xx (400/422...) also splits, and only a SINGLE item that still draws it is dropped (logged).
    'retry' keeps everything left in the spool (24 h cap by age) and logs one line.
    TIME BUDGET: no POST is started after `budget_s` seconds, and each POST has a hard wall-clock limit (thread + deadline,
    not just a socket timeout) so the call ends within about budget_s + 5 s; what is left stays in the spool. The result is
    'partial' only if at least one chunk was posted in this call (progress: no backoff), else 'queued' (back off). Dropped items go to dropped.jsonl, never just away. No URL/token: dev fallback, append
    to daily JSONL. Returns 'posted'|'dropped'|'queued'|'jsonl'."""
    if not (url and token):
        write_jsonl(data_dir, new_events, now)
        return "jsonl"
    spool = os.path.join(data_dir, "spool.jsonl")
    os.makedirs(data_dir, exist_ok=True)
    remaining = drop_expired(load_spool(spool) + new_events, now)
    if not remaining:
        save_spool(spool, [])
        return "posted"
    if not attempt:
        save_spool(spool, remaining)
        return "queued"
    save_spool(spool, remaining)  # this tick's new events are on disk before the first POST
    started = clock()
    limit, posts, dropped, posted, consec_drops, ok_streak = MAX_ITEMS, 0, 0, 0, 0, 0
    while remaining:
        elapsed = clock() - started
        if posts >= MAX_POSTS_PER_CALL or elapsed >= budget_s:
            return "partial" if posted else "queued"  # progress this tick = no backoff; none = back off. The spool holds the rest.
        chunk = take_chunk(remaining, limit)
        posts += 1
        try:
            left = max(2, min(POST_TIMEOUT_S, budget_s + 5 - elapsed))  # hard wall-clock limit for this POST
            if post is http_post:
                result = call_with_deadline(lambda: http_post(url, token, chunk, timeout=left), left)
            else:
                result = call_with_deadline(lambda: post(url, token, chunk), left)
            detail = getattr(result, "detail", "") or str(result)
        except Exception as e:
            result, detail = "retry", f"{type(e).__name__}: {scrub(e, token)}"
        if result in (True, "ok"):
            remaining = remaining[len(chunk):]
            save_spool(spool, remaining)
            posted += len(chunk)
            consec_drops, ok_streak = 0, ok_streak + 1
            if ok_streak >= 8:  # after a split, the chunk size grows back only after 8 clean POSTs in a row
                limit, ok_streak = min(MAX_ITEMS, limit * 2), 0
        elif result in ("split", "drop"):
            if len(chunk) > 1:
                limit, ok_streak = max(1, len(chunk) // 2), 0
                continue
            log_line(data_dir, f"DROP single item machine={scrub(chunk[0].get('machine'))} ts={scrub(chunk[0].get('ts'))} "
                               f"code={scrub(detail, token)} spool={len(remaining)}")
            write_dead_letter(data_dir, chunk[0], now)
            remaining = remaining[1:]
            save_spool(spool, remaining)
            dropped += 1
            consec_drops += 1
            limit = MAX_ITEMS
            if consec_drops >= SYSTEMIC_DROPS and posted == 0:
                log_line(data_dir, f"STOP server rejects every item ({consec_drops} single-item drops in a row, none accepted): "
                                   f"keeping the remaining spool={len(remaining)}")
                return "queued"
        else:
            log_line(data_dir, f"POST FAIL code={scrub(detail, token)} chunk={len(chunk)} spool={len(remaining)}")
            save_spool(spool, remaining)
            return "queued"
    return "dropped" if dropped and not posted else "posted"
