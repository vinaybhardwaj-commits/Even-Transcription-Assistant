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
    assert zm.pane_of("box", "build", "/tmp/tmpabc", c) == "box:scratch" and zm.pane_of("box", "build", "/tmp", c) == "box:scratch", "a run started in /tmp itself too"
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


@test
def ok_needs_clear_recovery_on_remaining_too_not_just_crossing_the_line():
    c = cfg(); st, out = zm.advance_alerts({}, M(9.5, None, 0.0), 0, c, NOW); assert len(out) == 1
    st, out = zm.advance_alerts(st, M(10.5, None, 0.0), 0, c, NOW + dt.timedelta(minutes=10)); assert out == [] and st["low"]["active"], "10.50 is above $10 but inside the 1.2x band: no OK"
    st, out = zm.advance_alerts(st, M(9.9, None, 0.0), 0, c, NOW + dt.timedelta(minutes=20)); assert out == [], "and dipping again does not re-alert"
    st, out = zm.advance_alerts(st, M(12.0, None, 0.0), 0, c, NOW + dt.timedelta(minutes=30)); assert len(out) == 1 and "CREDIT OK" in out[0], "12.00 = 1.2 x 10: clear"


@test
def report_says_unverified_until_a_checkpoint_and_carries_pane_notes():
    c = cfg(); p = make_db([(ms(0.3), "opencode", "m", "fleet-watch", 0.3, "/home/eta/fleet-watch", "assistant")])
    rows = [dict(r, host="box") for r in zm.collect_local(p, 0)]; g = zm.aggregate(rows, c)
    led = json.loads(json.dumps(zm.DEFAULT_LEDGER)); md = zm.render(NOW, g, zm.ledger_state(led, rows, c, NOW), {"box": "ok"}, c)
    assert "UNVERIFIED against Zen's own balance" in md and "usage export" in md and "no console checkpoint" in md and "Note on `box:fleet-watch`" in md and "$0.039" in md
    led["checkpoints"].append({"ts": (NOW - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "balance_usd": 40.0})
    md = zm.render(NOW, g, zm.ledger_state(led, rows, c, NOW), {"box": "ok"}, c); assert "last console checkpoint at" in md and "no console checkpoint" not in md


@test
def a_model_change_inside_one_pane_shows_as_two_rows_and_prices_get_an_access_column():
    c = cfg(); rows = [dict(t=ms(3.0), provider="opencode", model="gpt-5.3-codex", agent="linker-oc", dir="/d", cost=2.0, host="box"), dict(t=ms(0.5), provider="opencode", model="glm-5.3-flash", agent="linker-oc", dir="/d", cost=0.05, host="box")]
    g = zm.aggregate(rows, c); led = json.loads(json.dumps(zm.DEFAULT_LEDGER)); md = zm.render(NOW, g, zm.ledger_state(led, rows, c, NOW), {"box": "ok"}, c)
    sec = md[md.index("## Per pane by model"):md.index("## Daily total")]
    assert "| box:linker-oc | gpt-5.3-codex | 2.000 |" in sec and "| box:linker-oc | glm-5.3-flash | 0.050 |" in sec, sec
    rows2 = rows + [dict(t=ms(0.4), provider="opencode", model="free-one", agent="linker-oc", dir="/d", cost=0.0, host="box")]
    md2 = zm.render(NOW, zm.aggregate(rows2, c), zm.ledger_state(led, rows2, c, NOW), {"box": "ok"}, c); sec2 = md2[md2.index("## Per pane by model"):md2.index("## Daily total")]; assert "free-one" not in sec2 and "1 more (pane, model) pairs cost under $0.0005" in sec2, "zero rows are counted, not listed"
    import zen_prices as zp
    cat = {"opencode": {"models": {"a": {"name": "A", "cost": {"input": 1, "output": 2}, "limit": {}}, "b": {"name": "B", "cost": {"input": 1, "output": 3}, "limit": {}}}}}
    tab = zp.render(cat, {"a": {"status": "DISABLED", "detail": "403", "via": "chat"}}, NOW); tab = tab[tab.index("## All models"):]
    assert "works on our account" in tab and "| a | **DISABLED** |" in tab and "| b | untested |" in tab


def main():
    bad = 0
    for f in T:
        try: f()
        except Exception as ex:
            bad += 1; print("FAIL", f.__name__, "-", repr(ex)[:300])
    print("zen_meter tests: %d run, %d failed" % (len(T), bad)); return 1 if bad else 0


# ---------------------------------------------------------------- r413a(2): measured usage export
UH = "provider,model,input_tokens,output_tokens,reasoning_tokens,cost_micro_cents,created_at"
def urow(t, model, usd, provider="opencode"):
    return "%s,%s,10,1,0,%d,%s" % (provider, model, int(round(usd * 1e8)), t.strftime("%Y-%m-%dT%H:%M:%SZ"))
def ufile(rows_text, name="usage-7d.csv", d=None):
    d = d or tempfile.mkdtemp(); p = os.path.join(d, name); open(p, "w").write(UH + "\n" + rows_text + ("\n" if rows_text else "")); return d

@test
def read_usage_converts_microcents_and_fails_loud_never_zero():
    d = ufile(urow(NOW - dt.timedelta(hours=1), "glm-5.3-flash", 1.25) + "\n" + urow(NOW - dt.timedelta(hours=2), "qwen3.8-flash", 0.004))
    rows, err = zm.read_usage(os.path.join(d, "usage-7d.csv")); assert err is None and len(rows) == 2
    assert abs(rows[0]["usd"] - 1.25) < 1e-9 and rows[0]["model"] == "glm-5.3-flash" and rows[1]["t"] < rows[0]["t"]
    assert zm.read_usage(os.path.join(d, "nope.csv")) == (None, "missing")
    bad = os.path.join(d, "wrong.csv"); open(bad, "w").write("a,b,c\n1,2,3\n"); e = zm.read_usage(bad)[1]; assert "schema mismatch" in e, e
    d2 = ufile("opencode,m,1,1,0,NOT-A-NUMBER,2026-09-25T01:00:00Z\n" + urow(NOW, "m2", 0.5))
    rows, err = zm.read_usage(os.path.join(d2, "usage-7d.csv")); assert len(rows) == 1 and "unparseable" in err, "a garbage row is skipped and COUNTED, never silently $0"

@test
def usage_metrics_bucket_ist_days_and_the_trailing_window_and_distrust_empty():
    c = cfg()
    d = ufile("\n".join([urow(NOW - dt.timedelta(minutes=30), "a", 0.6), urow(NOW - dt.timedelta(hours=10), "b", 1.0), urow(NOW - dt.timedelta(hours=20), "c", 2.0)]))
    um = zm.usage_metrics(zm.load_usage(c, d), c, NOW)
    assert abs(um["total"] - 3.6) < 1e-9 and abs(um["burn_h"] - 0.6 / 3) < 1e-9, "only the last 30 min row is in the trailing 3 h window"
    assert abs(um["today"] - 1.6) < 1e-9, "NOW-10h is 04:30 IST today, NOW-20h is yesterday IST"
    assert um["per_model_today"] == {"a": 0.6, "b": 1.0}
    assert zm.usage_metrics(zm.load_usage(c, ufile("", d=tempfile.mkdtemp())), c, NOW) is None, "a valid header-only CSV claims zero spend in the window: NOT BELIEVED, UNMEASURED"
    assert zm.usage_metrics(zm.load_usage(c, tempfile.mkdtemp()), c, NOW) is None, "missing file is UNMEASURED"

@test
def overlay_measured_replaces_but_never_forgets_computed():
    c = cfg(); led = json.loads(json.dumps(zm.DEFAULT_LEDGER))
    rows = [dict(t=ms(1.0), provider="opencode", model="m", agent="a", dir="/d", cost=4.0, host="box")]
    m0 = zm.ledger_state(led, rows, c, NOW)
    d = ufile("\n".join([urow(NOW - dt.timedelta(hours=10), "m", 4.0), urow(NOW - dt.timedelta(hours=14), "m", 0.4), urow(NOW - dt.timedelta(hours=16), "m", 9.9)]))   # base 24 Sep 18:30Z = NOW-14.5h; the 16 h row is PRE-BASE and must never join the spend since it (refuter-2 #2797 M3)
    u = zm.load_usage(c, d); um = zm.usage_metrics(u, c, NOW)
    m = zm.overlay_measured(dict(m0), u, um, c, rows)
    assert abs(m["spent_computed"] - 4.0) < 1e-9 and abs(m["spent"] - 4.4) < 1e-9 and m["basis"].startswith("MEASURED"), "pre-base export rows are filtered out of the spend-since-base"
    assert abs(m["remaining"] - (50.0 - 4.4)) < 1e-9 and abs(m["delta_computed_minus_measured"] + 0.4) < 1e-9, "delta = computed minus measured"
    assert not m.get("window_clipped"), "oldest row predates base + 1 h: no clip"
    d2 = ufile(urow(NOW - dt.timedelta(hours=1), "m", 0.5))
    u2 = zm.load_usage(c, d2)
    m2 = zm.overlay_measured(dict(m0), u2, zm.usage_metrics(u2, c, NOW), c, [])
    assert not m2["window_clipped"], "an export whose window starts after the base is only CLIPPED if the computed record has Zen spend in the gap (refuter-2 #2797: first call today -> nothing clipped)"
    gap = [dict(t=ms(13.0), provider="opencode", model="m", agent="a", dir="/d", cost=1.0, host="box")]   # computed Zen spend 13 h ago, before the export's oldest row (NOW-1h)
    m3 = zm.overlay_measured(dict(m0), u2, zm.usage_metrics(u2, c, NOW), c, gap)
    assert m3["window_clipped"], "real evidence of spend the export window cannot see: warn"
    covered = [dict(t=ms(0.5), provider="opencode", model="m", agent="a", dir="/d", cost=5.0, host="box")]  # refuter-2 #2818: spend AFTER the oldest export row is covered by the window: no false clip warning
    m5 = zm.overlay_measured(dict(m0), u2, zm.usage_metrics(u2, c, NOW), c, covered)
    assert not m5["window_clipped"], "ordinary covered spend must never read as clipped"
    m4 = zm.overlay_measured(dict(m0), {"status": "missing", "rows": []}, None, c)
    assert m4["remaining"] == m0["remaining"] and "console balance is the truth" in m4["basis"] and "usage export: missing" in m4["basis"]

@test
def a_stale_export_file_is_UNMEASURED_not_zero_burn():
    import time as _t
    c = cfg(); d = ufile(urow(NOW - dt.timedelta(minutes=5), "m", 0.2))
    p = os.path.join(d, "usage-7d.csv"); old = _t.time() - 7200
    os.utime(p, (old, old))
    u = zm.load_usage(c, d)
    assert u["status"].startswith("stale"), u["status"]
    assert zm.usage_metrics(u, c, NOW) is None, "a 2 h old file must not be read as MEASURED $0 burn"

@test
def burn_and_day_alerts_are_measured_only_once_reminded_and_hysteresis_clears():
    c = cfg(); M2 = lambda b: {"burn_h": b, "remaining": 20.0}
    assert zm.advance_usage_alerts({}, M2(99), None, c, NOW) == ({}, []), "no export: no invented alert"
    um = lambda td: {"today": td, "total": td, "burn_h": 0, "per_model_today": {}, "n": 1, "oldest": 0}
    st, out = zm.advance_usage_alerts({}, M2(2.5), um(5.0), c, NOW); assert len(out) == 1 and "ZEN BURN HIGH $2.50/h" in out[0] and "measured" in out[0], out
    st, out = zm.advance_usage_alerts(st, M2(2.5), um(5.0), c, NOW + dt.timedelta(minutes=5)); assert out == []
    st, out = zm.advance_usage_alerts(st, M2(1.9), um(5.0), c, NOW + dt.timedelta(hours=7)); assert "(reminder)" in out[0]
    st, out = zm.advance_usage_alerts(st, M2(1.75), um(5.0), c, NOW + dt.timedelta(hours=8)); assert out == [], "1.75 > 2/1.2: hysteresis band, no flapping"
    st, out = zm.advance_usage_alerts(st, M2(1.5), um(5.0), c, NOW + dt.timedelta(hours=9)); assert any("BURN OK" in x for x in out)
    st, out = zm.advance_usage_alerts({}, M2(0.1), um(31.0), c, NOW); assert any("DAY HIGH $31.00" in x for x in out)
    st, out = zm.advance_usage_alerts(st, M2(0.1), um(35.0), c, NOW + dt.timedelta(hours=2)); assert out == [], "once per IST day"
    st, out = zm.advance_usage_alerts(st, M2(0.1), um(35.0), c, NOW + dt.timedelta(days=1, hours=1)); assert len(out) == 1 and "DAY HIGH" in out[0], "the next IST day re-arms"

@test
def render_switches_its_basis_line_and_shows_the_measured_models():
    c = cfg(); led = json.loads(json.dumps(zm.DEFAULT_LEDGER))
    rows = [dict(t=ms(0.5), provider="opencode", model="m", agent="a", dir="/d", cost=1.0, host="box")]
    g = zm.aggregate(rows, c); m0 = zm.ledger_state(led, rows, c, NOW)
    d = ufile(urow(NOW - dt.timedelta(minutes=30), "glm-5.3-flash", 3.0))
    u = zm.load_usage(c, d); um = zm.usage_metrics(u, c, NOW); m = zm.overlay_measured(dict(m0), u, um, c)
    md = zm.render(NOW, g, m, {"box": "ok"}, c, u, um)
    assert "MEASURED** from the Zen console usage export" in md and "glm-5.3-flash" in md and "| $3.00 | $3.00 | $1.000 |" in md, md[md.find("## Measured"):md.find("## Measured") + 500]
    u2 = zm.load_usage(c, tempfile.mkdtemp())
    md2 = zm.render(NOW, g, m0, {"box": "ok"}, c, u2, None)
    assert "UNVERIFIED" in md2 and "UNMEASURED: missing" in md2

@test
def read_usage_tolerates_the_real_wide_header_and_never_carries_identity_fields():
    hdr = "id,user_email,service_account_name,app,provider,model,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,cost_micro_cents,created_at"
    d = tempfile.mkdtemp(); p = os.path.join(d, "usage-7d.csv")
    open(p, "w").write(hdr + "\n" + "123,SOME@PERSON.example,ETA-FLEET,opencode,opencode,qwen3.8-flash,6,181,0,68002,338,0,124160," + (NOW - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z") + "\n")
    rows, err = zm.read_usage(p)
    assert err is None and len(rows) == 1 and abs(rows[0]["usd"] - 0.00124160) < 1e-9
    blob = json.dumps(rows) + json.dumps(zm.load_usage(cfg(), d)["rows"])
    assert "SOME@PERSON" not in blob and "ETA-FLEET" not in blob, "only provider/model/tokens/cost/time are mapped; identity columns are never carried"
    um = zm.usage_metrics(zm.load_usage(cfg(), d), cfg(), NOW)
    assert "SOME@PERSON" not in json.dumps(um) and um is not None, "millisecond-Z timestamps parse"

@test
def cycle_uses_measured_remaining_and_flags_measured_in_the_jsonl():
    c = cfg(); c["hosts"] = [{"name": "box", "local": True}]
    def local(db, since): return [dict(t=ms(1.0), provider="opencode", model="m", agent="a", dir="/d", cost=5.0)]
    led = json.loads(json.dumps(zm.DEFAULT_LEDGER))
    for n, text in (("usage-7d.csv", "\n".join([urow(NOW - dt.timedelta(hours=10), "m", 44.0), urow(NOW - dt.timedelta(hours=1), "m", 1.0)])), ("usage-24h.csv", "")):
        open(os.path.join(zm.RT, n), "w").write(UH + "\n" + text + "\n")
    try:
        sk = FakeSinks(); st, m, msgs = zm.run_cycle(c, sk, NOW, {}, led, local=local)
        assert abs(m["remaining"] - 5.0) < 1e-9, "measured $45 spent, not the computed $5 (50-45=5)"
        assert sk.rows[-1]["measured"] is True and any("ZEN CREDIT LOW" in x and "MEASURED" in x for x in msgs), msgs
        assert any("DAY HIGH" in x for x in msgs), "45 today (IST) measured > 30"
    finally:
        for n in ("usage-7d.csv", "usage-24h.csv"):
            os.replace(os.path.join(zm.RT, n), os.path.join(zm.RT, n + ".test-done"))


@test
def hsend_result_reads_only_appended_lines_and_allowlists_success():
    d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "kit")); os.makedirs(os.path.join(d, "scratch"))
    p = os.path.join(d, "kit", "hsend.sh"); open(p, "w").write("#!/bin/zsh\nexit 0\n")
    c = cfg(); c["hsend"] = p
    assert zm.hsend_result(c, "conductor", 0).startswith("hsend log unread")
    log = os.path.join(d, "scratch", "hsend.log")
    open(log, "w").write('20:00:00 -> conductor : "type":"agent_prompted" \n'); before = os.path.getsize(log)
    assert "no appended" in zm.hsend_result(c, "conductor", before), "pre-existing success is not my receipt (refuter-2 #2945)"
    open(log, "a").write('20:00:01 -> eta-refuter-2 : "type":"agent_prompted" \n')
    assert "no appended" in zm.hsend_result(c, "conductor", before), "another pane's receipt cannot mask a missing one"
    open(log, "a").write('20:00:02 -> conductor : "type":"agent_prompted" \n'); assert zm.hsend_result(c, "conductor", before) is None
    for tok in ('{"code":"agent_not_ready"}', '{"code":"empty_agent_prompt"}'):
        open(log, "a").write('20:00:03 -> conductor : %s \n' % tok)
        assert str(zm.hsend_result(c, "conductor", before)).startswith("undelivered:"), tok
        before = os.path.getsize(log)
    open(log, "w").write('20:00:09 -> conductor : "type":"agent_prompted" \n')
    assert zm.hsend_result(c, "conductor", 9999) is None, "rotated log restarts from 0: the fresh success counts (refuter-2 #2964)"
    open(log, "a").write('20:00:10 -> conductor : {"code":"agent_not_ready"} \n')
    assert str(zm.hsend_result(c, "conductor", 9999)).startswith("undelivered:"), "rotation is not a silence either"


@test
def free_model_rows_alert_once_realert_after_remind_and_never_depend_on_cost():
    c = cfg()
    rows = [dict(t=ms(0.1), provider="opencode", model="big-pickle", agent="eta-refuter-2", dir="/d", cost=0.0, host="box", n=7),
            dict(t=ms(2.0), provider="opencode", model="muse-spark-1.3", agent="x", dir="/home/eta/dev/eta-lab", cost=0.0, host="box", n=2),
            dict(t=ms(5.0), provider="opencode", model="big-pickle", agent="y", dir="/d", cost=0.0, host="box", n=9)]   # outside 3 h
    fr = zm.free_seen(rows, c, NOW)
    assert fr["box:eta-refuter-2"]["big-pickle"] == 7 and fr["box:x"]["muse-spark-1.3"] == 2 and len(fr) == 2, fr
    assert zm.free_seen([dict(t=ms(0.1), provider="opencode", model="qwen3.8-flash", agent="a", dir="/d", cost=0.0, host="box", n=3)], c, NOW) == {}
    st, out = zm.advance_free_alerts({}, fr, c, NOW)
    assert len(out) == 2 and all("FREE MODEL SEEN" in x for x in out), out
    st, out = zm.advance_free_alerts(st, fr, c, NOW + dt.timedelta(hours=1)); assert out == [], "once per pane+model"
    st, out = zm.advance_free_alerts(st, fr, c, NOW + dt.timedelta(hours=6, minutes=1)); assert len(out) == 2, "re-alert after remind_h while it KEEPS happening"
    clean = zm.free_seen([dict(t=ms(0.1), provider="opencode", model="qwen3.8-flash", agent="a", dir="/d", cost=1.0, host="box", n=1)], c, NOW)
    st, out = zm.advance_free_alerts(st, clean, c, NOW + dt.timedelta(hours=7)); assert out == []
    st, out = zm.advance_free_alerts(st, zm.free_seen([dict(t=ms(0.1), provider="opencode", model="big-pickle", agent="eta-refuter-2", dir="/d", cost=0.0, host="box", n=1)], c, NOW), c, NOW + dt.timedelta(hours=8))
    assert len(out) == 1 and "big-pickle" in out[0], "a RE-APPEARANCE after a clean cycle is a new incident"


@test
def go_share_survives_the_computed_fallback():
    c = cfg()
    rows = [dict(t=ms(1.0), provider="opencode-go", model="deepseek-v4-pro", agent="eta-refuter-2", dir="/d", cost=1.5, host="box"),
            dict(t=ms(1.0), provider="opencode", model="glm-5.3-flash", agent="a", dir="/d", cost=2.0, host="box")]
    led = json.loads(json.dumps(zm.DEFAULT_LEDGER)); m0 = zm.ledger_state(led, rows, c, NOW)
    mu = zm.overlay_measured(dict(m0), {"status": "stale (x)", "rows": [], "mtime": None, "file": "usage-7d.csv"}, None, c, rows)
    assert abs(mu["go_share_computed"] - 1.5) < 1e-9 and mu["spent"] == m0["spent"], "COMPUTED basis must still show the Go split"
    m1 = zm.overlay_measured(dict(m0), zm.load_usage(c, tempfile.mkdtemp()), None, c, rows)
    assert abs(m1["go_share_computed"] - 1.5) < 1e-9
    assert abs(m0["spent"] - 3.5) < 1e-9, "ledger_state counted BOTH routes into spent"


if __name__ == "__main__":
    sys.exit(main())
