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


PQM = dict(consult_uid="pqm_test_01", room_id="room_test_a", t_open=T0, t_close=T0 + 600, close_reason="pqm", quality="pqm", pqm_step_uid="step_test_01")
CUT = dict(consult_uid="uid_test_01", room_id="room_test_a", span_start="2026-10-18 09:30:00.000", span_end="2026-10-18 09:40:00.500", status="cut", window_id=7)
CAA = dict(consult_uid="uid_test_02", scope_path="scope/room_test_a/x", manifest=dict(t0_ms=1790000000000, t1_ms=1790000600000))


def test_dry_run_is_default_prints_counts_only_and_makes_no_network_call(tmp_path):
    f = write(tmp_path, [PQM, "not json", PQM | {"consult_uid": None}])
    with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")), mock.patch("socket.socket", side_effect=AssertionError("socket")):
        rc, out = run(["--kind", "pqm", "--file", f])
    assert rc == 0
    assert json.loads(out) == {"mode": "dry-run", "kind": "pqm", "read": 3, "bad_lines": 1, "skipped": 1, "refused": 0, "signals": 1}
    assert "pqm_test_01" not in out and "room_test_a" not in out


def test_dry_run_never_reads_the_token(tmp_path):
    f = write(tmp_path, [PQM])
    rc, _ = run(["--kind", "pqm", "--file", f, "--token-file", str(tmp_path / "missing")])
    assert rc == 0


def test_mappers():
    p = P.from_pqm(PQM, "o")
    assert (p["proxy"], p["source_key"], p["t_open"], p["t_close"]) == ("pqm", "pqm_test_01", "2026-09-21T14:13:20.000Z", "2026-09-21T14:23:20.000Z")
    assert p["attrs"] == {"ids": {"consult_uid": "pqm_test_01", "pqm_step_uid": "step_test_01"}, "quality": "pqm", "close_reason": "pqm"}
    c = P.from_cutter(CUT, "o")
    assert (c["t_open"], c["t_close"]) == ("2026-10-18T04:00:00.000Z", "2026-10-18T04:10:00.500Z")   # IST -> UTC
    a = P.from_caa(CAA, "o")
    assert (a["room_id"], a["t_close"]) == ("room_test_a", "2026-09-21T14:23:20.000Z")
    assert P.from_caa(dict(CAA, manifest={}), "o") is None
    for s in (p, c, a):
        assert set(s) <= {"proxy", "source_key", "room_id", "t_open", "t_close", "observed_at", "attrs"} and "source_rev" not in s


def test_cutter_takes_the_latest_row_per_uid(tmp_path):
    f = write(tmp_path, [CUT, CUT | {"span_end": "2026-10-18 09:45:00.000"}, CUT | {"consult_uid": "uid_test_09"}])
    sigs, counts = P.build(f, "cutter", "o")
    assert counts["signals"] == 2
    assert [s["t_close"] for s in sigs if s["source_key"] == "uid_test_01"] == ["2026-10-18T04:15:00.000Z"]


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
    f = write(tmp_path, [PQM, PQM | {"consult_uid": "pqm_test_02"}])
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
