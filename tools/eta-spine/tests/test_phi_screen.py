"""The Python PHI screens against the same fixture file the TS tests read (tests/fixtures/spine-phi-cases.json)."""
import json, os, re, sys
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import post_signals as P

F = json.load(open(os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "spine-phi-cases.json"), encoding="utf-8"))


def nest(n, leaf):
    return leaf if n == 0 else [nest(n - 1, leaf)]


FILL = {"{MS13}": "17" + "0" * 11, "{P16}": "1" + "0" * 15, "{PHONE10}": "9" * 10, "{PLUS_PHONE}": "+91" + "9" * 10, "{DIG7}": "1234567", "{DIG8}": "20260101", "{DIG9}": "123456789"}


def fill(v):
    """Digit runs are built here, never written in the fixture (same as tests/unit/spine-phi.test.ts)."""
    t = json.dumps(v)
    for k, x in FILL.items():
        t = t.replace(k, x)
    return json.loads(t)


def sig(proxy, attrs):
    return {"proxy": proxy, "source_key": F["good_source_key"].get(proxy, "x"), "t_open": "2026-10-18T04:00:00Z", "observed_at": "2026-10-18T04:20:00Z", "attrs": attrs}


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
    good = {"consult_uid": "uidtestaaaaaaaaaaaaaaaaa", "t_open": 1790000000, "close_reason": "pqm", "quality": "pqm"}
    bad = {"consult_uid": "uidtestbbbbbbbbbbbbbbbbb", "t_open": 1790000000, "close_reason": "patient said chest pain"}
    f = tmp_path / "w.jsonl"
    f.write_text(json.dumps(good) + "\n" + json.dumps(bad) + "\n")
    sigs, counts = P.build(str(f), "pqm", "2026-10-18T00:00:00Z")
    assert counts["signals"] == 1 and counts["refused"] == 1 and sigs[0]["source_key"] == "uidtestaaaaaaaaaaaaaaaaa"


def test_post_with_a_refused_row_exits_0_and_reports_it(tmp_path, capsys):
    from unittest import mock
    f = tmp_path / "w.jsonl"
    f.write_text(json.dumps({"consult_uid": "uidtestaaaaaaaaaaaaaaaaa", "t_open": 1790000000}) + "\n" + json.dumps({"consult_uid": "uidtestbbbbbbbbbbbbbbbbb", "t_open": 1790000000, "quality": "Ravi Kumar"}) + "\n")
    tok = tmp_path / "tok"
    tok.write_text("t\n")
    os.chmod(tok, 0o600)
    sent = []
    with mock.patch.object(P, "post_batch", lambda u, t, b: (sent.append(len(b)) or (200, {"inserted": 1, "duplicate": 0}))):
        assert P.main(["--kind", "pqm", "--file", str(f), "--post", "--url", "https://x.test/x", "--token-file", str(tok)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert sent == [1] and out["refused"] == 1 and out["inserted"] == 1


def verdict(s):
    try:
        P.check_signal(s)
        return "ok"
    except P.Refused as e:
        return str(e)


def reason(s):
    try:
        P.check_signal(s)
        return None
    except P.Refused as e:
        return e.reason


def test_rules_json_and_fixture_agree():
    keys = set(F["formats_accept"])
    assert P.ID_KEYS | {"room_id"} == keys == set(P.FORMATS) == set(F["formats_refuse"])
    for proxy, k in P.SOURCE_KEY_FORMAT.items():
        assert k in keys, proxy


def test_every_producer_format_accepted_as_ids_value():
    for k, vals in F["formats_accept"].items():
        for v in fill(vals):
            assert P.FORMATS[k].fullmatch(v), (k, v)
            if k in P.ID_KEYS:
                P.check_signal(sig("pqm", {"ids": {k: v}}))
            else:
                P.check_signal(dict(sig("pqm", {}), room_id=v))


def test_name_digits_phone_and_malformed_refused_by_every_key():
    for k in P.ID_KEYS:
        common = fill(F["formats_refuse_common"])
        for v in common + fill(F["formats_refuse"][k]):
            assert not P.FORMATS[k].fullmatch(v), (k, v)
            assert verdict(sig("pqm", {"ids": {k: v}})) == "attrs_ids", (k, v)


def test_anchored_a_stray_character_before_or_after_a_good_value_is_refused():
    for k, vals in F["formats_accept"].items():
        for v in fill(vals):
            for w in ("!" + v, v + "!", v + "\x00"):
                assert not P.FORMATS[k].fullmatch(w), (k, w)


def test_no_cross_key_use():
    for k in P.ID_KEYS:
        for o, vals in F["formats_accept"].items():
            if o == k:
                continue
            for v in fill(vals):
                if P.FORMATS[k].fullmatch(v):
                    continue
                assert verdict(sig("pqm", {"ids": {k: v}})) == "attrs_ids", (k, o)


def test_room_id_and_source_key_use_the_same_formats():
    for v in fill(F["formats_refuse_common"]):
        assert verdict(dict(sig("pqm", {}), room_id=v)) in ("room_id",) or v == "", (v,)
        assert verdict(dict(sig("pqm", {}), source_key=v)) == "source_key", (v,)


def test_ported_key_verdicts_equal_ts():
    for n, k in F["keys"].items():
        try:
            P.refuse_keys({k: 1})
            got = None
        except P.Refused as e:
            got = str(e)
        assert got == F["key_verdicts"][n], n


def test_ported_value_cases_equal_ts_on_all_cases():
    for c in F["value_cases"]:
        assert verdict(fill(c["signal"])) == c["expect"], c["label"]


def test_ported_value_cases_carry_the_same_reason_code_as_ts():
    for c in F["value_cases"]:
        if "reason" in c:
            assert reason(fill(c["signal"])) == c["reason"], c["label"]
