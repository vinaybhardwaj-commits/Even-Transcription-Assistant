#!/usr/bin/env python3
"""run_subscriber.py -- drives Subscriber from the pipe over ssh (one `sub` process per room+stream). Not loaded by any launchd job in this repo.
INFERRED: pipe topics have no wildcard, so the room list comes from rooms.json; `ssh -p PORT host sub <topic>` is the read form (UNVERIFIED on a live pipe)."""
import json, os, queue, subprocess, sys, threading, time
from subscriber import Subscriber, SpoolSink, STREAMS

HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))


def reader(cmd, topic, q):
    p = subprocess.Popen(cmd + ["sub", topic], stdout=subprocess.PIPE, text=True)
    for line in p.stdout:
        q.put((topic, line))


def main():
    cfg = json.load(open(os.path.join(HOME, "rooms.json")))
    host, port = os.environ["PIPE_HOST"], os.environ["PIPE_SSH_PORT"]
    ssh = ["ssh", "-p", port, "-i", os.path.join(HOME, "subscriber_ed25519"), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", host]
    s = Subscriber(os.path.join(HOME, "data"), HOME, cfg["rooms"], SpoolSink(os.path.join(HOME, "data", "spool")), quiet_after_s=cfg.get("quiet_after_s", 120))
    q = queue.Queue()
    for r in cfg["rooms"]:
        for st in STREAMS:
            threading.Thread(target=reader, args=(ssh, f"kiosk/{r}/{st}", q), daemon=True).start()
    last_ctl = last_prune = 0
    while True:
        try:
            s.on_line(*q.get(timeout=5))
        except queue.Empty:
            pass
        s.check_quiet()
        now = time.time()
        if now - last_ctl >= cfg.get("control_publish_s", 30):
            s.publish_control(lambda t, m: subprocess.run(ssh + ["pub", t], input=m, text=True, timeout=10))
            last_ctl = now
        if now - last_prune >= 3600:
            s.prune(); last_prune = now


if __name__ == "__main__":
    sys.exit(main())
