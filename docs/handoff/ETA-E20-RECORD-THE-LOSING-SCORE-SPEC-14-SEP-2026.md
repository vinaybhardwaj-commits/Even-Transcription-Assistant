# ETA-E20 — record the score that lost · SPEC · 14 Sep 2026

This is R-F3b from `ETA-E1-RULINGS-14-SEP-2026.md`, and it goes **before** the rest of E1. Small, and
it unblocks a decision nothing else can unblock.

## 1. WHY THIS IS FIRST

`room_turn_speaker` holds **317 rows and zero names.** 151 reached the matcher and did not clear the
threshold; 166 straddle a boundary and never reached it.

`match_confidence` is NULL on every unnamed row. **So we cannot tell whether those 151 missed by 0.02
or by 0.30** — and that is exactly the number needed to set the threshold, which is the open question
behind room naming, the encounter path and the phone path all at once.

> **The system discards the only evidence that would settle its own open question.**

This is testing rule 12 in a new place: a refusal that does not become data leaves you arguing instead
of measuring. Three unratified thresholds (0.65 room, 0.70 encounter default, 0.78 phone) are currently
being argued about with no distribution to argue from.

## 2. WHAT TO BUILD

When the matcher returns a best candidate that does **not** clear the threshold, write the losing
score and the losing `clinician_id` onto the turn, alongside `no_role_reason = 'no_match'`.

**`role` stays NULL.** Nothing about naming changes. This round adds evidence and changes no decision.

- Do not reuse `match_confidence` for the losing value if that column's meaning is "the confidence of
  the name we assigned" — a NULL there currently means "unnamed", and overloading it makes every
  existing query ambiguous. Add a column whose name says what it is, and say in your report which you
  chose and why.
- Straddle turns never reach the matcher. They get nothing, and that is correct.
- Additive migration. Check `schema_migrations` for the next free number — **E1 wants 0094 and E18 may
  have taken it.**

## 3. WHAT THIS ROUND DOES NOT DO

- **Do not change any threshold.** Not 0.65, not 0.70, not 0.78.
- **Do not unify the three thresholds.** That is R-F3a and it needs the distribution this round
  produces. Unifying them now would mean picking a number by feel, which is the thing the whole
  exercise exists to avoid.
- Do not touch centroids, `voice_print`, `voice_centroid` or the loaders. That is the rest of E1.
- Do not change `speaker-clusters.ts` — `SPEAKER_MATCH_THRESHOLD` there is the voice-to-voice
  clustering cosine and is **not** the naming gate, however much its name suggests otherwise.

## 4. VERIFY

- **V1** A turn whose best candidate is below threshold gets the losing score and the losing
  clinician id, with `role` still NULL and `no_role_reason = 'no_match'`.
- **V2** A turn that **does** clear the threshold is unchanged in every respect — same role, same
  confidence, same row shape as today. Prove it against a fixture that passes today.
- **V3** A straddle turn still gets nothing and is untouched.
- **V4** The migration is additive and idempotent; existing rows keep their current meaning, and no
  query that reads `match_confidence` changes behaviour.
- **V5 Mutation check**, including one that writes the losing score into the *named* path — it must
  fail.

## 5. AND THEN, AS A SEPARATE STEP

Once real clinic audio has run through it, one query gives the distribution of losing scores. **That
distribution is what R-F3a's threshold is set from.** Do not set it before the data exists, and do not
let anyone set it from a handful of rows: the 151 we have now were produced by centroids built from a
single voice sample for five of seven doctors, so they say more about enrolment depth than about the
threshold.

## 6. OUTPUT

`docs/handoff/ETA-E20-REPORT-14-SEP-2026.md` — diff, migration number, the column you added and why,
V1–V5 with mutation count. **Cap: 80 lines.** Commit on green; no push, no merge, no deploy.
Do not quote transcript text, speaker names or clinical content.
