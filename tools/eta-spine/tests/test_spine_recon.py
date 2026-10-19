import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import spine_recon as R

D = "2026-10-19"
def enc(i, status="confirmed", proxies=("pulse",), anchor="pulse", reason=None, **kw):
    return dict(encounter_id=f"enc_test{i:0>12}", status=status, proxies=list(proxies), anchor_proxy=anchor, reason=reason, **kw)
def link(i, uid, active=True):
    return dict(encounter_id=f"enc_test{i:0>12}", key_kind="consult_uid", value=uid, active=active)
def ledger(*uids, state="done"):
    return {u: {"freescript": state, "sarvam": state} for u in uids}

def test_one_to_one_passes():
    sp = dict(encounters=[enc(1), enc(2)], links=[link(1, "uid_test_01"), link(2, "uid_test_02")])
    r = R.reconcile(D, ledger("uid_test_01", "uid_test_02"), sp)
    assert r["mapped_to_one_confirmed"] == 2 and r["diffs"] == {} and r["extras_total"] == 0 and r["gate"] == "pass"

def test_missing_uid():
    sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01")])
    r = R.reconcile(D, ledger("uid_test_01", "uid_test_02"), sp)
    assert r["diffs"] == {"missing_uid": 1} and r["mapped_to_one_confirmed"] == 1 and r["gate"] == "fail"

def test_split_one_uid_two_encounters():
    sp = dict(encounters=[enc(1), enc(2)], links=[link(1, "uid_test_01"), link(2, "uid_test_01")])
    r = R.reconcile(D, ledger("uid_test_01"), sp)
    assert r["diffs"] == {"split": 1} and r["mapped_to_one_confirmed"] == 0

def test_merged_encounter_resolves_to_survivor():
    sp = dict(encounters=[enc(1), enc(2, status="merged", merged_into="enc_test000000000001")], links=[link(1, "uid_test_01"), link(2, "uid_test_02")])
    r = R.reconcile(D, ledger("uid_test_01", "uid_test_02"), sp)
    assert r["diffs"] == {} and r["mapped_to_one_confirmed"] == 2 and r["merged_uids_encounters"] == 1

def test_candidate_is_not_confirmed():
    sp = dict(encounters=[enc(1, status="candidate")], links=[link(1, "uid_test_01")])
    assert R.reconcile(D, ledger("uid_test_01"), sp)["diffs"] == {"not_confirmed:candidate": 1}

def test_inactive_link_ignored():
    sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01", active=False)])
    assert R.reconcile(D, ledger("uid_test_01"), sp)["diffs"] == {"missing_uid": 1}

def test_extra_weak_only_listed_by_proxy_and_reason():
    sp = dict(encounters=[enc(1), enc(2, status="confirmed", proxies=("acoustic", "timeline"), anchor=None, ambiguous=True)], links=[link(1, "uid_test_01")])
    r = R.reconcile(D, ledger("uid_test_01"), sp)
    assert r["extras"] == [{"proxy": "acoustic+timeline", "reason": "weak_only", "status": "confirmed", "count": 1}]
    assert r["extras_total"] == 1 and r["ambiguous_encounters"] == 1 and r["diffs"] == {}

def test_rejected_and_merged_are_not_extras():
    sp = dict(encounters=[enc(1, status="rejected", reason="blind_room_day"), enc(2, status="merged", merged_into="enc_test000000000001")], links=[])
    assert R.reconcile(D, {}, sp)["extras_total"] == 0

def test_stage_counts_and_proxy_expectation():
    sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01")], artefacts=[dict(encounter_id="e", stage="freescript", status="ok"), dict(encounter_id="e", stage="sarvam", status="failed")],
              signal_counts={"pulse": 17, "pqm": 0})
    r = R.reconcile(D, ledger("uid_test_01"), sp, expect={"pulse": 17, "pqm": 0, "caa": 0})
    assert r["stage_match"]["freescript"]["equal"] is True and r["stage_match"]["sarvam"]["equal"] is False
    assert all(c["equal"] for c in r["proxy_check"].values()) and r["gate"] == "fail"

def test_free_text_never_reaches_output():
    sp = dict(encounters=[enc(1, status="candidate", reason="Dr Some Name saw Patient X", proxies=("pulse",), anchor="A Person")], links=[])
    out = json.dumps(R.reconcile(D, {"uid_test_01": {"stage one": "Free Text!"}}, sp))
    assert "Some Name" not in out and "Patient" not in out and "Person" not in out and "Free Text" not in out

def write(tmp, name, text):
    p = tmp / name; p.write_text(text); return str(p)

def run(tmp, extra=(), lines=None, spine=None):
    led = write(tmp, "ledger.jsonl", "".join(json.dumps(x) + "\n" for x in (lines if lines is not None else [
        dict(consult_uid="uid_test_01", ist_date=D, stages={"freescript": "done"}),
        dict(consult_uid="uid_test_01", ist_date=D, stage="sarvam", state="done"),
        dict(consult_uid="uid_test_09", ist_date="2026-10-18", stage="sarvam", state="done")])) + "not json\n")
    sp = write(tmp, "spine.json", json.dumps(spine or dict(encounters=[enc(1)], links=[link(1, "uid_test_01")])))
    out = str(tmp / "out.json")
    rc = R.main(["--date", D, "--spine", sp, "--ledger", led, "--eta-data", str(tmp), "--out", out, *extra])
    return rc, out

def test_cli_local_json_no_upload_by_default(tmp_path, capsys):
    class Boom:
        def put_object(self, **k): raise AssertionError("uploaded without --upload")
    rc, out = run(tmp_path)
    assert rc == 0
    j = json.load(open(out))
    assert j["ledger_uids"] == 1 and j["ledger_bad_lines"] == 1 and j["gate"] == "pass" and j["daily_recon"] == {"present": False}
    assert oct(os.stat(out).st_mode & 0o777) == "0o600"
    assert R.main(["--date", D, "--spine", str(tmp_path / "spine.json"), "--ledger", str(tmp_path / "ledger.jsonl"), "--eta-data", str(tmp_path), "--out", out], client=Boom()) == 0

def test_cli_upload_only_with_flag(tmp_path):
    calls = []
    class C:
        def put_object(self, **k): calls.append(k)
    rc, _ = run(tmp_path, ["--upload", "--bucket", "b"])
    assert rc == 4
    sp, led = str(tmp_path / "spine.json"), str(tmp_path / "ledger.jsonl")
    assert R.main(["--date", D, "--spine", sp, "--ledger", led, "--eta-data", str(tmp_path), "--out", str(tmp_path / "o2.json"), "--upload", "--bucket", "b"], client=C()) == 0
    assert calls[0]["Key"] == f"enc/spine-recon/{D}.json" and calls[0]["Bucket"] == "b"

def test_cli_daily_recon_counts(tmp_path):
    os.makedirs(tmp_path / "consult" / "recon")
    (tmp_path / "consult" / "recon" / f"{D}.json").write_text(json.dumps(dict(day=dict(pqm_visits=0), rooms=[dict(pulse_windows=17, clips_cut=17)], alerts=[])))
    rc, out = run(tmp_path)
    assert json.load(open(out))["daily_recon"]["clips_cut"] == 17

def test_cli_broken_input_exits_2(tmp_path):
    p = write(tmp_path, "spine.json", "{")
    assert R.main(["--date", D, "--spine", p, "--ledger", str(tmp_path / "none.jsonl"), "--out", str(tmp_path / "o.json")]) == 2
