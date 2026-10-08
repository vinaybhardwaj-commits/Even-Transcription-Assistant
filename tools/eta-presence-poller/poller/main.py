import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from .events import collect, iso_now, make_event
from .probe import METHOD, ssh_run
from .transport import deliver, log_line, spool_stats

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS = os.path.expanduser("~/.claude/secrets")
DATA_DIR = os.environ.get("PRESENCE_DATA_DIR", os.path.expanduser("~/eta-data/presence"))
INTERVAL = 60


def load_hosts(path=None):
    with open(path or os.path.join(HERE, "hosts.json")) as f:
        data = json.load(f)
    return [{"machine": h["name"], "ssh": h["target"]} for h in data["hosts"]]


DEFAULT_URL = "https://www.evenscribe.app/api/presence"
TOKEN_FILES = ("~/.config/eta-presence/ingest.token", "~/oc/eta-presence-ingest/.ingest-token")


def get_url():
    return (os.environ.get("PRESENCE_INGEST_URL") or DEFAULT_URL).strip()


def get_token():
    """Env PRESENCE_INGEST_TOKEN, else the first readable token file. Never logged."""
    v = os.environ.get("PRESENCE_INGEST_TOKEN")
    if v and v.strip():
        return v.strip()
    files = [os.environ["PRESENCE_INGEST_TOKEN_FILE"]] if os.environ.get("PRESENCE_INGEST_TOKEN_FILE") else TOKEN_FILES
    for p in files:
        try:
            with open(os.path.expanduser(p)) as f:
                t = f.read().strip()
            if t:
                return t
        except OSError:
            pass
    return None


TICK_DEADLINE = 40  # seconds; must stay under INTERVAL


def tick(hosts, runner=ssh_run, now=None, deadline=TICK_DEADLINE):
    """One event per host, always. A host that fails or misses the deadline is unreachable."""
    ex = ThreadPoolExecutor(max_workers=len(hosts) or 1)
    futs = [(h, ex.submit(collect, h, runner, now)) for h in hosts]
    end = time.time() + deadline
    events = []
    for h, f in futs:
        try:
            events.append(f.result(timeout=max(0, end - time.time())))
        except Exception:
            events.append(make_event(h["machine"], iso_now(now), None))
    ex.shutdown(wait=False, cancel_futures=True)  # never wait on a stuck worker
    return events


_backoff = {"fails": 0, "next": 0.0}


def run_once():
    events = tick(load_hosts())
    now = time.time()
    mode = deliver(events, DATA_DIR, get_url(), get_token(), attempt=now >= _backoff["next"])
    if mode == "queued":
        _backoff["fails"] += 1
        _backoff["next"] = now + min(480, 30 * 2 ** _backoff["fails"])  # exponential, cap 8 min
    elif mode in ("posted", "dropped", "partial"):  # partial = progress inside the drain budget, not a failure
        _backoff.update(fails=0, next=0.0)
    n, age = spool_stats(DATA_DIR, now)
    if n:  # a non-empty spool is the symptom of an outage: say so every tick
        log_line(DATA_DIR, f"TICK mode={mode} spool={n} oldest_age_s={age}")
    return mode, events


def main(argv):
    if "--once" in argv:
        mode, events = run_once()
        for e in events:
            print(json.dumps(e, separators=(",", ":")))
        print("delivery:", mode, file=sys.stderr)
        for k, v in METHOD.items():
            print("transport:", k, v, file=sys.stderr)
        return 0
    while True:  # supervisor-friendly loop; launchd KeepAlive restarts on crash
        start = time.time()
        try:
            run_once()
        except Exception as e:
            log_line(DATA_DIR, f"TICK FAILED {type(e).__name__}")
        time.sleep(max(1, INTERVAL - (time.time() - start)))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
