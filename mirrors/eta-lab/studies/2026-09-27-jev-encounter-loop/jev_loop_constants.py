"""Frozen constants for the W44 Jev encounter-loop (lx): questions, thresholds, candidate phrase lists —
the one file humans review and tune (skill rule 11). Every value here is developed/tuned ONLY against a
room-day at or before 25 Sep (README "Development-vs-exit-test day split"; PREREG revision note,
eta-refuter-2 #4464 B1) — never against 26 Sep, which is the frozen exit-test day.
"""

JEV_MODEL = "jev-1.13.0"  # pinned unconditionally (eta-refuter-2 #4464 G4); prod's floating jev-latest is a separate concern
CHUNK_TARGET_MS = 60_000  # a chunk never splits a turn — this is a target, actual chunk length varies
SNAP_WINDOW_MS = 5_000    # a placed boundary snaps to the nearest acoustic activity edge within this window
PARTIAL_COVERAGE_SHARE = 0.20  # frozen in PREREG §4 (eta-refuter-2 #4464 G1): >20% translation_missing chunks -> PARTIAL COVERAGE

# ---- state-machine thresholds (§C) — two states, IN_ENCOUNTER / BETWEEN
OPEN_NOUL_T = 0.6
CLOSE_NOUL_T = 0.6
OPEN_PHASE_T = 0.5     # phase_probs["greeting_or_opening"] mass
CLOSE_PHASE_T = 0.5    # phase_probs["closing_or_follow_up_instructions"] mass
PATIENT_PRESENT_T = 0.5
NON_ENCOUNTER_PHASES = {"between_patients_or_admin", "staff_or_phone_talk"}

# ---- B. Jev question set (frozen — README §B; do not edit without re-freezing + re-dating dev day)
# Flattened to one STRING per option (eta-refuter-2 #4612 B1): the only proven-working Choice call in
# this repo (voice-jev/arms/common.py:118) sends option -> string, never a nested {what,not_for,
# examples} object, and nothing here has tested whether Jev accepts/rejects/silently-stringifies a
# dict. Rather than spend a real call to find out (no Fable go for that), each option folds `what` +
# the disambiguating `not_for` into one sentence, using the repo's proven format. Worked EXAMPLES are
# dropped entirely, not just flattened: eta-refuter-2 also flagged them against the prod prompt rule
# "no worked examples" (arm-d-v1, leakage) — a genuine second reason independent of the format
# question, so they are cut rather than folded in.
PHASE_OPTIONS = {
    "greeting_or_opening": ("the consultation is beginning — greeting, name/age, \"what brings you\", "
                             "inviting them to sit. NOT mid-consult small talk or closing pleasantries."),
    "history_taking": ("asking about symptoms, duration, past illness, medicines, allergies, family/social "
                        "history. NOT announcing a diagnosis or reading a prescription."),
    "examination": ("a physical exam happening or being directed — position instructions, findings said aloud, "
                     "instruments. NOT verbal-only history questions, or discussing a prior scan with no "
                     "hands-on exam."),
    "diagnosis_or_plan_discussion": ("explaining what is wrong, naming a diagnosis, discussing the plan in "
                                      "words. NOT history questions, or reading exact drug names/doses from a "
                                      "prescription."),
    "prescription_or_advice_readout": ("reading specific medicine names/doses/timings, diet/lifestyle advice, "
                                        "or test orders as instructions. NOT explaining the diagnosis in "
                                        "general terms."),
    "closing_or_follow_up_instructions": ("wrapping up — follow-up date, pharmacy/billing directions, goodbye. "
                                           "NOT the initial greeting, or the prescription readout itself."),
    "between_patients_or_admin": ("no patient present — paperwork, calling the next token, talking to "
                                   "reception, dead air. NOT any turn where a patient/attender is being "
                                   "addressed."),
    "staff_or_phone_talk": ("doctor/staff talking to each other or on the phone about something other than "
                             "the patient in the room. NOT talking to the patient/attender about their own "
                             "case."),
    "none_of_the_above": "does not clearly fit any option above.",
}

NOULS = {
    "new_patient": ("Is a different patient or attender being addressed in `chunk.text` than in `prev.text`? "
                     "Answer yes only on a clear signal (a new name/age/greeting, an explicit reference to the "
                     "next patient, or a distinct chief complaint that does not continue `prev.text`). Answer no "
                     "if `prev.text` is empty or clearly the same ongoing case."),
    "opening": ("Does `chunk.text` start a brand-new consultation — a greeting, taking the patient's name or age, "
                "asking what brings them in today, or inviting them to sit down? Answer no if this continues a "
                "consultation already in progress."),
    "closing": ("Does `chunk.text` end a consultation — naming a follow-up date, giving final medicine/pharmacy/"
                "billing directions, or a goodbye? Answer no if this is still the prescription discussion in "
                "progress, or a mid-consult remark."),
    "patient_present": ("Is a patient or their attender currently being spoken to, or spoken about as physically "
                         "present, in `chunk.text` — as opposed to staff/admin/phone talk with nobody present?"),
}

# ---- C. candidate regex phrase lists (code, not Jev — skill rule 10). English + a starter transliterated set for
# Kannada/Hindi/Tamil/Telugu/Malayalam. Reviewed/extended like deid.py's lexicon: a list humans grow, not weights.
OPENING_PHRASES = [
    r"\bcome in\b", r"\bsit down\b", r"\bwhat brings you\b", r"\bwhat is your name\b", r"\byour age\b",
    r"\bnext patient\b", r"\bnamaste\b", r"\bnamaskara\b", r"\bvanakkam\b",
    r"\bbanni\b",                      # Kannada "come" (transliterated)
    r"\baaiye\b", r"\bbaithiye\b",     # Hindi "come"/"sit" (transliterated)
    r"\bvaanga\b", r"\bvaango\b",      # Tamil "come" (transliterated)
    r"\bra?ndi\b",                     # Telugu "come" (transliterated, approximate)
]
CLOSING_PHRASES = [
    r"\bcome back\b", r"\bfollow[- ]?up\b", r"\bpharmacy\b", r"\bbilling\b", r"\bcounter\b",
    r"\btake care\b", r"\bthank you doctor\b", r"\bnext patient\b",
    r"\bhogi ba(nni)?\b",              # Kannada "go/come" closing (transliterated, approximate)
    r"\bdhanyavaad\b", r"\bdhanyawad\b",  # Hindi "thank you" (transliterated)
    r"\bnandri\b",                     # Tamil "thank you" (transliterated)
]
