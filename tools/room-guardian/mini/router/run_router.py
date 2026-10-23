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
STARTUP_RETRY_S, STARTUP_WINDOW_S = 30, 300      # FR1 D7-3 item 6 / D7-4: a failed startup check is retried 30 s after the failed attempt, until 300 s after the first one


def whoami_line(handle, registered, why):
    """FR1 D7-4 NIT-2: the one line each identity check logs. Metadata only."""
    return f"whoami handle={'none' if handle is None else str(handle)[:60]} session={ubus_bus.SESSION} registered={'none' if registered is None else registered} why={str(why)[:80]}"


class LazyBus:
    """Starts the ubus shim only when the tick has something to say or read (most ticks: nothing open). A failed start (FR1 D7: an identity
    mismatch on ubus_whoami) is remembered for the rest of the tick, so one tick starts the shim at most once and sends nothing.
    quiet=True (the startup check): logs nothing itself; startup_check logs its own whoami line on every attempt."""
    def __init__(self, cfg, quiet=False):
        self.cfg, self.b, self.err, self.quiet = cfg, None, None, quiet

    def _bus(self):
        if self.err is not None:
            raise self.err
        if self.b is None:
            try:
                self.b = ubus_bus.UbusBus(self.cfg)
            except Exception as e:
                self.err = e
                if not self.quiet:
                    log(f"bus start failed: {e.__class__.__name__}: {str(e)[:120]}")
                raise
            global _whoami_logged
            idn = getattr(self.b, "identity", None)
            if not self.quiet and idn != _whoami_logged:      # the first start of this process, and any change after it: one line
                _whoami_logged = idn
                log(whoami_line(idn and idn.get("handle"), idn and idn.get("registered"), "ok"))
        return self.b

    def post(self, *a):
        return self._bus().post(*a)

    def thread_messages(self, t):
        return self._bus().thread_messages(t)

    def close(self):
        if self.b is not None:
            self.b.close()


def startup_check(router, cfg):
    """FR1 D7-2: at startup, one shim start and the whoami check even with nothing due, so a wrong identity shows at once (the ROUTER SILENT line
    through router.identity_alarm). D7-4: every attempt logs one whoami line, with why= (ok, or the refusal). Returns True when the identity is right."""
    global _whoami_logged
    bus = LazyBus(cfg, quiet=True)
    try:
        bus._bus()
        idn = bus.b.identity
        _whoami_logged = idn                              # the tick-time LazyBus does not repeat this line
        log(whoami_line(idn.get("handle"), idn.get("registered"), "ok"))
        return True
    except Exception as e:
        if getattr(e, "identity", None) is not None:
            router.identity_alarm(e.identity)
            log(whoami_line(e.handle, e.registered, e))
        else:
            log(whoami_line(None, None, f"{e.__class__.__name__}: {e}"))
        return False
    finally:
        bus.close()


def try_startup(router):
    """One startup_check attempt that never raises."""
    try:
        return bool(startup_check(router, ubus_bus.load_cfg()))
    except Exception as e:                               # never fatal: the loop retries
        log(f"startup check failed: {e.__class__.__name__}: {str(e)[:120]}")
        return False


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
    # FR1 D7-3 item 6 / D7-4 NIT-1: a failed startup check is retried every 30 s (the first retry 30 s after the failed attempt), up to 300 s after
    # the first attempt, interleaved with normal ticks (an old shim's claim can stay live for 3 min after SIGKILL). Never after a success.
    first_try = time.time()
    startup_ok = try_startup(router)
    next_try = time.time() + STARTUP_RETRY_S
    while True:
        now = time.time()
        if not startup_ok and now >= next_try and now - first_try <= STARTUP_WINDOW_S:
            startup_ok = try_startup(router)
            next_try = time.time() + STARTUP_RETRY_S
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
