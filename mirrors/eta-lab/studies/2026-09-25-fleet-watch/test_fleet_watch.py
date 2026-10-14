#!/usr/bin/env python3
"""Tests for fleet_watch.py on INVENTED snapshots in the real Scribe door shape (no real data, no network, no ssh, no hsend)."""
import fcntl, datetime as dt, json, os, re, sys, tempfile
os.environ["FLEET_WATCH_HOME"] = tempfile.mkdtemp()      # unconditional: a test must never touch the real runtime dir (cost.jsonl, state, lock)
import fleet_watch as fw


def _no_real_model(*a, **k):
    raise AssertionError("a test reached a real model call (run_model must be stubbed or the budget cap must stop it)")
fw.run_model = _no_real_model      # fail fast: a bypassed cap used to hang the suite on a real opencode call (refuter-2 G7 note)

HERE = os.path.dirname(os.path.abspath(__file__))
MON_NOON = dt.datetime(2026, 9, 21, 6, 30, tzinfo=dt.timezone.utc)      # Mon 12:00 IST
MON_NIGHT = dt.datetime(2026, 9, 21, 17, 30, tzinfo=dt.timezone.utc)    # Mon 23:00 IST
SUN_NOON = dt.datetime(2026, 9, 20, 6, 30, tzinfo=dt.timezone.utc)      # Sun 12:00 IST


def room(name="OPD 1", rid="room_a", recording=True, state="recording", piece_age=120, now=MON_NOON, listener="listening", page=True, kiosk_lost=False, stalled=False, nd=None, sid=None):
    return {"room": {"id": rid, "name": name}, "page_open": page, "listener_state": listener, "recording": recording, "recording_session_id": sid, "room_state": {"state": state, "flags": []},
            "last_piece_at": (now - dt.timedelta(seconds=piece_age)).isoformat() if piece_age is not None else None,
            "flags": {"kiosk_not_listening": kiosk_lost, "stalled": stalled}, "not_delivering_minutes": nd}


def fleet_row(rid="room_a", flags=None, mic="authorized", dev="C270 HD WEBCAM", disk="ok"):
    return {"room": {"id": rid}, "install": {"state_flags": flags or [], "mic_state": mic, "input_device_name": dev}, "disk_level": disk}


def samples(now, n=40, adv=True, zr=0.0):
    return [{"t_ms": int((now.timestamp() - 15 * (n - i)) * 1000), "peak": 0.05, "avg": 0.03, "zero_ratio": zr, "session_open": True, "tape_advancing": adv, "samples": 6} for i in range(n)]


def snap(rooms, fleet=None, levels=None, now=MON_NOON, health=None, tape=None):
    return {"ts": now.isoformat(), "now": {"rooms": rooms}, "fleet": {"rooms": fleet or [fleet_row(r["room"]["id"]) for r in rooms]}, "health": health or {"issues": ["deepgram_key_missing"]},
            "levels": levels if levels is not None else {r["room"]["id"]: samples(now) for r in rooms}, "tape": tape or {}}


def issues_for(s, now=MON_NOON, cfg=None, prev=None):
    out, dev, info = fw.decide(s, cfg or fw.load_cfg(), now, prev)
    return out, dev, info


def codes(iss, sev="PROBLEM"):
    return sorted(i["code"] for i in iss if i["severity"] == sev)


class FakeSinks:
    def __init__(self): self.bug, self.rows, self.msgs, self.hb = [], [], [], []
    def buglog(self, l): self.bug.append(l)
    def jsonl(self, o): self.rows.append(o)
    def notify(self, m): self.msgs.append(m)
    def heartbeat(self, o): self.hb.append(o)


T = []
def test(f): T.append(f); return f


@test
def healthy_room_has_no_problem():
    out, _, info = issues_for(snap([room()]))
    assert out["OPD 1"] == [] and info == ["deepgram_key_missing"], (out, info)

@test
def not_recording_is_a_problem_in_clinic_hours_only():
    s = snap([room(recording=False, state="ready")])
    assert codes(issues_for(s)[0]["OPD 1"]) == ["NOT_RECORDING"]
    assert codes(issues_for(s, MON_NIGHT)[0]["OPD 1"]) == [] and codes(issues_for(s, MON_NIGHT)[0]["OPD 1"], "INFO") == ["NOT_RECORDING"], "outside clinic hours it is INFO"
    assert codes(issues_for(s, SUN_NOON)[0]["OPD 1"]) == [], "Sunday is outside clinic days"

@test
def an_offline_kiosk_is_one_root_cause_not_two_problems():
    s = snap([room(recording=False, state="offline", listener="stale", page=False, kiosk_lost=True)])
    assert codes(issues_for(s)[0]["OPD 1"]) == ["KIOSK_OFFLINE"], "NOT_RECORDING must not double-report an offline kiosk"

@test
def a_closed_page_with_a_listening_listener_is_still_an_offline_kiosk():
    s = snap([room(recording=False, state="ready", listener="listening", page=False)])
    assert codes(issues_for(s)[0]["OPD 1"]) == ["KIOSK_OFFLINE"], "page_open false alone is KIOSK_OFFLINE, not NOT_RECORDING"
    assert codes(issues_for(snap([room(recording=False, state="ready", listener="listening", page=True)]))[0]["OPD 1"]) == ["NOT_RECORDING"], "control: page open + listening + not recording is NOT_RECORDING"
    assert codes(issues_for(s, MON_NIGHT)[0]["OPD 1"]) == [] and codes(issues_for(s, MON_NIGHT)[0]["OPD 1"], "INFO") == ["KIOSK_OFFLINE"], "outside clinic hours it is INFO"

@test
def pieces_stalled_boundary_and_flag():
    assert codes(issues_for(snap([room(piece_age=700)]))[0]["OPD 1"]) == ["PIECES_STALLED"]
    assert codes(issues_for(snap([room(piece_age=500)]))[0]["OPD 1"]) == []
    assert codes(issues_for(snap([room(piece_age=10, stalled=True)]))[0]["OPD 1"]) == ["PIECES_STALLED"]

@test
def tape_not_advancing_needs_a_full_window_of_samples():
    r = room(); rid = r["room"]["id"]
    assert codes(issues_for(snap([r], levels={rid: samples(MON_NOON, 40, adv=False)}))[0]["OPD 1"]) == ["TAPE_NOT_ADVANCING"]
    assert codes(issues_for(snap([r], levels={rid: samples(MON_NOON, 20, adv=False)}))[0]["OPD 1"]) == [], "too few samples is not evidence"
    mixed = samples(MON_NOON, 40, adv=False); mixed[-1]["tape_advancing"] = True
    assert codes(issues_for(snap([r], levels={rid: mixed}))[0]["OPD 1"]) == []

@test
def level_log_zero_is_info_only_needs_measured_zero_and_null_is_unmeasurable_not_ok_not_zero():
    r = room(); rid = r["room"]["id"]
    z = issues_for(snap([r], levels={rid: samples(MON_NOON, 40, zr=1.0)}))[0]["OPD 1"]
    assert codes(z) == [] and codes(z, "INFO") == ["ZERO_SIGNAL"], "quiet is INFO only (scribe #2374, option E withdrawn)"
    assert codes(issues_for(snap([r], levels={rid: samples(MON_NOON, 40, zr=0.5)}))[0]["OPD 1"], "INFO") == []
    nul = samples(MON_NOON, 40, zr=1.0); nul[5]["zero_ratio"] = None
    assert codes(issues_for(snap([r], levels={rid: nul}))[0]["OPD 1"], "INFO") == [], "a null zero_ratio must never count as a zero"
    assert codes(issues_for(snap([r], levels={rid: None}))[0]["OPD 1"], "INFO") == [], "an unreadable level log is unmeasurable, not a zero"

@test
def device_and_mic_and_delivery_and_disk_rules():
    r = room()
    assert codes(issues_for(snap([r], fleet=[fleet_row(flags=["DEVICE_MISSING"])]))[0]["OPD 1"]) == ["DEVICE_MISSING"]
    out, dev, _ = issues_for(snap([r], fleet=[fleet_row(dev="Other mic")]), prev={"room_a": "C270 HD WEBCAM"})
    assert codes(out["OPD 1"]) == ["DEVICE_CHANGED"] and dev["room_a"] == "Other mic"
    assert codes(issues_for(snap([r], fleet=[fleet_row(mic="denied")]))[0]["OPD 1"]) == ["MIC_NOT_AUTHORIZED"]
    orb = room("ORB3", "room_o"); assert codes(issues_for(snap([orb], fleet=[fleet_row("room_o", mic="unknown")]))[0]["ORB3"]) == [], "ORB3's normal 'unknown' mic state is configured OK"
    assert codes(issues_for(snap([room(nd=15)]))[0]["OPD 1"]) == ["NOT_DELIVERING"] and codes(issues_for(snap([room(nd=3)]))[0]["OPD 1"]) == []
    assert codes(issues_for(snap([r], fleet=[fleet_row(disk="red")]), MON_NIGHT)[0]["OPD 1"]) == ["DISK_RED"], "red disk is a problem at any hour"
    assert codes(issues_for(snap([r], fleet=[fleet_row(disk="amber")]))[0]["OPD 1"]) == [] and codes(issues_for(snap([r], fleet=[fleet_row(disk="amber")]))[0]["OPD 1"], "INFO") == ["DISK_AMBER"]

@test
def a_known_condition_is_info_with_its_reason_and_ignored_rooms_are_skipped():
    cfg = fw.load_cfg(); cfg["known"] = {"OPD 1": {"NOT_RECORDING": "kiosk under repair"}}
    out, _, _ = issues_for(snap([room(recording=False, state="ready")]), cfg=cfg)
    assert codes(out["OPD 1"]) == [] and "kiosk under repair" in out["OPD 1"][0]["detail"]
    cfg["ignore_rooms"] = ["OPD 1"]; assert "OPD 1" not in issues_for(snap([room(recording=False)]), cfg=cfg)[0]

@test
def one_message_per_problem_per_state_change_then_reminder_then_resolved():
    cfg = fw.load_cfg(); bad = snap([room(recording=False, state="ready")])
    st, ev = fw.advance({}, issues_for(bad)[0], MON_NOON, cfg); assert [e["type"] for e in ev] == ["NEW"]
    t1 = MON_NOON + dt.timedelta(minutes=5); st, ev = fw.advance(st, issues_for(bad, t1)[0], t1, cfg); assert ev == [], "no repeat within the hour"
    t2 = MON_NOON + dt.timedelta(minutes=61); st, ev = fw.advance(st, issues_for(bad, t2)[0], t2, cfg); assert [e["type"] for e in ev] == ["REMIND"]
    t3 = t2 + dt.timedelta(minutes=5); st, ev = fw.advance(st, issues_for(bad, t3)[0], t3, cfg); assert ev == [], "the reminder resets the hour"
    t4 = t3 + dt.timedelta(minutes=5); good = snap([room(now=t4)], now=t4); st, ev = fw.advance(st, issues_for(good, t4)[0], t4, cfg)
    assert [e["type"] for e in ev] == ["RESOLVED"] and ev[0]["duration_s"] >= 4200 and st["problems"] == {}
    st, ev = fw.advance(st, issues_for(good, t4)[0], t4, cfg); assert ev == []

@test
def a_room_silent_twenty_minutes_is_flagged_for_w21_once():
    cfg = fw.load_cfg(); r = room(); rid = r["room"]["id"]; st = {}; got = []
    for m in range(0, 26, 5):
        t = MON_NOON + dt.timedelta(minutes=m); s = snap([r], levels={rid: samples(t, 40, adv=False)}, now=t)
        st, ev = fw.advance(st, issues_for(s, t)[0], t, cfg); got += [(m, e["type"]) for e in ev]
    assert got.count((20, "W21")) == 1 and sum(1 for _, x in got if x == "W21") == 1 and got[0] == (0, "NEW"), got

@test
def clinic_hours_ending_resolves_the_problem_without_a_false_alarm():
    cfg = fw.load_cfg(); bad = snap([room(recording=False, state="ready")]); st, _ = fw.advance({}, issues_for(bad)[0], MON_NOON, cfg)
    st, ev = fw.advance(st, issues_for(bad, MON_NIGHT)[0], MON_NIGHT, cfg); assert [e["type"] for e in ev] == ["RESOLVED"] and "clinic hours" in ev[0]["detail"]

@test
def log_lines_and_messages_carry_only_room_code_detail_and_times():
    e = {"type": "NEW", "room": "OPD 1", "code": "NOT_RECORDING", "detail": "state=ready", "since": MON_NOON.isoformat()}
    l, m = fw.buglog_line(e, MON_NOON), fw.message(e)
    assert m.startswith("NF| fleet-watch NEW: OPD 1 NOT_RECORDING") and "\n" not in m and "12:00 IST" in l and l.count("|") == 4
    r = dict(e, type="RESOLVED", duration_s=719); assert fw.buglog_line(r, MON_NOON).endswith("after 12m"), "719 s reads as 12 minutes, not 11"

@test
def agreement_is_strict_on_rooms_recording_and_state():
    s = snap([room("A", "a"), room("B", "b", recording=False, state="finished")])
    ok = {"rooms": [{"room": "A", "recording": True, "state": "recording"}, {"room": "B", "recording": False, "state": "finished"}]}
    assert fw.agreement(ok, s)[0]
    assert not fw.agreement({"rooms": ok["rooms"][:1]}, s)[0], "a missing room disagrees"
    bad = json.loads(json.dumps(ok)); bad["rooms"][0]["recording"] = False; assert not fw.agreement(bad, s)[0]
    bad = json.loads(json.dumps(ok)); bad["rooms"][1]["state"] = "ready"; assert not fw.agreement(bad, s)[0]

@test
def model_output_parsing_is_strict_and_reads_cost_and_errors():
    good = "\n".join([json.dumps({"type": "tool_use", "part": {"tool": "scribe_scribe_rooms"}}), json.dumps({"type": "text", "part": {"text": 'x {"rooms": [], "fleet_issues": []} y'}}),
                      json.dumps({"type": "step_finish", "part": {"cost": 0.004, "tokens": {"input": 10, "output": 2, "reasoning": 1}}})])
    r = fw.parse_model_output(good); assert r["ok"] and r["cost"] == 0.004 and r["tools"] == ["scribe_scribe_rooms"]
    assert not fw.parse_model_output(json.dumps({"type": "text", "part": {"text": "I could not"}}))["ok"], "prose is not a report: a watcher fault"
    assert not fw.parse_model_output(json.dumps({"type": "text", "part": {"text": '{"no_rooms": 1}'}}))["ok"]
    err = fw.parse_model_output(json.dumps({"type": "error", "error": {"data": {"message": "Model access is disabled"}}})); assert not err["ok"] and "disabled" in err["error"]

def _door(s, calls):
    def call(name, args):
        calls.append(name)
        if name == "scribe_rooms": return s["now"] if args["view"] == "now" else s["fleet"]
        if name == "scribe_health": return s["health"]
        if name == "scribe_room_levels": return {"samples": s["levels"][args["room_id"]]}
        if name == "scribe_session_tape": return s.get("manifest", {"chunks": []})
        raise AssertionError("a tool outside the read-only set was called: " + name)
    return call

@test
def collect_calls_only_the_read_tools_and_health_at_most_every_fifteen_minutes():
    calls = []; s = snap([room(sid="bs_1"), room("B", "b")]); st = {}
    out = fw.collect(_door(s, calls), MON_NOON, st)
    assert set(calls) == {"scribe_rooms", "scribe_health", "scribe_room_levels", "scribe_session_tape"} and calls.count("scribe_room_levels") == 2 and calls.count("scribe_session_tape") == 1, "one manifest per RECORDING room"
    assert calls.count("scribe_health") == 1
    calls.clear(); fw.collect(_door(s, calls), MON_NOON + dt.timedelta(minutes=5), st); assert "scribe_health" not in calls, "the cached health is reused inside 15 minutes"
    s2 = snap([room(sid="bs_1")]); s2["fleet"] = {"rooms": s2["fleet"]["rooms"], "releases": {"stable": {"blob_url": "https://public.example/x.zip"}}}
    got = fw.collect(_door(s2, []), MON_NOON, {}); assert set(got["fleet"]) == {"rooms"} and "https://" not in json.dumps(got), "no URL survives collect"
    calls.clear(); fw.collect(_door(s, calls), MON_NOON + dt.timedelta(minutes=16), st); assert calls.count("scribe_health") == 1

@test
def cycle_reports_a_new_problem_exactly_once_and_a_door_failure_is_a_watcher_fault():
    cfg = fw.load_cfg(); sk = FakeSinks(); bad = snap([room(recording=False, state="ready")]); calls = []
    st, rec = fw.run_cycle(_door(bad, calls), cfg, sk, MON_NOON, {}, use_model=False)
    assert len(sk.msgs) == 1 and len(sk.bug) == 1 and rec["events"] == ["NEW:OPD 1:NOT_RECORDING"] and sk.hb[-1]["ok"]
    t1 = MON_NOON + dt.timedelta(minutes=5); st, rec = fw.run_cycle(_door(bad, calls), cfg, sk, t1, st, use_model=False)
    assert len(sk.msgs) == 1 and len(sk.bug) == 1, "the same problem is not re-reported"
    def dead(name, args): raise RuntimeError("door down")
    st2, rec = fw.run_cycle(dead, cfg, sk, t1, st, use_model=False)
    assert rec["watcher_fault"].startswith("door") and st2 == st and len(sk.msgs) == 1 and sk.hb[-1]["ok"] is False, "a dead door is the watcher's fault, never a room problem"

@test
def budget_reached_falls_back_to_deterministic_and_says_so_once_per_day():
    cfg = fw.load_cfg(); cfg["budget_usd_per_day"] = 0.01; sk = FakeSinks(); s = snap([room()])
    open(os.path.join(fw.RT, "cost.jsonl"), "w").write(json.dumps({"day": MON_NOON.astimezone(fw.IST).strftime("%Y-%m-%d"), "cost": 0.02}) + "\n")
    st, rec = fw.run_cycle(_door(s, []), cfg, sk, MON_NOON, {}, use_model=True); assert rec["mode"].startswith("deterministic-only") and len(sk.msgs) == 1
    t1 = MON_NOON + dt.timedelta(minutes=5); st, rec = fw.run_cycle(_door(s, []), cfg, sk, t1, st, use_model=True); assert len(sk.msgs) == 1, "told once per day"
    os.remove(os.path.join(fw.RT, "cost.jsonl"))

@test
def no_secret_name_or_token_handling_in_the_module_and_records_hold_no_free_text():
    src = open(os.path.join(HERE, "fleet_watch.py")).read()
    for bad in ("scribe_mcp_token", "opencode_zen_key", "Bearer", "getenv(\"SCRIBE", "SCRIBE_MCP_TOKEN"):
        assert bad not in src, bad
    sk = FakeSinks(); fw.run_cycle(_door(snap([room()]), []), fw.load_cfg(), sk, MON_NOON, {}, use_model=False)
    assert set(sk.rows[0]) <= {"ts", "mode", "watcher_fault", "rooms", "fleet_info", "events"}, sk.rows[0].keys()
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", sk.hb[0]["ts"]), "the heartbeat timestamp is ISO UTC with Z (minibot's format)"

@test
def exact_zero_tape_uses_the_strict_full_chunk_band_and_drops_links_at_once():
    r = room(); rid = r["room"]["id"]
    mk = lambda bps: {rid: {"idx": 7, "bps": bps}}
    assert codes(issues_for(snap([r], tape=mk(707.93)))[0]["OPD 1"]) == ["EXACT_ZERO_TAPE"]
    assert codes(issues_for(snap([r], tape=mk(3812.1)))[0]["OPD 1"]) == [] and codes(issues_for(snap([r], tape=mk(709.5)))[0]["OPD 1"]) == [], "outside the 707-709 band"
    assert codes(issues_for(snap([r], tape={rid: None}))[0]["OPD 1"]) == [], "an unreadable manifest is unmeasurable, not zero"
    m = {"chunks": [{"idx": 1, "duration_ms": 300000, "size_bytes": 212379, "presigned_get": "https://r2/x"}, {"idx": 2, "duration_ms": 120000, "size_bytes": 10, "presigned_get": "https://r2/y"}]}
    got = fw.chunk_bps(m); assert got == {"idx": 1, "bps": 707.93} or abs(got["bps"] - 707.93) < 0.01, got
    assert set(got) == {"idx", "bps"} and "presigned" not in json.dumps(got), "only two numbers survive"
    assert fw.chunk_bps({"chunks": [{"duration_ms": 90000, "size_bytes": 1}]}) is None, "a partial chunk is not measured"

@test
def only_the_expected_rooms_can_raise_a_problem_and_the_odd_room_name_is_normalised():
    bad = dict(recording=False, state="ready")
    assert codes(issues_for(snap([room("Dietary Room", "d", **bad)]))[0]["Dietary Room"]) == [] and "expected-recording" in issues_for(snap([room("Dietary Room", "d", **bad)]))[0]["Dietary Room"][0]["detail"]
    assert codes(issues_for(snap([room("OPD 7 -", "s", **bad)]))[0]["OPD 7 -"]) == ["NOT_RECORDING"], "'OPD 7 -' is the expected OPD 7"
    assert codes(issues_for(snap([room("Cardiology OPD", "c", **bad)]))[0]["Cardiology OPD"]) == ["NOT_RECORDING"]
    for n in ("Third Floor Consultation", "Home Office", "ORB3 extra"): 
        if n != "ORB3 extra": assert codes(issues_for(snap([room(n, "x", **bad)]))[0][n]) == [], n

@test
def the_heartbeat_is_written_atomically_temp_then_rename_and_the_logs_are_appended():
    captured = []; orig = fw.subprocess.run
    fw.subprocess.run = lambda cmd, **kw: captured.append(cmd) or type("R", (), {"returncode": 0})()
    try:
        s = fw.Sinks(fw.load_cfg()); s.heartbeat({"ts": "x"}); s.buglog("line"); s.jsonl({"a": 1})
    finally:
        fw.subprocess.run = orig
    hb = [c[-1] for c in captured if c[-1].endswith("heartbeat'") or "heartbeat" in c[-1]][0]; bl = [c[-1] for c in captured if "BUGLOG" in c[-1]][0]
    assert "heartbeat.tmp" in hb and "mv " in hb and ">>" not in hb, hb
    assert ">> " in bl and "mv " not in bl, bl

@test
def replay_with_an_injected_fault_reports_once_then_resolves_with_the_replayed_duration():
    sp = os.path.join(tempfile.mkdtemp(), "state.json"); s = snap([room(), room("OPD 3", "room_b")]); cfg = fw.load_cfg(); sk = FakeSinks()
    bad = json.loads(json.dumps(s)); bad["now"]["rooms"][0]["recording"] = False; bad["now"]["rooms"][0]["room_state"]["state"] = "ready"
    st, rec = fw.run_cycle(None, cfg, sk, MON_NOON, {}, use_model=False, snap=bad, label="[INJECTED TEST]", heartbeat=True)
    assert len(sk.msgs) == 1 and sk.msgs[0].endswith("[INJECTED TEST]") and sk.bug[0].endswith("[INJECTED TEST]")
    st, rec = fw.run_cycle(None, cfg, sk, MON_NOON + dt.timedelta(minutes=5), st, use_model=False, snap=bad, label="[INJECTED TEST]"); assert len(sk.msgs) == 1, "not repeated"
    t2 = MON_NOON + dt.timedelta(minutes=12); good = snap([room(now=t2), room("OPD 3", "room_b", now=t2)], now=t2)
    st, rec = fw.run_cycle(None, cfg, sk, t2, st, use_model=False, snap=good, label="[INJECTED TEST]", heartbeat=False)
    assert len(sk.hb) == 2 and sk.hb[-1]["ts"] == "2026-09-21T06:35:00Z", "the third cycle (heartbeat=False) wrote none"
    assert rec["replay"] == "[INJECTED TEST]" and sk.rows[-1]["replay"] == "[INJECTED TEST]"
    assert len(sk.msgs) == 2 and "RESOLVED" in sk.msgs[1] and "after 12m" in sk.bug[1], (sk.msgs, sk.bug)

@test
def a_failed_primary_model_is_retried_once_on_the_fallback_and_both_costs_are_counted():
    cfg = fw.load_cfg(); sk = FakeSinks(); s = snap([room()]); good = {"rooms": [{"room": "OPD 1", "recording": True, "state": "recording"}]}; orig = fw.run_model; seen = []
    def fake(cfg_, name=None, variant=None):
        seen.append(name or cfg_["model"]["name"])
        return {"ok": False, "error": "Model access is disabled", "cost": 0.0, "seconds": 1} if len(seen) == 1 else {"ok": True, "json": good, "cost": 0.004, "seconds": 2}
    fw.run_model = fake
    try:
        st, rec = fw.run_cycle(_door(s, []), cfg, sk, MON_NOON, {}, use_model=True)
    finally:
        fw.run_model = orig
    assert seen == [cfg["model"]["name"], cfg["model"]["fallback"]] and rec["model"] == cfg["model"]["fallback"] and rec["watcher_fault"] is None and rec["agrees"] is True and rec["cost"] == 0.004
    if os.path.exists(os.path.join(fw.RT, "cost.jsonl")): os.remove(os.path.join(fw.RT, "cost.jsonl"))

@test
def a_replay_with_an_overridden_clock_shifts_every_snapshot_timestamp_so_it_stays_healthy():
    s = snap([room(), room("OPD 3", "room_b")]); cfg = fw.load_cfg(); t2 = MON_NOON + dt.timedelta(minutes=12)
    assert codes(issues_for(s, t2)[0]["OPD 1"]) == ["PIECES_STALLED"], "unshifted, 12 minutes later the pieces look stale"
    sh = fw.shift_snapshot(json.loads(json.dumps(s)), dt.timedelta(minutes=12))
    for r in ("OPD 1", "OPD 3"): assert codes(issues_for(sh, t2)[0][r]) == [], r
    assert abs(sh["levels"]["room_a"][-1]["t_ms"] - (s["levels"]["room_a"][-1]["t_ms"] + 720000)) < 1

@test
def a_config_file_override_is_read_and_a_zero_budget_forces_deterministic_only():
    d = tempfile.mkdtemp(); cp = os.path.join(d, "config.json"); json.dump({"budget_usd_per_day": 0.0, "known": {"OPD 1": {"NOT_RECORDING": "test"}}, "clinic": {"start": "09:00"}}, open(cp, "w"))
    cfg = fw.load_cfg(cp); assert cfg["budget_usd_per_day"] == 0.0 and cfg["clinic"]["start"] == "09:00" and cfg["clinic"]["end"] == "20:00" and cfg["known"]["OPD 1"]["NOT_RECORDING"] == "test", "nested dicts merge, unmentioned keys keep their defaults"
    sk = FakeSinks(); st, rec = fw.run_cycle(_door(snap([room()]), []), cfg, sk, MON_NOON, {}, use_model=True)
    assert rec["mode"].startswith("deterministic-only") and rec["watcher_fault"] is None

@test
def real_sinks_need_mode_live_in_the_run_home():
    d = tempfile.mkdtemp(); assert not fw.live_mode_ok(d), "no MODE file: not live"
    open(os.path.join(d, "MODE"), "w").write("dry\n"); assert not fw.live_mode_ok(d)
    open(os.path.join(d, "MODE"), "w").write("live\n"); assert fw.live_mode_ok(d)
    old_rt = fw.RT; fw.RT = tempfile.mkdtemp()      # a scratch home, as a stray --once from a temp copy would have
    try:
        assert fw.main(["--once"]) == 4 and fw.main(["--loop"]) == 4, "no MODE=live: refused, no sink touched"
        assert fw.main(["--replay", "/nonexistent.json"]) == 4, "a replay to real sinks is refused too"
        open(os.path.join(fw.RT, "MODE"), "w").write("dry")
        assert fw.main(["--once"]) == 4, "MODE=dry: refused"
    finally:
        fw.RT = old_rt

@test
def a_real_sink_replay_refuses_while_the_loop_holds_the_lock():
    old_rt = fw.RT; fw.RT = tempfile.mkdtemp(); open(os.path.join(fw.RT, "MODE"), "w").write("live")
    snapf = os.path.join(fw.RT, "snap.json"); json.dump({"ts": "2026-09-21T06:30:00+00:00", "now": {"rooms": []}}, open(snapf, "w"))
    held = open(os.path.join(fw.RT, "lock"), "w"); fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        assert fw.main(["--replay", snapf]) == 3, "loop holds the lock: refused before any sink is touched"
    finally:
        held.close(); fw.RT = old_rt

def _jsonc(path):
    s = re.sub(r"^\s*//.*$", "", open(path).read(), flags=re.M); return json.loads(s)

@test
def the_opencode_config_gives_the_agent_only_the_local_proxy_and_never_the_remote_mcp_or_the_scribe_token():
    c = _jsonc(os.path.join(HERE, "opencode.jsonc.template")); raw = open(os.path.join(HERE, "opencode.jsonc.template")).read()
    assert list(c["mcp"]) == ["scribe-fleet"] and c["mcp"]["scribe-fleet"]["type"] == "local", "no remote Scribe MCP"
    assert "scribe_mcp_token" not in raw and "evenscribe.app" not in raw and "Authorization" not in raw, "no Scribe token reference, URL or header in the agent's config"
    on = sorted(k for k, v in c["tools"].items() if v is True)
    assert c["tools"]["*"] is False and on == ["scribe-fleet_scribe_health", "scribe-fleet_scribe_rooms", "scribe-fleet_scribe_sessions", "scribe-fleet_scribe_system"], on
    a = c["agent"]["fleet-watch"]["tools"]; assert a["*"] is False and sorted(k for k, v in a.items() if v is True) == on
    writes = "room_command post_cue mark_consult pin_visit set_visit_clinician job_submit job_cancel silence_readjudicate transcribe_range extract_audio jev_window_run scratch".split()
    assert not [w for w in writes if any(k.endswith("scribe_" + w) and v for k, v in c["tools"].items())]
    assert not any("session_tape" in k and v for k, v in list(c["tools"].items()) + list(a.items())), "r402: the agent never gets scribe_session_tape (presigned audio links)"
    assert all(c["permission"][k] == "deny" for k in ("edit", "bash", "webfetch")), "no shell, no edits, no web"
    assert c["agent"]["title"]["disable"] is True, "no hidden title call to another model"
    assert "{file:/home/eta/.claude/secrets/opencode_zen_key}" in raw and not re.search(r"(sk-|Bearer [A-Za-z0-9]{16,}|eyJ[A-Za-z0-9]{10,})", raw), "the Zen key only by file reference"


def main():
    bad = 0
    for f in T:
        try: f()
        except Exception as ex:
            bad += 1; print("FAIL", f.__name__, "->", repr(ex)[:300])
    print("fleet_watch tests: %d run, %d failed" % (len(T), bad)); return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
