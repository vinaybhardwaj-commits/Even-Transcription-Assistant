#!/usr/bin/env python3
"""Tests for hf_ledger.py (r413.3) on INVENTED events: no network, no ssh, no hsend, no real runtime dir."""
import contextlib, datetime as dt, io, json, os, subprocess, sys, tempfile
os.environ["HF_LEDGER_HOME"] = tempfile.mkdtemp()
import hf_ledger as hl

T0 = dt.datetime(2026, 9, 25, 15, 0, tzinfo=dt.timezone.utc)


def cfg(**over):
    c = json.loads(json.dumps(hl.DEFAULT_CFG)); c.update(over); return c


def ev(t, type_, **kw):
    return dict(ts=(T0 + dt.timedelta(minutes=t)).isoformat(), type=type_, **kw)


def state_after(events, now=T0, c=None):
    st = {}
    for i in range(len(events)):
        st, _ = hl.advance_alerts(st, hl.ledger_state(events[:i + 1], c or cfg(), now), c or cfg(), now)
    return st


T = []
def test(f): T.append(f); return f


@test
def baseline_only_is_100_and_quiet():
    m = hl.ledger_state([], cfg(), T0)
    assert m["remaining"] == 100.0 and m["spent"] == 0 and m["committed"] == 0
    assert state_after([]) == {} and hl.advance_alerts({}, m, cfg(), T0)[1] == []


@test
def an_estimate_commits_and_an_actual_closes_the_same_job():
    m = hl.ledger_state([ev(0, "estimate", job="337e-b1", usd=40.0, flavor="a10g-large", hours=40)], cfg(), T0)
    assert m["committed"] == 40.0 and m["remaining"] == 60.0 and m["open"] == ["337e-b1"]
    m2 = hl.ledger_state([ev(0, "estimate", job="337e-b1", usd=40.0, flavor="a10g-large", hours=40), ev(30, "actual", job="337e-b1", usd=35.0)], cfg(), T0)
    assert m2["committed"] == 0 and m2["spent"] == 35.0 and m2["remaining"] == 65.0, "the actual REPLACES the estimate, never adds to it"


@test
def multiple_actuals_for_one_job_add_never_replace_refuter2_2792():
    m = hl.ledger_state([ev(0, "estimate", job="337e", usd=68.0), ev(10, "actual", job="337e", usd=20.0), ev(20, "actual", job="337e", usd=30.0)], cfg(), T0)
    assert m["spent"] == 50.0 and m["remaining"] == 50.0 and m["committed"] == 0.0 and m["open"] == [], "20+30 same job = spent 50, NOT last-wins 30"
    c = hl.ledger_state([ev(0, "actual", job="j", usd=20.0), ev(10, "correct", job="j", usd=-5.0)], cfg(), T0)
    assert c["spent"] == 15.0 and c["remaining"] == 85.0, "a signed correction lowers spend"
    assert hl.ledger_state([ev(0, "correct", job="j", usd=7.0)], cfg(), T0)["spent"] == 7.0, "a positive correction also adds"


@test
def ungate_cli_clears_the_sticky_flag_only_with_a_note():
    home = tempfile.mkdtemp()      # its OWN HF_LEDGER_HOME for the subprocesses: the module-level temp home must stay clean for the dry-persistence test
    env = dict(os.environ); env["HF_LEDGER_HOME"] = home
    json.dump({"low": None, "gated": {"since": T0.isoformat()}}, open(os.path.join(home, "alert-state.json"), "w"))
    r = subprocess.run([sys.executable, os.path.join(hl.HERE, "hf_ledger.py"), "--ungate", "--owner", "fleet"], capture_output=True, text=True, env=env)
    assert r.returncode == 0 and "gate cleared" in r.stdout, r.stdout + r.stderr
    st = json.load(open(os.path.join(home, "alert-state.json"))); assert "gated" not in st and st.get("low") is None, "only the gate flag is touched"
    notes = [json.loads(l) for l in open(os.path.join(home, "events.jsonl")) if l.strip()]
    assert notes[-1]["type"] == "note" and "GATE cleared" in notes[-1]["note"]
    r2 = subprocess.run([sys.executable, os.path.join(hl.HERE, "hf_ledger.py"), "--ungate", "--owner", "fleet"], capture_output=True, text=True, env=env)
    assert "gate was not set" in r2.stdout, "ungate on a clear gate is honest"


@test
def topups_add_to_the_baseline():
    m = hl.ledger_state([ev(0, "topup", usd=25.0)], cfg(), T0)
    assert m["remaining"] == 125.0


@test
def a_posted_estimate_far_off_hours_x_rate_is_flagged_not_corrected():
    m = hl.ledger_state([ev(0, "estimate", job="j", usd=5.0, flavor="a10g-large", hours=100)], cfg(), T0)
    assert len(m["est_notes"]) == 1 and "j:" in m["est_notes"][0]
    assert "j:" not in " ".join(hl.ledger_state([ev(0, "estimate", job="j", usd=100.0, flavor="a10g-large", hours=100)], cfg(), T0)["est_notes"]), "within 10% is fine"
    assert hl.ledger_state([ev(0, "estimate", job="j", usd=5.0)], cfg(), T0)["est_notes"] == [], "no flavor/hours is unchecked, not guessed"


@test
def low_fires_once_then_reminds_then_clears_above_1_2x_then_refires():
    c = cfg(); big = [ev(0, "estimate", job="b1", usd=75.0)]           # remaining 25 -> LOW
    st, al = hl.advance_alerts({}, hl.ledger_state(big, c, T0), c, T0)
    assert sum(1 for x in al if "LOW" in x) == 1
    st, al = hl.advance_alerts(st, hl.ledger_state(big, c, T0), c, T0 + dt.timedelta(hours=3)); assert al == []
    st, al = hl.advance_alerts(st, hl.ledger_state(big, c, T0), c, T0 + dt.timedelta(hours=7)); assert any("LOW (reminder)" in x for x in al)
    small = [ev(0, "estimate", job="b1", usd=5.0)]                      # remaining 95 -> no OK at 33, needs >= 36
    st, al = hl.advance_alerts(st, hl.ledger_state([ev(0, "estimate", job="b2", usd=67.0)], c, T0), c, T0)   # 33: between low and 1.2x
    assert al == [], "no flapping at the edge"
    st, al = hl.advance_alerts(st, hl.ledger_state(small, c, T0), c, T0); assert any("HF CREDIT OK" in x for x in al)


@test
def gate_at_15_fires_once_and_stays_sticky():
    c = cfg(); g = [ev(0, "estimate", job="b1", usd=90.0)]              # remaining 10
    st, al = hl.advance_alerts({}, hl.ledger_state(g, c, T0), c, T0)
    assert any("GATE" in x for x in al) and any("LOW" in x for x in al)
    st, al2 = hl.advance_alerts(st, hl.ledger_state(g, c, T0), c, T0 + dt.timedelta(hours=1))
    assert not any("GATE" in x for x in al2), "no repeat while it stands"
    st, al3 = hl.advance_alerts(st, hl.ledger_state([ev(0, "estimate", job="b1", usd=50.0)], c, T0), c, T0 + dt.timedelta(hours=2))
    assert not any("GATE" in x for x in al3), "gate does not self-clear after recovery: clearing it is Fable's call, not the guard's"


@test
def render_shows_the_numbers_and_the_gate():
    m = hl.ledger_state([ev(0, "estimate", job="j1", usd=88.0)], cfg(), T0)
    r = hl.render(T0, m, cfg())
    assert "$12.00" in r and "j1" in r and "COMPUTED" in r


@test
def evaluate_wires_ledger_alerts_report_and_notify_and_the_note_fires_once():
    notes, reports = [], []
    c = cfg()
    events = [ev(0, "estimate", job="bad", usd=1.0, flavor="a10g-large", hours=50)]
    st, m, al = hl.evaluate(c, events, {}, T0, lambda t: reports.append(t), notes.append)
    assert any("mismatch" in n for n in notes) and reports and "$-1.00" not in reports[0]
    st2, m2, al2 = hl.evaluate(c, events, st, T0 + dt.timedelta(hours=1), lambda t: None, notes.append)
    assert al2 == [], "the same mismatch is one message, not one per cycle"


@test
def cli_records_to_a_temp_home_and_a_cycle_stays_dry_without_MODE_live():
    home = os.environ["HF_LEDGER_HOME"]
    r = subprocess.run([sys.executable, os.path.join(hl.HERE, "hf_ledger.py"), "--estimate", "jobx", "12.5", "a10g-large", "12", "--owner", "diar-lab"], capture_output=True, text=True, env=dict(os.environ))
    assert r.returncode == 0 and "recorded estimate" in r.stdout, r
    r2 = subprocess.run([sys.executable, os.path.join(hl.HERE, "hf_ledger.py"), "--once"], capture_output=True, text=True, env=dict(os.environ))
    out = json.loads(r2.stdout.strip().splitlines()[-1])
    assert out["dry"] is True and abs(out["remaining"] - 87.5) < 1e-6
    assert os.path.exists(os.path.join(home, "dry", "HF-SPEND.md")) and not os.path.exists(os.path.join(home, "MODE"))
    assert not os.path.exists(os.path.join(home, "alert-state.json")), "dry never persists alert state"


@test
def live_report_mirrors_to_the_mini_with_a_real_argv_list():
    # a subprocess.run(SHELL STRING) without shell=True raises FileNotFoundError and the bare except SWALLOWS it: the mirror silently never worked (found 20:42, after the 20:40 cron went live)
    import subprocess as sp
    home = os.environ["HF_LEDGER_HOME"]; captured = []
    orig = sp.run
    sp.run = lambda cmd, **kw: (captured.append((cmd, kw.get("input"))), type("R", (), {"returncode": 0})())[1]
    try:
        hl.Sinks(hl.DEFAULT_CFG, dry=False).report("MIRROR-TEST")
    finally:
        sp.run = orig
    assert len(captured) == 1, "the mirror ran the ssh"
    cmd, data = captured[0]
    assert isinstance(cmd, list) and cmd[0] == "ssh" and any("HF-SPEND.md.tmp" in a and "mv " in a for a in cmd), cmd
    assert data == b"MIRROR-TEST" and os.path.exists(os.path.join(home, "HF-SPEND.md"))
    sp.run = lambda *a, **k: (_ for _ in ()).throw(OSError("ssh down"))
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            hl.Sinks(hl.DEFAULT_CFG, dry=False).report("STILL-STANDS")
        assert os.path.exists(os.path.join(home, "HF-SPEND.md")), "a failed mirror never stops the local report"
    finally:
        sp.run = orig
    assert "mini mirror FAILED: OSError" in err.getvalue(), "a dead mirror must announce itself on the first cycle, not on a spot-check (refuter-2 #2853)"


@test
def hsend_result_reads_only_appended_lines_and_allowlists_success():
    d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "kit")); os.makedirs(os.path.join(d, "scratch"))
    p = os.path.join(d, "kit", "hsend.sh"); open(p, "w").write("#!/bin/zsh\nexit 0\n")
    c = cfg(); c["hsend"] = p
    assert hl.hsend_result(c, "conductor", 0) == "hsend log unread: FileNotFoundError", "no log at all is a failure, not a silence"
    log = os.path.join(d, "scratch", "hsend.log")
    open(log, "w").write('20:00:00 -> conductor : "type":"agent_prompted" \n'); before = os.path.getsize(log)
    assert hl.hsend_result(c, "conductor", before) == "no appended hsend line for conductor", "a PRE-EXISTING success line is not my receipt (shared log, refuter-2 #2945)"
    open(log, "a").write('20:00:01 -> eta-refuter-2 : "type":"agent_prompted" \n')
    assert hl.hsend_result(c, "conductor", before) == "no appended hsend line for conductor", "another pane's receipt cannot mask a missing one"
    open(log, "a").write('20:00:02 -> conductor : "type":"agent_prompted" \n'); assert hl.hsend_result(c, "conductor", before) is None
    for tok in ('{"code":"agent_not_ready"}', '{"code":"empty_agent_prompt"}', 'unknown-agent (checked default + eta-lab-t4)', '"code":"agent_blocked"'):
        open(log, "a").write('20:00:03 -> conductor : %s \n' % tok)
        r = hl.hsend_result(c, "conductor", before)
        assert r and r.startswith("undelivered:"), "%s must NOT be success under an allowlist" % tok
        before = os.path.getsize(log)
    open(log, "w").write('20:00:09 -> conductor : "type":"agent_prompted" \n')
    assert hl.hsend_result(c, "conductor", 9999) is None, "rotated log (size < since_pos) restarts from 0: the fresh success IS this call's line (refuter-2 #2964: since_pos>size branch)"
    open(log, "a").write('20:00:10 -> conductor : {"code":"agent_not_ready"} \n')
    assert str(hl.hsend_result(c, "conductor", 9999)).startswith("undelivered:"), "and a rotated log is not a silence either"


@test
def selftest_exit_zero():
    r = subprocess.run([sys.executable, os.path.join(hl.HERE, "hf_ledger.py"), "--selftest"], capture_output=True, text=True)
    assert r.returncode == 0 and "selftest ok" in r.stdout, r.stdout + r.stderr


if __name__ == "__main__":
    fails = 0
    for f in T:
        try: f(); print("ok  ", f.__name__)
        except Exception as ex: fails += 1; print("FAIL", f.__name__, ":", ex)
    print("hf_ledger tests: %d run, %d failed" % (len(T), fails))
    sys.exit(1 if fails else 0)
