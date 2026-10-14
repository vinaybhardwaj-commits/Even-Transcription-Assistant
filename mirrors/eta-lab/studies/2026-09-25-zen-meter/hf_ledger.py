#!/usr/bin/env python3
"""hf_ledger.py — HF budget guard (Fable ruling 413.3). Every $ figure is COMPUTED from posted estimates/actuals, never read from HF (the probe prints OK/402 only).

Baseline: $100 put on HF by V ~20:00 IST 25 Sep (r413). Jobs (diar-lab 337e, lab-mover PARITY-389, hist-bulk routers) post an estimate BEFORE starting and an actual AFTER (r413.2);
fleet records each post here. remaining = baseline + topups - actuals (per-job ACTUALS ADD; signed `correct` events adjust) - open estimates. Alerts: LOW at $30 left (once, remind every remind_h, OK on recovery above 1.2x); GATE at $15 left
(no new HF job may start without a Fable order; cleared ONLY by --ungate on Fable's named order, which appends a note). A mismatch between a posted estimate and hours x flavor_rate above est_check_frac is a NOTE, never an auto-correction.
Ledger is append-only (a correction is a new line). Runtime: $HF_LEDGER_HOME (default ~/hf-meter). Real sinks need MODE=live.
"""
import argparse, datetime as dt, json, os, sys

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
RT = os.environ.get("HF_LEDGER_HOME", os.path.expanduser("~/hf-meter"))
DEFAULT_CFG = {
    "baseline": {"ts": "2026-09-25T14:30:00Z", "usd": 100.0, "note": "V put $100 on HF (r413)"},
    "flavor_usd_h": {"a10g-large": 1.00, "a100-large": 2.50, "h200-large": 5.00, "l4-large": 0.80, "cpu-basic": 0.0},   # r378 rates; cross-check only
    "low_usd": 30.0, "gate_usd": 15.0, "remind_h": 6.0, "est_check_frac": 0.10,
    "hsend": os.path.expanduser("~/dev/eta-lab/kit/hsend.sh"),
    "mini": {"host": "mini", "dir": "/Users/vinaybhardwaj/dev/hf-meter"},
}


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def load_json(path, default):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return json.loads(json.dumps(default))


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------- ledger math (pure)
def ledger_state(events, cfg, now):
    """events: [{ts, type: topup|estimate|actual|correct|note, job, usd, flavor?, hours?, owner?, note?}] -> metrics. An estimate is committed spend until the job's FIRST actual closes it; MULTIPLE actuals for one job ADD (per-batch reporting, diar-lab); `correct` is a signed adjustment to spend."""
    base = cfg["baseline"]
    top = sum(e["usd"] for e in events if e["type"] == "topup")
    ests = {}; closed = {}; spent = 0.0
    for e in events:
        if e["type"] == "estimate": ests[e["job"]] = e
        elif e["type"] == "actual":
            ests.pop(e["job"], None); closed[e["job"]] = closed.get(e["job"], 0.0) + e["usd"]; spent += e["usd"]      # additive: a second actual never REPLACES the first (refuter-2 #2792)
        elif e["type"] == "correct":
            spent += e["usd"]                                                                                        # signed; may be negative; never touches estimates
    committed = sum(e["usd"] for e in ests.values())
    remaining = float(base["usd"]) + top - spent - committed
    open_notes = []
    for e in events:
        if e["type"] != "estimate": continue
        rate = cfg["flavor_usd_h"].get(e.get("flavor"))
        if rate and e.get("hours"):
            implied = rate * e["hours"]
            if implied > 0 and abs(e["usd"] - implied) / implied > cfg["est_check_frac"]:
                open_notes.append("%s: posted $%.2f vs hours x rate $%.2f (%s)" % (e["job"], e["usd"], implied, e.get("flavor")))
    return {"baseline": float(base["usd"]), "topups": top, "spent": spent, "committed": committed, "remaining": remaining,
            "open": sorted(ests), "closed": sorted(closed), "est_notes": open_notes}


def advance_alerts(state, m, cfg, now):
    """Pure. -> (new_state, [messages]). LOW once on entry, remind after remind_h, OK on recovery above 1.2x low; GATE once on entry at <= gate_usd."""
    st = json.loads(json.dumps(state or {})); ts = now.isoformat(); out = []
    lo = st.get("low")
    if m["remaining"] <= cfg["low_usd"]:
        text = "NF| HF CREDIT LOW $%.2f left (baseline+topups-$%.2f spent-$%.2f committed, COMPUTED)" % (m["remaining"], m["spent"], m["committed"])
        if lo is None:
            st["low"] = {"last_sent": ts}; out.append(text)
        elif (now - parse_iso(lo["last_sent"])).total_seconds() >= cfg["remind_h"] * 3600:
            st["low"]["last_sent"] = ts; out.append(text.replace("LOW ", "LOW (reminder) ", 1))
    elif lo is not None and m["remaining"] >= cfg["low_usd"] * 1.2:
        st["low"] = None; out.append("HF CREDIT OK $%.2f left (recovered above $%.0f x 1.2)" % (m["remaining"], cfg["low_usd"]))
    if m["remaining"] <= cfg["gate_usd"] and not st.get("gated"):
        st["gated"] = {"since": ts}; out.append("HF GATE $%.2f left <= $%g: NO new HF job may start without a Fable order (r413.3)" % (m["remaining"], cfg["gate_usd"]))
    for n in m["est_notes"]:
        k = "note:" + n
        if not st.get(k):
            st[k] = {"since": ts}; out.append("NF| HF estimate mismatch -> conductor -> Fable: %s (mark, never auto-correct)" % n)
    return st, out


def render(now, m, cfg):
    L = ["# HF budget guard (r413.3) — COMPUTED from posted estimates/actuals; not read from HF",
         "as of %s" % now.astimezone(IST).strftime("%Y-%m-%d %H:%M IST"), "",
          "| baseline | topups | spent (actuals + corrections) | committed (open estimates) | **remaining** |", "|---|---|---|---|---|",
         "| $%.2f | $%.2f | $%.2f | $%.2f | **$%.2f** |" % (m["baseline"], m["topups"], m["spent"], m["committed"], m["remaining"]), "",
         "open jobs: %s | closed: %s" % (", ".join(m["open"]) or "-", ", ".join(m["closed"]) or "-"),
         "Alerts: LOW <= $%g (remind %g h), GATE <= $%g (no new job without Fable)." % (cfg["low_usd"], cfg["remind_h"], cfg["gate_usd"])]
    if m["est_notes"]: L += ["", "estimate mismatches:"] + ["- %s" % n for n in m["est_notes"]]
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- sinks
def live_mode_ok():
    try:
        return open(os.path.join(RT, "MODE")).read().strip() == "live"
    except OSError:
        return False


class Sinks:
    def __init__(self, cfg, dry): self.cfg, self.dry = cfg, dry
    def report(self, text):
        if self.dry:
            os.makedirs(os.path.join(RT, "dry"), exist_ok=True); open(os.path.join(RT, "dry", "HF-SPEND.md"), "w").write(text); return
        os.makedirs(RT, exist_ok=True); open(os.path.join(RT, "HF-SPEND.md"), "w").write(text)
        mi = self.cfg["mini"]
        try:
            path = "%s/HF-SPEND.md" % mi["dir"]
            __import__("subprocess").run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", mi["host"], "mkdir -p '%s' && cat > '%s.tmp' && mv '%s.tmp' '%s'" % (mi["dir"], path, path, path)],
                                         input=text.encode(), check=True, capture_output=True, timeout=30)
        except Exception as ex:
            sys.stderr.write("mini mirror FAILED: %s\n" % type(ex).__name__)   # refuter-2 #2853: never silent; the local file and alerts stand


def hsend_log(cfg):
    return os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(cfg["hsend"]))), "scratch", "hsend.log")


def hsend_size(cfg):
    try:
        return os.path.getsize(hsend_log(cfg))
    except OSError:
        return 0


def hsend_result(cfg, target, since_pos):
    """refuter-2 #2945: the log is SHARED (the newest line may be another pane's) and its token list is not a closed set - so read ONLY bytes appended after since_pos and ALLOWLIST the single success token; anything else is a failure."""
    try:
        with open(hsend_log(cfg), "rb") as f:
            f.seek(0, 2)
            if since_pos > f.tell(): since_pos = 0                      # rotated
            f.seek(since_pos)
            tail = f.read().decode("utf-8", "replace")
        lines = [l for l in tail.splitlines() if ("-> %s :" % target) in l]
        if not lines: return "no appended hsend line for %s" % target
        return None if '"type":"agent_prompted"' in lines[-1] else "undelivered: " + lines[-1].split(" : ", 1)[-1].strip()[:48]
    except Exception as ex:
        return "hsend log unread: %s" % type(ex).__name__


def notify(cfg, msg, dry):
    if dry:
        os.makedirs(os.path.join(RT, "dry"), exist_ok=True); open(os.path.join(RT, "dry", "notify.log"), "a").write(msg + "\n"); return
    open(os.path.join(RT, "notify.log"), "a").write(msg + "\n")
    try:
        before = hsend_size(cfg)
        r = __import__("subprocess").run(["zsh", cfg["hsend"], msg, "conductor"], timeout=30, capture_output=True)
        if r.returncode != 0:
            sys.stderr.write("hsend notify FAILED: exit %d\n" % r.returncode)
        else:
            bad = hsend_result(cfg, "conductor", before)
            if bad: sys.stderr.write("hsend notify RESULT: %s\n" % bad)
    except Exception as ex:
        sys.stderr.write("hsend notify FAILED: %s\n" % type(ex).__name__)   # the file line stands; a missed nudge must still show (refuter-2 #2853)


# ---------------------------------------------------------------- events (append-only)
def append_event(ev):
    ev["ts"] = ev.get("ts") or now_utc().isoformat()
    os.makedirs(RT, exist_ok=True)
    with open(os.path.join(RT, "events.jsonl"), "a") as f:
        f.write(json.dumps(ev) + "\n")


def read_events():
    p = os.path.join(RT, "events.jsonl")
    if not os.path.exists(p): return []
    return [json.loads(l) for l in open(p) if l.strip()]


def evaluate(cfg, events, state, now, report_fn, notify_fn):
    """One cycle: compute, advance alerts, persist state, render, notify. Returns (state, metrics, alerts)."""
    m = ledger_state(events, cfg, now)
    st, alerts = advance_alerts(state, m, cfg, now)
    report_fn(render(now, m, cfg))
    for msg in alerts: notify_fn(msg)
    return st, m, alerts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--estimate", nargs=4, metavar=("JOB", "USD", "FLAVOR", "HOURS"), help="record a posted estimate: job usd flavor hours (owner via --owner)")
    ap.add_argument("--actual", nargs=2, metavar=("JOB", "USD"), help="record a posted actual (or one batch of a job's actuals): job usd — MULTIPLE actuals for one job ADD, never replace (refuter-2 #2792)")
    ap.add_argument("--correct", nargs=2, metavar=("JOB", "USD"), help="signed correction to recorded spend after an over/under-posted actual (pair it with --note); needs a Fable-visible bus post")
    ap.add_argument("--ungate", action="store_true", help="clear the sticky GATE flag — ONLY on Fable's named order (r413.3); appends a note")
    ap.add_argument("--topup", type=float, help="record an HF top-up in USD")
    ap.add_argument("--note", help="append an explanatory note event (no money effect)")
    ap.add_argument("--owner", default="?")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--config")
    a = ap.parse_args()
    if a.selftest:
        cfg = json.loads(json.dumps(DEFAULT_CFG))
        ev = [{"ts": "2026-09-25T15:00:00+00:00", "type": "estimate", "job": "j1", "usd": 68.0, "flavor": "a10g-large", "hours": 70},
              {"ts": "2026-09-25T16:00:00+00:00", "type": "actual", "job": "j1", "usd": 40.0}]
        m = ledger_state(ev, cfg, now_utc())
        assert abs(m["remaining"] - 60.0) < 1e-9, m
        st, al = advance_alerts({}, m, cfg, now_utc()); assert al == [], "60 left is neither LOW nor GATE"
        m2 = ledger_state(ev + [{"ts": "2026-09-25T17:00:00+00:00", "type": "estimate", "job": "j2", "usd": 55.0, "flavor": "a10g-large", "hours": 55}], cfg, now_utc())
        assert abs(m2["remaining"] - 5.0) < 1e-9, m2
        st, al = advance_alerts(st, m2, cfg, now_utc())
        assert any("LOW" in x for x in al) and any("GATE" in x for x in al), al
        st, al2 = advance_alerts(st, m2, cfg, now_utc() + dt.timedelta(hours=1))
        assert al2 == [], "no repeats"
        assert ledger_state([{"ts": "x", "type": "estimate", "job": "j2", "usd": 2.0, "flavor": "a10g-large", "hours": 100}], cfg, now_utc())["est_notes"], "mismatch must be flagged"
        add = ledger_state([{"ts": "x", "type": "estimate", "job": "j9", "usd": 68.0}, {"ts": "y", "type": "actual", "job": "j9", "usd": 20.0}, {"ts": "z", "type": "actual", "job": "j9", "usd": 30.0}], cfg, now_utc())
        assert abs(add["spent"] - 50.0) < 1e-9 and abs(add["remaining"] - 50.0) < 1e-9 and add["committed"] == 0.0, add
        corr = ledger_state([{"ts": "x", "type": "actual", "job": "j9", "usd": 20.0}, {"ts": "y", "type": "correct", "job": "j9", "usd": -5.0}], cfg, now_utc())
        assert abs(corr["spent"] - 15.0) < 1e-9 and abs(corr["remaining"] - 85.0) < 1e-9, corr
        assert cfg["baseline"]["usd"] == 100.0, "r413: V put $100 on HF"
        print("hf_ledger selftest ok"); return 0
    cfg = load_json(a.config, DEFAULT_CFG) if a.config else json.loads(json.dumps(DEFAULT_CFG))
    if a.estimate:
        job, usd, flavor, hours = a.estimate[0], float(a.estimate[1]), a.estimate[2], float(a.estimate[3])
        append_event({"type": "estimate", "job": job, "usd": usd, "flavor": flavor, "hours": hours, "owner": a.owner}); print("recorded estimate", job, usd); return 0
    if a.actual:
        append_event({"type": "actual", "job": a.actual[0], "usd": float(a.actual[1]), "owner": a.owner}); print("recorded actual", a.actual[0]); return 0
    if a.correct:
        append_event({"type": "correct", "job": a.correct[0], "usd": float(a.correct[1]), "owner": a.owner, "note": a.note or ""}); print("recorded correction", a.correct[0], a.correct[1]); return 0
    if a.ungate:
        p = os.path.join(RT, "alert-state.json"); st = load_json(p, {}); had = st.pop("gated", None)
        json.dump(st, open(p + ".tmp", "w")); os.replace(p + ".tmp", p)
        append_event({"type": "note", "usd": 0.0, "owner": a.owner, "note": "GATE cleared on Fable's order" if had else "ungate run: gate was NOT set"}); print("gate cleared" if had else "gate was not set"); return 0
    if a.topup:
        append_event({"type": "topup", "usd": a.topup, "owner": a.owner}); print("recorded topup", a.topup); return 0
    if a.note:
        append_event({"type": "note", "usd": 0.0, "owner": a.owner, "note": a.note}); print("recorded note"); return 0
    if a.once:
        now = now_utc();         dry = a.dry or not live_mode_ok(); s = Sinks(cfg, dry)
        def save_state(st):
            if dry: return
            os.makedirs(RT, exist_ok=True)
            json.dump(st, open(os.path.join(RT, "alert-state.json.tmp"), "w")); os.replace(os.path.join(RT, "alert-state.json.tmp"), os.path.join(RT, "alert-state.json"))
        st, m, alerts = evaluate(cfg, read_events(), load_json(os.path.join(RT, "alert-state.json"), {}), now, s.report, lambda msg: notify(cfg, msg, dry))
        save_state(st)
        print(json.dumps({"dry": dry, "remaining": round(m["remaining"], 4), "alerts": len(alerts)}))
        return 0
    ap.print_help(); return 2


if __name__ == "__main__":
    sys.exit(main())
