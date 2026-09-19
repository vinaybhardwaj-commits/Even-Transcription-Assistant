#!/usr/bin/env python3
"""Running-code vs on-disk-code drift for ETA services on the Mini.
Measures SOURCE files only. Runtime artifacts (jobs/, logs, results, *.json)
are excluded on purpose: a job file is not code, and counting it manufactures
a fake drift number. Counts, paths and times only."""
import subprocess, os, plistlib, datetime, io

SERVICES = [
    "uk.llmvinayminihome.eta-stt-relay",
    "uk.llmvinayminihome.eta-diarize",
    "com.vinaybhardwaj.eta-status",
    "com.vinaybhardwaj.eta-indic",
    "com.vinaybhardwaj.eta-sravaani",
    "com.vinaybhardwaj.eta-router",
    "com.evenscribe.room-recorder",
    "com.evenscribe.session-id",
    "com.evenscribe.stt-drain",
]
HOME = os.path.expanduser("~")
PLIST_DIRS = [os.path.join(HOME, "Library/LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"]
SRC = (".py", ".sh", ".js", ".mjs", ".ts", ".swift", ".m", ".c", ".rs", ".go")
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "bin", "lib", "lib64",
             "share", "include", "jobs", "logs", "log", "cache", ".cache", "out", "outputs",
             "results", "tmp", "data", "audio", "clips", "models", "site-packages"}

def launchctl_rows():
    out = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
    d = {}
    for ln in out.splitlines():
        p = ln.split("\t")
        if len(p) >= 3:
            d[p[2].strip()] = p[0].strip()
    return d

def proc_start(pid):
    s = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    if not s:
        return None
    try:
        return datetime.datetime.strptime(s, "%a %b %d %H:%M:%S %Y")
    except Exception:
        return None

def load_plist(path):
    """Handle XML, binary, and the malformed ones, via plutil."""
    try:
        with open(path, "rb") as fh:
            return plistlib.load(fh)
    except Exception:
        pass
    r = subprocess.run(["plutil", "-convert", "xml1", "-o", "-", path], capture_output=True)
    if r.returncode == 0 and r.stdout:
        try:
            return plistlib.load(io.BytesIO(r.stdout))
        except Exception:
            return None
    return None

def code_dirs(pl):
    args = pl.get("ProgramArguments") or ([pl["Program"]] if "Program" in pl else [])
    dirs = []
    wd = pl.get("WorkingDirectory")
    if wd and os.path.isdir(wd):
        dirs.append(wd)
    for a in args:
        if not isinstance(a, str):
            continue
        if os.path.isfile(a) and (a.endswith(SRC) or "/" in a):
            dirs.append(os.path.dirname(a))
        elif os.path.isdir(a):
            dirs.append(a)
    seen, out = set(), []
    for d in dirs:
        rd = os.path.realpath(d)
        if rd in seen or rd in ("/", "/usr", "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"):
            continue
        if "/Library/" in rd or rd.startswith("/System"):
            continue
        seen.add(rd); out.append(rd)
    return out

def newest_source(d):
    bt, bf, n = 0, None, 0
    for root, dn, fn in os.walk(d):
        dn[:] = [x for x in dn if x not in SKIP_DIRS and not x.startswith(".")]
        for f in fn:
            if not f.endswith(SRC):
                continue
            if ".bak" in f or f.endswith((".pyc", ".orig")):
                continue
            p = os.path.join(root, f)
            try:
                m = os.path.getmtime(p)
            except OSError:
                continue
            n += 1
            if m > bt:
                bt, bf = m, p
    return bt, bf, n

rows, live = launchctl_rows(), []
print("%-36s %-7s %-14s %-14s %-9s %s" % ("SERVICE", "PID", "PROC STARTED", "NEWEST SRC", "DRIFT", "FILE / NOTE"))
print("-" * 122)
for label in SERVICES:
    pid = rows.get(label)
    if not pid or pid == "-":
        print("%-36s %-7s %s" % (label, "-", "NOT RUNNING"))
        continue
    st = proc_start(pid)
    sts = st.strftime("%d %b %H:%M") if st else "?"
    path = None
    for d in PLIST_DIRS:
        c = os.path.join(d, label + ".plist")
        if os.path.exists(c):
            path = c; break
    if not path:
        print("%-36s %-7s %-14s %-14s %-9s %s" % (label, pid, sts, "-", "-", "plist not found"))
        continue
    pl = load_plist(path)
    if pl is None:
        print("%-36s %-7s %-14s %-14s %-9s %s" % (label, pid, sts, "-", "-", "plist unparseable even via plutil"))
        continue
    dirs = code_dirs(pl)
    if not dirs:
        print("%-36s %-7s %-14s %-14s %-9s %s" % (label, pid, sts, "-", "-", "no source dir in ProgramArguments"))
        continue
    bt, bf, tot = 0, None, 0
    for d in dirs:
        t, f, n = newest_source(d)
        tot += n
        if t > bt:
            bt, bf = t, f
    if tot == 0:
        print("%-36s %-7s %-14s %-14s %-9s %s" % (label, pid, sts, "-", "-", "0 source files under " + dirs[0].replace(HOME, "~")))
        continue
    drift_h = (bt - st.timestamp()) / 3600.0 if st else None
    stale = drift_h is not None and drift_h > 0
    if stale:
        live.append((label, drift_h, bf))
    print("%-36s %-7s %-14s %-14s %-9s %s" % (
        label, pid, sts,
        datetime.datetime.fromtimestamp(bt).strftime("%d %b %H:%M"),
        ("+%.1fd" % (drift_h / 24.0)) if stale else "ok",
        ("STALE " if stale else "") + (bf.replace(HOME, "~") if bf else "") + " (%d src)" % tot))

print()
print("STALE: %d service(s) running code older than what is on disk." % len(live))
for lbl, d, f in sorted(live, key=lambda x: -x[1]):
    print("  %-36s %.1f days behind; newest unshipped source: %s" % (lbl, d / 24.0, f.replace(HOME, "~")))
if not live:
    print("  (none)")
