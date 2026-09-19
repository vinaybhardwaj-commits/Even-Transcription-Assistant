"""
Arm D wording trial — SYNTHETIC fixtures. Use A.2 (docs/handoff/ETA-JEV-INTEGRATION.md).

EVERY LINE OF TEXT BELOW IS INVENTED. There is no real consultation, patient, doctor, room or
recording here — this is fabricated English written to look like a machine-translated OPD window,
so the ground-truth label is known with certainty (D1a, non-PHI, reproducible). Nothing here is a
transcript. It is the trial's necessary input and lives only in this file; the results file carries
ids, labels and scores only, never this text.

One synthetic outpatient day, 16 consecutive 30-second windows in order, spanning three patients
with staff/phone/silence gaps between them, so the transition questions (start/end) are judgeable
from the sequence exactly as Slice J2 would present it.

Labels per window (1 = the positive class for that noul question):
  clinical  : any clinical conversation between a clinician and a patient/attendant
  clinician : the treating doctor is speaking (asking/examining/explaining/prescribing)
  start     : a NEW patient's consultation begins in this window
  end       : the consultation in progress ends in this window
The collinearity-breaker is deliberate: W4 is patient-only clinical talk (clinical=1, clinician=0),
so the clinician question cannot simply track the clinical question. W8 is the doctor speaking, but
to staff about admin, not to a patient — a HARD negative for both questions (clinical=0, clinician=0),
because every clinician wording's criteria require the doctor addressing the patient clinically, not
merely the doctor's voice being present.
"""

SETTING = ("Outpatient consultation room in an Indian hospital. Transcript is machine-translated to "
           "English from Kannada, Hindi or English speech and may contain recognition errors. "
           "Windows are consecutive 30-second slices in order.")

# (id, text, clinical, clinician, start, end)
WINDOWS = [
    ("W1",  "so many files pending today. did you have lunch. no not yet. the printer is jammed again on that side.", 0, 0, 0, 0),
    ("W2",  "come in, please sit down. is this your first time here. yes doctor. alright, tell me, what is the trouble.", 1, 1, 1, 0),
    ("W3",  "since when is this cough. about five days. and any fever. at night yes, and no appetite since then.", 1, 1, 0, 0),
    ("W4",  "i also get chest pain when i cough hard, and last night i could not sleep, only sitting up gave relief.", 1, 0, 0, 0),
    ("W5",  "let me listen to your chest. take a deep breath. again. now from the back, breathe in and out slowly.", 1, 1, 0, 0),
    ("W6",  "this is a chest infection. i am starting an antibiotic and a cough syrup, take the tablet twice daily after food.", 1, 1, 0, 0),
    ("W7",  "come back in five days for review, sooner if the fever climbs. take care, get well soon. thank you doctor.", 1, 1, 0, 1),
    ("W8",  "sister, send in the next file please, and cancel my four o'clock, i will not finish in time otherwise.", 0, 0, 0, 0),
    ("W9",  "yes come, sit. what happened to you. my knee is swollen since two weeks, it pains going down stairs.", 1, 1, 1, 0),
    ("W10", "any injury before this. no doctor. let me see, does it hurt when i press here. yes there, a little.", 1, 1, 0, 0),
    ("W11", "get an x-ray of the knee and take this painkiller for five days. that is all, you may go, thank you.", 1, 1, 0, 1),
    ("W12", "hello, yes speaking. no the report is not ready, tell them tomorrow afternoon. okay, okay, bye.", 0, 0, 0, 0),
    ("W13", "come inside, sit please. first visit here. yes. good, tell me what is bothering you these days.", 1, 1, 1, 0),
    ("W14", "i have fever three days and body pain, and a headache mostly in the evening, medicine did not help.", 1, 0, 0, 0),
    ("W15", "drink plenty of water, this paracetamol if it rises, come back if it is not settling in two days, bye.", 1, 1, 0, 1),
    ("W16", "(long pause) (a chair scrapes) (footsteps in the corridor) (a door closes somewhere) (quiet)", 0, 0, 0, 0),
]

DIMS = ["clinical", "clinician", "start", "end"]

# Candidate wordings per question. Each is a full (instructions, criteria) package — wording IS both.
# v1 is the spec's §5.3 wording verbatim; the alternatives vary the framing only. No worked examples
# inside criteria (known leakage risk); criteria describe situations, not degrees.
WORDINGS = {
    "clinical": {
        "v1": {"instructions": "Does window {W} contain any clinical conversation between a clinician and a patient or attendant?",
               "criteria": {"true": "Medical talk about a patient is happening between a clinician and a patient or attendant.",
                            "false": "No medical talk with a patient is happening in this window."}},
        "medical": {"instructions": "In window {W}, is there medical talk about a patient's health — complaints, examination, diagnosis, treatment or advice — involving a clinician and a patient or attendant?",
                    "criteria": {"true": "The window carries talk about a patient's symptoms, examination, diagnosis, treatment or advice.",
                                 "false": "The window carries none of that — it is staff talk, a phone call, admin, or silence."}},
        "consult_vs_not": {"instructions": "Is window {W} part of an actual patient consultation, rather than staff chatter, a phone call, admin work, or silence?",
                           "criteria": {"true": "The window is inside a doctor-patient consultation.",
                                        "false": "The window is staff chatter, a phone call, admin work, noise or silence."}},
    },
    "clinician": {
        "v1": {"instructions": "Is the treating doctor speaking in window {W}?",
               "criteria": {"true": "A doctor is asking, examining, explaining or prescribing.",
                            "false": "Only patients, attendants, nurses or other staff speak, or nobody."}},
        "action": {"instructions": "In window {W}, does the treating clinician speak to the patient — asking about complaints, examining, explaining findings, or prescribing?",
                   "criteria": {"true": "The clinician speaks to the patient in a clinical way in this window.",
                                "false": "The clinician does not speak to the patient here; only the patient, an attendant or staff speak, or the clinician speaks only about non-clinical matters."}},
        "voice_present": {"instructions": "Can the treating doctor's own voice be heard addressing the patient in window {W}?",
                          "criteria": {"true": "The doctor addresses the patient in this window.",
                                       "false": "The doctor does not address the patient in this window."}},
    },
    "start": {
        "v1": {"instructions": "Does a new patient's consultation begin in window {W}, meaning a different patient from the one in the preceding windows starts being seen?",
               "criteria": {"true": "A different patient's visit clearly starts here.",
                            "false": "The same patient continues, or no consultation is happening."}},
        "transition": {"instructions": "Does window {W} mark the moment a different patient's visit starts — a new person greeted or seated and beginning to describe a fresh complaint, after the previous patient?",
                       "criteria": {"true": "A new, different patient's visit begins in this window.",
                                    "false": "The current patient continues, or there is a gap with no patient."}},
        "short": {"instructions": "In window {W}, does a new patient's visit begin?",
                  "criteria": {"true": "A new patient's visit begins here.",
                               "false": "It does not."}},
    },
    "end": {
        "v1": {"instructions": "Does the patient consultation that was in progress end in window {W}?",
               "criteria": {"true": "The visit wraps up here: final instructions, goodbye, patient leaves.",
                            "false": "The visit continues after this window, or there was no visit."}},
        "marker": {"instructions": "Does the current patient's visit finish in window {W} — final advice or follow-up given, thanks or goodbye, or the patient leaving?",
                   "criteria": {"true": "The current visit concludes in this window.",
                                "false": "The current visit carries on past this window, or no visit is in progress."}},
        "short": {"instructions": "In window {W}, does the current consultation end?",
                  "criteria": {"true": "The current consultation ends here.",
                               "false": "It does not."}},
    },
}
