import hashlib
import json
import os

import pytest

from kit.reb import restore_quarantine as rq
from kit.reb.from_hist import IST, GuardUnavailable

import datetime

DATE, ROOM, WID = "2026-09-26", "room_ux92qpws", "c-2026-09-26_room_ux92qpws_1015"
T0 = int(datetime.datetime(2026, 9, 26, 10, 15, tzinfo=IST).timestamp() * 1000)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def tree(tmp, names=("stt.a__v1__aaaaaaaa.json", "stt.b__v1__bbbbbbbb.json"), qdir="_quarantine-r3w51"):
    root = tmp / "reb"
    wd = root / DATE / ROOM / WID
    (wd / "tracks" / qdir).mkdir(parents=True)
    ents, lines = [], []
    for n in names:
        body = ("body of " + n).encode()
        (wd / "tracks" / qdir / n).write_bytes(body)
        ents.append({"path": f"{DATE}/{ROOM}/{WID}/tracks/{n}", "sha256": sha(body)})
        lines.append(json.dumps({"sha256": sha(body), "status": "ok"}))
    (wd / "manifest.json").write_text(json.dumps({"window_id": WID, "t0_ms": T0, "t1_ms": T0 + 900000, "tracks": ents}))
    (root / DATE / "index.jsonl").write_text("\n".join(lines) + "\n")
    return root, wd


def open_guard(d, r):
    return False


def test_dry_run_moves_nothing_and_counts_would_restore(tmp_path):
    root, wd = tree(tmp_path)
    cnt, path = rq.run(str(root), write=False, is_held=open_guard, out_dir=str(tmp_path / "out"))
    assert cnt["would_restore"] == 2 and cnt["files"] == 2 and cnt["restored"] == 0
    assert sorted(os.listdir(wd / "tracks")) == ["_quarantine-r3w51"] and len(os.listdir(wd / "tracks" / "_quarantine-r3w51")) == 2
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"


def test_write_moves_only_when_every_check_passes_and_edits_no_manifest_or_index(tmp_path):
    root, wd = tree(tmp_path)
    before = ((wd / "manifest.json").read_bytes(), (root / DATE / "index.jsonl").read_bytes())
    cnt, _ = rq.run(str(root), write=True, is_held=open_guard, out_dir=None)
    assert cnt["restored"] == 2 and not os.listdir(wd / "tracks" / "_quarantine-r3w51")        # the empty quarantine dir stays
    live = wd / "tracks" / "stt.a__v1__aaaaaaaa.json"
    assert live.read_bytes() == b"body of stt.a__v1__aaaaaaaa.json"
    assert ((wd / "manifest.json").read_bytes(), (root / DATE / "index.jsonl").read_bytes()) == before
    again, _ = rq.run(str(root), write=True, is_held=open_guard, out_dir=None)
    assert again["files"] == 0                                                                   # idempotent: nothing left to move


def test_a_held_room_day_moves_nothing(tmp_path):
    root, wd = tree(tmp_path)
    cnt, _ = rq.run(str(root), write=True, is_held=lambda d, r: (d, r) == (DATE, ROOM), out_dir=None)
    assert cnt["still_held"] == 2 and cnt["restored"] == 0 and len(os.listdir(wd / "tracks" / "_quarantine-r3w51")) == 2
    only_span = lambda d, r: d == "2026-09-27" and r == ROOM                                     # a guard that holds the NEXT day does not touch a window inside this day
    assert rq.run(str(root), write=False, is_held=only_span, out_dir=None)[0]["would_restore"] == 2


def test_never_overwrites_a_live_file_and_refuses_sha_or_index_mismatch(tmp_path):
    root, wd = tree(tmp_path)
    (wd / "tracks" / "stt.a__v1__aaaaaaaa.json").write_bytes(b"live")
    (wd / "tracks" / "_quarantine-r3w51" / "stt.b__v1__bbbbbbbb.json").write_bytes(b"tampered")
    cnt, _ = rq.run(str(root), write=True, is_held=open_guard, out_dir=None)
    assert cnt["live_exists"] == 1 and cnt["manifest_sha_mismatch"] == 1 and cnt["restored"] == 0
    assert (wd / "tracks" / "stt.a__v1__aaaaaaaa.json").read_bytes() == b"live"
    root2, wd2 = tree(tmp_path / "two")
    (root2 / DATE / "index.jsonl").write_text("")
    assert rq.run(str(root2), write=True, is_held=open_guard, out_dir=None)[0]["not_in_index"] == 2
    root3, wd3 = tree(tmp_path / "three")
    m = json.loads((wd3 / "manifest.json").read_text())
    m["tracks"] = m["tracks"][:1]
    (wd3 / "manifest.json").write_text(json.dumps(m))
    c3 = rq.run(str(root3), write=False, is_held=open_guard, out_dir=None)[0]
    assert c3["would_restore"] == 1 and c3["no_manifest_entry"] == 1


def test_only_the_two_held_out_quarantine_dirs_are_in_scope(tmp_path):
    root, wd = tree(tmp_path, qdir="_quarantine-encounter-v0")
    cnt, _ = rq.run(str(root), write=True, is_held=open_guard, out_dir=None)
    assert cnt["files"] == 0 and len(os.listdir(wd / "tracks" / "_quarantine-encounter-v0")) == 2
    root2, _ = tree(tmp_path / "b", qdir="_quarantine-blind-preexisting")
    assert rq.run(str(root2), write=False, is_held=open_guard, out_dir=None)[0]["would_restore"] == 2


def test_unusable_window_times_fail_closed_and_a_missing_guard_is_fatal(tmp_path, monkeypatch):
    root, wd = tree(tmp_path)
    m = json.loads((wd / "manifest.json").read_text())
    m["t0_ms"] = None
    (wd / "manifest.json").write_text(json.dumps(m))
    assert rq.run(str(root), write=True, is_held=open_guard, out_dir=None)[0]["still_held"] == 2     # window_held treats unusable times as held
    def broken():
        raise GuardUnavailable("heldout guard unavailable (test)")
    monkeypatch.setattr(rq, "load_heldout", broken)
    with pytest.raises(SystemExit):
        rq.run(str(root), write=False, out_dir=None)


def test_sealed_clip_windows_are_never_restored_even_with_an_open_guard(tmp_path):
    root, wd = tree(tmp_path)
    sealed = root / DATE / ROOM / "L041"
    os.rename(wd, sealed)                                                                         # same files, but the window dir is a sealed clip id
    cnt, path = rq.run(str(root), write=True, is_held=open_guard, out_dir=str(tmp_path / "out"))
    assert cnt["sealed"] == 2 and cnt["restored"] == 0 and cnt["would_restore"] == 0
    assert len(os.listdir(sealed / "tracks" / "_quarantine-r3w51")) == 2 and not os.path.exists(sealed / "tracks" / "stt.a__v1__aaaaaaaa.json")
    from kit.reb import from_hist
    assert rq.SEALED_WINDOWS is from_hist.SEALED_WINDOWS and rq.SEALED_WINDOWS == {"L041", "L057", "L139", "L182"}      # one definition
