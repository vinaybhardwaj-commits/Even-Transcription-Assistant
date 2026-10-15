import os, sys, types, json
sys.path.insert(0, os.path.dirname(__file__))
import follower


def mk(tmp):
    a = types.SimpleNamespace(out=str(tmp / "rec"), events=str(tmp / "ev.jsonl"), arecord=["true"], piece_s=300)
    os.makedirs(a.out); return follower.Rec(a), a

def events(a): return [json.loads(l)["event"] for l in open(a.events)] if os.path.exists(a.events) else []


def test_stop_removes_empty_work_dir_only(tmp_path):
    r, a = mk(tmp_path)
    r.wd = os.path.join(r.work, "111"); os.makedirs(r.wd)
    r.p = types.SimpleNamespace(poll=lambda: 0)            # arecord already ended, nothing left to finalize
    r.stop("t"); assert not os.path.exists(r.wd) and "work_dir_removed" in events(a)
    r.wd = os.path.join(r.work, "222"); os.makedirs(r.wd); keep = os.path.join(r.wd, "stray.txt"); open(keep, "w").write("x")
    r.p = types.SimpleNamespace(poll=lambda: 0)
    r.stop("t"); assert os.path.isfile(keep)                # non-empty: kept, file untouched


def test_recover_removes_empty_keeps_nonempty(tmp_path):
    r, a = mk(tmp_path)
    os.makedirs(os.path.join(r.work, "333")); os.makedirs(os.path.join(r.work, "444"))
    open(os.path.join(r.work, "444", "stray.txt"), "w").write("x")
    r.recover()
    assert not os.path.exists(os.path.join(r.work, "333")) and os.path.isfile(os.path.join(r.work, "444", "stray.txt"))
    assert events(a).count("work_dir_removed") == 1


def test_finalized_piece_then_dir_removed(tmp_path):
    r, a = mk(tmp_path)
    wd = os.path.join(r.work, "1792000000000000000"); os.makedirs(wd)
    with open(os.path.join(wd, "rec.wav"), "wb") as f: f.write(b"\0" * 44 + b"\1\0" * 4800)
    r.recover()
    assert not os.path.exists(wd) and "piece" in events(a) and "work_dir_removed" in events(a)


def _arecord_exited(r, wd):
    r.wd = wd; r.epoch = int(os.path.basename(wd)); r.done = set()
    r.p = types.SimpleNamespace(poll=lambda: 1, returncode=1, stderr=types.SimpleNamespace(read=lambda: ""))


def test_arecord_exit_removes_empty_work_dir(tmp_path):
    r, a = mk(tmp_path)
    wd = os.path.join(r.work, "1792000000000000000"); os.makedirs(wd)
    with open(os.path.join(wd, "rec.wav"), "wb") as f: f.write(b"\0" * 44 + b"\1\0" * 4800)
    _arecord_exited(r, wd)
    assert r.check() is False
    assert not os.path.exists(wd) and os.listdir(r.work) == [] and events(a).count("work_dir_removed") == 1


def test_arecord_exit_keeps_dir_holding_a_file(tmp_path):
    r, a = mk(tmp_path)
    wd = os.path.join(r.work, "1792000000000000001"); os.makedirs(wd); keep = os.path.join(wd, "stray.txt"); open(keep, "w").write("x")
    _arecord_exited(r, wd)
    r.check()
    assert os.path.isfile(keep) and "work_dir_removed" not in events(a)
