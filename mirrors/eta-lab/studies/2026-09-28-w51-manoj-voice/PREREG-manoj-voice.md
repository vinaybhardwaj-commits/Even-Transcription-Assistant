# W51 Manoj-voice pre-registration — v2, rewritten to vj-refuter's checker terms

Owner lx; checker **vj-refuter**; scorer = this document's own rule, run once. Identity is by
**uid only** — `Tbvyk1V5ijpcD194ZOWi` (Kumar S) target, `eQvR4aMZIRv9l2UHpL8b` (Manoj C) control.
**Never the name "Manoj", never a schedule row** (vj-refuter #5296/#5297: the schedule text says
only "Dr Manoj (Ortho)"/"Dr Manoj (Physician)" with no surname, and both sit in ROOM 7 on the same
weekdays 12 h apart — a name- or room-keyed rule mixes them; V2's own audit found the ROOM N=OPD N
mapping does NOT hold in general, contradicted by Poornima/H05/c62 counterexamples, so it is a
prior only, never room truth).

**Still not posted — `eta-bus`/`even-jev` MCP disconnected this session (see HANDOVER).** v1 of
this file was never posted either; vj-refuter's #5296 (V1/V2 verdicts, read on
`~/oc/vj-refuter/reviews/W51-manoj-check.md`) and #5297 (checker terms, relayed by the user,
**item 4 truncated in relay** — see §7) reached me by a side channel while the bus was down. This
v2 responds to that guidance directly, still **unposted and unPASSed**. Everything computed below
(§3's coverage-gate table) is turn-timestamp arithmetic on data `dtree84` already embedded —
no new embedding, no cosine, no clustering, no scoring, per vj-refuter's "before ANY
embedding/cos/scoring" line.

## 1. Identity and windows (per vj-refuter #5297 term 1)

Target/control are the two `doctor_uid`s above, nothing else. A **window** = one PQM
`called_at`..`completed_at` interval for that uid (`queue_token_steps`, station='CONSULTATION'),
**padded ±180 s** (`PAD_S = 180`, fixed now, reused from `encounter_bounds.py`'s own `SLACK_MS` —
an already-calibrated value in this codebase for "how far a PQM edge can be off," not invented for
this study).

## 2. Room selection (per vj-refuter #5297 term 2 — supersedes v1's ROOM=OPD assumption entirely)

**No room is assumed.** Per window, the candidate search tests **every room with qualifying audio
in that window** (§3's gate) — the schedule is consulted only as a prior for sanity-reading results
afterward, never to pick which room to look in. This directly fixes v1's flaw: v1 attributed each
window to one schedule-implied room before looking, which is exactly the assumption V2 falsified
(Poornima's actual room contradicted her schedule row on the same days checked; H05's own booking
was in OPD 4 when Wed-ortho-Manoj's schedule row says ROOM 7; c62 sat in Vishal Naik's scheduled
slot).

## 3. Coverage gate (per vj-refuter #5297 term 3 — computed now, arithmetic only, not scoring)

A room qualifies for a window when it has **≥60 s of already-embedded turn duration** overlapping
the padded window (`X_S = 60`, fixed now: low enough not to discard a short consult, high enough to
drop near-zero-audio rooms; "seconds" = sum of turn durations overlapping the window, which can
exceed the window's own wall-clock span in a multi-speaker room — a richness signal for the gate,
not a dedup'd exclusive-speaking-time measure; that separation happens at the identity/coverage step
in §4-§5, not here).

**Computed for the 18-24 Sep sample** (the only PQM dates + `dtree84` room-days both available
locally right now — turns-`rd_*.json`'s own `s_ms`/`e_ms`, no cosine involved):

| Date | Kumar-S windows | Eligible-window counts by room (n meeting the ≥60s gate / total that day) |
|---|---|---|
| 18 Sep | 5 | **0 room-days have any `dtree84` coverage that date** — 0 eligible |
| 19 Sep | 10 | OPD 1=10/10, OPD 7=7/10, OPD 3=5/10, OPD 4=4/10, OPD 5=1/10 |
| 21 Sep | 8 | OPD 7=5/8, OPD 3=3/8, OPD 4=3/8, OPD 1=2/8, Cardiology=1/8, Third Floor=1/8 |
| 22 Sep | 10 | OPD 4=9/10, OPD 1=4/10, Cardiology=4/10, Third Floor=4/10, OPD 5=3/10, ORB3=2/10, OPD 7=2/10, OPD 6=2/10 |
| 23 Sep | 6 | Cardiology=6/6, OPD 7=6/6, OPD 5=4/6, OPD 4=4/6, OPD 6=3/6, OPD 3=2/6, Dietary=2/6, ORB3=2/6 |
| 24 Sep | 4 | ORB3=4/4, OPD 1=4/4, OPD 5=4/4, OPD 4=4/4, OPD 7=3/4, OPD 6=3/4, OPD 3=1/4 |

37 of 43 windows have at least one eligible room; 0/5 on 18 Sep (no `dtree84` coverage that date at
all — a data gap, not a negative result). **20 Sep has 0 Kumar-S PQM rows** (not a data gap: the
schedule has no Kumar-S slot that Sunday). Confirms vj-refuter's own note: OPD 7 23 Sep has 0
turns after 17:08 (Manoj C's 23 Sep evening consult, 19:01-20:20, is genuinely unrecorded in OPD 7,
consistent with V1).

**Reading this table:** it is deliberately unfiltered by plausibility (OPD 1 qualifying for 10/10
windows on 19 Sep almost certainly reflects a dense, likely non-clinical or shared-mic room, not
Kumar S) — §4's identity/dominance step, not this gate, is what tells the real occupant apart from
a room that merely has a lot of turns. Listing it un-pruned here is the point: the gate must be
named before looking at identity, exactly as asked.

**Not yet computed:** August and 25-27 Sep — `dtree84` has zero coverage there (already flagged in
`PLAN.md`), and PQM `pqm-*.csv` files were only found for 18-24 Sep locally (open item, §7.3).

## 4. Candidate identity and coverage/exclusivity scoring (frozen rule, NOT YET RUN)

For each (window, eligible room) pair from §3, the **occupant** is that room-day's dominant speaker
cluster inside the padded window (most turn-seconds, ties broken by highest `dtree84` `excess`).
**Identity across windows** is by centroid cosine ≥ **0.60** (H05/BATCH2-RULE's bar, reused) between
occupants, chained through a running reference seeded by the single highest-`excess` occurrence.
**Coverage** passes at **k/n ≥ 8, k from ≥3 distinct days and ≥2 distinct rooms** (the order's own
number was "N"; 8 is proposed, not tuned on a peek, vj-refuter may move it before the run only).
**Exclusivity**: the same identity's cosine to the dominant occupant of the SAME room during any
OTHER named doctor's own PQM windows (Room 4: Prashanth N, Abrar, Avinash; Room 7: Prathik, Manoj
C) must stay below 0.60 in ≥90% of that doctor's own eligible windows.

## 5. Voiceprint cross-check (descriptive, not a gate)

Report the candidate's centroid cosine against every stored print in `~/eta-data/vj/centroids/`
(Salanki, Banerjee, Ankit-TONOR). No stored Manoj print exists, so this is negative-control only —
the positive case rests on §4 plus V's blind listen (H05's own precedent: "NOT HIGH on its own
authority").

## 6. What is reported

§3's coverage-gate table (already above) plus, once §4 runs: coverage k/n with per-occurrence
`excess`/`contrast` (not just pass/fail), exclusivity share per named other doctor, the §5 cosine
table, and the order's 6 blind clip specs (4 inside Kumar-S-identity windows across different
days/rooms, 2 decoys including one explicit Manoj-C-evening clip). Counts, opaque ids, cosines and
timings only; no transcript text, no clip audio in git.

## 7. Exclusions and open items (per vj-refuter #5297 term 4 — RELAY TRUNCATED, best-effort read)

**#5297's item 4 ("Exclusions (R3): H...") was cut off in the relay before I could read the rest.**
Best-effort inference, flagged as inference not confirmed text: H05's own reference/minting days
(19 Sep OPD 4 c40, 23 Sep OPD 5 c62 + OPD 7 c200) are excluded from counting as NEW coverage
evidence for §4 — they were used to define the H05 family itself, so citing them again here would
be circular, mirroring the H05 result's own R3 rule ("the reference days used here... are neither
evidence nor minting audio for Manoj"). **This needs vj-refuter's literal text once the bus is
back** — do not treat my inference as the frozen rule until confirmed.

Other open items:
1. vj-refuter's PASS on this v2 (blocked on the bus).
2. Confirmation or correction of §7's R3 inference (blocked on the bus).
3. PQM source for 25-27 Sep (order says "pull later days via the linker pqm_truth"; not found
   under `~/eta-data/gcp-archive/voice-lab-1/home/vj/link/` locally — need linker).
4. `dtree84` backfill for August + 25-27 Sep (zero coverage today) before §3's table can extend to
   the order's full window — sized by a timed pilot in `PLAN.md`, not guessed.
5. Room-uid resolution for Room 4/7's other named doctors (Prashanth N, Abrar, Avinash, Prathik) —
   needed for §4's exclusivity check, not yet pulled.

## What this v2 does NOT change from the order's DO-NOTs

No Mini load 08:15-20:30. No model training. No centroid written to production. No audio moved off
box/R2. No retry after seeing a result — a weak §4 outcome is reported weak, not re-tuned.
