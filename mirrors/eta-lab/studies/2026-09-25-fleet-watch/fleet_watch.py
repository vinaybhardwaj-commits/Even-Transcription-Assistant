#!/usr/bin/env python3
"""fleet_watch.py — FLEET-WATCH (Fable ruling 399): every 5 min check that every room is recording; the WRAPPER decides what is a problem, the model only gathers and explains.
Room/state/timings only: no audio, no transcript text, no patient names ever enter a log, the bug log or a message. The Scribe door is READ-ONLY (the read token; kit/clip_fetch_mcp.py client; only scribe_rooms,
scribe_health, scribe_room_levels are ever called here). Tokens are read from files by the client at call time and never appear in argv, config text, logs or output.
Modes: --once | --loop | --replay SNAP.json [--inject ROOM:CODE] | --select N (model comparison) | --selftest. Runtime dir: $FLEET_WATCH_HOME (default ~/fleet-watch).
"""
import argparse, datetime as dt, fcntl, json, os, subprocess, sys, time

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
RT = os.environ.get("FLEET_WATCH_HOME", os.path.expanduser("~/fleet-watch"))
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CFG = {
    "clinic": {"start": "08:00", "end": "20:00", "days": [0, 1, 2, 3, 4, 5]},   # Mon=0 .. Sat=5, IST
    "piece_age_s": 600, "stall_window_s": 600, "silent_flag_s": 1200, "reminder_s": 3600, "min_samples": 30,
    "mic_ok": {"ORB3": ["unknown"]},        # rooms whose mic_state is normally not 'authorized'
    "expected_rooms": ["OPD 1", "OPD 3", "OPD 4", "OPD 5", "OPD 6", "OPD 7", "Cardiology OPD", "ORB3"],   # r401 / scribe #2374: only these can raise a PROBLEM; every other room is INFO ("known not-recording" until V says otherwise)
    "known": {},                            # {room name: {CODE: "reason"}} -> INFO instead of PROBLEM (set by conductor/Fable, never guessed here)
    "ignore_rooms": [], "health_every_s": 900, "exact_zero_bps": [707.0, 709.0],   # r343/r376: strict full-chunk 707-709 B/s

    "budget_usd_per_day": 2.0, "interval_s": 300,
    "model": {"name": "gemini-3.5-flash-lite", "variant": "low", "fallback": "deepseek-v4.1-flash", "fallback_variant": "", "timeout_s": 170},   # PROVISIONAL (r399's deepseek-v4-flash is 403 on V's Zen account): 12-cycle comparison 25 Sep, both agree 12/12, measured $0.0037 vs $0.0054 per cycle
    "mini": {"host": "mini", "dir": "/Users/vinaybhardwaj/dev/fleet-watch"},
    "hsend": os.path.expanduser("~/dev/eta-lab/kit/hsend.sh"),
}
PROBLEM_CODES = ("NOT_RECORDING", "KIOSK_OFFLINE", "PIECES_STALLED", "TAPE_NOT_ADVANCING", "EXACT_ZERO_TAPE", "DEVICE_MISSING", "DEVICE_CHANGED", "MIC_NOT_AUTHORIZED", "NOT_DELIVERING", "DISK_RED")
SILENT_CODES = ("EXACT_ZERO_TAPE", "TAPE_NOT_ADVANCING")   # a room silent this long is flagged for the W21 self-test (never run from here)


def norm(name):
    return (name or "").rstrip(" -").strip()      # the door names one room "OPD 7 -"


def load_cfg(path=None):
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    p = path or os.path.join(RT, "config.json")
    if os.path.exists(p):
        for k, v in json.load(open(p)).items():
            cfg[k] = {**cfg[k], **v} if isinstance(v, dict) and isinstance(cfg.get(k), dict) else v
    return cfg


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def age_s(iso, now):
    t = parse_iso(iso)
    return None if t is None else max(0.0, (now - t).total_seconds())


def in_clinic(now, cfg):
    n = now.astimezone(IST); c = cfg["clinic"]
    hm = lambda s: dt.time(int(s[:2]), int(s[3:5]))
    return n.weekday() in c["days"] and hm(c["start"]) <= n.time() < hm(c["end"])


# ---------------------------------------------------------------- collect (read-only door)
def chunk_bps(manifest):
    """Bytes/s of the newest FULL (300 s) chunk from a session manifest; everything else in the reply (links, labels) is dropped here at once. None if unmeasurable."""
    for c in reversed((manifest or {}).get("chunks") or []):
        if c.get("duration_ms") == 300000 and isinstance(c.get("size_bytes"), int):
            return {"idx": c.get("idx"), "bps": c["size_bytes"] * 1000.0 / c["duration_ms"]}
    return None


def collect(call, now, state=None, cfg=None):
    """One deterministic snapshot. call(name, args) -> dict (kit/clip_fetch_mcp.call). Raises on a door failure (a WATCHER fault, not a room fault).
    scribe_health runs a real whisper probe: at most every cfg health_every_s (default 15 min); the cached copy is reused in between."""
    cfg = cfg or DEFAULT_CFG; state = state if state is not None else {}
    snap = {"ts": now.isoformat(), "now": call("scribe_rooms", {"view": "now"}), "fleet": {"rooms": call("scribe_rooms", {"view": "fleet"}).get("rooms", [])}, "levels": {}, "tape": {}}   # only the rooms: the release block carries download URLs we neither need nor keep
    h = state.get("health")
    if h and (now - parse_iso(h["ts"])).total_seconds() < cfg["health_every_s"]:
        snap["health"] = h["data"]
    else:
        snap["health"] = call("scribe_health", {}); state["health"] = {"ts": now.isoformat(), "data": snap["health"]}
    frm = (now - dt.timedelta(seconds=cfg["stall_window_s"] + 120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for r in snap["now"].get("rooms", []):
        rid = r["room"]["id"]
        try:
            snap["levels"][rid] = call("scribe_room_levels", {"room_id": rid, "from": frm}).get("samples")
        except Exception:
            snap["levels"][rid] = None       # unmeasurable, never 'ok'
        if r.get("recording") and r.get("recording_session_id"):
            try:
                snap["tape"][rid] = chunk_bps(call("scribe_session_tape", {"view": "manifest", "session_id": r["recording_session_id"]}))
            except Exception:
                snap["tape"][rid] = None
    return snap


# ---------------------------------------------------------------- decide (pure)
def decide(snap, cfg, now, prev_devices=None):
    """-> ({room name: [issue dicts]}, {room id: input device name}, [fleet info strings]). Issue = {code, severity PROBLEM|INFO, detail}. Clinic hours: the listed conditions are PROBLEMs; outside: INFO."""
    clinic = in_clinic(now, cfg); prev_devices = prev_devices or {}
    fl = {x["room"]["id"]: x for x in snap.get("fleet", {}).get("rooms", [])}
    out, devices = {}, {}
    for r in snap["now"].get("rooms", []):
        name, rid = r["room"]["name"], r["room"]["id"]
        if name in cfg["ignore_rooms"]:
            continue
        expected = norm(name) in [norm(x) for x in cfg["expected_rooms"]]
        inst = (fl.get(rid) or {}).get("install", {}); iss = []
        def add(code, detail, sev=None):
            s = sev or ("PROBLEM" if clinic and code in PROBLEM_CODES else "INFO")
            if not expected and s == "PROBLEM":
                s, detail = "INFO", detail + " [not in the expected-recording list]"
            why = cfg["known"].get(name, {}).get(code)
            iss.append({"code": code, "severity": "INFO" if why else s, "detail": detail + (" [known: %s]" % why if why else "")})
        rs = r.get("room_state", {}); recording = bool(r.get("recording")); flags = r.get("flags", {})
        offline = bool(flags.get("kiosk_not_listening")) or r.get("listener_state") != "listening" or r.get("page_open") is False
        if offline:
            add("KIOSK_OFFLINE", "listener=%s page_open=%s" % (r.get("listener_state"), r.get("page_open")))
        elif not recording:
            add("NOT_RECORDING", "state=%s" % rs.get("state"))
        pa = age_s(r.get("last_piece_at"), now)
        if recording and (flags.get("stalled") or (pa is not None and pa > cfg["piece_age_s"])):
            add("PIECES_STALLED", "last piece %s s ago" % (int(pa) if pa is not None else "n/a"))
        lv = snap.get("levels", {}).get(rid); win = None
        if recording and lv:
            cut = (now.timestamp() - cfg["stall_window_s"]) * 1000
            win = [s for s in lv if s.get("t_ms", 0) >= cut]
            if len(win) >= cfg["min_samples"]:
                if not any(s.get("tape_advancing") for s in win):
                    add("TAPE_NOT_ADVANCING", "no tape advance in %d samples" % len(win))
                zr = [s.get("zero_ratio") for s in win]
                if all(z is not None for z in zr) and min(zr) >= 0.999:
                    add("ZERO_SIGNAL", "zero_ratio >= 0.999 in all %d samples (level log; INFO only: quiet is not a fault, and this is NOT the r376 tape-rate rule)" % len(win), "INFO")
        tp = (snap.get("tape") or {}).get(rid)
        if recording and tp and cfg["exact_zero_bps"][0] <= tp["bps"] <= cfg["exact_zero_bps"][1]:
            add("EXACT_ZERO_TAPE", "newest full chunk %.2f B/s (r376 exact-zero band %s-%s)" % (tp["bps"], cfg["exact_zero_bps"][0], cfg["exact_zero_bps"][1]))
        if "DEVICE_MISSING" in (inst.get("state_flags") or []) or "DEVICE_MISSING" in (rs.get("flags") or []):
            add("DEVICE_MISSING", "input device missing")
        dev = inst.get("input_device_name"); devices[rid] = dev
        if dev and prev_devices.get(rid) and prev_devices[rid] != dev:
            add("DEVICE_CHANGED", "%s -> %s" % (prev_devices[rid], dev))
        mic = inst.get("mic_state")
        if mic is not None and mic != "authorized" and mic not in cfg["mic_ok"].get(name, []):
            add("MIC_NOT_AUTHORIZED", "mic_state=%s" % mic)
        nd = r.get("not_delivering_minutes")
        if nd is not None and nd >= 10:
            add("NOT_DELIVERING", "not delivering %s min" % nd)
        dl = (fl.get(rid) or {}).get("disk_level")
        if dl == "red":
            add("DISK_RED", "disk level red", "PROBLEM")
        elif dl == "amber":
            add("DISK_AMBER", "disk level amber", "INFO")
        out[name] = iss
    info = []
    for k in ("issues", "problems"):
        v = (snap.get("health") or {}).get(k)
        if isinstance(v, list):
            info += [str(x)[:60] for x in v]
    return out, devices, info


# ---------------------------------------------------------------- state machine: one message per problem per state change
def advance(state, issues, now, cfg):
    """-> (new_state, events). events: {type NEW|RESOLVED|REMIND|W21, room, code, detail, since, duration_s}."""
    st = dict(state); st["problems"] = dict(state.get("problems", {})); st["w21"] = dict(state.get("w21", {}))   # keep every other key (devices, budget_told)
    cur = {f"{room}|{i['code']}": (room, i) for room, iss in issues.items() for i in iss if i["severity"] == "PROBLEM"}
    ev, clinic = [], in_clinic(now, cfg); ts = now.isoformat()
    for key, (room, i) in cur.items():
        p = st["problems"].get(key)
        if p is None:
            st["problems"][key] = {"room": room, "code": i["code"], "first": ts, "reported": ts, "detail": i["detail"]}
            ev.append({"type": "NEW", "room": room, "code": i["code"], "detail": i["detail"], "since": ts})
        else:
            if clinic and (now - parse_iso(p["reported"])).total_seconds() >= cfg["reminder_s"]:
                p["reported"] = ts; ev.append({"type": "REMIND", "room": room, "code": i["code"], "detail": i["detail"], "since": p["first"], "duration_s": int((now - parse_iso(p["first"])).total_seconds())})
            p["detail"] = i["detail"]
            if i["code"] in SILENT_CODES and key not in st["w21"] and (now - parse_iso(p["first"])).total_seconds() >= cfg["silent_flag_s"]:
                st["w21"][key] = ts; ev.append({"type": "W21", "room": room, "code": i["code"], "detail": "silent %d min in clinic hours: candidate for the W21 mic self-test (run gate stays closed)" % (cfg["silent_flag_s"] // 60), "since": p["first"]})
    for key in list(st["problems"]):
        if key not in cur:
            p = st["problems"].pop(key); st["w21"].pop(key, None)
            ev.append({"type": "RESOLVED", "room": p["room"], "code": p["code"], "detail": "cleared" if clinic else "clinic hours ended or cleared", "since": p["first"], "duration_s": int((now - parse_iso(p["first"])).total_seconds())})
    return st, ev


def fmt_local(iso):
    return parse_iso(iso).astimezone(IST).strftime("%Y-%m-%d %H:%M IST")


def buglog_line(e, now):
    d = "" if e.get("duration_s") is None else " after %dm" % ((e["duration_s"] + 30) // 60)     # rounded to the nearest minute
    tag = {"NEW": "NEW", "RESOLVED": "RESOLVED", "REMIND": "STILL", "W21": "W21-CANDIDATE"}[e["type"]]
    return "%s | %s | %s | %s | %s%s" % (fmt_local(now.isoformat()), tag, e["room"], e["code"], e["detail"], d)


def message(e):
    since = parse_iso(e["since"]).astimezone(IST).strftime("%H:%M")
    return "NF| fleet-watch %s: %s %s (%s) since %s IST" % (e["type"], e["room"], e["code"], e["detail"][:90], since)


# ---------------------------------------------------------------- sinks (injectable; real ones are ssh-stdin to the Mini, hsend to conductor)
class Sinks:
    def __init__(self, cfg, dry=False):
        self.cfg, self.dry = cfg, dry
        self.spool = os.path.join(RT, "spool"); os.makedirs(self.spool, exist_ok=True)

    def _mini(self, fname, text, mode="a"):
        if self.dry:      # --dry: nothing leaves the box; files land under RT/dry/
            os.makedirs(os.path.join(RT, "dry"), exist_ok=True); open(os.path.join(RT, "dry", fname), mode).write(text); return True
        m = self.cfg["mini"]; path = "%s/%s" % (m["dir"], fname)
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", m["host"],
               ("mkdir -p '%s' && cat >> '%s'" % (m["dir"], path)) if mode == "a" else ("mkdir -p '%s' && cat > '%s.tmp' && mv '%s.tmp' '%s'" % (m["dir"], path, path, path))]   # 'w' is atomic (temp + rename): minibot reads the heartbeat
        try:
            subprocess.run(cmd, input=text.encode(), check=True, timeout=40, capture_output=True); return True
        except Exception:
            open(os.path.join(self.spool, "%d_%s_%s" % (time.time() * 1000, mode, fname)), "w").write(text); return False

    def flush_spool(self):
        for f in sorted(os.listdir(self.spool)):
            _, mode, fname = f.split("_", 2); p = os.path.join(self.spool, f)
            if self._mini(fname, open(p).read(), mode):
                os.remove(p)
            else:
                break

    def buglog(self, line): self._mini("BUGLOG.md", line + "\n")
    def jsonl(self, obj): self._mini("fleet-watch.jsonl", json.dumps(obj, separators=(",", ":")) + "\n")
    def heartbeat(self, obj): self._mini("heartbeat", json.dumps(obj) + "\n", "w")

    def notify(self, msg):
        if self.dry:
            os.makedirs(os.path.join(RT, "dry"), exist_ok=True); open(os.path.join(RT, "dry", "notify.log"), "a").write(msg + "\n"); return
        open(os.path.join(RT, "notify.log"), "a").write(msg + "\n")     # local copy of what conductor was sent (the pane tails it)
        subprocess.run(["/bin/zsh", self.cfg["hsend"], msg, "conductor"], timeout=40, capture_output=True)


# ---------------------------------------------------------------- model layer (gathers + explains; never decides)
def cost_today(now):
    p = os.path.join(RT, "cost.jsonl"); day = now.astimezone(IST).strftime("%Y-%m-%d"); t = 0.0
    if os.path.exists(p):
        for l in open(p):
            j = json.loads(l); t += j["cost"] if j.get("day") == day else 0
    return t


def run_model(cfg, name=None, variant=None):
    """One `opencode run` (stdin closed: it hangs otherwise). Returns {ok, json, cost, tokens, seconds, error}."""
    m = cfg["model"]; name = name or m["name"]; variant = m["variant"] if variant is None else variant
    cmd = [os.path.expanduser("~/.local/bin/opencode"), "run", "--agent", "fleet-watch", "-m", "opencode/" + name, "--format", "json", "--dir", RT] + (["--variant", variant] if variant else []) + ["Run one watch cycle now."]
    env = dict(os.environ, OPENCODE_CONFIG=os.path.join(RT, "opencode.jsonc")); t0 = time.time()
    try:
        p = subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=m["timeout_s"])
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout", "cost": 0.0, "seconds": time.time() - t0}
    return parse_model_output(p.stdout, time.time() - t0)


def parse_model_output(stdout, seconds=0.0):
    text, cost, tok, tools, err = [], 0.0, {}, [], None
    for l in stdout.splitlines():
        if not l.startswith("{"):
            continue
        try:
            e = json.loads(l)
        except Exception:
            continue
        t, part = e.get("type"), e.get("part", {})
        if t == "text": text.append(part.get("text", ""))
        if t == "tool_use": tools.append(part.get("tool"))
        if t in ("step_finish", "step-finish"):
            cost += part.get("cost", 0) or 0
            k = part.get("tokens", {}); tok = {a: tok.get(a, 0) + k.get(a, 0) for a in ("input", "output", "reasoning")}
        if t == "error": err = (e.get("error", {}).get("data", {}) or {}).get("message", "error")[:120]
    s = "".join(text)
    try:
        j = json.loads(s[s.index("{"):s.rindex("}") + 1])
        assert isinstance(j, dict) and isinstance(j.get("rooms"), list)
        return {"ok": True, "json": j, "cost": cost, "tokens": tok, "tools": tools, "seconds": seconds}
    except Exception:
        return {"ok": False, "error": err or "non-JSON answer", "cost": cost, "tokens": tok, "tools": tools, "seconds": seconds}


def agreement(model_json, snap):
    """Strict: the same rooms, and per room the same recording flag and state as the deterministic snapshot. -> (bool, [mismatch strings])"""
    det = {r["room"]["name"]: (bool(r.get("recording")), r.get("room_state", {}).get("state")) for r in snap["now"].get("rooms", [])}
    got = {x.get("room"): (x.get("recording"), x.get("state")) for x in model_json.get("rooms", [])}
    bad = [("room set differs: %s" % sorted(set(det) ^ set(got)))] if set(det) != set(got) else []
    bad += ["%s: model %s vs det %s" % (k, got[k], det[k]) for k in det if k in got and got[k] != det[k]]
    return (not bad), bad


# ---------------------------------------------------------------- one cycle
def run_cycle(call, cfg, sinks, now, state, use_model=True, snap=None, label="", heartbeat=True):
    """-> (new_state, record). The record is the jsonl line (room/state/timings only)."""
    rec = {"ts": now.isoformat(), "mode": "deterministic", "watcher_fault": None}
    try:
        snap = snap or collect(call, now, state, cfg)
    except Exception as ex:
        rec["watcher_fault"] = "door: %s" % type(ex).__name__
        sinks.jsonl(rec)
        if heartbeat:
            sinks.heartbeat({"ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": False, "fault": rec["watcher_fault"]})
        return state, rec
    issues, devices, finfo = decide(snap, cfg, now, state.get("devices"))
    st, events = advance(state, issues, now, cfg); st["devices"] = devices
    if use_model and cost_today(now) < cfg["budget_usd_per_day"]:
        mr = run_model(cfg); used = cfg["model"]["name"]; spent = mr.get("cost", 0) or 0
        if not mr["ok"] and cfg["model"].get("fallback"):        # the primary failed (403, timeout, non-JSON): one retry on the fallback model
            mr2 = run_model(cfg, cfg["model"]["fallback"], cfg["model"].get("fallback_variant", "")); spent += mr2.get("cost", 0) or 0
            if mr2["ok"]:
                mr, used = mr2, cfg["model"]["fallback"]
        rec.update(mode="model+deterministic", model=used, cost=round(spent, 5), model_seconds=round(mr.get("seconds", 0), 1))
        with open(os.path.join(RT, "cost.jsonl"), "a") as f:
            f.write(json.dumps({"day": now.astimezone(IST).strftime("%Y-%m-%d"), "ts": now.isoformat(), "cost": spent}) + "\n")
        if mr["ok"]:
            rec["agrees"], rec["disagreements"] = agreement(mr["json"], snap)
        else:
            rec["watcher_fault"] = "model: %s" % mr.get("error")          # a watcher fault, not a room fault
    elif use_model:
        rec["mode"] = "deterministic-only (daily budget reached)"
        if not st.get("budget_told") == now.astimezone(IST).strftime("%Y-%m-%d"):
            sinks.notify("NF| fleet-watch: Zen budget $%.2f/day reached, deterministic-only until midnight IST" % cfg["budget_usd_per_day"]); st["budget_told"] = now.astimezone(IST).strftime("%Y-%m-%d")
    rec["rooms"] = [{"room": r["room"]["name"], "id": r["room"]["id"], "state": r.get("room_state", {}).get("state"), "recording": bool(r.get("recording")),
                     "last_piece_age_s": None if age_s(r.get("last_piece_at"), now) is None else int(age_s(r.get("last_piece_at"), now)),
                     "issues": [i["code"] + ("" if i["severity"] == "PROBLEM" else "(info)") for i in issues.get(r["room"]["name"], [])]} for r in snap["now"].get("rooms", [])]
    rec["fleet_info"] = finfo; rec["events"] = [e["type"] + ":" + e["room"] + ":" + e["code"] for e in events]
    for e in events:
        line = buglog_line(e, now) + (" %s" % label if label else "")
        sinks.buglog(line)
        sinks.notify(message(e) + (" %s" % label if label else ""))
    if label:
        rec["replay"] = label          # a replayed snapshot is marked in the jsonl
    sinks.jsonl(rec)
    if heartbeat:                      # a replay must NEVER touch the heartbeat: its old timestamp would trip minibot's STALE alert
        sinks.heartbeat({"ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": rec["watcher_fault"] is None, "fault": rec["watcher_fault"], "mode": rec["mode"]})
    return st, rec


def select_models(call, cfg, n, gap_s, candidates):
    """r399 item 3: run each candidate for n cycles against the live door, compare with the deterministic snapshot taken just before, record measured cost. -> list of per-cycle rows."""
    rows = []; out = open(os.path.join(RT, "model-selection.jsonl"), "a")
    for i in range(n):
        now = dt.datetime.now(dt.timezone.utc); snap = collect(call, now, {}, cfg)
        for name, variant in candidates:
            mr = run_model(cfg, name, variant); row = {"cycle": i + 1, "ts": now.isoformat(), "model": name, "variant": variant, "ok": mr["ok"], "cost": round(mr.get("cost", 0), 5), "seconds": round(mr.get("seconds", 0), 1), "tools": mr.get("tools")}
            if mr["ok"]:
                row["agrees"], row["disagreements"] = agreement(mr["json"], snap)
            else:
                row["error"] = mr.get("error")
            rows.append(row); out.write(json.dumps(row) + "\n"); out.flush(); print(json.dumps(row), flush=True)
        time.sleep(gap_s)
    return rows


def shift_snapshot(snap, delta):
    """--at: move every timestamp of a replayed snapshot by delta (a timedelta) so the snapshot stays consistent with the overridden clock."""
    iso_keys = {"ts", "now", "last_piece_at", "last_seen_at", "last_poll_at", "started_at", "ended_at", "last_chunk_at", "last_any_chunk_at", "checked_at"}
    def walk(o):
        if isinstance(o, dict):
            for k, v in list(o.items()):
                if k in iso_keys and isinstance(v, str) and v[:2] == "20":
                    try:
                        o[k] = (parse_iso(v) + delta).isoformat()
                    except ValueError:
                        pass
                elif k == "t_ms" and isinstance(v, (int, float)):
                    o[k] = v + delta.total_seconds() * 1000
                else:
                    walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    walk(snap)
    return snap


def load_state(path):
    return json.load(open(path)) if os.path.exists(path) else {}


def save_state(path, st):
    tmp = path + ".tmp"; json.dump(st, open(tmp, "w")); os.replace(tmp, path)


def live_mode_ok(rt=None):
    """Real sinks (the Mini bug log, conductor) only when THIS run home's MODE file says 'live'. A stray run with a scratch FLEET_WATCH_HOME (no MODE file) or a dry home can never reach production."""
    try:
        return open(os.path.join(rt or RT, "MODE")).read().strip() == "live"
    except OSError:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true"); ap.add_argument("--loop", action="store_true"); ap.add_argument("--no-model", action="store_true")
    ap.add_argument("--dry", action="store_true"); ap.add_argument("--select", type=int); ap.add_argument("--gap", type=int, default=45); ap.add_argument("--replay"); ap.add_argument("--at"); ap.add_argument("--inject"); ap.add_argument("--state"); ap.add_argument("--config"); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        import test_fleet_watch; return test_fleet_watch.main()
    if not a.dry and not a.select and not live_mode_ok():
        print("fleet-watch: REFUSED: real sinks need MODE=live in %s (add --dry, or flip MODE after the refuter's PASS)" % RT, file=sys.stderr); return 4
    os.makedirs(RT, exist_ok=True); cfg = load_cfg(a.config)
    sys.path.insert(0, os.path.join(HERE, "..", "..", "kit"))
    if a.replay:   # replayed snapshot, optional injected fault, REAL sinks, its own state file (so real state is untouched)
        snap = json.load(open(a.replay)); label = "[REPLAY]"    # a replay is never a real event: its lines are always marked
        if a.inject:
            room, code = a.inject.split(":"); label = "[INJECTED TEST]"
            for r in snap["now"]["rooms"]:
                if r["room"]["name"] == room:
                    if code == "NOT_RECORDING": r["recording"] = False; r["room_state"]["state"] = "ready"
                    if code == "PIECES_STALLED": r["last_piece_at"] = "2000-01-01T00:00:00Z"
        sp = a.state or os.path.join(RT, "state.replay.json"); now = parse_iso(a.at or snap["ts"])   # --at overrides the clock (e.g. +12 min for the RESOLVED line)
        if a.at:
            snap = shift_snapshot(snap, now - parse_iso(snap["ts"]))
        st, rec = run_cycle(None, cfg, Sinks(cfg, dry=a.dry), now, load_state(sp), use_model=False, snap=snap, label=label, heartbeat=False); save_state(sp, st); print(json.dumps(rec["events"])); return 0
    import clip_fetch_mcp
    if a.select:
        m = cfg["model"]; select_models(clip_fetch_mcp.call, cfg, a.select, a.gap, [(m["name"], m["variant"]), (m["fallback"], m["fallback_variant"])]); return 0
    lock = open(os.path.join(RT, "lock"), "w")      # only the live loop takes the lock: replay and the model benchmark never touch live state
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("fleet-watch: another instance holds the lock"); return 3
    sp = a.state or os.path.join(RT, "state.dry.json" if a.dry else "state.json"); sinks = Sinks(cfg, dry=a.dry)
    while True:
        now = dt.datetime.now(dt.timezone.utc); sinks.flush_spool()
        cfg = load_cfg(a.config); sinks.cfg = cfg          # config.json is re-read EVERY cycle: a budget/known/clinic change takes effect within 5 minutes, no restart
        st, rec = run_cycle(clip_fetch_mcp.call, cfg, sinks, now, load_state(sp), use_model=not a.no_model); save_state(sp, st)
        print("%s %s events=%d fault=%s cost=%s" % (fmt_local(now.isoformat()), rec["mode"], len(rec.get("events", [])), rec["watcher_fault"], rec.get("cost")), flush=True)
        if not a.loop:
            return 0
        time.sleep(max(1, cfg["interval_s"] - (dt.datetime.now(dt.timezone.utc) - now).total_seconds()))


if __name__ == "__main__":
    sys.exit(main())
