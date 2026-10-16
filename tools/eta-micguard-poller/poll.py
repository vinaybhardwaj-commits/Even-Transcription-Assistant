#!/usr/bin/env python3
"""eta-micguard-poller: reads each room Mac's mic-guard heartbeat over ssh (read-only) and posts one
kiosk-health event per room (kind "mic_guard") to /api/kiosk-health. Python 3 standard library only.

Run once per minute from launchd:  poll.py --once

Kiosks are not ours. The only thing sent to a kiosk is the fixed read-only command REMOTE_COMMAND:
it reads the guard's .last file, its mtime, and today's RESTORED lines of the guard log. No writes,
no sudo, no installs. Raw line text, the ssh target and the token are never logged or posted.
"""
import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SOURCE = "mini_micguard_poller"
KIND = "mic_guard"
INSTALL_ID = "mini-micguard-poller"
STALE_LINE_S = 300      # .last older than this = stale (line_old)
REFRESH_S = 300         # re-post an unchanged room at least this often
POLL_BUDGET_S = 50      # whole poll
SSH_CONNECT_S = 5
MAX_PARALLEL = 8
IST_OFFSET = "+05:30"   # the guard writes local (IST) wall-clock stamps

DEFAULT_CONFIG = "~/.config/eta-micguard/kiosks.json"
DEFAULT_STATE = "~/.local/state/eta-micguard/state.json"
DEFAULT_URL = "https://evenscribe.app/api/kiosk-health"
DEFAULT_CRED_PATH = "~/.claude/secrets/kiosk_health_ingest_token"

# Fixed, read-only. Prints: LAST <line> | NOFILE, MTIME <epoch>, NOW <epoch>, RESTORED <stamp>*.
REMOTE_COMMAND = (
    'L="$HOME/Library/Logs/eta-tcc-guard"; '
    'if [ -f "$L.last" ]; then echo "LAST $(head -n 1 "$L.last")"; echo "MTIME $(stat -f %m "$L.last")"; else echo NOFILE; fi; '
    'echo "NOW $(date +%s)"; D=$(date +%F); '
    'grep "^$D .* RESTORED " "$L.log" 2>/dev/null | tail -n 50 | sed "s/^\\([^ ]* [^ ]*\\) .*/RESTORED \\1/"'
)

STATES = ("ok", "restored", "read_error", "missing", "write_failed", "db_missing", "stale", "not_installed")

_LINE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (ok 2|restored \d+->2|read_error|missing|write_failed|db_missing)$")
_STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


def log(msg):
    print("%s micguard %s" % (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), msg), flush=True)


def iso_utc(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp_to_iso(stamp):
    """'YYYY-MM-DD HH:MM:SS' (kiosk local, IST) -> ISO with offset, or None."""
    if not _STAMP_RE.match(stamp):
        return None
    return stamp.replace(" ", "T") + IST_OFFSET


# ---------------------------------------------------------------- parsing and classification

def parse_remote(text):
    """Remote output -> dict(line, mtime, now, restored[list of stamps], nofile). Never keeps unknown text."""
    out = {"line": None, "mtime": None, "now": None, "restored": [], "nofile": False}
    for raw in (text or "").splitlines():
        if raw == "NOFILE":
            out["nofile"] = True
        elif raw.startswith("LAST "):
            out["line"] = raw[5:].strip()
        elif raw.startswith("MTIME "):
            v = raw[6:].strip()
            out["mtime"] = int(v) if v.isdigit() else None
        elif raw.startswith("NOW "):
            v = raw[4:].strip()
            out["now"] = int(v) if v.isdigit() else None
        elif raw.startswith("RESTORED "):
            s = raw[9:].strip()
            if _STAMP_RE.match(s):
                out["restored"].append(s)
    return out


def classify(parsed, now_epoch):
    """Parsed remote -> payload dict {state, reason, last_line_at, age_s, restored_today, last_restored_at}."""
    restored = sorted(parsed["restored"])
    base = {
        "restored_today": len(restored),
        "last_restored_at": stamp_to_iso(restored[-1]) if restored else None,
        "last_line_at": None,
        "age_s": None,
    }

    def mk(state, reason=None):
        d = dict(base)
        d["state"] = state
        d["reason"] = reason
        return d

    if parsed["nofile"] or (parsed["line"] is None):
        return mk("not_installed")
    m = _LINE_RE.match(parsed["line"])
    mtime = parsed["mtime"]
    if mtime is not None:
        remote_now = parsed["now"] if parsed["now"] is not None else now_epoch
        base["last_line_at"] = iso_utc(mtime)
        base["age_s"] = max(0, remote_now - mtime)
    if not m or mtime is None:
        return mk("read_error", "unparsed")
    if base["age_s"] > STALE_LINE_S:
        return mk("stale", "line_old")
    word = m.group(2)
    if word == "ok 2":
        return mk("ok")
    if word.startswith("restored"):
        return mk("restored")
    return mk(word)


def unreachable_payload():
    return {"state": "stale", "reason": "ssh_unreachable", "last_line_at": None, "age_s": None,
            "restored_today": 0, "last_restored_at": None}


def not_configured_payload():
    return {"state": "not_installed", "reason": None, "last_line_at": None, "age_s": None,
            "restored_today": 0, "last_restored_at": None}


# ---------------------------------------------------------------- ssh

def real_runner(target, command, timeout):
    """Runs one ssh call. Returns stdout text, or None on any failure. The target is never logged."""
    argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=%d" % SSH_CONNECT_S, target, command]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout


def poll_room(entry, runner, now_epoch, deadline):
    if entry.get("installed") is False:
        return not_configured_payload()
    left = deadline - time.time()
    if left <= 1:
        return unreachable_payload()
    try:
        text = runner(entry.get("ssh", ""), REMOTE_COMMAND, min(left, SSH_CONNECT_S + 10))
    except Exception:
        text = None
    if text is None:
        return unreachable_payload()
    return classify(parse_remote(text), now_epoch)


def poll_all(entries, runner, now_epoch, budget_s=POLL_BUDGET_S):
    deadline = time.time() + budget_s
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PARALLEL) as ex:
        futs = {ex.submit(poll_room, e, runner, now_epoch, deadline): e for e in entries}
        for f, e in futs.items():
            try:
                results[e["room_id"]] = f.result(timeout=max(1, deadline - time.time() + 2))
            except Exception:
                results[e["room_id"]] = unreachable_payload()
    return results


# ---------------------------------------------------------------- state and post rule

def load_state(path, now_epoch):
    try:
        with open(path) as fh:
            st = json.load(fh)
        if isinstance(st, dict) and isinstance(st.get("boot_epoch"), int) and isinstance(st.get("seq"), int):
            st.setdefault("rooms", {})
            return st
    except (OSError, ValueError):
        pass
    return {"boot_epoch": now_epoch, "seq": 0, "rooms": {}}


def save_state(path, st):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(st, fh)
    os.replace(tmp, path)


def should_post(prev, payload, now_epoch):
    """prev: {state, reason, restored_today, posted_at} or None."""
    if not prev:
        return True
    if (prev.get("state"), prev.get("reason"), prev.get("restored_today")) != (payload["state"], payload["reason"], payload["restored_today"]):
        return True
    return now_epoch - int(prev.get("posted_at", 0)) >= REFRESH_S


def build_events(entries, results, st, now_epoch):
    """Returns (events, posted_marks). Advances st['seq'] for every event built."""
    events, marks = [], {}
    for e in entries:
        rid = e["room_id"]
        p = results[rid]
        if not should_post(st["rooms"].get(rid), p, now_epoch):
            continue
        st["seq"] += 1
        events.append({
            "machine": e["machine"], "room_id": rid, "install_id": INSTALL_ID,
            "boot_id": str(st["boot_epoch"]), "seq": st["seq"], "source": SOURCE, "kind": KIND,
            "ts": iso_utc(now_epoch), "payload": p,
        })
        marks[rid] = {"state": p["state"], "reason": p["reason"], "restored_today": p["restored_today"], "posted_at": now_epoch}
    return events, marks


# ---------------------------------------------------------------- http

def real_post(url, token, body_bytes, timeout=15):
    req = urllib.request.Request(url, data=body_bytes, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def read_token(path):
    try:
        with open(os.path.expanduser(path)) as fh:
            t = fh.read().strip()
        return t or None
    except OSError:
        return None


def load_config(path):
    with open(os.path.expanduser(path)) as fh:
        raw = json.load(fh)
    out = []
    for e in raw:
        if isinstance(e, dict) and e.get("room_id") and e.get("machine"):
            out.append({"room_id": str(e["room_id"]), "machine": str(e["machine"]),
                        "ssh": str(e.get("ssh", "")), "installed": e.get("installed") is not False})
    return out


# ---------------------------------------------------------------- main

def run_once(env=None, runner=real_runner, poster=real_post, now_epoch=None):
    env = os.environ if env is None else env
    now_epoch = int(time.time()) if now_epoch is None else now_epoch
    token = read_token(env.get("MICGUARD_TOKEN_FILE", DEFAULT_CRED_PATH))
    if token is None:
        log("token file missing or empty; nothing posted")
        return 0
    cfg = os.path.expanduser(env.get("MICGUARD_KIOSKS", DEFAULT_CONFIG))
    try:
        entries = load_config(cfg)
    except (OSError, ValueError):
        log("kiosk config unreadable; nothing posted")
        return 0
    if not entries:
        log("kiosk config empty; nothing posted")
        return 0
    state_path = os.path.expanduser(env.get("MICGUARD_STATE", DEFAULT_STATE))
    st = load_state(state_path, now_epoch)
    results = poll_all(entries, runner, now_epoch)
    events, marks = build_events(entries, results, st, now_epoch)
    save_state(state_path, st)  # seq advanced before the post: never reused
    counts = {}
    for p in results.values():
        counts[p["state"]] = counts.get(p["state"], 0) + 1
    if not events:
        log("polled %d rooms %s; no change to post" % (len(entries), json.dumps(counts, sort_keys=True)))
        return 0
    body = json.dumps({"events": events}).encode("utf-8")
    status = poster(env.get("MICGUARD_INGEST_URL", DEFAULT_URL), token, body)
    if 200 <= status < 300:
        st["rooms"].update(marks)
        save_state(state_path, st)
        log("posted %d events %s status %d" % (len(events), json.dumps(counts, sort_keys=True), status))
    else:
        log("post failed status %d; will retry next poll" % status)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Post kiosk mic-guard state to kiosk-health.")
    ap.add_argument("--once", action="store_true", help="poll once and exit (the launchd mode)")
    ap.parse_args(argv)
    return run_once()


if __name__ == "__main__":
    sys.exit(main())
