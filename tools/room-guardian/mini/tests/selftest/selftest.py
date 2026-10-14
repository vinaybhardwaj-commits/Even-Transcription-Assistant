#!/usr/bin/env python3
"""selftest.py -- Phase 0 self-test, Mini only. A fake room (pipe user `testroom`) publishes health every 10 s; the real subscriber and router
(launchd jobs) do the rest. Timeline (seconds from T0):
   0-240   publish            240-450  silent (quiet > 120 s opens ONE guardian_quiet case ~360)
   ~420    kickstart the SUBSCRIBER mid-case (case state must survive, no second case, no second page)
   450-1050 publish again (recovery closes the case on the first line). Total publishing 10 min.
   during the second publish: kill-switch proof via the control topic (on -> off -> on -> file moved aside -> restored).
Routing is TEST (herdr-lead only, subject prefix TEST) for the whole run; switch it afterwards. Writes logs/selftest-timeline.log (metadata only)."""
import json, os, sqlite3, subprocess, sys, threading, time
HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
PIPE = f"{HOME}/scripts/pipe-ssh.sh"
LOG = open(f"{HOME}/logs/selftest-timeline.log", "a")
T0 = time.time()
stop_pub = threading.Event(); pub_on = threading.Event()
seqs = []
ctl_seen = []


def log(msg):
    line = f"{time.strftime('%H:%M:%S')} T+{int(time.time() - T0):04d}s {msg}"
    print(line, flush=True); LOG.write(line + "\n"); LOG.flush()


def cases():
    db = sqlite3.connect(f"{HOME}/data/cases.sqlite", timeout=10)
    rows = db.execute("SELECT first_id, kind, room_id, page_count, suppressed_count, acked_by, closed_at, close_reason FROM room_alert_case WHERE room_id='testroom' ORDER BY first_id").fetchall()
    db.close()
    return [{"id": r[0], "kind": r[1], "pages": r[3], "dups": r[4], "acked_by": r[5], "closed": r[6] is not None, "close_reason": r[7]} for r in rows]


def publisher():
    n = 0
    while not stop_pub.is_set():
        if pub_on.is_set():
            n += 1
            msg = json.dumps({"room": "testroom", "seq": n, "ts": int(time.time()), "fake": True})
            r = subprocess.run([PIPE, f"{HOME}/keys/testroom", "pub", "-c", "-b=false", "kiosk/testroom/health"], input=msg + "\n", text=True, capture_output=True, timeout=20)
            seqs.append((n, r.returncode, int(time.time())))
        stop_pub.wait(10)


def control_watcher():
    p = subprocess.Popen([PIPE, f"{HOME}/keys/testroom", "sub", "-c", "-k", "guardian/control"], stdout=subprocess.PIPE, text=True)
    for line in p.stdout:
        try:
            ctl_seen.append((time.time(), json.loads(line).get("kill")))
        except ValueError:
            pass


def wait_until(t):
    while time.time() - T0 < t:
        time.sleep(2)


def kill_state_after(label, content, timeout=75):
    """Set the kill-switch file, wait for a control line that shows the expected state, return (ok, seconds)."""
    want = content not in ("off", "0", "false")
    t = time.time()
    if content is None:
        want = True
    while time.time() - t < timeout:
        if ctl_seen and ctl_seen[-1][0] > t and ctl_seen[-1][1] is want:
            log(f"kill-switch {label}: control line shows kill={want} after {int(time.time() - t)} s")
            return True
        time.sleep(1)
    log(f"kill-switch {label}: NOT seen within {timeout} s (last={ctl_seen[-1] if ctl_seen else None})")
    return False


def main():
    log(f"start; cases before: {cases()}")
    threading.Thread(target=publisher, daemon=True).start()
    threading.Thread(target=control_watcher, daemon=True).start()
    pub_on.set(); log("publish ON (phase 1)")
    wait_until(240); pub_on.clear(); log("publish OFF (silence begins)")
    wait_until(380); log(f"cases at +380: {cases()}")
    wait_until(420)
    log(f"kickstart subscriber mid-case; cases before: {cases()}")
    subprocess.run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.eta.guardian.subscriber"], check=False)
    wait_until(450); log(f"cases after restart (+30 s): {cases()}")
    pub_on.set(); log("publish ON (phase 2, resume)")
    wait_until(500); log(f"cases at +500: {cases()}")
    ks = f"{HOME}/etc/kill-switch"
    res = {}
    os.rename(ks, ks + ".keep"); res["fail_safe_missing_file"] = kill_state_after("file missing (fail-safe)", None)
    os.rename(ks + ".keep", ks)
    with open(ks, "w") as f: f.write("off\n")
    res["off"] = kill_state_after("off (actions allowed)", "off")
    with open(ks, "w") as f: f.write("on\n")
    res["on"] = kill_state_after("on (killed)", "on")
    log(f"kill-switch results {res}")
    wait_until(1050); pub_on.clear(); stop_pub.set()
    ok = [s for s in seqs if s[1] == 0]
    log(f"published {len(seqs)} lines, ssh rc==0 for {len(ok)}")
    with open(f"{HOME}/data/{time.strftime('%Y-%m-%d')}/testroom.health.jsonl") as f:
        got = [json.loads(l).get("seq") for l in f if '"fake"' in l]
    log(f"subscriber stored {len(got)} fake health lines; missing seqs {sorted(set(s[0] for s in seqs) - set(got))[:20]}")
    log(f"final cases: {cases()}")
    log("DONE")


if __name__ == "__main__":
    sys.exit(main())
