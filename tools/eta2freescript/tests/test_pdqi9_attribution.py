"""Floor attribution (14 Oct 2026): every floor hit has a source; measurement artefacts are marked, never silently dropped. Synthetic only."""
from __future__ import annotations

import json

import pytest
from conftest import CONSULTS, build_artifact, stage_a
from test_pdqi9_harness import (RX, UIDS, _FakeJev, _argv, _lockbox_rule, _write_inputs, floors_row, frozen, fever, item, make_frozen, responder)  # noqa: F401

from tools.eta2freescript.eval.pdqi9 import floors, jev_lines, run, scoreboard
from tools.eta2freescript.models import FakeClient

CAT = {"uid": "cat-1", "name": "Paracetamol", "brand_name": "Dolo", "generic": "paracetamol", "other": False}


def test_catalogue_strength_not_in_the_note_is_pulse_catalogue(fever):
    c, art = fever
    r = floors._invented_core({"medicines": [{**CAT, "strength": "500 mg", "frequency": "three times a day"}]}, art, c)
    assert r["count"] == 1 and r["sources"] == ["pulse_catalogue"]


def test_strength_in_eta_note_or_on_a_non_catalogue_row_is_eta(fever):
    c, art = fever
    note500 = {**art, "note_text": art["note_text"].replace("paracetamol 1 g", "paracetamol 500 mg")}
    assert floors._invented_core({"medicines": [{**CAT, "strength": "500 mg"}]}, note500, c)["sources"] == ["eta"]
    free = {"name": "Paracetamol", "strength": "500 mg", "other": True}
    assert floors._invented_core({"medicines": [free]}, art, c)["sources"] == ["eta"]


def test_dose_precedence_sources(fever):
    _, art = fever
    assert floors.dose_precedence_sources({"medicines": [{**CAT, "strength": "650 mg"}]}, art) == ["pulse_catalogue"]
    # a doctor strength in the note that the rx does not carry, or a non-catalogue rx strength, stays with ETA
    assert floors.dose_precedence_sources({"medicines": [{"name": "Paracetamol", "strength": "650 mg", "other": True}]}, art) == ["eta"]
    assert floors.dose_precedence_sources({"medicines": []}, art) == ["eta"]
    assert floors.dose_precedence_sources({"medicines": [{**CAT, "strength": "1 g"}]}, art) == []
    assert floors.dose_precedence({"medicines": [{**CAT, "strength": "650 mg"}]}, art) == 1


def test_frequency_and_duration_digits_are_pulse_extraction_unless_eta_wrote_them(fever):
    c, art = fever
    rx = {"medicines": [{**CAT, "strength": "1 g", "frequency": "7 times a day", "duration": "three days"}]}
    assert floors._invented_core(rx, art, c)["sources"] == ["pulse_extraction"]
    note7 = {**art, "note_text": art["note_text"].replace("three times a day", "7 times a day")}
    assert floors._invented_core(rx, note7, c)["sources"] == ["eta"]


def test_unmatched_digitless_medicine_is_not_a_hit_and_is_counted(fever):
    c, art = fever
    r = floors._invented_core({"medicines": [{"name": "Zorbex", "frequency": "twice a day"}]}, art, c)
    assert r["count"] == 0 and r["unmatched_no_digits"] == 1 and r["sources"] == []
    r = floors._invented_core({"medicines": [{"name": "Zorbex", "strength": "10 mg"}]}, art, c)
    assert r["count"] == 1 and r["unmatched_medicines"] == 1 and r["unmatched_no_digits"] == 0


def test_printable_pulse_symptoms_question_mark_is_pulse_extraction(fever):
    _, art = fever
    pa = floors.printable_attribution({"symptoms": "?"}, art)
    assert pa["raw"] == floors.printable_count({"symptoms": "?"}, art) >= 1
    assert pa["sources"]["pulse_extraction"] >= 1 and pa["sources"]["eta"] == 0 and pa["sources"]["pulse_catalogue"] == 0
    bad = {**art, "note_text": art["note_text"] + "\nPlan of Management: tbd {{x}}"}
    assert floors.printable_attribution({}, bad)["sources"]["eta"] >= 2


def test_printable_duplicates_are_marked_check_not_dropped(fever):
    _, art = fever
    rx = {"general_advice": ["[doctor to verify] dose"]}
    pa = floors.printable_attribution(rx, art)
    assert pa["raw"] == floors.printable_count(rx, art)
    assert pa["check"] >= 1 and pa["dedup"] == pa["raw"] - pa["check"] and sum(pa["sources"].values()) == pa["raw"]


def test_printable_catalogue_line_error_survives_blanking_extraction_fields():
    rx = {"medicines": [{**CAT, "strength": "5 mg", "instructions": "tbd"}]}
    assert floors.printable_attribution(rx, None)["sources"]["pulse_extraction"] >= 1
    rx = {"medicines": [{**CAT, "name": "Paracetamol [x]", "strength": "5 mg"}]}
    assert floors.printable_attribution(rx, None)["sources"]["pulse_catalogue"] >= 1


def test_judge_floors_are_attributed(frozen, tmp_path, fever):
    _, art = fever
    rx = {"medicines": [{**CAT, "strength": "500 mg"}, {"name": "Zorbex", "other": True}], "diagnoses": [{"name": "Cough"}]}
    its = floors.numbered_items(rx)
    rows = [item(1, invented=["strength"], dose_precedence_error=True), item(2, said="no"), item(3)]
    out: dict = {}
    r = floors.judge_items(FakeClient(lambda *a: json.dumps({"items": rows})), frozen, its, "T0 hi", tmp_path / "a", "u", "Bn", None, art, out)
    assert r["invented_fields"] == 1 and r["unsupported_drugs"] == 1 and r["dose_precedence_errors"] == 1
    assert out["invented_fields"]["pulse_catalogue"] == 1 and out["dose_precedence_errors"]["pulse_catalogue"] == 1
    assert out["unsupported_drugs"]["pulse_extraction"] == 1


def _agg(basis, **kw):
    row = floors_row(invented_numbers=3, attribution={"invented_numbers": {"eta": 0, "pulse_catalogue": 3, "pulse_extraction": 0, "check": 0}}, **kw)
    return floors.aggregate([row], [floors_row()], basis)


def test_basis_switch_changes_only_pass_and_stamp():
    a, e = _agg("all"), _agg("eta")
    assert a["basis"] == "all" and e["basis"] == "eta"
    ra = next(t for t in a["rows"] if t["floor"].startswith("invented numbers"))
    re_ = next(t for t in e["rows"] if t["floor"].startswith("invented numbers"))
    assert ra["pass"] is False and re_["pass"] is True and ra["bn"] == re_["bn"] == 3 and re_["pulse_catalogue"] == 3
    strip = lambda t: [{k: v for k, v in r.items() if k not in ("pass", "basis_value")} for r in t["rows"]]
    assert strip(a) == strip(e) and a["all_pass"] is False and e["all_pass"] is True


def test_basis_env_default_all_and_a_typo_raises(monkeypatch):
    monkeypatch.delenv("FREESCRIPT_FLOOR_BASIS", raising=False)
    assert floors.floor_basis() == "all"
    monkeypatch.setenv("FREESCRIPT_FLOOR_BASIS", "eta")
    assert floors.floor_basis() == "eta"
    monkeypatch.setenv("FREESCRIPT_FLOOR_BASIS", "ETA ")
    with pytest.raises(ValueError):
        floors.floor_basis()


def test_rows_without_attribution_count_as_eta():
    t = floors.aggregate([floors_row(invented_numbers=2)], [floors_row()], "eta")
    r = next(x for x in t["rows"] if x["floor"].startswith("invented numbers"))
    assert r["eta"] == 2 and r["pass"] is False


def test_jev_skips_bare_headings_and_counts_them():
    fj = _FakeJev()
    note = "Co-morbidities:\nPlan of Management: rest\nSurgery or Procedure:\nMedication: x\nFollow up:\nsome body line\nRefer to:"
    r = jev_lines.check_lines(note, "t", client=fj)
    assert list(fj.args[0]["state"]["lines"]) == ["L2", "L4", "L5", "L6"]  # a heading with an un-headed body line below it is kept
    assert r["lines"] == 4 and r["jev_skipped_empty_headings"] == 3


def test_end_to_end_basis_all_totals_equal_the_sum_of_sources_and_stamp(tmp_path, monkeypatch):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    monkeypatch.delenv("FREESCRIPT_FLOOR_BASIS", raising=False)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:2])
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=FakeClient(responder)) == 0
    row = json.loads((tmp_path / "SCOREBOARD.R1.json").read_text())
    assert row["floor_basis"] == "all" and row["floors"]["basis"] == "all"
    for t in row["floors"]["rows"]:
        if "eta" in t:
            assert t["bn"] == sum(t[k] for k in floors.SOURCES), t["floor"]
    md = (tmp_path / "SCOREBOARD.md").read_text()
    assert "floor basis" in md.splitlines()[0] and "[eta " in md and "| all |" in md
    assert "jev_skipped_empty_headings" in row["jev"]
