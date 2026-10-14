# H-1 — Jev U9 surgery-recommendation wording, DRAFT (23 Sep 2026)

**STATUS: SCORED 23 Sep 2026 (jev-1.13.0) — see RESULTS-23-SEP.md.** This file is the v1 wording as drafted; the v2 firmness/urgency fix is in RESULTS. (Originally drafted before even-jev was reachable from this box.)

## Fields, per H-1's order text, and how each maps to a Jev primitive

Six separate questions, batched in one askJev/jev_ask call per consult (fan-out — plan principle 7),
each independently confidence-banded. `procedure` is **not drafted here** — H-1 asks for "a free
label mapped to a fixed list + 'other'", and no fixed procedure taxonomy exists yet in any order or
finding (H-3's findings give `procedure_name` as a free string from `surgery_cases`, not a closed
list). That list needs a ruling from V/Fable before a `choice` question can be worded for it — flagged
here, not invented.

### recommended (choice) — the core field, both purposes turn on this one
```
type: "choice"
instructions: "Based on this consultation, did the clinician recommend a surgical or interventional
  procedure to the patient? 'yes' = a specific procedure was proposed as something the patient should
  have. 'discussed_not_recommended' = a procedure was named or explained (e.g. as an option, or why it
  is NOT needed now) but not put forward as the recommended course. 'no' = no surgical or interventional
  procedure was discussed at all."
criteria: {
  yes: "a procedure was recommended to the patient",
  discussed_not_recommended: "a procedure was named/explained but not recommended",
  no: "no surgical or interventional procedure was discussed",
}
```

### firmness (choice) — only meaningful when recommended=yes; ask it anyway, "not_applicable" absorbs the rest
```
type: "choice"
instructions: "How firmly did the clinician put the recommendation? Only meaningful if a procedure was
  recommended; if none was recommended, answer not_applicable."
criteria: {
  suggested: "mentioned as one option among others, low pressure",
  advised: "clinician's clear professional opinion that the patient should have it",
  strongly_advised: "clinician pressed the point, urgency or repetition in the framing",
  scheduled: "a date/booking step was already set in motion during this consult",
  not_applicable: "no procedure was recommended in this consult",
}
```

### patient_response (choice)
```
type: "choice"
instructions: "How did the patient respond to the recommendation, in this consult? Only meaningful if
  a procedure was recommended or discussed; otherwise answer not_stated."
criteria: {
  agreed: "patient accepted or agreed to proceed",
  will_think: "patient asked for time, said they would consider it",
  declined: "patient said no or pushed back",
  not_stated: "no procedure was recommended/discussed, or the patient's reaction was not captured",
}
```

### urgency_stated (noul) — P(yes)
"Did the clinician state any urgency or timeframe for the procedure (e.g. 'soon', 'before it gets
worse', 'within a month')? Answer only about EXPLICIT urgency language, not your own judgement of how
urgent the condition sounds."

### cost_discussed (noul) — P(yes)
"Was the cost of the procedure discussed in this consult (an amount, a range, insurance, or an explicit
mention that cost was NOT discussed yet)?"

### second_opinion_offered (noul) — P(yes)
"Did the clinician offer, or the patient ask about, getting a second opinion before proceeding?"

## H-2 (audit completeness) — deferred to the second wording round
H-2's five yes/no/unclear fields (indication, risks, alternatives incl. conservative management,
expected recovery, cost explained) are U8-shaped (lib/jev/prompts and the U8 trial in
../2026-09-23-jev-opp/TRIALS-23-SEP.md already proved that pattern STRONG). Not drafted this round —
H-1's `recommended` field is the one every other H-1/H-2 field depends on, so it is the one worth
getting right first; H-2 wording is a short follow-up once U9's core field is scored.
