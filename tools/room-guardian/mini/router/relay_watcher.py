#!/usr/bin/env python3
"""relay_watcher.py -- separate Mini watcher: page if the relay's last-poll file is older than 10 min (A6 design 8). Run by launchd every 60 s.
Edge-triggered with a state file: one page when stale starts, one note when it clears. Reads only the epoch= field; posts through an injected post()."""
import json, os, re, sys, time

STALE_S = 600


def read_epoch(path):
    try:
        with open(path) as f:
            m = re.search(r"\bepoch=(\d+)", f.read())
        return int(m.group(1)) if m else None
    except OSError:
        return None


def check(last_poll_path, state_path, post, clock=time.time):
    now = clock()
    ep = read_epoch(last_poll_path)
    stale = ep is None or now - ep > STALE_S
    try:
        with open(state_path) as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {}
    was = bool(st.get("stale"))
    why = "last-poll file missing or unreadable" if ep is None else f"last poll {int(now - ep)} s ago"
    if stale and not was:
        post(f"ROOM ALERT RELAY NOT POLLING: {why}", "The relay's last-poll is older than 10 minutes. Until it recovers, absence of room alerts means nothing.", "urgent")
    elif was and not stale:
        post("ROOM ALERT RELAY polling again", "The relay's last-poll is fresh.", "normal")
    tmp = f"{state_path}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump({"stale": stale}, f)
    os.replace(tmp, state_path)
    return "stale" if stale else "ok"


def main():
    import importlib.util
    kit_path = os.environ.get("RELAY_KIT_PATH", os.path.expanduser("~/dev/eta-lab/kit/room-alert-relay.py"))
    spec = importlib.util.spec_from_file_location("room_alert_relay_kit", kit_path)
    kit = importlib.util.module_from_spec(spec); spec.loader.exec_module(kit)
    state_dir = kit.STATE_DIR
    bus = kit.StdioBus(as_name="room-alert-watcher")
    try:
        r = check(kit.LAST_POLL_FILE, os.path.join(state_dir, "relay-watcher.state.json"),
                  lambda s, b, p: bus.post(kit.BUS_TO, s[:120], b, p, f"room-alert-relay-watch-{int(time.time())}"))
    finally:
        bus.close()
    print(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
