import os, re, subprocess, sys
pane = sys.argv[1]
def cmd(p):
    try: return open("/proc/%s/cmdline" % p).read().replace("\0", " ")
    except Exception: return ""
pid = None
for p in os.listdir("/proc"):
    if not p.isdigit(): continue
    c = cmd(p)
    if c.startswith("claude "):
        try: env = open("/proc/%s/environ" % p).read().split("\0")
        except Exception: continue
        if ("HERDR_PANE_ID=" + pane) in env: pid = int(p)
if not pid: print("pid=none"); sys.exit(0)
ss = subprocess.run(["ss", "-tnp"], capture_output=True, text=True).stdout
port_of = {}
for l in ss.splitlines():
    m = re.search(r"127\.0\.0\.1:(222[24])\s.*pid=(\d+)", l)
    if m: port_of[int(m.group(2))] = m.group(1)
ks = [int(x) for x in subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()]
ssh = [k for k in ks if cmd(k).startswith("ssh ")]
legacy = sum(1 for k in ssh if port_of.get(k) == "2222"); lab = sum(1 for k in ssh if port_of.get(k) == "2224")
bash = sum(1 for k in ks if cmd(k).startswith("/bin/bash -c source"))
exe = os.path.realpath("/proc/%d/exe" % pid)
print("pid=%d native=%s legacy=%d lab=%d bash_children=%d cmd=%s" % (pid, "yes" if "versions/2.1.281" in exe else "NO(" + exe[-30:] + ")", legacy, lab, bash, cmd(pid)[:150]))
