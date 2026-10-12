"""Regressions for the 10 Oct FRX misses. Synthetic only. check() must be empty on each."""
import datetime as dt
import json

from conftest import T0, build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.followup import add_interval
from tools.eta2freescript.mapper import ADVICE_MAX_CHARS, ADVICE_MAX_ITEMS
from tools.eta2freescript.models import UsageLedger, cost_for_uid
from tools.eta2freescript.validate import check

DOC = {"0": "doctor", "1": "patient", "2": "attendant"}
LINES = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever and cough."), (11, 15, "2", "He takes amlodipine 5 mg."),
         (16, 20, "0", "Throat is red."), (21, 30, "0", "Take paracetamol 500 mg twice a day for three days."),
         (31, 35, "0", "Drink water and rest."), (36, 40, "0", "Come back after one week.")]
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def art_of(c=None, **enc):
    return build_artifact(c or mk_consult(LINES, roles=DOC), empty_encounter(**enc))


def test_a1_blob_is_split_then_capped_at_item_boundaries():
    items = ["Walk daily", "Sleep early", "Gargle tonight", "Wear a mask", "Steam inhalation", "Avoid stairs", "No ice cream", "Sit upright"]
    a = art_of(advice=[{"text": "; ".join(items), "basis": "said", "source_turns": [5]}])
    ga = a["gp_extraction"]["general_advice"]
    assert len(ga.split("; ")) == ADVICE_MAX_ITEMS and len(ga) <= ADVICE_MAX_CHARS
    assert check(a) == []


def test_a1_colon_replacement_cannot_push_past_300():
    piece = "Do this: " + ("ab" * 28)
    a = art_of(advice=[{"text": "; ".join([piece] * 6), "basis": "said", "source_turns": [5]}])
    ga = a["gp_extraction"]["general_advice"]
    assert len(ga) <= ADVICE_MAX_CHARS and ":" not in ga
    assert check(a) == []


def test_p3_decision_turn_is_one_of_the_cited_spans():
    rx = {"action": "start", "decision_turn": 6, "generic": "paracetamol", "basis": "said", "confidence": 0.9,
          "frequency": "twice a day", "source_turns": [0, 1, 2, 3]}
    a = art_of(prescription=[rx])
    owner = next(p for p in a["provenance"] if p.get("json_pointer") == "/medicines/0")
    cited = [int(ev["segment_ref"].rsplit(":", 1)[1]) for ev in owner["evidence"]]
    assert owner["decision"]["turn"] in cited
    assert check(a) == []


def test_m3_brand_number_absent_from_the_tape_is_stripped():
    lines = list(LINES)
    lines[4] = (21, 30, "0", "Take Crocin twice a day for three days.")
    c = mk_consult(lines, roles=DOC)
    rx = {"action": "start", "decision_turn": 4, "generic": None, "brand_as_said": "Crocin 500", "strength": "500 mg",
          "frequency": "twice a day", "duration": "3 days", "basis": "said", "confidence": 0.9, "source_turns": [4]}
    a = art_of(c=c, prescription=[rx])
    assert "500" not in a["gp_extraction"]["medicines"][0]["name"]
    assert check(a) == []


def test_f2_followup_date_is_the_visit_plus_the_interval():
    visit = dt.datetime.fromtimestamp(T0 / 1000, IST).date()
    wrong = (visit + dt.timedelta(days=3)).isoformat()
    a = art_of(follow_up={"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 2, "unit": "WEEKS"}, "date": wrong,
                          "basis": "said", "source_turns": [6]})
    assert a["gp_extraction"]["follow_up"]["followup_date"] == add_interval(visit, 2, "WEEKS").isoformat()
    assert check(a) == []


def test_m1_form_prefix_stripped_and_class_word_becomes_a_slot():
    named = {"action": "start", "decision_turn": 4, "generic": "Tab.Paracetamol", "strength": "500 mg",
             "frequency": "twice a day", "duration": "3 days", "basis": "said", "confidence": 0.9, "source_turns": [4]}
    vitamin = {"action": "start", "decision_turn": 4, "generic": "Vitamin D", "basis": "said", "confidence": 0.8, "source_turns": [4]}
    klass = {"action": "start", "decision_turn": 4, "generic": "painkiller", "basis": "said", "confidence": 0.8, "source_turns": [4]}
    a = art_of(prescription=[named, vitamin, klass])
    names = [m["name"] for m in a["gp_extraction"]["medicines"]]
    assert len(names) == 1 and names[0].lower().startswith("paracetamol") and "500" in names[0]
    assert not names[0].lower().startswith("tab")
    heard = " ".join(str((s.get(f) or {}).get("text") or "") for s in a["slots"] for f in ("class", "form"))
    assert "painkiller" in heard.lower() or "vitamin" in heard.lower()
    assert check(a) == []


def test_e3_phone_and_title_are_scrubbed_before_validation():
    phone = "98" + "76543210"
    who = "D" + "r " + "Planted"
    a = art_of(advice=[{"text": "Call the clinic " + phone, "basis": "said", "source_turns": [5]}],
               referrals=[{"to": who, "basis": "said", "for_this_patient": True, "source_turns": [5]}])
    blob = json.dumps(a["gp_extraction"]) + json.dumps([p.get("text") for p in a["provenance"]])
    blob += json.dumps(a["slots"])
    assert phone not in blob and "Planted" not in blob
    assert "referrals" not in a["gp_extraction"]
    assert check(a) == []


def test_p2_inferred_patient_decision_is_held_out():
    c = mk_consult(LINES, roles=DOC, role_track=False)
    c.turns[4].role = "patient"
    rx = {"action": "start", "decision_turn": 4, "generic": "paracetamol", "strength": "500 mg",
          "frequency": "twice a day", "duration": "3 days", "basis": "said", "confidence": 0.9, "source_turns": [4]}
    a = art_of(c=c, prescription=[rx])
    assert "medicines" not in a["gp_extraction"]
    assert check(a) == []


def test_r1_two_capitalised_words_are_not_a_department():
    a = art_of(referrals=[{"to": "Ortho Clinic", "basis": "said", "for_this_patient": True, "source_turns": [5]}])
    assert "referrals" not in a["gp_extraction"]
    assert check(a) == []


def test_s1_a_drug_token_in_a_slot_part_is_not_heard():
    a = art_of(regimen_slots=[{"dosage_form": "paracetamol", "frequency": "twice a day", "quote_turn": 4, "source_turns": [4]}])
    slot = a["slots"][0]
    assert slot["form"]["evidence_state"] == "not_said_in_room"
    assert "text" not in slot["form"]
    assert slot["frequency"]["evidence_state"] == "heard_in_room"
    assert check(a) == []


def test_cost_for_uid_sums_ledger_lines_without_a_model_call(tmp_path):
    led = UsageLedger(tmp_path / "usage.jsonl")
    led.record("sonnet", "stageA-v2:synth-unit", 0.2, 1000, 100)
    led.record("sonnet", "stageB-v4:synth-unit", 0.2, 200, 50)
    led.record("haiku", "stageA-v2:other-uid", 0.1, 9, 9)
    assert cost_for_uid(led, "synth-unit") == round(1000 / 1e6 * 3 + 100 / 1e6 * 15 + 200 / 1e6 * 3 + 50 / 1e6 * 15, 5)
    assert cost_for_uid(led, "missing") is None
