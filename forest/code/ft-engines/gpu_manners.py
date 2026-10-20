"""ft-engines GPU manners: kit/reb clip_lanes.GpuGate (~/gpu.lock + 2048 MiB free) per item, and stand aside entirely while the palimpsest hourly lane runs."""
import subprocess, sys, os, time, contextlib
NO_LOCK = os.environ.get('FTE_DEDICATED_GPU') == '1'   # set only on a dedicated box (the HF L40S): no shared lock, no palimpsest there
if not NO_LOCK:
    sys.path.insert(0, os.environ.get('FTE_KIT', '~/dev/eta-lab-run'))
    from kit.reb.clip_lanes import GpuGate
    _gate = GpuGate()


def palimpsest_active():
    return subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'palimpsest-hourly.service']).returncode == 0


@contextlib.contextmanager
def hold():
    if NO_LOCK:
        yield; return
    while palimpsest_active(): time.sleep(5)
    with _gate.hold():
        yield
    time.sleep(0.2)   # leave a gap for other lock pollers
