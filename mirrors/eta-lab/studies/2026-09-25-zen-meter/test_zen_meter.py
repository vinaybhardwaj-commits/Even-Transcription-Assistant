#!/usr/bin/env python3
"""Tests for zen_meter.py. A synthetic OpenCode database (message + session tables only, invented rows), a fake remote, and a fake notifier: nothing here reaches a real database, host, Mini or conductor."""
import datetime as dt, json, os, sqlite3, sys, tempfile

os.environ["ZEN_METER_HOME"] = tempfile.mkdtemp()      # before the import: the tests must never touch ~/zen-meter
import zen_meter as zm

T = []
def test(f): T.append(f); return f

NOW = dt.datetime(2026, 9, 25, 9, 0, tzinfo=dt.timezone.utc)      # 14:30 IST
def ms(h_ago=0.0, minute_off=0): return int((NOW.timestamp() - h_ago * 3600) * 1000) + minute_off * 60000
def cfg(**kw):
    c = json.loads(json.dumps(zm.DEFAULT_CFG)); c.update(kw); return c


def make_db(rows):
    """rows: (t_ms, provider, model, agent, cost, dir, role). Assistant rows get a data blob with the cost/token keys; any text in it would be a leak the query must not select."""
    p = os.path.join(tempfile.mkdtemp(), "opencode.db"); con = sqlite3.connect(p)
    con.execute("create table session (id text primary key, directory text not null, title text not null)")
    con.execute("create table message (id text primary key, session_id text not null, time_created integer not null, data text not null)")
    con.execute("create table credential (id text, value text)"); con.execute("insert into credential values ('c', 'SECRET-VALUE')")
    dirs = {}
    for i, (t, prov, model, agent, cost, d, role) in enumerate(rows):
        sid = dirs.setdefault(d, "s%d" % len(dirs)); con.execute("insert or ignore into session values (?,?,?)", (sid, d, "TITLE-TEXT-NEVER-READ"))
        data = {"role": role, "agent": agent, "providerID": prov, "modelID": model, "cost": cost, "tokens": {"input": 100, "output": 10, "reasoning": 5, "cache": {"read": 50, "write": 0}}}
        con.execute("insert into message values (?,?,?,?)", ("m%d" % i, sid, t, json.dumps(data)))
    con.commit(); con.close(); return p


@test
def collector_reads_assistant_zen_rows_and_no_text_or_credentials():
    p = make_db([(ms(0.5), "opencode", "gpt-5.3-codex", "build", 0.10, "/home/eta/dev/eta-lab", "assistant"), (ms(0.5, 0), "opencode", "gpt-5.3-codex", "build", 0.05, "/home/eta/dev/eta-lab", "assistant"),
                 (ms(0.4), "opencode", "gpt-5.3-codex", "build", 9.99, "/home/eta/dev/eta-lab", "user")])
    rows = zm.collect_local(p, 0)
    assert len(rows) == 1 and abs(rows[0]["cost"] - 0.15) < 1e-9 and rows[0]["n"] == 2 and rows[0]["in"] == 200, "same minute summed, the user row ignored"
    blob = json.dumps(rows)
    assert "SECRET-VALUE" not in blob and "TITLE-TEXT" not in blob
    low = zm.SQL.lower()
    for bad in ("credential", "account", "part", "session_input", "title", "todo", "control_account", "session_share"):
        assert bad not in low, "the query must never name %s" % bad
    assert "select " in low and low.count("select") == 1 and low.count("from ") == 1 and "join session" in low


@test
def panes_by_agent_then_directory_then_basename_and_hosts_stay_apart():
    c = cfg()
    assert zm.pane_of("box", "linker-oc", "/x", c) == "box:linker-oc", "a named agent IS the pane"
    assert zm.pane_of("box", "build", "/home/eta/dev/eta-lab", c) == "box:linker-oc", "default agent falls back to the directory map"
    assert zm.pane_of("box", "build", "/home/eta/dev/eta-lab/sub", c) == "box:linker-oc", "prefix match"
    assert zm.pane_of("box", "build", "/tmp/tmpabc", c) == "box:scratch"
    assert zm.pane_of("mini", "build", "/Users/v/dev/thing", c) == "mini:dir:thing", "unmapped: a visible dir label, never silently merged"
    c["pane_map"]["/home/eta/dev"] = "shorter"; assert zm.pane_of("box", "build", "/home/eta/dev/eta-lab", c) == "box:linker-oc", "longest prefix wins"


@test
def aggregation_hourly_daily_and_only_zen_counts_as_zen():
    c = cfg(); rows = [dict(t=ms(0.2), provider="opencode", model="a", agent="p1", dir="/d", cost=1.0, host="box"), dict(t=ms(0.2), provider="opencode", model="a", agent="p1", dir="/d", cost=0.5, host="mini"),
                       dict(t=ms(1.5), provider="opencode", model="b", agent="p1", dir="/d", cost=2.0, host="box"), dict(t=ms(0.2), provider="openrouter", model="z", agent="p1", dir="/d", cost=7.0, host="box"),
                       dict(t=ms(30), provider="opencode", model="a", agent="p1", dir="/d", cost=4.0, host="box")]
    g = zm.aggregate(rows, c)
    assert abs(g["per_pane_hour"][("box:p1", zm.hour_key(ms(0.2)))] - 1.0) < 1e-9 and abs(g["per_pane_hour"][("mini:p1", zm.hour_key(ms(0.2)))] - 0.5) < 1e-9
    assert abs(g["per_day"][zm.day_key(ms(0.2))] - 3.5) < 1e-9 and abs(g["per_day"][zm.day_key(ms(30))] - 4.0) < 1e-9, "IST days"
    assert g["other"] == {"openrouter": 7.0} and abs(sum(g["per_model"].values()) - 7.5) < 1e-9, "openrouter is not Zen spend"


@test
def ledger_start_topup_checkpoint_and_burn():
    c = cfg(); rows = [dict(t=ms(5), provider="opencode", cost=3.0), dict(t=ms(2), provider="opencode", cost=6.0), dict(t=ms(1), provider="opencode", cost=3.0), dict(t=ms(1), provider="openrouter", cost=50.0)]
    led = json.loads(json.dumps(zm.DEFAULT_LEDGER)); led["start"]["ts"] = (NOW - dt.timedelta(hours=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    m = zm.ledger_state(led, rows, c, NOW)
    assert abs(m["spent"] - 12.0) < 1e-9 and abs(m["remaining"] - 38.0) < 1e-9, m
    assert abs(m["burn_h"] - 3.0) < 1e-9 and abs(m["burn_day"] - 72.0) < 1e-9 and abs(m["runway_h"] - 38.0 / 3.0) < 1e-9, "trailing 3 h = 9.00 / 3"
    led["topups"].append({"ts": (NOW - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "usd": 25}); assert abs(zm.ledger_state(led, rows, c, NOW)["remaining"] - 63.0) < 1e-9
    led["topups"].append({"ts": (NOW - dt.timedelta(hours=20)).strftime("%Y-%m-%dT%H:%M:%SZ"), "usd": 1000}); assert abs(zm.ledger_state(led, rows, c, NOW)["remaining"] - 63.0) < 1e-9, "a top-up before the base does not count"
    led["checkpoints"].append({"ts": (NOW - dt.timedelta(hours=1.5)).strftime("%Y-%m-%dT%H:%M:%SZ"), "balance_usd": 20.0})
    m = zm.ledger_state(led, rows, c, NOW)
    assert m["base_kind"] == "checkpoint" and abs(m["remaining"] - (20.0 + 25.0 - 3.0)) < 1e-9, "re-based on the console balance: only spend and top-ups after it count: %s" % m
    assert zm.ledger_state(led, [], c, NOW)["runway_h"] is None, "no burn: no runway"


def M(remaining, runway, burn_day=24.0):
    return {"remaining": remaining, "runway_h": runway, "burn_day": burn_day, "base_kind": "start"}


@test
def low_alert_fires_once_reminds_every_remind_h_and_clears_with_hysteresis():
    c = cfg(); st = {}
    st, out = zm.advance_alerts(st, M(45.0, 40.0), 0, c, NOW); assert out == [] and not st.get("low", {}).get("active")
    st, out = zm.advance_alerts(st, M(45.0, 10.0, 100.0), 0, c, NOW); assert len(out) == 1 and out[0].startswith("NF| ZEN CREDIT LOW 45.00 100.00/day"), out
    for k in range(1, 5):
        st, out = zm.advance_alerts(st, M(44.0, 10.0), 0, c, NOW + dt.timedelta(minutes=10 * k)); assert out == [], "once, not every cycle"
    st, out = zm.advance_alerts(st, M(30.0, 8.0), 0, c, NOW + dt.timedelta(hours=6, minutes=1)); assert len(out) == 1 and "(reminder)" in out[0]
    st, out = zm.advance_alerts(st, M(30.0, 25.0), 0, c, NOW + dt.timedelta(hours=7)); assert out == [] and st["low"]["active"], "25 h is over the 24 h line but inside the hysteresis band"
    st, out = zm.advance_alerts(st, M(30.0, 40.0), 0, c, NOW + dt.timedelta(hours=8)); assert len(out) == 1 and "CREDIT OK" in out[0] and not st["low"]["active"]
    st, out = zm.advance_alerts(st, M(30.0, 40.0), 0, c, NOW + dt.timedelta(hours=9)); assert out == []


@test
def low_by_remaining_alone_and_unmeasured_hosts_are_named_in_the_alert():
    c = cfg(); st, out = zm.advance_alerts({}, M(9.5, None, 0.0), 0, c, NOW, unmeasured=("yoga",))
    assert len(out) == 1 and "LOW 9.50 0.00/day" in out[0] and "runway n/a" in out[0] and "NOT MEASURED: yoga" in out[0] and "console balance is the truth" in out[0], out


@test
def daily_cap_80_percent_fires_once_per_ist_day_then_100_once():
    c = cfg(daily_cap_usd=10.0); st, out = zm.advance_alerts({}, M(45.0, 99.0), 7.9, c, NOW); assert out == []
    st, out = zm.advance_alerts(st, M(45.0, 99.0), 8.0, c, NOW); assert len(out) == 1 and "CAP 80%" in out[0] and "8.00 of 10.00" in out[0]
    for v in (8.5, 9.0, 9.9):
        st, out = zm.advance_alerts(st, M(45.0, 99.0), v, c, NOW); assert out == [], "once"
    st, out = zm.advance_alerts(st, M(45.0, 99.0), 10.0, c, NOW); assert len(out) == 1 and "CAP REACHED" in out[0]
    st, out = zm.advance_alerts(st, M(45.0, 99.0), 11.0, c, NOW); assert out == []
    st, out = zm.advance_alerts(st, M(45.0, 99.0), 8.5, c, NOW + dt.timedelta(days=1)); assert len(out) == 1 and "CAP 80%" in out[0], "a new IST day re-arms it"
    c0 = cfg(); st, out = zm.advance_alerts({}, M(45.0, 99.0), 500.0, c0, NOW); assert out == [], "no cap set (r407b): no cap alert"


@test
def a_failed_host_is_named_not_measured_and_never_drops_the_others():
    def local(db, since): return [dict(t=ms(0.1), provider="opencode", model="m", agent="a", dir="/d", cost=1.0)]
    def remote(target, since):
        if target == "ubuntuyoga": raise RuntimeError("Host key verification failed")
        return [dict(t=ms(0.1), provider="opencode", model="m", agent="a", dir="/d", cost=2.0)]
    rows, status = zm.gather(cfg(), 0, local, remote)
    assert status["box"] == "ok" and status["mini"] == "ok" and status["air"] == "ok" and status["yoga"].startswith("NOT MEASURED") and "Host key" not in status["yoga"], "no stderr text"
    assert abs(sum(r["cost"] for r in rows) - 5.0) < 1e-9 and {r["host"] for r in rows} == {"box", "mini", "air"}


@test
def report_has_panes_hours_days_models_and_no_text():
    c = cfg(); p = make_db([(ms(0.3), "opencode", "gpt-5.3-codex", "build", 1.25, "/home/eta/dev/eta-lab", "assistant"), (ms(2.2), "opencode", "gemini-3.5-flash-lite", "fleet-watch", 0.004, "/home/eta/fleet-watch", "assistant")])
    rows = [dict(r, host="box") for r in zm.collect_local(p, 0)]; g = zm.aggregate(rows, c)
    led = json.loads(json.dumps(zm.DEFAULT_LEDGER)); m = zm.ledger_state(led, rows, c, NOW); md = zm.render(NOW, g, m, {"box": "ok", "yoga": "NOT MEASURED: RuntimeError"}, c)
    for want in ("box:linker-oc", "box:fleet-watch", "gpt-5.3-codex", "gemini-3.5-flash-lite", "1.250", "yoga=NOT MEASURED", "remaining", "2026-09-25"):
        assert want in md, want
    assert "TITLE-TEXT" not in md and "SECRET" not in md


class FakeSinks:
    def __init__(self): self.mini_w, self.rows, self.msgs = [], [], []
    dry = True
    def report(self, f, t): self.mini_w.append((f, t))
    def jsonl(self, o): self.rows.append(o)
    def notify(self, m): self.msgs.append(m)


@test
def cycle_sends_one_alert_at_the_transition_and_writes_report_and_jsonl_to_its_sinks_only():
    c = cfg(); c["hosts"] = [{"name": "box", "local": True}]
    burst = [dict(t=ms(1.0), provider="opencode", model="m", agent="hot", dir="/d", cost=20.0)]
    led = json.loads(json.dumps(zm.DEFAULT_LEDGER)); led["start"]["ts"] = (NOW - dt.timedelta(hours=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    sk = FakeSinks(); st = {}
    for k in range(3):
        st, m, msgs = zm.run_cycle(c, sk, NOW + dt.timedelta(minutes=10 * k), st, led, local=lambda d, s: burst)
    assert len(sk.msgs) == 1 and sk.msgs[0].startswith("NF| ZEN CREDIT LOW"), sk.msgs       # 30 left, burn 6.67/h -> 4.5 h runway
    assert len(sk.rows) == 3 and sk.mini_w and sk.mini_w[0][0] == "ZEN-SPEND.md" and "box:hot" in sk.mini_w[0][1]


@test
def real_sinks_need_mode_live_and_a_free_lock():
    d = tempfile.mkdtemp(); assert not zm.live_mode_ok(d); open(os.path.join(d, "MODE"), "w").write("dry"); assert not zm.live_mode_ok(d)
    open(os.path.join(d, "MODE"), "w").write("live\n"); assert zm.live_mode_ok(d)
    old = zm.RT; zm.RT = tempfile.mkdtemp()
    try:
        assert zm.main(["--once"]) == 4, "no MODE=live: refused"
        open(os.path.join(zm.RT, "MODE"), "w").write("live")
        import fcntl; held = open(os.path.join(zm.RT, "lock"), "w"); fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert zm.main(["--once"]) == 3, "the loop holds the lock: a one-off real run refuses"
    finally:
        zm.RT = old


@test
def topup_and_checkpoint_append_and_never_edit():
    old = zm.RT; zm.RT = tempfile.mkdtemp()
    try:
        assert zm.main(["--topup", "25", "--note", "UPI"]) == 0 and zm.main(["--checkpoint", "41.5"]) == 0 and zm.main(["--topup", "10"]) == 0
        led = json.load(open(os.path.join(zm.RT, "ledger.json")))
        assert [t["usd"] for t in led["topups"]] == [25.0, 10.0] and led["checkpoints"][0]["balance_usd"] == 41.5 and led["start"]["usd"] == 50.0
    finally:
        zm.RT = old


@test
def price_table_lists_free_tiers_access_and_the_cost_basis():
    import zen_prices as zp
    cat = {"opencode": {"models": {"big-pickle": {"name": "Big Pickle", "cost": {"input": 0, "output": 0}, "limit": {"context": 200000}},
            "gpt-6-astra": {"name": "A", "cost": {"input": 10, "output": 50, "cache_read": 1, "cache_write": 12.5, "tiers": [{"input": 20, "output": 75, "tier": {"type": "context", "size": 272000}}]}, "limit": {"context": 1000000}, "provider": {"npm": "@ai-sdk/openai"}},
            "cheap": {"name": "C", "cost": {"input": 0.14, "output": 0.28, "cache_read": 0.028}, "limit": {}}}}}
    md = zp.render(cat, {"cheap": {"status": "DISABLED", "detail": "403", "via": "chat"}}, NOW)
    tab = md[md.index("## All models"):]
    assert tab.index("big-pickle (free)") < tab.index("| cheap |") < tab.index("| gpt-6-astra |"), "free first, then by output price"
    assert "over 272K ctx: 20 in / 75 out" in md and "| cheap | **DISABLED** |" in md and "COMPUTED" in md and "4.4% + $0.30" in md and "0.028" in md and "openai" in md


def main():
    bad = 0
    for f in T:
        try: f()
        except Exception as ex:
            bad += 1; print("FAIL", f.__name__, "-", repr(ex)[:300])
    print("zen_meter tests: %d run, %d failed" % (len(T), bad)); return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
