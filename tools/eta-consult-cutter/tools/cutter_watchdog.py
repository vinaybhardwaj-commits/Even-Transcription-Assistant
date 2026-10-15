#!/usr/bin/env python3
"""m3-23 watchdog (stdlib only). `--check` (the unit) | `--status` (read-only, one JSON line). Any other argument prints usage and exits 2.
  lock_held_long    : cutter.lock held by ONE holder for more than LOCK_MAX_S (holder file cutter.lock.holder, written by cutter.run.acquire_run_lock)
  lock_held_unknown : cutter.lock is held (per /proc/locks) but there is no live holder file, for more than LOCK_MAX_S since first seen
  recut_storm       : a consult RE-cut more than STORM_MAX times in the IST day. Cuts = distinct cut_at among index rows with a path (mirror / error rows repeat cut_at and are not cuts); re-cuts = cuts today, minus 1 when the first cut ever is today.
On a NEW condition: touch recut.stop (the re-cut worker idles) and append one row to ALERTS.jsonl. A condition already stopped for is never re-stopped: an operator rm of recut.stop sticks until a new incident. One alert per condition per hour. Storm alerts are ONE row per check (count + up to 5 uids).
No bus client: consult-lead's sweep reads ALERTS.jsonl and --status."""
import json, os, sys, time
E = os.path.expanduser("~/eta-data"); D = f"{E}/consult"
LOCK = f"{D}/cutter.lock"; LOCK_HOLDER = f"{D}/cutter.lock.holder"; PROGRESS = f"{D}/recut-progress.jsonl"; INDEX = f"{D}/clips/index.jsonl"; STOP = f"{D}/recut.stop"; ALERTS = f"{D}/ALERTS.jsonl"; STATE = f"{D}/watchdog-state.json"
LOCK_MAX_S = 3000; STORM_MAX = 3; DEDUPE_S = 3600; ROW_UIDS = 5

def _read(path):
    try: return open(path, "rb").read().decode("utf-8", "replace")
    except OSError: return ""

def proc_start_ticks(pid):
    try: s = open(f"/proc/{pid}/stat").read()
    except OSError: return None
    try: return int(s.rsplit(")", 1)[1].split()[19])
    except (IndexError, ValueError): return None

def lock_holder(path=None, alive=None):
    """-> dict(pid, mode, start) of the live holder, or None (no file, unreadable, process dead, pid reused)."""
    try: h = json.loads(_read(path or LOCK_HOLDER))
    except ValueError: return None
    if not isinstance(h, dict) or not isinstance(h.get("pid"), int) or not isinstance(h.get("start"), (int, float)): return None
    if alive is not None: return h if alive(h) else None
    t = proc_start_ticks(h["pid"])
    if t is None or (h.get("ticks") is not None and t != h["ticks"]): return None
    return h

def lock_age(now, path=None, alive=None):
    h = lock_holder(path, alive); return (h, now - h["start"]) if h else (None, None)

def lock_is_held(lock_path=None, locks_text=None):
    """True when /proc/locks shows a FLOCK on the inode of the lock file (reads only, never takes the lock)."""
    try: ino = os.stat(lock_path or LOCK).st_ino
    except OSError: return False
    for l in (locks_text if locks_text is not None else _read("/proc/locks")).splitlines():
        f = l.split()
        if len(f) >= 6 and f[1] == "FLOCK" and f[5].rsplit(":", 1)[-1] == str(ino): return True
    return False

def _day(ts): return time.strftime("%Y-%m-%d", time.localtime(ts))

def storm(now, index=None):
    """-> {uid: re-cuts today} for uids over STORM_MAX."""
    today = _day(now); cuts = {}
    for l in _read(index or INDEX).splitlines():
        if '"cut_at"' not in l: continue
        try: r = json.loads(l)
        except ValueError: continue
        if isinstance(r, dict) and r.get("path") and isinstance(r.get("consult_uid"), str) and isinstance(r.get("cut_at"), str): cuts.setdefault(r["consult_uid"], set()).add(r["cut_at"])
    out = {}
    for u, s in cuts.items():
        n = sum(1 for c in s if c[:10] == today)
        if n and min(c[:10] for c in s) == today: n -= 1
        if n > STORM_MAX: out[u] = n
    return out

def _state(p):
    try: s = json.loads(_read(p)); return s if isinstance(s, dict) else {}
    except ValueError: return {}

def _save(p, s):
    tmp = f"{p}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w") as fh: json.dump(s, fh)
        os.replace(tmp, p)
    except OSError: pass

def append_alert(text, path=None):
    p = path or ALERTS; os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True); fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as fh: fh.write(json.dumps(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), source="watchdog", alert=text)) + "\n")

def conditions(now, st, holder_path=None, alive=None, index=None, lock_path=None, locks_text=None):
    """-> (list of (alert_key, [incident keys], text), st updated in place with the unknown-holder clock)."""
    out = []; h, age = lock_age(now, holder_path, alive)
    if h and age > LOCK_MAX_S: out.append(("lock_held_long", [f"lock_held_long:{h['pid']}:{int(h['start'])}"], f"ALERT watchdog lock_held_long: cutter.lock held {int(age)} s by pid {h['pid']} ({h.get('mode', '?')}); limit {LOCK_MAX_S} s."))
    if not h and lock_is_held(lock_path, locks_text):
        since = st.setdefault("unknown_since", now)
        if now - since > LOCK_MAX_S: out.append(("lock_held_unknown", [f"lock_held_unknown:{int(since)}"], f"ALERT watchdog lock_held_unknown: cutter.lock held {int(now - since)} s with no holder file; limit {LOCK_MAX_S} s."))
    else: st.pop("unknown_since", None)
    s = storm(now, index)
    if s:
        top = sorted(s, key=lambda u: (-s[u], u))[:ROW_UIDS]; day = _day(now)
        out.append(("recut_storm", [f"recut_storm:{day}:{u}" for u in sorted(s)], f"ALERT watchdog recut_storm: {len(s)} consults re-cut more than {STORM_MAX} times today: " + ", ".join(f"{u} ({s[u]})" for u in top) + (f" and {len(s) - len(top)} more" if len(s) > len(top) else "") + "."))
    return out

def check(now=None, holder_path=None, alive=None, index=None, stop=None, alerts=None, state=None, lock_path=None, locks_text=None, **_ignored):
    """-> alert keys written this call. recut.stop is touched only for an incident key not yet stopped for."""
    now = time.time() if now is None else now; stp = stop or STOP; sp = state or STATE; st = _state(sp); st0 = json.dumps(st, sort_keys=True)
    stopped = st.setdefault("stopped", {}); sent = st.setdefault("sent", {}); fired = []
    for akey, ikeys, text in conditions(now, st, holder_path, alive, index, lock_path, locks_text):
        new = [k for k in ikeys if k not in stopped]
        if new:
            try:
                with open(stp, "a"): os.utime(stp, None)
            except OSError: pass
            for k in new: stopped[k] = now
        if new or now - sent.get(akey, 0) >= DEDUPE_S:
            append_alert(text + (" Re-cut worker stopped (recut.stop)." if new else " Still true; recut.stop is not touched again (operator rm sticks)."), alerts); sent[akey] = now; fired.append(akey)
    for k in [k for k, v in stopped.items() if now - v > 3 * 86400]: del stopped[k]
    for k in [k for k, v in sent.items() if now - v > 2 * DEDUPE_S]: del sent[k]
    if json.dumps(st, sort_keys=True) != st0: _save(sp, st)
    return fired

def status(now=None, holder_path=None, alive=None, index=None, stop=None, state=None, lock_path=None, locks_text=None, **_ignored):
    """read-only: no write of any file."""
    now = time.time() if now is None else now; st = _state(state or STATE); h, age = lock_age(now, holder_path, alive)
    act = [a for a, _, _ in conditions(now, dict(st), holder_path, alive, index, lock_path, locks_text)]
    return dict(active=act, stop_file=os.path.exists(stop or STOP), holder=(dict(pid=h["pid"], mode=h.get("mode"), age_s=int(age)) if h else None), alerted_last_hour=sorted(k for k, v in (st.get("sent") or {}).items() if isinstance(v, (int, float)) and now - v < DEDUPE_S))

USAGE = "usage: cutter_watchdog.py --check | --status\n  --check   evaluate the conditions, write ALERTS.jsonl / state / recut.stop (the unit)\n  --status  read-only, one JSON line"

if __name__ == "__main__":
    a = sys.argv[1:]
    if a == ["--status"]: print(json.dumps(status())); sys.exit(0)
    if a != ["--check"]: print(USAGE, file=sys.stderr); sys.exit(2)
    try: print(json.dumps(dict(fired=check())))
    except Exception as e: print(json.dumps(dict(error=str(e)[:200]))); sys.exit(1)
