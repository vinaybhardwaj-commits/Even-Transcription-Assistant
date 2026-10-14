"""OS-level presence probe. Runs as `/bin/sh -s` on the Mac, fed over ssh stdin.

Read-only. Nothing about browsers beyond whether the Chrome process exists.
"""
import os
import re
import signal
import subprocess

# Pure /bin/sh. Sent on stdin, so no ssh quoting traps. Python (Quartz) is used for the
# lock flag only when /usr/bin/python3 is a real interpreter, not the xcode-select stub.
PROBE_SCRIPT = r"""
PATH=/usr/bin:/bin:/usr/sbin:/sbin
idle=$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}')
echo "idle_s=${idle:--1}"
lock=-1
src=none
if [ -x /usr/bin/python3 ] && xcode-select -p >/dev/null 2>&1; then
  v=$(/usr/bin/python3 -c 'import Quartz;d=Quartz.CGSessionCopyCurrentDictionary() or {};print(1 if d.get("CGSSessionScreenIsLocked") else 0)' 2>/dev/null)
  case "$v" in 0|1) lock=$v; src=py;; esac
fi
if [ "$lock" = "-1" ]; then
  if ioreg -n Root -d1 2>/dev/null | grep -q '"IOConsoleLocked" = Yes'; then lock=1; else lock=0; fi
  src=sh
fi
echo "locked=$lock"
echo "lock_src=$src"
if pgrep -x 'Google Chrome' >/dev/null 2>&1; then echo "chrome=1"; else echo "chrome=0"; fi
echo "user=$(stat -f%Su /dev/console 2>/dev/null)"
"""

_USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class ProbeError(Exception):
    pass


def parse_probe(text):
    """Parse probe stdout. Returns dict idle_s, locked, chrome_running, console_user, lock_src."""
    kv = {}
    for line in text.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            kv[k.strip()] = v.strip()
    try:
        idle = int(kv["idle_s"])
        chrome = int(kv["chrome"])
        locked = int(kv["locked"])
    except (KeyError, ValueError):
        raise ProbeError("unparseable probe output")
    if chrome not in (0, 1) or locked not in (-1, 0, 1):
        raise ProbeError("out-of-range probe value")
    user = kv.get("user", "")
    return {
        "idle_s": idle if idle >= 0 else None,
        "locked": locked,
        "chrome_running": chrome,
        "console_user": user if _USER_RE.match(user) else None,
        "lock_src": kv.get("lock_src", "none"),
    }


TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
METHOD = {}  # target -> "tailscale" | "ssh" | "none" (last tick, for logs only)


SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
            "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectionAttempts=1"]


def _run(cmd, script, timeout):
    """Hard wall-clock timeout; kills the whole process group so nothing keeps a pipe open."""
    try:
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    except OSError:
        raise ProbeError("spawn failed")
    try:
        out, _ = p.communicate(script, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            p.communicate(timeout=2)
        except Exception:
            pass
        raise ProbeError("timeout")
    if p.returncode != 0:
        raise ProbeError(f"exit {p.returncode}")
    return out


def _looks_like_probe(out):
    """A transport attempt only counts as success if it returned the probe output.
    Under launchd, `tailscale ssh` can exit 0 without delivering the command's
    stdout; without this check that empty output is accepted and the host is
    wrongly marked unreachable instead of falling through to plain ssh."""
    return isinstance(out, str) and "idle_s=" in out


def ssh_run(target, script, timeout=12):
    """Tailscale ssh first (no known_hosts), then plain ssh. Worst case ~2 x timeout."""
    try:
        out = _run([TAILSCALE, "ssh", target, "/bin/sh", "-s"], script, min(timeout, 8))
        if _looks_like_probe(out):
            METHOD[target] = "tailscale"
            return out
    except ProbeError:
        pass
    try:
        out = _run(["ssh"] + SSH_OPTS + [target, "/bin/sh", "-s"], script, timeout)
        if not _looks_like_probe(out):
            raise ProbeError("bad output")
        METHOD[target] = "ssh"
        return out
    except ProbeError:
        METHOD[target] = "none"
        raise ProbeError("unreachable")
