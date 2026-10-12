"""Build the SYNTHETIC consult fixtures. Every consult here is invented: no real patient, clinician, room, uid or number.

  python tools/eta2freescript/tests/fixtures/build_fixtures.py

consults/<uid>/  transcript.json, role.json (when the consult has a role track), meta.json, signed.json (invented)
model/<uid>/     canned model output for the replay client: stageA.json, stageB.txt (when present), judge.json

synth-fever-dose      role track, English. Patient names "Dolo 650"; the doctor says paracetamol 1 g. Social detail,
                      a borderline-BP remark, duplicated advice, follow-up with reports after one week.
synth-boundary-knee   role track with two_consults (gap 60 s): the clip opens on the previous patient's order. Unnamed
                      gel (regimen slot), attendant-reported metformin, knee examined with no finding said, "come back if".
                      Its Stage B note names the quarantined drug, so the run must fall back to the deterministic note.
synth-cough-native    NO role track and NO English pass: native / romanised Hindi only. Roles inferred by Stage A.
                      Named syrup, an unnamed tablet, follow-up "do hafte baad" (2 weeks). No Stage B output stored.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
T0 = int(dt.datetime(2026, 10, 5, 10, 0, tzinfo=IST).timestamp() * 1000)


def seg(t0_s, t1_s, spk, text, lang=None):
    d = {"t0_ms": T0 + int(t0_s * 1000), "t1_ms": T0 + int(t1_s * 1000), "speaker_id": spk, "text": text}
    if lang:
        d["lang"] = lang
    return d


def role_track(segs, roles, extras, shift_ms=0):
    """One role segment per transcript segment (same speaker), optionally shifted to exercise the overlap join."""
    return {"layer": "role", "engine": "llm-roles", "status": "ok", "config_hash": "synthcfg01", "window_id": "consult-synthetic",
            "segments": [{"t0_ms": s["t0_ms"] + shift_ms, "t1_ms": s["t1_ms"] + shift_ms, "speaker": s["speaker_id"], "role": roles[s["speaker_id"]]} for s in segs],
            "extras": extras}


def write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(obj if isinstance(obj, str) else json.dumps(obj, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- 1. synth-fever-dose
FEVER = [
    seg(0, 4, "0", "Good morning, please sit. What is the problem?"),
    seg(5, 11, "1", "I have fever for three days and body pain."),
    seg(12, 17, "1", "I took Dolo 650 at home twice."),
    seg(18, 24, "1", "I work at the vegetable market and came by bus today."),
    seg(25, 29, "0", "Any cough or burning while passing urine?"),
    seg(30, 38, "1", "No cough. My BP was a little high at the pharmacy."),
    seg(40, 53, "0", "Let me check. Temperature is 101, throat is red, chest is clear."),
    seg(55, 64, "0", "This looks like a viral fever. Take paracetamol 1 g three times a day for three days."),
    seg(65, 71, "0", "Get a CBC test done today."),
    seg(72, 77, "0", "Drink plenty of water and take rest."),
    seg(78, 84, "0", "Drink lots of water, at least three litres."),
    seg(85, 89, "0", "Come back after one week with the CBC report."),
    seg(90, 92, "1", "Okay, thank you."),
]
FEVER_A = {
    "schema": "even.encounter.v2",
    "speaker_roles": [{"speaker": "S0", "role": "doctor", "confidence": 1.0}, {"speaker": "S1", "role": "patient", "confidence": 1.0}],
    "language_notes": "English, clear",
    "chief_complaint": {"text": "Fever", "duration": "3 days", "basis": "said", "source_turns": [1]},
    "hpi": [{"text": "Body pain", "basis": "said", "source_turns": [1]}],
    "comorbidities": [],
    "history": [{"type": "social", "text": "Works at a vegetable market, came by bus", "clinically_relevant": False, "basis": "said", "source_turns": [3]}],
    "drug_history": [{"name_as_said": "Dolo 650", "text": "Took Dolo 650 at home twice", "current": False, "reported_by": "patient", "source_turns": [2]}],
    "allergy_history": [],
    "examination": [{"performed": "Temperature", "finding": "101 F", "basis": "said", "source_turns": [6]},
                    {"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [6]},
                    {"performed": "Chest", "finding": "clear", "basis": "said", "source_turns": [6]}],
    "vitals": [{"name": "Temperature", "value": "101", "unit": "F", "source_turns": [6]}],
    "assessment": {"summary": "Viral fever", "basis": "said", "source_turns": [7]},
    "diagnoses": [
        {"label": "Viral fever", "rank": "primary", "doctor_named": True, "status": "provisional", "basis": "said", "icd10_suggestion": "B34.9", "icd10_confidence": 0.6, "source_turns": [7]},
        {"label": "Elevated blood pressure", "rank": "secondary", "doctor_named": False, "status": "provisional", "basis": "inferred", "icd10_suggestion": "R03.0", "icd10_confidence": 0.4, "source_turns": [5]},
        {"label": "Body ache", "rank": "secondary", "doctor_named": False, "status": "provisional", "basis": "said", "icd10_suggestion": "R52", "icd10_confidence": 0.4, "source_turns": [1]}],
    "plan": [],
    "prescription": [{"action": "start", "decision_turn": 7, "generic": "paracetamol", "brand_as_said": "Dolo 650", "name_interpretation": None,
                      "strength": "650 mg", "strength_said_by": "patient", "strength_turn": 2, "dosage_form": "tablet", "route": "oral",
                      "frequency": "three times a day", "duration": "3 days", "instructions": None, "basis": "said", "confidence": 0.85,
                      "source_quote_turn": 7, "source_turns": [2, 7]}],
    "regimen_slots": [],
    "investigations": [{"name": "CBC", "order_status": "ordered", "timing": "today", "decision_turn": 8, "basis": "said", "source_turns": [8]}],
    "advice": [{"text": "Drink plenty of water", "basis": "said", "source_turns": [9]},
               {"text": "Take rest", "basis": "said", "source_turns": [9]},
               {"text": "Drink lots of water, at least three litres", "basis": "said", "source_turns": [10]}],
    "follow_up": {"type": "FOLLOW_UP_WITH_REPORTS", "interval": {"value": 1, "unit": "WEEKS"}, "date": None, "when": "After 1 week with CBC report",
                  "condition": None, "with_reports": True, "with_referral": False, "basis": "said", "source_turns": [11]},
    "referrals": [], "red_flags_safety_net": [],
    "consult_boundary": {"suspected": False, "foreign_turns": [], "reason": None},
    "uncertainties": [],
}
FEVER_B = ("Co-morbidities:\nPresenting Complaint: Fever (3 days). Body pain.\nExamination: Temperature - 101 F; Throat - red; Chest - clear\n"
           "Diagnoses: ?Viral fever\nPlan of Management:\nSurgery or Procedure:\nMedication: paracetamol 1 g three times a day x 3 days\n"
           "Further Investigation: CBC (today)\nFollow up: follow up with reports; 2026-10-12; After 1 week with CBC report\nRefer to:\n"
           "General Advice: Drink plenty of water; Take rest\n")
FEVER_SIGNED = {"medicines": [{"name": "Paracetamol 1000 mg", "strength": "1000 mg", "frequency": "TDS", "duration": "3 days"}],
                "diagnoses": ["Viral fever"], "icd_codes": ["B34.9"], "investigations": ["CBC"], "comorbidities": [],
                "advice": "Plenty of oral fluids, rest", "follow_up": {"type": "FOLLOW_UP_WITH_REPORTS", "date": "2026-10-12", "text": "Review with CBC"}}
FEVER_J = {
    "drugs_ref": [{"ref_idx": 0, "name": "Paracetamol 1000 mg", "said_aloud": "named", "evidence_turns": [7], "matched_pred_idx": 0, "matched_kept_k": None,
                   "match": "exact", "dose": {"strength": "match", "frequency": "match", "duration": "match"}, "slot_k": None, "slot_fields": {}}],
    "drugs_pred": [{"pred_idx": 0, "label": "paracetamol 1 g", "matched_ref_idx": 0, "tape_supported": "yes", "order_status_ok": True, "issue": None}],
    "comorbidities_pred": [], "kept_out_review": [],
    "completion_review": [],
    "diagnosis": {"ref": "Viral fever", "pred": "Viral fever", "match": "exact", "icd_ref": "B34.9", "icd_pred": "B34.9", "icd_match": "exact", "dx_oversplit": False},
    "investigations_ref": [{"name": "CBC", "said_aloud": "yes", "matched": True}],
    "investigations_pred": [{"name": "CBC", "matched_ref": True, "tape_supported": "yes", "order_status_ok": True, "issue": None}],
    "referrals_pred": [], "advice_ref": [{"text": "fluids", "said_aloud": "yes", "matched": True}],
    "advice_pred": [{"text": "Drink plenty of water", "matched_ref": True, "tape_supported": "yes"}], "advice_too_long": False,
    "follow_up": {"ref": "with CBC", "pred": "with reports 2026-10-12", "match": "match", "type_ok": True},
    "hallucinations": [], "omissions_said_aloud": [], "omissions_not_said_aloud": [], "stage_b_additions": [], "comment": "Synthetic fixture.",
}

# ---------------------------------------------------------------- 2. synth-boundary-knee
KNEE = [
    seg(0, 7, "0", "So continue pantoprazole 40 before breakfast for two weeks."),
    seg(8, 13, "2", "Okay, thank you, I will come next month."),
    seg(14, 16, "0", "Take care."),
    seg(70, 75, "0", "Come in. What happened to your knee?"),
    seg(76, 84, "1", "Right knee pain for two months, worse on stairs."),
    seg(85, 91, "3", "She also takes metformin for sugar."),
    seg(92, 95, "0", "How long have you had sugar?"),
    seg(96, 98, "1", "Five years."),
    seg(104, 110, "0", "Let me examine the knee."),
    seg(120, 127, "0", "Apply this gel twice a day for ten days."),
    seg(128, 133, "0", "Get an X-ray of the right knee."),
    seg(134, 139, "0", "Avoid climbing stairs."),
    seg(140, 146, "0", "Come back if the pain does not settle."),
]
KNEE_A = {
    "schema": "even.encounter.v2",
    "speaker_roles": [{"speaker": "S0", "role": "doctor", "confidence": 1.0}, {"speaker": "S1", "role": "patient", "confidence": 1.0},
                      {"speaker": "S2", "role": "patient", "confidence": 1.0}, {"speaker": "S3", "role": "attendant", "confidence": 1.0}],
    "language_notes": "English",
    "chief_complaint": {"text": "Right knee pain", "duration": "2 months", "basis": "said", "source_turns": [4]},
    "hpi": [{"text": "Worse on stairs", "basis": "said", "source_turns": [4]}],
    "comorbidities": [{"name": "Diabetes mellitus", "duration": {"value": 5, "unit": "YEARS"}, "on_treatment": True, "basis": "said", "source_turns": [5, 7]}],
    "history": [],
    "drug_history": [{"name_as_said": "metformin", "text": "Takes metformin for sugar", "current": True, "reported_by": "attendant", "source_turns": [5]}],
    "allergy_history": [],
    "examination": [{"performed": "Right knee", "finding": None, "basis": "said", "source_turns": [8]}],
    "vitals": [],
    "assessment": {"summary": "Knee pain, likely degenerative", "basis": "inferred", "source_turns": [4]},
    "diagnoses": [
        {"label": "Osteoarthritis of right knee", "rank": "primary", "doctor_named": False, "status": "provisional", "basis": "inferred", "icd10_suggestion": "M17.11", "icd10_confidence": 0.5, "source_turns": [4, 10]},
        {"label": "Knee pain", "rank": "secondary", "doctor_named": False, "status": "confirmed", "basis": "said", "icd10_suggestion": "M25.561", "icd10_confidence": 0.5, "source_turns": [4]}],
    "plan": [],
    "prescription": [{"action": "continue", "decision_turn": 0, "generic": "pantoprazole", "brand_as_said": None, "name_interpretation": None,
                      "strength": "40 mg", "strength_said_by": "doctor", "strength_turn": 0, "dosage_form": "tablet", "route": "oral",
                      "frequency": "once daily before breakfast", "duration": "2 weeks", "instructions": "before breakfast", "basis": "said",
                      "confidence": 0.8, "source_quote_turn": 0, "source_turns": [0]}],
    "regimen_slots": [{"dosage_form": "gel", "frequency": "twice a day", "duration": "10 days", "timing": None, "drug_class_said": None,
                       "indication_said": "knee pain", "quote_turn": 9, "source_turns": [9], "confidence": 0.7}],
    "investigations": [{"name": "X-ray right knee", "order_status": "ordered", "timing": None, "decision_turn": 10, "basis": "said", "source_turns": [10]}],
    "advice": [{"text": "Avoid climbing stairs", "basis": "said", "source_turns": [11]}],
    "follow_up": {"type": None, "interval": None, "date": None, "when": None, "condition": "Come back if the pain does not settle",
                  "with_reports": False, "with_referral": False, "basis": "said", "source_turns": [12]},
    "referrals": [], "red_flags_safety_net": [],
    "consult_boundary": {"suspected": True, "foreign_turns": [0, 1, 2], "reason": "goodbye to a previous patient before a new greeting"},
    "uncertainties": [],
}
KNEE_B = ("Co-morbidities: Diabetes mellitus\nPresenting Complaint: Right knee pain (2 months). Worse on stairs.\nExamination:\n"
          "Diagnoses: ?Osteoarthritis of right knee\nPlan of Management:\nSurgery or Procedure:\nMedication: pantoprazole 40 mg once daily x 2 weeks\n"
          "Further Investigation: X-ray right knee\nFollow up: if required; Come back if the pain does not settle\nRefer to:\nGeneral Advice: Avoid climbing stairs\n")
KNEE_SIGNED = {"medicines": [{"name": "Diclofenac gel", "frequency": "BD", "duration": "10 days"}, {"name": "Metformin 500 mg", "frequency": "BD", "duration": "continue"}],
               "diagnoses": ["Osteoarthritis knee"], "icd_codes": ["M17.1"], "investigations": ["X-ray knee AP/lateral"],
               "comorbidities": ["Type 2 diabetes mellitus"], "advice": "Avoid stairs", "follow_up": {"type": "IF_REQUIRED", "text": "SOS"}}
KNEE_J = {
    "drugs_ref": [{"ref_idx": 0, "name": "Diclofenac gel", "said_aloud": "regimen_only", "evidence_turns": [9], "matched_pred_idx": None, "matched_kept_k": None,
                   "match": "none", "dose": {}, "slot_k": 2, "slot_fields": {"frequency": "match", "duration": "match"}},
                  {"ref_idx": 1, "name": "Metformin 500 mg", "said_aloud": "named", "evidence_turns": [5], "matched_pred_idx": None, "matched_kept_k": 3,
                   "match": "none", "dose": {}, "slot_k": None, "slot_fields": {}}],
    "drugs_pred": [], "comorbidities_pred": [{"name": "Diabetes mellitus", "valid": True, "category": None}],
    "kept_out_review": [{"k": 0, "item": "pantoprazole", "verdict": "hallucination_prevented", "why": "previous patient's order"}],
    "completion_review": [{"c": 0, "kind": "exam_missing", "verdict": "unclear", "why": ""}, {"c": 1, "kind": "regimen_slot", "verdict": "needed", "why": "gel unnamed"},
                          {"c": 2, "kind": "drug_history", "verdict": "needed", "why": "metformin continued in reference"},
                          {"c": 3, "kind": "boundary_review", "verdict": "needed", "why": "previous patient at clip start"}],
    "diagnosis": {"ref": "Osteoarthritis knee", "pred": "Osteoarthritis of right knee", "match": "exact", "icd_ref": "M17.1", "icd_pred": "M17.11", "icd_match": "category", "dx_oversplit": False},
    "investigations_ref": [{"name": "X-ray knee", "said_aloud": "yes", "matched": True}],
    "investigations_pred": [{"name": "X-ray right knee", "matched_ref": True, "tape_supported": "yes", "order_status_ok": True, "issue": None}],
    "referrals_pred": [], "advice_ref": [{"text": "Avoid stairs", "said_aloud": "yes", "matched": True}],
    "advice_pred": [{"text": "Avoid climbing stairs", "matched_ref": True, "tape_supported": "yes"}], "advice_too_long": False,
    "follow_up": {"ref": "SOS", "pred": "if required", "match": "match", "type_ok": True},
    "hallucinations": [], "omissions_said_aloud": [], "omissions_not_said_aloud": [{"field": "medicine", "item": "metformin dose"}],
    "stage_b_additions": [], "comment": "Synthetic fixture.",
}

# ---------------------------------------------------------------- 3. synth-cough-native (no role track, no English pass)
COUGH = [
    seg(0, 3, "0", "Namaste, batao kya hua?", "hi"),
    seg(4, 9, "1", "तीन दिन से खांसी है और गले में दर्द।", "hi"),
    seg(10, 13, "0", "Bukhar hai? Saans phoolti hai?", "hi"),
    seg(14, 16, "1", "Bukhar nahi hai.", "hi"),
    seg(18, 24, "0", "Gala laal hai, chest clear hai.", "hi"),
    seg(26, 33, "0", "Ascoril syrup 5 ml din mein teen baar, paanch din.", "hi"),
    seg(34, 40, "0", "Aur ek tablet raat ko sone se pehle, paanch din.", "hi"),
    seg(41, 45, "0", "Garam paani se garare karo.", "hi"),
    seg(46, 49, "0", "Do hafte baad dikhana.", "hi"),
]
COUGH_A = {
    "schema": "even.encounter.v2",
    "speaker_roles": [{"speaker": "S0", "role": "doctor", "confidence": 0.9}, {"speaker": "S1", "role": "patient", "confidence": 0.9}],
    "language_notes": "Romanised and Devanagari Hindi, no English pass",
    "chief_complaint": {"text": "Cough and sore throat", "duration": "3 days", "basis": "said", "source_turns": [1]},
    "hpi": [{"text": "No fever", "basis": "said", "source_turns": [3]}],
    "comorbidities": [], "history": [], "drug_history": [], "allergy_history": [],
    "examination": [{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [4]},
                    {"performed": "Chest", "finding": "clear", "basis": "said", "source_turns": [4]}],
    "vitals": [], "assessment": {"summary": "Upper respiratory infection", "basis": "inferred", "source_turns": [1, 4]},
    "diagnoses": [{"label": "Acute pharyngitis", "rank": "primary", "doctor_named": False, "status": "provisional", "basis": "inferred", "icd10_suggestion": "J02.9", "icd10_confidence": 0.5, "source_turns": [1, 4]}],
    "plan": [],
    "prescription": [{"action": "start", "decision_turn": 5, "generic": None, "brand_as_said": "Ascoril", "name_interpretation": None,
                      "strength": "5 ml", "strength_said_by": "doctor", "strength_turn": 5, "dosage_form": "syrup", "route": "oral",
                      "frequency": "3 times a day", "duration": "5 days", "instructions": None, "basis": "said", "confidence": 0.8,
                      "source_quote_turn": 5, "source_turns": [5]}],
    "regimen_slots": [{"dosage_form": "tablet", "frequency": "once at night", "duration": "5 days", "timing": "at bedtime", "drug_class_said": None,
                       "indication_said": None, "quote_turn": 6, "source_turns": [6], "confidence": 0.6}],
    "investigations": [],
    "advice": [{"text": "Gargle with warm water", "basis": "said", "source_turns": [7]}],
    "follow_up": {"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 2, "unit": "WEEKS"}, "date": None, "when": None, "condition": None,
                  "with_reports": False, "with_referral": False, "basis": "said", "source_turns": [8]},
    "referrals": [], "red_flags_safety_net": [],
    "consult_boundary": {"suspected": False, "foreign_turns": [], "reason": None},
    "uncertainties": [],
}
COUGH_SIGNED = {"medicines": [{"name": "Ascoril LS syrup", "strength": "5 ml", "frequency": "TDS", "duration": "5 days"},
                              {"name": "Levocetirizine 5 mg", "frequency": "HS", "duration": "5 days"}],
                "diagnoses": ["Acute pharyngitis"], "icd_codes": ["J02.9"], "investigations": [], "comorbidities": [],
                "advice": "Warm water gargles", "follow_up": {"type": "MANDATORY_FOLLOW_UP", "date": "2026-10-19"}}
COUGH_J = {
    "drugs_ref": [{"ref_idx": 0, "name": "Ascoril LS syrup", "said_aloud": "named", "evidence_turns": [5], "matched_pred_idx": 0, "matched_kept_k": None,
                   "match": "same_generic", "dose": {"strength": "match", "frequency": "match", "duration": "match"}, "slot_k": None, "slot_fields": {}},
                  {"ref_idx": 1, "name": "Levocetirizine 5 mg", "said_aloud": "regimen_only", "evidence_turns": [6], "matched_pred_idx": None, "matched_kept_k": None,
                   "match": "none", "dose": {}, "slot_k": 0, "slot_fields": {"frequency": "match", "duration": "match"}}],
    "drugs_pred": [{"pred_idx": 0, "label": "Ascoril 5 ml", "matched_ref_idx": 0, "tape_supported": "yes", "order_status_ok": True, "issue": None}],
    "comorbidities_pred": [], "kept_out_review": [],
    "completion_review": [{"c": 0, "kind": "regimen_slot", "verdict": "needed", "why": "tablet unnamed"}],
    "diagnosis": {"ref": "Acute pharyngitis", "pred": "Acute pharyngitis", "match": "exact", "icd_ref": "J02.9", "icd_pred": "J02.9", "icd_match": "exact", "dx_oversplit": False},
    "investigations_ref": [], "investigations_pred": [], "referrals_pred": [],
    "advice_ref": [{"text": "gargles", "said_aloud": "yes", "matched": True}],
    "advice_pred": [{"text": "Gargle with warm water", "matched_ref": True, "tape_supported": "yes"}], "advice_too_long": False,
    "follow_up": {"ref": "2026-10-19", "pred": "2026-10-19", "match": "match", "type_ok": True},
    "hallucinations": [], "omissions_said_aloud": [], "omissions_not_said_aloud": [], "stage_b_additions": [], "comment": "Synthetic fixture.",
}


def main() -> None:
    c, m = HERE / "consults", HERE / "model"
    clip = lambda segs, room: {"t0_ms": T0, "t1_ms": T0 + 150_000 if room == "synth-room-2" else segs[-1]["t1_ms"] + 2000, "room_slug": room}
    # 1
    write(c / "synth-fever-dose" / "transcript.json", {"consult_uid": "synth-fever-dose", "clip": clip(FEVER, "synth-room-1"), "language_code": "en-IN",
                                                       "model_translate": None, "english_segments": FEVER})
    write(c / "synth-fever-dose" / "role.json", role_track(FEVER, {"0": "doctor", "1": "patient"},
                                                           {"map": {"0": "doctor", "1": "patient"}, "attender_present": False, "two_consults": {"flag": False}, "diar_partial": False},
                                                           shift_ms=300))
    write(c / "synth-fever-dose" / "meta.json", {"room": "synth-room-1", "specialty": "General Medicine"})
    write(c / "synth-fever-dose" / "signed.json", FEVER_SIGNED)
    write(m / "synth-fever-dose" / "stageA.json", FEVER_A)
    write(m / "synth-fever-dose" / "stageB.txt", FEVER_B)
    write(m / "synth-fever-dose" / "judge.json", FEVER_J)
    # 2
    write(c / "synth-boundary-knee" / "transcript.json", {"consult_uid": "synth-boundary-knee", "clip": clip(KNEE, "synth-room-2"), "language_code": "en-IN",
                                                          "model_translate": None, "english_segments": KNEE})
    write(c / "synth-boundary-knee" / "role.json", role_track(KNEE, {"0": "doctor", "1": "patient", "2": "patient", "3": "attender"},
                                                              {"map": {"0": "doctor", "1": "patient", "2": "patient", "3": "attender"}, "attender_present": True,
                                                               "two_consults": {"flag": True, "gap_at_s": 60}, "diar_partial": False}))
    write(c / "synth-boundary-knee" / "meta.json", {"room": "synth-room-2", "specialty": "Orthopaedics"})
    write(c / "synth-boundary-knee" / "signed.json", KNEE_SIGNED)
    write(m / "synth-boundary-knee" / "stageA.json", KNEE_A)
    write(m / "synth-boundary-knee" / "stageB.txt", KNEE_B)
    write(m / "synth-boundary-knee" / "judge.json", KNEE_J)
    # 3
    write(c / "synth-cough-native" / "transcript.json", {"consult_uid": "synth-cough-native", "clip": clip(COUGH, "synth-room-3"), "language_code": "hi-IN",
                                                         "native_segments": COUGH})
    write(c / "synth-cough-native" / "meta.json", {"room": "synth-room-3", "specialty": "General Medicine"})
    write(c / "synth-cough-native" / "signed.json", COUGH_SIGNED)
    write(m / "synth-cough-native" / "stageA.json", COUGH_A)
    write(m / "synth-cough-native" / "judge.json", COUGH_J)
    print("wrote", c, m)


if __name__ == "__main__":
    main()
