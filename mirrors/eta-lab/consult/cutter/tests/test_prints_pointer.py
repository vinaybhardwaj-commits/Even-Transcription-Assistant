import importlib, json, os, tempfile, shutil
from unittest import mock
import numpy as np, pytest
from cutter import config as C, speak as SP, run as R

def vec(i, n=192): v = [0.0] * n; v[i] = 1.0; return v
def prints_doc(*uids): return dict(prints=[dict(doctor_uid=u, centroid_192_l2=vec(k)) for k, u in enumerate(uids)])

@pytest.fixture
def box():
    home = tempfile.mkdtemp(); d = f"{home}/eta-data/consult"; os.makedirs(d)
    json.dump(prints_doc("D1"), open(f"{d}/prints-provisional-06oct.json", "w"))
    with mock.patch.dict(os.environ, {"HOME": home}):
        importlib.reload(C); yield d, home
    shutil.rmtree(home, True); importlib.reload(C)

def test_prints_follow_the_live_pointer_when_it_exists_else_the_provisional_file(box):
    d, _ = box; assert C.PRINTS.endswith("prints-provisional-06oct.json")                                          # no pointer at all: as before
    v2 = prints_doc("D1", "N1"); json.dump(v2, open(f"{d}/prints-live-v002.json", "w")); os.symlink("prints-live-v002.json", f"{d}/prints-live.json")
    importlib.reload(C); assert C.PRINTS.endswith("prints-live.json"); assert sorted(SP.load_prints(C.PRINTS, strict=True)) == ["D1", "N1"]

def test_strict_loader_fails_loud_for_every_bad_case_and_never_falls_back(box):
    d, _ = box; live = f"{d}/prints-live.json"
    os.symlink("prints-live-v009.json", live); importlib.reload(C); assert C.PRINTS == C.LIVE_PRINTS                    # a dangling pointer is USED (lexists), not skipped
    with pytest.raises(SP.PrintsError, match="dangling"): SP.load_prints(strict=True)
    os.remove(live); json.dump(prints_doc("D1", "N1"), open(f"{d}/prints-live-v002.json", "w")); os.symlink("prints-live-v002.json", live); os.remove(f"{d}/prints-live-v002.json")
    with pytest.raises(SP.PrintsError, match="dangling"): SP.load_prints(strict=True)                                      # target removed after the pointer was set
    def bad(doc, match):
        os.remove(live); json.dump(doc, open(f"{d}/prints-live-v003.json", "w")); os.symlink("prints-live-v003.json", live)
        with pytest.raises(SP.PrintsError, match=match): SP.load_prints(strict=True)
    bad(dict(prints=[]), "no prints")
    bad(dict(prints=[dict(doctor_uid="D1", centroid_192_l2=[0.0] * 192)]), "zero vector")
    bad(dict(prints=[dict(doctor_uid="D1", centroid_192_l2=[float("nan")] + [0.0] * 191)]), "finite")
    bad(dict(prints=[dict(doctor_uid="D1", centroid_192_l2=[1.0] * 10)]), "192-d")
    bad(dict(prints=[dict(doctor_uid="N1", centroid_192_l2=vec(1))]), "lack 1 provisional")                                 # D1 (provisional) missing from the live file
    open(f"{d}/prints-live-v003.json", "w").write("{not json"); 
    with pytest.raises(SP.PrintsError, match="unreadable"): SP.load_prints(strict=True)
    os.remove(live); os.remove(f"{d}/prints-live-v003.json"); os.remove(f"{d}/prints-provisional-06oct.json"); importlib.reload(C)
    with pytest.raises(SP.PrintsError, match="does not exist"): SP.load_prints(strict=True)

def test_a_bad_pointer_aborts_the_run_before_cutting_with_an_alert_line(box, capsys, caplog):
    d, _ = box; os.symlink("prints-live-v009.json", f"{d}/prints-live.json"); importlib.reload(C)
    with mock.patch.object(R.Wn, "fetch", side_effect=AssertionError("must not fetch windows")), mock.patch.object(R, "acquire_run_lock", side_effect=AssertionError("must not lock")):
        rc = R.main(["--once"])
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1]); assert rc == 3 and out["aborted"] == "prints_invalid" and out["alert"].startswith("ALERT cutter prints invalid, run aborted before cutting")
    assert "ALERT cutter prints invalid" in caplog.text


def test_N4_duplicate_doctor_uid_rows_are_a_prints_error(box):
    d, _ = box; doc = prints_doc("D1", "N1"); doc["prints"].append(dict(doctor_uid="N1", centroid_192_l2=vec(5)))
    json.dump(doc, open(f"{d}/prints-live-v002.json", "w")); os.symlink("prints-live-v002.json", f"{d}/prints-live.json"); importlib.reload(C)
    with pytest.raises(SP.PrintsError, match="twice"): SP.load_prints(strict=True)

def test_N3_the_run_uses_the_prints_it_pre_checked_and_never_reads_them_again(box):
    d, _ = box; seen = {}; calls = []
    real = SP.load_prints
    def counting(path=None, strict=False): calls.append(strict); return real(path, strict=strict)
    def ctx(now, **kw): seen["prints"] = kw.get("prints"); return dict(now=now)
    with mock.patch.object(SP, "load_prints", counting), mock.patch.object(R.Wn, "fetch", lambda since: []), mock.patch.object(R, "make_ctx", ctx), mock.patch.object(R, "run_once", lambda *a, **k: (dict(eligible=0), [])), \
         mock.patch.object(R, "acquire_run_lock", lambda: object()):
        R.main(["--once", "--dry-run"])
    assert calls == [True] and sorted(seen["prints"]) == ["D1"]                                                           # one strict read, handed to make_ctx

def test_N5_the_abort_writes_an_alert_line_to_the_spool_and_the_tools_work(box, capsys):
    d, home = box; os.symlink("prints-live-v009.json", f"{d}/prints-live.json"); importlib.reload(C)
    assert R.main(["--once"]) == 3
    lines = [json.loads(l) for l in open(C.ALERTS)]; assert len(lines) == 1 and lines[0]["alert"].startswith("ALERT cutter prints invalid, run aborted before cutting") and lines[0]["source"] == "cutter.run" and oct(os.stat(C.ALERTS).st_mode & 0o777) == "0o600"
    import subprocess, sys
    tools = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
    subprocess.run([sys.executable, f"{tools}/alert_append.py", "ALERT cutter-hourly.service failed"], check=True, env=dict(os.environ, HOME=home))
    assert [json.loads(l)["source"] for l in open(C.ALERTS)] == ["cutter.run", "systemd"]
    p = subprocess.Popen([sys.executable, f"{tools}/alert_watch.py", "--all"], stdout=subprocess.PIPE, text=True, env=dict(os.environ, HOME=home))
    try: out = [p.stdout.readline(), p.stdout.readline()]
    finally: p.kill()
    assert "cutter.run: ALERT cutter prints invalid" in out[0] and "systemd: ALERT cutter-hourly.service failed" in out[1]


def test_L3_uids_equal_after_strip_casefold_and_zero_width_removal_are_duplicates(box):
    d, _ = box
    for twin in ("D1 ", "d1", "​D1", "D​1", " d1﻿"):
        doc = prints_doc("D1"); doc["prints"].append(dict(doctor_uid=twin, centroid_192_l2=vec(7)))
        p = f"{d}/prints-live-v00{len(twin)}.json"; json.dump(doc, open(p, "w"))
        with pytest.raises(SP.PrintsError, match="twice"): SP.load_prints(p, strict=True)

def test_L4_alert_append_creates_the_spool_dir_and_uses_stdlib_only():
    import subprocess, sys
    home = tempfile.mkdtemp(); tools = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
    try:
        r = subprocess.run(["/usr/bin/python3", "-I", f"{tools}/alert_append.py", "ALERT x failed"], env=dict(os.environ, HOME=home), capture_output=True, text=True); assert r.returncode == 0, r.stderr
        line = json.loads(open(f"{home}/eta-data/consult/ALERTS.jsonl").read()); assert line["alert"] == "ALERT x failed" and oct(os.stat(f"{home}/eta-data/consult").st_mode & 0o777) == "0o700"
    finally: shutil.rmtree(home, True)
