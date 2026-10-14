"""Floor scope and number words (14 Oct 2026). Synthetic only."""
from __future__ import annotations

from decimal import Decimal

import pytest
from conftest import mk_consult
from test_pdqi9_attribution import CAT, _syn
from test_pdqi9_harness import RX, floors_row  # noqa: F401

from tools.eta2freescript.eval.pdqi9 import floors

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n: int, with_and: bool = False) -> str:
    """English words for 0..9999 (test-side generator; the property is that parse_number_words reads them back)."""
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + (f" {ONES[n % 10]}" if n % 10 else "")
    if n < 1000:
        rest = n % 100
        return f"{ONES[n // 100]} hundred" + ((" and " if with_and else " ") + words(rest) if rest else "")
    rest = n % 1000
    return f"{words(n // 1000)} thousand" + ((" and " if with_and else " ") + words(rest, with_and) if rest else "")


def test_every_integer_0_to_9999_and_every_n_point_5_parses_back():
    for n in range(10000):
        for w in {words(n), words(n, True)}:
            assert floors.parse_number_words(w) == [Decimal(n)], (n, w)
        assert floors.parse_number_words(f"{words(n)} and a half") == [Decimal(n) + Decimal("0.5")], n
        assert floors.parse_number_words(f"{words(n)} point five") == [Decimal(f"{n}.5")], n


@pytest.mark.parametrize("text,want", [
    ("five hundred milligram", ["500"]), ("5 hundred", ["500"]), ("two thousand and fifty", ["2050"]), ("one thousand", ["1000"]),
    ("thousand", ["1000"]), ("hundred", ["100"]), ("half a tablet", ["0.5"]), ("one and a half", ["1.5"]), ("one and half", ["1.5"]),
    ("two point five", ["2.5"]), ("point five", ["0.5"]), ("zero point two five", ["0.25"]), ("twenty five", ["25"]),
    ("one two three", ["1", "2", "3"]), ("twenty-five", ["25"]), ("take ten then fifteen", ["10", "15"]),
    ("sixty five hundred", ["6500"]), ("a hundred and one", ["101"]), ("nothing here", []),
])
def test_table(text, want):
    assert floors.parse_number_words(text) == [Decimal(w) for w in want]


def test_spoken_runs_are_digit_runs():
    assert floors.spoken_runs("two point five and five hundred") == {"2", "5", "500"}


def _consult(said):
    return mk_consult([(0, 3, "S0", said)])


def _prov(name, quote=""):
    return {"text": name, "names": [name], "evidence": [{"segment_ref": "x:0", "quote": quote}]}


def test_number_words_in_the_transcript_make_the_strength_not_invented():
    art = _syn("Medication: Paracetamol", [_prov("Paracetamol")])
    rx = {"medicines": [{"name": "Paracetamol", "strength": "500 mg"}]}
    assert floors._invented_core(rx, art, _consult("take five hundred milligram"))["count"] == 0
    assert floors._invented_core(rx, art, _consult("take six hundred milligram"))["count"] == 1
    assert floors._invented_core(rx, art, _consult("take 5 hundred milligram"))["count"] == 0
    assert floors._invented_core({"medicines": [{"name": "Paracetamol", "strength": "2.5 mg"}]}, art, _consult("two point five"))["count"] == 0


def test_scope_setting_default_global_and_typos_raise(monkeypatch):
    monkeypatch.delenv("FREESCRIPT_FLOOR_SCOPE", raising=False)
    assert floors.floor_scope() == "global"
    monkeypatch.setenv("FREESCRIPT_FLOOR_SCOPE", "")
    assert floors.floor_scope() == "global"
    monkeypatch.setenv("FREESCRIPT_FLOOR_SCOPE", "medicine")
    assert floors.floor_scope() == "medicine"
    for bad in ("Medicine", "med", " global"):
        monkeypatch.setenv("FREESCRIPT_FLOOR_SCOPE", bad)
        with pytest.raises(ValueError):
            floors.floor_scope()


CAT_AMOX = {"uid": "c2", "name": "Amoxicillin", "generic": "amoxicillin", "other": False}
NOTE_TWO = "Medication:\nParacetamol 650 mg twice a day\nAmoxicillin 500 mg three times a day"


def _two(note=NOTE_TWO):
    return _syn(note, [_prov("Paracetamol"), _prov("Amoxicillin")])


def test_global_mode_is_todays_rule_and_medicine_mode_reads_the_same_medicine_only():
    c = _consult("hello")
    rx = {"medicines": [{**CAT, "strength": "500 mg"}]}  # paracetamol 500: digits only in the AMOXICILLIN line
    art = _two()
    assert floors._invented_core(rx, art, c, "global")["sources"] == ["eta"]
    assert floors._invented_core(rx, art, c, "medicine")["sources"] == ["pulse_catalogue"]
    # the same digits on the same medicine's line: eta in both modes
    same = _two(NOTE_TWO.replace("Paracetamol 650 mg", "Paracetamol 500 mg"))
    for mode in ("global", "medicine"):
        assert floors._invented_core(rx, same, c, mode)["sources"] == ["eta"]
    # frequency digits are scoped the same way
    rxf = {"medicines": [{**CAT, "strength": "650 mg", "frequency": "3 times a day"}]}
    assert floors._invented_core(rxf, art, c, "global")["sources"] == ["eta", "eta"]
    assert floors._invented_core(rxf, art, c, "medicine")["sources"] == ["eta", "pulse_extraction"]


def test_ambiguous_or_missing_pairing_uses_todays_rule():
    c = _consult("hello")
    rx = {"medicines": [{**CAT, "strength": "500 mg"}]}
    two_lines = _two("Medication:\nParacetamol 650 mg twice a day\nParacetamol later 1 g\nAmoxicillin 500 mg three times a day")
    assert floors._invented_core(rx, two_lines, c, "medicine")["sources"] == ["eta"]
    no_line = _syn("Medication:\nAmoxicillin 500 mg three times a day", [_prov("Amoxicillin")])
    assert floors._invented_core(rx, no_line, c, "medicine")["sources"] == ["eta"]


def test_gp_entry_and_provenance_quote_belong_to_the_medicine():
    c = _consult("hello")
    rx = {"medicines": [{**CAT, "strength": "500 mg"}]}
    art = _two()
    art["gp_extraction"] = {"medicines": [{"name": "Paracetamol 500 mg"}]}
    assert floors._invented_core(rx, art, c, "medicine")["sources"] == ["eta"]
    art2 = _syn(NOTE_TWO, [_prov("Paracetamol", "five hundred, 500"), _prov("Amoxicillin")])
    assert floors._invented_core(rx, art2, c, "medicine")["sources"] == ["eta"]


def test_judge_invented_field_is_scoped_too():
    rx = {"medicines": [{**CAT, "strength": "500 mg"}]}
    its = floors.numbered_items(rx)
    row = {"n": 1, "said": "yes", "leak": False, "invented": ["strength"], "dose_precedence_error": False, "turns": []}
    art = _two()
    assert floors._judge_attribution([row], its, art, "global")["invented_fields"] == floors._tally(["eta"])
    assert floors._judge_attribution([row], its, art, "medicine")["invented_fields"] == floors._tally(["pulse_catalogue"])


def test_header_and_table_carry_floor_scope(monkeypatch):
    monkeypatch.delenv("FREESCRIPT_FLOOR_SCOPE", raising=False)
    bn, b0 = [floors_row()], [floors_row()]
    assert floors.aggregate(bn, b0)["header"]["floor_scope"] == "global"
    t = floors.aggregate(bn, b0, "eta", "medicine")
    assert t["scope"] == "medicine" and t["header"]["floor_scope"] == "medicine" and t["header"]["floor_basis"] == "eta"
    with pytest.raises(ValueError):
        floors.aggregate(bn, b0, "eta", "bogus")
