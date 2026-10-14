import datetime
import hashlib
import json
import os
import types

import pytest

from kit.reb import classify_pre_2oct as cp
from kit.reb import encounter as enc
from kit.reb import room_windows as rw
from kit.reb import sarvam_lane as sl
from kit.reb import s2_driver as s2
from kit.reb import window_lanes as wl
from kit.reb import write_track
from kit.reb.writer import config_hash

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
ROOM = "room_aaaa1111"
TODAY = "2026-10-12"


def ms(y, mo, d, h, mi=0):
    return int(datetime.datetime(y, mo, d, h, mi, tzinfo=IST).timestamp() * 1000)


def iso(t):
    return datetime.datetime.fromtimestamp(t / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def tapes(tmp, chunks):
    """chunks: [(start_ms, dur_ms, key)] -> a tape manifest path"""
    p = tmp / "manifest.jsonl"
    rows = [{"id": f"c{i}", "room_id": ROOM, "idx": i, "r2_key": key, "started_at": iso(s), "duration_ms": d, "size_bytes": 100 + i, "sha256": hashlib.sha256(key.encode()).hexdigest(), "source": "primary",
             "path": f"{ROOM}/x{i}.webm"} for i, (s, d, key) in enumerate(chunks)]
    rows.append({"id": "sec", "room_id": ROOM, "r2_key": "secondary", "started_at": iso(chunks[0][0]), "duration_ms": 300000, "size_bytes": 1, "sha256": "z", "source": "secondary", "path": "n"})
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return str(p)


def make(tmp, chunks, **kw):
    root = tmp / "reb"
    root.mkdir(exist_ok=True)
    return rw.make(str(root), tapes(tmp, chunks), today=kw.pop("today", TODAY), is_held=kw.pop("is_held", lambda d, r: False), labels={ROOM: "OPD 9"}, **kw), str(root)


def manifest(root, date, wid):
    return json.load(open(os.path.join(root, date, ROOM, wid, "manifest.json")))


def test_slots_ids_manifest_and_the_deterministic_audio_sha(tmp_path):
    # one 5-min chunk 09:02-09:07 IST on 9 Oct (inside the 09:00 slot) and one 09:55-10:05 (across the 09:45 and 10:00 slots)
    c = [(ms(2026, 10, 9, 9, 2), 300000, "k1"), (ms(2026, 10, 9, 9, 55), 600000, "k2")]
    res, root = make(tmp_path, c, write=True)
    assert res["created"] == 3 and res["slots"] == 3 and res["per_day"] == {"2026-10-09": {"slots": 3, "created": 3}}
    m = manifest(root, "2026-10-09", "c-2026-10-09_room_aaaa1111_0900")
    assert (m["source_kind"], m["clock"], m["room_slug"], m["t1_ms"] - m["t0_ms"]) == ("room_tape", "tape_utc", "OPD 9", 900000) and m["tracks"] == []
    a = m["audio"]
    assert a["r2_key"] == f"tape:{ROOM}" and a["sample_rate"] == 0 and a["duration_ms"] == 900000 and a["extras"]["n_chunks"] == 1 and a["extras"]["created_by"] == "room_windows"
    assert a["extras"]["covered_fraction"] == round(300000 / 900000, 4)
    assert a["sha256"] == hashlib.sha256(f"k1 100 {hashlib.sha256(b'k1').hexdigest()}".encode()).hexdigest()               # sha256 of the sorted "key size sha" lines
    assert manifest(root, "2026-10-09", "c-2026-10-09_room_aaaa1111_0945")["audio"]["sha256"] != a["sha256"]
    assert {os.path.basename(p) for p in os.listdir(os.path.join(root, "2026-10-09", ROOM))} == {"c-2026-10-09_room_aaaa1111_0900", "c-2026-10-09_room_aaaa1111_0945", "c-2026-10-09_room_aaaa1111_1000"}
    assert not os.path.exists(os.path.join(root, "2026-10-09", "index.jsonl"))                      # no index line until a track exists
    # the sha depends on the chunk set only (same chunks -> same sha), not on when it ran
    res2, root2 = make(tmp_path / "again" if (tmp_path / "again").mkdir() is None else tmp_path, c, write=True)
    assert manifest(root2, "2026-10-09", "c-2026-10-09_room_aaaa1111_0900")["audio"]["sha256"] == a["sha256"]


def test_past_days_from_the_first_date_only_and_idempotent(tmp_path):
    c = [(ms(2026, 10, 7, 10), 300000, "old"), (ms(2026, 10, 8, 10), 300000, "first"), (ms(2026, 10, 11, 10), 300000, "yday"), (ms(2026, 10, 12, 10), 300000, "today")]
    res, root = make(tmp_path, c, write=True)
    assert res["created"] == 2 and res["before_first"] == 1 and res["today_skipped"] == 1 and sorted(res["per_day"]) == ["2026-10-08", "2026-10-11"]
    res2, _ = make(tmp_path, c, write=True)
    assert res2["created"] == 0 and res2["exists"] == 2                                          # create-only: the second run changes nothing
    assert manifest(root, "2026-10-08", "c-2026-10-08_room_aaaa1111_1000")["audio"]["extras"]["n_chunks"] == 1
    dry, root3 = make(tmp_path / "d" if (tmp_path / "d").mkdir() is None else tmp_path, c)
    assert dry["would_create"] == 2 and not os.path.exists(os.path.join(root3, "2026-10-08"))     # a dry run writes nothing


def test_a_slot_that_already_has_any_window_gets_no_second_one(tmp_path):
    c = [(ms(2026, 10, 9, 10, 5), 300000, "k")]
    root = tmp_path / "reb"
    stub = {"window_id": "l3-c003-r1", "room_id": ROOM, "room_slug": ROOM, "ist_date": "2026-10-09", "t0_ms": ms(2026, 10, 9, 9, 30), "t1_ms": ms(2026, 10, 9, 10, 20), "source_kind": "room_tape",
            "audio": {"r2_key": "hist-chunks:x", "sha256": "unknown:from_hist", "sample_rate": 0, "duration_ms": 3000000}}
    from kit.reb import writer
    writer.write_manifest(str(root), "2026-10-09", ROOM, "l3-c003-r1", stub)                      # a hist window of another id that overlaps the 10:00 slot
    res = rw.make(str(root), tapes(tmp_path, c), write=True, today=TODAY, is_held=lambda d, r: False, labels={})
    assert res["created"] == 0 and res["exists_overlap"] == 1


def test_held_out_guard_is_applied(tmp_path):
    res, root = make(tmp_path, [(ms(2026, 10, 9, 10), 300000, "k")], write=True, is_held=lambda d, r: True)
    assert res["blind_refused"] == 1 and res["created"] == 0


def test_the_planner_finds_the_audio_of_a_room_window_by_room_and_time(tmp_path):
    c = [(ms(2026, 10, 9, 10, 2), 300000, "k")]
    res, root = make(tmp_path, c, write=True)
    m = manifest(root, "2026-10-09", "c-2026-10-09_room_aaaa1111_1000")
    tp = tmp_path / "tp"
    (tp / ROOM).mkdir(parents=True)
    (tp / ROOM / "x0.webm").write_bytes(b"chunk")
    by_room = {ROOM: [{"id": "c0", "idx": 0, "started_at": iso(c[0][0]), "duration_ms": 300000, "path": f"{ROOM}/x0.webm", "sha256": hashlib.sha256(b"chunk").hexdigest()}]}
    plan = sl.window_plan(m, by_room, str(tp), str(tmp_path))
    assert plan["source"] == "tape_chunks" and plan["covered_ms"] == 300000


def test_encounter_attaches_to_the_new_windows_and_the_alarm_day_clears(tmp_path):
    c = [(ms(2026, 10, 10, 10, 2), 300000, "k")]
    res, root = make(tmp_path, c, write=True)
    idx = tmp_path / "clips.jsonl"
    idx.write_text(json.dumps({"consult_uid": "u1", "status": "cut", "ist_date": "2026-10-10"}) + "\n" + json.dumps({"consult_uid": "u2", "status": "skipped", "ist_date": "2026-10-11"}) + "\n")
    today = datetime.date(2026, 10, 12)
    days, facts = enc.no_encounter_days(root, str(idx), today=today)
    assert days == ["2026-10-10"] and facts == {"2026-10-10": {"cut_clips": 1, "encounter_tracks": 0}, "2026-10-11": {"cut_clips": 0, "encounter_tracks": 0}}    # clips but no tracks: alarm
    a = types.SimpleNamespace(write=True, date=None, since="2026-10-08", dry_run=False)
    cnt = enc.run(a, fetch=lambda room, f, t: [], root=root, is_held=lambda d, r: False, outbox=str(tmp_path / "ob.jsonl"), log_dir=None)
    assert cnt["windows"] == 1 and cnt["written"] == 1 and cnt["errors"] == 0                       # the step now enumerates the window and writes its track
    assert enc.no_encounter_days(root, str(idx), today=today)[0] == []                               # cleared
    assert enc.no_encounter_days(root, str(tmp_path / "missing.jsonl"), today=today) == ([], {"error": "cutter index unreadable"})
    assert enc.no_encounter_days(root, str(idx), today=datetime.date(2026, 10, 14))[0] == []          # a day older than [today-2, yesterday] is not checked
    assert cnt["no_encounter_days"] == 0 or "no_encounter_day_list" in cnt


def test_no_lane_picks_the_new_windows_up_by_default(tmp_path):
    c = [(ms(2026, 10, 9, 10, 2), 300000, "k"), (ms(2026, 10, 1, 10, 2), 300000, "pre")]
    res, root = make(tmp_path, c, write=True, first="2026-10-01")
    assert res["created"] == 2
    # the S2 census stops before 2026-10-02 and keeps only what is before it: the 9 Oct window is never selected
    rows = []
    cp.census(root, cutoff=cp.CUTOFF, is_held=lambda d, r: False, tapes=str(tmp_path), data=str(tmp_path), rows_out=rows, kinds=("room_tape",))
    assert all(r["window_id"].startswith("c-2026-10-01") or r["window_id"] < "c-2026-10-02" for r in rows)
    assert not any("2026-10-09" in r["window_id"] for r in rows)
    sel = s2.scan(root, units=None, is_held=lambda d, r: False, tapes=str(tmp_path), data=str(tmp_path))[0]
    assert not any("2026-10-09" in r["window_id"] for r in sel)
    # window_lanes has no enumerate-by-date mode: it needs explicit window ids
    with pytest.raises(SystemExit):
        wl.main([])


def test_audio_sha_covers_every_overlapping_chunk_sorted(tmp_path):
    a = [(ms(2026, 10, 9, 9, 2), 300000, "kB"), (ms(2026, 10, 9, 9, 8), 300000, "kA")]       # two chunks in the 09:00 slot, listed out of key order
    res, root = make(tmp_path, a, write=True)
    m = manifest(root, "2026-10-09", "c-2026-10-09_room_aaaa1111_0900")
    sh = lambda k, size: f"{k} {size} {hashlib.sha256(k.encode()).hexdigest()}"
    assert m["audio"]["extras"]["n_chunks"] == 2 and m["audio"]["sha256"] == hashlib.sha256("\n".join(sorted([sh("kB", 100), sh("kA", 101)])).encode()).hexdigest()
    sub = tmp_path / "b"
    sub.mkdir()
    res2, root2 = make(sub, [a[0], (ms(2026, 10, 9, 9, 8), 300000, "kC")], write=True)           # a different second chunk: a different sha
    assert manifest(root2, "2026-10-09", "c-2026-10-09_room_aaaa1111_0900")["audio"]["sha256"] != m["audio"]["sha256"]


def test_a_failing_alarm_check_is_counted_not_silent(tmp_path, monkeypatch):
    res, root = make(tmp_path, [(ms(2026, 10, 10, 10, 2), 300000, "k")], write=True)
    monkeypatch.setattr(enc, "no_encounter_days", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    cnt = enc.run(types.SimpleNamespace(write=True, date=None, since="2026-10-08", dry_run=False), fetch=lambda room, f, t: [], root=root, is_held=lambda d, r: False,
                  outbox=str(tmp_path / "ob.jsonl"), log_dir=None)
    assert cnt["errors"] == 1 and cnt["no_encounter_check_failed"] == 1 and cnt["no_encounter_days"] == 0 and cnt["error_classes"] == {"no_encounter_days": 1}
    assert cnt["written"] == 1                                                                   # the step's own work is unaffected


# ---------------------------------------------------------------- architect #11570: one window per slot, whichever kind comes first
def test_orphan_tape_skips_slots_that_a_room_window_already_covers_and_the_reverse(tmp_path):
    from kit.reb import orphan_tape as ot
    from kit.reb import writer
    from .test_s2_tools import make_tape
    tape = make_tape(tmp_path)                                    # recorded 09:00-09:15 and 09:20-09:25 IST on 9 Oct -> orphan slots 0900 and 0915
    root, data = str(tmp_path / "reb"), str(tmp_path / "data")
    os.makedirs(root)
    os.makedirs(data)
    room = ot.ROOM_ID
    stub = {"window_id": f"c-2026-10-09_{room}_0915", "room_id": room, "room_slug": room, "ist_date": "2026-10-09", "t0_ms": ms(2026, 10, 9, 9, 15), "t1_ms": ms(2026, 10, 9, 9, 30),
            "source_kind": "room_tape", "audio": {"r2_key": f"tape:{room}", "sha256": "s", "sample_rate": 0, "duration_ms": 900000}}
    assert writer.write_manifest(root, "2026-10-09", room, stub["window_id"], stub)               # a room_windows tape window already holds the 09:15 slot

    def ffmpeg(cmd, input=None, capture_output=True):
        open(cmd[-1], "wb").write(b"FLAC")
        return types.SimpleNamespace(returncode=0)
    dry = ot.make_windows(tape, root=root, data=data, is_held=lambda a, b: False)
    assert dry["windows"] == 2 and dry["exists_overlap"] == 1 and dry["would_write"] == 1
    res = ot.make_windows(tape, root=root, data=data, write=True, is_held=lambda a, b: False, runner=ffmpeg)
    assert res["written"] == 1 and res["exists_overlap"] == 1
    assert sorted(os.listdir(os.path.join(root, "2026-10-09", room))) == [f"c-2026-10-09_{room}_0915", f"o-2026-10-09_{room}_0900"]          # one window per slot
    again = ot.make_windows(tape, root=root, data=data, write=True, is_held=lambda a, b: False, runner=ffmpeg)
    assert again["written"] == 0 and again["exists"] == 1 and again["exists_overlap"] == 1
    # the reverse: a tape chunk in the orphan-covered 09:00 slot gets no room window
    c = [(ms(2026, 10, 9, 9, 2), 300000, "k")]
    res2 = rw.make(root, tapes(tmp_path, [(c[0][0], c[0][1], "k")]) if False else _tape_for(tmp_path, room, c), write=True, today=TODAY, is_held=lambda d, r: False, labels={})
    assert res2["created"] == 0 and res2["exists_overlap"] == 1


def _tape_for(tmp, room, chunks):
    p = tmp / "tape2.jsonl"
    rows = [{"id": f"c{i}", "room_id": room, "idx": i, "r2_key": key, "started_at": iso(s), "duration_ms": d, "size_bytes": 1, "sha256": "x", "source": "primary", "path": "p"} for i, (s, d, key) in enumerate(chunks)]
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return str(p)
