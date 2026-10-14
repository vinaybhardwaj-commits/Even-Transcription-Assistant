import time
from . import VERSION
from .probe import PROBE_SCRIPT, ProbeError, parse_probe

FIELDS = ("machine", "ts", "idle_s", "locked", "chrome_running",
          "console_user", "state", "poller_version")


def iso_now(now=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now if now is not None else time.time()))


def make_event(machine, ts, probe=None):
    """probe=None means unreachable. Exactly FIELDS, nothing else."""
    if probe is None:
        ev = dict(idle_s=0, locked=False, chrome_running=False, console_user=None, state="unreachable")
    else:
        # sink wants JSON booleans; unknown lock (-1) is null
        ev = dict(idle_s=probe["idle_s"],
                  locked=None if probe["locked"] == -1 else bool(probe["locked"]),
                  chrome_running=bool(probe["chrome_running"]),
                  console_user=probe["console_user"], state="ok")
    ev.update(machine=machine, ts=ts, poller_version=VERSION)
    return {k: ev[k] for k in FIELDS}


def collect(host, runner, now=None):
    """runner(target, script) -> stdout. Any failure becomes state=unreachable."""
    ts = iso_now(now)
    try:
        probe = parse_probe(runner(host["ssh"], PROBE_SCRIPT))
    except Exception:  # ProbeError, OSError, anything: never crash the tick
        return make_event(host["machine"], ts, None)
    return make_event(host["machine"], ts, probe)
