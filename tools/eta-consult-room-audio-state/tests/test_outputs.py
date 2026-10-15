"""Checks on the written shadow files (skipped when none exist yet)."""
import glob, json, os
from datetime import datetime
import pytest

OUT = os.path.expanduser("~/eta-data/consult/audio-state")
FILES = sorted(glob.glob(os.path.join(OUT, "room_*.jsonl")))
pytestmark = pytest.mark.skipif(not FILES, reason="no shadow output")


def load(fn):
    return [json.loads(l) for l in open(fn)]


def test_every_file_sums_to_1440_and_is_contiguous():
    for fn in FILES:
        rs = load(fn)
        mins = sum((datetime.fromisoformat(r["ts_end"]) - datetime.fromisoformat(r["ts_start"])).total_seconds() for r in rs) / 60
        assert abs(mins - 1440) < 0.01, (fn, mins)
        for p, n in zip(rs, rs[1:]):
            assert p["ts_end"] == n["ts_start"], fn


def test_states_are_the_allowed_set():
    allowed = {"recorder_off", "muted", "zero_all_day", "audio_present", "audio_gated", "withheld"}
    for fn in FILES:
        assert {r["state"] for r in load(fn)} <= allowed


def test_no_gaps_between_a_rooms_consecutive_days():
    by = {}
    for fn in FILES:
        room, day = os.path.basename(fn)[:-6].rsplit("_", 1)
        by.setdefault(room, []).append(day)
    for room, days in by.items():
        ds = sorted(datetime.fromisoformat(d) for d in days)
        assert all((b - a).days == 1 for a, b in zip(ds, ds[1:])), room


def test_cache_dir_private():
    c = os.path.join(OUT, "cache")
    if os.path.isdir(c):
        assert oct(os.stat(c).st_mode & 0o777) == "0o700"


def test_no_zero_length_or_sliver_intervals():
    for fn in FILES:
        for r in load(fn):
            dt = (datetime.fromisoformat(r["ts_end"]) - datetime.fromisoformat(r["ts_start"])).total_seconds()
            assert dt >= 1.0, (fn, r["ts_start"], dt)


def test_every_known_room_is_tiled_through_the_last_day():
    by = {}
    for fn in FILES:
        room, day = os.path.basename(fn)[:-6].rsplit("_", 1)
        by.setdefault(room, []).append(day)
    last = {max(d) for d in by.values()}
    assert len(last) == 1, last


def test_blind_room_days_are_single_withheld_interval_and_cache_has_none():
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from ras.blind import blind_room_days
    blind = blind_room_days()
    for fn in FILES:
        room, day = os.path.basename(fn)[:-6].rsplit("_", 1)
        rs = load(fn)
        if (room, day) in blind:
            assert len(rs) == 1 and rs[0]["state"] == "withheld" and rs[0]["evidence"] == {"reason": "blind_holdout"}
        else:
            assert all(r["state"] != "withheld" for r in rs)
    cache = os.path.join(OUT, "cache", "feat.jsonl")
    if os.path.exists(cache):
        manifest = {}
        for l in open(os.path.expanduser("~/eta-data/tapes/manifest.jsonl")):
            m = json.loads(l)
            manifest[m["id"]] = m
        from ras.classify import parse_ts, ist_day
        for l in open(cache):
            m = manifest[json.loads(l)["id"]]
            assert (m["room_id"], ist_day(parse_ts(m["started_at"]))) not in blind


def test_after_snapshot_only_near_the_data_edge():
    """Unobserved time starts at (latest data end - 15 min) or later; earlier dark time is plain recorder_off."""
    last_data = max(datetime.fromisoformat(r["ts_end"]) for fn in FILES for r in load(fn)
                    if r["state"] not in ("recorder_off", "withheld"))
    for fn in FILES:
        for r in load(fn):
            if r["evidence"].get("after_snapshot"):
                assert (last_data - datetime.fromisoformat(r["ts_start"])).total_seconds() <= 900 + 1, (fn, r["ts_start"])


def test_dead_kiosks_have_plain_recorder_off_days():
    for room in ("room_2qe955hy", "room_7egw2my6"):
        rs = load(os.path.join(OUT, f"{room}_2026-10-05.jsonl"))
        assert [r["state"] for r in rs] == ["recorder_off"] and not rs[0]["evidence"].get("after_snapshot")


def test_audio_gated_carries_chatter_evidence():
    n = 0
    for fn in FILES:
        for r in load(fn):
            if r["state"] == "audio_gated":
                n += 1
                e = r["evidence"]
                assert e["gated_reason"] and set(e["gated_reason"]) <= {"density", "gate", "zero_frac"}
                assert e["chatter_seconds"] >= 0 and e["n_stretches"] >= 0 and e["peak_blips_per_min"] >= 0
                assert 0.0 <= e["zero_fraction"] <= 1.0
                if "density" in e["gated_reason"]:
                    assert e["chatter_seconds"] > 0 and e["n_stretches"] >= 1 and e["peak_blips_per_min"] > 2.0
                if "zero_frac" in e["gated_reason"]:
                    assert e["zero_fraction"] >= 0.5
            else:
                assert "chatter_seconds" not in r["evidence"] and "gated_reason" not in r["evidence"]
            if r["state"] == "audio_present":
                assert r["evidence"]["zero_frac"] is None or r["evidence"]["zero_frac"] < 0.5
    assert n > 0


def test_day_summary_has_one_exact_row_per_room_day_of_the_written_files(tmp_path):
    """Builds its own summary from the shadow files (the committed day-summary.jsonl is only regenerated by make_report,
    so it may be stale): one row per room-day file, each exactly 1440 min."""
    from ras import report
    allint = {}
    for fn in FILES:
        room, day = os.path.basename(fn)[:-6].rsplit("_", 1)
        for r in load(fn):
            a, b = (datetime.fromisoformat(r[k]).timestamp() for k in ("ts_start", "ts_end"))
            allint.setdefault(room, []).append({"ist_day": day, "state": r["state"], "_a": a, "_b": b})
    out = tmp_path / "day-summary.jsonl"
    report.write_day_summary(allint, {}, str(out))
    rows = [json.loads(l) for l in open(out)]
    assert len(rows) == len(FILES)
    assert {(r["room_id"], r["ist_day"]) for r in rows} == {tuple(os.path.basename(f)[:-6].rsplit("_", 1)) for f in FILES}
    for r in rows:
        assert abs(sum(r[c] for c in report.SUMMARY_COLS) - 1440) < 0.1, r
