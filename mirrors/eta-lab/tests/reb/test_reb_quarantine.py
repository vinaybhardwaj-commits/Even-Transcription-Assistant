import os

import pytest

from kit.reb import load_window, write_track
from kit.reb.writer import config_hash

ROOM, DATE, WID = "room_abcd1234", "2026-10-06", "c-2026-10-06_room_abcd1234_1100"
STUB = {"window_id": WID, "room_id": ROOM, "room_slug": ROOM, "ist_date": DATE, "t0_ms": 1, "t1_ms": 900001,
        "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 1}}


def track(engine, status="ok", cfg=None):
    config = cfg or {"e": engine}
    return {"schema": "reb.track.v1", "window_id": WID, "layer": "stt", "engine": engine, "model": "m", "version": "v1",
            "config": config, "config_hash": config_hash(config), "machine": "t", "status": status,
            "reason": None if status == "ok" else "r", "segments": [{"t0_ms": 1, "t1_ms": 2, "text": "synthetic"}] if status == "ok" else []}


@pytest.fixture
def win(tmp_path):
    root = str(tmp_path)
    paths = {e: write_track(root, DATE, ROOM, WID, track(e), manifest_stub=STUB) for e in ("alpha", "beta")}
    return root, paths


def quarantine(path, name="_quarantine-test"):
    d = os.path.join(os.path.dirname(path), name)
    os.makedirs(d)
    os.rename(path, os.path.join(d, os.path.basename(path)))
    return d


def test_normal_window_unchanged(win):
    root, _ = win
    w = load_window(WID, ist_date=DATE, room_id=ROOM, root=root)
    assert sorted(t.engine for t in w.tracks()) == ["alpha", "beta"]
    assert all(t.status == "ok" and t.segments for t in w.tracks(latest_ok=False))


def test_quarantined_entry_excluded_from_latest_ok(win):
    root, paths = win
    qdir = quarantine(paths["alpha"])
    w = load_window(WID, ist_date=DATE, room_id=ROOM, root=root)
    assert [t.engine for t in w.tracks()] == ["beta"]
    assert [t.engine for t in w.tracks(layer="stt", engine="beta")] == ["beta"]
    assert w.tracks(engine="alpha") == []
    assert [s["_track"]["engine"] for s in w.segments_between(0, 10)] == ["beta"]


def test_quarantined_entry_listed_with_latest_ok_false(win):
    root, paths = win
    qdir = quarantine(paths["alpha"])
    w = load_window(WID, ist_date=DATE, room_id=ROOM, root=root)
    got = {t.engine: t for t in w.tracks(latest_ok=False)}
    assert got["beta"].status == "ok" and got["alpha"].status == "quarantined"
    a = got["alpha"]
    assert a.entry["original_status"] == "ok" and a.entry["quarantine_dir"] == qdir
    assert a.body["extras"]["quarantine_dir"] == qdir and a.segments == []   # body not loaded
    assert w.segments_between(0, 10, latest_ok=False)[0]["_track"]["engine"] == "beta"   # quarantined never read as evidence


def test_missing_everywhere_still_raises_with_path(win):
    root, paths = win
    os.unlink(paths["alpha"])
    w = load_window(WID, ist_date=DATE, room_id=ROOM, root=root)
    with pytest.raises(FileNotFoundError) as e:
        w.tracks()
    assert paths["alpha"] in str(e.value)
    with pytest.raises(FileNotFoundError):
        w.tracks(latest_ok=False)


def test_quarantined_alongside_a_live_rerun_of_same_engine(win):
    root, paths = win
    quarantine(paths["alpha"])
    p2 = write_track(root, DATE, ROOM, WID, track("alpha", cfg={"e": "alpha", "v": 2}))
    w = load_window(WID, ist_date=DATE, room_id=ROOM, root=root)
    live = [t for t in w.tracks() if t.engine == "alpha"]
    assert len(live) == 1 and live[0].path == p2 and live[0].status == "ok"
