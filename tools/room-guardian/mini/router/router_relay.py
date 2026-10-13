"""router_relay.py -- SUCCESSOR relay loop (FR-1 C4). Subclasses the kit's Relay WITHOUT editing ~/dev/eta-lab/kit/room-alert-relay.py:
loads that file by path (RELAY_KIT_PATH), keeps its door/cursor/flock/SILENT logic, and adds the durable router:
  _deliver  = the kit's plain post, THEN router.on_row (cursor still advances only after every row succeeded);
  poll_once = the kit's poll, THEN router.tick (acks, re-pages, V notices, 21:00 list).
The production case store is NOT built here (no DB writer exists for the Mini; see README flag). main() refuses to run without one.
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
            self.router.on_row(_RouterBus(bus), row)       # runs on a replay too: on_row is idempotent per row id
            return posted

        def poll_once(self):
            status = super().poll_once()
            bus = None
            try:
                bus = self.bus_factory()
                self.router.tick(_RouterBus(bus))
            except Exception as e:                           # router trouble must not stop the plain relay; the case table keeps its state
                kit.log(f"router tick failed: {e.__class__.__name__}: {kit.one_line(e, 100)}")
            finally:
                if bus is not None:
                    try: bus.close()
                    except Exception: pass
            return status
    return RouterRelay


class _RouterBus:
    """Adapts the kit's StdioBus to the router's bus interface. Message shape from bus_thread is INFERRED: {"messages":[{"from","subject","body"}]}."""
    def __init__(self, stdio, to=("gating-lead", "fleet")):
        self.b, self.to = stdio, list(to)

    def post(self, subject, body, priority, thread_id):
        self.b.post(self.to, subject, body, priority, thread_id)

    def thread_messages(self, thread_id):
        return self.b._tool("bus_thread", {"thread_id": thread_id}).get("messages", [])


def main():
    sys.stderr.write("router_relay: no production case store configured (flag in README). Refusing to start.\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
