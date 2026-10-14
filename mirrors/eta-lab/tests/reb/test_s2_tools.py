import datetime
import hashlib
import json
import os
import struct

import pytest

from kit.reb import orphan_tape as ot
from kit.reb import sarvam_lane as sl
from kit.reb import tape_gap_fetch as tg
from kit.reb import writer, write_track
from kit.reb.writer import config_hash
from kit.reb.validate import ValidationError

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
BASE = int(datetime.datetime(2026, 10, 9, 9, 0, 0, tzinfo=IST).timestamp())      # a quarter-hour aligned IST start
ROOM = "room_ux92qpws"


# ---------------------------------------------------------------- the orphan tape
def make_tape(tmp_path, blocks=((0, 900), (1200, 1500))):
    """A tape.pcm + tape.idx with recorded stretches [start_s, end_s) after BASE; the samples of stretch k are the constant k+1 so a cut is checkable. -> tape dir."""
    d = tmp_path / "tape"
    d.mkdir()
    rows, off, samples = [{"byte_offset": 0, "samples": 0, "wall_ns": int(BASE * 1e9), "input_sample_rate": 48000, "device": "dev", "rms": 0}], 0, 0
    pcm = bytearray()
    first = True
    for k, (a, b) in enumerate(blocks):
        if not first:
            rows.append({"byte_offset": off, "samples": samples, "wall_ns": int((BASE + a) * 1e9), "discontinuity": "resumed", "device": "dev"})
        first = False
        for t in range(a, b, 10):
            n = 10 * ot.SR
            pcm += struct.pack("<h", 1000 * (k + 1)) * n
            off += n * 2
            samples += n
            rows.append({"byte_offset": off, "samples": samples, "wall_ns": int((BASE + t + 10) * 1e9), "input_sample_rate": 48000, "device": "dev", "rms": 0.03, "peak": 0.1})
        if k < len(blocks) - 1:
            rows.append({"byte_offset": off, "samples": samples, "wall_ns": int((BASE + b) * 1e9), "discontinuity": "device_lost", "device": "dev"})
    (d / "tape.pcm").write_bytes(bytes(pcm))
    (d / "tape.idx").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return str(d)


def test_pieces_and_gaps(tmp_path):
    d = make_tape(tmp_path)
    pieces, gaps = ot.pieces_of(ot.load_index(d))
    assert pieces[0][:2] == (BASE, BASE + 10) and pieces[-1][1] == BASE + 1500
    assert [(g[1], g[2]) for g in gaps] == [(300.0, True)]                                  # the 300 s device loss, marked
    assert sum(p[3] - p[2] for p in pieces) / (ot.SR * 2) == 1200


def test_window_cut_keeps_the_tape_clock_and_lays_silence_in_the_gap(tmp_path):
    d = make_tape(tmp_path)
    pieces, _ = ot.pieces_of(ot.load_index(d))
    starts = [p[0] for p in pieces]
    buf, rec = ot.window_pcm(os.path.join(d, "tape.pcm"), pieces, starts, BASE + 600, BASE + 1500)       # 600..1500: stretch 1 until 900, silence 900..1200, stretch 2 1200..1500
    s = lambda sec: struct.unpack_from("<h", buf, int(sec * ot.SR) * 2)[0]
    assert (s(0), s(299), s(300), s(599), s(600), s(899)) == (1000, 1000, 0, 0, 2000, 2000)
    assert rec == 600 * ot.SR                                                                 # recorded 300 s + 300 s of the 900 s window


def test_make_windows_dry_run_then_write(tmp_path):
    d = make_tape(tmp_path)
    root, data = str(tmp_path / "reb"), str(tmp_path / "data")
    os.makedirs(root); os.makedirs(data)
    dry = ot.make_windows(d, root=root, data=data, is_held=lambda a, b: False)
    assert dry["windows"] == 2 and dry["would_write"] == 2 and dry["written"] == 0 and dry["partial"] == 1 and dry["full"] == 1 and os.listdir(root) == []

    def ffmpeg(cmd, input=None, capture_output=True):
        open(cmd[-1], "wb").write(b"FLAC" + hashlib.sha256(input).digest())              # a stand-in encoder: deterministic bytes per window
        return type("R", (), {"returncode": 0})()
    w = ot.make_windows(d, root=root, data=data, write=True, is_held=lambda a, b: False, runner=ffmpeg)
    assert w["written"] == 2 and w["exists"] == 0
    wid = "o-2026-10-09_room_ux92qpws_0900"
    m = json.load(open(os.path.join(root, "2026-10-09", ROOM, wid, "manifest.json")))
    assert m["source_kind"] == "room_tape_orphan" and m["clock"] == "tape_utc" and m["tracks"] == [] and m["t1_ms"] - m["t0_ms"] == 900000
    a = m["audio"]
    assert a["r2_key"].startswith("local:orphan-windows/opd4/2026-10-09/") and a["sample_rate"] == 16000 and a["extras"]["covered_fraction"] == 1.0
    assert "room_tape" not in a["extras"]["room_assertion"] and "does not state the room" in a["extras"]["room_assertion"] and "opd4" in a["extras"]["room_assertion"]
    assert a["sha256"] == hashlib.sha256(open(os.path.join(data, a["r2_key"][6:]), "rb").read()).hexdigest()
    m2 = json.load(open(os.path.join(root, "2026-10-09", ROOM, "o-2026-10-09_room_ux92qpws_0915", "manifest.json")))
    assert m2["audio"]["extras"]["covered_fraction"] == pytest.approx(0.3333, abs=1e-4) and m2["audio"]["extras"]["gap_s"] == 600.0
    # the planner sees the window's audio and its coverage; a second run changes nothing
    plan = sl.window_plan(m2, {}, data=data)
    assert plan["source"] == "local_window" and plan["covered_ms"] == pytest.approx(300000, rel=1e-3)
    assert ot.make_windows(d, root=root, data=data, write=True, is_held=lambda a, b: False, runner=ffmpeg)["exists"] == 2


def test_orphan_guards_blind_and_sealed(tmp_path):
    d = make_tape(tmp_path)
    cnt = ot.make_windows(d, root=str(tmp_path / "reb"), data=str(tmp_path), is_held=lambda a, b: True)
    assert cnt["blind_refused"] == 2 and cnt["would_write"] == 0


# ---------------------------------------------------------------- the writer's manifest-only create
def test_write_manifest_is_create_only_and_validated(tmp_path):
    stub = {"window_id": "o-x", "room_id": ROOM, "room_slug": "OPD 4", "ist_date": "2026-10-09", "t0_ms": 1, "t1_ms": 2, "source_kind": "room_tape_orphan",
            "audio": {"r2_key": "local:x", "sha256": "s", "sample_rate": 1, "duration_ms": 1}}
    assert writer.write_manifest(str(tmp_path), "2026-10-09", ROOM, "o-x", stub) is True
    assert writer.write_manifest(str(tmp_path), "2026-10-09", ROOM, "o-x", {**stub, "t0_ms": 9}) is False
    assert json.load(open(tmp_path / "2026-10-09" / ROOM / "o-x" / "manifest.json"))["t0_ms"] == 1
    assert not os.path.exists(tmp_path / "2026-10-09" / "index.jsonl")
    with pytest.raises(ValidationError):
        writer.write_manifest(str(tmp_path), "2026-10-09", ROOM, "o-y", {**stub, "window_id": "o-y", "source_kind": "bogus"})
    with pytest.raises(ValueError):
        writer.write_manifest(str(tmp_path), "2026-10-09", "../x", "o-y", stub)


# ---------------------------------------------------------------- the planner's tape fallback
def test_window_plan_falls_back_to_tape_chunks_only_when_asked(tmp_path):
    data, tapes = tmp_path / "data", tmp_path / "tapes"
    (tapes / ROOM).mkdir(parents=True)
    data.mkdir()
    chunk = tapes / ROOM / "c1.webm"
    chunk.write_bytes(b"chunk")
    t0 = int(datetime.datetime(2026, 9, 30, 4, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000)
    by_room = {ROOM: [{"id": "c1", "idx": 0, "started_at": "2026-09-30T04:00:00.000Z", "duration_ms": 900000, "path": f"{ROOM}/c1.webm", "sha256": hashlib.sha256(b"chunk").hexdigest()}]}
    m = {"window_id": "w", "room_id": ROOM, "t0_ms": t0, "t1_ms": t0 + 900000, "audio": {"r2_key": "local:gone.webm", "sha256": "x", "sample_rate": 1, "duration_ms": 900000}}
    with pytest.raises(sl.AudioProblem) as e:
        sl.window_plan(m, by_room, str(tapes), str(data))
    assert e.value.kind == "audio_missing"                                                    # the default is unchanged
    plan = sl.window_plan(m, by_room, str(tapes), str(data), fallback_tape=True)
    assert plan["source"] == "tape_chunks" and plan["covered_ms"] == 900000
    (data / "gone.webm").write_bytes(b"other")                                                # present but differs: the same fallback, and the original kind when the tape fails too
    assert sl.window_plan(m, by_room, str(tapes), str(data), fallback_tape=True)["source"] == "tape_chunks"
    with pytest.raises(sl.AudioProblem) as e:
        sl.window_plan(m, {}, str(tapes), str(data), fallback_tape=True)
    assert e.value.kind == "sha_mismatch"


# ---------------------------------------------------------------- the tape-gap plan and fetch
def W(wid, room, t0, t1, kind="audio_missing"):
    return {"window_id": wid, "room_id": room, "kind": kind, "t0_ms": t0 * 3600000, "t1_ms": t1 * 3600000, "ist_date": "2026-09-10"}


def test_gap_classification_ranges_and_new_time(tmp_path):
    tapes = tmp_path
    (tapes / "f").write_bytes(b"x")
    by_room = {"r1": [{"started_at": "1970-01-01T05:00:00Z", "duration_ms": 3600000, "path": "f", "id": "c"}]}          # hours 5-6 on the box
    probs = [W("a", "r1", 5, 6), W("b", "r1", 10, 11), W("c", "r1", 11, 12), W("d", "r2", 10, 11), W("e", "r1", 20, 21)]
    cls = tg.classify(probs, by_room, str(tapes))
    assert cls == {"a": "rebuild_on_box", "b": "fetch", "c": "fetch", "d": "fetch", "e": "fetch"}
    assert tg.merge_ranges([w for w in probs if cls[w["window_id"]] == "fetch"]) == {"r1": [(36000000, 43200000), (72000000, 75600000)], "r2": [(36000000, 39600000)]}
    ok = {"r1": [(20 * 3600000, 21 * 3600000)]}                                                                           # window e lies inside audio the box has
    assert tg.uncovered_ms(probs[4], ok) == 0 and tg.uncovered_ms(probs[1], ok) == 3600000
    calls = []

    def query(room, t0, t1):
        calls.append((room, t0, t1))
        return [{"id": "x", "started_at": "1970-01-01T10:00:00Z", "duration_ms": 3600000, "size_bytes": 1000, "upload_state": "verified"},
                {"id": "y", "started_at": "1970-01-01T11:30:00Z", "duration_ms": 600000, "size_bytes": 500, "upload_state": "pending"}]
    res = tg.plan(probs, by_room, str(tapes), query=query, ok=ok)
    assert res["rebuild_on_box"]["windows"] == 1 and res["fetch"]["windows"] == 3 and res["fetch_all_problem_windows"]["windows"] == 4
    assert len(calls) == 2 and res["fetch"]["verified_chunks"] == 2 and res["fetch"]["bytes"] == 2000                          # only the verified rows count
    assert res["fetch"]["windows_with_a_verified_chunk"] == 2 and res["fetch"]["windows_without_any_db_chunk"] == 1


def test_fetch_is_disabled_and_the_quiet_hours_helper_still_works():
    plan = {"fetch": {"bytes": 10, "gb": 0.0}, "ranges": [{"room": "r1", "from": "a", "to": "b", "verified": 2}]}
    called = []
    for kw in ({}, {"now": datetime.datetime(2026, 10, 10, 22, 0, tzinfo=IST)}, {"runner": lambda *a, **k: called.append(1)}):
        with pytest.raises(SystemExit) as e:
            tg.fetch(plan, **kw)
        assert "disabled" in str(e.value)
    assert called == []                                                                          # no puller, no R2 key, whatever the hour
    with pytest.raises(SystemExit):
        tg.main(["--fetch"])
    assert tg.in_quiet_hours(datetime.datetime(2026, 10, 10, 22, 0, tzinfo=IST)) and not tg.in_quiet_hours(datetime.datetime(2026, 10, 10, 12, 0, tzinfo=IST))


# ---------------------------------------------------------------- a manifest-only window is found by id (no index.jsonl line yet)
def test_load_window_finds_a_window_that_has_a_manifest_but_no_track(tmp_path):
    from kit.reb import reb
    stub = {"window_id": "o-2026-10-09_room_ux92qpws_0900", "room_id": ROOM, "room_slug": "OPD 4 Ortho", "ist_date": "2026-10-09", "t0_ms": 1, "t1_ms": 2, "source_kind": "room_tape_orphan",
            "audio": {"r2_key": "local:x", "sha256": "s", "sample_rate": 1, "duration_ms": 1}}
    assert writer.write_manifest(str(tmp_path), "2026-10-09", ROOM, stub["window_id"], stub)
    assert not os.path.exists(tmp_path / "2026-10-09" / "index.jsonl")
    w = reb.load_window(stub["window_id"], root=str(tmp_path))
    assert w.window_id == stub["window_id"] and w.source_kind == "room_tape_orphan"
    other = {**stub, "window_id": "c-2026-10-07_room_ymch4bxu_1300", "room_id": "room_ymch4bxu", "source_kind": "room_tape", "ist_date": "2026-10-07"}
    assert writer.write_manifest(str(tmp_path), "2026-10-07", "room_ymch4bxu", other["window_id"], other)
    for bad in ("nope", "../x", "a/b", "", "*", "?", "o-2026-10-09_room_ux92qpws_09?0", "[o]-2026-10-09_room_ux92qpws_0900", "o-*", "{a,b}", ".hidden", "a b"):
        with pytest.raises(reb.WindowNotFoundError):                                                 # a glob character or a path part must never load some other window
            reb.load_window(bad, root=str(tmp_path))
    assert reb.load_window("c-2026-10-07_room_ymch4bxu_1300", root=str(tmp_path)).window_id == "c-2026-10-07_room_ymch4bxu_1300"
    assert reb._PLAIN_WINDOW_ID.match("l3-c003-r1") and reb._PLAIN_WINDOW_ID.match("L041") and reb._PLAIN_WINDOW_ID.match("2026-09-10_room_2qe955hy_2315")
