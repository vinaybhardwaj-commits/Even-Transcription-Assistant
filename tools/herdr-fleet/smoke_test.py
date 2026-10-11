#!/usr/bin/env python3
"""Smoke test for fleetboard: pty run with resizes and stray keys, plus layout sizes."""
import fcntl, os, pty, select, signal, struct, sys, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def layout_test():
    import fleetboard as fb
    fb.load_state()
    fb.detect_unicode()
    b = fb.Board()
    b.cycle()
    snap = b.snapshot()
    roster, rerr = fb.load_roster()
    bad = 0
    for W, H in [(140, 38), (120, 34), (100, 60)]:
        for pg in (0, 1):
            lines = fb.build(snap, roster, rerr, W, H, page=pg)
            txt = "\n".join("".join(t for t, _ in sp) for sp, _ in lines)
            foot = txt.splitlines()[-1].strip()
            agent_rows = sum(1 for l in txt.splitlines() if any(x in l for x in (" WORKING ", " IDLE ", " DONE ", " BLOCKED ", " UNKNOWN ")))
            jl = next((l.strip() for l in txt.splitlines() if "windows done" in l), "NO JOB LINE")
            print("size %dx%d page%d lines=%d agent_rows=%d more_marker=%s | %s" % (W, H, pg, len(lines), agent_rows, "more agent" in txt, foot[:90]))
            L = txt.splitlines()
            i0 = next(i for i, l in enumerate(L) if "MACHINES" in l); i1 = next(i for i, l in enumerate(L) if "JOBS" in l or "AGENTS" in l)
            print("   machines_rows=%d machine_dots=%d" % (i1 - i0 - 1, sum(l.count("\u25cf ") for l in L[i0 + 1:i1])))
            print("   job: " + jl[:130])
    for W, H in [(150, 45), (140, 40), (140, 35), (110, 35), (100, 30), (80, 24), (60, 16), (50, 12), (30, 8), (24, 6), (20, 5), (200, 50)]:
        lines = fb.build(snap, roster, rerr, W, H)
        mx = max(sum(len(t) for t, _ in sp) for sp, _ in lines)
        ok = len(lines) <= H and mx <= W - 1 + (0 if W >= 24 and H >= 6 else 99)
        last = "".join(t for t, _ in lines[-2][0]).strip()[:60] if len(lines) > 1 else ""
        print("layout %3dx%-2d lines=%2d maxw=%3d %s | %s" % (W, H, len(lines), mx, "OK" if ok else "BAD", last))
        bad += 0 if ok else 1
    return bad


def pty_test(rows=40, cols=140, dur=44):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["LANG"] = "en_US.UTF-8"
        os.execv("/opt/homebrew/bin/python3", ["python3", os.path.join(HERE, "fleetboard.py")])
    def size(r, c):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    size(rows, cols)
    buf = b""
    t0 = time.time()
    if rows == 40 and cols == 140:
        steps = [(8, lambda: size(24, 80)), (14, lambda: size(12, 50)), (18, lambda: size(7, 30)),
                 (22, lambda: size(45, 150)), (26, lambda: os.write(fd, b"x")), (27, lambda: os.write(fd, b"\x1b[A")),
                 (28, lambda: os.write(fd, b" ")), (40, lambda: size(40, 140)), (44, lambda: os.write(fd, b"q"))]
    else:  # fixed size: run past two page turns (15 s each), stray key, quit
        steps = [(10, lambda: os.write(fd, b"x")), (dur - 1, lambda: os.write(fd, b"q"))]
    exited = None
    while time.time() - t0 < 60:
        while steps and time.time() - t0 >= steps[0][0]:
            steps.pop(0)[1]()
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                d = b""
            if not d:
                pass
            buf += d
        w, status = os.waitpid(pid, os.WNOHANG)
        if w:
            exited = status
            break
    if exited is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    txt = buf.decode("utf-8", "replace")
    print("pty: bytes=%d runtime=%.0fs exit_status=%s" % (len(buf), time.time() - t0, exited))
    print("pty: traceback=%s  has_title=%s  has_stt-bench=%s  has_resize_msg=%s  has_blocked=%s" % (
        "Traceback" in txt, "ETA FLEET" in txt, "stt-bench" in txt, "terminal too small" in txt, "BLOCKED" in txt))
    return ("Traceback" in txt) or exited != 0


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    rc = 0
    if which in ("layout", "both"):
        rc |= layout_test()
    if which in ("pty", "both"):
        rc |= 1 if pty_test() else 0
    if which == "fixed":
        for r, c in ((38, 140), (34, 120), (60, 100)):
            print("fixed size", r, c)
            rc |= 1 if pty_test(r, c, 36) else 0
    print("RESULT", "FAIL" if rc else "PASS")
