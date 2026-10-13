"""router_relay.py -- SUCCESSOR relay loop (FR-1 C4). Subclasses the kit's Relay WITHOUT editing ~/dev/eta-lab/kit/room-alert-relay.py:
loads that file by path (RELAY_KIT_PATH), keeps its door/cursor/flock/SILENT logic, and adds the durable router:
  _deliver  = the kit's plain post, THEN router.on_row (cursor still advances only after every row succeeded);
  poll_once = the kit's poll, THEN router.tick (acks, re-pages, V notices, 21:00 list).
Production store: Mini-local SQLite at <GUARDIAN_HOME>/data/cases.sqlite (alert_router.default_store).
"""
import importlib.util, os, sys

KIT = os.environ.get("RELAY_KIT_PATH", os.path.expanduser("~/dev/eta-lab/kit/room-alert-relay.py"))


def load_kit(path=KIT):
    spec = importlib.util.spec_from_file_location("room_alert_relay_kit", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_relay_class(kit):
    class RouterRelay(kit.Relay):
        def __init__(self, router, *a, **kw):
            super().__init__(*a, **kw)
            self.router = router

        def _deliver(self, bus, row):
            posted = super()._deliver(bus, row)
            self.router.on_row(RouterBus(bus), row)       # runs on a replay too: on_row is idempotent per row id
            return posted

        def poll_once(self):
            status = super().poll_once()
            bus = None
            try:
                bus = self.bus_factory()
                self.router.tick(RouterBus(bus))
            except Exception as e:                           # router trouble must not stop the plain relay; the case table keeps its state
                kit.log(f"router tick failed: {e.__class__.__name__}: {kit.one_line(e, 100)}")
            finally:
                if bus is not None:
                    try: bus.close()
                    except Exception: pass
            return status
    return RouterRelay


class RouterBus:
    """Adapts the kit's StdioBus to the router's bus interface. Message shape from bus_thread is INFERRED: {"messages":[{"from","subject","body"}]}."""
    def __init__(self, stdio, to=("gating-lead", "fleet")):
        self.b, self.to = stdio, list(to)

    def post(self, subject, body, priority, thread_id):
        self.b.post(self.to, subject, body, priority, thread_id)

    def thread_messages(self, thread_id):
        return self.b._tool("bus_thread", {"thread_id": thread_id}).get("messages", [])


def main():
    import time
    kit = load_kit()
    home = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
    import alert_router
    store = alert_router.default_store(home)                     # Mini-local SQLite, WAL (C4 R2 ruling 1)
    router = alert_router.Router(store, lambda: RouterBus(kit.StdioBus()), time.time, os.path.join(home, "data", "router-local.json"))
    lock = kit.take_lock()
    if lock is None:
        kit.log("another relay holds the lock; exiting"); return 0
    relay = make_relay_class(kit)(router, kit.http_door, kit.StdioBus)
    kit.log(f"router relay started pid={os.getpid()} cursor={relay.state['cursor']}")
    last_backup = ""
    while True:
        try:
            kit.log(f"poll: {relay.poll_once()}")
            day = time.strftime("%Y-%m-%d")
            if time.strftime("%H") == "02" and day != last_backup:      # nightly copy, 14 kept
                store.backup_to(os.path.join(home, "backup"), keep=14); last_backup = day
        except Exception as e:
            kit.log(f"poll crashed: {e.__class__.__name__}: {kit.one_line(e, 120)}")
        time.sleep(kit.POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
