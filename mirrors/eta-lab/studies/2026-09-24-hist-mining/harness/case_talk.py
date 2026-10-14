#!/usr/bin/env python3
"""case_talk.py — FLAG (never a veto) for clinician-to-clinician CASE TALK about an absent patient (pre-op presentation, ward/OT handover), which is not a proposal made TO a patient (eta-refuter-2 #652: CT02 was exactly this;
v3 greyed this kind of talk). Cues were fixed from domain knowledge BEFORE any labelled passage was scored; the threshold is set a priori (>= 3 DISTINCT cue kinds in the passage + its context turns).
Five kinds: case_intro (known case of / k/c/o / NN-year-old / presenting with / POD n), preop_work (pre-op, PAC, fitness, anaesthesia, airway, intubation, physician/cardiology opinion, NBM, consent taken, blood arranged),
labs_talk (HbA1c, creatinine, haemoglobin, platelets, TLC, INR, 'ECG is', 'EF is'), third_person (the/this patient, 'she/he has/was/underwent'), ot_list (OT list/tomorrow, scheduled for tomorrow, listed for).
NOT done: the structural cue 'no second speaker answering' (needs speaker turns; production room_turn_speaker has them, the fixture excerpts do not).
  case_talk(turns) -> {"kinds": [...], "n_kinds": int, "staff_case_talk": bool}       python3 case_talk.py --selftest"""
import re, sys
CUES = {
    "case_intro": re.compile(r"\b(?:known\s+case\s+of|k/?c/?o|case\s+of|\d{1,3}[\s\-]?(?:years?|yrs?)[\s\-]?(?:old)?|yo\s+(?:male|female)|presenting\s+with|admitted\s+(?:with|for)|post[\s\-]?op(?:erative)?\s+day|pod\s?\d)\b"),
    "preop_work": re.compile(r"\b(?:pre[\s\-]?op(?:erative)?|pac|fitness|an(?:a)?esth\w*|airway|intubat\w*|physician\s+opinion|cardiology\s+opinion|nbm|npo|consent\s+taken|high[\s\-]risk\s+consent|blood\s+arranged|cross[\s\-]?match\w*)\b"),
    "labs_talk": re.compile(r"\b(?:hb\s?a1c|creatinine|h(?:a)?emoglobin|platelets?|tlc|inr|ecg\s+(?:is|was)|ef\s+is|2d\s?echo\s+(?:is|was|shows))\b"),
    "third_person": re.compile(r"\b(?:the|this)\s+patient\b|\bpatient\s+(?:has|is|was|had|came)\b|\b(?:she|he)\s+(?:has|is|was|had|came|underwent|is\s+a)\b"),
    "ot_list": re.compile(r"\b(?:ot\s+(?:list|tomorrow|today)|scheduled\s+for\s+(?:tomorrow|today)|on\s+the\s+(?:ot\s+)?list|listed\s+for|tomorrow'?s\s+list)\b"),
}
MIN_KINDS = 3
def case_talk(turns):
    t = " ".join(x for x in turns if x).lower()
    kinds = [k for k, rx in CUES.items() if rx.search(t)]
    return {"kinds": kinds, "n_kinds": len(kinds), "staff_case_talk": len(kinds) >= MIN_KINDS}
def selftest():
    staff = ["this is a known case of type 2 diabetes, 58 year old female, hba1c is 8, for ot tomorrow. pre op fitness pending, anaesthesia to check airway",
             "the patient was admitted with pain, creatinine is 1.2, physician opinion taken, scheduled for tomorrow"]
    consult = ["come back with the hearing test and the ct scan and we will decide", "how long has the pain been there? about two weeks. ok, we will do a scan and see you next week",
               "take this tablet twice a day after food, and the scan of your knee is not needed now"]
    for x in staff: assert case_talk([x])["staff_case_talk"], x
    for x in consult: assert not case_talk([x])["staff_case_talk"], x
    assert case_talk([])["n_kinds"] == 0 and case_talk([None, ""])["staff_case_talk"] is False
    assert not case_talk(["the patient has pain. she is here. pre op."])["staff_case_talk"], "two kinds are below the a-priori threshold of 3"
    print("selftest OK (synthetic): staff case talk flagged, ordinary consult talk not, threshold 3 distinct kinds, empty input safe")
if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else print(__doc__)
