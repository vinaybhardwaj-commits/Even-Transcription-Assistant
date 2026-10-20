import json, os, sys, socket, builtins
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import spine_recon as R
D = "2026-10-19"
def enc(n, status="confirmed", proxies=("pulse",), anchor="pulse", reason="pulse", **kw):
    return dict(encounter_id=f"enc_test{n}", status=status, proxies=list(proxies), anchor_proxy=anchor, reason=reason, **kw)
def link(n, uid, active=True):
    return dict(encounter_id=f"enc_test{n}", key_kind="consult_uid", value=uid, active=active)

def test_A_wrong_ledger_key_must_not_pass_vacuously(tmp_path):
    # ledger uses "uid" instead of "consult_uid": every line is bad, 0 uids
    led = tmp_path / "l.jsonl"; led.write_text(json.dumps(dict(uid="uid_test_01", ist_date=D, stage="sarvam", state="done")) + "\n")
    sp = tmp_path / "s.json"; sp.write_text(json.dumps(dict(encounters=[enc("a")], links=[link("a", "uid_test_01")])))
    out = tmp_path / "o.json"
    assert R.main(["--date", D, "--spine", str(sp), "--out", str(out), "--ledger", str(led), "--eta-data", str(tmp_path)]) == 1
    r = json.loads(out.read_text())
    assert r["ledger_uids"] == 0 and r["ledger_bad_lines"] == 1
    assert r["gate"] != "pass", "0 ledger uids + bad lines => gate PASS (vacuous)"

def test_B_wrong_date_field_utc_vs_ist():
    # a ledger date given as a UTC ts late evening is bucketed to IST next day: just document
    assert R.line_date({"ts": "2026-10-19T19:00:00Z"}) == "2026-10-20"

def test_C_digit_run_passes_code_filter():
    assert R.code("9" * 10) == "other", "a 10-digit run passes the closed-vocabulary filter"

def test_D_0600_even_if_tmp_preexists(tmp_path):
    out = tmp_path / "o.json"; tmp = tmp_path / "o.json.tmp"; tmp.write_text("x"); os.chmod(tmp, 0o644)
    R.write_atomic(str(out), "{}")
    assert oct(os.stat(out).st_mode & 0o777) == "0o600"

def test_E_no_network_without_upload(tmp_path, monkeypatch):
    def boom(*a, **k): raise AssertionError("network")
    monkeypatch.setattr(socket, "socket", boom); monkeypatch.setattr(socket, "create_connection", boom)
    real_import = builtins.__import__
    monkeypatch.setattr(builtins, "__import__", lambda n, *a, **k: (_ for _ in ()).throw(AssertionError("boto3")) if n.startswith("boto") else real_import(n, *a, **k))
    led = tmp_path / "l.jsonl"; led.write_text(json.dumps(dict(consult_uid="uid_test_01", ist_date=D, stage="sarvam", state="done")) + "\n")
    sp = tmp_path / "s.json"; sp.write_text(json.dumps(dict(encounters=[enc("a")], links=[link("a", "uid_test_01")])))
    assert R.main(["--date", D, "--spine", str(sp), "--out", str(tmp_path / "o.json"), "--ledger", str(led), "--eta-data", str(tmp_path)]) == 0

def test_F_daily_recon_bad_shape_exits_2(tmp_path):
    led = tmp_path / "l.jsonl"; led.write_text("")
    sp = tmp_path / "s.json"; sp.write_text(json.dumps(dict(encounters=[], links=[])))
    dr = tmp_path / "d.json"; dr.write_text(json.dumps(dict(rooms=["x"])))
    assert R.main(["--date", D, "--spine", str(sp), "--out", str(tmp_path / "o.json"), "--ledger", str(led), "--daily-recon", str(dr)]) == 2

def test_G_two_uids_one_encounter_gate():
    # two ledger consults merged into one encounter (R1 risk): gate passes today
    sp = dict(encounters=[enc("a")], links=[link("a", "uid_test_01"), link("a", "uid_test_02")])
    r = R.reconcile(D, {"uid_test_01": {}, "uid_test_02": {}}, sp)
    assert r["merged_uids_encounters"] == 1
    assert r["gate"] == "fail", "two consults collapsed into one encounter pass the 1:1 gate"

def test_H_uid_mapped_to_rejected_and_confirmed_is_split():
    sp = dict(encounters=[enc("a"), enc("b", status="rejected", reason="no_tape")], links=[link("a", "uid_test_01"), link("b", "uid_test_01")])
    r = R.reconcile(D, {"uid_test_01": {}}, sp)
    assert r["diffs"] == {"split": 1}

def test_I_extras_listed_with_strong_proxy_but_no_ledger():
    sp = dict(encounters=[enc("a"), enc("b")], links=[link("a", "uid_test_01")])
    r = R.reconcile(D, {"uid_test_01": {}}, sp)
    assert r["extras"] == [{"proxy": "pulse", "reason": "pulse", "status": "confirmed", "count": 1}] and r["gate"] == "pass"

def test_J_links_non_dict_is_broken_input_not_traceback(tmp_path):
    led = tmp_path / "l.jsonl"; led.write_text(json.dumps(dict(consult_uid="uid_test_01", ist_date=D)) + "\n")
    sp = tmp_path / "s.json"; sp.write_text(json.dumps(dict(encounters=[], links=["x"])))
    assert R.main(["--date", D, "--spine", str(sp), "--out", str(tmp_path / "o.json"), "--ledger", str(led)]) == 2
