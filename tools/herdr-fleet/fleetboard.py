#!/usr/bin/env python3
"""ETA fleet board: a read-only, full-screen overview of machines and agent panes.

Collects from the herdr CLI (read-only calls only: machine list, agent list,
workspace list, pane process-info) every 30 s in a background thread and
renders with curses. `--once` does one collection and prints plain text.
Only key handled: q (quit).
"""
import argparse
import curses
import json
import locale
import os
import re
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROSTER_PATH = os.path.join(HERE, "roster.json")
STATE_PATH = os.path.join(HERE, "state.json")
JOBS_PATH = os.path.join(HERE, "jobs.json")
HERDR = "/opt/homebrew/bin/herdr"
IST = timezone(timedelta(hours=5, minutes=30))

REFRESH_SECS = 30
CALL_TIMEOUT = 20
MODEL_TTL = 600
MACHINE_BUDGET = 38      # stop issuing process-info calls after this many seconds
PAGE_SECS = 15
SKIP_SESSIONS = {"ctl-test"}   # named local herdr sessions the board never reads
STALE_AFTER = 150        # header turns red if no cycle has finished for this long

STATUS_ORDER = {"blocked": 0, "working": 1, "idle": 2, "done": 3, "unknown": 4}
STATUS_BADGE = {"blocked": "BLOCKED", "working": "WORKING", "idle": "IDLE",
                "done": "DONE", "unknown": "UNKNOWN"}
STATUS_STYLE = {"blocked": "b_blocked", "working": "b_working", "idle": "b_idle",
                "done": "b_done", "unknown": "b_unknown"}

ASCII_MAP = {"●": "*", "○": "o", "─": "-", "…": "~", "▌": "|",
             "▲": "!", "·": "-", "—": "-"}
UNI = True


# ----------------------------------------------------------------- helpers

def trunc(s, n):
    s = "" if s is None else str(s)
    if n <= 0:
        return ""
    if len(s) <= n:
        return s
    if n == 1:
        return "…"
    return s[: n - 1] + "…"


def pad(s, n):
    return trunc(s, n).ljust(n)


def fmt_age(sec):
    sec = max(0, int(sec))
    if sec < 60:
        return "<1m"
    if sec < 3600:
        return "%dm" % (sec // 60)
    if sec < 86400:
        return "%dh" % (sec // 3600)
    return "%dd" % (sec // 86400)


def hhmm(ts, secs=False):
    return datetime.fromtimestamp(ts, IST).strftime("%H:%M:%S" if secs else "%H:%M")


# herdr-lead 8 Oct: call herdr on these machines directly over multiplexed ssh
# (box: 0.16 s vs 6 s through --machine). Unknown machines keep --machine.
FAST_SSH = {
    "c33e904116170d7a433e283bad3200c8": "e2e-lab",
    "85baa2e0f8428b0b03a3e8606f826e43": "e2e-ci",
}
if os.environ.get("HX_HOST_ASUS"):  # asus host is set locally, not committed
    FAST_SSH["6481ba9074c9fa50c5ebf1a2de931786"] = os.environ["HX_HOST_ASUS"]


def _herdr_cmd(args, machine):
    if machine in FAST_SSH:
        import shlex
        rc = "PATH=$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH; herdr " + " ".join(shlex.quote(a) for a in args)
        return ["ssh", "-n", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", FAST_SSH[machine], rc]
    return [HERDR] + (["--machine", machine] if machine else []) + args


def herdr(args, machine=None, timeout=CALL_TIMEOUT):
    cmd = _herdr_cmd(args, machine)
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except Exception:
            pass
        try:
            p.communicate(timeout=2)
        except Exception:
            pass
        raise RuntimeError("timeout after %ds" % timeout)
    if p.returncode != 0:
        raise RuntimeError((err or out or "").strip()[:100] or "exit %d" % p.returncode)
    return out


def herdr_json(args, machine=None, timeout=CALL_TIMEOUT):
    return json.loads(herdr(args, machine, timeout))


# ------------------------------------------------------------------ roster

_roster = {"mtime": None, "data": {"agents": {}, "machines": {}, "extra_machines": []}, "err": None}


def load_roster():
    try:
        mt = os.stat(ROSTER_PATH).st_mtime
        if mt != _roster["mtime"]:
            with open(ROSTER_PATH) as f:
                d = json.load(f)
            _roster["data"] = {"agents": d.get("agents", {}) or {},
                               "machines": d.get("machines", {}) or {},
                               "extra_machines": d.get("extra_machines", []) or []}
            _roster["mtime"] = mt
        _roster["err"] = None
    except Exception as e:  # keep last good roster
        _roster["err"] = str(e)[:60]
    return _roster["data"], _roster["err"]


# -------------------------------------------------------------------- jobs

_jobs = {"mtime": None, "data": [], "err": None}


def load_jobs():
    """jobs.json: list of {name, function, machine, owner, check}. Keeps last good copy."""
    try:
        mt = os.stat(JOBS_PATH).st_mtime
        if mt != _jobs["mtime"]:
            with open(JOBS_PATH) as f:
                d = json.load(f)
            _jobs["data"] = [j for j in d if isinstance(j, dict) and j.get("name")]
            _jobs["mtime"] = mt
        _jobs["err"] = None
    except FileNotFoundError:
        _jobs["data"], _jobs["mtime"], _jobs["err"] = [], None, None
    except Exception as e:
        _jobs["err"] = str(e)[:60]
    return _jobs["data"]


def run_check(cmd, timeout=CALL_TIMEOUT):
    """Run a job's check command on this machine. Returns (ok, first_line_or_error)."""
    p = subprocess.Popen(["/bin/sh", "-c", cmd], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except Exception:
            pass
        try:
            p.communicate(timeout=2)
        except Exception:
            pass
        return False, "timeout after %ds" % timeout
    line = next((ln.strip() for ln in (out or "").splitlines() if ln.strip()), "")
    if p.returncode != 0 or not line:
        why = (err or "").strip().splitlines()
        return False, (why[-1] if why else "exit %d" % p.returncode)[:80]
    return True, line


# ------------------------------------------------------------------- state

_state_lock = threading.Lock()
STATE = {"since": {}, "models": {}, "cache": {}}


def load_state():
    try:
        with open(STATE_PATH) as f:
            d = json.load(f)
        for k in STATE:
            STATE[k] = d.get(k, {}) or {}
    except Exception:
        pass


def save_state():
    try:
        with _state_lock:
            data = json.dumps(STATE)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            f.write(data)
        os.replace(tmp, STATE_PATH)
    except Exception:
        pass


# ------------------------------------------------------------------ models

def short_model(s):
    if not s:
        return ""
    s = s.strip().split("/")[-1].lower()
    s = re.sub(r"-\d{8}$", "", s)
    if s.startswith("claude-"):
        s = s[7:]
    m = re.match(r"^(sonnet|opus|haiku)(?:-(\d+)(?:-(\d+))?)?(?:\b|-|$)", s)
    if m:
        ver = ""
        if m.group(2):
            ver = " %s" % m.group(2) + ("." + m.group(3) if m.group(3) else "")
        return m.group(1) + ver
    m = re.match(r"^(\d+)(?:-(\d+))?-(sonnet|opus|haiku)", s)
    if m:
        return m.group(3) + " %s" % m.group(1) + ("." + m.group(2) if m.group(2) else "")
    return s


def model_from_procs(procs):
    for p in procs or []:
        av = p.get("argv") or []
        names = [os.path.basename(x) for x in av[:2]]
        if not any(n in ("claude", "opencode") for n in names):
            continue
        for i, x in enumerate(av):
            if x in ("--model", "-m") and i + 1 < len(av):
                return short_model(av[i + 1])
            if x.startswith("--model="):
                return short_model(x.split("=", 1)[1])
        if "claude" in names:
            return "default"   # herdr-lead 09 Oct: claude started without --model
    return ""


def model_from_label(*texts):
    for t in texts:
        if not t:
            continue
        m = re.search(r"\bC (sonnet|opus|haiku)\b", t, re.I)
        if m:
            return m.group(1).lower()
        m = re.search(r"OpenCode\s+(\S+)", t)
        if m:
            return short_model(m.group(1))
    return ""


# --------------------------------------------------------------- collector

def list_machines():
    """herdr machine list (TSV). Local machine has no entry; add it first."""
    ms = [{"id": None, "key": "local", "label": "Local", "enabled": True}]
    out = herdr(["machine", "list"])
    for ln in out.splitlines():
        parts = ln.split("\t")
        if len(parts) < 2 or not parts[0].strip():
            continue
        enabled = (parts[4].strip() == "enabled") if len(parts) >= 5 else True
        ms.append({"id": parts[0].strip(), "key": parts[0].strip(), "label": parts[1].strip(),
                   "enabled": enabled})
    return ms


def collect_machine(mach):
    mid, key = mach["id"], mach["key"]
    t0 = time.time()
    # herdr-lead 09 Oct: on the local Mini, also read every running named session (e.g. cc2,
    # where the lead sessions live). Pane ids repeat across sessions, so keys carry the session.
    sessions = [None]
    if mid is None:
        try:
            for ln in herdr(["session", "list"]).splitlines()[1:]:
                f_ = ln.split()
                if len(f_) >= 2 and f_[0] != "default" and f_[1] == "running" and f_[0] not in SKIP_SESSIONS:
                    sessions.append(f_[0])
        except Exception:
            pass
    raw, wl = [], {}
    for sn in sessions:
        pre = ["--session", sn] if sn else []
        try:
            with ThreadPoolExecutor(2) as ex:
                fa = ex.submit(herdr_json, pre + ["agent", "list"], mid)
                fw = ex.submit(herdr_json, pre + ["workspace", "list"], mid)
                ra = fa.result()["result"]["agents"]
                try:
                    wl.update({(sn, w["workspace_id"]): w.get("label", "") for w in fw.result()["result"]["workspaces"]})
                except Exception:
                    pass
        except Exception:
            if sn is None:
                raise
            continue
        for a in ra:
            a["_session"] = sn
        raw += ra

    def one(a):
        name = a.get("name") or a.get("terminal_title_stripped") or a.get("pane_id")
        sess = (a.get("agent_session") or {}).get("value", "")
        hs_ = a.get("_session")
        ck = "%s|%s|%s|%s" % (key if not hs_ else "%s@%s" % (key, hs_), a.get("pane_id"), sess, name)
        label = wl.get((hs_, a.get("workspace_id")), "")
        group = (a.get("tokens") or {}).get("group", "")
        now = time.time()
        with _state_lock:
            c = STATE["models"].get(ck)
        if c and now - c["ts"] < MODEL_TTL:
            model = c["model"]
        else:
            model = None
            if time.time() - t0 < MACHINE_BUDGET:
                try:
                    d = herdr_json((["--session", hs_] if hs_ else []) + ["pane", "process-info", "--pane", a["pane_id"]], mid)
                    model = model_from_procs(d["result"]["process_info"]["foreground_processes"])
                    with _state_lock:
                        STATE["models"][ck] = {"model": model, "ts": time.time()}
                except Exception:
                    model = None
        model = model or model_from_label(group, label) or "?"
        status = a.get("agent_status") or "unknown"
        if status not in STATUS_ORDER:
            status = "unknown"
        return {"name": name, "pane": a.get("pane_id"), "agent": a.get("agent"), "status": status, "_session": hs_,
                "model": model, "title": a.get("terminal_title_stripped") or "",
                "wslabel": label, "cwd": a.get("cwd") or ""}

    with ThreadPoolExecutor(6) as ex:
        agents = list(ex.map(one, raw))

    now = time.time()
    with _state_lock:
        since = STATE["since"]
        seen = set()
        for a in agents:
            k = "%s|%s" % (key if not a.get("_session") else "%s@%s" % (key, a["_session"]), a["name"])
            seen.add(k)
            cur = since.get(k)
            if not cur or cur.get("status") != a["status"]:
                cur = {"status": a["status"], "since": now}
                since[k] = cur
            a["since"] = cur["since"]
        for k in [k for k in since if (k.startswith(key + "|") or k.startswith(key + "@")) and k not in seen]:
            del since[k]
        STATE["cache"][key] = {"ts": now, "agents": agents}
    return {"ok": True, "ts": now, "agents": agents, "err": "", "dur": now - t0}


class Board:
    def __init__(self):
        self.lock = threading.Lock()
        self.snap = {"machines": [], "results": {}, "cycle_end": None, "collecting": False,
                     "last_cycle_dur": None, "error": "", "jobs": {}}
        for key, c in STATE["cache"].items():  # seed from last run: shown greyed until refreshed
            self.snap["results"][key] = {"ok": None, "ts": c.get("ts"), "agents": c.get("agents", []),
                                         "err": "", "dur": None}

    def snapshot(self):
        with self.lock:
            s = dict(self.snap)
            s["results"] = dict(self.snap["results"])
            s["jobs"] = dict(self.snap["jobs"])
            return s

    def _set_result(self, key, res):
        with self.lock:
            self.snap["results"][key] = res

    def cycle(self):
        t0 = time.time()
        with self.lock:
            self.snap["collecting"] = True
        try:
            machines = list_machines()
            with self.lock:
                self.snap["machines"] = machines
            roster, _ = load_roster()

            def work(m):
                rinfo = roster["machines"].get(m["label"], {})
                if rinfo.get("hide") or not m["enabled"]:
                    return
                try:
                    res = collect_machine(m)
                except Exception as e:
                    with self.lock:
                        prev = self.snap["results"].get(m["key"]) or {}
                    ts = prev.get("ts")
                    if prev.get("ok") is None and ts is None:
                        ts = None
                    res = {"ok": False, "ts": ts, "agents": prev.get("agents", []),
                           "err": str(e)[:80], "dur": time.time() - t0}
                    if prev.get("ok") is True:
                        res["ts"] = prev.get("ts")
                self._set_result(m["key"], res)

            jobs = [j for j in load_jobs() if j.get("check")]

            def jwork(j):
                try:
                    ok, line = run_check(j["check"])
                except Exception as e:
                    ok, line = False, str(e)[:80]
                with self.lock:
                    self.snap["jobs"][j["name"]] = {"ok": ok, "line": line, "ts": time.time()}

            with ThreadPoolExecutor(max(1, len(machines) + len(jobs))) as ex:
                futs = [ex.submit(work, m) for m in machines] + [ex.submit(jwork, j) for j in jobs]
                for f in futs:
                    f.result()
            save_state()
            with self.lock:
                self.snap["cycle_end"] = time.time()
                self.snap["last_cycle_dur"] = time.time() - t0
                self.snap["error"] = ""
        except Exception as e:
            with self.lock:
                self.snap["error"] = "collector: %s" % str(e)[:80]
        finally:
            with self.lock:
                self.snap["collecting"] = False

    def loop(self, stop):
        while not stop.is_set():
            t0 = time.time()
            self.cycle()
            stop.wait(max(5, REFRESH_SECS - (time.time() - t0)))


# ------------------------------------------------------------------ layout
# A line is (spans, fill_style_or_None); a span is (text, style_name).


# ---- plain-ssh fallback probe (herdr-lead 08 Oct): HF Spaces reject herdr's platform detection,
# but a plain ssh works. roster machines[label].ssh_probe = "user@host" enables it.
import threading as _th
_SSHP = {}
def _ssh_probe_ok(target, cmd="true"):
    key = target + "\0" + cmd
    ent = _SSHP.get(key)
    now = time.time()
    if ent is None or (now - ent["ts"] > 60 and not ent["busy"]):
        ent = ent or {"ok": None, "ts": 0, "busy": False}
        ent["busy"] = True
        _SSHP[key] = ent
        def run():
            try:
                r = subprocess.run(["ssh", "-n", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", target, cmd],
                                   capture_output=True, timeout=20)
                good = (r.returncode == 0)
            except Exception:
                good = False
            # HF ssh gateway flaps: one failed probe keeps the last state; two in a row = unreachable
            ent["fails"] = 0 if good else ent.get("fails", 0) + 1
            if good or ent["fails"] >= 2 or ent["ok"] is None:
                ent["ok"] = good
            ent["ts"] = time.time(); ent["busy"] = False
        _th.Thread(target=run, daemon=True).start()
    return ent["ok"]

def assemble(snap, roster):
    """Return (machines, agents) display records."""
    machines, agents = [], []
    rmach = roster["machines"]
    ragents = roster["agents"]
    order = {lbl: i for i, lbl in enumerate(rmach.keys())}
    herd = sorted(snap["machines"], key=lambda m: order.get(m["label"], 10 ** 6))
    for m in herd:
        info = rmach.get(m["label"], {})
        if info.get("hide"):
            continue
        res = snap["results"].get(m["key"])
        if not m["enabled"]:
            state = "paused"
        elif res is None or res.get("ok") is None:
            state = "checking"
        elif res["ok"]:
            state = "online"
        else:
            state = "unreachable"
            if info.get("ssh_probe") and _ssh_probe_ok(info["ssh_probe"]):
                state = "online"
                res = dict(res or {}); res["agents"] = []; res["err"] = ""
        ags = res.get("agents", []) if (res and m["enabled"]) else []
        rec = {"key": m["key"], "name": info.get("short") or m["label"],
               "kind": (info.get("kind") or "").capitalize(), "role": info.get("role", ""),
               "state": state, "n": len(ags), "last_ok": (res or {}).get("ts"),
               "err": (res or {}).get("err", "")}
        machines.append(rec)
        for a in ags:
            r = ragents.get(a["name"]) or lead_cfg().get(a["name"], {})
            agents.append({"mkey": m["key"], "name": a["name"], "status": a["status"],
                           "model": a["model"], "since": a.get("since"),
                           "func": r.get("function") or a.get("wslabel") or a.get("title") or "",
                           "owner": r.get("owner") or "?",
                           "stale": state in ("unreachable", "checking")})
    for x in roster["extra_machines"]:
        st = (x.get("state") or "").lower()
        mstate = "stopped" if st == "stopped" else ("online" if st == "running" else "extra")
        if x.get("probe_ssh"):
            ok = _ssh_probe_ok(x["probe_ssh"], x.get("probe_cmd", "true"))
            mstate = "checking" if ok is None else ("online" if ok else "unreachable")
            st = x.get("probe_label", "live probe") if ok else (st or "probe failed")
        machines.append({"key": None, "name": x.get("short", "?"),
                         "kind": (x.get("kind") or "").capitalize(), "role": x.get("role", ""),
                         "state": mstate, "n": 0,
                         "info": st or "n/a", "last_ok": None, "err": ""})
    rank = {"online": 0, "unreachable": 0, "checking": 0, "paused": 1, "stopped": 2, "extra": 3}
    machines.sort(key=lambda m: rank.get(m["state"], 0))
    return machines, agents


DOT_STYLE = {"online": "green", "paused": "grey", "stopped": "grey", "extra": "grey",
             "unreachable": "red", "checking": "yellow"}


def off_state_text(m):
    st = m["state"]
    return "paused" if st == "paused" else ("stopped" if st == "stopped" else (m.get("info") or "off"))


def machine_cell(m, w):
    st = m["state"]
    off = st in ("paused", "stopped", "extra")
    compact = w < 56  # 3-column layout: no room for the role text
    if st == "online":
        info, istyle = ("%d agent%s" % (m["n"], "" if m["n"] == 1 else "s")), "text"
    elif st == "unreachable":
        info, istyle = "unreachable", "redbold"
    elif st == "checking":
        info, istyle = "checking", "yellow"
    else:
        info, istyle = (off_state_text(m) if compact else "\u2014"), "dim"
    nstyle = "red" if st == "unreachable" else ("dim" if off else "bold")
    kind = m["kind"]
    if compact:
        kind = {"Physical": "Phys"}.get(kind, kind)
    nw, tw, iw = 16, (5 if compact else 9), 12
    spans = [("\u25cf ", DOT_STYLE[st]), (pad(m["name"], nw) + " ", nstyle),
             (pad(kind, tw) + " ", "dim"), (pad(info, iw) + " ", istyle)]
    rem = w - (2 + nw + 1 + tw + 1 + iw + 1)
    if rem >= 10:
        role = m["role"]
        if off:
            role = re.sub(r"\s*\((paused|stopped)\)\s*$", "", role)
            role = "%s \u00b7 %s" % (role, off_state_text(m)) if role else off_state_text(m)
        spans.append((trunc(role, rem), "faint" if off else "dim"))
    return spans


def span_len(spans):
    return sum(len(t) for t, _ in spans)


def title_rule(title, W):
    return [("\u2500\u2500 ", "rule"), (title, "sect"), (" " + "\u2500" * max(0, W - 1 - 4 - len(title)), "rule")]


def job_state(j, snap):
    """-> (state, text): state in running / idle / failed / pending."""
    r = snap.get("jobs", {}).get(j["name"])
    if r is None:
        return "pending", "checking\u2026"
    if not r["ok"]:
        return "failed", "check failed" + (" (%s)" % trunc(r["line"], 40) if r.get("line") else "")
    if r["line"].lower().startswith("running"):
        return "running", r["line"]
    return "idle", r["line"]


def job_lines(jobs, snap, W):
    states = [job_state(j, snap) for j in jobs]
    namew = min(24, max(len(j["name"]) for j in jobs))
    progw = min(78, max(len(t) for _, t in states))
    ownw = 8
    lines = []
    for j, (st, text) in zip(jobs, states):
        dot = {"running": "green", "failed": "dimred"}.get(st, "grey")
        tstyle = {"running": "text", "failed": "dimred"}.get(st, "dim")
        sp = [(" \u25cf ", dot), (pad(j["name"], namew), "bold"), (" ", "text")]
        used = 3 + namew + 1
        pw = max(10, min(progw, W - 1 - used - ownw - 2 - 20))
        sp += [(pad(text, pw), tstyle), (" ", "text")]
        used += pw + 1
        rest = W - 1 - used - ownw - 1
        info = " \u00b7 ".join(x for x in (j.get("function"), j.get("machine")) if x)
        if rest >= 8:
            sp += [(pad(info, rest), "faint"), (" ", "text")]
        sp.append((pad(j.get("owner", ""), ownw), "owner"))
        lines.append((sp, None))
    return lines


def build(snap, roster, roster_err, W, H, plain=False, page=None):
    now = time.time()
    if W < 24 or H < 6:
        return [([("terminal too small", "dim")], None)]
    machines, agents = assemble(snap, roster)
    leads = lead_agents(now, skip={a["name"] for a in agents})
    # HK6b F1: the Sarvam API draws as a normal MACHINES row after the others.
    sv = sarvam_agg(now)
    sv_state = "online" if sv.get("state") in ("working", "idle") else ("checking" if sv.get("state") == "stale" else "idle")
    machines.append({"key": "sarvam", "name": "Sarvam API", "kind": "Cloud", "role": sv.get("detail", ""),
                     "state": sv_state, "n": sv.get("n_jobs", 0), "info": sv.get("detail", ""),
                     "last_ok": None, "err": ""})
    reach = {m["key"]: m for m in machines if m["key"]}
    live = [a for a in agents if not a["stale"]] + leads
    cnt = {s: sum(1 for a in live if a["status"] == s) for s in STATUS_ORDER}
    n_unreach = sum(1 for m in machines if m["state"] == "unreachable")

    out = []
    # ---- header
    left = [(" ETA FLEET ", "title"), ("  ", "text"),
            (datetime.fromtimestamp(now, IST).strftime("%a %d %b  %H:%M:%S") + " IST", "bold")]
    ce = snap.get("cycle_end")
    if ce is None:
        right, rstyle = "refreshing…" if snap.get("collecting") else "waiting for first refresh", "yellow"
    elif now - ce > STALE_AFTER:
        right, rstyle = "STALE: last refresh %s" % hhmm(ce, True), "redbold"
    else:
        right = "refreshed %s" % hhmm(ce, True) + (" · updating" if snap.get("collecting") else "")
        rstyle = "dim"
    gap = W - 1 - span_len(left) - len(right)
    out.append((left + ([(" " * gap, "text"), (right, rstyle)] if gap >= 2 else []), None))
    cspans = []
    jobs = load_jobs()
    n_jobs = sum(1 for j in jobs if job_state(j, snap)[0] == "running")
    items = [("working", cnt["working"], "green"), ("idle", cnt["idle"], "yellow"),
             ("job running" if n_jobs == 1 else "jobs running", n_jobs, "green"),
             ("done", cnt["done"], "cyan"), ("blocked", cnt["blocked"], "redbold"),
             ("unreachable", n_unreach, "redbold")]
    cspans.append((" ", "text"))
    for lbl, n, sty in items:
        s = sty if n else "faint"
        cspans += [("● ", s), ("%d %s" % (n, lbl), s if n else "faint"), ("    ", "text")]
    out.append((cspans, None))
    blocked = [a for a in live if a["status"] == "blocked"]
    if blocked:
        names = ", ".join(a["name"] for a in blocked)
        out.append(([(" ▲ NEEDS ATTENTION  ", "b_blocked"), (" " + names, "redbold")], None))
    out.append((title_rule("MACHINES", W), None))

    # ---- machines: every machine gets a row; use as few columns as keep everything on one page
    n_flat = (len(agents) + len({a["mkey"] for a in agents}) + ((1 + (len(leads) + 1) // 2) if leads else 0)) or 1
    jobs_n = (1 + len(jobs)) if jobs else 0
    allowed = [c for c, minw in ((1, 0), (2, 96), (3, 120)) if W >= minw]
    cols = allowed[-1]
    for c in allowed:
        need = len(out) + -(-len(machines) // c) + jobs_n + 1 + n_flat + 1
        if need <= H:
            cols = c
            break
    gapw = 2
    cw = (W - 1 - 1 - (cols - 1) * gapw) // cols
    max_rows = max(2, H // 3)
    rows = [machines[i:i + cols] for i in range(0, len(machines), cols)]
    hidden_m = 0
    if len(rows) > max_rows:
        hidden_m = sum(len(r) for r in rows[max_rows - 1:])
        rows = rows[:max_rows - 1]
    for r in rows:
        spans = [(" ", "text")]
        for i, m in enumerate(r):
            cell = machine_cell(m, cw)
            spans += cell
            fill = cw - span_len(cell)
            if i < len(r) - 1:
                spans.append((" " * (fill + gapw), "text"))
        out.append((spans, None))
    if hidden_m:
        out.append(([(" +%d more machines" % hidden_m, "dim")], None))
    # ---- jobs (background work that is not an agent)
    if jobs:
        out.append((title_rule("JOBS", W), None))
        out += job_lines(jobs, snap, W)

    # ---- agents
    out.append((title_rule("AGENTS", W), None))
    # column plan
    namew = min(22, max([len(a["name"]) for a in agents] + [8]))
    modw = min(16, max([len(a["model"]) for a in agents] + [5]))
    ownw, agew = 8, 5
    show_owner, show_model = True, True
    def funcw():
        fixed = 1 + 9 + 1 + namew + 1 + 1 + agew + 1
        if show_model:
            fixed += modw + 1
        if show_owner:
            fixed += ownw + 1
        return W - 1 - fixed
    if funcw() < 24:
        show_owner = False
    if funcw() < 16:
        show_model = False
    if funcw() < 10:
        namew = max(8, namew - 6)
    fw = max(0, funcw())

    groups = []
    for m in machines:
        if m["key"] is None:
            continue
        ags = [a for a in agents if a["mkey"] == m["key"]]
        if not ags:
            continue
        ags.sort(key=lambda a: (STATUS_ORDER.get(a["status"], 9), a["name"]))
        groups.append((m, ags))
    groups.sort(key=lambda g: 0 if any(a["status"] == "blocked" and not a["stale"] for a in g[1]) else 1)

    flat = []  # ("hdr", line) / ("row", line)
    for m, ags in groups:
        stale = m["state"] in ("unreachable", "checking")
        hs = [(" ▌ ", "red" if m["state"] == "unreachable" else "sect"),
              (m["name"], "red" if m["state"] == "unreachable" else "bold")]
        if m["kind"]:
            hs.append((" · " + m["kind"], "dim"))
        if m["state"] == "unreachable":
            seen = hhmm(m["last_ok"]) if m["last_ok"] else "never"
            hs.append(("  UNREACHABLE — last seen %s" % seen, "redbold"))
            if m.get("err"):
                hs.append(("  (%s)" % trunc(m["err"], 40), "faint"))
        elif m["state"] == "checking":
            hs.append(("  checking… (showing last known)", "yellow"))
        else:
            parts = ["%d agent%s" % (len(ags), "" if len(ags) == 1 else "s")]
            w_ = sum(1 for a in ags if a["status"] == "working")
            if w_:
                parts.append("%d working" % w_)
            hs.append(("  " + " · ".join(parts), "dim"))
        flat.append(("hdr", (hs, None), None))
        cur_hdr = hs
        for a in ags:
            isb = a["status"] == "blocked" and not a["stale"]
            base = "br" if isb else ("faint" if stale else "text")
            nm = "brb" if isb else ("faint" if stale else "bold")
            badge = " %s " % STATUS_BADGE[a["status"]]
            bs = "b_stale" if stale else STATUS_STYLE[a["status"]]
            age = "—" if stale or not a["since"] else fmt_age(now - a["since"])
            sp = [(" ", base), (badge.center(9), bs), (" ", base),
                  (pad(a["name"], namew), nm), (" ", base),
                  (pad(a["func"], fw), base if isb else ("faint" if stale else "dim")), (" ", base)]
            if show_model:
                sp += [(pad(a["model"], modw), "br" if isb else ("faint" if stale else "cyan")), (" ", base)]
            if show_owner:
                sp += [(pad(a["owner"], ownw), "br" if isb else ("faint" if stale else "owner")), (" ", base)]
            sp.append((age.rjust(agew), base))
            flat.append(("row", (sp, "br" if isb else None), cur_hdr))
    if leads:
        ls_ = sorted(leads, key=lambda a: (STATUS_ORDER.get(a["status"], 9), a["name"]))
        nw_ = sum(1 for a in ls_ if a["status"] == "working")
        lh = [(" ▌ ", "sect"), ("Leads", "bold"), (" · outside herdr", "dim"),
              ("  %d lead%s%s · age = last bus post" % (len(ls_), "" if len(ls_) == 1 else "s",
                                                      " · %d working" % nw_ if nw_ else ""), "dim")]
        flat.append(("hdr", (lh, None), None))
        half = (W - 2) // 2
        lnw = min(22, max(len(a["name"]) for a in ls_))
        per = 2 if 2 * (1 + 9 + 1 + lnw + 1 + ownw + 1 + agew) <= W - 1 else 1
        for i in range(0, len(ls_), per):
            sp = []
            for j, a in enumerate(ls_[i:i + per]):
                age = "—" if not a["since"] else fmt_age(now - a["since"])
                cell = [(" ", "text"), (" %s " % STATUS_BADGE[a["status"]], STATUS_STYLE[a["status"]]), (" ", "text"),
                        (pad(a["name"], lnw), "bold"), (" ", "text"), (pad(a["owner"], ownw), "owner"), (" ", "text"),
                        (age.rjust(agew), "text")]
                cell[1] = (cell[1][0].center(9), cell[1][1])
                if j == 0 and per == 2:
                    cell.append((" " * max(1, half - span_len(cell)), "text"))
                sp += cell
            flat.append(("row", (sp, None), lh))
    if not flat:
        flat.append(("hdr", ([(" no agents reported yet", "dim")], None), None))

    page_note = ""
    if plain:
        out += [ln for _, ln, _h in flat]
    else:
        avail = max(1, H - len(out) - 1)  # leave footer row
        pages, cur = [], []
        for kind, ln, hdr in flat:
            if len(cur) >= avail or (kind == "hdr" and len(cur) >= avail - 1):
                pages.append(cur)
                cur = []
            if kind == "row" and not cur and hdr is not None:  # continued group: repeat its header
                cur.append(([(" \u258c ", "sect")] + [(trunc(hdr[1][0], 30), "bold"), (" (cont.)", "dim")], None))
            cur.append(ln)
        if cur:
            pages.append(cur)
        if len(pages) > 1:
            pg = int(now // PAGE_SECS) % len(pages) if page is None else page % len(pages)
            page_note = "page %d/%d, turns every %ds" % (pg + 1, len(pages), PAGE_SECS)
        else:
            pg = 0
        out += pages[pg] if pages else []
        while len(out) < H - 1:
            out.append(([], None))
    # ---- footer
    foot = " read-only · q quits · refresh %ds" % REFRESH_SECS
    fs = [(foot, "faint")]
    if page_note:
        fs.append((" \u00b7 " + page_note, "yellow"))
    dur = snap.get("last_cycle_dur")
    if dur is not None:
        fs.append((" · last cycle %.0fs" % dur, "faint"))
    if snap.get("error"):
        fs.append(("  " + snap["error"], "redbold"))
    if roster_err:
        fs.append(("  roster.json unreadable, using last good", "yellow"))
    out.append((fs, None))
    if not plain:
        if len(out) > H:  # tiny window: keep the top, then the footer
            out = out[:H - 1] + [out[-1]]
        out = [(clip_spans(sp, W - 1), fl) for sp, fl in out]
    return out


def clip_spans(spans, width):
    """Clip a line to `width` columns, ending in an ellipsis if anything was cut."""
    if span_len(spans) <= width:
        return spans
    res, used = [], 0
    for t, s in spans:
        room = width - used
        if room <= 0:
            break
        if len(t) <= room:
            res.append((t, s))
            used += len(t)
        else:
            res.append((trunc(t, room), s))
            used = width
            break
    else:
        return res
    if res and not res[-1][0].endswith("…") and used >= 1:
        t, s = res[-1]
        res[-1] = (t[:-1] + "…", s)
    return res


# --------------------------------------------------------------- rendering

def to_plain(lines):
    res = []
    for spans, _ in lines:
        res.append("".join(t for t, _s in spans).rstrip())
    return "\n".join(res)


def detect_unicode():
    global UNI
    try:
        locale.setlocale(locale.LC_ALL, "")
    except locale.Error:
        pass
    enc = (locale.getpreferredencoding(False) or "").lower()
    if "utf" not in enc:
        for loc in ("en_US.UTF-8", "C.UTF-8"):
            try:
                locale.setlocale(locale.LC_ALL, loc)
                enc = (locale.getpreferredencoding(False) or "").lower()
                if "utf" in enc:
                    break
            except locale.Error:
                continue
    UNI = "utf" in enc


# style: (fg256, bg256, attr, fg8, bg8)
B = curses.A_BOLD
STYLES = {
    "text": (252, 16, 0, 7, 0), "dim": (246, 16, 0, 7, 0), "faint": (240, 16, 0, 7, 0),
    "bold": (255, 16, B, 7, 0), "title": (16, 81, B, 0, 6), "sect": (75, 16, B, 4, 0),
    "rule": (237, 16, 0, 0, 0), "green": (78, 16, 0, 2, 0), "yellow": (221, 16, 0, 3, 0),
    "cyan": (81, 16, 0, 6, 0), "red": (203, 16, 0, 1, 0), "redbold": (203, 16, B, 1, 0),
    "grey": (244, 16, 0, 7, 0), "dimred": (131, 16, 0, 1, 0), "owner": (180, 16, 0, 5, 0),
    "b_working": (16, 78, B, 0, 2), "b_idle": (16, 221, B, 0, 3), "b_done": (16, 81, B, 0, 6),
    "b_blocked": (231, 196, B, 7, 1), "b_unknown": (16, 244, B, 0, 7), "b_stale": (245, 236, 0, 7, 0),
    "br": (231, 52, 0, 7, 1), "brb": (231, 52, B, 7, 1),
}
_attrs = {}


def init_colors():
    curses.start_color()
    big = curses.COLORS >= 256
    for i, (name, (f, b, a, f8, b8)) in enumerate(STYLES.items(), start=1):
        try:
            curses.init_pair(i, f if big else f8, b if big else b8)
            _attrs[name] = curses.color_pair(i) | a
        except curses.error:
            _attrs[name] = a
    if "text" not in _attrs:
        _attrs["text"] = 0


def attr(name):
    return _attrs.get(name, _attrs.get("text", 0))


def put(scr, y, x, text, style, maxx):
    if x >= maxx or not text:
        return x
    text = text[: maxx - x]
    if not UNI:
        text = text.translate(str.maketrans(ASCII_MAP))
    try:
        scr.addstr(y, x, text, attr(style))
    except curses.error:
        pass
    return x + len(text)


def draw(scr, lines):
    H, W = scr.getmaxyx()
    maxx = W - 1
    scr.erase()
    for y, (spans, fill) in enumerate(lines[:H]):
        x = 0
        if fill:
            put(scr, y, 0, " " * maxx, fill, maxx)
        for text, style in spans:
            x = put(scr, y, x, text, style, maxx)
    scr.noutrefresh()
    curses.doupdate()


def tui(scr, board):
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    init_colors()
    scr.bkgd(" ", attr("text"))
    scr.timeout(1000)
    scr.keypad(True)
    while True:
        try:
            H, W = scr.getmaxyx()
            roster, rerr = load_roster()
            try:
                lines = build(board.snapshot(), roster, rerr, W, H)
            except Exception as e:  # never let a render bug kill the board
                lines = [([(" render error: %s" % trunc(e, W - 18), "redbold")], None)]
            draw(scr, lines)
        except curses.error:
            pass
        ch = scr.getch()
        if ch == ord("q"):
            return
        if ch == curses.KEY_RESIZE:
            try:
                curses.update_lines_cols()
            except Exception:
                pass
            scr.clear()
        # every other key is ignored




# ---- Sarvam lane (HK6, herdr-lead order 08 Oct) ----
SARVAM_CALLERS_PATH = os.path.join(HERE, "sarvam_callers.json")
_sarvam_cache = {"ts": 0, "lanes": {}}

def sarvam_callers():
    try:
        with open(SARVAM_CALLERS_PATH) as f:
            return json.load(f).get("callers", [])
    except Exception:
        return []

def sarvam_lanes(max_age=60):
    """Fetch lanes/sarvam-<caller>.json from the box over ssh (one ssh per
    refresh, cached like the other box probes). Returns {caller: dict}."""
    now = time.time()
    with _state_lock:
        if now - _sarvam_cache["ts"] < max_age:
            return _sarvam_cache["lanes"]
    lanes = {}
    callers = sarvam_callers()
    if callers:
        cmd = ("for c in " + " ".join(c for c in callers) + "; do "
               'echo "===PATH $c"; cat "/home/eta/oc/fleet-json/sarvam/$c.json" 2>/dev/null; done')
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", "e2e-lab", cmd],
                           capture_output=True, text=True, timeout=20)
        txt = r.stdout or ""
        for caller in callers:
            m = re.search(r"===PATH %s\n(.*?)(?====PATH |\Z)" % re.escape(caller), txt, re.S)
            if m and m.group(1).strip():
                try:
                    lanes[caller] = json.loads(m.group(1))
                except Exception:
                    pass
    with _state_lock:
        _sarvam_cache["ts"] = now
        _sarvam_cache["lanes"] = lanes
    return lanes

def sarvam_agg(now=None):
    """Aggregate all caller lanes -> row dict + per-caller JOBS lines."""
    now = now or time.time()
    lanes = sarvam_lanes()
    n_jobs = 0
    detail_bits = {"batch": {}, "sync": {}}
    today_min = 0; total_min = 0
    stale = False
    job_lines = []
    for caller, lane in lanes.items():
        upd = lane.get("updated_at")
        try:
            upd_ts = datetime.fromisoformat(upd).timestamp() if upd else 0
        except Exception:
            upd_ts = 0
        active = lane.get("active") or []
        if active and upd_ts and (now - upd_ts) > 600:
            stale = True
        n_jobs += len(active)
        for a in active:
            mode = a.get("mode") or "?"
            task = a.get("task") or "?"
            if mode == "stream":
                mode = "sync"   # stream counts with sync (HK6b F2)
            key = (mode, task)
            detail_bits[mode][key] = detail_bits[mode].get(key, 0) + 1
        # herdr-lead 09 Oct (#10352): a lane's "today" is only rewritten when it runs, so a file last
        # written on an earlier IST date counts 0 for today.
        if upd_ts and datetime.fromtimestamp(upd_ts, IST).date() == datetime.fromtimestamp(now, IST).date():
            today_min += (lane.get("today") or {}).get("audio_min") or 0
        total_min += (lane.get("all_time") or {}).get("audio_min") or 0
    if not lanes:
        detail = "0 jobs idle · no data"
        state = "idle"
    else:
        state = "stale" if stale else ("working" if n_jobs else "idle")
        def mode_txt(bits, label):
            txt = ", ".join(f"{c} {t}" for (m_, t), c in sorted(bits.items())) if bits else "0"
            return f"{label}: {txt}"
        detail = f"{mode_txt(detail_bits['batch'], 'batch')} · {mode_txt(detail_bits['sync'], 'sync')} · today {int(today_min)} min · total {int(total_min)} min"
        for caller, lane in lanes.items():
            active = lane.get("active") or []
            if not active:
                continue
            counts = {}
            oldest = None
            for a2 in active:
                key = f"{a2.get('mode') or '?'} {a2.get('task') or '?'}"
                counts[key] = counts.get(key, 0) + 1
                started = a2.get("started_at")
                try:
                    t = datetime.fromisoformat(started).timestamp()
                except Exception:
                    continue
                if oldest is None or t < oldest:
                    oldest = t
            bits = ", ".join(f"{c} {k}" for k, c in sorted(counts.items()))
            age = ""
            if oldest:
                age_sec = max(0, int(now - oldest))
                age = f", oldest {age_sec // 60} min" if age_sec >= 60 else f", oldest {age_sec} s"
            job_lines.append(f"{caller}: {len(active)} active ({bits}{age})")
    return {"name": "Sarvam API", "kind": "cloud", "detail": detail, "state": state,
            "n_jobs": n_jobs, "job_lines": job_lines}

def sarvam_row():
    return sarvam_agg()


# ---- leads (herdr-lead 09 Oct): lead threads run as Claude Code sessions outside herdr panes,
# so they are shown from their last bus post (bus.db opened read-only). Config: leads.json.
LEADS_PATH = os.path.join(HERE, "leads.json")


def lead_cfg():
    try:
        with open(LEADS_PATH) as f:
            d = json.load(f)
        lv = d.get("leads") if isinstance(d, dict) else None
        return lv if isinstance(lv, dict) else {}
    except Exception:
        return {}


def lead_agents(now=None, skip=()):
    """Agent-shaped records for the leads in leads.json; [] on any error."""
    import sqlite3
    now = now or time.time()
    try:
        with open(LEADS_PATH) as f:
            cfg = json.load(f)
        leads = cfg.get("leads") if isinstance(cfg, dict) else None
        if not isinstance(leads, dict) or not leads:
            return []
        db = os.path.expanduser(cfg.get("bus_db", "~/dev/_fable/bus/bus.db"))
        con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=5)
        try:
            names = list(leads)
            q = "select sender, max(ts) from messages where sender in (%s) group by sender" % ",".join("?" * len(names))
            last = {r[0]: r[1] / 1000.0 for r in con.execute(q, names)}
        finally:
            con.close()
    except Exception:
        return []
    wk, idl = 60 * cfg.get("working_mins", 15), 60 * cfg.get("idle_mins", 180)
    out = []
    for name, info in leads.items():
        if name in skip:
            continue
        t = last.get(name)
        st = "unknown" if t is None else ("working" if now - t <= wk else ("idle" if now - t <= idl else "done"))
        out.append({"mkey": "leads", "name": name, "status": st, "model": info.get("model", "cc"),
                    "since": t, "func": info.get("function", ""), "owner": info.get("owner", "?"),
                    "stale": False})
    return out


def fleet_json(snap, roster):
    """Schema v1 fleet JSON (HK5, herdr-lead order 08 Oct): machines, agents
    (with thread/owner from roster.json, model, since, task), jobs. Only what
    the board already shows: no patient data, no transcripts, no secrets."""
    from datetime import timezone as _tz
    machines, agents = assemble(snap, roster)
    out_machines = []
    out_agents = []
    for m in machines:
        key = m.get("key")
        reachable = bool(key) and m.get("state") not in ("unreachable", "checking", "stopped")
        out_machines.append({
            "name": m.get("name") or "?",
            "kind": "cloud" if (m.get("kind") or "").lower() in ("cloud", "hf", "job") else "physical",
            "reachable": bool(reachable),
            "agents": len([a for a in agents if a.get("mkey") == key]) if key else 0,
            "note": (m.get("role") or m.get("info") or "")[:80],
        })
    for a in agents:
        state = a.get("status") or "unreachable"
        if a.get("stale"):
            state = "unreachable"
        task = (a.get("func") or "")[:80]
        out_agents.append({
            "name": a.get("name") or "?",
            "machine": a.get("mkey") or (a.get("machine") or "?"),
            "state": state,
            "thread": (a.get("owner") or "?"),
            "model": a.get("model") or "?",
            "since": (datetime.fromtimestamp(a["since"], timezone.utc).isoformat()
                      if a.get("since") else ""),
            "task": task,
        })
    for a in lead_agents(skip={a["name"] for a in agents}):
        out_agents.append({
            "name": a["name"], "machine": "leads", "state": a["status"],
            "thread": a["owner"], "model": a["model"],
            "since": (datetime.fromtimestamp(a["since"], timezone.utc).isoformat() if a.get("since") else ""),
            "task": a["func"][:80],
        })
    out_jobs = []
    jlist = load_jobs()
    jstates = snap.get("jobs") or {}
    for j in jlist:
        st, text = job_state(j, snap)
        out_jobs.append({"name": j.get("name") or "?", "state": st, "thread": j.get("owner") or "?",
                         "progress": (text or "")[:80]})
    sv = sarvam_agg()
    out_machines.append({"name": "Sarvam API", "kind": "cloud",
                         "reachable": True, "agents": sv.get("n_jobs", 0),
                         "state": sv.get("state", "idle"),
                         "note": sv.get("detail", "")[:80]})
    for jl in sv.get("job_lines", []):
        out_jobs.append({"name": jl.split(":")[0] if ":" in jl else "sarvam",
                         "state": "running", "thread": "HERDR",
                         "progress": (jl or "")[:80]})
    return {
        "schema_version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "machines": out_machines,
        "agents": out_agents,
        "jobs": out_jobs,
    }


def main():
    ap = argparse.ArgumentParser(description="ETA fleet board (read-only)")
    ap.add_argument("--once", action="store_true", help="collect once, print plain text, exit")
    ap.add_argument("--json", type=str, default=None, metavar="PATH",
                    help="collect once, write schema-v1 fleet JSON to PATH atomically, exit")
    ap.add_argument("--width", type=int, default=140, help="width for --once output")
    ap.add_argument("--height", type=int, default=10000, help="height used to pick the --once machine layout")
    args = ap.parse_args()
    load_state()
    detect_unicode()
    board = Board()
    if args.json:
        t0 = time.time()
        board.cycle()
        snap = board.snapshot()
        roster, rerr = load_roster()
        doc = fleet_json(snap, roster)
        tmp = args.json + ".tmp"
        with open(tmp, "w") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        os.replace(tmp, args.json)
        print("wrote %s (%d machines, %d agents, %d jobs) in %.1fs"
              % (args.json, len(doc["machines"]), len(doc["agents"]), len(doc["jobs"]), time.time() - t0))
        return
    stop = threading.Event()
    th = threading.Thread(target=board.loop, args=(stop,), daemon=True)
    th.start()
    try:
        curses.wrapper(tui, board)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        save_state()


if __name__ == "__main__":
    # herdr-lead 08 Oct: a restart (SIGTERM) exits 75 so the Air launcher reconnects; only q exits 0
    signal.signal(signal.SIGTERM, lambda *_: os._exit(75))
    main()
