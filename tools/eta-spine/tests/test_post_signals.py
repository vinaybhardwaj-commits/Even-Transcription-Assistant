"""post_signals: dry-run is the default and opens no socket; a disallowed key is refused client-side; the mappers; --post needs a 0600 token file. No network."""
import datetime as dt, io, json, os, sys, contextlib
from unittest import mock
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import post_signals as P

NOW = dt.datetime(2026, 10, 18, 6, 0, tzinfo=dt.timezone.utc)
T0 = 1790000000.0


def write(tmp_path, rows, name="in.jsonl"):
    p = tmp_path / name
    p.write_text("\n".join(json.dumps(r) if not isinstance(r, str) else r for r in rows) + "\n")
    return str(p)


def run(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = P.main(argv, now=NOW)
    return rc, out.getvalue()


PQM = dict(consult_uid="pqm_a1b2c3d4e5f6a7b8c9d0e1", room_id="room_abcd2345", t_open=T0, t_close=T0 + 600, close_reason="pqm", quality="pqm", pqm_step_uid="a1b2c3d4e5f6a7b8c9d0")
CUT = dict(consult_uid="uidtestaaaaaaaaaaaaaaaaa", room_id="room_abcd2345", span_start="2026-10-18 09:30:00.000", span_end="2026-10-18 09:40:00.500", status="cut", window_id=7)
CAA = dict(consult_uid="uidtestbbbbbbbbbbbbbbbbb", scope_path="scope/room_abcd2345/x", manifest=dict(t0_ms=1790000000000, t1_ms=1790000600000))


def test_dry_run_is_default_prints_counts_only_and_makes_no_network_call(tmp_path):
    f = write(tmp_path, [PQM, "not json", PQM | {"consult_uid": None}])
    with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")), mock.patch("socket.socket", side_effect=AssertionError("socket")):
        rc, out = run(["--kind", "pqm", "--file", f])
    assert rc == 0
    assert json.loads(out) == {"mode": "dry-run", "kind": "pqm", "read": 3, "bad_lines": 1, "skipped": 1, "refused": 0, "refused_by_reason": {}, "signals": 1}
    assert "pqm_a1b2c3d4e5f6a7b8c9d0e1" not in out and "room_abcd2345" not in out


def test_dry_run_never_reads_the_token(tmp_path):
    f = write(tmp_path, [PQM])
    rc, _ = run(["--kind", "pqm", "--file", f, "--token-file", str(tmp_path / "missing")])
    assert rc == 0


def test_mappers():
    p = P.from_pqm(PQM, "o")
    assert (p["proxy"], p["source_key"], p["t_open"], p["t_close"]) == ("pqm", "pqm_a1b2c3d4e5f6a7b8c9d0e1", "2026-09-21T14:13:20.000Z", "2026-09-21T14:23:20.000Z")
    assert p["attrs"] == {"ids": {"consult_uid": "pqm_a1b2c3d4e5f6a7b8c9d0e1", "pqm_step_uid": "a1b2c3d4e5f6a7b8c9d0"}, "quality": "pqm", "close_reason": "pqm"}
    c = P.from_cutter(CUT, "o")
    assert (c["t_open"], c["t_close"]) == ("2026-10-18T04:00:00.000Z", "2026-10-18T04:10:00.500Z")   # IST -> UTC
    a = P.from_caa(CAA, "o")
    assert (a["room_id"], a["t_close"]) == ("room_abcd2345", "2026-09-21T14:23:20.000Z")
    assert P.from_caa(dict(CAA, manifest={}), "o") is None
    for s in (p, c, a):
        assert set(s) <= {"proxy", "source_key", "room_id", "t_open", "t_close", "observed_at", "attrs"} and "source_rev" not in s


def test_cutter_takes_the_latest_row_per_uid(tmp_path):
    f = write(tmp_path, [CUT, CUT | {"span_end": "2026-10-18 09:45:00.000"}, CUT | {"consult_uid": "uidtestccccccccccccccccc"}])
    sigs, counts = P.build(f, "cutter", "o")
    assert counts["signals"] == 2
    assert [s["t_close"] for s in sigs if s["source_key"] == "uidtestaaaaaaaaaaaaaaaaa"] == ["2026-10-18T04:15:00.000Z"]


def test_disallowed_keys_are_refused_client_side_at_any_depth_and_never_sent(tmp_path):
    assert P.check_signal(P.from_pqm(PQM, "o"))
    for bad in ({"attrs": {"ids": {"patient_label": "x"}}}, {"attrs": {"ids": {"a": {"b": {"c": {"Name": "x"}}}}}}, {"phone": "x"}, {"attrs": {"extra": 1}}):
        s = P.from_pqm(PQM, "o") | bad
        with pytest.raises(P.Refused):
            P.check_signal(s)
    # through the input: a row whose ids would carry a text-like key never reaches the signals list
    with mock.patch.dict(P.MAPPERS, {"pqm": lambda r, o: {"proxy": "pqm", "source_key": "k", "t_open": "x", "attrs": {"ids": {"x": {"y": {"transcript": "t"}}}}}}):
        sigs, counts = P.build(write(tmp_path, [PQM]), "pqm", "o")
    assert sigs == [] and counts["refused"] == 1


def test_deep_nesting_is_refused():
    o = {}
    for _ in range(40):
        o = {"k": o}
    with pytest.raises(P.Refused):
        P.refuse_keys(o)


def test_post_needs_url_and_token_file_and_a_0600_token(tmp_path):
    f = write(tmp_path, [PQM])
    with pytest.raises(SystemExit):
        run(["--kind", "pqm", "--file", f, "--post"])
    tok = tmp_path / "tok"
    tok.write_text("tok_test\n")
    os.chmod(tok, 0o644)
    with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")), pytest.raises(SystemExit):
        run(["--kind", "pqm", "--file", f, "--post", "--url", "https://x.test/api/spine/signals", "--token-file", str(tok)])


def test_post_sends_a_bearer_batch_and_reports_counts(tmp_path):
    f = write(tmp_path, [PQM, PQM | {"consult_uid": "pqm_b1b2c3d4e5f6a7b8c9d0e1"}])
    tok = tmp_path / "tok"
    tok.write_text("tok_test\n")
    os.chmod(tok, 0o600)
    seen = {}
    def fake(url, token, batch):
        seen.update(url=url, token=token, n=len(batch))
        return 200, {"ok": True, "inserted": 1, "duplicate": 1}
    with mock.patch.object(P, "post_batch", fake):
        rc, out = run(["--kind", "pqm", "--file", f, "--post", "--url", "https://x.test/api/spine/signals", "--token-file", str(tok)])
    assert rc == 0 and seen == {"url": "https://x.test/api/spine/signals", "token": "tok_test", "n": 2}
    assert json.loads(out)["inserted"] == 1 and "tok_test" not in out
    with mock.patch.object(P, "post_batch", lambda u, t, b: (401, {})):
        rc, out = run(["--kind", "pqm", "--file", f, "--post", "--url", "https://x.test/x", "--token-file", str(tok)])
    assert rc == 1 and json.loads(out)["failed_status"] == 401


def _post(tmp_path, rows, responder):
    f = write(tmp_path, rows)
    tok = tmp_path / "tok"
    tok.write_text("tok_test\n")
    os.chmod(tok, 0o600)
    with mock.patch.object(P, "post_batch", responder):
        return run(["--kind", "pqm", "--file", f, "--post", "--url", "https://x.test/x", "--token-file", str(tok)])


def test_a_server_conflict_is_counted_reported_and_exits_3(tmp_path):
    rc, out = _post(tmp_path, [PQM, PQM | {"consult_uid": "pqm_b1b2c3d4e5f6a7b8c9d0e1"}], lambda u, t, b: (200, {"ok": True, "inserted": 1, "duplicate": 0, "conflict": 1}))
    assert rc == 3
    assert json.loads(out)["conflict"] == 1 and json.loads(out)["inserted"] == 1


def test_conflicts_add_up_across_batches_and_zero_conflict_is_rc_0(tmp_path):
    with mock.patch.object(P, "BATCH", 1):
        rc, out = _post(tmp_path, [PQM, PQM | {"consult_uid": "pqm_b1b2c3d4e5f6a7b8c9d0e1"}], lambda u, t, b: (200, {"ok": True, "inserted": 0, "duplicate": 0, "conflict": 1}))
    assert rc == 3 and json.loads(out)["conflict"] == 2
    rc, out = _post(tmp_path, [PQM], lambda u, t, b: (200, {"ok": True, "inserted": 1, "duplicate": 0, "conflict": 0}))
    assert rc == 0 and json.loads(out)["conflict"] == 0


def test_a_response_without_a_conflict_field_is_zero(tmp_path):
    rc, out = _post(tmp_path, [PQM], lambda u, t, b: (200, {"ok": True, "inserted": 1, "duplicate": 0}))
    assert rc == 0 and json.loads(out)["conflict"] == 0


def test_conflict_survives_a_later_batch_that_the_server_skipped(tmp_path):
    answers = iter([(200, {"ok": True, "inserted": 0, "duplicate": 0, "conflict": 1}), (200, {"ok": True, "skipped": "off"})])
    with mock.patch.object(P, "BATCH", 1):
        rc, out = _post(tmp_path, [PQM, PQM | {"consult_uid": "pqm_b1b2c3d4e5f6a7b8c9d0e1"}], lambda u, t, b: next(answers))
    assert rc == 3
    o = json.loads(out)
    assert o["conflict"] == 1 and o["server_skipped"] == "off"
    # no conflict before the skip: rc 0
    answers = iter([(200, {"ok": True, "inserted": 1, "duplicate": 0, "conflict": 0}), (200, {"ok": True, "skipped": "off"})])
    with mock.patch.object(P, "BATCH", 1):
        rc, out = _post(tmp_path, [PQM, PQM | {"consult_uid": "pqm_b1b2c3d4e5f6a7b8c9d0e1"}], lambda u, t, b: next(answers))
    assert rc == 0 and json.loads(out)["conflict"] == 0


def test_dry_run_counts_refusals_per_reason_and_prints_no_value(tmp_path):
    secret_name = "ramesh_9845"
    rows = [
        PQM,
        PQM | {"consult_uid": "enc_ramesh"},                                   # source_key
        PQM | {"consult_uid": "enc_ramesh9845"},                               # source_key
        PQM | {"room_id": "room_ramesh"},                                      # room_id
        PQM | {"pqm_step_uid": "abcdefghijklmnopqrstuvwx"},                    # attrs_ids.pqm_step_uid
        PQM | {"pqm_step_uid": secret_name},                                   # attrs_ids.pqm_step_uid
        PQM | {"close_reason": "patient said chest pain"},                     # close_reason
        PQM | {"quality": "x"},                                                # quality
    ]
    f = write(tmp_path, rows)
    rc, out = run(["--kind", "pqm", "--file", f])
    assert rc == 0
    o = json.loads(out)
    assert o["refused_by_reason"] == {"source_key": 2, "room_id": 1, "attrs_ids.pqm_step_uid": 2, "close_reason": 1, "quality": 1}
    assert o["refused"] == 7 and o["signals"] == 1 and sum(o["refused_by_reason"].values()) == o["refused"]
    for leak in ("ramesh", "room_ra", "room_ab", "abcdefghijkl", "chest", "enc_", "9845"):
        assert leak not in out, leak


def test_the_digit_guard_is_its_own_reason_and_a_real_id_is_never_dropped_silently(tmp_path):
    guarded = "a" * 8 + "1234567" + "b" * 8                                   # 23 chars of [a-z0-9] with a 7-digit run: a base36 Pulse uid that happens to hold one
    f = write(tmp_path, [CUT | {"consult_uid": guarded}, CUT | {"consult_uid": "uid_with_underscore_xxxx"}])
    _, counts = P.build(f, "cutter", "o")
    assert counts["signals"] == 0 and counts["refused"] == 2
    assert counts["refused_by_reason"] == {"source_key": 1, "source_key.digit_run": 1}


def test_an_unlisted_ids_key_is_counted_without_its_name(tmp_path):
    row = PQM | {"pqm_step_uid": "a1b2c3d4e5f6a7b8c9d0"}
    sig = P.from_pqm(row, "o")
    sig["attrs"]["ids"]["ramesh_key"] = "x"
    with pytest.raises(P.Refused) as e:
        P.check_signal(sig)
    assert e.value.reason == "attrs_ids.unknown_key" and "ramesh" not in e.value.reason


NEMO = dict(window_id="bw_abcd2345_1790000000000_primary", room_day_id="rd_abcd2345", status="ok", audio_ms=900000, turns_json=[[0, 1000, "spk0"]])


def test_nemotron_window_poster_maps_a_window_row(tmp_path):
    f = write(tmp_path, [NEMO, NEMO | {"audio_ms": 600000}, NEMO | {"window_id": "bw_abcd2345_1790000900000_backup", "status": "empty", "start_ms": 1790000900000},
                         NEMO | {"window_id": "bw_abcd2345_1790001800000_primary", "status": "failed", "audio_ms": 5000},
                         NEMO | {"window_id": "bw_abcd2345_1790002700000_primary", "audio_ms": 0}, NEMO | {"window_id": None}])
    sigs, counts = P.build(f, "nemotron_window", "o")
    assert counts["signals"] == 2 and counts["skipped"] == 3 and counts["refused"] == 0   # latest row per window; failed / no-audio / no id skipped
    s = {x["source_key"]: x for x in sigs}["bw_abcd2345_1790000000000_primary"]
    assert s["proxy"] == "nemotron_window" and s["room_id"] is None
    assert s["t_open"] == "2026-09-21T14:13:20.000Z" and s["t_close"] == "2026-09-21T14:23:20.000Z"      # audio_ms of the LATEST row (600 s)
    assert s["attrs"] == {"ids": {"window_id": "bw_abcd2345_1790000000000_primary"}}
    assert "turns_json" not in json.dumps(s) and "rd_abcd2345" not in json.dumps(s)


def test_nemotron_window_dry_run_is_default_and_screens_apply(tmp_path):
    f = write(tmp_path, [NEMO, NEMO | {"window_id": "ramesh_9845", "start_ms": 1790000000000}])
    with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        rc, out = run(["--kind", "nemotron_window", "--file", f])
    o = json.loads(out)
    assert rc == 0 and o["mode"] == "dry-run" and o["signals"] == 1 and o["refused_by_reason"] == {"source_key": 1}
    assert "bw_" not in out and "ramesh" not in out
