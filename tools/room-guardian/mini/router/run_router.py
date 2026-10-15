#!/usr/bin/env python3
"""run_router.py -- launchd job com.eta.guardian.router. Runs Router.tick (ack reads, re-pages, V notices, 21:00 list and the monthly _to_delete size line, all in one batch send) every TICK_S on the
Mini-local SQLite case store shared with the subscriber. Does NOT run the server-outbox relay (router_relay.py): that would take the relay lock
and post real server alerts, which is not Phase 0. Routing and ackers come from etc/router.json (re-read every tick)."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alert_router, ubus_bus

HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
TICK_S = 30
alert_router.Router.inbox_path = os.environ.get("GUARDIAN_GATING_INBOX", "~/oc/fable/INBOX-FROM-GATING.md")      # CA-C6: HEAL action lines are appended here


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z"), msg, flush=True)


class LazyBus:
    """Starts the ubus shim only when the tick has something to say or read (most ticks: nothing open)."""
    def __init__(self, cfg):
        self.cfg, self.b = cfg, None

    def _bus(self):
        if self.b is None:
            self.b = ubus_bus.UbusBus(self.cfg)
        return self.b

    def post(self, *a):
        return self._bus().post(*a)

    def thread_messages(self, t):
        return self._bus().thread_messages(t)

    def close(self):
        if self.b is not None:
            self.b.close()


def main():
    try:
        ubus_bus.load_cfg()
    except Exception as e:                           # gate C2: refuse to start on a bad router.json; launchd retries, the log says why, nobody is paged
        log(f"REFUSING TO START: {e.__class__.__name__}: {str(e)[:160]}")
        return 2
    store = alert_router.default_store(HOME)
    router = alert_router.Router(store, ubus_bus.UbusBus, time.time, os.path.join(HOME, "data", "router-local.json"),
                                 lambda: alert_router.guardian_size_lines(HOME))
    log(f"router started pid={os.getpid()}")
    while True:
        try:
            cfg = ubus_bus.load_cfg()
            alert_router.ACKERS = set(cfg["ackers"])
            bus = LazyBus(cfg)
            try:
                out = router.tick(bus)
            finally:
                bus.close()
            if any(out.values()):
                log(f"tick {out}")
        except Exception as e:                       # a bus or store fault must not kill the loop; the case table keeps its state
            log(f"tick failed: {e.__class__.__name__}: {str(e)[:120]}")
        time.sleep(TICK_S)


if __name__ == "__main__":
    sys.exit(main())
