"""Synthetic regressions for the four medication errors found in the 10 Oct comparison."""
import json
import pytest

from conftest import build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.ingest import _native_span, format_transcript, load_consult
from tools.eta2freescript.medication_safety import (
    catalogue_hit,
    dose_bound,
    native_supports,
    normalize_numbers,
    resolvable,
    same_molecules,
)
from tools.eta2freescript.validate import check, frx

DOC = {"0": "doctor"}


def _art(line, rx, *, native=None, diagnoses=None, vitals=None):
    row = (0, 8, "0", line, native) if native else (0, 8, "0", line)
    c = mk_consult([row], roles=DOC, lang="kn" if native else "en")
    return build_artifact(c, empty_encounter(
        examination=[], prescription=[rx], diagnoses=diagnoses or [], vitals=vitals or []))


def _rx(**over):
    row = {
        "action": "start", "decision_turn": 0, "generic": "paracetamol", "brand_as_said": None,
        "strength": None, "dosage_form": "tablet", "frequency": None, "duration": None,
        "basis": "said", "confidence": 0.9, "source_turns": [0],
    }
    row.update(over)
    return row


def test_m12_antibiotic_cannot_pick_up_the_syrups_10_ml():
    a = _art("Take azithromycin tablet. Take Ascoril syrup 10 ml.",
             _rx(generic="azithromycin", strength="10 ml"))
    med = a["gp_extraction"]["medicines"][0]
    owner = next(p for p in a["provenance"] if p.get("json_pointer") == "/medicines/0")
    assert med["name"] == "azithromycin" and "10" not in med["name"]
    assert "dose_binding_conflict" in owner["flags"]
    assert owner["medicine"]["strength"]["evidence_state"] == "not_said_in_room"
    assert any(c["kind"] == "dose_unstated" for c in a["completion_required"])
    assert check(a) == []


def test_m9_kannada_rivaroxaban_cannot_become_a_nonexistent_name():
    a = _art("Take Oxypent 10 mg.", _rx(generic="Oxypent", strength="10 mg"),
             native="ರಿವರಾಕ್ಸಾಬಾನ್ ೧೦ mg ತೆಗೆದುಕೊಳ್ಳಿ")
    assert "medicines" not in a["gp_extraction"]
    assert "translation_conflict" in a["slots"][0]["flags"]
    assert check(a) == []


def test_m9_native_40_cannot_become_940_for_a_continued_drug():
    a = _art("Continue pantoprazole 940 mg.", _rx(
        action="continue", generic="pantoprazole", strength="940 mg"),
        native="ಪ್ಯಾಂಟೋಪ್ರಜೋಲ್ ೪೦ mg ಮುಂದುವರಿಸಿ")
    assert "medicines" not in a["gp_extraction"]
    assert "translation_conflict" in a["slots"][0]["flags"]
    assert check(a) == []


def test_m11_vonoprazan_brand_cannot_become_omeprazole():
    a = _art("Take Voquezna 20 mg.", _rx(
        generic="omeprazole", brand_as_said="Voquezna", strength="20 mg"))
    assert "medicines" not in a["gp_extraction"]
    assert "molecule_conflict" in a["slots"][0]["flags"]
    assert check(a) == []


def test_m10_unknown_name_becomes_a_pick_drug_slot():
    a = _art("Take Zzyzx twice a day.", _rx(generic="Zzyzx", frequency="twice a day"))
    assert "medicines" not in a["gp_extraction"]
    assert "unresolved_name" in a["slots"][0]["flags"]
    assert check(a) == []


def test_native_number_support_uses_whole_tokens():
    assert native_supports("pantoprazole", ["10 mg"], "ಪ್ಯಾಂಟೋಪ್ರಜೋಲ್ ೧೦ mg")
    assert not native_supports("pantoprazole", ["1 mg"], "ಪ್ಯಾಂಟೋಪ್ರಜೋಲ್ ೧೦ mg")


def test_native_number_support_does_not_swap_doses_between_drugs():
    native = "ಪ್ಯಾಂಟೋಪ್ರಜೋಲ್ ೪೦ mg. ರಿವರಾಕ್ಸಾಬಾನ್ ೧೦ mg."
    assert native_supports("pantoprazole", ["40 mg"], native)
    assert not native_supports("pantoprazole", ["10 mg"], native)


def test_native_name_support_uses_boundaries_and_known_indic_aliases():
    assert not native_supports("amlodipine", ["5 mg"], "I am longing for relief, 5 mg")
    assert native_supports("metformin", ["500 mg"], "मेटफॉर्मिन ५०० mg")


def test_native_alignment_keeps_source_segments_as_separate_clauses():
    text, lang = _native_span(
        {"t0_ms": 0, "t1_ms": 4000, "speaker_id": "0"},
        [
            {"t0_ms": 0, "t1_ms": 2000, "speaker_id": "0", "lang": "kn", "text": "ಪ್ಯಾಂಟೋಪ್ರಜೋಲ್ ೪೦ mg"},
            {"t0_ms": 2000, "t1_ms": 4000, "speaker_id": "0", "lang": "kn", "text": "ರಿವರಾಕ್ಸಾಬಾನ್ ೧೦ mg"},
        ],
        "kn",
    )
    assert lang == "kn" and ". " in text
    assert not native_supports("pantoprazole", ["10 mg"], text)


def test_m12_allows_a_comma_between_one_drug_and_its_dose():
    assert dose_bound("azithromycin", [], "500 mg", ["Take azithromycin, 500 mg."])


def test_m11_requires_the_complete_molecule_set():
    assert not same_molecules("Telma-AM", "Telma-H")
    assert not same_molecules("metformin", "Glycomet GP")


def test_m12_uses_native_clause_binding_when_translation_splits_the_dose():
    a = _art("Take pantoprazole. The dose is 40 mg.",
             _rx(generic="pantoprazole", strength="40 mg"),
             native="ಪ್ಯಾಂಟೋಪ್ರಜೋಲ್ ೪೦ mg ತೆಗೆದುಕೊಳ್ಳಿ")
    assert a["gp_extraction"]["medicines"][0]["name"] == "pantoprazole 40 mg"
    assert check(a) == []


def test_m12_infers_tablet_form_from_the_quote():
    a = _art("Take azithromycin tablet 10 ml.",
             _rx(generic="azithromycin", strength="10 ml", dosage_form=None))
    med = a["gp_extraction"]["medicines"][0]
    owner = next(p for p in a["provenance"] if p.get("json_pointer") == "/medicines/0")
    assert med["name"] == "azithromycin"
    assert "dose_binding_conflict" in owner["flags"]
    assert any(c["kind"] == "dose_unstated" for c in a["completion_required"])
    assert check(a) == []


def test_m13_implausible_strength_is_removed_and_reviewed():
    a = _art("Take pantoprazole 940 mg.", _rx(generic="pantoprazole", strength="940 mg"))
    med = a["gp_extraction"]["medicines"][0]
    owner = next(p for p in a["provenance"] if p.get("json_pointer") == "/medicines/0")
    assert med["name"] == "pantoprazole"
    assert "implausible_strength" in owner["flags"]
    assert owner["medicine"]["strength"]["evidence_state"] == "not_said_in_room"
    assert any(c["kind"] == "dose_unstated" for c in a["completion_required"])
    assert check(a) == []


def test_m13_removes_strength_when_no_reviewed_range_exists():
    a = _art("Take tramadol 99999 mg.", _rx(generic="tramadol", strength="99999 mg"))
    med = a["gp_extraction"]["medicines"][0]
    owner = next(p for p in a["provenance"] if p.get("json_pointer") == "/medicines/0")
    assert med["name"] == "tramadol"
    assert "implausible_strength" in owner["flags"]
    assert check(a) == []


def test_d4_warns_and_creates_lab_dx_conflict_completion():
    a = _art("HbA1c is 6.8, this is pre-diabetes.", _rx(action="stop", generic="paracetamol"),
             diagnoses=[{"label": "Pre-diabetes", "rank": "primary", "doctor_named": True,
                         "status": "confirmed", "basis": "said", "source_turns": [0]}],
             vitals=[{"name": "HbA1c", "value": "6.8", "unit": "%", "source_turns": [0]}])
    assert any(x.startswith("FRX-D4") for x in frx(a))
    assert any(c["kind"] == "lab_dx_conflict" for c in a["completion_required"])
    assert not any(x.startswith("FRX-D4") for x in check(a))


def test_ingest_aligns_native_span_and_prompt_presents_it_first(tmp_path):
    d = tmp_path / "synth-native"
    d.mkdir()
    (d / "transcript.json").write_text(json.dumps({
        "consult_uid": "synth-native", "language_code": "kn-IN",
        "clip": {"t0_ms": 1000, "t1_ms": 5000, "room_slug": "synth-room"},
        "english_segments": [{"t0_ms": 1000, "t1_ms": 5000, "speaker_id": "0", "text": "Take rivaroxaban 10 mg."}],
        "native_segments": [{"t0_ms": 1000, "t1_ms": 5000, "speaker_id": "0", "lang": "kn",
                             "text": "ರಿವರಾಕ್ಸಾಬಾನ್ ೧೦ mg ತೆಗೆದುಕೊಳ್ಳಿ"},
                            {"t0_ms": 4900, "t1_ms": 7000, "speaker_id": "0", "lang": "kn",
                             "text": "ಅಜಿಥ್ರೊಮೈಸಿನ್ ೫೦೦ mg"}],
    }))
    c = load_consult(tmp_path, "synth-native")
    assert c.turns[0].native_text
    line = format_transcript(c)
    assert line.index("NATIVE[kn]") < line.index("ENGLISH:")
    assert "೫೦೦" not in line


@pytest.mark.parametrize("word", ["पांच", "ಐದು", "ஐந்து", "ఐదు", "അഞ്ച്"])
def test_native_number_words_cover_five_required_languages(word):
    assert "5" in normalize_numbers(word)


@pytest.mark.parametrize("spoken", [
    "Menopace", "Menopace Iso", "Mounjaro", "Sompraz", "Ultra Magnesium", "Soframycin",
    "Telma 20", "Telma 40", "Unienzyme", "Glycomet Trio 2",
    "Daflon", "Ecosprin AV", "Silodal 4",
])
def test_catalogue_resolves_spoken_brands(spoken):
    assert catalogue_hit(spoken)
    assert resolvable(spoken)
    a = _art(f"Take {spoken} once a day.", _rx(generic=spoken, frequency="once a day"))
    meds = a["gp_extraction"]["medicines"]
    if spoken == "Glycomet Trio 2":
        assert [m["name"] for m in meds] == ["metformin", "glimepiride", "voglibose"]
        assert all(m["raw_name"] == "Glycomet Trio 2" for m in meds)
    else:
        assert meds[0]["name"].lower().startswith(spoken.split()[0].lower())
    assert "unresolved_name" not in (a["slots"][0]["flags"] if a["slots"] else [])
    assert check(a) == []


def test_loose_fuzzy_brand_spelling_does_not_release():
    """Atolip/Atorlip is 0.92 and Sompras/Sompraz is 0.86. Neither is exact enough to release."""
    assert catalogue_hit("Sompraz")
    assert catalogue_hit("Sompras") is None
    assert catalogue_hit("Atolip") is None
    assert catalogue_hit("Atolip A") is None
    assert catalogue_hit("Azithroxyz") is None
    assert not resolvable("Atolip A")
    assert not resolvable("Azithroxyz")
    a = _art("Take Azithroxyz twice a day.", _rx(generic="Azithroxyz", frequency="twice a day"))
    assert "medicines" not in a["gp_extraction"]
    assert "unresolved_name" in a["slots"][0]["flags"]
    assert check(a) == []


def test_m12_another_drug_on_the_same_turn_does_not_unbind_a_dose():
    a = _art("Take pantoprazole 40 mg and paracetamol 500 mg.",
             _rx(generic="pantoprazole", strength="40 mg"))
    assert a["gp_extraction"]["medicines"][0]["name"] == "pantoprazole 40 mg"
    assert check(a) == []
