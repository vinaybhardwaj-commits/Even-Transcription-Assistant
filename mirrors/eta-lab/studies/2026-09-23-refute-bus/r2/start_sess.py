import os, pty, subprocess, time, sys
name = sys.argv[1]
env = dict(os.environ)
env["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin"
# herdr sets HERDR_* for panes it manages; a nested attach must not inherit them
for k in ("HERDR_PANE_ID", "HERDR_SESSION", "HERDR_ENV"):
    env.pop(k, None)
env["TERM"] = "xterm-256color"
m, s = pty.openpty()
os.set_blocking(m, False)
p = subprocess.Popen(["herdr", "session", "attach", name],
                     stdin=s, stdout=s, stderr=s, env=env,
                     start_new_session=True, close_fds=True)
os.close(s)
time.sleep(8)
print("attach pid:", p.pid, "alive:", p.poll() is None)
with open("/tmp/rf2/sess.pid", "w") as f:
    f.write(str(p.pid))
