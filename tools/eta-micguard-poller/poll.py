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
import fcntl
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
TOTAL_BUDGET_S = 50     # whole run, post included
SSH_PHASE_S = 30        # ssh phase cap
POST_TIMEOUT_S = 15     # post cap (also limited by what is left of TOTAL_BUDGET_S)
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

# The rooms the board knows (lib/rooms-live/rooms.ts). A config room_id outside this list is skipped. MICGUARD_ROOMS (comma list) replaces it.
KNOWN_ROOMS = ("room_yh3etjpf", "room_87frpus9", "room_ux92qpws", "room_4ggnkg5x", "room_pnyc9u49", "room_qyzghzaf", "room_ymch4bxu", "room_bh6jtq4t")
_TARGET_RE = re.compile(r"^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$")
_MACHINE_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

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


def poll_all(entries, runner, now_epoch, budget_s=SSH_PHASE_S):
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


def ist_day(epoch):
    return datetime.fromtimestamp(epoch + 19800, timezone.utc).strftime("%Y-%m-%d")


def _iso_ms(v):
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def apply_carry(payload, carry, now_epoch):
    """Never report a lower same-IST-day restored_today than already seen; keep the matching last_restored_at.
    Mutates and returns payload. carry: {day, restored_today, last_restored_at} or None."""
    if carry and carry.get("day") == ist_day(now_epoch) and carry.get("restored_today", 0) > payload["restored_today"]:
        payload["restored_today"] = carry["restored_today"]
        payload["last_restored_at"] = carry.get("last_restored_at")
    return payload


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

def real_post(url, token, body_bytes, timeout=POST_TIMEOUT_S):
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


def load_config(path, known_rooms=KNOWN_ROOMS):
    """Returns (entries, skipped) where skipped is a dict of reason -> count. Values are never reported."""
    with open(os.path.expanduser(path)) as fh:
        raw = json.load(fh)
    out, skipped = [], {}

    def skip(reason):
        skipped[reason] = skipped.get(reason, 0) + 1

    for e in raw if isinstance(raw, list) else []:
        if not isinstance(e, dict) or not e.get("room_id") or not e.get("machine"):
            skip("incomplete")
            continue
        if str(e["room_id"]) not in known_rooms:
            skip("unknown_room")
            continue
        if not _MACHINE_RE.match(str(e["machine"])):
            skip("bad_machine")
            continue
        installed = e.get("installed") is not False
        target = str(e.get("ssh", ""))
        if installed and not _TARGET_RE.match(target):
            skip("bad_target")
            continue
        out.append({"room_id": str(e["room_id"]), "machine": str(e["machine"]), "ssh": target if installed else "", "installed": installed})
    return out, skipped


# ---------------------------------------------------------------- main

def run_once(env=None, runner=real_runner, poster=real_post, now_epoch=None):
    env = os.environ if env is None else env
    t0 = time.time()
    now_epoch = int(t0) if now_epoch is None else now_epoch
    token = read_token(env.get("MICGUARD_TOKEN_FILE", DEFAULT_CRED_PATH))
    if token is None:
        log("token file missing or empty; nothing posted")
        return 0
    state_path = os.path.expanduser(env.get("MICGUARD_STATE", DEFAULT_STATE))
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    lock_fh = open(state_path + ".lock", "w")
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another run holds the lock; exiting")
        lock_fh.close()
        return 0
    try:
        return _run_locked(env, runner, poster, now_epoch, t0, token, state_path)
    finally:
        lock_fh.close()  # releases the flock


def _run_locked(env, runner, poster, now_epoch, t0, token, state_path):
    cfg = os.path.expanduser(env.get("MICGUARD_KIOSKS", DEFAULT_CONFIG))
    rooms = tuple(r for r in env.get("MICGUARD_ROOMS", "").split(",") if r) or KNOWN_ROOMS
    try:
        entries, skipped = load_config(cfg, rooms)
    except (OSError, ValueError):
        log("kiosk config unreadable; nothing posted")
        return 0
    if skipped:
        log("skipped config entries %s" % json.dumps(skipped, sort_keys=True))
    if not entries:
        log("kiosk config empty; nothing posted")
        return 0
    st = load_state(state_path, now_epoch)
    st.setdefault("carry", {})
    results = poll_all(entries, runner, now_epoch)
    day = ist_day(now_epoch)
    for rid, p in results.items():
        apply_carry(p, st["carry"].get(rid), now_epoch)
        st["carry"][rid] = {"day": day, "restored_today": p["restored_today"], "last_restored_at": p["last_restored_at"]}
    events, marks = build_events(entries, results, st, now_epoch)
    save_state(state_path, st)  # seq advanced before the post: never reused
    counts = {}
    for p in results.values():
        counts[p["state"]] = counts.get(p["state"], 0) + 1
    if not events:
        log("polled %d rooms %s; no change to post" % (len(entries), json.dumps(counts, sort_keys=True)))
        return 0
    left = TOTAL_BUDGET_S - (time.time() - t0)
    if left < 1:
        log("no time left to post; will retry next poll")
        return 0
    body = json.dumps({"events": events}).encode("utf-8")
    status = poster(env.get("MICGUARD_INGEST_URL", DEFAULT_URL), token, body, min(POST_TIMEOUT_S, left))
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
