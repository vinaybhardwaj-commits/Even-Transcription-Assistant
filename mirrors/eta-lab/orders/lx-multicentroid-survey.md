# ORDER — lx — RESEARCHER — what exists for multi-centroid voice profiles?

Report facts. Build nothing. Mark anything unverified UNVERIFIED. Read the findings ledger first.

## V's two decisions, verbatim
1. *"Let's just stick to harvesting."* — no special enrolment recordings. Voiceprints come from audio
   already captured.
2. *"I do think we need to build a multicentroid profile on each doctor so we can allow them to use
   the ETA on their phones as well."*

So each doctor gets **one centroid per acoustic domain** — room (TONOR, across the room) and phone
(near-field), possibly more — and matching uses the one that fits the audio. This is the direct fix
for the domain mismatch you found: one close-mic centroid matched against room audio, nothing
compensating.

## Before anyone designs, I need to know what already exists — we have been bitten twice this
## project by commissioning things that were already built.

1. **`docs/handoff/ETA-E1-MULTI-CENTROID-PLAN-14-SEP-2026.md`** — read it. What does it propose, how far
   did it get, was any of it built, and does it already answer V's requirement? Summarise its design
   and its status in plain terms.
2. **Migration 0108 `voice_print_generation`**: it is keyed unique on `(clinician_id, generation)` and
   has `origin` in (`enrolment_clip`, `room_audio`). Can it hold **several simultaneous centroids per
   clinician, one per domain**, or does its design assume one current centroid per clinician? Say
   whether multi-centroid needs a new column or table, or fits as-is.
3. **The matcher already uses different thresholds by context** — 0.65 room, 0.78 phone, 0.82 passive.
   Where is the context decided, and does it know which domain a piece of audio came from at match
   time? If it does, domain-aware centroid selection may be a small change; if it does not, that is
   the hard part and I need to know.
4. **Phone-domain harvest material.** ETA began as a phone app with doctor login (PIN). Count, per
   clinician: phone/encounter sessions recorded, total audio minutes, and whether that audio is still
   in R2. This matters because a doctor's own phone sessions are near-field audio we already hold.
5. **How would we tell the doctor's voice from the patient's inside a phone session?** The login
   says whose *session* it is, not whose *voice* each segment is. Report whether diarization runs on
   phone sessions today, and whether a doctor's sessions share one recurring speaker across many
   patients — the doctor is the voice present in all of them; patients change. State plainly whether
   the data supports that, with numbers, or whether it is UNVERIFIED.

## One thing to flag, not decide
V ruled out "proxies" as ground truth for room audio — rosters, room bindings, queue data. Whether a
doctor's **login on their own phone session** counts as a proxy is his call, not ours. Report the facts
that bear on it; do not argue either way.

## Not allowed
Build nothing, enrol nobody, touch no centroid, print no transcript text or patient content.
Counts, ids, durations, file:line only.

## Output
Five numbered answers. Append measured findings to the ledger (append-only, rule 7). CAP 400 words.
