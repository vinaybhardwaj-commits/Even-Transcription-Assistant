import csv
import json
import os

import pytest

from kit.reb import pitch_match as pm
from .test_sarvam_lane import ROOM, Env, FakeGW, make_row

D = "2026-10-08"      # a translate day: the lane writes a translate track too


def shifted(uid, date, start_hm):
    """A 5-minute consult starting at date start_hm (09:42:22.522 in make_row)."""
    r = make_row(uid=uid, date=date)
    base = {"span_start": "09:42:22.522", "t_open": "09:43:22.522", "t_close": "09:47:22.522", "span_end": "09:47:22.522"}
    for k, v in base.items():
        h, m = int(v[:2]), int(v[3:5])
        total = h * 60 + m + (int(start_hm[:2]) * 60 + int(start_hm[3:]) - (9 * 60 + 42))
        r[k] = f"{date} {total // 60:02d}:{total % 60:02d}:{v[6:]}"
    return r


def make_env(tmp, rows):
    env = Env(tmp, rows)
    env.run(FakeGW(), date=rows[0]["ist_date"])
    return env


def clips_csv(tmp, *clips):
    p = tmp / "clips.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["clip_id", "date", "room", "scribe_room_id", "window_from_ist", "window_to_ist"])
        w.writeheader()
        for c in clips:
            w.writerow({"date": D, "room": "OPD", **c})
    return str(p)


def go(env, tmp, clips, held=lambda d, r: False):
    out = str(tmp / "out")
    counts = pm.run(clips, out, root=env.root, is_held=held)
    return counts, out


def result(out, clip_id):
    return json.load(open(os.path.join(out, clip_id + ".json")))


def test_matched_partial_none_and_overlapping_segments_only(tmp_path):
    env = make_env(tmp_path, [make_row(date=D)])                    # consult 09:42:22.522 .. 09:47:22.522 (300 s), segments at +1.5..4.0 s and +4.5..9.25 s
    clips = clips_csv(tmp_path,
                      {"clip_id": "c_in", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:43:00", "window_to_ist": f"{D} 09:44:00"},       # fully inside, but past the segments
                      {"clip_id": "c_seg", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:42:00", "window_to_ist": f"{D} 09:42:27"},      # 4.478 s overlap...
                      {"clip_id": "c_half", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:47:00", "window_to_ist": f"{D} 09:48:00"},    # 22.478 s of 60 s
                      {"clip_id": "c_out", "scribe_room_id": ROOM, "window_from_ist": f"{D} 11:00:00", "window_to_ist": f"{D} 11:01:00"},
                      {"clip_id": "c_room", "scribe_room_id": "room_other999", "window_from_ist": f"{D} 09:43:00", "window_to_ist": f"{D} 09:44:00"})
    counts, out = go(env, tmp_path, clips)
    assert counts == {"matched": 1, "partial": 2, "none": 2}
    r = result(out, "c_in")
    assert r["status"] == "matched" and r["overlap_s"] == 60.0 and r["segments"] == [] and r["consults"][0]["overlap_s"] == 60.0       # matched even with no speech in the window
    r = result(out, "c_seg")
    assert r["status"] == "partial" and r["overlap_s"] == 4.478 and len(r["segments"]) == 1                                              # the second segment starts at :27.022, just after the window
    assert r["segments"][0]["t0_ist"] == "2026-10-08T09:42:24.022+05:30" and r["segments"][0]["speaker"] == "0" and r["segments"][0]["lang"] == "hi-IN"
    assert result(out, "c_half")["status"] == "partial" and result(out, "c_out")["status"] == "none" and result(out, "c_room")["consults"] == []
    idx = open(os.path.join(out, "index.csv")).read().splitlines()
    assert idx[0] == "clip_id,consult_uids,overlap_s,status" and idx[1].startswith("c_in,uid123abc,60.0,matched") and idx[4].endswith(",0.0,none")


def test_the_50_percent_threshold(tmp_path):
    env = make_env(tmp_path, [make_row(date=D)])                    # consult ends 09:47:22.522
    clips = clips_csv(tmp_path,
                      {"clip_id": "half", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:46:22.522", "window_to_ist": f"{D} 09:48:22.522"},   # 60 of 120 s = 50%
                      {"clip_id": "less", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:46:22.600", "window_to_ist": f"{D} 09:48:22.600"})  # 59.922 of 120 s
    counts, out = go(env, tmp_path, clips)
    assert result(out, "half")["status"] == "matched" and result(out, "less")["status"] == "partial"


def test_english_beside_the_text_where_the_translate_track_exists(tmp_path):
    env = make_env(tmp_path, [make_row(date=D)])
    clips = clips_csv(tmp_path, {"clip_id": "c", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:42:00", "window_to_ist": f"{D} 09:43:00"})
    r = result(go(env, tmp_path, clips)[1], "c")
    assert r["consults"][0]["has_translate"] is True and all("english" in s and s["english"] for s in r["segments"])
    old = "2026-10-06"                                                   # before the translate lane: no translate track, no english key
    env2 = make_env(tmp_path / "e2", [make_row(date=old)])
    clips2 = clips_csv(tmp_path, {"clip_id": "o", "scribe_room_id": ROOM, "window_from_ist": f"{old} 09:42:00", "window_to_ist": f"{old} 09:43:00"})
    r2 = result(go(env2, tmp_path / "x", clips2)[1], "o")
    assert r2["consults"][0]["has_translate"] is False and all("english" not in s for s in r2["segments"]) and r2["segments"]


def test_two_consults_union_of_spans_and_no_double_count(tmp_path):
    rows = [make_row(uid="uidAAA", date=D), shifted("uidBBB", D, "09:50"), shifted("uidCCC", D, "09:44")]        # CCC overlaps AAA (09:44..09:49 vs 09:42..09:47)
    env = make_env(tmp_path, rows)
    clips = clips_csv(tmp_path, {"clip_id": "u", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:42:22.522", "window_to_ist": f"{D} 09:52:22.522"})
    r = result(go(env, tmp_path, clips)[1], "u")
    assert sorted(c["consult_uid"] for c in r["consults"]) == ["uidAAA", "uidBBB", "uidCCC"]
    assert r["overlap_s"] == 540.0 and r["status"] == "matched"                                                # 09:42:22..09:49:22 union (7 min) + 09:50..09:55 inside the window (2 min)


def test_blind_room_day_is_none_without_a_reason_and_reads_nothing(tmp_path):
    env = make_env(tmp_path, [make_row(date=D)])
    clips = clips_csv(tmp_path, {"clip_id": "b", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:42:00", "window_to_ist": f"{D} 09:43:00"})
    r = result(go(env, tmp_path, clips, held=lambda d, r_: True)[1], "b")
    assert r["status"] == "none" and "reason" not in r and r["consults"] == [] and r["segments"] == []


def test_files_are_private_no_doctor_fields_and_csv_columns_checked(tmp_path):
    env = make_env(tmp_path, [make_row(date=D)])
    clips = clips_csv(tmp_path, {"clip_id": "c", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:42:00", "window_to_ist": f"{D} 09:43:00"})
    counts, out = go(env, tmp_path, clips)
    assert oct(os.stat(out).st_mode & 0o777) == "0o700"
    for n in os.listdir(out):
        assert oct(os.stat(os.path.join(out, n)).st_mode & 0o777) == "0o600"
    dump = open(os.path.join(out, "c.json")).read().lower()
    for bad in ("doctor", "quality", "signature", "t_open", "dr "):
        assert bad not in dump
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("clip_id,room\nx,y\n")
    with pytest.raises(ValueError):
        pm.read_clips(str(bad_csv))
    assert pm.parse_ist("2026-10-08 10:15:00") == pm.parse_ist("2026-10-08T10:15:00+05:30") == pm.parse_ist("2026-10-08T04:45:00Z")
    assert pm.ist_days(pm.parse_ist("2026-10-08 23:50:00"), pm.parse_ist("2026-10-09 00:10:00")) == ["2026-10-08", "2026-10-09"]


def test_empty_window_and_guard_failure(tmp_path, monkeypatch):
    env = make_env(tmp_path, [make_row(date=D)])
    clips = clips_csv(tmp_path, {"clip_id": "e", "scribe_room_id": ROOM, "window_from_ist": f"{D} 09:43:00", "window_to_ist": f"{D} 09:43:00"})
    r = result(go(env, tmp_path, clips)[1], "e")
    assert r["status"] == "none" and r["reason"] == "empty_window"
    from kit.reb.from_hist import GuardUnavailable

    def boom():
        raise GuardUnavailable("none")
    monkeypatch.setattr(pm, "load_heldout", boom)
    with pytest.raises(GuardUnavailable):
        pm.run(clips, str(tmp_path / "o2"), root=env.root)
