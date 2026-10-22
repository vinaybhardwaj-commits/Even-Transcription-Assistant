#!/usr/bin/env python3
"""run_router.py -- launchd job com.eta.guardian.router. Runs Router.tick (ack reads, pages, reminders, cleared lines, V notices, 21:00 list and the monthly _to_delete size line, all in one batch send) every TICK_S on the
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


alert_router.Router.log_fn = staticmethod(log)      # FR1 D7: denied ack reads, once per case (metadata only)


_whoami_logged = None


class LazyBus:
    """Starts the ubus shim only when the tick has something to say or read (most ticks: nothing open). A failed start (FR1 D7: an identity
    mismatch on ubus_whoami) is remembered for the rest of the tick, so one tick starts the shim at most once and sends nothing."""
    def __init__(self, cfg):
        self.cfg, self.b, self.err = cfg, None, None

    def _bus(self):
        if self.err is not None:
            raise self.err
        if self.b is None:
            try:
                self.b = ubus_bus.UbusBus(self.cfg)
            except Exception as e:
                self.err = e
                log(f"bus start failed: {e.__class__.__name__}: {str(e)[:120]}")
                raise
            global _whoami_logged
            idn = getattr(self.b, "identity", None)
            if idn != _whoami_logged:                 # the first start of this process, and any change after it: one line
                _whoami_logged = idn
                log(f"whoami handle={idn and idn.get('handle')} session={ubus_bus.SESSION} registered={idn and idn.get('registered')}")
        return self.b

    def post(self, *a):
        return self._bus().post(*a)

    def thread_messages(self, t):
        return self._bus().thread_messages(t)

    def close(self):
        if self.b is not None:
            self.b.close()


def startup_check(router, cfg):
    """FR1 D7-2: at startup, one shim start and the whoami check even with nothing due, so a wrong identity shows at once (the whoami line, or
    the ROUTER SILENT line through router.identity_alarm). Returns True when the identity is right."""
    bus = LazyBus(cfg)
    try:
        bus._bus()
        return True
    except Exception as e:
        if getattr(e, "identity", None) is not None:
            router.identity_alarm(e.identity)
        return False
    finally:
        bus.close()


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
    try:
        startup_check(router, ubus_bus.load_cfg())
    except Exception as e:                           # never fatal: the loop below retries every tick
        log(f"startup check failed: {e.__class__.__name__}: {str(e)[:120]}")
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
