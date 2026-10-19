"""Synthetic-fixture tests for diar_agreement. No real data, no text anywhere."""
import itertools
import json
import math
import os
import stat
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import diar_agreement as da  # noqa: E402

T0 = 1_789_000_000_000
DUR = 60.0
MODEL = "nvidia/Nemotron-3-Diarization"


# ---- oracle: bench-C score.py:122-219 copied verbatim (use2 and helpers), the reference for parity ----
FR = 0.1


def bench_frames(sg, dur):
    n = int(math.ceil(dur / FR))
    A = {}
    for a, b, s in sg:
        i0 = int(round(a / FR)); i1 = max(i0 + 1, int(round(b / FR)))
        A.setdefault(s, np.zeros(n, bool))[i0:min(n, i1)] = True
    return A, n


def bench_best_map(O):
    r, h = O.shape
    if r == 0 or h == 0:
        return {}
    if r <= h:
        best = (-1, None)
        for p in itertools.permutations(range(h), r):
            v = O[range(r), p].sum()
            if v > best[0]:
                best = (v, p)
        return {i: best[1][i] for i in range(r)}
    best = (-1, None)
    for p in itertools.permutations(range(r), h):
        v = O[p, range(h)].sum()
        if v > best[0]:
            best = (v, p)
    return {best[1][j]: j for j in range(h)}


def bench_use2(Ar, Ah, n, minspk=1.0):
    R = [s for s in Ar if Ar[s].sum() * FR >= minspk]
    Hs = [s for s in Ah if Ah[s].sum() * FR >= minspk]
    if not R or not Hs:
        return dict(dis=float('nan'))
    RM = np.stack([Ar[s] for s in R]); HM = np.stack([Ah[s] for s in Hs])
    O = (RM[:, None, :] & HM[None, :, :]).sum(-1)
    mp = bench_best_map(O)
    nr = RM.sum(0); nh = HM.sum(0)
    correct = sum(O[i, j] for i, j in mp.items())
    den = np.maximum(nr, nh).sum()
    return dict(dis=float((den - correct) / den) if den else float('nan'))


# ---- fixtures ----
def seg(a_s, b_s, spk):
    return {"speaker": spk, "t0_ms": T0 + int(a_s * 1000), "t1_ms": T0 + int(b_s * 1000)}


def track(segs, **kw):
    d = {"schema": "reb.track.v1", "layer": "diar", "status": "ok", "segments": segs,
         "model": MODEL, "version": "f667ed73", "extras": {"created_at": "2026-10-14T00:00:00Z"}}
    d.update(kw)
    return d


SARVAM = [seg(0, 10, "A"), seg(10, 20, "B"), seg(20, 30, "A"), seg(30, 45, "C"), seg(45, 58, "B")]
NEMO_SAME = [seg(0, 10, "x"), seg(10, 20, "y"), seg(20, 30, "x"), seg(30, 45, "z"), seg(45, 58, "y")]
NEMO_OFF = [seg(0, 10, "x"), seg(10, 20, "x"), seg(20, 30, "y"), seg(30, 45, "y"), seg(45, 58, "x"),
            seg(3, 8, "z")]


def bench_dis(nemo, sar):
    def sg(t):
        return sorted((max(0.0, (s["t0_ms"] - T0) / 1000.0), min(DUR, (s["t1_ms"] - T0) / 1000.0), s["speaker"])
                      for s in t if min(DUR, (s["t1_ms"] - T0) / 1000.0) > max(0.0, (s["t0_ms"] - T0) / 1000.0))
    As, n = bench_frames(sg(sar), DUR)
    An, _ = bench_frames(sg(nemo), DUR)
    return bench_use2(As, An, n)["dis"]


def write_consult(root, uid, nemo_segs, sar_segs, date="2026-10-01", room="room_a", nemo_ver="f667ed73",
                  sar_hash="04486dbb", with_nemo=True):
    cdir = root / date / room / "_consults" / uid
    (cdir / "tracks").mkdir(parents=True)
    (cdir / "manifest.json").write_text(json.dumps(
        {"ist_date": date, "t0_ms": T0, "t1_ms": T0 + int(DUR * 1000), "audio": {"duration_ms": int(DUR * 1000)}}))
    if with_nemo:
        (cdir / "tracks" / f"diar.nemotron__{nemo_ver}__52a308d1.json").write_text(
            json.dumps(track(nemo_segs, version=nemo_ver)))
    (cdir / "tracks" / f"diar.sarvam-saaras-v3__saaras-v3__{sar_hash}.json").write_text(
        json.dumps(track(sar_segs, model="saaras:v3", version="saaras-v3", engine="sarvam-saaras-v3")))
    return cdir


# ---- metric parity ----
@pytest.mark.parametrize("nemo", [NEMO_SAME, NEMO_OFF])
def test_metric_parity_with_bench(nemo):
    got = da.compute_dis(track(nemo), track(SARVAM), T0, DUR)
    assert got == pytest.approx(bench_dis(nemo, SARVAM), abs=1e-12)


def test_identical_is_perfect_and_off_is_not():
    assert da.compute_dis(track(NEMO_SAME), track(SARVAM), T0, DUR) == pytest.approx(0.0)
    assert 0.0 < da.compute_dis(track(NEMO_OFF), track(SARVAM), T0, DUR) < 1.0


def test_scipy_and_brute_force_agree():
    As, _ = da.frames(da.segs_of(track(SARVAM), T0, DUR), DUR)
    An, _ = da.frames(da.segs_of(track(NEMO_OFF), T0, DUR), DUR)
    R, H = list(As.values()), list(An.values())
    O = (np.stack(R)[:, None, :] & np.stack(H)[None, :, :]).sum(-1)
    a, b = da.best_map(O), da.best_map_brute(O)
    assert sum(O[i, j] for i, j in a.items()) == sum(O[i, j] for i, j in b.items())


def test_clamping_and_short_speakers_dropped():
    # a sub-second speaker is ignored (minspk), out-of-clip time is clamped
    sar = SARVAM + [seg(5, 5.5, "tiny"), seg(-5, -1, "before")]
    assert da.compute_dis(track(NEMO_SAME), track(sar), T0, DUR) == pytest.approx(0.0)


# ---- review flag boundary: dis >= 0.5 ----
@pytest.mark.parametrize("dis,flag", [(0.0, False), (0.4999, False), (0.5, True), (0.5001, True), (1.0, True)])
def test_review_flag_boundary(dis, flag):
    r = da.make_row("c1", "2026-10-01", dis, MODEL + "@f667ed7", "diar.sarvam__x__y")
    assert r["review_flag"] is flag
    assert r["diar_agreement"] == pytest.approx(1 - dis, abs=1e-6)


def test_flag_uses_dis_not_rounded_agreement():
    r = da.make_row("c1", "2026-10-01", 0.4999999, MODEL + "@f667ed7", "s")
    assert r["review_flag"] is False and r["diar_agreement"] == 0.5


@pytest.mark.parametrize("bad", [float("nan"), -0.1, 1.1, None])
def test_make_row_rejects_bad_dis(bad):
    with pytest.raises(da.InputError):
        da.make_row("c", "d", bad, "m", "s")


# ---- row shape, no text ----
def test_row_fields_and_no_text(tmp_path):
    write_consult(tmp_path, "pqm_aaa", NEMO_OFF, SARVAM)
    rows, stats = da.run(str(tmp_path), str(tmp_path / "out.jsonl"))
    assert stats["rows"] == 1
    r = rows[0]
    assert tuple(r) == da.FIELDS
    assert r["nemotron_model"] == "nvidia/Nemotron-3-Diarization@f667ed7"
    assert r["sarvam_track_id"] == "diar.sarvam-saaras-v3__saaras-v3__04486dbb"
    assert isinstance(r["review_flag"], bool) and 0.0 <= r["diar_agreement"] <= 1.0
    assert r["computed_at"].endswith("Z")
    for v in r.values():
        assert isinstance(v, (str, bool, float))
    assert not {"text", "transcript", "name", "speaker"} & set(r)


# ---- writer: 0600, append-only, idempotent ----
def test_create_mode_0600_even_with_loose_umask(tmp_path):
    out = tmp_path / "sub" / "o.jsonl"
    old = os.umask(0o022)
    try:
        da.append_rows(str(out), [{"consult_uid": "a"}])
    finally:
        os.umask(old)
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600


def test_append_never_truncates(tmp_path):
    out = tmp_path / "o.jsonl"
    out.write_text('{"consult_uid":"old"}\n')
    os.chmod(out, 0o640)
    da.append_rows(str(out), [{"consult_uid": "new"}])
    lines = out.read_text().splitlines()
    assert lines == ['{"consult_uid":"old"}', '{"consult_uid":"new"}']
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o640  # existing mode untouched


def test_empty_append_creates_nothing(tmp_path):
    out = tmp_path / "o.jsonl"
    assert da.append_rows(str(out), []) == 0 and not out.exists()


def test_dry_run_default_writes_nothing(tmp_path, capsys):
    write_consult(tmp_path, "pqm_aaa", NEMO_OFF, SARVAM)
    out = tmp_path / "o.jsonl"
    assert da.main(["--reb-root", str(tmp_path), "--out", str(out)]) == 0
    assert not out.exists()
    assert json.loads(capsys.readouterr().out.strip())["consult_uid"] == "pqm_aaa"


def test_write_then_idempotent_skip_then_force(tmp_path):
    write_consult(tmp_path, "pqm_aaa", NEMO_OFF, SARVAM)
    out = str(tmp_path / "o.jsonl")
    assert da.main(["--reb-root", str(tmp_path), "--out", out, "--write"]) == 0
    assert len(open(out).read().splitlines()) == 1
    da.main(["--reb-root", str(tmp_path), "--out", out, "--write"])
    assert len(open(out).read().splitlines()) == 1  # skipped
    da.main(["--reb-root", str(tmp_path), "--out", out, "--write", "--force"])
    assert len(open(out).read().splitlines()) == 2  # forced
    assert da.read_latest(out)["pqm_aaa"]["consult_uid"] == "pqm_aaa"


def test_new_sarvam_track_or_model_not_skipped(tmp_path):
    out = str(tmp_path / "o.jsonl")
    root = tmp_path / "reb"
    cdir = write_consult(root, "pqm_aaa", NEMO_OFF, SARVAM)
    da.run(str(root), out, write=True)
    (cdir / "tracks" / "diar.sarvam-saaras-v3__saaras-v3__ffffffff.json").write_text(
        json.dumps(track(SARVAM, extras={"created_at": "2026-10-20T00:00:00Z"})))
    rows, stats = da.run(str(root), out, write=True)
    assert stats["rows"] == 1 and rows[0]["sarvam_track_id"].endswith("ffffffff")
    assert len(open(out).read().splitlines()) == 2
    assert da.read_latest(out)["pqm_aaa"]["sarvam_track_id"].endswith("ffffffff")


def test_read_latest_ignores_malformed_lines(tmp_path):
    out = tmp_path / "o.jsonl"
    out.write_text('{"consult_uid":"a","v":1}\nnot json\n[1]\n{"consult_uid":"a","v":2}\n')
    assert da.read_latest(str(out))["a"]["v"] == 2


# ---- malformed input ----
def test_missing_nemotron_track_is_skipped_not_error(tmp_path):
    write_consult(tmp_path, "pqm_aaa", [], SARVAM, with_nemo=False)
    rows, stats = da.run(str(tmp_path), str(tmp_path / "o.jsonl"))
    assert rows == [] and stats["missing_track"] == 1


@pytest.mark.parametrize("segs", [[{"speaker": "a"}], [{"t0_ms": "x", "t1_ms": 1, "speaker": "a"}],
                                  [{"t0_ms": T0, "t1_ms": T0 + 1000}]])
def test_malformed_segments_raise_and_run_continues(tmp_path, segs):
    write_consult(tmp_path, "pqm_bad", segs, SARVAM)
    write_consult(tmp_path, "pqm_ok", NEMO_OFF, SARVAM, room="room_b")
    rows, stats = da.run(str(tmp_path), str(tmp_path / "o.jsonl"), log=open(os.devnull, "w"))
    assert [r["consult_uid"] for r in rows] == ["pqm_ok"] and stats["bad_input"] == 1


def test_malformed_manifest_and_empty_speech(tmp_path):
    cdir = write_consult(tmp_path, "pqm_m", NEMO_OFF, SARVAM)
    (cdir / "manifest.json").write_text("{not json")
    with pytest.raises(da.InputError):
        da.row_from_consult_dir(str(cdir))
    (cdir / "manifest.json").write_text(json.dumps({"t0_ms": T0}))
    with pytest.raises(da.InputError):
        da.row_from_consult_dir(str(cdir))
    cdir2 = write_consult(tmp_path, "pqm_e", [], SARVAM, room="room_e")
    with pytest.raises(da.InputError):  # nan disagreement, no comparable speech
        da.row_from_consult_dir(str(cdir2))


def test_failed_status_track_ignored(tmp_path):
    cdir = write_consult(tmp_path, "pqm_f", NEMO_OFF, SARVAM)
    p = next((cdir / "tracks").glob("diar.nemotron*"))
    d = json.loads(p.read_text()); d["status"] = "failed"; p.write_text(json.dumps(d))
    assert da.row_from_consult_dir(str(cdir)) is None
