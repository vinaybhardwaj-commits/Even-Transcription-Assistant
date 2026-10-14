"""synthetic tests of the VP-ACC-01 scoring (no real data, no audio): python3 -m pytest studies/2026-10-08-vp-acc/test_vp_acc.py"""
import base64, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vp_acc as V

rng = np.random.default_rng(7)
def unit(v): return v / np.linalg.norm(v)
def b64(v): return base64.b64encode(np.asarray(v, dtype="<f4").tobytes()).decode()
PR = {f"D{i}": dict(name=f"Dr {i}", vec=unit(rng.normal(size=192)), source_gated=(i == 2)) for i in range(3)}
def near(u, cos=0.8):
    r = unit(rng.normal(size=192)); r = unit(r - np.dot(r, PR[u]["vec"]) * PR[u]["vec"]); return unit(cos * PR[u]["vec"] + np.sqrt(1 - cos ** 2) * r)
def other(): return unit(rng.normal(size=192))
def clip(uid, gt, vecs, vi=False, secs=60.0, re=False): return dict(uid=uid, gt=gt, vi=vi, room="opd-1", day="2026-10-08", re_embedded=re, clusters=[(secs, v) for v in vecs])
def many(n_each=20): return [clip(f"c{u}{i}", u, [near(u), other()]) for u in PR for i in range(n_each)]

def test_pass_with_enough_clean_clips():
    r = V.score(many(20), PR); a = r["non_vi"]
    assert r["verdict"].startswith("PASS"), r["verdict"]; assert a["R1"]["pooled"] == 1.0 and a["R2"]["hits"] == 0 and a["R3"]["rate"] == 1.0 and a["R1"]["n"] == 60
    assert a["genuine"]["min"] > 0.55 and a["impostor"]["median"] < 0.3 and a["equal_error"] is not None and a["R1"]["per_doctor"]["Dr 2"]["source_gated"] is True

def test_inconclusive_below_40_non_vi_clips_of_printed_doctors():
    r = V.score(many(10), PR); assert r["verdict"].startswith("INCONCLUSIVE") and "30 non-VI" in r["verdict"]
    r = V.score(many(20)[:39], PR); assert r["verdict"].startswith("INCONCLUSIVE")

def test_vi_clips_never_count_toward_the_bars():
    cs = many(20) + [clip(f"v{i}", "D0", [other()], vi=True) for i in range(30)]; r = V.score(cs, PR)
    assert r["verdict"].startswith("PASS") and r["non_vi"]["clips"] == 60 and r["vi_no_bars"]["clips"] == 30 and r["vi_no_bars"]["R1"]["pooled"] == 0.0

def test_false_accept_and_top1_failures_are_listed():
    cs = many(20); cs[0] = clip("bad", "D0", [near("D0", 0.9), near("D1", 0.7)])           # an impostor cluster that also matches D1, weaker than D0's own: R2 hit, R3 fine
    cs[1] = clip("swap", "D0", [near("D1", 0.9), near("D0", 0.6)])                         # D1 scores higher than the right doctor: R2 and R3 failure
    r = V.score(cs, PR); a = r["non_vi"]
    assert a["R2"]["hits"] == 2 and ("bad", "Dr 1") in [(f[0], f[1]) for f in a["R2"]["failures"]] and ("swap", "Dr 1") in [(f[0], f[1]) for f in a["R2"]["failures"]]
    assert a["R3"]["hits"] == a["R3"]["n"] - 1 and a["R3"]["failures"][0][0] == "swap" and a["R3"]["failures"][0][1] == "Dr 1"

def test_unprinted_doctor_clips_count_for_r2_and_r3_but_not_r1():
    cs = many(20) + [clip(f"u{i}", "UNPRINTED", [near("D1", 0.7)]) for i in range(5)]; a = V.score(cs, PR)["non_vi"]
    assert a["R1"]["n"] == 60 and a["R2"]["pairs"] == 60 * 2 + 5 * 3 and a["R2"]["hits"] == 5 and a["R3"]["n"] == 65 and a["R3"]["hits"] == 60            # the 5 unprinted clips are R3 misses

def test_short_clusters_are_ignored_and_each_doctor_bar_applies():
    cs = [clip(f"s{i}", "D0", [near("D0")], secs=19.9) for i in range(5)] + many(20)[20:]       # D0: only short clusters -> no match -> recall 0 for 5 clips... plus D1/D2 clean
    a = V.score(cs, PR)["non_vi"]; assert a["R1"]["per_doctor"]["Dr 0"]["recall"] == 0.0
    r = V.score(cs + [clip(f"z{i}", "D0", [near("D0")]) for i in range(30)], PR); assert r["verdict"].startswith("FAIL") and "R1 fail" in r["verdict"]                   # 30/35 = 86% recall passes the doctor bar? pooled and per doctor decide

def _holdout_fixture():
    idx = {}; tl = {}
    def add(uid, day, quality="clean", vi=None, emb=True, doctor="D0", source="warehouse_doctor_uid", minutes=10.0):
        idx[uid] = dict(consult_uid=uid, **({} if minutes is None else dict(minutes=minutes)), status="cut", ist_date=day, span_start=f"{day}T10:00:00+05:30", room_slug="opd-1-x", path=uid, **({} if vi is None else dict(voice_isolated=vi)))
        tl[uid] = dict(window=dict(quality=quality), doctor=dict(uid=doctor, source=source), clusters={"S0": dict(sec=50.0, emb_b64=b64(other()))} if emb else {"S0": dict(sec=50.0)})
    return idx, tl, add

def test_holdout_selection():
    idx, tl, add = _holdout_fixture()
    add("old", "2026-10-06"); add("multi", "2026-10-08", quality="multi_doctor"); add("ok", "2026-10-08"); add("vi", "2026-10-07", vi=True); add("noemb", "2026-10-08", emb=False)
    idx["skipped"] = dict(consult_uid="skipped", status="skipped", ist_date="2026-10-08")
    out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]])
    assert sorted(c["uid"] for c in out) == ["ok", "vi"] and need == ["noemb"] and {c["uid"]: c["vi"] for c in out} == {"ok": False, "vi": True} and ex == {"multi_doctor": 1}

def test_F1_F2_only_warehouse_ground_truth_and_no_doctor_clips_are_excluded_and_counted():
    idx, tl, add = _holdout_fixture()
    add("wh", "2026-10-08"); add("consulting", "2026-10-08", source="consulting_doctor_uid"); add("none1", "2026-10-08", doctor=None, source=None); add("none2", "2026-10-08", doctor="", source="warehouse_doctor_uid")
    out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]])
    assert [c["uid"] for c in out] == ["wh"] and ex == {"non_warehouse": 1, "no_doctor": 2}

def test_F3_r2_bar_uses_scorable_clips_only_and_reports_the_all_clip_rate():
    cs = many(20) + [clip(f"short{i}", "D0", [near("D1", 0.9)], secs=10.0) for i in range(20)]                  # 20 clips with no cluster >= 20 s
    a = V.score(cs, PR)["non_vi"]["R2"]; assert a["pairs"] == 60 * 2 and a["pairs_all_clips"] == 80 * 2 and a["unscorable_clips"] == 20 and a["hits"] == 0 and a["rate_all_clips_no_bar"] == 0.0
    b = V.score(cs + [clip("bad", "D0", [near("D0"), near("D1", 0.9)])], PR)["non_vi"]["R2"]; assert b["hits"] == 1 and b["rate"] > b["rate_all_clips_no_bar"]            # the bar rate is the stricter one
    r = V.score(cs, PR)["non_vi"]["R1"]; assert r["n"] == 80 and r["pooled"] == 60 / 80                          # R1 unchanged: unscorable clips of printed doctors are misses

def test_F4_score_refuses_a_prints_file_that_differs_from_the_pin(tmp_path=None):
    import tempfile, json, hashlib
    d = tempfile.mkdtemp(); f = f"{d}/p.json"; json.dump({"prints": [dict(doctor_uid="X", display_name="X", centroid_192_l2=[1.0] * 192)]}, open(f, "w"))
    try: V.check_prints_pin(f); raise AssertionError("must refuse")
    except SystemExit as e: assert "REFUSED" in str(e) and hashlib.sha256(open(f, "rb").read()).hexdigest() in str(e)
    old = V.PRINTS_SHA256; V.PRINTS_SHA256 = hashlib.sha256(open(f, "rb").read()).hexdigest()
    try:
        V.check_prints_pin(f)                                                                                   # the pinned content passes
        json.dump({"prints": [dict(doctor_uid="X", display_name="X", centroid_192_l2=[1.0] * 192, source_days=["2026-10-06", "2026-10-07"])]}, open(f, "w")); V.PRINTS_SHA256 = hashlib.sha256(open(f, "rb").read()).hexdigest()
        try: V.check_prints_pin(f); raise AssertionError("must refuse a source day on/after the holdout start")
        except SystemExit as e: assert "source day 2026-10-07" in str(e)
    finally: V.PRINTS_SHA256 = old
    assert V.PRINTS_SHA256 == "68a719eac7aad1aaf281df2187f0e9f9404c7dc03110bd9107386ec61a744ad4"

def test_F5_results_are_also_split_by_re_embedded_without_bars():
    cs = many(20) + [clip(f"re{i}", "D0", [near("D0")], re=True) for i in range(10)]; r = V.score(cs, PR, {"non_warehouse": 3})
    assert r["by_embedding_no_bars"]["live"]["clips"] == 60 and r["by_embedding_no_bars"]["re_embedded"]["clips"] == 10 and r["by_embedding_no_bars"]["re_embedded"]["R1_pooled"] == 1.0 and r["excluded"] == {"non_warehouse": 3}
    assert r["prereg"] == "VP-ACC-PREREG-rev3.md" and r["prints_sha256"].startswith("68a719ea") and "excluded" in V.table(r)


def test_rev3_long_windows_are_excluded_and_counted_before_everything_else():
    idx, tl, add = _holdout_fixture()
    add("at45", "2026-10-08", minutes=45.0); add("over", "2026-10-08", minutes=45.1); add("nomin", "2026-10-08", minutes=None); add("bad", "2026-10-08", minutes="12")
    out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]])
    assert [c["uid"] for c in out] == ["at45"] and ex == {"long_gt45": 1, "no_minutes": 2}

def test_rev3_count_has_no_score_and_checks_the_floor_after_the_new_filter():
    idx, tl, add = _holdout_fixture()
    for i in range(40): add(f"k{i}", "2026-10-08", doctor="D1")
    add("long", "2026-10-08", doctor="D1", minutes=90.0); add("v", "2026-10-08", doctor="D1", vi=True)
    out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]]); pr = {"D1": {}}
    c = V.count(out, need, ex, pr); assert (c["non_vi_printed_doctor_clips"], c["vi"], c["excluded"]["long_gt45"], c["status"]) == (40, 1, 1, "floor reached")
    out2 = [x for x in out if x["uid"] != "k0"]; assert V.count(out2, need, ex, pr)["status"].startswith("INCONCLUSIVE")


def test_m3_13b_minutes_non_positive_or_non_finite_are_no_minutes():
    idx, tl, add = _holdout_fixture()
    add("zero", "2026-10-08", minutes=0); add("neg", "2026-10-08", minutes=-3.0); add("inf", "2026-10-08", minutes=float("inf")); add("nan", "2026-10-08", minutes=float("nan")); add("ok", "2026-10-08", minutes=0.5)
    out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]])
    assert [c["uid"] for c in out] == ["ok"] and ex == {"no_minutes": 4}

def test_m3_13b_score_refuses_while_a_clip_still_needs_embedding_and_checks_the_sidecar():
    import tempfile, shutil, pytest
    from unittest import mock
    idx, tl, add = _holdout_fixture(); add("noemb", "2026-10-08", emb=False)
    with mock.patch.object(V, "check_prints_pin", lambda: None), mock.patch.object(V, "load_prints", lambda: {}), mock.patch.object(V, "read_index", lambda: idx), mock.patch.object(V, "timeline_of", lambda r: tl[r["consult_uid"]]):
        with pytest.raises(SystemExit) as e: V.main(["score"])
        assert "REFUSED" in str(e.value) and "no embedding" in str(e.value)
    here = tempfile.mkdtemp(); shutil.copy(f"{os.path.dirname(V.__file__)}/VP-ACC-PREREG-rev3.md", here); open(f"{here}/VP-ACC-PREREG-rev3.sha256", "w").write("0" * 64 + "  VP-ACC-PREREG-rev3.md\n")
    with pytest.raises(SystemExit): V.prereg_sidecar_check(here)
    assert V.prereg_sidecar_check() == open(f"{os.path.dirname(V.__file__)}/VP-ACC-PREREG-rev3.sha256").read().split()[0]


def test_m3_13d_markers_are_atomic_and_only_a_valid_marker_excludes():
    import tempfile
    d = tempfile.mkdtemp(); old = V.OUT; V.OUT = d
    try:
        os.makedirs(f"{d}/reembed"); idx, tl, add = _holdout_fixture()
        for u in ("empty", "junk", "trunc", "handmade", "wronguid", "short", "good"): add(u, "2026-10-08", emb=False)
        w = lambda u, txt: open(f"{d}/reembed/{u}.failed.json", "w").write(txt)
        w("empty", ""); w("junk", "x"); w("trunc", '{"consult_uid": "trunc", "attempts": 2, "reas')
        w("handmade", '{"attempts": 2}'); w("wronguid", json.dumps(dict(consult_uid="other", attempts=2, reasons=["a", "b"]))); w("short", json.dumps(dict(consult_uid="short", attempts=2, reasons=["a"])))
        V.mark_failed("good", "r1"); V.mark_failed("good", "r2")
        out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]])
        assert ex == {"embed_failed": 1} and sorted(need) == ["empty", "handmade", "junk", "short", "trunc", "wronguid"]       # only the valid 2-attempt marker excludes; every bad one leaves the clip NEEDED
        assert V.count(out, need, ex, {})["bad_marker"] == 6
        V.mark_failed("empty", "again"); assert V.marker_state("empty") == ("ok", 1)                                           # a bad marker is replaced by a fresh attempt 1
        assert not [f for f in os.listdir(f"{d}/reembed") if f.endswith(".tmp")] and oct(os.stat(f"{d}/reembed/good.failed.json").st_mode & 0o777) == "0o600"
    finally: V.OUT = old


def _w(d, u, txt): os.makedirs(f"{d}/reembed", exist_ok=True); open(f"{d}/reembed/{u}.failed.json", "w").write(txt)

def test_m3_14_embeddings_come_only_from_the_live_cutter_output_a_reembed_file_no_longer_counts():
    import tempfile
    d = tempfile.mkdtemp(); old = V.OUT; V.OUT = d
    try:
        idx, tl, add = _holdout_fixture(); add("live", "2026-10-08"); add("old", "2026-10-08", emb=False)
        os.makedirs(f"{d}/reembed"); json.dump(dict(clusters={"S0": dict(sec=50.0, emb_b64=b64(other()))}), open(f"{d}/reembed/old.json", "w"))     # the retired path's file
        out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]]); assert [c["uid"] for c in out] == ["live"] and need == ["old"] and not any(c["re_embedded"] for c in out)
    finally: V.OUT = old

def test_m3_14_prepare_is_a_recut_request_it_lists_and_runs_nothing(capsys=None):
    import tempfile, io, contextlib
    from unittest import mock
    d = tempfile.mkdtemp(); old = V.OUT; V.OUT = d; idx, tl, add = _holdout_fixture(); add("a", "2026-10-08", emb=False); add("b", "2026-10-08")
    buf = io.StringIO()
    try:
        with mock.patch.object(V, "read_index", lambda: idx), mock.patch.object(V, "timeline_of", lambda r: tl[r["consult_uid"]]), mock.patch("subprocess.run", side_effect=AssertionError("must not run anything")), contextlib.redirect_stdout(buf):
            V.prepare()
        o = json.loads(buf.getvalue()); assert o["holdout_clips_needing_a_recut"] == 1 and o["uids"] == ["a"] and "recut_queue" in o["recut_with"]
        assert not os.path.exists(f"{d}/reembed")                                                                                  # wrote nothing
    finally: V.OUT = old

def test_m3_14_a_clip_the_recut_driver_failed_on_twice_is_embed_failed_one_failure_keeps_it_needed():
    import tempfile
    d = tempfile.mkdtemp(); old = V.OUT; V.OUT = d
    try:
        idx, tl, add = _holdout_fixture(); add("once", "2026-10-08", emb=False); add("twice", "2026-10-08", emb=False)
        _w(d, "once", json.dumps(dict(consult_uid="once", attempts=1, reasons=["x"]))); _w(d, "twice", json.dumps(dict(consult_uid="twice", attempts=2, reasons=["x", "y"])))
        out, need, ex = V.holdout(idx, lambda r: tl[r["consult_uid"]]); assert need == ["once"] and ex == {"embed_failed": 1}
    finally: V.OUT = old

def test_m3_14_score_refuses_a_wrong_dimension_or_nan_embedding():
    import pytest
    ok = [clip("a", "D0", [near("D0")])]; V.check_embeddings(ok)
    for bad in (np.ones(10), np.full(192, np.nan), np.append(unit(rng.normal(size=191)), np.inf)):
        with pytest.raises(SystemExit) as e: V.check_embeddings([clip("x", "D0", [bad])])
        assert "192-d" in str(e.value)
