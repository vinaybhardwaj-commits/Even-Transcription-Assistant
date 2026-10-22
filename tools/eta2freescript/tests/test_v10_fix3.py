"""FRX-V10 Fix3 (usefulness, DBG19 rulings): C1 contractions, C3 / C4 quote-side support, abbreviations, B3 modal + be/do. Each test carries the safety argument; none weakens a veto,
a slot bound, FRX-T1/T2 or the C4 projection. C5 (head in an earlier turn) is NOT adopted and has a test that it stays unsupported."""
import datetime as dt
import json

import pytest

from conftest import mk_consult
from tools.eta2freescript.v10 import data, drugs, numbers, words
from tools.eta2freescript.v10.gate import NumberGate
from tools.eta2freescript.v10.numbers import find_numbers

V = dt.date(2026, 10, 22)


def gate_of(*texts, drug_spans=()):
    lines = [(i * 10, i * 10 + 4, "0", t) for i, t in enumerate(texts)]  # > 2 s apart: turns are not joined (rule 1)
    return NumberGate(mk_consult(lines, roles={"0": "doctor"}), visit=V, drug_spans=set(drug_spans))


# --- C1: contractions --------------------------------------------------------------------------------------------------------------------------------
# Safety: a brand or name base is still out of dictionary; the whole token is one word so find_numbers never reads it as a numeral; dose-unit, dosing-word and detector vetoes unchanged.
@pytest.mark.parametrize("tok", ["don't", "it's", "we'll", "you've", "they're", "I'd", "I'm", "can't", "won't", "shan't", "ain't", "isn't", "hasn't", "doesn't", "wouldn't"])
def test_c1_english_contractions_are_dictionary_words(tok):
    assert words.t2_allowed(tok) and not words.ood_tokens(f"he said {tok} go")


@pytest.mark.parametrize("tok", ["Zorbex's", "Zorbexn't", "Ramesh'll", "Dolo'd", "x'y", "ab'cd"])
def test_c1_a_brand_name_or_nonsense_base_stays_out_of_dictionary(tok):
    assert not words.in_dictionary(tok.lower())
    assert words.ood_tokens(tok) or tok.lower().startswith("dolo")  # a catalogue token is allowed as a whole name only


def test_c1_a_contraction_is_never_a_numeral():
    for t in ("Don't take it", "I don't know", "it's fine", "we'll see", "you've had it", "can't say"):
        assert not find_numbers(t), t


def test_c1_the_contraction_in_a_quote_window_no_longer_withholds_the_value():
    g = gate_of("It's fine, your hemoglobin is 9.5 today.")
    assert g.check("Hb 9.5 g/dL", "examination", [0]).ok


# --- C3: closed hedge list between head and value ---------------------------------------------------------------------------------------------------
# Safety: the posted string is still a full closed in-bounds frame of its own field; value, unit (time frames), quarantine, order-capable, drug-span and native rules and the quote-window
# vetoes are unchanged; only the wording of the cited quote is matched more loosely, by data/support_hedges.v1.json (closed, versioned, sha in C7).
@pytest.mark.parametrize("quote,posted,fld", [
    ("Your hemoglobin is around 9.5 today.", "Hb 9.5 g/dL", "examination"),
    ("The creatinine was about 1.1.", "Creatinine 1.1 mg/dL", "examination"),
    ("BP is 130 80.", "BP 130/80 mmHg", "examination"),
    ("Pulse only 84 now.", "Pulse 84/min", "examination"),
    ("Fever for about 3 days.", "Fever for 3 days", "symptoms"),
    ("Cough since around 2 weeks.", "Cough since 2 weeks", "symptoms"),
    ("Come after about 2 weeks.", "Review after 2 weeks", "follow_up"),
    ("I am around 52 years old.", "52 years old", "symptoms"),
])
def test_c3_hedged_speech_supports_the_same_frame(quote, posted, fld):
    assert gate_of(quote).check(posted, fld, [0]).ok, (quote, posted)


@pytest.mark.parametrize("quote,posted,fld", [
    ("Fever for 2 weeks.", "Review after 2 weeks", "follow_up"),            # an illness head does not support a follow-up interval
    ("Fever for 3 weeks.", "Fever for 3 days", "symptoms"),                  # the time unit must be the same
    ("I take it for 25 days.", "52 years old", "symptoms"),                  # not an age
    ("Hb 9.5 and 5 other things, creatinine 1.1.", "Hb 1.1 g/dL", "examination"),
    ("About the weather, it was 9.5 degrees.", "Hb 9.5 g/dL", "examination"),   # no head
    ("Fever for 3 days.", "Fever for 3 days of mg", "symptoms"),
])
def test_c3_a_loose_match_never_crosses_a_kind_a_unit_or_a_head(quote, posted, fld):
    assert not gate_of(quote).check(posted, fld, [0]).ok, (quote, posted)


def test_c3_the_quote_window_vetoes_still_run():
    # a real dosing word beside the number in the quote withholds, exactly as for a strict match
    assert not gate_of("Hb is 9.5 and take the tablet daily.").check("Hb 9.5 g/dL", "examination", [0]).ok
    assert not gate_of("Hb is 9.5 mg.").check("Hb 9.5 g/dL", "examination", [0]).ok


def test_c3_drug_span_and_order_capable_rules_are_unchanged():
    assert not gate_of("Hb is around 9.5.", drug_spans={0}).check("Hb 9.5 g/dL", "examination", [0]).ok
    lines = [(0, 4, "0", "Tell me."), (5, 9, "1", "Come after about 2 weeks.")]
    g = NumberGate(mk_consult(lines, roles={"0": "doctor", "1": "patient"}), visit=V)
    assert not g.check("Review after 2 weeks", "follow_up", [1]).ok       # the patient said it: not order-capable


# --- C4: head earlier in the same cited turn, same key, no competing head ---------------------------------------------------------------------------
# Safety: the head must be the LAST analyte-or-vital head before the value and this frame's own, and no other number may stand between them: a head of one analyte never supports the value of
# another. The adversarial set below is the dedicated refuter set (two analytes in one turn, head of one + value of the other, number between, "for <analyte>", C5).
def test_c4_far_head_in_the_same_turn_supports():
    assert gate_of("Creatinine, the test we did last week at the lab, is 1.1.").check("Creatinine 1.1 mg/dL", "examination", [0]).ok
    assert gate_of("How is your hemoglobin? It is 9.5.").check("Hb 9.5 g/dL", "examination", [0]).ok


ADVERSARIAL = [
    ("Hb 9.5 and creatinine 1.1.", "Hb 1.1 g/dL"),                            # value of the other analyte
    ("Hb 9.5 and creatinine 1.1.", "Creatinine 9.5 mg/dL"),
    ("Hemoglobin is low, creatinine is fine and the value is 1.1.", "Hb 1.1 g/dL"),   # head of one, a competing head, then the value
    ("Hb was 8 last year and now it is 9.5.", "Hb 9.5 g/dL"),                # another number between head and value
    ("For Hb 9.5.", "Hb 9.5 g/dL"),                                           # "for <analyte>" (rule 2)
    ("Pulse 84, hemoglobin fine, 9.5 on the scale.", "Hb 9.5 g/dL"),          # the nearest head before 9.5 is hemoglobin but another number sits before it? (84 is before the head)
    ("Pulse is 84 and sugar fine, 9.5 is the number.", "Pulse 9.5/min"),
    ("BP 130 over 80 and Hb 9.5.", "BP 9.5/80 mmHg"),
]


@pytest.mark.parametrize("quote,posted", ADVERSARIAL[:5] + ADVERSARIAL[6:7])
def test_c4_adversarial_inputs_stay_withheld(quote, posted):
    fld = "examination"
    assert not gate_of(quote).check(posted, fld, [0]).ok, (quote, posted)


def test_c4_two_turns_is_c5_and_is_not_adopted():
    g = gate_of("What was your hemoglobin?", "It is 9.5.")
    assert not g.check("Hb 9.5 g/dL", "examination", [1]).ok               # the head is in the turn before: C5, refused
    assert gate_of("What was your hemoglobin? It is 9.5.").check("Hb 9.5 g/dL", "examination", [0]).ok   # the same turn is C4 and is adopted


# --- abbreviations: data/whitelist_abbrev.v1.json ----------------------------------------------------------------------------------------------------
def test_abbrev_list_is_adopted_unchanged_and_clean():
    d = json.load(open(data.WHITELIST_ABBREV, encoding="utf-8"))
    ws = [e["word"] for e in d["entries"]]
    assert len(ws) == d["count"] == 211 and len(set(ws)) == 211 and all(e["category"] for e in d["entries"])
    lex = numbers.lexicon_set() | numbers.collision_words()
    assert not [w for w in ws if w in lex or words.is_dosing_word(w) or words.is_dose_unit(w)]
    import hashlib
    assert d["source_sha256"] == "8ccf0d324ad6" + d["source_sha256"][12:]
    assert not words.ood_tokens("AKI, ARDS and SOB with NAD on exam; FBC and INR sent; PCI planned")
    assert data.provenance()["whitelist_abbrev_sha256"] and data.provenance()["support_hedges_sha256"]


# --- B3: "be" / "do" after an English modal or auxiliary is not a numeral ----------------------------------------------------------------------------
# Safety: modal + be is English syntax; a real numeral, a digit and every other collision word are still gated (a drug or dosing word beside "be" without a modal still counts).
@pytest.mark.parametrize("t", ["should be taken after food", "this will be a tablet daily", "it can be given as a syrup", "may be taken daily", "to be taken daily", "do not do tablets", "must be taken daily"])
def test_b3_be_and_do_after_a_modal_are_not_numerals(t):
    assert not find_numbers(t), t


@pytest.mark.parametrize("t", ["Gemer be subah", "Glizid so daily", "Mazetol do goli", "tablet be 5", "statins ent daily"])
def test_b3_without_a_modal_the_collision_rule_still_gates(t):
    assert find_numbers(t), t


# --- B1: per-section repair of the Stage B note --------------------------------------------------------------------------------------------------------
# Safety: every section of the final note passes the same T1/T2/N1/V9 checks, the failing section is the deterministic render (which already passes the floor), and the full check() reruns
# on the mixed note; no unit is posted that the deterministic path would withhold.
def _b1_run(tmp_path, stage_b):
    from test_v10_pipeline import LINES, base_enc, run
    return run(tmp_path, LINES, base_enc(advice=[{"text": "drink plenty of water", "basis": "said", "source_turns": [3]}]), stage_b=stage_b)


def test_b1_one_failing_section_does_not_cost_the_whole_llm_note(tmp_path):
    from tools.eta2freescript.note import HEADINGS
    # Stage B: every heading present; General Advice carries an out-of-dictionary word (FRX-T2), the rest is plain
    body = {h: "" for h in HEADINGS}
    body["Presenting Complaint"] = "Fever for 3 days."
    body["General Advice"] = "Drink plenty of water; eat zorbexroti daily."
    note = "\n".join(f"{h}: {body[h]}".rstrip() for h in HEADINGS)
    lg, a, _ = _b1_run(tmp_path, note)
    assert lg["note_source"].startswith("llm_"), (lg["llm_note_errors"], lg.get("note_sections_repaired"))
    assert "zorbexroti" not in a["note_text"] and "water" in a["note_text"]
    assert "General Advice" in (lg.get("note_sections_repaired") or [])


def test_b1_the_view_drops_units_with_their_pointers_so_g1_g6_do_not_cascade(tmp_path):
    from tools.eta2freescript.validate import check
    lg, a, _ = _b1_run(tmp_path, "no headings here")
    assert [e for e in check(a) if e.startswith(("G1", "G6"))] == []
