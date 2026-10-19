"""The Python PHI screens against the same fixture file the TS tests read (tests/fixtures/spine-phi-cases.json)."""
import json, os, sys
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import post_signals as P

F = json.load(open(os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "spine-phi-cases.json"), encoding="utf-8"))


def nest(n, leaf):
    return leaf if n == 0 else [nest(n - 1, leaf)]


def sig(proxy, attrs):
    return {"proxy": proxy, "source_key": "k_test_01", "t_open": "2026-10-18T04:00:00Z", "observed_at": "2026-10-18T04:20:00Z", "attrs": attrs}


def test_refuse_keys_fixture():
    for k in F["refuse_keys"]:
        for v in ({k: 1}, [sig("pqm", {"ids": {k: "x"}})], {"a": [{"b": {k: 1}}]}):
            with pytest.raises(P.Refused, match="text_key"):
                P.refuse_keys(v)


def test_normalisation_cases():
    assert P.norm_key("ｎａｍｅ") == "name" and P.norm_key("na​me") == "name" and P.norm_key("pa­tient") == "patient"
    assert P.norm_key("nаme") == "name" and P.norm_key("patıent") == "patient"


def test_ok_keys():
    for k in F["ok_keys"]:
        P.refuse_keys({k: 1})


def test_depth_cases():
    for c in F["deep"]:
        v = nest(c["nest"], c["leaf"])
        if c["expect"] is None:
            P.refuse_keys(v)
        else:
            with pytest.raises(P.Refused, match=c["expect"]):
                P.refuse_keys(v)


def test_enums_and_id_keys_equal_the_fixture():
    for proxy, e in P.ENUMS.items():
        assert e["close_reason"] == set(F["enums"][proxy]["close_reason"]), proxy
        assert e["quality"] == set(F["enums"][proxy]["quality"]), proxy
    assert P.ID_KEYS == set(F["id_keys"])


def test_every_enum_value_accepted():
    for proxy in P.ENUMS:
        for v in F["enums"][proxy]["close_reason"]:
            P.check_signal(sig(proxy, {"close_reason": v}))
        for v in F["enums"][proxy]["quality"]:
            P.check_signal(sig(proxy, {"quality": v}))


def test_fixture_signals_same_verdict_as_ts():
    for c in F["signals"]:
        if c["expect"] == "ok":
            P.check_signal(c["signal"])
        else:
            with pytest.raises(P.Refused):
                P.check_signal(c["signal"])


def test_a_bad_row_is_skipped_and_counted_not_fatal(tmp_path):
    good = {"consult_uid": "uid_test_01", "t_open": 1790000000, "close_reason": "pqm", "quality": "pqm"}
    bad = {"consult_uid": "uid_test_02", "t_open": 1790000000, "close_reason": "patient said chest pain"}
    f = tmp_path / "w.jsonl"
    f.write_text(json.dumps(good) + "\n" + json.dumps(bad) + "\n")
    sigs, counts = P.build(str(f), "pqm", "2026-10-18T00:00:00Z")
    assert counts["signals"] == 1 and counts["refused"] == 1 and sigs[0]["source_key"] == "uid_test_01"


def test_post_with_a_refused_row_exits_0_and_reports_it(tmp_path, capsys):
    from unittest import mock
    f = tmp_path / "w.jsonl"
    f.write_text(json.dumps({"consult_uid": "uid_test_01", "t_open": 1790000000}) + "\n" + json.dumps({"consult_uid": "uid_test_02", "t_open": 1790000000, "quality": "Ravi Kumar"}) + "\n")
    tok = tmp_path / "tok"
    tok.write_text("t\n")
    os.chmod(tok, 0o600)
    sent = []
    with mock.patch.object(P, "post_batch", lambda u, t, b: (sent.append(len(b)) or (200, {"inserted": 1, "duplicate": 0}))):
        assert P.main(["--kind", "pqm", "--file", str(f), "--post", "--url", "https://x.test/x", "--token-file", str(tok)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert sent == [1] and out["refused"] == 1 and out["inserted"] == 1
