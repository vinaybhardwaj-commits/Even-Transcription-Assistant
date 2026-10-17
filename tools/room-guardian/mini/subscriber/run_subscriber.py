#!/usr/bin/env python3
"""run_subscriber.py -- launchd job com.eta.guardian.subscriber. Drives Subscriber from the local pipe over ssh.
Differences from the C4 template (5574b09), each forced by what the pinned pipe does (see PHASE0-REPORT):
  * pico scopes every topic to the publishing user. A room key `<room>` publishing `kiosk/<room>/health` lands on `<room>/kiosk/<room>/health`.
    The subscriber key has the pico `admin` feature and reads absolute names `/<room>/kiosk/<room>/<stream>`. A room cannot write another room's topic.
  * `sub -c -k`: clean output, stay subscribed across publisher disconnects (a kiosk publishes with one ssh per message).
  * each reader reconnects after 5 s; the control snapshot goes to `/<room>/guardian/control` (admin pub), one topic per room.
  * rooms come from etc/rooms.json; case alerts go to the router over ubus (router.json); the kill switch is etc/kill-switch."""
import json, os, queue, subprocess, sys, threading, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import alert_router, ubus_bus
from subscriber import Subscriber, RouterSink, STREAMS, validate_rooms

HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
PIPE_SSH = os.path.join(HOME, "scripts", "pipe-ssh.sh")
KEY = os.path.join(HOME, "keys", "subscriber")


def _open_log():
    try:
        return open(os.path.join(HOME, "logs", "subscriber-ssh.log"), "a")
    except OSError:                                  # (a missing logs dir, e.g. under a test): discard rather than fail to import
        return open(os.devnull, "a")


LOG = _open_log()


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z"), msg, flush=True)


def reader(room, stream, q):
    topic = f"kiosk/{room}/{stream}"
    while True:
        try:
            p = subprocess.Popen([PIPE_SSH, KEY, "sub", "-c", "-k", f"/{room}/{topic}"], stdout=subprocess.PIPE, stderr=LOG, text=True)
            for line in p.stdout:
                q.put((topic, line))
            p.wait()
        except Exception as e:
            log(f"reader {room}/{stream} error {e.__class__.__name__}")
        time.sleep(5)


def publish(room, msg):
    subprocess.run([PIPE_SSH, KEY, "pub", "-c", "-b=false", f"/{room}/guardian/control"], input=msg + "\n", text=True, timeout=15, stderr=LOG)


def check_rooms(rooms, flags):
    """Startup check for rooms.json against the control contract; with consult_open_publish on, the worst-case payload includes the hold map, and with
    consult_live_publish ALSO on (it only takes effect with the hold built) the consult_live map too. -> error string or None."""
    open_on = flags.get("consult_open_publish") is True
    return validate_rooms(rooms, consult_open=open_on,
                          consult_live=open_on and flags.get("consult_live_publish") is True)


def build_subscriber(cfg, rooms, flags, sink, home, clock=time.time, log_file=None, consult_sources=None):
    """The Subscriber exactly as the live process builds it: the consult hold (background refresher, off the publish thread) when its flag is on, start_day (background
    sender) when its flag is on, the F2 USB verify always, and the usb_device_missing seed from the case store. Raises start_day.ConfigError (the caller refuses to start)."""
    consult = start_day = None
    if flags.get("consult_open_publish") is True:    # FR1 2.4 d' flags: default off, so today's control bytes and behaviour are unchanged
        import consult_hold
        consult = consult_hold.build(flags, rooms, sink, home, clock, sources=consult_sources, background=True)
        consult.start()
    if flags.get("start_day_after_boot") is True:
        import start_day as start_day_mod
        start_day = start_day_mod.build(flags, sink, home, clock, log_file, background=True)
    import usb_verify
    verify = usb_verify.UsbVerify(sink, os.path.join(home, "data", "usb-verify-state.json"), clock, os.path.join(home, "logs", "usb-verify-audit.jsonl"))
    return Subscriber(os.path.join(home, "data"), os.path.join(home, "etc"), rooms, sink, clock=clock, quiet_after_s=cfg.get("quiet_after_s", 120), quiet_seed=sink.open_quiet_rooms(),
                      consult=consult, start_day=start_day, usb_verify=verify, usb_missing_seed=sink.open_rooms("usb_device_missing"),
                      consult_live=flags.get("consult_live_publish") is True)


def housekeeping(s, logger=None):
    """The per-iteration checks of the main loop. Each runs on its own, so a fault in one (a bus fault in check_quiet) never skips the others. -> names of the checks that raised."""
    failed = []
    for name in ("check_quiet", "check_start_day", "check_usb_verify", "check_consult_stuck"):
        try:
            getattr(s, name)()
        except Exception as e:                       # a bus fault must not drop the quiet edge: Subscriber marked it raised, so log loudly
            failed.append(name)
            if logger:
                logger(f"{name} failed: {e.__class__.__name__}: {str(e)[:120]}")
    return failed


def main():
    with open(os.path.join(HOME, "etc", "rooms.json")) as f:
        cfg = json.load(f)
    rooms = cfg["rooms"]
    try:
        flags = ubus_bus.load_cfg()
    except Exception:
        flags = {}
    err = check_rooms(rooms, flags)
    if err:                                          # frozen control contract: a room the kiosk regex would reject kills every kiosk, so refuse to start
        log(f"REFUSING TO START: rooms.json: {err}")
        return 2
    try:
        router_cfg = ubus_bus.load_cfg()
    except Exception as e:                           # gate C2
        log(f"REFUSING TO START: {e.__class__.__name__}: {str(e)[:160]}")
        return 2
    alert_router.ACKERS = set(router_cfg["ackers"])
    router = alert_router.Router(alert_router.default_store(HOME), ubus_bus.UbusBus, time.time)   # opens/closes cases; the router job pages and reads acks
    sink = RouterSink(router, router.bus_factory)
    import start_day as start_day_mod
    try:
        s = build_subscriber(cfg, rooms, flags, sink, HOME, time.time, LOG)
    except start_day_mod.ConfigError as e:           # no existing admin path is wired by this code: refuse rather than page start_day_failed forever
        log(f"REFUSING TO START: {e}")
        return 2
    q = queue.Queue()
    for r in rooms:
        for st in STREAMS:
            threading.Thread(target=reader, args=(r, st, q), daemon=True).start()
    log(f"subscriber started pid={os.getpid()} rooms={len(rooms)}")
    last_ctl = last_prune = 0
    while True:
        try:
            s.on_line(*q.get(timeout=5))
        except queue.Empty:
            pass
        except Exception as e:
            log(f"on_line failed: {e.__class__.__name__}: {str(e)[:120]}")
        try:
            alert_router.ACKERS = set(ubus_bus.load_cfg()["ackers"])
        except Exception as e:
            log(f"load_cfg failed: {e.__class__.__name__}: {str(e)[:120]}")
        housekeeping(s, log)
        now = time.time()
        if now - last_ctl >= cfg.get("control_publish_s", 30):
            for r in rooms:
                try:
                    publish(r, s.control_message())     # ts is taken per room, at the moment of this publish
                except Exception as e:
                    log(f"control publish {r} failed: {e.__class__.__name__}")
            last_ctl = now
        if now - last_prune >= 3600:
            log(f"pruned {s.prune()}"); last_prune = now


if __name__ == "__main__":
    sys.exit(main())
