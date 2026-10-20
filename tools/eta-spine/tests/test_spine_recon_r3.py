import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import spine_recon as R
D = "2026-10-19"
def enc(n, status="confirmed", **kw): return dict(encounter_id=f"enc_test{n}", status=status, proxies=["pulse"], anchor_proxy="pulse", reason="pulse", **kw)
def link(n, uid): return dict(encounter_id=f"enc_test{n}", key_kind="consult_uid", value=uid, active=True)
def run(tmp, lines, sp, extra=(), out=None):
    led = tmp / "l.jsonl"; led.write_text("".join((l if isinstance(l, str) else json.dumps(l)) + "\n" for l in lines))
    s = tmp / "s.json"; s.write_text(sp if isinstance(sp, str) else json.dumps(sp)); out = out or (tmp / "o.json")
    rc = R.main(["--date", D, "--spine", str(s), "--out", str(out), "--ledger", str(led), "--eta-data", str(tmp), *extra])
    return rc, (json.loads(out.read_text()) if os.path.isfile(out) else None)
OK = dict(encounters=[enc("a")], links=[link("a", "uid_test_01")])
L = lambda **kw: dict(dict(consult_uid="uid_test_01", stage="sarvam", state="done"), **kw)
P9 = lambda a, b: "9" * a + "-" + "4" * b
# ---- G1
def test_g1_utc_date_only_fails(tmp_path):
    rc, r = run(tmp_path, [L(date=D)], OK); assert rc == 1 and r["ledger_undated_lines"] == 1 and "ledger_undated_lines" in r["gate_reasons"]
def test_g1_naive_ts_fails(tmp_path):
    for k in ("ts", "t_close", "t_open"):
        rc, r = run(tmp_path, [L(**{k: D + "T06:00:00"})], OK); assert rc == 1 and r["ledger_undated_lines"] == 1, k
def test_g1_ist_header_passes(tmp_path):
    for h in ("Asia/Kolkata", " asia/kolkata "):
        rc, r = run(tmp_path, [{"tz": h}, L(ts=D + "T23:00:00"), L(consult_uid="uid_test_01", stage="whisper", day=D)], OK); assert rc == 0, h
def test_g1_ist_header_naive_late_evening_stays_same_day(tmp_path):
    rc, r = run(tmp_path, [{"tz": "Asia/Kolkata"}, L(ts=D + "T23:59:00")], OK); assert rc == 0 and r["ledger_uids"] == 1
def test_g1_utc_header_bare_date_undated(tmp_path):
    rc, r = run(tmp_path, [{"tz": "UTC"}, L(date=D)], OK); assert rc == 1 and r["ledger_undated_lines"] == 1
def test_g1_unknown_tz_bad(tmp_path):
    for h in ("IST", "+05:30", "Mars/Base", None, 5):
        rc, r = run(tmp_path, [{"tz": h}, L(ts=D + "T05:00:00Z")], OK); assert rc == 1 and r["ledger_bad_lines"] == 1, h
def test_g1_mixed_file_counts(tmp_path):
    rows = [L(ts=D + "T05:00:00Z"), L(consult_uid="uid_test_02", ts=D + "T05:00:00"), L(consult_uid="uid_test_03", date=D), L(consult_uid="uid_test_04", ist_date=D)]
    rc, r = run(tmp_path, rows, OK); assert rc == 1 and r["ledger_undated_lines"] == 2 and r["ledger_uids"] == 2
def test_g1_aware_ts_ignores_header(tmp_path):
    rc, r = run(tmp_path, [{"tz": "Asia/Kolkata"}, L(ts=D + "T19:00:00Z")], OK); assert rc == 1 and "ledger_empty" in r["gate_reasons"]
def test_g1_header_with_uid_is_data_not_header(tmp_path):
    rc, r = run(tmp_path, [L(tz="Asia/Kolkata", date=D)], OK); assert rc == 1 and r["ledger_undated_lines"] == 1
def test_g1_conflicting_headers_not_silently_last_wins(tmp_path):
    rc, r = run(tmp_path, [{"tz": "UTC"}, L(ts=D + "T20:00:00"), {"tz": "Asia/Kolkata"}], OK)
    assert rc == 1, "two different tz headers: the last silently re-zones every line"
def test_g1_utc_header_date_only_ts_is_not_an_ist_date(tmp_path):
    rc, r = run(tmp_path, [{"tz": "UTC"}, L(ts=D)], OK)
    assert rc == 1, "under tz=UTC a date-only ts (a UTC calendar date) is accepted as the IST date"
# ---- G2
def test_g2_every_field_hostile(tmp_path):
    hostile = ["D" + "r Someone", P9(5, 5), "+91 " + "9" * 10, "enc_" + "9" * 9, "x" * 60, "a b", "uid_" + "8" * 8]
    encs = [dict(enc(f"{c}"), status=h, reason=h, anchor_proxy=h, proxies=[h]) for c, h in zip("abcdefg", hostile)]
    links = [link("a", "uid_test_01")] + [dict(link("b", "uid_test_02"), encounter_id=h) for h in hostile] + [dict(link("b", "uid_test_03"), encounter_id=h) for h in hostile]
    encs += [dict(enc("z"), encounter_id=h) for h in hostile]
    sp = dict(encounters=encs, links=links, signal_counts={h: 1 for h in hostile}, artefacts=[dict(encounter_id="enc_testa", stage=h, status=h) for h in hostile])
    rows = [L(ts=D + "T05:00:00Z", stages={h: h}) for h in hostile] + [L(consult_uid="uid_test_02", ts=D + "T05:00:00Z"), L(consult_uid="uid_test_03", ts=D + "T05:00:00Z")]
    rc, r = run(tmp_path, rows, sp, extra=["--expect", ",".join(f"{h}=1" for h in hostile if "," not in h)])
    s = json.dumps(r).lower()
    assert "someone" not in s and not re.search(r"[0-9]{8}", re.sub(r"[-. ()+_:]", "", s.replace(D, ""))), "id/number leak"
    assert r["redacted_ids"] == r["two_uids_encounters"].count("redacted_id") >= 1
def test_g2_clean_id_kept_case(tmp_path):
    good = "enc_" + "abcdefghijklmnop"
    sp = dict(encounters=[dict(enc("a"), encounter_id=good)], links=[dict(link("a", "uid_test_01"), encounter_id=good), dict(link("a", "uid_test_02"), encounter_id=good)])
    rc, r = run(tmp_path, [L(ts=D + "T05:00:00Z"), L(consult_uid="uid_test_02", ts=D + "T05:00:00Z")], sp)
    assert r["two_uids_encounters"] == [good] and r["redacted_ids"] == 0 and rc == 1
# ---- G3
def test_g3_separators():
    for v in (P9(5, 5), "9" * 3 + "." + "8" * 3 + "." + "7" * 4, "+91-" + "9" * 10, "(" + "9" * 3 + ")" + "8" * 7):
        assert R.code(v) == "other", v
def test_g3_underscore_colon_phone():
    for v in ("9" * 5 + "_" + "4" * 5, "9" * 5 + ":" + "4" * 5):
        assert R.code(v) == "other", v
def test_g3_legit_codes_survive():
    for v in ("sarvam", "not_confirmed:merged", "whisper-v3", "opd-5", "room_12", "a-123-456", "nemotron_window", "clips-2026-10"):
        assert R.code(v) == v, v
def test_g3_date_shaped_code_is_dropped_note():
    assert R.code("cut-" + D) == "other"  # fail-safe: dashed dates collapse to other
# ---- G4
def _crash(tmp_path, lines, sp, **kw):
    rc, r = run(tmp_path, lines, sp, **kw); assert rc == 2 and r is None, rc
def test_g4_crash_paths(tmp_path):
    ln = [L(ts=D + "T05:00:00Z")]
    for sp in (dict(OK, artefacts=["x"]), dict(OK, links=[dict(encounter_id="enc_testa", key_kind="consult_uid")]), dict(OK, signal_counts=["x"]),
               dict(OK, encounters=[dict(enc("a"), encounter_id=["x"])]), "[]", "{", dict(OK, encounters=[dict(enc("a"), proxies=5, anchor_proxy=None)], links=[]),
               dict(OK, signal_counts={"a": float("inf")}) if False else dict(OK, artefacts=[None]), "[" * 5000 + "]" * 5000):
        _crash(tmp_path, ln, sp)
def test_g4_daily_crashes(tmp_path):
    for d in (dict(rooms=[dict(clips_cut="x")]), dict(rooms=[dict(clips_cut=None)]), dict(day=dict(pqm_visits=[1]))):
        p = tmp_path / "d.json"; p.write_text(json.dumps(d))
        _crash(tmp_path, [L(ts=D + "T05:00:00Z")], OK, extra=["--daily-recon", str(p)])
def test_g4_non_utf8_ledger(tmp_path):
    led = tmp_path / "l.jsonl"; led.write_bytes(b"\xff\xfe\x00bad\n"); s = tmp_path / "s.json"; s.write_text(json.dumps(OK))
    assert R.main(["--date", D, "--spine", str(s), "--out", str(tmp_path / "o.json"), "--ledger", str(led)]) == 2
def test_g4_unwritable_out_is_not_exit_1(tmp_path):
    rc = None
    try:
        rc, _ = run(tmp_path, [L(ts=D + "T05:00:00Z")], OK, out=tmp_path / "nodir" / "o.json")
    except Exception as e:
        rc = f"uncaught {type(e).__name__} (python exit 1)"
    assert rc not in (0, 1) and isinstance(rc, int), rc
def test_g4_exit1_only_gate_fail(tmp_path):
    rc, r = run(tmp_path, [L(ts=D + "T05:00:00Z")], OK); assert rc == 0 and r["gate"] == "pass"
    rc, r = run(tmp_path, [L(ts=D + "T05:00:00")], OK); assert rc == 1 and r["gate"] == "fail"
def test_g2_lowercase_word_id_is_redacted(tmp_path):
    name = "some" + "one"
    sp = dict(encounters=[dict(enc("a"), encounter_id=name)], links=[dict(link("a", "uid_test_01"), encounter_id=name), dict(link("a", "uid_test_02"), encounter_id=name)])
    rc, r = run(tmp_path, [L(ts=D + "T05:00:00Z"), L(consult_uid="uid_test_02", ts=D + "T05:00:00Z")], sp)
    assert name not in json.dumps(r) and r["two_uids_encounters"] == ["redacted_id"] and r["redacted_ids"] == 1
# ---- builder additions (R4)
def test_h1_late_header_is_bad_and_not_applied(tmp_path):
    rc, r = run(tmp_path, [{"tz": "UTC"}, L(ts=D + "T06:00:00"), {"tz": "Asia/Kolkata"}], OK)
    assert rc == 1 and r["ledger_bad_lines"] == 1
def test_h1_second_header_bad(tmp_path):
    rc, r = run(tmp_path, [{"tz": "Asia/Kolkata"}, {"tz": "Asia/Kolkata"}, L(ts=D + "T06:00:00")], OK)
    assert rc == 1 and r["ledger_bad_lines"] == 1
def test_h2_date_only_ts_undated(tmp_path):
    for k in ("ts", "t_close", "t_open"):
        rc, r = run(tmp_path, [{"tz": "UTC"}, L(**{k: D})], OK); assert rc == 1 and r["ledger_undated_lines"] == 1, k
def test_enc_id_loosened_mutant_dies():
    assert R.enc_code("someone") is None and R.enc_code("enc_ab-c") is None and R.enc_code("enc_testa") == "enc_testa"
def test_g3_underscore_colon_phone():
    assert R.code("99999_44444") == "other" and R.code("99999:44444") == "other" and R.code("room_12") == "room_12"
def test_g4_unwritable_out_is_exit_2(tmp_path):
    rc, r = run(tmp_path, [L(ts=D + "T05:00:00Z")], OK, out=tmp_path / "nodir" / "o.json"); assert rc == 2
