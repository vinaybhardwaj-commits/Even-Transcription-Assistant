import hashlib
import json
import os
import types

import pytest

from kit.reb import s2_driver as d
from kit.reb import write_track
from kit.reb.writer import config_hash

ROOM = "room_aaaa1111"
T0_W39 = 1790400000000        # 2026-09-26 (ISO week 39, IST)
T0_W40 = 1790900000000        # 2026-10-01 (ISO week 40, IST)
DATE = {"39": "2026-09-26", "40": "2026-10-01"}


def put(root, wid, date, layer, engine, segs, status="ok", stub=None):
    cfg = {"e": engine, "w": wid}
    t = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1", "config": cfg,
         "config_hash": config_hash(cfg), "machine": "t", "status": status, "reason": None if status == "ok" else "r", "segments": segs}
    return write_track(root, date, ROOM, wid, t, manifest_stub=stub)


ALT = [(i * 20, i * 20 + 18, str(i % 2)) for i in range(15)]


@pytest.fixture
def store(tmp_path):
    root, data, tapes = tmp_path / "reb", tmp_path / "data", tmp_path / "tapes"
    for x in (root, data, tapes):
        x.mkdir()
    (tapes / "manifest.jsonl").write_text("")
    (data / "w.webm").write_bytes(b"audio")
    sha = hashlib.sha256(b"audio").hexdigest()

    def window(week, hh, kind="room_tape", diar=None, sarvam=False):
        date, t0 = DATE[week], (T0_W39 if week == "39" else T0_W40) + int(hh) * 3600000
        wid = f"c-{date}_{ROOM}_{hh}00"
        stub = {"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": date, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": kind,
                "audio": {"r2_key": "local:w.webm", "sha256": sha, "sample_rate": 1, "duration_ms": 900000}}
        put(str(root), wid, date, "stt", "koyal", [], stub=stub)
        if diar is not None:
            put(str(root), wid, date, "diar", "pyannote-local-twin", [{"t0_ms": a * 1000, "t1_ms": b * 1000, "speaker": s} for a, b, s in diar] if diar else [],
                status="ok" if diar else "empty")
        if sarvam:
            put(str(root), wid, date, "stt", "sarvam-saaras-v3", [])
        return wid, date, t0
    return str(root), str(data), str(tapes), window, tmp_path


CAA_HEADER = "consult_uid,room,doctor_uid,t0_utc_ms,t1_utc_ms,boundary_source,sarvam_done,clip_path,clip_status,date\n"


def caa_file(tmp, rows=(), name="caa.csv", labels=None):
    """A CAA manifest (one harmless far-away row unless rows are given) and a room-labels file mapping the test room to 'OPD 1'. -> (manifest path, labels path)"""
    mp = tmp / name
    body = CAA_HEADER + "".join(f"c{i},{room},D,{t0},{t1},pqm,{done},/x.flac,{status},2026-09-26\n" for i, (room, t0, t1, done, status) in enumerate(rows or [("OPD 1", 1, 2, "n", "ok")]))
    mp.write_text(body)
    lp = tmp / "labels.json"
    lp.write_text(json.dumps({"rooms": labels or [{"room_id": ROOM, "label": "OPD 1"}, {"room_id": "room_bbbb2222", "label": "OPD 4 Ortho"}, {"room_id": "room_cccc3333", "label": "Dietary OPD"}]}))
    return str(mp), str(lp)


PLANNED_HEADER = "consult_uid,room_id,t0_utc_ms,t1_utc_ms,room_source,status\n"


def planned_file(tmp, rows=(), name="planned.csv"):
    """consult-lead's planned-clips file; one harmless far-away row unless rows (room_id, t0, t1, status) are given. -> path"""
    p = tmp / name
    p.write_text(PLANNED_HEADER + "".join(f"pqm_{i},{room},{t0},{t1},pqm,{status}\n" for i, (room, t0, t1, status) in enumerate(rows or [(ROOM, 1, 2, "planned")])))
    return str(p)


def args(tmp, **kw):
    ns = dict(write=False, weeks=None, unit=None, phases="a,b,c", evidence="any", min_coverage=0.99, sarvam_workers=2, worker_status="worker", excuse_rate_cap_sleep=True, caa_manifest=caa_file(tmp, name="caa-default.csv")[0], consult_planned=planned_file(tmp, name="planned-default.csv"), consult_max_age_h=3.0, consult_count_dead=False, caa_max_age_h=3.0, caa_count_dead=False,
              state_dir=str(tmp / "state"), py_nemo="n", py_sarvam="s", force=False, tape_fallback=True)
    ns.update(kw)
    return types.SimpleNamespace(**ns)


@pytest.fixture(autouse=True)
def labels_path(tmp_path, monkeypatch):
    caa_file(tmp_path)
    monkeypatch.setattr(d, "ROOM_LABELS", str(tmp_path / "labels.json"))


def drive(env, a, nemotron=None, sarvam=None):
    root, data, tapes, _, tmp = env
    out = []
    lines, stop = d.drive(a, root=root, is_held=lambda x, y: False, tapes=tapes, data=data, nemotron=nemotron or (lambda *x: {}), sarvam=sarvam or (lambda *x: {}), out=out.append)
    return lines, stop, out


def test_dry_run_plans_newest_week_first_and_calls_no_lane(store):
    root, _, _, window, tmp = store
    window("39", "01", diar=ALT)                       # CONSULT-LIKE from existing pyannote
    window("39", "02")                                  # UNCLASSIFIED
    window("40", "01")                                  # UNCLASSIFIED, newer week
    called = []
    lines, stop, out = drive(store, args(tmp), nemotron=lambda *x: called.append("n"), sarvam=lambda *x: called.append("s"))
    assert stop is None and called == [] and [l["unit"] for l in lines] == ["2026-W40", "2026-W39"]
    w39 = lines[1]
    assert w39["mode"] == "dry-run" and w39["nemotron"]["to_run"] == 1 and w39["sarvam"]["to_send"] == 1 and w39["before"]["labels"]["CONSULT-LIKE"] == 1
    assert not os.path.exists(tmp / "state")           # a dry run writes no state


def test_full_unit_nemotron_then_classify_then_sarvam_and_resume(store):
    root, _, _, window, tmp = store
    a_wid, date, t0 = window("39", "01")                                # no turns yet
    b_wid, _, _ = window("39", "02", diar=ALT, sarvam=True)             # already sent to Sarvam
    seen = {}

    def nemotron(unit, ids, a):
        seen["nem"] = ids
        put(root, ids[0], date, "diar", "nemotron", [{"t0_ms": t0 + x * 1000, "t1_ms": t0 + y * 1000, "speaker": s} for x, y, s in ALT])      # tape time
        return {"windows": 1, "ok": 1, "errors": 0, "skipped_existing": 0, "audio_h": 0.25, "stopped": None}

    def sarvam(unit, ids, a):
        seen["sar"] = ids
        return {"windows": len(ids), "ok": len(ids), "failed": 0, "throttled": 0, "audio_h": 0.25, "skipped_existing": 0, "errors": 0}
    lines, stop, _ = drive(store, args(tmp, write=True), nemotron, sarvam)
    assert stop is None and seen["nem"] == [a_wid] and seen["sar"] == [a_wid]                 # phase c sees the window phase a just turned CONSULT-LIKE; b_wid is already sent
    (l,) = lines
    assert l["before"]["labels"]["UNCLASSIFIED"] == 1 and l["after"]["labels"]["CONSULT-LIKE"] == 2 and l["sarvam"]["ok"] == 1 and l["nemotron"]["ok"] == 1
    st = json.load(open(tmp / "state" / "2026-W39.json"))
    assert st["done"] is False                                                                # this pass had work
    # the second pass: the Sarvam fake wrote nothing, so the window is still unsent; make it done and see the unit marked done, then skipped
    put(root, a_wid, date, "stt", "sarvam-saaras-v3", [])
    lines, stop, _ = drive(store, args(tmp, write=True), nemotron, sarvam)
    assert json.load(open(tmp / "state" / "2026-W39.json"))["done"] is True
    lines, stop, out = drive(store, args(tmp, write=True), nemotron, sarvam)
    assert lines == [] and json.loads(out[0]) == {"unit": "2026-W39", "skipped": "done"}


def test_phase_c_selection_rules():
    rows = [{"window_id": "a", "label": "CONSULT-LIKE", "coverage": 1.0, "sarvam": False, "reason": "pyannote"},
            {"window_id": "b", "label": "CONSULT-LIKE", "coverage": 0.98, "sarvam": False, "reason": "pyannote"},       # coverage < 0.99
            {"window_id": "c", "label": "CONSULT-LIKE", "coverage": 1.0, "sarvam": True, "reason": "pyannote"},         # already sent
            {"window_id": "e", "label": "CONSULT-LIKE", "coverage": 0.99, "sarvam": False, "reason": "nemotron"},
            {"window_id": "f", "label": "STAFF/OTHER", "coverage": 1.0, "sarvam": False, "reason": "pyannote"}]
    assert d.sarvam_ids(rows) == ["a", "e"] and d.sarvam_ids(rows, evidence="pyannote") == ["a"] and d.sarvam_ids(rows, min_coverage=0.97) == ["a", "b", "e"]


@pytest.mark.parametrize("sar,nem,reason", [
    ({"throttled": 1}, None, "sarvam_throttled"), ({"failed": 6}, None, "sarvam_failed"),
    (None, {"errors": 6}, "nemotron_errors"), (None, {"stopped": "production_behind"}, "production_behind")])
def test_stop_rules_halt_the_driver_and_save_the_reason(store, sar, nem, reason):
    root, _, _, window, tmp = store
    window("39", "01")
    window("40", "01")
    base_n = {"windows": 1, "ok": 1, "errors": 0, "audio_h": 0.25, "stopped": None}
    base_s = {"windows": 1, "ok": 1, "failed": 0, "throttled": 0, "audio_h": 0.25}
    calls = []

    def nemotron(unit, ids, a):
        calls.append(unit)
        r = {**base_n, **(nem or {})}
        # classify the window as CONSULT-LIKE so phase c is reached when phase a passes
        return r

    def sarvam(unit, ids, a):
        return {**base_s, **(sar or {})}
    if sar:
        window("40", "02", diar=ALT)                       # the newest week has a CONSULT-LIKE window to send
    lines, stop, out = drive(store, args(tmp, write=True), nemotron, sarvam)
    assert stop is not None and stop.reason == reason and out[-1].startswith(f"STOP {reason} unit=2026-W40")
    assert len(calls) <= 1                                                                      # the driver did not go on to the next week
    assert json.load(open(tmp / "state" / "2026-W40.json"))["last"]["stop"] == reason


def test_orphan_unit_selects_only_orphan_windows(store):
    root, _, _, window, tmp = store
    window("40", "01")
    o, _, _ = window("40", "02", kind="room_tape_orphan")
    rows, tot = d.scan(root, orphan=True, is_held=lambda x, y: False, tapes=store[2], data=store[1])
    assert [r["window_id"] for r in rows] == [o] and rows[0]["week"] == "orphan-opd4"
    lines, stop, _ = drive(store, args(tmp, unit="orphan"))
    assert [l["unit"] for l in lines] == ["orphan-opd4"] and lines[0]["before"]["windows"] == 1


def test_main_refuses_write_without_the_worker_signal_and_three_workers():
    with pytest.raises(SystemExit):
        d.main(["--write", "--worker-status", "none"])
    with pytest.raises(SystemExit):
        d.main(["--sarvam-workers", "3"])


def test_parse_counters_and_lane_commands(tmp_path):
    assert d.parse_counters('x\nwindow_lanes nemotron write {"ok": 3, "errors": 0}\n') == {"ok": 3, "errors": 0}
    with pytest.raises(RuntimeError):
        d.parse_counters("nothing here")
    a = args(tmp_path, worker_status="file:/b.json")
    cmds = []
    d.run_nemotron("u", ["w1"], a, run=lambda cmd, env=None: (cmds.append(cmd), (0, 'window_lanes {"windows": 1, "ok": 1}'))[1])
    d.run_sarvam("u", ["w1"], a, run=lambda cmd, env=None: (cmds.append((cmd, env)), (0, 'sarvam_lane {"windows": 1, "ok": 1}'))[1])
    assert "--excuse-rate-cap-sleep" in cmds[0]                                                    # the driver default (architect #11330)
    d.run_nemotron("u", ["w1"], args(tmp_path, excuse_rate_cap_sleep=False), run=lambda cmd, env=None: (cmds.append(cmd), (0, 'window_lanes {"windows": 1}'))[1])
    assert "--excuse-rate-cap-sleep" not in cmds[-1] and d.build_parser().parse_args([]).excuse_rate_cap_sleep is True and d.build_parser().parse_args(["--no-excuse-rate-cap-sleep"]).excuse_rate_cap_sleep is False
    assert cmds[0][:3] == ["n", "-m", "kit.reb.window_lanes"] and "--write" in cmds[0] and cmds[0][cmds[0].index("--worker-status") + 1] == "file:/b.json"
    assert cmds[1][0][:3] == ["s", "-m", "kit.reb.sarvam_lane"] and "--research-windows" in cmds[1][0] and cmds[1][0][cmds[1][0].index("--workers") + 1] == "2"
    assert json.load(open(tmp_path / "state" / "u-sarvam-ids.json")) == ["w1"] and oct(os.stat(tmp_path / "state" / "u-sarvam-ids.json").st_mode)[-3:] == "600"


# ---------------------------------------------------------------- CAA overlap (architect #11351/#11352)
H = 3600000
W = lambda wid, t0=0, t1=900000, room=ROOM: {"window_id": wid, "room_id": room, "t0_ms": t0, "t1_ms": t1}


def test_caa_skip_rules():
    caa = {ROOM: [(0, 300000, False), (300000, 500000, False), (2000000, 2100000, True)]}      # two touching not-done clips cover 500 s of a 900 s window; one done clip elsewhere
    assert d.caa_skip([W("cover")], caa) == {"cover": "cover"}                                   # the UNION covers 55.6% >= 50%
    assert d.caa_skip([W("under", 0, 1200000)], caa) == {}                                       # 500 s of 1200 s = 41.7%: not covered, not done
    assert d.caa_skip([W("exact", 0, 1000000)], caa) == {"exact": "cover"}                       # exactly 50%
    assert d.caa_skip([W("done_edge", 2099999, 2999999)], caa) == {"done_edge": "sarvam_done"}   # 1 ms of overlap with a Sarvam-done clip is enough
    assert d.caa_skip([W("touch", 2100000, 3000000)], caa) == {}                                 # touching (no overlap) is not an overlap
    assert d.caa_skip([W("other_room", room="room_bbbb2222")], caa) == {}                        # another room's clips never count
    assert d.caa_skip([W("overlapping_clips")], {ROOM: [(0, 300000, False), (200000, 500000, False)]}) == {"overlapping_clips": "cover"}     # overlapping CAA clips are not double counted: union 500 s


def test_load_caa_maps_labels_drops_dead_clips_and_fails_closed(tmp_path):
    mp, lp = caa_file(tmp_path, [("OPD 1", 10, 20, "y", "ok"), ("OPD 4", 30, 40, "n", "ok"), ("Dietary", 50, 60, "n", "dead")])
    got = d.load_caa(mp, lp, now=lambda: os.path.getmtime(mp) + 10)
    assert got == {ROOM: [(10, 20, True)], "room_bbbb2222": [(30, 40, False)]}                  # OPD 4 -> OPD 4 Ortho; the dead Dietary clip is not counted
    assert d.load_caa(mp, lp, now=lambda: os.path.getmtime(mp) + 10, count_dead=True)["room_cccc3333"] == [(50, 60, False)]
    ok = lambda p: d.load_caa(p, lp, now=lambda: os.path.getmtime(p) + 10)
    with pytest.raises(d.CaaUnavailable):
        d.load_caa(str(tmp_path / "missing.csv"), lp)                                           # missing
    with pytest.raises(d.CaaUnavailable):
        d.load_caa(mp, lp, now=lambda: os.path.getmtime(mp) + 3 * 3600 + 1)                      # older than 3 h
    assert d.load_caa(mp, lp, now=lambda: os.path.getmtime(mp) + 3 * 3600)                       # exactly 3 h is still fine
    for name, body in (("empty.csv", CAA_HEADER), ("nohdr.csv", "a,b\n1,2\n"), ("badnum.csv", CAA_HEADER + "c,OPD 1,D,x,2,pqm,n,/x,ok,d\n"),
                       ("badint.csv", CAA_HEADER + "c,OPD 1,D,5,5,pqm,n,/x,ok,d\n"), ("baddone.csv", CAA_HEADER + "c,OPD 1,D,1,2,pqm,maybe,/x,ok,d\n"),
                       ("badroom.csv", CAA_HEADER + "c,OPD 9,D,1,2,pqm,n,/x,ok,d\n"), ("blankroom.csv", CAA_HEADER + "c,,D,1,2,pqm,n,/x,ok,d\n")):
        (tmp_path / name).write_text(body)
        with pytest.raises(d.CaaUnavailable):
            ok(str(tmp_path / name))
    one, amb = tmp_path / "one.csv", tmp_path / "amb.json"
    one.write_text(CAA_HEADER + "c,OPD 1,D,1,2,pqm,n,/x,ok,d\n")                                                       # a manifest with ONLY the label under test
    amb.write_text(json.dumps({"rooms": [{"room_id": "a", "label": "OPD 1"}, {"room_id": "b", "label": "OPD 1 Annex"}]}))                   # 'OPD 1' would match two rooms
    with pytest.raises(d.CaaUnavailable):
        d.load_caa(str(one), str(amb), now=lambda: os.path.getmtime(str(one)) + 10)
    near = tmp_path / "near.json"
    near.write_text(json.dumps({"rooms": [{"room_id": "a", "label": "OPD 1"}, {"room_id": "b", "label": "OPD 10"}]}))                      # 'OPD 1' is NOT a prefix of 'OPD 10 ' + space: no collision
    assert d.load_caa(str(one), str(near), now=lambda: os.path.getmtime(str(one)) + 10) == {"a": [(1, 2, False)]}
    with pytest.raises(d.CaaUnavailable):
        d.load_caa(mp, str(tmp_path / "nolabels.json"))


def test_phase_c_skips_caa_overlap_counts_it_and_refuses_without_a_fresh_manifest(store):
    root, _, _, window, tmp = store
    a_wid, date, t0 = window("39", "01", diar=ALT)                       # CONSULT-LIKE, will overlap CAA by 60%
    b_wid, _, t0b = window("39", "02", diar=ALT)                         # CONSULT-LIKE, a CAA clip with Sarvam done touches it for 1 s
    c_wid, _, _ = window("39", "03", diar=ALT)                           # CONSULT-LIKE, no CAA at all
    mp, _ = caa_file(tmp, [("OPD 1", t0, t0 + 540000, "n", "ok"), ("OPD 1", t0b + 899000, t0b + 1500000, "y", "ok")])
    sent = {}

    def sarvam(unit, ids, a):
        sent["ids"] = ids
        return {"windows": len(ids), "ok": len(ids), "failed": 0, "throttled": 0, "audio_h": 0.25, "errors": 0}
    lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_manifest=mp), sarvam=sarvam)
    assert stop is None and sent["ids"] == [c_wid] and lines[0]["sarvam"]["skipped_caa"] == 2
    assert lines[0]["sarvam"]["skipped_caa_cover"] == 1 and lines[0]["sarvam"]["skipped_caa_sarvam_done"] == 1 and lines[0]["sarvam"]["to_send"] == 1
    skipped = json.load(open(tmp / "state" / "2026-W39-caa-skipped.json"))
    assert sorted(skipped) == sorted([a_wid, b_wid]) and oct(os.stat(tmp / "state" / "2026-W39-caa-skipped.json").st_mode)[-3:] == "600"
    # a missing or stale manifest: phase c refuses, STOP, nothing is sent
    sent.clear()
    lines, stop, out = drive(store, args(tmp, write=True, phases="c", caa_manifest=str(tmp / "nope.csv")), sarvam=sarvam)
    assert stop is not None and stop.reason == "caa_manifest_unavailable" and out[-1].startswith("STOP caa_manifest_unavailable") and sent == {}
    old = tmp / "old.csv"
    old.write_text((tmp / "caa.csv").read_text())
    os.utime(old, (1, 1))
    lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_manifest=str(old)), sarvam=sarvam)
    assert stop is not None and stop.reason == "caa_manifest_unavailable" and sent == {}
    # phases a,b never read the manifest: Nemotron and classify run without it
    lines, stop, _ = drive(store, args(tmp, phases="a,b", caa_manifest=str(tmp / "nope.csv")))
    assert stop is None and lines


# ---------------------------------------------------------------- the stop-flag file
def test_stop_file_stops_the_driver_between_units_and_before_phase_c_without_killing(store):
    root, _, _, window, tmp = store
    window("39", "01")
    window("40", "01")
    flag = tmp / "state" / "STOP"
    os.makedirs(flag.parent)
    flag.write_text("")
    called = []
    lines, stop, out = drive(store, args(tmp, write=True), nemotron=lambda *x: called.append("n"), sarvam=lambda *x: called.append("s"))
    assert stop is not None and stop.reason == "stop_file" and called == [] and lines == [] and out[-1].startswith("STOP stop_file unit=2026-W40")
    flag.unlink()
    # the flag appears while the Nemotron lane runs: the lane reports stopped=stop_file, the driver stops and never reaches phase c
    def nemotron(unit, ids, a):
        flag.write_text("")
        return {"windows": 1, "ok": 1, "errors": 0, "audio_h": 0.25, "stopped": "stop_file"}
    lines, stop, out = drive(store, args(tmp, write=True), nemotron=nemotron, sarvam=lambda *x: called.append("s"))
    assert stop is not None and stop.reason == "stop_file" and called == []
    flag.unlink()
    # the driver passes the flag path to the lane (default <state-dir>/STOP, or --stop-file)
    cmds = []
    d.run_nemotron("u", ["w"], args(tmp), run=lambda cmd, env=None: (cmds.append(cmd), (0, 'window_lanes {"windows": 1}'))[1])
    assert cmds[0][cmds[0].index("--stop-file") + 1] == str(flag)
    d.run_nemotron("u", ["w"], args(tmp, stop_file="/x/STOP"), run=lambda cmd, env=None: (cmds.append(cmd), (0, 'window_lanes {"windows": 1}'))[1])
    assert cmds[1][cmds[1].index("--stop-file") + 1] == "/x/STOP"


# ---------------------------------------------------------------- the CAA manifest is re-read before every chunk (refuter #11359)
def test_manifest_is_reloaded_per_chunk_so_a_mid_unit_flip_is_seen_and_stop_rules_act_per_chunk(store):
    root, _, _, window, tmp = store
    a_wid, date, ta = window("39", "01", diar=ALT)
    b_wid, _, tb = window("39", "02", diar=ALT)
    c_wid, _, tc = window("39", "03", diar=ALT)
    mp, _ = caa_file(tmp, [("OPD 1", 1, 2, "n", "ok")], name="live.csv")
    sent, loads = [], []
    real = d.load_caa

    def counting(*a, **k):
        loads.append(1)
        return real(*a, **k)
    d.load_caa = counting
    try:
        def sarvam(unit, ids, a):
            sent.append(ids)
            if len(sent) == 1:                                                       # while chunk 1 is being sent CAA marks window b done: the manifest on disk changes
                caa_file(tmp, [("OPD 1", tb + 1000, tb + 2000, "y", "ok")], name="live.csv")
            return {"windows": len(ids), "ok": len(ids), "failed": 0, "throttled": 0, "audio_h": 0.25, "errors": 0}
        lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_manifest=mp, caa_reload_every=1), sarvam=sarvam)
    finally:
        d.load_caa = real
    assert stop is None and sent == [[a_wid], [c_wid]] and len(loads) == 3                # b was skipped at its own chunk; the manifest was read once per chunk
    s = lines[0]["sarvam"]
    assert s["skipped_caa"] == 1 and s["skipped_caa_sarvam_done"] == 1 and s["to_send"] == 2 and s["ok"] == 2 and s["chunks"] == 2
    # a throttle in chunk 1 stops the unit before chunk 2 is sent
    sent.clear()
    caa_file(tmp, [("OPD 1", 1, 2, "n", "ok")], name="live.csv")

    def throttled(unit, ids, a):
        sent.append(ids)
        return {"windows": 1, "ok": 0, "failed": 0, "throttled": 1, "audio_h": 0.25, "errors": 0}
    lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_manifest=mp, caa_reload_every=1), sarvam=throttled)
    assert stop is not None and stop.reason == "sarvam_throttled" and len(sent) == 1
    # failed windows add up across chunks: 3 chunks x 2 failed = 6 > 5 stops after the third
    sent.clear()
    for hh in ("04", "05", "06"):
        window("39", hh, diar=ALT)

    def failing(unit, ids, a):
        sent.append(ids)
        return {"windows": 1, "ok": 0, "failed": 2, "throttled": 0, "audio_h": 0.1, "errors": 0}
    lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_manifest=mp, caa_reload_every=1), sarvam=failing)
    assert stop is not None and stop.reason == "sarvam_failed" and len(sent) == 3
    # a manifest that goes stale/missing between chunks stops the unit with nothing more sent
    sent.clear()

    def breaks(unit, ids, a):
        sent.append(ids)
        os.remove(mp)
        return {"windows": 1, "ok": 1, "failed": 0, "throttled": 0, "audio_h": 0.1, "errors": 0}
    caa_file(tmp, [("OPD 1", 1, 2, "n", "ok")], name="live.csv")
    lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_manifest=mp, caa_reload_every=1), sarvam=breaks)
    assert stop is not None and stop.reason == "caa_manifest_unavailable" and len(sent) == 1


def test_default_chunk_size_is_50_and_the_stop_file_is_honoured_between_chunks(store):
    assert d.CAA_RELOAD_EVERY == 50 and d.build_parser().parse_args([]).caa_reload_every == 50
    root, _, _, window, tmp = store
    ids = [window("39", f"{h:02d}", diar=ALT)[0] for h in range(1, 4)]
    flag = tmp / "state" / "STOP"
    os.makedirs(flag.parent)
    sent = []

    def sarvam(unit, i, a):
        sent.append(i)
        flag.write_text("")                                                           # the operator touches the flag during chunk 1
        return {"windows": 1, "ok": 1, "failed": 0, "throttled": 0, "audio_h": 0.1, "errors": 0}
    lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_reload_every=1), sarvam=sarvam)
    assert stop is not None and stop.reason == "stop_file" and len(sent) == 1


# ---------------------------------------------------------------- consult-lead's planned Sept clips (architect #11427)
def test_planned_skip_rules_and_loader(tmp_path):
    now = lambda p: (lambda: os.path.getmtime(p) + 10)
    p = planned_file(tmp_path, [(ROOM, 0, 300000, "planned"), (ROOM, 300000, 500000, "cut"), (ROOM, 700000, 900000, "dead"), ("room_bbbb2222", 0, 900000, "planned")])
    got = d.load_planned(p, now=now(p))
    assert got == {ROOM: [(0, 300000), (300000, 500000)], "room_bbbb2222": [(0, 900000)]}                       # the dead clip is not counted
    assert d.load_planned(p, now=now(p), count_dead=True)[ROOM][-1] == (700000, 900000)
    W_ = lambda wid, t0=0, t1=900000, room=ROOM: {"window_id": wid, "room_id": room, "t0_ms": t0, "t1_ms": t1}
    assert d.planned_skip([W_("cover")], got) == {"cover": "cover"}                                              # 500 s of 900 s = 55.6% >= 50%
    assert d.planned_skip([W_("under", 0, 1200000)], got) == {}                                                  # 41.7%
    assert d.planned_skip([W_("exact", 0, 1000000)], got) == {"exact": "cover"}                                  # exactly 50%
    assert d.planned_skip([W_("other_room", room="room_cccc3333")], got) == {}
    assert d.planned_skip([W_("whole", room="room_bbbb2222")], got) == {"whole": "cover"}
    assert d.planned_skip([W_("dead_only", 600000, 1000000)], got) == {}                                         # only the dead clip overlaps


def test_planned_loader_fails_closed(tmp_path):
    p = planned_file(tmp_path)
    fresh = lambda: os.path.getmtime(p) + 10
    assert d.load_planned(p, now=fresh)
    with pytest.raises(d.PlannedUnavailable):
        d.load_planned(str(tmp_path / "missing.csv"))
    with pytest.raises(d.PlannedUnavailable):
        d.load_planned(p, now=lambda: os.path.getmtime(p) + 3 * 3600 + 1)
    assert d.load_planned(p, now=lambda: os.path.getmtime(p) + 3 * 3600)                                         # exactly 3 h is fine
    bad = {"empty.csv": PLANNED_HEADER, "nohdr.csv": "a,b\\n1,2\\n", "badnum.csv": PLANNED_HEADER + "c,room_a,x,2,pqm,planned\\n", "badint.csv": PLANNED_HEADER + "c,room_a,5,5,pqm,planned\\n",
           "badroom.csv": PLANNED_HEADER + "c,OPD 1,1,2,pqm,planned\\n", "badstatus.csv": PLANNED_HEADER + "c,room_a,1,2,pqm,maybe\\n", "blankroom.csv": PLANNED_HEADER + "c,,1,2,pqm,planned\\n"}
    for name, body in bad.items():
        (tmp_path / name).write_text(body)
        with pytest.raises(d.PlannedUnavailable):
            d.load_planned(str(tmp_path / name), now=lambda n=name: os.path.getmtime(str(tmp_path / n)) + 10)


def test_phase_c_skips_planned_clips_counts_them_and_the_stop_carries_partial_totals(store):
    root, _, _, window, tmp = store
    a_wid, date, ta = window("39", "01", diar=ALT)                          # covered 60% by a planned clip -> skipped_consult
    b_wid, _, tb = window("39", "02", diar=ALT)                             # covered by a CAA done clip -> skipped_caa (counted there, not twice)
    c_wid, _, tc = window("39", "03", diar=ALT)                             # clean -> sent
    caa, _ = caa_file(tmp, [("OPD 1", tb + 1000, tb + 2000, "y", "ok")], name="live2.csv")
    pl = planned_file(tmp, [(ROOM, ta, ta + 540000, "planned"), (ROOM, tb, tb + 900000, "cut"), (ROOM, tc, tc + 900000, "dead")], name="plan-live.csv")
    sent = []

    def sarvam(unit, ids, a):
        sent.append(ids)
        return {"windows": len(ids), "ok": len(ids), "failed": 0, "throttled": 0, "audio_h": 0.25, "errors": 0}
    lines, stop, _ = drive(store, args(tmp, write=True, phases="c", caa_manifest=caa, consult_planned=pl), sarvam=sarvam)
    assert stop is None and sent == [[c_wid]]
    s = lines[0]["sarvam"]
    assert s["skipped_caa"] == 1 and s["skipped_consult"] == 1 and s["to_send"] == 1
    assert json.load(open(tmp / "state" / "2026-W39-consult-skipped.json")) == [a_wid] and json.load(open(tmp / "state" / "2026-W39-caa-skipped.json")) == [b_wid]
    # a missing planned file stops the unit with the reason; a stop mid-unit carries what was sent so far
    sent.clear()
    lines, stop, out = drive(store, args(tmp, write=True, phases="c", caa_manifest=caa, consult_planned=str(tmp / "nope.csv")), sarvam=sarvam)
    assert stop is not None and stop.reason == "consult_planned_unavailable" and sent == [] and out[-1].startswith("STOP consult_planned_unavailable")
    for hh in ("04", "05"):
        window("39", hh, diar=ALT)
    flag = tmp / "state" / "STOP"

    def sarvam2(unit, ids, a):
        sent.append(ids)
        flag.write_text("")                                                  # the operator touches the flag during the first chunk
        return {"windows": len(ids), "ok": len(ids), "failed": 0, "throttled": 0, "audio_h": 0.25, "errors": 0}
    caa2, _ = caa_file(tmp, [("OPD 1", 1, 2, "n", "ok")], name="live3.csv")
    lines, stop, out = drive(store, args(tmp, write=True, phases="c", caa_manifest=caa2, caa_reload_every=1, consult_planned=planned_file(tmp, name="plan2.csv")), sarvam=sarvam2)
    assert stop is not None and stop.reason == "stop_file" and len(sent) == 1
    assert stop.partial["ok"] == 1 and stop.partial["to_send_so_far"] == 1 and stop.partial["sarvam_audio_min"] == 15.0
    assert "partial=" in out[-1] and json.load(open(tmp / "state" / "2026-W39.json"))["last"]["partial"]["ok"] == 1


# ---------------------------------------------------------------- planned-clips.COMPLETE (architect #11457)
def test_planned_staleness_is_waived_only_for_a_newer_complete_marker_and_no_planned_rows(tmp_path):
    def make(rows, marker, marker_newer=True, name="p.csv"):
        p = tmp_path / name
        p.write_text(PLANNED_HEADER + "".join(f"pqm_{i},{ROOM},{i + 1},{i + 5},pqm,{st}\n" for i, st in enumerate(rows)))
        os.utime(p, (1_000_000, 1_000_000))
        m = tmp_path / (name[:-4] + ".COMPLETE")
        if m.exists():
            os.remove(m)
        if marker:
            m.write_text("")
            t = 1_000_000 + (10 if marker_newer else -10)
            os.utime(m, (t, t))
        return str(p)
    old = lambda: 1_000_000 + 4 * 3600                                      # 4 h after the csv's mtime: stale by the 3 h rule
    # waived: stale, marker newer, every row cut or dead
    p = make(["cut", "dead", "cut"], marker=True)
    assert d.load_planned(p, now=old) == {ROOM: [(1, 5), (3, 7)]}                                                 # the dead clip is still not counted
    # not waived: no marker; marker OLDER than the csv; a planned row left; marker present but all rows planned
    for rows, marker, newer, name in ((["cut"], False, True, "a.csv"), (["cut"], True, False, "b.csv"), (["cut", "planned"], True, True, "c.csv"), (["planned"], True, True, "d.csv")):
        with pytest.raises(d.PlannedUnavailable):
            d.load_planned(make(rows, marker, newer, name), now=old)
    # fresh files behave as before whatever the marker says, and the marker never rescues a malformed file
    assert d.load_planned(make(["planned"], False, name="e.csv"), now=lambda: 1_000_000 + 60)
    bad = tmp_path / "f.csv"
    bad.write_text(PLANNED_HEADER + f"x,{ROOM},1,2,pqm,maybe\n")
    os.utime(bad, (1_000_000, 1_000_000))
    (tmp_path / "f.COMPLETE").write_text("")
    os.utime(tmp_path / "f.COMPLETE", (1_000_010, 1_000_010))
    with pytest.raises(d.PlannedUnavailable):
        d.load_planned(str(bad), now=old)                                                                             # an unknown status still fails
    # exactly 3 h: still fine without any marker
    assert d.load_planned(make(["cut"], False, name="g.csv"), now=lambda: 1_000_000 + 3 * 3600)
    # no rows at all: the marker does not make an empty file valid
    h = tmp_path / "h.csv"
    h.write_text(PLANNED_HEADER)
    os.utime(h, (1_000_000, 1_000_000))
    (tmp_path / "h.COMPLETE").write_text("")
    os.utime(tmp_path / "h.COMPLETE", (1_000_010, 1_000_010))
    with pytest.raises(d.PlannedUnavailable):
        d.load_planned(str(h), now=old)
