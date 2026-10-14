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


def test_spoken_values_stay_whole():
    assert floors.spoken_values("two point five and five hundred") == {Decimal("2.5"), Decimal("500")}
    assert floors.spoken_values("take half a tablet") == {Decimal("0.5")}
    assert floors.spoken_values("one and a half tablets") == {Decimal("1.5")}
    assert floors.spoken_values("one point five") == {Decimal("1.5")}
    assert floors.spoken_values("twenty one") == {Decimal(21)}
    assert floors.spoken_values("one hundred") == {Decimal(100)}
    assert floors.spoken_values("one gram, two times a day") == {Decimal(1), Decimal(2)}


@pytest.mark.parametrize("said", ["a hundred percent", "at this point two", "which one", "the white one", "take this one",
                                  "which one? the white one, at night, zero side effects", "a hundred percent sure",
                                  "this one, half in the morning", "zero side effects", "nil"])
def test_bare_quantity_words_outside_quantity_context_are_not_heard(said):
    assert floors.spoken_values(said) <= {Decimal(2)}  # "at this point two": the two is a number, the point is not


def _inv(strength=None, frequency=None, duration=None):
    art = _syn("Medication: Paracetamol", [_prov("Paracetamol")])
    m = {"name": "Paracetamol", **{k: v for k, v in (("strength", strength), ("frequency", frequency), ("duration", duration)) if v}}
    return lambda said: floors._invented_core({"medicines": [m]}, art, _consult(said))


@pytest.mark.parametrize("field,value,said,count", [
    ("strength", "5 mg", "take half a tablet", 1), ("duration", "5 days", "one and a half tablets", 1),
    ("frequency", "1-0-1", "this one, half in the morning", 3), ("strength", "1 g", "take this one", 1),
    ("frequency", "0-0-1", "which one? the white one, at night, zero side effects", 3),
    ("strength", "100 mg", "a hundred percent sure", 1), ("strength", "0.2 mg", "at this point two of them", 2),
    ("strength", "1 g", "take one gram", 0), ("strength", "5 mg", "take 0.5 mg", 0), ("strength", "0.5 mg", "half a tablet", 0),
    ("strength", "1.5 mg", "one and a half mg", 0), ("strength", "500 mg", "five hundred milligram", 0),
    ("strength", "5 mg", "five hundred milligram", 1), ("strength", "2.5 mg", "two point five milligram", 0),
])
def test_floor_cases(field, value, said, count):
    assert _inv(**{field: value})(said)["count"] == count, (value, said)


def test_d3_digits_only_in_a_non_medicine_part_stay_eta():
    c = _consult("hello")
    rx = {"medicines": [{**CAT, "strength": "500 mg"}]}
    for note in ("Plan of Management: tablet 500 mg SOS for fever\nMedication: Paracetamol twice a day",
                 "Follow up: review in 500 days\nMedication: Paracetamol twice a day"):
        art = _syn(note, [_prov("Paracetamol")])
        assert floors._invented_core(rx, art, c, "global")["sources"] == ["eta"]
        assert floors._invented_core(rx, art, c, "medicine")["sources"] == ["eta"]
    fu = {"kind": "follow_up", "text": "review after 5 days", "evidence": []}
    art = _syn("Medication: Paracetamol twice a day", [_prov("Paracetamol")], [fu])
    rxd = {"medicines": [{**CAT, "duration": "5 days"}]}
    assert floors._invented_core(rxd, art, c, "medicine")["sources"] == ["eta"]
    # another medicine's gp_extraction entry still does not count for this one
    art2 = _two()
    art2["gp_extraction"] = {"medicines": [{"name": "Amoxicillin 500 mg"}]}
    assert floors._invented_core({"medicines": [{**CAT, "strength": "500 mg"}]}, art2, c, "medicine")["sources"] == ["pulse_catalogue"]


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
