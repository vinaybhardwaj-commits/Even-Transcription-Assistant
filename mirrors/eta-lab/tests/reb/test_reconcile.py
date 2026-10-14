import json

from kit.reb import reconcile
from tests.reb.test_r2_ls import KEYS, Stub


def _box(tmp_path, files, index):
    for rel in files:
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{}")
    d = tmp_path / "2026-09-26"
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.jsonl").write_text("\n".join(json.dumps({"path": x}) for x in index) + "\n")


A = "2026-09-26/room_a/w1/tracks/stt.whisper-auto__v1__abc.json"
B = "2026-09-26/room_a/w1/tracks/diar.pyannote__v1__abc.json"
ONLY_BOX = "2026-09-26/room_a/w9/tracks/stt.x__v1__z.json"
GHOST = "2026-09-26/room_a/w8/tracks/stt.y__v1__z.json"


def test_three_difference_classes(tmp_path):
    _box(tmp_path, [A, ONLY_BOX], [A, GHOST])
    r2 = reconcile.r2_track_keys(Stub(KEYS))
    rows = reconcile.compare(r2, reconcile.box_track_keys(str(tmp_path)), reconcile.index_track_keys(str(tmp_path)))
    r = rows["2026-09-26"]
    assert r["examples"]["in_box_not_r2"] == [ONLY_BOX]
    assert B in r["examples"]["in_r2_not_box"]
    assert r["examples"]["in_index_not_on_disk"] == [GHOST]
    assert r["box"] == 2 and r["index"] == 2 and r["r2"] == 3
    assert "2026-09-27" in rows  # present only in R2


def test_examples_capped_and_report(tmp_path):
    many = [f"2026-09-26/room_a/w{i}/tracks/stt.e__v1__z.json" for i in range(30)]
    _box(tmp_path, many, [])
    out = tmp_path / "out"
    class Empty:
        def list_objects_v2(self, **kw): return {"IsTruncated": False}
    assert reconcile.main(client=Empty(), box=str(tmp_path), out_dir=str(out)) == 0
    rep = next(out.glob("reconcile-*.md")).read_text()
    assert "in_box_not_r2 (30; up to 20 shown)" in rep and rep.count("- 2026-09-26/room_a/w") == 20
