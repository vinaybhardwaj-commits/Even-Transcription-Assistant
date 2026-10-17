"""The scan must never open a blind room-day chunk."""
import json
from ras import scan, zeros
from ras.classify import parse_ts, ist_day

ROWS = [
    {"id": "b1", "room_id": "room_x", "started_at": "2026-10-03T04:00:00.000Z", "path": "room_x/2026-10-03/b1.webm"},
    {"id": "b2", "room_id": "room_x", "started_at": "2026-10-03T17:00:00.000Z", "path": "room_x/2026-10-03/b2.webm"},  # 22:30 IST same day
    {"id": "b3", "room_id": "room_x", "started_at": "2026-10-03T18:45:00.000Z", "path": "room_x/2026-10-04/b3.webm"},  # 00:15 IST 4 Oct
    {"id": "o1", "room_id": "room_y", "started_at": "2026-10-03T04:00:00.000Z", "path": "room_y/2026-10-03/o1.webm"},
]
BLIND = {("room_x", "2026-10-03")}


def test_blind_is_decided_by_ist_day_of_start():
    assert [scan.is_blind(r, BLIND) for r in ROWS] == [True, True, False, False]


def test_scan_opens_zero_blind_chunks(monkeypatch):
    opened = []

    def fake_decode(path):
        opened.append(path)
        raise RuntimeError("no audio in test")
    monkeypatch.setattr(zeros, "decode", fake_decode)
    for r in scan.todo(ROWS, set(), BLIND):
        scan.one((r, True, True))
    assert sorted(p.rsplit("/", 1)[1] for p in opened) == ["b3.webm", "o1.webm"]
    assert not any("b1" in p or "b2" in p for p in opened)


def test_purge_removes_blind_features(tmp_path):
    c = tmp_path / "feat.jsonl"
    c.write_text("".join(json.dumps({"id": i}) + "\n" for i in ["b1", "b2", "b3", "o1"]))
    assert scan.purge_blind(str(c), ROWS, BLIND) == 2
    assert [json.loads(l)["id"] for l in open(c)] == ["b3", "o1"]


def test_vi_todo_skips_blind_old_and_done_chunks():
    rows = ROWS + [{"id": "old", "room_id": "room_y", "started_at": "2026-09-25T04:00:00.000Z", "path": "x"}]
    assert [r["id"] for r in scan.todo_vi(rows, set(), BLIND)] == ["b3", "o1"]
    assert [r["id"] for r in scan.todo_vi(rows, {"o1"}, BLIND)] == ["b3"]


def test_scan_main_writes_vi_cache_and_opens_no_blind_chunk(monkeypatch, tmp_path):
    import numpy as np
    opened = []
    monkeypatch.setattr(scan, "TAPES", str(tmp_path))
    (tmp_path / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in ROWS))
    monkeypatch.setattr(scan, "Pool", None)

    class P:                                   # in-process stand-in for multiprocessing.Pool
        def __init__(self, *a): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def imap_unordered(self, fn, it, chunksize=1): return map(fn, it)
    monkeypatch.setattr(scan, "Pool", P)

    def fake_decode(path):
        opened.append(path)
        return np.zeros(48000 * 3, dtype=np.int16)
    monkeypatch.setattr(zeros, "decode", fake_decode)
    out, vi = tmp_path / "c" / "feat.jsonl", tmp_path / "c" / "vi.jsonl"
    scan.main(str(out), BLIND, str(vi))
    assert sorted(p.rsplit("/", 1)[1] for p in opened) == ["b3.webm", "o1.webm"]
    got = {json.loads(l)["id"]: json.loads(l) for l in open(vi)}
    assert set(got) == {"b3", "o1"} and got["o1"]["g"] == [50, 50, 50] and got["o1"]["s"] == [0, 0, 0]
