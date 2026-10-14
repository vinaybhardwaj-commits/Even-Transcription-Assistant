# Jev prompt trials for ETA / EvenScribe — 2026-09-23

Transport: `even-jev-mcp` on `mini`, via `tailscale-shell run_on` piping JSON-RPC frames into `run.sh`.
First call of the session timed out at the hardcoded 30000ms Jev-API client timeout ("Jev did not respond
within 30000ms") — looks like a cold TLS/connection warm-up, not a real outage. Every call after that
(34 more `jev_ask` calls, spanning 8 separate `run.sh` invocations, several with 4-5 fixtures fanned per
invocation) returned `status=200` cleanly. Multiple `tools/call` frames in one `run.sh` stdin stream work
fine — no need for one process per fixture.

All fixtures below are synthetic, written for this trial, no real patient data.

Model: `jev-1.13.0`. Total `jev_ask` calls this session: 35 (1 timeout + 34 succeeded).
Total input tokens across the 34 successful calls: ~27,084. Cost at $42/B input tokens: **~$0.0011** (output is free).
Latency: mostly 350-800ms per call; a few calls in the 1.9-3.4s range (no pattern found, not correlated with
fixture length); the one timeout was the very first call of the session.

---

## U1 — Consult phase (choice)

Options: greeting / history_taking / examination / diagnosis_explained / prescribing / counselling_or_advice / closing / not_a_consultation / cannot_tell.
Wordings: w1 "which phase is this window part of", w2 "what are doctor and patient primarily doing".

| Fixture | Tests | w1 choice (p, conf) | w2 choice (p, conf) |
|---|---|---|---|
| F1 | pure greeting, no complaint yet | greeting (1.00, 1.00) | greeting (1.00, 1.00) |
| F2 | history_taking -> examination boundary (window spans both) | examination (1.00, 1.00) | examination (1.00, 1.00) |
| F3 | prescribing -> counselling_or_advice boundary | prescribing (0.89, 0.88) [counselling 0.11] | prescribing (0.89, 0.87) [counselling 0.11] |
| F4 | staff chit-chat, no patient present | not_a_consultation (1.00, 1.00) | not_a_consultation (0.99, 0.99) |

**Verdict: STRONG.** Both wordings agree everywhere. Unambiguous fixtures get full confidence; the genuinely
mixed prescribing/counselling window gets a sensible 0.89/0.11 split rather than a false-confident pick.
Best wording: tie (w1 marginally simpler, keep it).

## U2 — Consultation boundary (noul x2: starts / ends)

State {W1, W2, W3}. Wordings: v1 direct, v2 "monitoring system" framing (same criteria, different instructions).

| Fixture | Tests | start_v1/v2 | end_v1/v2 |
|---|---|---|---|
| F1 | mid-consult, same patient throughout | 0.03 / 0.04 | 0.02 / 0.03 |
| F2 | hand-off between two patients inside W2 | 0.97 / 0.97 | 0.79 / 0.80 |
| F3 | start after an idle gap | 0.96 / 0.97 | 0.04 / 0.08 |
| F4 | idle staff chatter, long, no patient ever (length-bias probe) | 0.04 / 0.05 | 0.04 / 0.08 |

**Verdict: STRONG.** Every fixture lands on the correct side with a large margin (lowest true positive 0.79
[end, handoff] vs highest false positive 0.08 → margin 0.71). Critically, the long empty-chatter fixture (F4)
did **not** trigger a false "consultation" signal — no repeat of the J-A length-bias failure. Wordings track
within 1-4 points of each other; v1 marginally tighter. Best wording: v1.

## U3 — Speaker role per turn (choice)

State {previous_turn, T, next_turn}. Options: doctor / patient / family_or_attendant / nurse_or_staff / cannot_tell.

| Fixture | Tests | v1 choice (p, conf) | v2 choice (p, conf) |
|---|---|---|---|
| F1 | clear doctor turn (clinical question) | doctor (1.00, 1.00) | doctor (1.00, 1.00) |
| F2 | family/attendant speaking for a child ("iska khana...") | family_or_attendant (1.00, 1.00) | family_or_attendant (1.00, 0.99) |
| F3 (hard) | patient asking about their own medicine | patient (1.00, 1.00) | patient (1.00, 1.00) |
| F4 (hard) | doctor's one-word imperative "Baithiye." ("sit") | doctor (1.00, 1.00) | doctor (0.99, 0.99) [0.01 nurse_or_staff] |

**Verdict: STRONG.** All 4 fixtures correct, including both flagged "hard" cases — the one-word "sit" turn
resolves to doctor from context (prior nurse turn announcing the patient + next turn being the patient
greeting back) rather than defaulting to nurse_or_staff, and only picks up a token 0.01 hedge under w2.
Best wording: tie, slight edge to v2 for showing that hedge (more honest signal on the truly ambiguous turn).

## U4 — Note faithfulness (noul) — the most important use

State {transcript_excerpt, note_sentence}. 3 wordings (v1 plain, v2 "reviewer sign-off" framing, v3 "numbers must match exactly").

| Fixture | Tests | v1 / v2 / v3 P(supported) |
|---|---|---|
| F1 | exact support (Paracetamol 500mg bid pc x5d, matches) | 0.97 / 0.97 / 0.96 |
| F2 | **dose swap**: transcript "1 tablet twice daily" -> note "2 tablets once daily" | 0.03 / 0.02 / 0.02 |
| F3 | frequency change: transcript "3x/day" -> note "twice daily" | 0.02 / 0.02 / 0.02 |
| F4 | drug-name substitution: Azithromycin -> note says Amoxicillin | 0.02 / 0.02 / 0.02 |
| F5 | invented finding: note adds chest pain/SOB not in transcript | 0.02 / 0.02 / 0.02 |

**Verdict: STRONG — cleanest separation of all 8 uses.** Margin between the true case (0.96-0.97) and every
false case (0.02-0.03) is ~0.94-0.95, comfortably over the 0.3 bar, and every one of the four required
faithfulness-break types (dose swap, frequency change, drug substitution, invented finding) is caught
identically hard. All three wordings are within 1 point of each other — wording barely matters here, the
noul is already extremely well specified by the criteria alone. Best wording: v1 (simplest, ties the others).
This is the strongest single candidate for early production use.

## U5 — Cleanup safety (noul)

State {before_cleanup, after_cleanup}. 3 wordings (v1 plain, v2 "accidentally merged" framing, v3 "safe vs lossy compression" framing).

| Fixture | Tests | v1 / v2 / v3 P(lost content) |
|---|---|---|
| F1 | pure repeated loop collapsed | 0.07 / 0.06 / 0.21 |
| F2 | two different dose lines (Paracetamol AM, Azithromycin PM) merged into one vague line | 0.98 / 0.98 / 0.94 |
| F3 | "ek ek ek goli" (3 tablets) -> "ek goli" (1 tablet) — dose count silently dropped | 0.65 / 0.70 / 0.74 |
| F4 | filler words ("um", "matlab", "aa") removed, content intact | 0.08 / 0.09 / 0.15 |

**Verdict: PROMISING.** Direction is right on all 4 fixtures and margin is adequate (best case, v1: min-true
0.65 vs max-false 0.08 → margin 0.57), but confidence on the subtle "3 tablets silently became 1" fixture is
only 0.65-0.74 — solidly in the "cautious/queue for review" band, not the "act automatically" band. v3's
stricter instruction wording also raised false-positive risk on the true-negative fixtures (0.15-0.21 vs
0.06-0.09 for v1/v2). Best wording: v1. This use needs either a sharper criteria rewrite for the
dose-count-collapse case or a lower auto-approve threshold before it drives any automatic cleanup gating.

## U6 — Is this clinical (choice)

Options: clinical_consultation / staff_or_admin_talk / phone_call / social_chatter / garbled_or_no_real_speech / cannot_tell.

| Fixture | Tests | v1 choice (p, conf) | v2 choice (p, conf) |
|---|---|---|---|
| F1 | clear doctor-patient exchange | clinical_consultation (1.00, 1.00) | clinical_consultation (1.00, 1.00) |
| F2 | nurse/staff logistics talk, no patient | staff_or_admin_talk (1.00, 1.00) | staff_or_admin_talk (1.00, 1.00) |
| F3 | one-sided phone call | phone_call (1.00, 1.00) | phone_call (1.00, 1.00) |
| F4 | long run of filler syllables ("aa... theek hai theek hai...") — length-bias probe | garbled_or_no_real_speech (0.91, 0.90) | garbled_or_no_real_speech (0.94, 0.93) |

**Verdict: STRONG.** All 4 fixtures correct. The deliberately long, information-free filler fixture (the
exact failure mode that sank J-A) is still correctly classified as garbled with confidence 0.90-0.93, not
mistaken for coherent speech from sheer volume. Best wording: v2 (slightly higher confidence, 0.93 vs 0.90,
on the one fixture that matters most here).

## U7 — Clinician self-identification (choice, dynamic candidate list)

State {window_text, candidate_clinicians: [Dr. Dibyendu, Dr. A, Dr. B]}.

| Fixture | Tests | v1 choice (p, conf) | v2 choice (p, conf) |
|---|---|---|---|
| F1 | doctor self-introduces by name | Dr. Dibyendu (1.00, 1.00) | Dr. Dibyendu (1.00, 1.00) |
| F2 | nurse names the doctor in third person | Dr. B (0.99, 0.98) | Dr. B (1.00, 1.00) |
| F3 | no name mentioned at all | none_named (1.00, 1.00) | none_named (1.00, 1.00) |
| F4 (hard) | garbled/uncertain name reference ("Dr. ... something") | none_named (0.67, **0.58**) [cannot_tell 0.33] | none_named (0.84, 0.80) [cannot_tell 0.16] |

**Verdict: PROMISING — one miss.** F1-F3 are clean full-confidence hits. F4 was designed to land on
`cannot_tell`, but both wordings instead lean to `none_named` while explicitly splitting real probability
mass onto `cannot_tell` (33%/16%) and dropping confidence to 0.58-0.80 — i.e. it flags the ambiguity rather
than confidently mis-tagging it, but the top choice differs from the intended label. This exposes a real
criteria-wording gap: "none_named" and "cannot_tell" overlap when a name is uttered but too garbled to
resolve. Fix: tighten the `none_named` criterion to require that literally no name-like token appears, and
widen `cannot_tell` to cover "a name-like token appears but doesn't clearly resolve to one candidate."
Best wording for routing purposes: v1 (its lower confidence, 0.58, more honestly signals "send to review"
than v2's 0.80).

## U8 — Note completeness (4 independent nouls on one state)

allergies_asked / follow_up_interval_stated / red_flag_advice_given / medication_instructions_complete.

| Fixture | Designed truth (A/F/R/M) | Jev (A/F/R/M) | Match? |
|---|---|---|---|
| F1 "complete" note (asks allergy, gives dose+freq+duration but only says "ye tablet" — never names the drug) | T/T/T/T | 0.99/0.98/0.98/**0.06** | 3/4 — see note |
| F2 minimal note (no allergy Q, vague dosing, no follow-up, no red flags) | F/F/F/F | 0.03/0.04/0.03/0.03 | 4/4 |
| F3 allergy asked + fully named/dosed medicine, no follow-up, no red flags | T/F/F/T | 0.98/0.05/0.03/0.98 | 4/4 |
| F4 no allergy Q, vague medicine, follow-up + red-flag advice given | F/T/T/F | 0.03/0.98/0.98/0.03 | 4/4 |

**Verdict: STRONG**, with a fixture-writing lesson, not a model miss: F1's transcript says "ye tablet"
("this tablet") and never actually names a drug, so `medication_instructions_complete` correctly came back
false (0.06) even though I had intended F1 to be the "everything present" case. Jev applied the completeness
criterion (drug name + dose + frequency + duration) more strictly and correctly than my fixture did. F3,
which does name a real drug ("Paracetamol 500mg"), confirms the noul reads true (0.98) once a name is
actually present. Margin between true/false clusters across all 16 (question x fixture) cells is ~0.90-0.96.
One wording each was trialled (no wording variants needed — the criteria alone separate cleanly). This is a
second strong, low-risk candidate for early production use alongside U4.

---

## Summary table

| Use | Verdict | Best wording | Worst margin (true vs false) |
|---|---|---|---|
| U1 consult phase | STRONG | tie (w1) | ambiguous window: 0.89 vs next-best 0.11 (by design, not a miss) |
| U2 consult boundary | STRONG | v1 | 0.79 (end, handoff) vs 0.08 (false) = 0.71 |
| U3 speaker role | STRONG | tie (v2 shows honest hedge) | both hard cases resolved at ≥0.99 |
| U4 note faithfulness | STRONG | v1 (tie) | 0.96 vs 0.03 = 0.93 |
| U5 cleanup safety | PROMISING | v1 | 0.65 vs 0.08 = 0.57, but confidence on hard case only 0.65-0.74 |
| U6 is-this-clinical | STRONG | v2 | 0.91 vs ~0 = 0.91, incl. long-filler probe |
| U7 clinician self-ID | PROMISING | v1 | 1 fixture (garbled name) resolved to wrong top label, low-confidence hedge |
| U8 note completeness | STRONG | n/a (1 wording, clean) | 0.90-0.96 across all cells |
