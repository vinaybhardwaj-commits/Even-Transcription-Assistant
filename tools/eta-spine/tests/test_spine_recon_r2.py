import json, os, sys, stat
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import spine_recon as R
D = "2026-10-19"
def enc(n, status="confirmed", **kw): return dict(encounter_id=f"enc_test{n}", status=status, proxies=["pulse"], anchor_proxy="pulse", reason="pulse", **kw)
def link(n, uid): return dict(encounter_id=f"enc_test{n}", key_kind="consult_uid", value=uid, active=True)
def run(tmp, lines, sp, extra=()):
    led = tmp / "l.jsonl"; led.write_text("".join((l if isinstance(l, str) else json.dumps(l)) + "\n" for l in lines))
    s = tmp / "s.json"; s.write_text(json.dumps(sp)); out = tmp / "o.json"
    rc = R.main(["--date", D, "--spine", str(s), "--out", str(out), "--ledger", str(led), "--eta-data", str(tmp), *extra])
    return rc, (json.loads(out.read_text()) if out.exists() else None)
OK = dict(encounters=[enc("a")], links=[link("a", "uid_test_01")])
L1 = dict(consult_uid="uid_test_01", ts="2026-10-19T05:00:00Z", stage="sarvam", state="done")
def test_correct_ledger_passes(tmp_path):
    rc, r = run(tmp_path, [L1], OK); assert rc == 0 and r["gate"] == "pass" and r["gate_reasons"] == []
def test_empty(tmp_path):
    rc, r = run(tmp_path, [], OK); assert rc == 1 and "ledger_empty" in r["gate_reasons"]
def test_bad_json_line(tmp_path):
    rc, r = run(tmp_path, [L1, "{not json"], OK); assert rc == 1 and r["gate_reasons"] == ["ledger_bad_lines"]
def test_wrong_key(tmp_path):
    rc, r = run(tmp_path, [dict(uid="uid_test_01", ts=L1["ts"])], OK); assert rc == 1 and {"ledger_empty", "ledger_bad_lines"} <= set(r["gate_reasons"])
def test_undated(tmp_path):
    rc, r = run(tmp_path, [L1, dict(consult_uid="uid_test_02", when="x")], OK); assert rc == 1 and r["gate_reasons"] == ["ledger_undated_lines"]
def test_utc_ts_evening_goes_to_next_ist_day(tmp_path):
    # 19:00Z on the 19th is 00:30 IST on the 20th: not this day -> ledger empty for D
    rc, r = run(tmp_path, [dict(L1, ts="2026-10-19T19:00:00Z")], OK); assert rc == 1 and "ledger_empty" in r["gate_reasons"]
def test_utc_ts_beats_bare_utc_date(tmp_path):
    rc, r = run(tmp_path, [dict(L1, ts="2026-10-18T19:00:00Z", date="2026-10-18")], OK); assert rc == 0
def test_bare_utc_date_only_ledger_must_not_pass(tmp_path):
    # ledger written with a UTC calendar "date" only (no ts, no ist_date): zone unknown -> should not be trusted for the gate
    rc, r = run(tmp_path, [dict(consult_uid="uid_test_01", date=D, stage="sarvam", state="done")], OK)
    assert rc != 0, "a ledger dated only by a zone-less 'date' passes the IST gate"
def test_under_floor(tmp_path):
    uids = [f"uid_test_{i:02d}" for i in range(20)]
    sp = dict(encounters=[enc(f"x{i:02d}".replace("0","a").replace("1","b")) for i in range(18)], links=[])
    sp["links"] = [dict(encounter_id=e["encounter_id"], key_kind="consult_uid", value=u, active=True) for e, u in zip(sp["encounters"], uids)]
    rc, r = run(tmp_path, [dict(L1, consult_uid=u) for u in uids], sp)
    assert rc == 1 and "matched_below_floor" in r["gate_reasons"] and r["mapped_to_one_confirmed"] == 18
def test_two_uids(tmp_path):
    rc, r = run(tmp_path, [L1, dict(L1, consult_uid="uid_test_02")], dict(encounters=[enc("a")], links=[link("a", "uid_test_01"), link("a", "uid_test_02")]))
    assert rc == 1 and "two_uids_one_encounter" in r["gate_reasons"] and r["two_uids_encounters"] == ["enc_testa"]
def test_two_uids_list_is_not_filtered(tmp_path):
    # the id list bypasses code(): a non-spine id (8+ digit run) reaches the output verbatim
    bad = "enc_" + "9" * 11
    sp = dict(encounters=[dict(enc("a"), encounter_id=bad)], links=[dict(link("a", "uid_test_01"), encounter_id=bad), dict(link("a", "uid_test_02"), encounter_id=bad)])
    rc, r = run(tmp_path, [L1, dict(L1, consult_uid="uid_test_02")], sp)
    assert bad not in json.dumps(r), "unvalidated encounter_id reaches the report"
def test_code_digits():
    assert R.code("1" * 8) == "other" and R.code("1" * 7) == "1" * 7 and R.code("x_" + "1" * 8) == "other"
def test_code_dashed_phone():
    assert R.code("-".join(["9" * 5, "4" * 5])) == "other", "a dashed 10-digit phone passes code()"
def test_tmp_0644_symlink(tmp_path):
    out = tmp_path / "o.json"; tgt = tmp_path / "victim"; tgt.write_text("keep"); os.symlink(tgt, str(out) + ".tmp")
    R.write_atomic(str(out), "{}"); assert tgt.read_text() == "keep" and stat.S_IMODE(os.stat(out).st_mode) == 0o600
def test_tmp_0644(tmp_path):
    out = tmp_path / "o.json"; t = tmp_path / "o.json.tmp"; t.write_text("x"); os.chmod(t, 0o644)
    R.write_atomic(str(out), "{}"); assert stat.S_IMODE(os.stat(out).st_mode) == 0o600 and not t.exists()
def test_non_dict_daily_and_room(tmp_path, capsys):
    for d in (["x"], dict(rooms=["x"]), dict(rooms={"a": 1}), dict(day=["x"])):
        p = tmp_path / "d.json"; p.write_text(json.dumps(d))
        rc, _ = run(tmp_path, [L1], OK, ["--daily-recon", str(p)]); assert rc == 2, d
        assert "daily_recon: bad shape" in capsys.readouterr().err
def test_non_dict_link(tmp_path, capsys):
    rc, _ = run(tmp_path, [L1], dict(encounters=[enc("a")], links=[link("a", "uid_test_01"), 7])); assert rc == 2
    assert "spine: bad link" in capsys.readouterr().err
def test_non_dict_artefact_is_broken_input(tmp_path):
    rc, _ = run(tmp_path, [L1], dict(OK, artefacts=["x"])); assert rc == 2
def test_link_without_value_is_broken_input(tmp_path):
    rc, _ = run(tmp_path, [L1], dict(encounters=[enc("a")], links=[dict(encounter_id="enc_testa", key_kind="consult_uid")])); assert rc == 2
def test_flags_counted(tmp_path):
    sp = dict(encounters=[enc("a", flags=["ambiguous", "clamped"]), enc("b", status="rejected", flags=["ambiguous"])], links=[link("a", "uid_test_01")])
    rc, r = run(tmp_path, [L1], sp); assert r["ambiguous_encounters"] == 1 and r["flag_counts"]["clamped"] == 1 and "ambiguous" not in json.dumps(r["extras"])

def test_naive_ts_is_undated(tmp_path):
    rc, r = run(tmp_path, [dict(L1, ts="2026-10-19T10:00:00")], OK)
    assert rc == 1 and "ledger_undated_lines" in r["gate_reasons"] and r["ledger_undated_lines"] == 1
def test_date_only_ts_is_undated(tmp_path):
    rc, r = run(tmp_path, [dict(L1, ts=D)], OK); assert rc == 1 and "ledger_undated_lines" in r["gate_reasons"]
def test_bare_day_field_is_undated(tmp_path):
    rc, r = run(tmp_path, [dict(consult_uid="uid_test_01", day=D, stage="sarvam", state="done")], OK)
    assert rc == 1 and r["ledger_undated_lines"] == 1
def test_header_ist_accepts_naive_ts_and_bare_date(tmp_path):
    rc, r = run(tmp_path, [{"tz": "Asia/Kolkata"}, dict(L1, ts="2026-10-19T10:00:00")], OK); assert rc == 0 and r["gate_reasons"] == []
    rc, r = run(tmp_path, [{"tz": "Asia/Kolkata"}, dict(consult_uid="uid_test_01", date=D, stage="sarvam", state="done")], OK); assert rc == 0
def test_header_utc_reads_naive_ts_as_utc(tmp_path):
    # naive 19:00 under UTC is 00:30 IST next day: not this IST day
    rc, r = run(tmp_path, [{"tz": "UTC"}, dict(L1, ts="2026-10-19T19:00:00")], OK); assert rc == 1 and "ledger_empty" in r["gate_reasons"]
    rc, r = run(tmp_path, [{"tz": "UTC"}, dict(L1, ts="2026-10-19T05:00:00")], OK); assert rc == 0
def test_header_utc_does_not_make_bare_date_ist(tmp_path):
    rc, r = run(tmp_path, [{"tz": "UTC"}, dict(consult_uid="uid_test_01", date=D, stage="sarvam", state="done")], OK)
    assert rc == 1 and r["ledger_undated_lines"] == 1
def test_header_anywhere_and_unknown_tz_is_bad(tmp_path):
    rc, r = run(tmp_path, [dict(L1, ts="2026-10-19T10:00:00"), {"tz": "Asia/Kolkata"}], OK); assert rc == 0
    rc, r = run(tmp_path, [{"tz": "Mars/Base"}, L1], OK); assert rc == 1 and r["ledger_bad_lines"] == 1
def test_g2_redacted_id_counted_and_clean_id_kept(tmp_path):
    bad = "enc_" + "9" * 11
    sp = dict(encounters=[dict(enc("a"), encounter_id=bad), enc("b")], links=[dict(link("a", "uid_test_01"), encounter_id=bad), dict(link("a", "uid_test_02"), encounter_id=bad), link("b", "uid_test_03"), link("b", "uid_test_04")])
    rc, r = run(tmp_path, [L1, dict(L1, consult_uid="uid_test_02"), dict(L1, consult_uid="uid_test_03"), dict(L1, consult_uid="uid_test_04")], sp)
    assert bad not in json.dumps(r) and sorted(r["two_uids_encounters"]) == ["enc_testb", "redacted_id"] and r["redacted_ids"] == 1
def test_g2_non_enc_id_is_redacted(tmp_path):
    name = "D" + "r" + " Someone"
    sp = dict(encounters=[dict(enc("a"), encounter_id=name)], links=[dict(link("a", "uid_test_01"), encounter_id=name), dict(link("a", "uid_test_02"), encounter_id=name)])
    rc, r = run(tmp_path, [L1, dict(L1, consult_uid="uid_test_02")], sp)
    assert "someone" not in json.dumps(r).lower() and r["two_uids_encounters"] == ["redacted_id"]
def test_g3_phone_separators():
    for v in ("-".join(["9" * 5, "4" * 5]), "+91 " + "9" * 5 + " " + "4" * 5, "(" + "9" * 4 + ") " + "5" * 4 + "." + "6" * 4, "9" * 4 + " " + "8" * 4):
        assert R.code(v) == "other", v
    assert R.code("a-" + "1" * 3 + "-" + "2" * 3) == "a-" + "1" * 3 + "-" + "2" * 3
def test_g4_crash_is_exit_2_not_1(tmp_path):
    rc, _ = run(tmp_path, [L1], dict(OK, signal_counts=["x"])); assert rc == 2
def test_g4_gate_fail_stays_exit_1(tmp_path):
    rc, _ = run(tmp_path, [], OK); assert rc == 1
