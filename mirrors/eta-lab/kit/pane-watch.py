#!/usr/bin/env python3
"""pane-watch.py — python3 stdlib only.

Polls `herdr agent list` on the Mini's default session and on the
eta-lab-t4 machine every 10s. The moment any agent transitions
working -> done/idle:
  1. captures its last ~80 lines to bus/done/<agent>/<UTC-ts>.md
  2. appends a summary line to bus/for-fable.jsonl (ts, agent, state,
     shas found, verdict word, whether "WAITING ON" appears, a short
     excerpt) — never more transcript text than the pane itself printed
  3. if Fable has a lowest-numbered file queued at
     orders/queue/<machine-or-default>:<agent>/NNN-*.md, sends
     "Fable (queued): <first line> — full order: <path>" via
     `herdr agent prompt` and moves the file to .../sent/ — checked every
     poll for every agent currently idle/done (not just on a transition),
     never to an agent that is working or blocked, and never to minibot.

Single-instance: holds an flock on bus/pane-watch.lock for its whole
lifetime; a second instance logs and exits immediately rather than
double-polling and double-sending queued orders.
A transition into `blocked` is logged to for-fable.jsonl (state=blocked)
and NOTHING is sent — never answers a blocked dialog.

Survives herdr server restarts: every `herdr` call is wrapped, a failure
just logs and retries next poll — it never crashes the loop.

Usage: pane-watch.py [--dry-run] [--once]
  --dry-run  log what WOULD be captured/sent; write nothing to done/,
             for-fable.jsonl, pane-state.json, or the queue.
  --once     run a single poll cycle and exit (for testing).
"""
import fcntl
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import datetime

LAB = os.path.expanduser("~/dev/eta-lab")
BUS = os.path.join(LAB, "bus")
ORDERS = os.path.join(LAB, "orders")
QUEUE_DIR = os.path.join(ORDERS, "queue")
STATE_FILE = os.path.join(BUS, "pane-state.json")
FOR_FABLE = os.path.join(BUS, "for-fable.jsonl")
DONE_DIR = os.path.join(BUS, "done")
LOG_FILE = os.path.join(BUS, "pane-watch.log")
LOCK_FILE = os.path.join(BUS, "pane-watch.lock")
BUS_DB = os.path.join(BUS, "bus.db")
BUS_MIRROR_BODY_MAX = 800  # keep the herdr prompt short; the real message stays in bus_thread

# None = the Mini's local default session. Add more machine labels here if
# more get attached later (see herdr-ctl.sh's own --machine convention).
MACHINES = [None, "eta-lab-t4"]
POLL_SECONDS = 10
READ_LINES = 80
NEVER_SEND = {"minibot"}
SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b")
VERDICT_RE = re.compile(r"\bPASS-WITH-FIXES\b|\bPASS\b|\bFAIL\b")
QUEUE_FILE_RE = re.compile(r"^\d+-.*\.md$")


def log(msg):
    # Every line used to appear twice: this wrote the line to LOG_FILE
    # itself AND printed it to stdout, which launchd's own
    # StandardOutPath ALSO redirects into the exact same file — so every
    # line landed there via two independent paths. print() only now;
    # launchd is the sole writer when running as the service. A manual
    # `python3 pane-watch.py --once` still shows output on the terminal;
    # redirect it yourself (`>> bus/pane-watch.log`) if you want it filed
    # the same way outside launchd.
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} {msg}", flush=True)


_lock_fd = None


def acquire_singleton_lock():
    # Two instances polling at once double-send queued orders and (before
    # the log() fix) double-write every line — flock is held for the life
    # of this process and released automatically by the OS on exit or
    # crash, so a dead instance never wedges the next launchd restart.
    global _lock_fd
    os.makedirs(BUS, exist_ok=True)
    _lock_fd = open(LOCK_FILE, "a+")
    try:
        fcntl.flock(_lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log(f"another pane-watch.py instance already holds {LOCK_FILE} — exiting")
        sys.exit(1)
    _lock_fd.seek(0)
    _lock_fd.truncate()
    _lock_fd.write(str(os.getpid()))
    _lock_fd.flush()


def hcli(machine, args):
    cmd = ["herdr"]
    if machine:
        cmd += ["--machine", machine]
    cmd += args
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return out.returncode, out.stdout, out.stderr
    except Exception as e:
        return 1, "", str(e)


def agent_list(machine):
    rc, out, err = hcli(machine, ["agent", "list"])
    if rc != 0:
        raise RuntimeError(err.strip() or f"exit {rc}")
    try:
        d = json.loads(out)
    except Exception as e:
        raise RuntimeError(f"bad JSON from agent list: {e}")
    return d.get("result", {}).get("agents", [])


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            return json.load(open(STATE_FILE))
        except Exception:
            return {}
    return {}


def save_state(state, dry_run):
    if dry_run:
        return
    os.makedirs(BUS, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


def append_jsonl(path, obj, dry_run):
    if dry_run:
        log(f"[dry-run] would append to {os.path.basename(path)}: {json.dumps(obj)}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(obj) + "\n")


def capture_report(name, text, dry_run):
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rel = os.path.join("bus", "done", name, f"{ts}.md")
    if dry_run:
        log(f"[dry-run] would write {len(text)} bytes to {rel}")
        return rel
    d = os.path.join(DONE_DIR, name)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{ts}.md")
    with open(path, "w") as f:
        f.write(text)
    return os.path.relpath(path, LAB)


def extract_meta(text):
    shas = sorted(set(SHA_RE.findall(text)))[:5]
    verdicts = VERDICT_RE.findall(text)
    verdict = verdicts[-1] if verdicts else None
    waiting_on = "WAITING ON" in text
    excerpt = text.strip()[:200]
    return shas, verdict, waiting_on, excerpt


def next_queue_file(key):
    # Queue dirs are created by qpush.sh under the qualified "machine:name"
    # key (e.g. orders/queue/eta-lab-t4:lab-mover/), never the bare agent
    # name — looking up by bare name silently never matched anything.
    d = os.path.join(QUEUE_DIR, key)
    if not os.path.isdir(d):
        return None
    files = sorted(f for f in os.listdir(d) if QUEUE_FILE_RE.match(f))
    if not files:
        return None
    return os.path.join(d, files[0])


QUEUE_INLINE_MAX_BYTES = 4000  # above this, fall back to a path pointer (see below)


def send_queued(machine, name, path, dry_run):
    # Cross-machine bug found live 23 Sep (scribe, box): orders/queue/ is
    # untracked runtime state, never synced by git, so a box-side recipient
    # cannot read a path pointer into the Mini's own checkout (and vice
    # versa) -- it can only read what's IN the message. Embed the file's
    # full text when it's small enough (every queue file seen so far is a
    # few lines); only fall back to the old path-pointer form, which still
    # works for a same-machine recipient, if it's unexpectedly large.
    try:
        with open(path) as f:
            body = f.read()
        first_line = body.splitlines()[0].strip().lstrip("#").strip() if body.strip() else ""
    except Exception as e:
        log(f"could not read queued order {path}: {e}")
        return
    rel = os.path.relpath(path, LAB)
    if len(body.encode("utf-8", "replace")) <= QUEUE_INLINE_MAX_BYTES:
        msg = f"Fable (queued): {rel}\n\n{body.strip()}"
    else:
        msg = f"Fable (queued): {first_line} — full order: {rel} (too large to inline, {len(body)} bytes)"
    if dry_run:
        log(f"[dry-run] would prompt {name} (machine={machine}): {msg}")
        log(f"[dry-run] would move {rel} -> sent/")
        return
    rc, out, err = hcli(machine, ["agent", "prompt", name, msg])
    if rc != 0:
        log(f"FAILED to send queued order to {name}: {err.strip()}")
        return
    sent_dir = os.path.join(os.path.dirname(path), "sent")
    os.makedirs(sent_dir, exist_ok=True)
    shutil.move(path, os.path.join(sent_dir, os.path.basename(path)))
    log(f"sent queued order to {name}: {os.path.basename(path)} -> sent/")


def process_transition(machine, name, old_state, new_state, dry_run):
    key = f"{machine or 'default'}:{name}"
    if old_state == "working" and new_state in ("done", "idle"):
        rc, out, err = hcli(machine, ["agent", "read", name, "--source", "recent-unwrapped", "--lines", str(READ_LINES)])
        text = out if rc == 0 else f"[could not read pane: {err.strip()}]"
        report_path = capture_report(name, text, dry_run)
        shas, verdict, waiting_on, excerpt = extract_meta(text)
        append_jsonl(FOR_FABLE, {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "agent": key,
            "state": new_state,
            "sha": shas,
            "verdict": verdict,
            "waiting_on": waiting_on,
            "excerpt": excerpt,
            "report": report_path,
        }, dry_run)
        log(f"{key}: working -> {new_state}, report captured ({report_path})")
    elif new_state == "blocked" and old_state != "blocked":
        append_jsonl(FOR_FABLE, {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "agent": key,
            "state": "blocked",
        }, dry_run)
        log(f"{key}: -> blocked, flagged for Fable (not answering)")


def maybe_send_queued(machine, name, status, dry_run):
    # Runs every poll for every agent currently idle/done, transition or
    # not — an agent that was ALREADY idle/done when an order got queued
    # for it (e.g. via qpush.sh) would otherwise never receive it, since
    # process_transition only fires on a working -> idle/done edge.
    # Idempotent: send_queued moves the file to sent/, so a repeat call
    # with nothing left in the queue is a no-op.
    if status not in ("done", "idle"):
        return
    if name in NEVER_SEND:
        return
    key = f"{machine or 'default'}:{name}"
    qf = next_queue_file(key)
    if qf:
        send_queued(machine, name, qf, dry_run)


def fetch_new_bus_messages(recipient, since_id):
    # Fable order 001-herdr-kit-3 item 2: bus_inbox can return [] while
    # unread rows genuinely exist (root cause: a long-lived eta-bus-mcp
    # connection can end up with its bus.db-wal/-shm fds pointing at an
    # orphaned inode after an external file replacement, and silently stop
    # seeing new commits -- fixed in eta-bus-mcp/lib/db.mjs, but every
    # already-running eta-bus-mcp process needs a restart to pick that fix
    # up). Until every session has restarted, read the same file directly,
    # read-only, from THIS short-lived process -- a fresh connection every
    # poll can never go stale the way a long-lived one did.
    uri = f"file:{BUS_DB}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        cur = conn.execute(
            """SELECT m.id, m.ts, m.sender, m.subject, m.body
               FROM receipts r JOIN messages m ON m.id = r.message_id
               WHERE r.recipient = ? AND m.id > ?
               ORDER BY m.id ASC LIMIT 20""",
            (recipient.lower(), since_id),
        )
        return cur.fetchall()
    finally:
        conn.close()


def maybe_mirror_bus(machine, name, status, dry_run, state):
    # Same idle/done-only, never-minibot restriction as maybe_send_queued:
    # never interrupts a working/blocked agent, never prompts a placeholder
    # pane. This is a stopgap only -- it does not mark anything read or
    # acked; bus_inbox/bus_ack (once every process has restarted onto the
    # fixed db.mjs) remain the real read path.
    if status not in ("done", "idle"):
        return
    if name in NEVER_SEND:
        return
    key = f"{machine or 'default'}:{name}"
    watermark = state.get(key, {}).get("bus_mirror_last_id", 0)
    try:
        rows = fetch_new_bus_messages(name, watermark)
    except Exception as e:
        log(f"bus mirror error for {key}: {e}")
        return
    if not rows:
        return
    max_id = watermark
    for msg_id, ts, sender, subject, body in rows:
        max_id = max(max_id, msg_id)
        short_body = body if len(body) <= BUS_MIRROR_BODY_MAX else body[:BUS_MIRROR_BODY_MAX] + " …[truncated, see bus_thread]"
        msg = f"[bus mirror #{msg_id} from {sender}] {subject}\n\n{short_body}"
        if dry_run:
            log(f"[dry-run] would mirror bus #{msg_id} to {name} (machine={machine})")
            continue
        rc, out, err = hcli(machine, ["agent", "prompt", name, msg])
        if rc != 0:
            log(f"FAILED to mirror bus #{msg_id} to {name}: {err.strip()}")
            return  # stop here so the watermark doesn't skip past a failed send
    state.setdefault(key, {})["bus_mirror_last_id"] = max_id
    log(f"{key}: mirrored {len(rows)} bus message(s) up to #{max_id}")


def poll_once(state, dry_run):
    for machine in MACHINES:
        try:
            agents = agent_list(machine)
        except Exception as e:
            log(f"poll error (machine={machine or 'default'}): {e}")
            continue
        for a in agents:
            name = a.get("name")
            if not name:
                continue
            status = a.get("agent_status", "unknown")
            key = f"{machine or 'default'}:{name}"
            old = state.get(key, {}).get("state")
            # Skip the very first observation of any agent — that's just
            # establishing a baseline, not a real transition.
            if old is not None and old != status:
                process_transition(machine, name, old, status, dry_run)
            maybe_send_queued(machine, name, status, dry_run)
            maybe_mirror_bus(machine, name, status, dry_run, state)
            # Merge, not overwrite -- maybe_mirror_bus stores bus_mirror_last_id
            # on this same state[key] dict and it must survive this update.
            state.setdefault(key, {})
            state[key]["state"] = status
            state[key]["ts"] = time.time()
    save_state(state, dry_run)


def main():
    dry_run = "--dry-run" in sys.argv
    once = "--once" in sys.argv
    acquire_singleton_lock()
    os.makedirs(BUS, exist_ok=True)
    os.makedirs(DONE_DIR, exist_ok=True)
    state = load_state()
    log(f"pane-watch starting (dry_run={dry_run}, once={once})")
    while True:
        poll_once(state, dry_run)
        if once:
            break
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
