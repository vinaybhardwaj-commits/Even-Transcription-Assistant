"""Floor attribution (14 Oct 2026): every floor hit has a source; measurement artefacts are marked, never silently dropped. Synthetic only."""
from __future__ import annotations

import json
import re

import pytest
from conftest import CONSULTS, build_artifact, stage_a
from test_pdqi9_harness import (RX, UIDS, _FakeJev, _argv, _lockbox_rule, _write_inputs, floors_row, frozen, fever, item, make_frozen, responder)  # noqa: F401

from tools.eta2freescript.eval.pdqi9 import floors, jev_lines, run, scoreboard
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient

CAT = {"uid": "cat-1", "name": "Paracetamol", "brand_name": "Dolo", "generic": "paracetamol", "other": False}


def test_catalogue_strength_not_in_the_note_is_pulse_catalogue(fever):
    c, art = fever
    r = floors._invented_core({"medicines": [{**CAT, "strength": "500 mg", "frequency": "three times a day"}]}, art, c)
    assert r["count"] == 1 and r["sources"] == ["pulse_catalogue"]





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


def test_printable_finding_on_an_entity_resolved_medicine_line_is_pulse_catalogue():
    rx = {"medicines": [{**CAT, "strength": "5 mg", "instructions": "tbd"}]}
    assert floors.printable_attribution(rx, None)["sources"]["pulse_catalogue"] >= 1
    assert floors.printable_attribution({"general_advice": ["tbd?"]}, None)["sources"]["pulse_extraction"] >= 1
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


def test_basis_env_default_eta_and_a_typo_raises(monkeypatch):
    monkeypatch.delenv("FREESCRIPT_FLOOR_BASIS", raising=False)
    assert floors.floor_basis() == "eta"
    monkeypatch.setenv("FREESCRIPT_FLOOR_BASIS", "")
    assert floors.floor_basis() == "eta"
    monkeypatch.setenv("FREESCRIPT_FLOOR_BASIS", "all")
    assert floors.floor_basis() == "all"
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
    monkeypatch.setenv("FREESCRIPT_FLOOR_BASIS", "all")
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:2])
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=FakeClient(responder)) == 0
    row = json.loads((tmp_path / "SCOREBOARD.R1.json").read_text())
    assert row["floor_basis"] == "all" and row["floors"]["basis"] == "all"
    for t in row["floors"]["rows"]:
        if "eta" in t:
            assert t["bn"] == sum(t[k] for k in floors.SOURCES), t["floor"]
    md = (tmp_path / "SCOREBOARD.md").read_text()
    assert "floor basis" in md.splitlines()[0] and "[eta " in md and "| all [eta " in md
    h = row["floor_header"]
    assert h["floor_basis"] == "all" and h == row["floors"]["header"] and all(k in h for k in floors.SOURCES) and h["total"] == sum(h[k] for k in floors.SOURCES)
    assert "jev_skipped_empty_headings" in row["jev"]


# ---- fix round 1 (14 Oct 2026): D1-D5 ----------------------------------------------------------------------------

def _syn(note, medicine_prov=(), extra=()):
    """A minimal synthetic artifact: a note_text and medicine provenance items."""
    prov = [{"kind": "medicine", "json_pointer": f"/medicines/{i}", "evidence": [], "flags": [], **p} for i, p in enumerate(medicine_prov)]
    return {"note_text": note, "provenance": prov + list(extra), "completion_required": []}


def test_d1_distinct_lines_with_the_same_finding_are_distinct():
    for rx in ({"medicines": [{"name": "Alpha", "instructions": "after food?"}, {"name": "Beta", "instructions": "at night?"}]},
               {"general_advice": ["walk daily?", "avoid sugar?"]}):
        pa = floors.printable_attribution(rx, None)
        assert (pa["raw"], pa["dedup"], pa["check"]) == (2, 2, 0)
        assert pa["raw"] == floors.printable_count(rx, None)
    # the same finding twice on ONE line is the validator counting one bracket twice: a repeat
    pa = floors.printable_attribution({"general_advice": ["[tbd] dose"]}, None)
    assert pa["check"] == 1 and pa["dedup"] == pa["raw"] - 1
    # identical finding on two different lines: two findings
    two = floors.printable_attribution({"general_advice": ["walk daily?", "walk daily?"]}, None)
    assert (two["raw"], two["dedup"], two["check"]) == (2, 2, 0)


def test_d1_no_field_identity_means_no_dedup():
    # two bracketed lines: the whole-text checks coalesce; only the one double emission is a repeat
    pa = floors.printable_attribution({"general_advice": ["[a] x", "[b] y"]}, None)
    assert pa["check"] == 1 and pa["dedup"] == pa["raw"] - 1


def test_d2_replayed_finding_whose_text_is_in_etas_note_is_eta():
    art = _syn("Presenting Complaint: Fever (3 days). Body pain?")
    pa = floors.printable_attribution({"symptoms": "Fever (3 days). Body pain?"}, art)
    assert pa["sources"]["eta"] == 2 and pa["sources"]["pulse_extraction"] == 0 and pa["raw"] == 2
    # a rule ETA's note never trips stays Pulse's
    pa = floors.printable_attribution({"symptoms": "Cough since a week {x}"}, art)
    assert pa["sources"]["pulse_extraction"] >= 1 and pa["sources"]["eta"] == 1


def test_d3_strength_anywhere_in_etas_note_or_provenance_is_eta(fever):
    c, _ = fever
    cat = {"uid": "c1", "name": "Paracetamol", "brand_name": "Dolo", "generic": "paracetamol", "other": False, "strength": "650 mg"}
    # (a) ETA calls the drug PCM; the catalogue row has another name
    a = _syn("Medication: PCM 650 mg twice a day", [{"text": "PCM", "names": ["PCM"]}])
    assert floors._invented_core({"medicines": [cat]}, a, c)["sources"] == ["eta"]
    # (b) the catalogue row is a brand with no generic; ETA wrote the generic
    cal = {"uid": "c2", "name": "Calpol 650 mg", "brand_name": "Calpol", "other": False, "strength": "650 mg"}
    b = _syn("Medication: paracetamol 650 mg twice a day")
    assert floors._invented_core({"medicines": [cal]}, b, c)["sources"] == ["eta"]
    # judge side, same rule
    rx = {"medicines": [cat]}
    its = floors.numbered_items(rx)
    assert floors._judge_attribution([item(1, invented=["strength"], dose_precedence_error=True)], its, a) == {
        "unsupported_drugs": floors._tally([]), "invented_fields": floors._tally(["eta"]), "dose_precedence_errors": floors._tally(["eta"])}
    # a strength ETA never wrote is still the catalogue's
    other = _syn("Medication: PCM 500 mg twice a day", [{"text": "PCM", "names": ["PCM"]}])
    assert floors._invented_core({"medicines": [cat]}, other, c)["sources"] == ["pulse_catalogue"]


def test_d3_dose_precedence_det_uses_the_same_rule():
    doc = {"kind": "medicine", "text": "Dolo", "names": ["Dolo"], "flags": ["doctor_dose_precedence"],
           "evidence": [{"speaker": "doctor", "quote": "Dolo 500 mg"}]}
    art = _syn("Medication: Dolo 500 mg; patient took 650 mg at home", [doc])
    cat = {"uid": "c1", "name": "Dolo", "other": False, "strength": "650 mg"}
    assert floors.dose_precedence_sources({"medicines": [cat]}, art) == ["eta"]       # 650 is in ETA's note
    art2 = _syn("Medication: Dolo 500 mg", [doc])
    assert floors.dose_precedence_sources({"medicines": [cat]}, art2) == ["pulse_catalogue"]


def test_d5_structured_provenance_strength_is_etas(fever):
    c, _ = fever
    art = _syn("Medication: Dolo twice a day", [{"text": "Dolo - twice a day", "names": ["Dolo"], "medicine": {"strength": {"text": "750 mg"}}}])
    rx = {"medicines": [{"uid": "c1", "name": "Dolo", "other": False, "strength": "750 mg"}]}
    assert floors._invented_core(rx, art, c)["sources"] == ["eta"]
    bare = _syn("Medication: Dolo twice a day", [{"text": "Dolo - twice a day", "names": ["Dolo"]}])
    assert floors._invented_core(rx, bare, c)["sources"] == ["pulse_catalogue"]
    doc = {"text": "Dolo", "names": ["Dolo"], "flags": ["doctor_dose_precedence"], "medicine": {"strength": {"text": "750 mg"}},
           "evidence": [{"speaker": "doctor", "quote": "Dolo 500 mg"}]}
    assert floors.dose_precedence_sources(rx, _syn("Medication: Dolo", [doc])) == ["eta"]
    # transcript quotes are not ETA's output
    q = _syn("Medication: Dolo", [{"text": "Dolo", "names": ["Dolo"], "evidence": [{"quote": "Dolo 750 mg"}]}])
    assert floors._invented_core(rx, q, c)["sources"] == ["pulse_catalogue"]


# ---- D4: floor totals pinned to the pre-change module --------------------------------------------------------------
# Frozen reference: the base (25da5f0a) functions, copied verbatim. Only the digitless-unmatched medicine changed on purpose (item 2).

_FORM_REF = re.compile(r"\b(tab(?:let)?s?|cap(?:sule)?s?|syp|syrup|inj(?:ection)?|oint(?:ment)?|drops?|gel|cream)\b\.?", re.I)
_DIGITS_REF = re.compile(r"\d+")


def _ref_s(v):
    return re.sub(r"\s+", " ", v).strip() if isinstance(v, str) else ""


def _ref_norm_name(s):
    s = _FORM_REF.sub(" ", (s or "").lower())
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", _DIGITS_REF.sub(" ", s)).replace("mg", " ")).strip()


def _ref_names_match(a, b):
    a, b = {x for x in a if len(x) >= 3}, {x for x in b if len(x) >= 3}
    return any(x == y or x in y or y in x for x in a for y in b)


def _ref_rx_names(m):
    return {_ref_norm_name(m.get(k, "")) for k in ("name", "brand_name", "generic")} - {""}


def _ref_prov_medicines(art):
    return [p for p in (art or {}).get("provenance") or [] if isinstance(p, dict) and p.get("kind") == "medicine" and p.get("json_pointer")]


def _ref_prov_names(p):
    return {_ref_norm_name(x) for x in list(p.get("names") or []) + [p.get("text") or ""]} - {""}


def _ref_cited_turns(p):
    out = []
    for e in p.get("evidence") or []:
        ref = str((e or {}).get("segment_ref") or "")
        if ":" in ref and ref.rsplit(":", 1)[1].isdigit():
            out.append(int(ref.rsplit(":", 1)[1]))
    return out


_STRENGTH_REF = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|g|ml|mcg|iu|%)", re.I)


def _ref_strength(s):
    m = _STRENGTH_REF.search(s or "")
    return (float(m.group(1)), m.group(2).lower()) if m else None


def _ref_invented_numbers(rx, art, consult):
    prov = _ref_prov_medicines(art)
    offending = unmatched = 0
    for m in rx.get("medicines") or []:
        runs = [r for k in ("strength", "frequency", "duration") for r in _DIGITS_REF.findall(m.get(k) or "")]
        match = next((p for p in prov if _ref_names_match(_ref_rx_names(m), _ref_prov_names(p))), None)
        if match is None:
            unmatched += 1
            continue
        heard = set()
        for t in _ref_cited_turns(match):
            if 0 <= t < len(consult.turns):
                heard |= set(_DIGITS_REF.findall(f"{consult.turns[t].text} {consult.turns[t].native_text or ''}"))
        offending += sum(1 for r in runs if r not in heard)
    return offending + unmatched


def _ref_dose_precedence(rx, art):
    errs = 0
    for p in _ref_prov_medicines(art):
        if "doctor_dose_precedence" not in (p.get("flags") or []):
            continue
        ds = floors.validate._doctor_strength(p)
        want = (float(ds[0]), ds[1].lower()) if ds else _ref_strength(p.get("text") or "")
        if want is None:
            continue
        m = next((m for m in rx.get("medicines") or [] if _ref_names_match(_ref_rx_names(m), _ref_prov_names(p))), None)
        if m is None or _ref_strength(m.get("strength") or "") != want:
            errs += 1
    return errs


def _ref_printable_text(rx):
    sec = {h: [] for h in ("Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management",
                           "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice")}
    s = _ref_s

    def add(head, *parts):
        line = " ".join(p for p in (s(x) for x in parts) if p)
        if line:
            sec[head].append(line)

    for m in rx.get("medicines") or []:
        add("Medication", m.get("name"), m.get("brand_name"), m.get("generic"), m.get("strength"), m.get("frequency"),
            "for" if s(m.get("duration")) else "", m.get("duration"), m.get("instructions"))
    for i in rx.get("investigations") or []:
        add("Further Investigation", i.get("name"), i.get("instruction"))
    for x in rx.get("surgeries") or []:
        add("Surgery or Procedure", x.get("name"), x.get("scheduled_date"), x.get("notes"))
    for r in rx.get("referrals") or []:
        add("Refer to", r.get("speciality"), r.get("notes"))
    fu = rx.get("follow_up") or {}
    add("Follow up", fu.get("type"), fu.get("date"), fu.get("instructions"))
    for d in rx.get("diagnoses") or []:
        add("Diagnoses", d.get("name"))
    for c in rx.get("comorbidities") or []:
        add("Co-morbidities", c.get("name"), c.get("duration"))
    for a in rx.get("general_advice") or []:
        add("General Advice", a)
    add("Examination", rx.get("examination"))
    add("Presenting Complaint", rx.get("symptoms"))
    add("Plan of Management", rx.get("management_plan"))
    return "\n".join(f"{h}:\n" + "\n".join(lines) for h, lines in sec.items() if lines)


def _ref_printable_count(rx, art):
    n = 0
    if art is not None and isinstance(art.get("note_text"), str):
        prompts = [c.get("prompt") for c in art.get("completion_required") or [] if isinstance(c, dict)]
        n += len(floors.validate.printable_errors(art["note_text"], prompts))
    return n + len(floors.validate.printable_errors(_ref_printable_text(rx), []))


_VARIANTS = [
    RX,
    {**RX, "medicines": [{"name": "Paracetamol", "strength": "5 g", "frequency": "7 times a day", "duration": "9 days"}]},
    {**RX, "medicines": [{"uid": "c", "name": "Paracetamol", "brand_name": "Dolo", "generic": "paracetamol", "other": False, "strength": "500 mg"}]},
    {**RX, "medicines": [{"name": "Zorbex", "strength": "10 mg"}, {"name": "Cetrizine", "frequency": "at night"}]},
    {**RX, "medicines": [], "symptoms": "fever?", "general_advice": ["[x] a", "walk?", "walk?"], "examination": "tbd {y}"},
    {"medicines": [{"name": "Paracetamol", "strength": "1 g", "instructions": "after food?"}, {"name": "Dolo", "instructions": "at night?"}]},
]


@pytest.mark.parametrize("uid", sorted(p.name for p in CONSULTS.iterdir()))
def test_d4_basis_all_floor_totals_equal_the_pre_change_module(uid, frozen, tmp_path):
    c = load_consult(CONSULTS, uid)
    art = build_artifact(c, stage_a(uid))
    for k, rx in enumerate(_VARIANTS):
        for a in (art, None):
            rec = floors.consult_floors(FakeClient(responder), frozen, uid=uid, arm_kind="Bn", rx=rx, signed_rx=rx, art=a, consult=c,
                                        transcript="T0 hi", cache_dir=tmp_path / f"c{k}{a is None}")
            # item 2 moved the digitless unmatched medicine out of the count on purpose; add it back to compare
            assert rec["invented_numbers"] + rec["unmatched_no_digits"] == _ref_invented_numbers(rx, a, c)
            assert rec["dose_precedence_det"] == _ref_dose_precedence(rx, a)
            assert rec["printable_errors"] == _ref_printable_count(rx, a)
            pd = rec["printable_detail"]
            assert pd["raw"] == rec["printable_errors"] and pd["dedup"] + pd["check"] == pd["raw"]
            assert sum(rec["attribution"]["printable_errors"].values()) == pd["raw"]
            for key in ("invented_numbers", "dose_precedence_det"):
                assert sum(rec["attribution"][key].values()) == rec[key]


# ---- fix round 2 (14 Oct 2026): simpler rules, verdict R2 inputs (1a)-(1c), (2), (3a), (3b), (4), (5), (6) -----------

def test_r2_1_printable_source_is_decided_by_the_same_rule_not_text():
    # (1a) the rx paraphrase carries ETA's own '?'
    art = _syn("Presenting Complaint: Fever (3 days). Body pain?")
    pa = floors.printable_attribution({"symptoms": "Fever for 3 days, body pain?"}, art)
    assert pa["sources"]["eta"] == 2 and pa["sources"]["pulse_extraction"] == 0
    # (1b) ETA's note has a bracket; the catalogue name carries one too: eta, not pulse_catalogue
    art = _syn("Medication: Calpol [P] 500 mg 1-0-1")
    rx = {"medicines": [{"uid": "c", "name": "Calpol [P]", "other": False, "strength": "500 mg", "frequency": "1-0-1", "duration": "5 days"}]}
    pa = floors.printable_attribution(rx, art)
    assert pa["sources"]["eta"] == 2 and pa["sources"]["pulse_catalogue"] == 0 and pa["check"] == 2  # one double emission in ETA's note, one in the replay
    # (1c) an underscore blank in both
    art = _syn("General Advice: Come back on ___ for a review")
    pa = floors.printable_attribution({"general_advice": ["Return on ___ for review"]}, art)
    assert pa["sources"]["eta"] == 2 and pa["sources"]["pulse_extraction"] == 0
    # a rule ETA never trips: catalogue line -> pulse_catalogue, anything else -> pulse_extraction
    clean = _syn("Medication: Dolo 500 mg")
    assert floors.printable_attribution(rx, clean)["sources"]["pulse_catalogue"] >= 1
    assert floors.printable_attribution({"general_advice": ["Return on ___"]}, clean)["sources"]["pulse_extraction"] == 1


def test_r2_2_only_the_bracket_double_emission_is_a_repeat():
    # (2) the verdict's note: 2 bracket findings (one bracket per line -> one double emission each on the whole text) plus others
    note = ("Plan of Management: start [A] today\nGeneral Advice: avoid [B] foods\nFollow up: confirm the dose with pharmacy\n"
            "Examination: recheck the blood pressure please")
    art = {**_syn(note), "completion_required": [{"prompt": "confirm the dose with pharmacy"}, {"prompt": "recheck the blood pressure please"}]}
    pa = floors.printable_attribution({}, art)
    whole = floors.validate.printable_errors(note, [c["prompt"] for c in art["completion_required"]])
    assert pa["raw"] == len(whole) == 5 and pa["check"] == 1 and pa["dedup"] == 4 and pa["sources"]["eta"] == 4
    # two distinct matches on one line are two findings
    for ins in ("dose not mentioned; duration not mentioned", "please confirm the dose, please confirm the duration"):
        pa = floors.printable_attribution({"medicines": [{"name": "Alpha", "instructions": ins}]}, None)
        assert pa["check"] == 0 and pa["dedup"] == pa["raw"] == floors.printable_count({"medicines": [{"name": "Alpha", "instructions": ins}]}, None)


def test_r2_3_dose_precedence_on_non_medicine_items_matches_raw_values():
    # (3a) differential '?Dengue' in the note, rx value 'Dengue'
    art = _syn("Diagnoses: ?Dengue")
    rx = {"diagnoses": [{"name": "Dengue", "is_differential": True}]}
    its = floors.numbered_items(rx)
    out = floors._judge_attribution([item(1, dose_precedence_error=True)], its, art)
    assert out["dose_precedence_errors"] == floors._tally(["eta"])
    # (3b) follow-up type and instructions
    art = _syn("Follow up: review after one week")
    rx = {"follow_up": {"type": "review", "instructions": "after one week"}}
    out = floors._judge_attribution([item(1, dose_precedence_error=True)], floors.numbered_items(rx), art)
    assert out["dose_precedence_errors"] == floors._tally(["eta"])
    # a value ETA never wrote is Pulse's
    out = floors._judge_attribution([item(1, dose_precedence_error=True)], floors.numbered_items({"follow_up": {"type": "surgery"}}), art)
    assert out["dose_precedence_errors"] == floors._tally(["pulse_extraction"])


def test_r2_4_number_words_are_normalised(fever):
    c, _ = fever
    art = _syn("Medication: Amoxicillin 500 mg three times a day for five days", [{"text": "Amoxicillin", "names": ["Amoxicillin"]}])
    rx = {"medicines": [{"name": "Amoxicillin", "strength": "500 mg", "frequency": "3 times a day", "duration": "5 days"}]}
    assert set(floors._invented_core(rx, art, c)["sources"]) <= {"eta"}
    out = floors._judge_attribution([item(1, invented=["frequency", "duration"])], floors.numbered_items(rx), art)
    assert out["invented_fields"] == floors._tally(["eta"])
    for words, digits in (("once daily", "1 a day"), ("twice a day", "2 daily"), ("thrice a day", "3 a day"), ("twenty days", "20 days")):
        assert floors._in_text(digits, words) and floors._in_text(words, digits)
    assert not floors._in_text("4 days", "three days")


def test_r2_5_empty_judge_invented_field_is_not_eta_when_eta_wrote_no_strength_and_provenance_leaves_are_read(fever):
    rx = {"medicines": [{"uid": "c", "name": "Dolo", "other": False, "strength": "", "frequency": "twice a day"}]}
    out = floors._judge_attribution([item(1, invented=["strength"])], floors.numbered_items(rx), _syn("Medication: Dolo"))
    assert out["invented_fields"] == floors._tally(["check"], 1)  # FIX3: ETA wrote no strength, so no ETA invention (flag, not a source)
    out = floors._judge_attribution([item(1, invented=["strength"])], floors.numbered_items(rx), _syn("Medication: Dolo 500 mg"))
    assert out["invented_fields"] == floors._tally(["eta"])  # ETA wrote one
    # (6) every string leaf of the structured provenance objects
    p = {"text": "x", "diagnosis": {"icd10": {"code": "A90"}}, "follow_up": {"when": "next Tuesday"}, "investigation": {"panel": "CBC"},
         "procedure": {"site": "left knee"}, "medicine": {"strength": {"text": "650 mg"}}}
    t = floors._prov_text(p)
    for leaf in ("A90", "next Tuesday", "CBC", "left knee", "650 mg"):
        assert leaf in t
    assert "quote" not in floors._prov_text({"text": "x", "evidence": [{"quote": "secret"}]})


# ---- fix round 3 (14 Oct 2026): verdict R3 inputs (a), (b), D2, LOW 3, (4a), (4b) ----------------------------------------

def test_r3_1_printable_class_follows_the_findings_own_line():
    clean = _syn("Medication: Dolo 500 mg")
    dolo = {**CAT, "strength": "500 mg", "instructions": "after food?"}
    # (a) catalogue line and a symptoms field, same rule
    art = _syn("Presenting Complaint: body pain")
    pa = floors.printable_attribution({"medicines": [dolo], "symptoms": "body pain?"}, art)
    assert pa["sources"]["pulse_catalogue"] == 1 and pa["sources"]["pulse_extraction"] == 1 and pa["sources"]["eta"] == 0
    # (b) catalogue and non-catalogue medicine lines, same rule
    zorbex = {"name": "Zorbex", "other": True, "instructions": "at night?"}
    pa = floors.printable_attribution({"medicines": [{**CAT, "strength": "500 mg", "instructions": "SOS?"}, zorbex]}, clean)
    assert pa["sources"]["pulse_catalogue"] == 1 and pa["sources"]["pulse_extraction"] == 1
    assert sum(pa["sources"].values()) == pa["raw"]


def test_r3_2_empty_vals_and_empty_catalogue_field_are_eta(fever):
    art = _syn("Follow up: No follow-up needed")
    its = floors.numbered_items({"follow_up": {"no_follow_up_needed": True}})
    out = floors._judge_attribution([item(1, dose_precedence_error=True)], its, art)
    assert out["dose_precedence_errors"] == floors._tally(["eta"])
    rx = {"medicines": [{**CAT, "name": "Dolo", "strength": ""}]}
    out = floors._judge_attribution([item(1, dose_precedence_error=True)], floors.numbered_items(rx), _syn("Medication: Dolo"))
    assert out["dose_precedence_errors"] == floors._tally(["eta"])


def test_r3_3_matched_text_in_etas_note_makes_a_replayed_finding_eta():
    # (4a) the section is not gated in ETA's note, the replay's copy is
    art = _syn("Presenting Complaint: fever, dose to be confirmed")
    rx = {"medicines": [{**CAT, "strength": "500 mg", "instructions": "dose to be confirmed"}]}
    pa = floors.printable_attribution(rx, art)
    assert pa["sources"]["eta"] == pa["raw"] >= 2 and pa["sources"]["pulse_catalogue"] == 0
    # (4b) the '?' is exempt on a Diagnoses line; the same text in the plan has none to match, so the field's line is compared
    art = _syn("Diagnoses: ?Dengue")
    pa = floors.printable_attribution({"management_plan": "?Dengue"}, art)
    assert pa["sources"]["eta"] == 1 and pa["sources"]["pulse_extraction"] == 0
    # text ETA never wrote stays Pulse's
    assert floors.printable_attribution({"management_plan": "?Malaria"}, art)["sources"]["pulse_extraction"] == 1


# ---- fix round 4 (14 Oct 2026): a whole-text finding's class does not depend on line order -------------------------------

def _prov_advice(text):
    return {"kind": "advice", "json_pointer": "/general_advice/0", "text": text, "evidence": [], "flags": []}


def test_r4_1_whole_text_finding_is_eta_if_any_yielding_line_is_etas():
    clean = _syn("Medication: Dolo 500 mg")
    # (a) Pulse-only line first, ETA's advice line second
    art = {**clean, "provenance": [_prov_advice("bring reports __")]}
    rx_a = {"management_plan": "review in ___", "general_advice": ["bring reports __"]}
    pa = floors.printable_attribution(rx_a, art)
    assert pa["sources"]["eta"] >= 1 and pa["sources"]["pulse_extraction"] == 0
    # (a-reversed) ETA's line is the one earlier in section order
    art = {**clean, "provenance": [_prov_advice("review in ___")]}
    pa = floors.printable_attribution(rx_a, art)
    assert pa["sources"]["eta"] >= 1 and pa["sources"]["pulse_extraction"] == 0
    # (b) a Pulse-only symptoms line before ETA's non-catalogue medicine line
    art = _syn("Medication: Calpol", [{"text": "Calpol [P]", "names": ["Calpol"]}])
    rx_b = {"symptoms": "headache [x]", "medicines": [{"name": "Calpol [P]", "other": True}]}
    pa = floors.printable_attribution(rx_b, art)
    assert pa["sources"]["eta"] == 1 and pa["sources"]["pulse_extraction"] == 0 and pa["sources"]["check"] == 1


def test_r4_2_permuting_line_order_never_changes_the_class_counts():
    import itertools
    clean = _syn("Medication: Dolo 500 mg")
    dolo = {**CAT, "strength": "500 mg", "instructions": "after food [x]"}
    zorbex = {"name": "Zorbex", "other": True, "instructions": "at night [y]"}
    adv = ["bring reports __", "see ___", "walk daily [z]"]
    for art in (clean, {**clean, "provenance": [_prov_advice("see ___")]}):
        got = {json.dumps(floors.printable_attribution({"management_plan": "review in ___", "symptoms": "headache [x]",
                                                        "general_advice": list(p)}, art)["sources"], sort_keys=True)
               for p in itertools.permutations(adv)}
        assert len(got) == 1
    got = {json.dumps(floors.printable_attribution({"medicines": list(m), "symptoms": "headache [x]"}, clean)["sources"], sort_keys=True)
           for m in itertools.permutations([dolo, zorbex])}
    assert len(got) == 1
    # a finding yielded only by catalogue lines stays pulse_catalogue, in either order
    for m in itertools.permutations([dolo, {**dolo, "strength": "250 mg"}]):
        pa = floors.printable_attribution({"medicines": list(m)}, clean)
        assert pa["sources"]["pulse_extraction"] == 0 and pa["sources"]["pulse_catalogue"] >= 1


def test_unset_basis_end_to_end_is_eta_and_header_carries_eta_and_pulse_counts(tmp_path, monkeypatch):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    monkeypatch.delenv("FREESCRIPT_FLOOR_BASIS", raising=False)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:2])
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=FakeClient(responder)) == 0
    row = json.loads((tmp_path / "SCOREBOARD.R1.json").read_text())
    assert row["floor_basis"] == "eta" and row["floors"]["basis"] == "eta" and row["floor_header"]["floor_basis"] == "eta"
    md = (tmp_path / "SCOREBOARD.md").read_text()
    assert "| eta [eta " in md and "pulse_catalogue " in md and "pulse_extraction " in md


def test_header_carries_basis_and_both_eta_and_pulse_counts_whichever_basis():
    for b in ("eta", "all"):
        h = _agg(b)["header"]
        assert h["floor_basis"] == b and h["eta"] == 0 and h["pulse_catalogue"] == 3 and h["pulse_extraction"] == 0 and h["check"] == 0 and h["total"] == 3


# ---- scoreboard split: eta_coincidence and eta_legacy (FIX1, 15 Oct 2026) ------------------------------------------
def test_scoreboard_split_prints_coincidence_and_legacy():
    from tools.eta2freescript.eval.pdqi9 import scoreboard
    t = {"eta": 4, "eta_coincidence": 3, "pulse_catalogue": 2, "pulse_extraction": 1, "check": 0}
    assert scoreboard.split_cell(t) == ("[eta 4, eta_coincidence 3, ordered_not_supported 0, pulse_catalogue 2, pulse_extraction 1, check 0; eta_wrote_nothing 0 (flag, not a source); eta_legacy (old rule) 7]")
    t["eta_wrote_nothing"] = 2
    assert scoreboard.split_cell(t) == ("[eta 4, eta_coincidence 3, ordered_not_supported 0, pulse_catalogue 2, pulse_extraction 1, check 0; eta_wrote_nothing 2 (flag, not a source); eta_legacy (old rule) 9]")


def test_scoreboard_old_row_without_coincidence_reads_zero():
    from tools.eta2freescript.eval.pdqi9 import scoreboard
    t = {"eta": 5, "pulse_catalogue": 0, "pulse_extraction": 1, "check": 0}
    assert scoreboard.split_cell(t) == "[eta 5, eta_coincidence 0, ordered_not_supported 0, pulse_catalogue 0, pulse_extraction 1, check 0; eta_wrote_nothing 0 (flag, not a source); eta_legacy (old rule) 5]"
    assert "eta_legacy (old rule) -" in scoreboard.split_cell({**t, "eta": None})


def test_scoreboard_eta_legacy_is_eta_plus_coincidence_for_random_counts():
    import random
    import re
    from tools.eta2freescript.eval.pdqi9 import scoreboard
    rng = random.Random(1510)
    for _ in range(2000):
        e, c = rng.randint(0, 500), rng.randint(0, 500)
        w = rng.randint(0, 50)
        out = scoreboard.split_cell({"eta": e, "eta_coincidence": c, "eta_wrote_nothing": w, "pulse_catalogue": 0, "pulse_extraction": 0, "check": 0})
        assert int(re.search(r"eta_legacy \(old rule\) (\d+)", out).group(1)) == e + c + w
        assert f"eta_wrote_nothing {w} " in out
        assert f"eta {e}," in out and f"eta_coincidence {c}," in out
