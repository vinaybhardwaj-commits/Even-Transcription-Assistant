"""Hourly job: rescan the manifest, rerun the classifier, write today and yesterday (IST) to Neon.

Exactly one counts-only line goes to hourly.log per run, including runs that fail before the write loop."""
import os, signal, sys, time

LOG = os.path.expanduser("~/eta-data/consult/audio-state/logs/hourly.log")


def log_line(rc, summary, t0):
    os.makedirs(os.path.dirname(LOG), mode=0o700, exist_ok=True)
    s = summary or {}
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} rc={rc} room_days={s.get('room_days')} "
                f"committed={s.get('committed_room_days')} rolled_back={s.get('rolled_back')} "
                f"intervals={s.get('intervals')} secs={time.time() - t0:.0f}\n")


def _term(signum, frame):
    sys.exit(128 + signum)     # SIGTERM (e.g. systemd's TimeoutStartSec) raises SystemExit so the finally logs the run


def main():
    t0 = time.time()
    signal.signal(signal.SIGTERM, _term)
    rc, summary = "EXC", None
    try:
        from . import scan
        scan.main()                      # new manifest rows only; blind room-days are never opened
        import ras_write
        ras_write.main.last = None
        rc = ras_write.main(["--days-back", "1"])
        summary = getattr(ras_write.main, "last", None)
        return rc
    except BaseException as e:           # a crash before the write loop still leaves its line
        rc = f"EXC {type(e).__name__}"
        raise
    finally:
        log_line(rc, summary, t0)


if __name__ == "__main__":
    sys.exit(main())
