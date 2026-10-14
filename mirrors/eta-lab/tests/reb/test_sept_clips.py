import hashlib
import json
import os
import types

import pytest

from kit.reb import caa_import as ci
from kit.reb import clip_lanes as cl
from kit.reb import reb, sept_clips as sc, s2_driver as s2, window_lanes as wl
from kit.reb import sarvam_lane as sl
from kit.reb.schema import SOURCE_KIND_VALUES

ROOM = "room_aaaa1111"
LABELS = {"rooms": [{"room_id": ROOM, "label": "OPD 1"}, {"room_id": "room_bbbb2222", "label": "OPD 4 Ortho"}]}
T0 = 1789037775000                       # 2026-09-10 IST
NOW = 2_000_000_000


def labels(tmp):
    p = tmp / "labels.json"
    p.write_text(json.dumps(LABELS))
    return str(p)


def caa_file(src, uid, room="OPD 1", t0=T0, t1=T0 + 242000, status="ok", segs=None, **kw):
    segs = [{"t0_utc_ms": t0 + 1000, "t1_utc_ms": t0 + 5000, "speaker": "doctor", "speaker_code": "D", "lang": "kn-IN", "text": "kannada text", "en": "english text"},
            {"t0_utc_ms": t0 + 6000, "t1_utc_ms": t0 + 9000, "speaker": "unknown", "speaker_code": "S", "lang": "en-IN", "text": "plain", "en": ""}] if segs is None else segs
    d = {"consult_uid": uid, "room": room, "room_basis": "single_room", "doctor_uid": "SECRETDOC", "t0_utc_ms": t0, "t1_utc_ms": t1, "boundary_source": "pqm+trim", "clip_t0_utc_ms": t0 - 40000, "clip_s": 356.0,
         "status": status, "stt": "sarvam saaras:v3", "translate": "sarvam mayura:v1", "speaker_source": "csv", "masked": "names masked (smask)", "segments": segs, **kw}
    p = src / f"{uid}.json" if False else os.path.join(str(src), f"{uid}.json")
    json.dump(d, open(p, "w"))
    return p


@pytest.fixture
def src(tmp_path, monkeypatch):
    d = tmp_path / "caa"
    d.mkdir()
    globals()["src"] = d                        # caa_file() writes into it
    return d


# ---------------------------------------------------------------- part 1: CAA results into the consult scope
def test_part1_files_stt_and_translate_with_provenance_and_no_doctor_id(tmp_path, src):
    root = str(tmp_path / "reb")
    caa_file(src, "u1")
    caa_file(src, "u_empty", segs=[], status="no_speech")
    caa_file(src, "u_nodoc", room="OPD 9")                                  # unmapped label
    (src / "bad.json").write_text("{not json")
    assert "consult_clip_external" in SOURCE_KIND_VALUES
    dry = ci.file_all(str(src), root=root, labels_path=labels(tmp_path), is_held=lambda d, r: False)
    assert dry["would_file"] == 2 and dry["unmapped_room"] == 1 and dry["bad_file"] == 1 and dry["files"] == 4 and not os.path.exists(root)
    cnt = ci.file_all(str(src), root=root, labels_path=labels(tmp_path), write=True, is_held=lambda d, r: False)
    assert cnt["filed"] == 2 and cnt["no_translate"] == 1 and cnt["empty_tracks"] == 2 and cnt["segments"] == 2 and cnt["translate_segments"] == 1 and cnt["roles"] == 2       # the second segment has no `en`; u_empty has an empty stt AND an empty role track
    d = os.path.join(root, "2026-09-10", ROOM, "_consults", "u1")
    man = json.load(open(os.path.join(d, "manifest.json")))
    assert man["source_kind"] == "consult_clip_external" and man["boundary_source"] == "pqm+trim" and man["audio"]["r2_key"] == "external:caa/u1" and man["audio"]["sample_rate"] == 0
    assert man["consult"] == {"attribution": {"doctor_identified": True}} and "SECRETDOC" not in json.dumps(man)
    assert man["provenance"]["caller"] == "caa" and len(man["provenance"]["file_sha256"]) == 64
    names = sorted(os.listdir(os.path.join(d, "tracks")))
    assert [n.split("__")[0] for n in names] == ["role.caa-labels", "stt.sarvam-saaras-v3", "translate.sarvam-mayura-v1"] and all("__caa__" in n for n in names)      # Mayura, not Saaras (ruling 4)
    role = json.load(open(os.path.join(d, "tracks", names[0])))
    stt = json.load(open(os.path.join(d, "tracks", names[1])))
    tr = json.load(open(os.path.join(d, "tracks", names[2])))
    assert role["layer"] == "role" and role["engine"] == "caa-labels" and role["version"] == "caa" and role["status"] == "ok"
    assert [(s["t0_ms"], s["speaker"], s["role"]) for s in role["segments"]] == [(T0 + 1000, "doctor", "doctor"), (T0 + 6000, "unknown", "unknown")] and role["extras"]["map"] == {"doctor": {"role": "doctor"}, "unknown": {"role": "unknown"}}
    assert role["extras"]["caller"] == "caa" and role["extras"]["role_source"] == "caa_labels" and "not a voiceprint identity" in role["extras"]["identity"] and "text" not in json.dumps(role["segments"])
    assert stt["status"] == "ok" and [(s["t0_ms"], s["speaker"], s["lang"]) for s in stt["segments"]] == [(T0 + 1000, "doctor", "kn-IN"), (T0 + 6000, "unknown", "en-IN")]
    assert stt["segments"][0]["extras"] == {"speaker_code": "D", "role_source": "caa"} and stt["extras"]["caller"] == "caa" and stt["version"] == "caa"
    assert tr["engine"] == "sarvam-mayura-v1" and tr["model"] == "mayura:v1" and tr["status"] == "ok" and [s["text"] for s in tr["segments"]] == ["english text"] and tr["segments"][0]["lang"] == "en-IN"
    assert tr["segments"][0]["extras"]["source_language_code"] == "kn-IN" and tr["extras"]["translator"] == "sarvam mayura:v1"
    et = os.path.join(root, "2026-09-10", ROOM, "_consults", "u_empty", "tracks")
    empty = json.load(open(os.path.join(et, [n for n in os.listdir(et) if n.startswith("stt")][0])))
    assert empty["status"] == "empty" and empty["reason"] == "CAA status no_speech" and empty["segments"] == [] and len(os.listdir(et)) == 2         # stt + role, no translate
    # idempotent; a changed source file is a new track (cfg8 over the file sha)
    again = ci.file_all(str(src), root=root, labels_path=labels(tmp_path), write=True, is_held=lambda d, r: False)
    assert again["filed"] == 0 and again["skipped_existing"] == 2
    caa_file(src, "u1", segs=[{"t0_utc_ms": T0 + 1000, "t1_utc_ms": T0 + 2000, "speaker": "weird", "speaker_code": "P", "lang": "en-IN", "text": "changed", "en": "changed"}])
    cnt2 = ci.file_all(str(src), root=root, labels_path=labels(tmp_path), write=True, is_held=lambda d, r: False)
    assert len([n for n in os.listdir(os.path.join(d, "tracks")) if n.startswith("stt")]) == 2 and len([n for n in os.listdir(os.path.join(d, "tracks")) if n.startswith("role")]) == 2
    assert cnt2["role_labels_other"] == 1                                                                 # a label outside doctor/patient/attendant/unknown becomes unknown and is counted
    newest = max((os.path.join(d, "tracks", n) for n in os.listdir(os.path.join(d, "tracks")) if n.startswith("role")), key=os.path.getmtime)
    assert json.load(open(newest))["segments"][0]["role"] == "unknown" and json.load(open(newest))["extras"]["labels_other"] == {"weird": 1}


def test_part1_blind_guard_and_label_mapping(tmp_path, src):
    caa_file(src, "u1")
    assert ci.file_all(str(src), root=str(tmp_path / "r"), labels_path=labels(tmp_path), write=True, is_held=lambda d, r: True)["blind_refused"] == 1
    rooms = ci.room_map(labels(tmp_path))
    assert ci.map_room("OPD 1", rooms) == ROOM and ci.map_room("OPD 4", rooms) == "room_bbbb2222" and ci.map_room("OPD", rooms) is None and ci.map_room("", rooms) is None
    with pytest.raises(ValueError):
        caa_file(src, "x_bad", t1=T0 - 1)
        ci.load_result(os.path.join(str(src), "x_bad.json"))


# ---------------------------------------------------------------- part 3: who has already paid for the speech
def row(uid, s0_ms, s1_ms, room=ROOM, date="2026-09-10"):
    import datetime
    f = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, ci.IST).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    return {"consult_uid": uid, "room_id": room, "ist_date": date, "status": "cut", "span_start": f(s0_ms), "span_end": f(s1_ms)}


def test_eligibility_rules():
    s0, s1 = 1_000_000, 2_000_000                                       # a 1000 s clip
    caa = {ROOM: [(s0, s0 + 499_999, False), (9_000_000, 9_100_000, True)]}
    sent = {ROOM: [(1_900_000, 2_100_000)]}
    rows = [row("caa_uid", s0, s1), row("caa_49", s0, s1), row("caa_50", s0, s0 + 999_998), row("s2_10", s0, s1), row("other_room", s0, s1, room="room_bbbb2222"),
            row("s2_half", 1_850_000, 2_000_000), row("clean", 5_000_000, 5_500_000)]
    ids, why = sc.eligible(rows, caa, {"caa_uid"}, sent)
    assert why["caa_uid"] == "caa_uid"
    assert why["caa_50"] == "caa_overlap"                               # 499,999 ms of a 999,998 ms clip: exactly 50%
    assert "caa_49" in ids                                              # 49.9999% of 1,000,000 ms: kept (and the S2 window covers only 10%)
    assert why["s2_half"] == "s2_window" and "s2_10" in ids             # the sent S2 window covers 66.7% of s2_half's span and 10% of s2_10's
    assert "other_room" in ids and "clean" in ids
    assert sc.eligible(rows, {}, set(), {})[0] == [r["consult_uid"] for r in rows]
    # a CAA clip with sarvam_done = y skips on ANY overlap (even 1 ms), a not-done clip needs 50%
    done_rows = [row("done_1ms", 8_950_000, 9_000_001), row("done_touch", 8_900_000, 9_000_000), row("notdone_small", 7_000_000, 7_900_000)]
    caa2 = {ROOM: [(9_000_000, 9_100_000, True), (7_000_000, 7_100_000, False)]}
    ids2, why2 = sc.eligible(done_rows, caa2, set(), {})
    assert why2 == {"done_1ms": "caa_done_overlap"} and ids2 == ["done_touch", "notdone_small"]


def test_caa_view_fails_closed(tmp_path):
    res = tmp_path / "res"
    res.mkdir()
    (res / "a.json").write_text("{}")
    mp = tmp_path / "caa.csv"
    mp.write_text("consult_uid,room,doctor_uid,t0_utc_ms,t1_utc_ms,boundary_source,sarvam_done,clip_path,clip_status,date\nc,OPD 1,D,1,2,pqm,n,/x,ok,d\n")
    lb = labels(tmp_path)
    fresh = lambda: os.path.getmtime(str(mp)) + 10
    caa, uids = sc.caa_view(str(mp), str(res), lb, now=fresh)
    assert caa == {ROOM: [(1, 2, False)]} and uids == {"a", "c"}                    # the file's uid and the manifest's uid
    with pytest.raises(sc.Unavailable):
        sc.caa_view(str(tmp_path / "none.csv"), str(res), lb)
    with pytest.raises(sc.Unavailable):
        sc.caa_view(str(mp), str(tmp_path / "nores"), lb, now=fresh)
    with pytest.raises(sc.Unavailable):
        sc.caa_view(str(mp), str(res), lb, now=lambda: os.path.getmtime(str(mp)) + 3 * 3600 + 1)


def args(tmp, **kw):
    ns = dict(write=True, since="2026-09-09", until="2026-10-01", root=str(tmp / "reb"), index=str(tmp / "index.jsonl"), ledger=str(tmp / "led"), caa_manifest=str(tmp / "caa.csv"),
              caa_results=str(tmp / "res"), state_dir=str(tmp / "state"), stop_file=None, worker_status="worker", excuse_rate_cap_sleep=True, py_sarvam="s", parts="3")
    ns.update(kw)
    return types.SimpleNamespace(**ns)


@pytest.fixture
def caa_env(tmp_path, monkeypatch):
    (tmp_path / "res").mkdir()
    (tmp_path / "led").mkdir()
    (tmp_path / "caa.csv").write_text("consult_uid,room,doctor_uid,t0_utc_ms,t1_utc_ms,boundary_source,sarvam_done,clip_path,clip_status,date\nc,OPD 1,D,1,2,pqm,n,/x,ok,d\n")
    monkeypatch.setattr(s2, "ROOM_LABELS", labels(tmp_path))
    return tmp_path


def test_part3_sends_only_eligible_clips_in_chunks_with_stop_rules(caa_env, monkeypatch):
    tmp = caa_env
    monkeypatch.setattr(sc, "CHUNK", 2)
    rows = [row(f"u{i}", 5_000_000 + i * 1_000_000, 5_900_000 + i * 1_000_000) for i in range(5)] + [row("covered", 1, 1000)]
    json.dump({"x": 1}, open(tmp / "res" / "u1.json", "w"))                                   # CAA has a result for u1
    (tmp / "caa.csv").write_text((tmp / "caa.csv").read_text() + "c2,OPD 1,D,1,3000,pqm,y,/x,ok,d\n")      # a CAA clip covers the 'covered' clip (1..1000 ms)
    sent, loads = [], []
    orig = sc.caa_view

    def counting(*a, **k):
        loads.append(1)
        return orig(*a, **k)
    monkeypatch.setattr(sc, "caa_view", counting)

    def sarvam(ids, a):
        sent.append(ids)
        return {"clips": len(ids), "ok": len(ids), "failed": 0, "throttled": 0, "errors": 0, "audio_h": 0.25}
    out = sc.part3(args(tmp), rows=rows, sarvam=sarvam, now=lambda: os.path.getmtime(str(tmp / "caa.csv")) + 5)
    assert sent == [["u0"], ["u2", "u3"], ["u4"]] and len(loads) == 3                         # u1 and 'covered' skipped; chunks of 2 clips; the manifest read per chunk
    assert out["skipped_caa_uid"] == 1 and out["skipped_caa_done_overlap"] == 1 and out["would_send"] == 4 and out["sent"]["ok"] == 4 and out["sent"]["audio_min"] == 45.0 and "stopped" not in out
    # a throttle stops after its chunk; the manifest going stale stops before the next chunk
    sent.clear()
    out = sc.part3(args(tmp), rows=rows, sarvam=lambda ids, a: (sent.append(ids), {"clips": 1, "ok": 0, "failed": 0, "throttled": 1, "errors": 0, "audio_h": 0.1})[1], now=lambda: os.path.getmtime(str(tmp / "caa.csv")) + 5)
    assert out["stopped"] == "sarvam_throttled" and len(sent) == 1
    sent.clear()
    calls = []
    mt = os.path.getmtime(str(tmp / "caa.csv"))

    def clock():                                                      # fresh for the first chunk's read, 4 h old for the second
        calls.append(1)
        return mt + (5 if len(calls) <= 1 else 4 * 3600)
    out = sc.part3(args(tmp), rows=rows, sarvam=lambda ids, a: (sent.append(ids), {"clips": 1, "ok": 1, "failed": 0, "throttled": 0, "errors": 0, "audio_h": 0.1})[1], now=clock)
    assert out["stopped"] == "caa_unavailable" and len(sent) == 1
    dry = sc.part3(args(tmp, write=False), rows=rows, sarvam=lambda *a: pytest.fail("no send in a dry run"), now=lambda: os.path.getmtime(str(tmp / "caa.csv")) + 5)
    assert dry["would_send"] == 4 and "sent" not in dry


def test_part3_command_has_the_research_flags(tmp_path):
    cmds = []
    sc.sarvam_clips(["a", "b"], args(tmp_path, state_dir=str(tmp_path / "state")), run=lambda cmd, env=None: (cmds.append((cmd, env)), (0, 'sarvam_lane write {"clips": 2, "ok": 2}'))[1])
    c = cmds[0][0]
    assert c[:3] == ["s", "-m", "kit.reb.sarvam_lane"] and "--consult-list" in c and "--use-research" in c and "--write" in c and c[c.index("--workers") + 1] == "2"
    assert json.load(open(tmp_path / "state" / "sept-sarvam-ids.json")) == ["a", "b"]


# ---------------------------------------------------------------- part 2: the yield gate and the stop file in clip_lanes
def test_clip_lanes_yield_gate_and_stop_file(tmp_path, monkeypatch):
    calls = []

    class Y:
        def __init__(self, exc=None):
            self.exc, self.n = exc, 0

        def wait_clear(self):
            self.n += 1
            if self.exc:
                raise self.exc
    gate = cl.YieldingGate(types.SimpleNamespace(hold=lambda: __import__("contextlib").nullcontext()), Y(wl.WorkerStalled("x")), (wl.WorkerStalled, wl.ProductionBehind, wl.StopRequested))
    with pytest.raises(cl.LaneHalt) as e:
        with gate.hold():
            pass
    assert e.value.reason == "worker_stalled" and isinstance(e.value, cl.GuardUnavailable)
    ok = cl.YieldingGate(types.SimpleNamespace(hold=lambda: __import__("contextlib").nullcontext()), Y(), (wl.WorkerStalled,))
    with ok.hold():
        pass
    assert ok.yielder.n == 1
    rows = [{"consult_uid": f"u{i}", "ist_date": "2026-09-10", "status": "cut"} for i in range(4)]
    monkeypatch.setattr(sl, "select", lambda a, p: rows)
    flag = tmp_path / "STOP"

    def proc(lane, r, *a):
        calls.append(r["consult_uid"])
        if r["consult_uid"] == "u1":
            raise cl.LaneHalt("production_behind")
    monkeypatch.setattr(cl, "process_clip", proc)
    ns = types.SimpleNamespace(consult=None, date=None, since="2026-09-09", until="2026-10-01", write=True, limit=0, stop_file=None)
    out = cl.run(ns, "nemotron", root=str(tmp_path), is_held=lambda d, r: False, runner=object(), gate=object(), recut_pending=frozenset(), log_dir=None)
    assert calls == ["u0", "u1"] and out["stopped"] == "production_behind"                       # the halt ends the run: u2, u3 never start
    calls.clear()
    monkeypatch.setattr(cl, "process_clip", lambda lane, r, *a: (calls.append(r["consult_uid"]), flag.write_text("") if r["consult_uid"] == "u0" else None))
    ns.stop_file = str(flag)
    out = cl.run(ns, "nemotron", root=str(tmp_path), is_held=lambda d, r: False, runner=object(), gate=object(), recut_pending=frozenset(), log_dir=None)
    assert calls == ["u0"] and out["stopped"] == "stop_file"                                      # the flag appears during u0: u0 is finished, u1 is not started
    flag.unlink()
    ns.stop_file = None
    calls.clear()
    out = cl.run(ns, "nemotron", root=str(tmp_path), is_held=lambda d, r: False, runner=object(), gate=object(), recut_pending=frozenset(), log_dir=None)
    assert "stopped" not in out and len(calls) == 4                                               # defaults: nothing changes for the hourly run


# ---------------------------------------------------------------- the driver
def test_drive_runs_parts_in_order_1_3_2_4_and_honours_the_stop_file(tmp_path):
    order = []
    a = args(tmp_path, parts="1,2,3,4", write=True)
    out = []
    kw = {"part1": {}, "part3": {}}
    import kit.reb.sept_clips as m
    old = (m.part1, m.part2, m.part3, m.part4)
    try:
        m.part1 = lambda a: order.append("1") or {}
        m.part3 = lambda a: order.append("3") or {}
        m.part2 = lambda a: order.append("2") or {}
        m.part4 = lambda a: order.append("4") or {}
        m.drive(a, out=out.append)
        assert order == ["1", "3", "2", "4"]
        order.clear()
        os.makedirs(a.state_dir)
        open(os.path.join(a.state_dir, "STOP"), "w").close()
        res = m.drive(a, out=out.append)
        assert order == ["1"] and res["stopped"] == "stop_file"                                     # part 1 (no Sarvam, quick) runs; the rest stops
    finally:
        m.part1, m.part2, m.part3, m.part4 = old


def test_a_consult_the_manifest_lists_counts_as_caas_even_without_a_result_file(caa_env):
    tmp = caa_env
    (tmp / "caa.csv").write_text((tmp / "caa.csv").read_text() + "done_no_file,OPD 4,D,7,8,pqm,y,/x,ok,d\n")     # CAA says done; the sync has not brought the file
    caa, uids = sc.caa_view(str(tmp / "caa.csv"), str(tmp / "res"), None, now=lambda: os.path.getmtime(str(tmp / "caa.csv")) + 5)
    assert "done_no_file" in uids and not os.path.exists(tmp / "res" / "done_no_file.json")
    ids, why = sc.eligible([row("done_no_file", 5_000_000, 5_900_000)], caa, uids, {})
    assert ids == [] and why == {"done_no_file": "caa_uid"}
