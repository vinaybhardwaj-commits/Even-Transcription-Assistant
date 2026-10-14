#!/usr/bin/env python3
"""zen_meter.py — Zen spend meter + credit ledger (Fable rulings 407, 407a, 407b, W25 P0).

What it measures: OpenCode's own per-message record of every model call that went to Zen (provider "opencode"): time, model, agent, cost, token counts, and the session's directory.
It reads ONLY those fields from the `message` and `session` tables of each host's OpenCode database (read-only). It never selects prompts, replies, parts, titles, or the account/credential tables,
so nothing here can hold text, patient identity or a key.
COST IS COMPUTED, NOT BILLED: Zen replies carry token counts only (no cost field, no cost header; measured 25 Sep). OpenCode multiplies tokens by its catalogue price. The only ground truth is the Zen
console balance, so the ledger takes `checkpoints` (a balance someone read from the console at a time) and re-bases from the latest one.
Per pane: pane = the OpenCode agent name when it is not a default agent; else the session directory matched against `pane_map`; else "dir:<basename>". Panes should run `--agent <pane>-oc`.
Modes: --once | --loop | --emit (local aggregate JSON, used over ssh) | --topup USD | --checkpoint USD | --selftest. The price table is zen_prices.py. Runtime dir: $ZEN_METER_HOME (default ~/zen-meter).
Real sinks (the Mini report, conductor) need MODE=live in the run home and, outside --loop, the loop's lock to be free; everything else is dry (files under RT/dry/).
"""
import argparse, collections, datetime as dt, fcntl, json, os, sqlite3, subprocess, sys, time

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
RT = os.environ.get("ZEN_METER_HOME", os.path.expanduser("~/zen-meter"))
DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
DEFAULT_CFG = {
    "hosts": [{"name": "box", "local": True}, {"name": "mini", "ssh": "mini"}, {"name": "air", "ssh": "air"}, {"name": "yoga", "ssh": "ubuntuyoga"}],
    "pane_map": {"/home/eta/fleet-watch": "fleet-watch", "/home/eta/dev/eta-lab": "linker-oc", "/tmp/": "scratch"},   # longest prefix wins; only used for the default agents
    "default_agents": ["build", "plan", "general", "explore"],
    "provider": "opencode",            # Zen. Other providers (openrouter) are reported separately and never touch the Zen ledger
    "daily_cap_usd": None, "cap_alert_frac": 0.8,      # r407b: no fixed cap; the 80% alert exists for when V sets one
    "low_usd": 10.0, "low_runway_h": 24.0, "burn_window_h": 3.0, "remind_h": 6.0, "interval_s": 600,
    "mini": {"host": "mini", "dir": "/Users/vinaybhardwaj/dev/zen-meter"},
    "hsend": os.path.expanduser("~/dev/eta-lab/kit/hsend.sh"),
}
DEFAULT_LEDGER = {"start": {"ts": "2026-09-24T18:30:00Z", "usd": 50.0, "note": "prepaid credit at 25 Sep 00:00 IST (r407)"}, "topups": [], "checkpoints": []}

# The ONLY query that ever touches an OpenCode database. Assistant messages carry no text; the tables account/credential/part/session_input are never named.
SQL = ("SELECT m.time_created, json_extract(m.data,'$.providerID'), json_extract(m.data,'$.modelID'), json_extract(m.data,'$.agent'), COALESCE(json_extract(m.data,'$.cost'),0), "
       "COALESCE(json_extract(m.data,'$.tokens.input'),0), COALESCE(json_extract(m.data,'$.tokens.output'),0), COALESCE(json_extract(m.data,'$.tokens.reasoning'),0), "
       "COALESCE(json_extract(m.data,'$.tokens.cache.read'),0), COALESCE(json_extract(m.data,'$.tokens.cache.write'),0), s.directory "
       "FROM message m JOIN session s ON s.id = m.session_id WHERE json_extract(m.data,'$.role') = 'assistant' AND m.time_created >= ?")


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def load_json(path, default):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return json.loads(json.dumps(default))


# ---------------------------------------------------------------- collection
def collect_local(db=None, since_ms=0):
    """-> rows [{t (ms, minute), provider, model, agent, dir, cost, in, out, reason, cr, cw, n}], summed per minute/provider/model/agent/dir."""
    con = sqlite3.connect("file:%s?mode=ro" % (db or DB), uri=True, timeout=10)
    try:
        acc = collections.OrderedDict()
        for t, prov, model, agent, cost, i, o, r, cr, cw, d in con.execute(SQL, (int(since_ms),)):
            k = (int(t) // 60000 * 60000, prov or "?", model or "?", agent or "?", d or "?")
            a = acc.setdefault(k, [0.0, 0, 0, 0, 0, 0, 0])
            a[0] += float(cost or 0); a[1] += int(i or 0); a[2] += int(o or 0); a[3] += int(r or 0); a[4] += int(cr or 0); a[5] += int(cw or 0); a[6] += 1
    finally:
        con.close()
    return [{"t": k[0], "provider": k[1], "model": k[2], "agent": k[3], "dir": k[4], "cost": v[0], "in": v[1], "out": v[2], "reason": v[3], "cr": v[4], "cw": v[5], "n": v[6]} for k, v in acc.items()]


def collect_remote(target, since_ms, timeout=90):
    """Run this same file on another host over ssh (program on stdin, read-only) and return its rows. Raises on any failure; the caller reports the host as NOT MEASURED."""
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, "python3", "-", "--emit", "--since", str(int(since_ms))],
                       input=open(os.path.abspath(__file__), "rb").read(), capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError("ssh/emit exit %d" % p.returncode)
    return json.loads(p.stdout)["rows"]


def gather(cfg, since_ms, local=None, remote=None):
    """-> (rows with a 'host' key, {host: 'ok' | 'NOT MEASURED: reason'}). A host that fails never makes the totals look complete."""
    local, remote = local or collect_local, remote or collect_remote
    rows, status = [], {}
    for h in cfg["hosts"]:
        try:
            got = local(None, since_ms) if h.get("local") else remote(h["ssh"], since_ms)
            for r in got:
                r = dict(r); r["host"] = h["name"]; rows.append(r)
            status[h["name"]] = "ok"
        except Exception as ex:
            status[h["name"]] = "NOT MEASURED: %s" % type(ex).__name__
    return rows, status


# ---------------------------------------------------------------- attribution and aggregation
def pane_of(host, agent, directory, cfg):
    if agent and agent not in cfg["default_agents"] and agent != "?":
        p = agent
    else:
        best = ""
        for pre in cfg["pane_map"]:
            if directory.startswith(pre) and len(pre) > len(best):
                best = pre
        p = cfg["pane_map"][best] if best else "dir:" + (os.path.basename(directory.rstrip("/")) or directory)
    return "%s:%s" % (host, p)


def hour_key(t_ms):
    return dt.datetime.fromtimestamp(t_ms / 1000, IST).strftime("%Y-%m-%d %H:00")


def day_key(t_ms):
    return dt.datetime.fromtimestamp(t_ms / 1000, IST).strftime("%Y-%m-%d")


def aggregate(rows, cfg):
    """Zen rows only -> per_pane_hour {(pane, 'YYYY-MM-DD HH:00'): $}, per_day {day: $}, per_model {model: $}, per_pane_day {(pane, day): $}. Other providers go to `other`."""
    pph, pd, pm, ppd, other = collections.defaultdict(float), collections.defaultdict(float), collections.defaultdict(float), collections.defaultdict(float), collections.defaultdict(float)
    for r in rows:
        if r["provider"] != cfg["provider"]:
            other[r["provider"]] += r["cost"]; continue
        pane = pane_of(r["host"], r["agent"], r["dir"], cfg)
        pph[(pane, hour_key(r["t"]))] += r["cost"]; pd[day_key(r["t"])] += r["cost"]; pm[r["model"]] += r["cost"]; ppd[(pane, day_key(r["t"]))] += r["cost"]
    return {"per_pane_hour": dict(pph), "per_day": dict(pd), "per_model": dict(pm), "per_pane_day": dict(ppd), "other": dict(other)}


# ---------------------------------------------------------------- ledger
def ledger_state(ledger, rows, cfg, now):
    """remaining = latest base (start or checkpoint) + top-ups after it - computed Zen spend after it. burn/h = spend in the trailing window / window."""
    base_ts, base_usd, base_kind = parse_iso(ledger["start"]["ts"]), float(ledger["start"]["usd"]), "start"
    for c in ledger.get("checkpoints", []):
        if parse_iso(c["ts"]) > base_ts:
            base_ts, base_usd, base_kind = parse_iso(c["ts"]), float(c["balance_usd"]), "checkpoint"
    bms = base_ts.timestamp() * 1000
    topups = sum(float(t["usd"]) for t in ledger.get("topups", []) if parse_iso(t["ts"]) > base_ts)
    zen = [r for r in rows if r["provider"] == cfg["provider"]]
    spent = sum(r["cost"] for r in zen if r["t"] >= bms)
    remaining = base_usd + topups - spent
    w = float(cfg["burn_window_h"]); wms = (now.timestamp() - w * 3600) * 1000
    burn_h = sum(r["cost"] for r in zen if r["t"] >= wms) / w
    return {"base_kind": base_kind, "base_ts": base_ts.isoformat(), "base_usd": base_usd, "topups": topups, "spent": spent, "remaining": remaining,
            "burn_h": burn_h, "burn_day": burn_h * 24, "runway_h": (remaining / burn_h) if burn_h > 0 else None}


def is_low(m, cfg):
    return m["remaining"] < cfg["low_usd"] or (m["runway_h"] is not None and m["runway_h"] < cfg["low_runway_h"])


def is_clear(m, cfg):
    """Hysteresis: it must be clearly better than the threshold, not just across it, before ZEN CREDIT OK is sent."""
    return m["remaining"] >= cfg["low_usd"] * 1.2 and (m["runway_h"] is None or m["runway_h"] >= cfg["low_runway_h"] * 1.25)


def advance_alerts(state, m, spend_today, cfg, now, unmeasured=()):
    """Pure. -> (new_state, [messages]). LOW once on entry, a reminder every remind_h, OK once on a clear recovery; the 80% cap alert once per IST day (and once more at 100%)."""
    st = json.loads(json.dumps(state)); out = []; ts = now.isoformat()
    lo = st.get("low", {"active": False})
    tail = " | computed from OpenCode cost, the console balance is the truth (basis: %s%s)" % (m["base_kind"], (" | NOT MEASURED: " + ",".join(unmeasured)) if unmeasured else "")
    text = "NF| ZEN CREDIT LOW %.2f %.2f/day (runway %s h at the trailing %gh burn)%s" % (m["remaining"], m["burn_day"], ("%.1f" % m["runway_h"]) if m["runway_h"] is not None else "n/a", cfg["burn_window_h"], tail)
    if not lo.get("active"):
        if is_low(m, cfg):
            st["low"] = {"active": True, "since": ts, "last_sent": ts}; out.append(text)
    else:
        if is_clear(m, cfg):
            st["low"] = {"active": False}; out.append("NF| ZEN CREDIT OK %.2f remaining, %.2f/day (runway %s h)" % (m["remaining"], m["burn_day"], ("%.1f" % m["runway_h"]) if m["runway_h"] is not None else "n/a"))
        elif (now - parse_iso(lo["last_sent"])).total_seconds() >= cfg["remind_h"] * 3600:
            st["low"]["last_sent"] = ts; out.append(text.replace("LOW ", "LOW (reminder) ", 1))
    cap = cfg.get("daily_cap_usd")
    if cap:
        day = now.astimezone(IST).strftime("%Y-%m-%d"); c = st.get("cap", {})
        if c.get("day") != day:
            c = {"day": day, "s80": False, "s100": False}
        if spend_today >= cap and not c["s100"]:
            c["s100"] = True; c["s80"] = True; out.append("NF| ZEN DAILY CAP REACHED %.2f of %.2f today (IST, computed)" % (spend_today, cap))
        elif spend_today >= cap * cfg["cap_alert_frac"] and not c["s80"]:
            c["s80"] = True; out.append("NF| ZEN DAILY CAP %d%% %.2f of %.2f today (IST, computed)" % (round(cfg["cap_alert_frac"] * 100), spend_today, cap))
        st["cap"] = c
    return st, out


# ---------------------------------------------------------------- report
def render(now, agg, m, status, cfg, hours=8):
    """Markdown. Money only: pane names, model ids, hosts, hours. No text of any kind."""
    hrs = [(now - dt.timedelta(hours=i)).astimezone(IST).strftime("%Y-%m-%d %H:00") for i in range(hours - 1, -1, -1)]
    today = now.astimezone(IST).strftime("%Y-%m-%d")
    L = ["# Zen spend meter (computed from OpenCode cost x Zen token counts; the console balance is the truth)", "",
         "Generated %s IST. Provider counted: `%s` (Zen). Hosts: %s." % (now.astimezone(IST).strftime("%Y-%m-%d %H:%M"), cfg["provider"], ", ".join("%s=%s" % kv for kv in status.items())), "",
         "## Credit ledger", "",
         "| base (%s) | top-ups since | computed spend since | **remaining** | burn/h (trailing %gh) | burn/day | runway |" % (m["base_kind"], cfg["burn_window_h"]), "|---|---|---|---|---|---|---|",
         "| $%.2f at %s | $%.2f | $%.2f | **$%.2f** | $%.3f | $%.2f | %s |" % (m["base_usd"], m["base_ts"][:16].replace("T", " ") + "Z", m["topups"], m["spent"], m["remaining"], m["burn_h"], m["burn_day"], ("%.1f h" % m["runway_h"]) if m["runway_h"] is not None else "n/a"), "",
         "Alert rule: remaining < $%g OR runway < %g h -> `ZEN CREDIT LOW <remaining> <burn/day>` to Fable via conductor." % (cfg["low_usd"], cfg["low_runway_h"]), "",
         "## Per pane per hour ($, IST hour starting)", ""]
    panes = sorted({p for p, _ in agg["per_pane_hour"]}, key=lambda p: -sum(v for (q, _), v in agg["per_pane_hour"].items() if q == p))
    L += ["| pane | " + " | ".join(h[5:] for h in hrs) + " | today |", "|---|" + "---|" * (len(hrs) + 1)]
    for p in panes:
        L.append("| %s | " % p + " | ".join(("%.3f" % agg["per_pane_hour"][(p, h)]) if (p, h) in agg["per_pane_hour"] else "" for h in hrs) + " | **%.3f** |" % agg["per_pane_day"].get((p, today), 0.0))
    L += ["", "## Daily total ($, IST day)", "", "| day | total |", "|---|---|"] + ["| %s | %.3f |" % (d, v) for d, v in sorted(agg["per_day"].items())]
    if cfg.get("daily_cap_usd"):
        L += ["", "Daily cap $%.2f: today $%.2f (%.0f%%)." % (cfg["daily_cap_usd"], agg["per_day"].get(today, 0.0), 100 * agg["per_day"].get(today, 0.0) / cfg["daily_cap_usd"])]
    L += ["", "## By model ($, all time in the window)", "", "| model | total |", "|---|---|"] + ["| %s | %.3f |" % (k, v) for k, v in sorted(agg["per_model"].items(), key=lambda kv: -kv[1])]
    if agg["other"]:
        L += ["", "Not Zen (not in the ledger): " + ", ".join("%s $%.3f" % kv for kv in sorted(agg["other"].items()))]
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- sinks
class Sinks:
    def __init__(self, cfg, dry):
        self.cfg, self.dry = cfg, dry
        os.makedirs(os.path.join(RT, "dry"), exist_ok=True)

    def report(self, fname, text):
        open(os.path.join(RT, "dry" if self.dry else "", fname), "w").write(text)      # local copy always; the Mini copy only when live
        if self.dry:
            return True
        m = self.cfg["mini"]; path = "%s/%s" % (m["dir"], fname)
        try:
            subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", m["host"], "mkdir -p '%s' && cat > '%s.tmp' && mv '%s.tmp' '%s'" % (m["dir"], path, path, path)],
                           input=text.encode(), check=True, timeout=40, capture_output=True); return True
        except Exception:
            return False

    def jsonl(self, obj):
        open(os.path.join(RT, "dry" if self.dry else "", "zen-meter.jsonl"), "a").write(json.dumps(obj) + "\n")

    def notify(self, msg):
        if self.dry:
            open(os.path.join(RT, "dry", "notify.log"), "a").write(msg + "\n"); return
        open(os.path.join(RT, "notify.log"), "a").write(msg + "\n")
        subprocess.run(["/bin/zsh", self.cfg["hsend"], msg, "conductor"], timeout=40, capture_output=True)


def live_mode_ok(rt=None):
    try:
        return open(os.path.join(rt or RT, "MODE")).read().strip() == "live"
    except OSError:
        return False


def run_cycle(cfg, sinks, now, state, ledger, local=None, remote=None):
    since = parse_iso(ledger["start"]["ts"]).timestamp() * 1000      # nothing before the ledger start is counted or shown
    rows, status = gather(cfg, since, local, remote)
    agg = aggregate(rows, cfg); m = ledger_state(ledger, rows, cfg, now)
    today = now.astimezone(IST).strftime("%Y-%m-%d")
    unmeasured = [h for h, s in status.items() if s != "ok"]
    state, msgs = advance_alerts(state, m, agg["per_day"].get(today, 0.0), cfg, now, unmeasured)
    sinks.report("ZEN-SPEND.md", render(now, agg, m, status, cfg))
    sinks.jsonl({"ts": now.isoformat(), "remaining": round(m["remaining"], 4), "spent": round(m["spent"], 4), "burn_h": round(m["burn_h"], 5), "today": round(agg["per_day"].get(today, 0.0), 4), "hosts": status, "alerts": len(msgs)})
    for x in msgs:
        sinks.notify(x)
    return state, m, msgs


def main(argv=None):
    ap = argparse.ArgumentParser()
    for f in ("--once", "--loop", "--emit", "--dry", "--selftest"):
        ap.add_argument(f, action="store_true")
    ap.add_argument("--since", type=int, default=0); ap.add_argument("--topup", type=float); ap.add_argument("--checkpoint", type=float); ap.add_argument("--note", default=""); ap.add_argument("--config")
    a = ap.parse_args(argv)
    if a.selftest:
        import test_zen_meter; return test_zen_meter.main()
    if a.emit:
        print(json.dumps({"rows": collect_local(None, a.since)})); return 0
    os.makedirs(RT, exist_ok=True)
    cfg = json.loads(json.dumps(DEFAULT_CFG)); cfg.update(load_json(a.config or os.path.join(RT, "config.json"), {}))
    lp = os.path.join(RT, "ledger.json"); ledger = load_json(lp, DEFAULT_LEDGER)
    if a.topup is not None or a.checkpoint is not None:      # append-only history: a correction is a new entry, never an edit
        e = {"ts": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "note": a.note}
        if a.topup is not None:
            ledger["topups"].append(dict(e, usd=a.topup))
        if a.checkpoint is not None:
            ledger["checkpoints"].append(dict(e, balance_usd=a.checkpoint))
        json.dump(ledger, open(lp, "w"), indent=1); print("ledger updated"); return 0
    if not a.dry and not live_mode_ok():
        print("zen-meter: REFUSED: real sinks need MODE=live in %s (add --dry)" % RT, file=sys.stderr); return 4
    if not a.dry:      # real sinks: one writer at a time, so a one-off run can never race the live loop
        lock = open(os.path.join(RT, "lock"), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("zen-meter: another instance holds the lock"); return 3
    sp = os.path.join(RT, "state.dry.json" if a.dry else "state.json"); sinks = Sinks(cfg, a.dry)
    while True:
        now = dt.datetime.now(dt.timezone.utc)
        cfg.update(load_json(a.config or os.path.join(RT, "config.json"), {})); ledger = load_json(lp, DEFAULT_LEDGER)
        st, m, msgs = run_cycle(cfg, sinks, now, load_json(sp, {}), ledger); json.dump(st, open(sp, "w"))
        print("%s remaining=%.2f burn/h=%.3f alerts=%d" % (now.astimezone(IST).strftime("%Y-%m-%d %H:%M IST"), m["remaining"], m["burn_h"], len(msgs)), flush=True)
        if not a.loop:
            return 0
        time.sleep(cfg["interval_s"])


if __name__ == "__main__":
    sys.exit(main())
