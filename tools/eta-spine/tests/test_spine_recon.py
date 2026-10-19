import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import spine_recon as R

D = "2026-10-19"
def eid(i):
    return "enc_test" + chr(ord("a") + i) * 12


def enc(i, status="confirmed", proxies=("pulse",), anchor="pulse", reason=None, **kw):
    return dict(encounter_id=eid(i), status=status, proxies=list(proxies), anchor_proxy=anchor, reason=reason, **kw)
def link(i, uid, active=True):
    return dict(encounter_id=eid(i), key_kind="consult_uid", value=uid, active=active)
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
    sp = dict(encounters=[enc(1), enc(2, status="merged", merged_into=eid(1))], links=[link(1, "uid_test_01"), link(2, "uid_test_02")])
    r = R.reconcile(D, ledger("uid_test_01", "uid_test_02"), sp)
    assert r["diffs"] == {} and r["mapped_to_one_confirmed"] == 2 and r["merged_uids_encounters"] == 1

def test_candidate_is_not_confirmed():
    sp = dict(encounters=[enc(1, status="candidate")], links=[link(1, "uid_test_01")])
    assert R.reconcile(D, ledger("uid_test_01"), sp)["diffs"] == {"not_confirmed:candidate": 1}

def test_inactive_link_ignored():
    sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01", active=False)])
    assert R.reconcile(D, ledger("uid_test_01"), sp)["diffs"] == {"missing_uid": 1}

def test_extra_weak_only_listed_by_proxy_and_reason():
    sp = dict(encounters=[enc(1), enc(2, status="confirmed", proxies=("acoustic", "timeline"), anchor=None, flags=["ambiguous"])], links=[link(1, "uid_test_01")])
    r = R.reconcile(D, ledger("uid_test_01"), sp)
    assert r["extras"] == [{"proxy": "acoustic+timeline", "reason": "weak_only", "status": "confirmed", "count": 1}]
    assert r["extras_total"] == 1 and r["ambiguous_encounters"] == 1 and r["flag_counts"]["ambiguous"] == 1 and r["diffs"] == {}

def test_rejected_and_merged_are_not_extras():
    sp = dict(encounters=[enc(1, status="rejected", reason="blind_room_day"), enc(2, status="merged", merged_into=eid(1))], links=[])
    assert R.reconcile(D, {}, sp)["extras_total"] == 0

def test_stage_counts_and_proxy_expectation():
    sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01")], artefacts=[dict(encounter_id="e", stage="freescript", status="ok"), dict(encounter_id="e", stage="sarvam", status="failed")],
              signal_counts={"pulse": 17, "pqm": 0})
    r = R.reconcile(D, ledger("uid_test_01"), sp, expect={"pulse": 17, "pqm": 0, "caa": 0})
    assert r["stage_match"]["freescript"]["equal"] is True and r["stage_match"]["sarvam"]["equal"] is False
    assert all(c["equal"] for c in r["proxy_check"].values()) and r["gate"] == "fail"

def test_free_text_never_reaches_output():
    sp = dict(encounters=[enc(1, status="candidate", reason="Free Quux Alpha saw Sample X", proxies=("pulse",), anchor="A Person")], links=[])
    out = json.dumps(R.reconcile(D, {"uid_test_01": {"stage one": "Free Text!"}}, sp))
    assert "Quux Alpha" not in out and "Patient" not in out and "Person" not in out and "Free Text" not in out

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
    assert rc == 1  # the "not json" line is a bad ledger line: the gate fails
    j = json.load(open(out))
    assert j["ledger_uids"] == 1 and j["ledger_bad_lines"] == 1 and j["gate"] == "fail" and j["gate_reasons"] == ["ledger_bad_lines"] and j["daily_recon"] == {"present": False}
    assert oct(os.stat(out).st_mode & 0o777) == "0o600"
    assert R.main(["--date", D, "--spine", str(tmp_path / "spine.json"), "--ledger", str(tmp_path / "ledger.jsonl"), "--eta-data", str(tmp_path), "--out", out], client=Boom()) == 1

def test_cli_upload_only_with_flag(tmp_path):
    calls = []
    class C:
        def put_object(self, **k): calls.append(k)
    rc, _ = run(tmp_path, ["--upload", "--bucket", "b"])
    assert rc == 4
    sp, led = str(tmp_path / "spine.json"), str(tmp_path / "ledger.jsonl")
    assert R.main(["--date", D, "--spine", sp, "--ledger", led, "--eta-data", str(tmp_path), "--out", str(tmp_path / "o2.json"), "--upload", "--bucket", "b"], client=C()) == 1
    assert calls[0]["Key"] == f"enc/spine-recon/{D}.json" and calls[0]["Bucket"] == "b"

def test_cli_daily_recon_counts(tmp_path):
    os.makedirs(tmp_path / "consult" / "recon")
    (tmp_path / "consult" / "recon" / f"{D}.json").write_text(json.dumps(dict(day=dict(pqm_visits=0), rooms=[dict(pulse_windows=17, clips_cut=17)], alerts=[])))
    rc, out = run(tmp_path)
    assert json.load(open(out))["daily_recon"]["clips_cut"] == 17

def test_cli_broken_input_exits_2(tmp_path):
    p = write(tmp_path, "spine.json", "{")
    assert R.main(["--date", D, "--spine", p, "--ledger", str(tmp_path / "none.jsonl"), "--out", str(tmp_path / "o.json")]) == 2


# ---- R2: refute F1-F8 (Opus refute tests ported; mutants B-series / P8-P10 killed) ----
import builtins, socket

def one(tmp, led_lines, spine, extra=()):
    led = write(tmp, "l.jsonl", "".join(json.dumps(x) + "\n" for x in led_lines))
    sp = write(tmp, "s.json", json.dumps(spine))
    out = str(tmp / "o.json")
    return R.main(["--date", D, "--spine", sp, "--ledger", led, "--eta-data", str(tmp), "--out", out, *extra]), out

def good_spine():
    return dict(encounters=[enc(1)], links=[link(1, "uid_test_01")])

def test_F1_flags_counted_and_all_exposed():
    sp = dict(encounters=[enc(1, flags=["ambiguous", "multi_machine"]), enc(2, flags=["clamped", "pulse_overlap"]), enc(3, flags=["clamp_failed", "covered_by_pulse"]), enc(4)],
              links=[link(1, "uid_test_01")])
    fc = R.reconcile(D, ledger("uid_test_01"), sp)["flag_counts"]
    assert fc == {"ambiguous": 1, "multi_machine": 1, "pulse_overlap": 1, "clamped": 1, "clamp_failed": 1, "covered_by_pulse": 1}

def test_F2_wrong_ledger_key_fails_gate(tmp_path):
    rc, out = one(tmp_path, [dict(uid="uid_test_01", ist_date=D, stage="sarvam", state="done")], good_spine())
    r = json.load(open(out))
    assert rc == 1 and r["gate"] == "fail" and r["ledger_uids"] == 0
    assert "ledger_empty" in r["gate_reasons"] and "ledger_bad_lines" in r["gate_reasons"]

def test_F2_empty_ledger_fails_gate(tmp_path):
    rc, out = one(tmp_path, [], dict(encounters=[], links=[]))
    assert rc == 1 and json.load(open(out))["gate_reasons"] == ["ledger_empty"]

def test_F2_undated_line_fails_gate(tmp_path):
    rc, out = one(tmp_path, [dict(consult_uid="uid_test_01", ist_date=D, stage="sarvam", state="done"), dict(consult_uid="uid_test_02", stage="sarvam", state="done")], good_spine())
    r = json.load(open(out))
    assert rc == 1 and r["ledger_undated_lines"] == 1 and "ledger_undated_lines" in r["gate_reasons"]

def test_F2_utc_date_is_not_ist_date(tmp_path):
    # 2026-10-19T19:00Z is 00:30 IST on the 20th: a UTC-bucketed ledger puts it on the wrong day
    assert R.line_date({"ts": "2026-10-19T19:00:00Z"}) == "2026-10-20"
    assert R.line_date({"ts": "2026-10-19T19:00:00Z", "date": "2026-10-19"}) == "2026-10-20"
    assert R.line_date({"ts": "2026-10-19T19:00:00+00:00", "ist_date": "2026-10-20"}) == "2026-10-20"
    rc, out = one(tmp_path, [dict(consult_uid="uid_test_01", ts="2026-10-19T19:00:00Z", stage="sarvam", state="done")], good_spine())
    r = json.load(open(out))
    assert rc == 1 and r["ledger_uids"] == 0 and r["gate"] == "fail"

def test_F2_match_floor_95_percent():
    uids = [f"uid_test_{i:02d}" for i in range(20)]
    encs = [enc(i) for i in range(20)]
    links = [link(i, u) for i, u in enumerate(uids)]
    full = R.reconcile(D, ledger(*uids), dict(encounters=encs, links=links))
    assert full["gate"] == "pass" and full["gate_reasons"] == []
    r = R.reconcile(D, ledger(*uids), dict(encounters=encs[:19], links=links[:19]))  # 19/20 = 95%: still fails on the diff
    assert r["gate"] == "fail" and "diffs" in r["gate_reasons"] and "matched_below_floor" not in r["gate_reasons"]
    r = R.reconcile(D, ledger(*uids), dict(encounters=encs[:18], links=links[:18]))  # 18/20 = 90%
    assert "matched_below_floor" in r["gate_reasons"]

def test_F3_two_uids_one_encounter_fails():
    sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01"), link(1, "uid_test_02")])
    r = R.reconcile(D, ledger("uid_test_01", "uid_test_02"), sp)
    assert r["gate"] == "fail" and "two_uids_one_encounter" in r["gate_reasons"] and r["two_uids_encounters"] == [eid(1)]
    assert r["merged_uids_encounters"] == 1

def test_F4_code_rejects_eight_digit_runs():
    assert R.code("9876543210") == "other" and R.code("a12345678b") == "other"
    assert R.code("1234567") == "1234567" and R.code("uid_12345_6789") == "uid_12345_6789"

def test_F5_write_atomic_0600_over_stale_tmp(tmp_path):
    out, tmp = tmp_path / "o.json", tmp_path / "o.json.tmp"
    tmp.write_text("x"); os.chmod(tmp, 0o644)
    R.write_atomic(str(out), "{}")
    assert oct(os.stat(out).st_mode & 0o777) == "0o600" and not tmp.exists()

def test_F6_non_dict_room_or_link_is_broken_input(tmp_path):
    L = [dict(consult_uid="uid_test_01", ist_date=D, stage="sarvam", state="done")]
    dr = write(tmp_path, "d.json", json.dumps(dict(rooms=["x"])))
    assert one(tmp_path, L, good_spine(), ["--daily-recon", dr])[0] == 2
    dr = write(tmp_path, "d2.json", json.dumps([1]))
    assert one(tmp_path, L, good_spine(), ["--daily-recon", dr])[0] == 2
    assert one(tmp_path, L, dict(encounters=[], links=["x"]))[0] == 2

def test_no_network_without_upload(tmp_path, monkeypatch):
    def boom(*a, **k): raise AssertionError("network")
    monkeypatch.setattr(socket, "socket", boom); monkeypatch.setattr(socket, "create_connection", boom)
    real = builtins.__import__
    def guard(n, *a, **k):
        if n.startswith("boto"): raise AssertionError("boto3")
        return real(n, *a, **k)
    monkeypatch.setattr(builtins, "__import__", guard)
    assert one(tmp_path, [dict(consult_uid="uid_test_01", ist_date=D, stage="sarvam", state="done")], good_spine())[0] == 0

def test_P8_free_text_filter_is_case_insensitive_on_output():
    # P8: with the CODE filter removed, lowercased free text "free text!" is still not a code
    sp = dict(encounters=[enc(1, status="candidate", reason="Free Text With Spaces!", anchor="A Person")], links=[])
    out = json.dumps(R.reconcile(D, {"uid_test_01": {"Stage One": "Free Text!"}}, sp)).lower()
    assert "free text" not in out and "a person" not in out and "stage one" not in out and "with spaces" not in out

def test_P9_links_to_absent_encounters_are_ignored():
    sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01"), link(7, "uid_test_02")])
    r = R.reconcile(D, ledger("uid_test_01", "uid_test_02"), sp)
    assert r["diffs"] == {"missing_uid": 1}

def test_P10_every_done_state_counts_as_done():
    for st in R.DONE_STATES:
        sp = dict(encounters=[enc(1)], links=[link(1, "uid_test_01")], artefacts=[dict(encounter_id="e", stage="freescript", status="ok")])
        assert R.reconcile(D, {"uid_test_01": {"freescript": st}}, sp)["stage_match"]["freescript"]["equal"] is True, st
    assert R.DONE_STATES == ("done", "ok", "written", "sealed", "ready")
