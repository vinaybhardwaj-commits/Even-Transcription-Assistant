import json, os, sys, time, datetime as dt
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import daily_recon as D

DATE = "2026-10-09"; NOW = dt.datetime(2026, 10, 10, 12, 0, tzinfo=D.IST).timestamp()
def w(p, text): os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(text)
def jl(rows): return "".join(json.dumps(r) + "\n" for r in rows)
def clip(uid, room, status="cut", t_close="2026-10-09 05:00:00", **kw):
    kw.setdefault("r2", {"status": "mirrored"}); kw.setdefault("t_open", "2026-10-09 04:50:00.000"); return dict(consult_uid=uid, ist_date=DATE, room_id=room, status=status, t_close=t_close, **kw)
def visit(uid, room, a="2026-10-09T10:00:00+05:30", b="2026-10-09T10:10:00+05:30"): return dict(step_uid=uid, room_id=room, doctor_uid="d9", start=a, end=b, room_unknown_reason=None if room else "no_schedule_slot")
def tracks(eta, room, uid, names):
    for n in names: w(f"{eta}/reb/{DATE}/{room}/_consults/{uid}/tracks/{n}", json.dumps({"status": "empty" if n.startswith("role") else "ok"}))
OTHER = dict(consult_uid="other", ist_date="2026-10-08", room_id="rA", status="cut", t_open="2026-10-08 04:00:00", t_close="2026-10-08 04:10:00")          # an index row of another day: the index is not empty
ALL = ["stt.sarvam-saaras-v3__a.json", "diar.nemotron__a.json", "role.text-judge__a.json", "acoustics.x__a.json"]

@pytest.fixture(autouse=True)
def lockpath(tmp_path, monkeypatch): monkeypatch.setattr(D, "MANIFEST_LOCK", str(tmp_path / "lock" / ".manifest.lock"))

@pytest.fixture
def eta(tmp_path):
    e = str(tmp_path / "eta"); w(f"{e}/labels.json", json.dumps({"rooms": [{"room_id": "rA", "label": "OPD A"}, {"room_id": "rB", "label": "OPD B"}, {"room_id": "rO", "label": "ORB2 (OT2)"}]})); return e

def go(eta, visits, clips, tape=(), **kw):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": visits}))
    w(f"{eta}/consult/clips/index.jsonl", jl(clips))
    w(f"{eta}/tapes/manifest.jsonl", jl([dict(room_id=r, started_at="2026-10-09T03:00:00.000Z", duration_ms=int(h * 3.6e6)) for r, h in tape]))
    return D.run(DATE, eta, f"{eta}/labels.json", f"{eta}/out", f"{eta}/ALERTS.jsonl", no_db=True, now=NOW, **kw)

def msgs(rep): return [a['message'] for a in rep['alerts']]
def room(rep, rid): return next(r for r in rep["rooms"] if r["room_id"] == rid)

def test_clean_day_no_alerts_and_outputs(eta):
    cl = []
    for i in range(5): cl.append(clip(f"u{i}", "rA", boundary_source="pulse")); tracks(eta, "rA", f"u{i}", ALL)
    rep = go(eta, [visit(f"v{i}", "rA") for i in range(5)], cl, tape=[("rA", 3)])
    assert rep["alerts"] == [] and room(rep, "rA")["clips_cut"] == 5 and room(rep, "rA")["lanes"]["sarvam"] == 5 and room(rep, "rA")["tape_h"] == 3.0
    assert [r["room_id"] for r in rep["rooms"]] == ["rA", "rB"]          # ORB excluded, empty room B present
    assert json.load(open(f"{eta}/out/{DATE}.json"))["date"] == DATE and "Daily reconciliation" in open(f"{eta}/out/{DATE}.md").read()
    assert not os.path.exists(f"{eta}/ALERTS.jsonl") and not [f for f in os.listdir(f"{eta}/out") if ".tmp" in f]

def test_tape_without_clips_alert(eta):
    rep = go(eta, [], [], tape=[("rB", 2.0), ("rA", 1.9)])
    assert len([a for a in rep["alerts"] if a["code"] == "tape_no_clips"]) == 1 and rep["alerts"][0]["room"] == "OPD B"

def test_clip_ratio_threshold_is_80_percent(eta):
    cl = [clip(f"u{i}", "rA") for i in range(4)]
    for c in cl: tracks(eta, "rA", c["consult_uid"], ALL)
    assert not [a for a in go(eta, [visit(f"v{i}", "rA") for i in range(5)], cl)["alerts"] if a["code"] == "clips_low"]       # 4/5 = 80%
    for c in cl[:3]: pass
    assert [a for a in go(eta, [visit(f"v{i}", "rA") for i in range(6)], cl)["alerts"] if a["code"] == "clips_low"]            # 4/6 = 66%

def test_lane_alert_respects_grace_and_95(eta):
    cl = [clip(f"u{i}", "rA") for i in range(20)]
    for i, c in enumerate(cl): tracks(eta, "rA", c["consult_uid"], ALL if i else ALL[:3])          # one clip lacks acoustics: 19/20 = 95% passes
    assert not [a for a in go(eta, [], cl)["alerts"] if a["code"].startswith("lane")]
    tracks(eta, "rA", "u1", []); os.remove(f"{eta}/reb/{DATE}/rA/_consults/u1/tracks/stt.sarvam-saaras-v3__a.json")
    os.remove(f"{eta}/reb/{DATE}/rA/_consults/u2/tracks/stt.sarvam-saaras-v3__a.json"); a = [x["message"] for x in go(eta, [], cl)["alerts"] if x["code"] == "lane_sarvam_low"]
    assert len(a) == 1 and "18 of 20" in a[0]
    young = [clip(f"y{i}", "rA", t_close="2026-10-10 10:30:00") for i in range(10)]                    # 10:30 IST, 1.5 h before NOW: inside the grace
    assert not [x for x in go(eta, [], young)["alerts"] if x["code"].startswith("lane")]

def test_r2_pending_and_unplaced_alerts(eta):
    c = clip("u0", "rA"); c["r2"] = {"status": "pending"}; tracks(eta, "rA", "u0", ALL)
    vis = [visit("a", "rA")] + [visit(f"x{i}", None) for i in range(2)] + [visit("b", "rA"), visit("c", "rA")]          # 2 of 5 = 40% unplaced
    rep = go(eta, vis, [c]); t = " ".join(msgs(rep))
    assert "1 clips not yet mirrored" in t and "2 of 5 visits have no room" in t and rep["day"]["unplaced_reasons"] == {"no_schedule_slot": 2}
    ok = go(eta, [visit("a", "rA")] * 1 + [visit(f"y{i}", "rA") for i in range(3)] + [visit("z", None)], [])          # 1 of 5 = 20%: not over
    assert not [a for a in ok["alerts"] if a["code"] == "unplaced_high"]

def test_not_cut_reasons_and_visit_miss(eta):
    cl = [clip("s", "rA", status="skipped", skip_reason="final after 24 h: no_session"), clip("p", "rA", boundary_source="pqm", pqm_step_uid="v1")]
    tracks(eta, "rA", "p", ALL); rep = go(eta, [visit("v1", "rA"), visit("v2", "rA")], cl); r = room(rep, "rA")
    assert r["not_cut_reasons"] == {"final after 24 h: no_session": 1} and r["visit_miss_reasons"] == {"no_cut_clip": 1} and r["clips_pqm"] == 1

def test_latest_row_wins_and_bad_index_line_counted(eta):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": []}))
    w(f"{eta}/consult/clips/index.jsonl", jl([clip("u", "rA", status="deferred_long")]) + "{broken\n" + jl([clip("u", "rA")])); w(f"{eta}/tapes/manifest.jsonl", "")
    rep = D.run(DATE, eta, f"{eta}/labels.json", f"{eta}/out", f"{eta}/A.jsonl", no_db=True, now=NOW)
    assert room(rep, "rA")["clips_cut"] == 1 and rep["bad_input_lines"] == 1

def test_room_with_no_data_is_all_zero(eta):
    r = room(go(eta, [], []), "rB")
    assert r["placed"] == 0 and r["clips_cut"] == 0 and r["tape_h"] == 0 and r["pulse_windows"] == 0 and all(v == 0 for v in r["lanes"].values())

def test_placed_file_overrides_room(eta):
    w(f"{eta}/drtpqma/{DATE}/encounters.placed.json", json.dumps({"encounters": [dict(step_uid="v1", room_id="rB")]}))
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": [visit("v1", None)]}))
    assert D.load_visits(eta, DATE)[0]["room_id"] == "rB"

def test_alerts_line_format(eta):
    go(eta, [], [], tape=[("rA", 5)]); line = json.loads(open(f"{eta}/ALERTS.jsonl").read().splitlines()[0])
    assert {"at", "source", "alert"} <= set(line) and line["source"] == "daily_recon" and line["code"] == "tape_no_clips" and line["room"] == "OPD A" and oct(os.stat(f"{eta}/ALERTS.jsonl").st_mode)[-3:] == "600"

def test_alert_dedupe_and_supersede(eta):
    lines = lambda: [json.loads(l) for l in open(f"{eta}/ALERTS.jsonl")]
    go(eta, [], [], tape=[("rA", 5)]); go(eta, [], [], tape=[("rA", 5)])
    assert len(lines()) == 1                                                  # same key, same count: nothing appended
    go(eta, [], [], tape=[("rA", 5), ("rB", 3)]); assert len(lines()) == 2 and not any(l.get("superseded") for l in lines())    # new key rB appended
    go(eta, [], [], tape=[("rA", 6), ("rB", 3)]); L = lines()
    assert len(L) == 3 and L[-1]["superseded"] is True and L[-1]["room"] == "OPD A" and L[-1]["count"] == 6      # changed count: new superseded line

def test_missing_encounters_is_nodata_not_broken(eta, capsys):
    w(f"{eta}/consult/clips/index.jsonl", ""); w(f"{eta}/tapes/manifest.jsonl", "")
    assert D.main(["--date", DATE, "--eta-data", eta, "--labels", f"{eta}/labels.json", "--no-db", "--no-r2"]) == 0
    rep = json.load(open(f"{eta}/consult/recon/{DATE}.json"))
    assert rep["pqm_present"] is False and all(r["status"] == "nodata" for r in rep["rooms"]) and [a["code"] for a in rep["alerts"]] == ["pqm_missing"]

class FakeR2:
    def __init__(self, man=None): self.o = {} if man is None else {"enc/manifest.json": json.dumps(man).encode()}
    def get_object(self, Bucket, Key):
        if Key not in self.o: raise Exception("NoSuchKey")
        import io; return {"Body": io.BytesIO(self.o[Key])}
    def put_object(self, Bucket, Key, Body, ContentType=None): assert Bucket == "eta-lab-results"; self.o[Key] = Body

def exp(eta, visits, clips, client, tape=()):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": visits})); w(f"{eta}/consult/clips/index.jsonl", jl(clips)); w(f"{eta}/tapes/manifest.jsonl", "")
    return D.run(DATE, eta, f"{eta}/labels.json", f"{eta}/out", f"{eta}/ALERTS.jsonl", no_db=True, now=NOW, no_r2=False, client=client)

def test_export_rows_and_manifest_merge(eta):
    import hashlib
    cl = [clip("u0", "rA", doctor_uid="d1", room_source="schedule", r2={"status": "mirrored", "prefix": "consult-clips/x/"}), clip("s", "rA", status="skipped", skip_reason="no_session")]
    tracks(eta, "rA", "u0", ALL); fk = FakeR2(man={"2026-10-01": {"sha256": "a", "rows": 1, "isolation_sha256": "b", "isolation_rows": 2}})
    rep = exp(eta, [visit("v1", "rA")], cl, fk)
    daily = json.loads(fk.o[f"enc/daily/{DATE}.json"]); iso = [json.loads(l) for l in fk.o[f"enc/isolation/{DATE}.jsonl"].decode().splitlines()]
    assert {d["room_id"] for d in daily} == {"rA", "rB"} and next(d for d in daily if d["room_id"] == "rA")["isolated"] == 1 and daily[0]["lane_parts"] == 0
    assert set(daily[0]) == {"ist_date", "room_id", "visits", "placed", "isolated", "isolated_pulse", "isolated_pqm", "not_isolated", "lane_sarvam", "lane_nemotron", "lane_role", "lane_parts", "rx_matched", "tape_hours", "status", "alerts", "computed_at", "source"}
    by = {r["consult_uid"]: r for r in iso}
    assert by["u0"]["status"] == "cut" and by["u0"]["r2_prefix"] == "consult-clips/x/" and by["u0"]["lanes"]["sarvam"] is True and by["u0"]["parts"] is None and by["u0"]["rx"] is None and by["u0"]["t_start"].endswith("+05:30") and all("updated_at" not in r for r in iso)
    assert by["s"]["status"] == "skipped" and by["s"]["skip_reason"] == "no_session" and by["planned_v1"]["status"] == "planned" and by["planned_v1"]["pqm_step_uid"] == "v1"
    man = json.loads(fk.o["enc/manifest.json"]); e = man[DATE]
    assert "2026-10-01" in man and e["sha256"] == hashlib.sha256(fk.o[f"enc/daily/{DATE}.json"]).hexdigest() and e["rows"] == 2 and e["isolation_rows"] == 3 and e["isolation_sha256"] == hashlib.sha256(fk.o[f"enc/isolation/{DATE}.jsonl"]).hexdigest()
    assert rep["export"]["uploaded"] is True

def test_no_r2_uploads_nothing(eta):
    class Boom:
        def __getattr__(self, n): raise AssertionError("R2 touched")
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": []})); w(f"{eta}/consult/clips/index.jsonl", jl([OTHER])); w(f"{eta}/tapes/manifest.jsonl", "")
    rep = D.run(DATE, eta, f"{eta}/labels.json", f"{eta}/out", f"{eta}/A.jsonl", no_db=True, now=NOW, no_r2=True, client=Boom())
    assert rep["export"] == dict(daily_rows=2, isolation_rows=0, uploaded=False, refused=[])

def test_leak_guard_blocks_doctor_name_and_uploads_nothing(eta):
    import index_mirror as IM
    cl = [clip("u0", "rA", doctor_name="Dr Zorblatt Quimby", status="skipped", skip_reason="seen with Zorblatt Quimby")]; fk = FakeR2()
    w(f"{eta}/consult/clips/index.jsonl", jl(cl))
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": []})); w(f"{eta}/tapes/manifest.jsonl", "")
    old = IM.INDEX; IM.INDEX = f"{eta}/consult/clips/index.jsonl"
    try:
        with pytest.raises(IM.LeakError): D.run(DATE, eta, f"{eta}/labels.json", f"{eta}/out", f"{eta}/A.jsonl", no_db=True, now=NOW, no_r2=False, client=fk)
    finally: IM.INDEX = old
    assert fk.o == {} and not os.path.exists(f"{eta}/out/{DATE}.json")

def test_r2_failure_exit_4_local_written(eta, monkeypatch):
    import index_mirror as IM
    monkeypatch.setattr(IM, "r2_client", lambda *a, **k: (_ for _ in ()).throw(IM.ConfigError("credential file unreadable")))
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": []})); w(f"{eta}/consult/clips/index.jsonl", jl([OTHER])); w(f"{eta}/tapes/manifest.jsonl", "")
    assert D.main(["--date", DATE, "--eta-data", eta, "--labels", f"{eta}/labels.json", "--no-db"]) == 4 and os.path.exists(f"{eta}/consult/recon/{DATE}.json")

@pytest.mark.parametrize("bad", ["{not json", json.dumps({"nope": 1}), json.dumps({"encounters": [{"x": 1}]})])
def test_malformed_encounters_exits_2(eta, bad, capsys):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", bad)
    assert D.main(["--date", DATE, "--eta-data", eta, "--labels", f"{eta}/labels.json", "--no-db", "--no-r2"]) == 2 and "BROKEN INPUT" in capsys.readouterr().err

def test_bad_labels_exit_2(eta):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": []})); w(f"{eta}/labels.json", "[]")
    assert D.main(["--date", DATE, "--eta-data", eta, "--labels", f"{eta}/labels.json", "--no-db"]) == 2

def test_exit_0_when_alerts_fire(eta):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": [visit(f"x{i}", None) for i in range(5)]}))
    assert D.main(["--date", DATE, "--eta-data", eta, "--labels", f"{eta}/labels.json", "--no-db", "--no-r2"]) == 0
    assert os.path.exists(f"{eta}/consult/recon/{DATE}.json")

def test_processed_needs_three_lanes_ok_or_empty(eta):
    tracks(eta, "rA", "a", ALL); tracks(eta, "rA", "b", ALL[:2])                            # b lacks role.text-judge
    tracks(eta, "rA", "c", ALL); w(f"{eta}/reb/{DATE}/rA/_consults/c/tracks/diar.nemotron__a.json", json.dumps({"status": "failed"}))
    tracks(eta, "rA", "d", ALL); w(f"{eta}/reb/{DATE}/rA/_consults/d/tracks/stt.sarvam-saaras-v3__a.json", "{broken")
    rep = go(eta, [], [clip(u, "rA") for u in "abcd"]); r = room(rep, "rA")
    assert r["processed"] == 1 and r["lanes"]["nemotron"] == 3 and r["lanes"]["sarvam"] == 3 and r["lanes"]["role"] == 3        # role "empty" counts

# ---- Python mirror of ETA lib/enc/schemas.ts (zod .strict() field lists), copied from the Mini worktree agent-a1e834b503cd45772 ----
import re as _re
_ID = lambda v: isinstance(v, str) and 1 <= len(v) <= 128
_CNT = lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= 0
_DATE = lambda v: isinstance(v, str) and _re.match(r"^\d{4}-\d{2}-\d{2}$", v) is not None
def _TIME(v):
    if not (isinstance(v, str) and 10 <= len(v) <= 40): return False
    try: dt.datetime.fromisoformat(v.replace("Z", "+00:00")); return True
    except ValueError: return False
_NUM = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
_opt = lambda f: (lambda v: v is None or f(v))
def _alert(a): return isinstance(a, dict) and set(a) == {"code", "message", "count"} and isinstance(a["code"], str) and 1 <= len(a["code"]) <= 64 and isinstance(a["message"], str) and len(a["message"]) <= 300 and _CNT(a["count"])
DAILY = dict(ist_date=_DATE, room_id=_ID, visits=_CNT, placed=_CNT, isolated=_CNT, isolated_pulse=_CNT, isolated_pqm=_CNT, not_isolated=_CNT, lane_sarvam=_CNT, lane_nemotron=_CNT, lane_role=_CNT, lane_parts=_CNT, rx_matched=_CNT,
             tape_hours=lambda v: _NUM(v) and 0 <= v <= 1000, status=lambda v: v in ("ok", "warn", "alert", "nodata"), alerts=lambda v: isinstance(v, list) and len(v) <= 50 and all(_alert(a) for a in v), computed_at=_TIME, source=lambda v: isinstance(v, str) and 1 <= len(v) <= 128)
ISO = dict(consult_uid=_ID, ist_date=_DATE, room_id=_ID, doctor_uid=_opt(_ID), t_start=_TIME, t_end=_TIME, boundary_source=lambda v: v in ("pulse", "pqm", "hyp", "refined"), room_source=_opt(lambda v: isinstance(v, str) and len(v) <= 64),
           confidence=_opt(lambda v: _NUM(v) and 0 <= v <= 1), status=lambda v: v in ("cut", "skipped", "deferred", "planned"), skip_reason=_opt(lambda v: isinstance(v, str) and len(v) <= 120), r2_prefix=_opt(lambda v: isinstance(v, str) and len(v) <= 300),
           lanes=lambda v: isinstance(v, dict) and all(isinstance(k, str) and len(k) <= 32 and isinstance(x, bool) for k, x in v.items()), parts=_opt(lambda v: isinstance(v, list)), rx=_opt(lambda v: isinstance(v, dict)), pqm_step_uid=_opt(_ID))
OPTIONAL = {"doctor_uid", "room_source", "confidence", "skip_reason", "r2_prefix", "parts", "rx", "pqm_step_uid"}     # zod .optional(): the key may be absent; we always send them (null)
def check(row, spec):
    extra = set(row) - set(spec); missing = {k for k in set(spec) - set(row) if k not in OPTIONAL}
    bad = [k for k, f in spec.items() if k in row and not f(row[k])]
    return extra, missing, bad

def test_every_exported_row_validates_against_the_eta_schema(eta):
    cl = [clip("u0", "rA", doctor_uid="d1", room_source="schedule", r2={"status": "mirrored", "prefix": "consult-clips/x/"}), clip("s", "rA", status="skipped", skip_reason="no_session"), clip("e", "rA", status="error"),
          clip("n", None, status="skipped", skip_reason="x"), clip("t", "rA", status="deferred_long", t_open="2026-10-09T04:00:00Z", t_close="2026-10-09T04:30:00+05:30")]
    tracks(eta, "rA", "u0", ALL); fk = FakeR2(); exp(eta, [visit("v1", "rA"), visit("v2", None)], cl, fk)
    daily = json.loads(fk.o[f"enc/daily/{DATE}.json"]); iso = [json.loads(l) for l in fk.o[f"enc/isolation/{DATE}.jsonl"].decode().splitlines()]
    assert daily and iso
    for r in daily: assert check(r, DAILY) == (set(), set(), []), r
    for r in iso: assert check(r, ISO) == (set(), set(), []), r
    by = {r["consult_uid"]: r for r in iso}
    assert by["e"]["status"] == "skipped" and by["e"]["skip_reason"] == "error" and by["n"]["room_id"] == "unplaced" and by["t"]["status"] == "deferred" and by["t"]["t_start"].startswith("2026-10-09T09:30")
    man = json.loads(fk.o["enc/manifest.json"])[DATE]
    assert set(man) == {"sha256", "rows", "isolation_sha256", "isolation_rows"} and all(_re.match(r"^[0-9a-f]{64}$", man[k]) for k in ("sha256", "isolation_sha256"))

def test_bad_ids_dropped_with_alert(eta):
    fk = FakeR2(); rep = exp(eta, [], [clip("good_1-A", "rA"), clip("bad id!", "rA"), clip("ok2", "room/../x")], fk)
    assert [json.loads(l)["consult_uid"] for l in fk.o[f"enc/isolation/{DATE}.jsonl"].decode().splitlines()] == ["good_1-A"]
    assert [a for a in rep["alerts"] if a["code"] == "bad_id"][0]["count"] == 2

def test_not_isolated_uses_the_50_percent_overlap_rule(eta):
    # visit window 10:00-10:10 +-60 s = 720 s; a clip covering exactly 360 s covers it, 359 s does not
    v = [visit("v1", "rA"), visit("v2", "rA", a="2026-10-09T12:00:00+05:30", b="2026-10-09T12:10:00+05:30")]
    cl = [clip("c1", "rA", t_open="2026-10-09 09:59:00", t_close="2026-10-09 10:05:00"), clip("c2", "rA", t_open="2026-10-09 11:59:00", t_close="2026-10-09 11:58:59"[:0] + "2026-10-09 12:04:59")]
    rep = go(eta, v, cl); r = room(rep, "rA")
    assert r["not_isolated"] == 1 and r["visit_miss_reasons"] == {"no_cut_clip": 1}

def _refuse_main(eta, fk, monkeypatch):
    import index_mirror as IM
    monkeypatch.setattr(IM, "r2_client", lambda *a, **k: fk)
    return D.main(["--date", DATE, "--eta-data", eta, "--labels", f"{eta}/labels.json", "--no-db"])

def test_refuses_pqm_missing_exit_3_local_written(eta, monkeypatch):
    w(f"{eta}/consult/clips/index.jsonl", jl([clip("u0", "rA")])); w(f"{eta}/tapes/manifest.jsonl", ""); fk = FakeR2()
    assert _refuse_main(eta, fk, monkeypatch) == 3 and fk.o == {} and os.path.exists(f"{eta}/consult/recon/{DATE}.json") and os.path.exists(f"{eta}/consult/recon/{DATE}.md")

def test_refuses_missing_index_and_missing_tape_manifest(eta, monkeypatch):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": [visit("v1", "rA")]})); w(f"{eta}/tapes/manifest.jsonl", ""); fk = FakeR2()
    assert _refuse_main(eta, fk, monkeypatch) == 3 and fk.o == {}
    w(f"{eta}/consult/clips/index.jsonl", ""); os.remove(f"{eta}/tapes/manifest.jsonl")
    assert _refuse_main(eta, fk, monkeypatch) == 3 and fk.o == {}

def test_refuses_partial_run_when_neon_windows_fail(eta, monkeypatch):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": []})); w(f"{eta}/consult/clips/index.jsonl", ""); w(f"{eta}/tapes/manifest.jsonl", "")
    monkeypatch.setattr(D, "load_windows", lambda d, n=False: (None, True)); fk = FakeR2()
    import index_mirror as IM; monkeypatch.setattr(IM, "r2_client", lambda *a, **k: fk)
    assert D.main(["--date", DATE, "--eta-data", eta, "--labels", f"{eta}/labels.json"]) == 3 and fk.o == {}

def test_refuses_zero_rows_over_existing_rows(eta):
    fk = FakeR2(man={DATE: {"sha256": "a" * 64, "rows": 8, "isolation_sha256": "b" * 64, "isolation_rows": 5}})
    with pytest.raises(D.Refused): exp(eta, [], [OTHER], fk)
    assert set(fk.o) == {"enc/manifest.json"}
    ok = FakeR2(); exp(eta, [], [OTHER], ok); assert json.loads(ok.o["enc/manifest.json"])[DATE]["isolation_rows"] == 0          # first export of an empty day is allowed

def test_manifest_reread_under_lock_keeps_a_date_written_meanwhile(eta):
    class Racy(FakeR2):
        n = 0
        def get_object(self, Bucket, Key):
            r = super().get_object(Bucket, Key)
            if Key == "enc/manifest.json":
                Racy.n += 1
                if Racy.n == 1: self.o["enc/manifest.json"] = json.dumps({"2026-10-11": {"sha256": "c" * 64, "rows": 1, "isolation_sha256": "d" * 64, "isolation_rows": 1}}).encode()      # a second writer lands after our first read
            return r
    fk = Racy(man={}); exp(eta, [], [clip("u", "rA")], fk); assert set(json.loads(fk.o["enc/manifest.json"])) == {DATE, "2026-10-11"}
    assert os.path.exists(D.MANIFEST_LOCK) and not os.path.exists(f"{eta}/out/.manifest.lock")

def test_iso_t_times_parse():
    assert D.parse_ts("2026-10-09T10:00:00+05:30") == D.parse_ts("2026-10-09 10:00:00") == D.parse_ts("2026-10-09T04:30:00Z") and D.parse_ts("garbage") is None

def test_slug_guard_is_upload_only_and_override_passes(eta, monkeypatch):
    import index_mirror as IM
    cl = [clip("u0", "rA", doctor_name="Dr Zorblatt Quimby", room_slug="zorblatt-opd-1", r2={"status": "mirrored", "prefix": "consult-clips/p/"})]
    w(f"{eta}/consult/clips/index.jsonl", jl(cl)); w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": []})); w(f"{eta}/tapes/manifest.jsonl", "")
    monkeypatch.setattr(IM, "INDEX", f"{eta}/consult/clips/index.jsonl"); monkeypatch.delenv("INDEX_MIRROR_SKIP_SLUG_GUARD", raising=False)
    args = (DATE, eta, f"{eta}/labels.json", f"{eta}/out", f"{eta}/A.jsonl")
    D.run(*args, no_db=True, now=NOW, no_r2=True)                                   # local report, alerts and payload copy: no slug guard
    assert os.path.exists(f"{eta}/out/{DATE}.json") and os.path.exists(f"{eta}/out/enc/isolation/{DATE}.jsonl")
    fk = FakeR2()
    with pytest.raises(IM.SlugNameError): D.run(*args, no_db=True, now=NOW, no_r2=False, client=fk)
    assert fk.o == {} and os.path.exists(f"{eta}/out/{DATE}.md")
    monkeypatch.setenv("INDEX_MIRROR_SKIP_SLUG_GUARD", "1"); D.run(*args, no_db=True, now=NOW, no_r2=False, client=fk)
    assert "enc/manifest.json" in fk.o

def test_refuses_empty_index(eta, monkeypatch):
    w(f"{eta}/drtpqma/{DATE}/encounters.json", json.dumps({"encounters": [visit("v1", "rA")]})); w(f"{eta}/consult/clips/index.jsonl", ""); w(f"{eta}/tapes/manifest.jsonl", ""); fk = FakeR2()
    assert _refuse_main(eta, fk, monkeypatch) == 3 and fk.o == {}

def test_refuses_zero_clip_rows_over_existing_cut_rows(eta):
    other = clip("z", "rA"); other["ist_date"] = "2026-10-08"                    # index has rows, none for DATE
    prev = FakeR2(man={DATE: {"sha256": "a" * 64, "rows": 8, "isolation_sha256": "b" * 64, "isolation_rows": 1}})
    prev.o[f"enc/isolation/{DATE}.jsonl"] = (json.dumps({"consult_uid": "u", "status": "cut"}, sort_keys=True) + "\n").encode()
    with pytest.raises(D.Refused): exp(eta, [visit("v1", "rA")], [other], prev)             # would export one planned row over a cut row
    assert f"enc/daily/{DATE}.json" not in prev.o
    fresh = FakeR2(); exp(eta, [visit("v1", "rA")], [other], fresh); assert "enc/manifest.json" in fresh.o      # nothing in R2 yet: allowed
