#!/usr/bin/env python3
"""restart-box-pane.py NAME  -- restart ONE idle/done box pane onto the current ssh config (ruling 152), keeping its session.
Same guards as herdr-ctl restart (which cannot run on the box: herdr's box agent records carry no session id): refuse if working,
refuse if a background command runs under the pane, refuse if the input box holds a draft, and if /exit opens a dialog send Esc and STOP."""
import json, os, re, subprocess, sys, time
NAME = sys.argv[1]
REG = os.environ["REG"]          # path to a herdr-registry.json copy (a private worktree; nothing here writes the registry)
# Needs kit/box-pane-info.py copied to the box as /tmp/box_pane_info.py (scp). Run from the Mini. One pane per run; check the printed RESULT line.
def sh(cmd, timeout=90):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
def herdr(*a, timeout=90): return sh(["herdr", "--machine", "eta-lab-t4", *a], timeout)
def box(code, timeout=60): return sh(["ssh", "-o", "ConnectTimeout=10", "e2e-lab-ts", code], timeout).stdout.strip()
def sys_count():
    out = sh(["ps", "-axo", "pid,ppid,command"]).stdout
    return sum(1 for l in out.splitlines() if re.search(r"sshd-session: vinaybhardwaj \[priv\]", l) and l.split()[1] == "1")
def die(msg): print("ABORT %s: %s" % (NAME, msg)); sys.exit(1)

reg = json.load(open(REG))["machine:eta-lab-t4"]; reg = reg.get("agents", reg)
a = reg.get(NAME) or die("not in registry")
pane, sid, model, perm, label = a["pane_id"], a["session_id"], a["model"], a["permission_mode"], a["label"]
info = lambda: box("python3 /tmp/box_pane_info.py " + pane)
st = json.loads(herdr("agent", "get", NAME).stdout)["result"]["agent"]["agent_status"]
if st not in ("idle", "done"): die("status is %s, not idle/done" % st)
pre = info(); print("before:", pre[:120])
if "pid=none" in pre: die("no claude pid found for the pane")
m = re.search(r"bash_children=(\d+)", pre)
if not m or int(m.group(1)) != 0: die("background commands run under the pane: " + pre)
oldpid = int(re.search(r"pid=(\d+)", pre).group(1))
screen = herdr("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "12").stdout
for l in screen.splitlines():
    if l.startswith("❯") and l[1:].strip(): die("the input box holds a draft: " + l[:60])
n_before = sys_count(); print("system sshd instances before: %d" % n_before)

herdr("agent", "prompt", NAME, "/exit")
gone = False
for i in range(20):
    time.sleep(3)
    if not box("ps -p %d -o pid= 2>/dev/null" % oldpid).strip(): gone = True; break
    scr = herdr("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "14").stdout
    if re.search(r"Esc to cancel|Are you sure|background|Enter to confirm", scr) and i >= 1:
        herdr("agent", "send-keys", NAME, "esc"); die("/exit opened a dialog; sent Esc and stopped (nothing confirmed)")
if not gone: die("old pid %d still alive after 60 s" % oldpid)
args = ["agent", "start", NAME, "--kind", "claude", "--pane", pane, "--timeout", "90000", "--", "--resume", sid, "-n", label, "--model", model]
args += ["--dangerously-skip-permissions"] if perm == "bypass" else ["--permission-mode", perm]
r = herdr(*args, timeout=150); race = "no longer owns" in (r.stdout + r.stderr) or "timeout" in (r.stdout + r.stderr)
time.sleep(4)
lst = json.loads(herdr("agent", "list").stdout)["result"]["agents"]
mine = [x for x in lst if x["pane_id"] == pane]
if mine and not mine[0].get("name"):
    herdr("agent", "rename", pane, NAME); time.sleep(2); print("renamed nameless agent (registration race)")
time.sleep(6)
post = info(); n_after = sys_count()
ok = ("native=yes" in post and "lab=2" in post and "legacy=0" in post and ("--resume " + sid) in post)
print("after:", post[:170]); print("system sshd instances after: %d (was %d)" % (n_after, n_before))
st2 = json.loads(herdr("agent", "get", NAME).stdout)["result"]["agent"]
print("agent: name=%s status=%s" % (st2.get("name"), st2["agent_status"]))
print("RESULT %s %s oldpid=%d sys %d->%d" % (NAME, "OK" if ok else "CHECK", oldpid, n_before, n_after))
sys.exit(0 if ok else 2)
