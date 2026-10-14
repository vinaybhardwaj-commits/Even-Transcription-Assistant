# W51 Manoj-voice — plan + ETA (lx, 28 Sep)

**Status: drafted, not yet posted.** `eta-bus`/`even-jev` MCP disconnected this session — this plan,
the prereg, and the H05 check are all ready to post the instant the bus reconnects. Nothing below
has started; this is the plan the order asked for "first."

## What's done already (offline, no bus needed — audits + arithmetic on already-embedded data)
- Verified the order's facts: schedule sha256[:16] `398895d305c9fef9`/217 slots match exactly; PQM
  `pqm-*.csv` for 18–24 Sep exist and roughly match the stated call-time ranges.
- **H05 conflation check done and reported** (`H05-CONFLATION-CHECK.md`): c200 is cleanly in
  Manoj Ortho's afternoon slot, no Manoj-C-evening conflation — **independently verified by
  vj-refuter (bus #5296)**, same verdict, more precise numbers. c62 is NOT Salanki (cos 0.13) but
  its own time window matches Dr Vishal Naik's slot — flagged, doesn't change H05's PASS.
- **Found a shortcut**: `~/eta-data/voice-linkage/dtree84/link-rd_*.json` already carries a `pairs`
  array per room-day — `(doctor_uid, cluster)` rows with `present/consults/dominance_rank/excess`
  precomputed. Most of the coverage/exclusivity evidence is already on disk for the days that exist.
- **Found the scope gap**: `dtree84` only covers 9–24 Sep, 80 room-days. Nothing for August or
  25–27 Sep — the order's "Aug through 27 Sep" window needs a real backfill for those two gaps.
- **Pre-registration v1 → v2**: vj-refuter's #5296/#5297 (relayed while the bus was down) found v1's
  ROOM=OPD mapping assumption **does not hold in general** (Poornima/H05/c62 counterexamples) and
  set 4 checker terms: uid-only identity, no assumed room (test every room with qualifying audio per
  window instead), a named coverage-gate threshold with the eligible-room-days table computed and
  shown, and an R3-style exclusion for H05's own minting days (their exact text was truncated in
  relay — my best-effort read is in the prereg, flagged as needing confirmation). v2 (pushed) answers
  all 4: computed the eligible-room table for 18–24 Sep (pure turn-timestamp arithmetic on data
  `dtree84` already embedded — no cosine, no clustering, no scoring) and rewrote §1–§4 to test every
  qualifying room per window rather than one assumed room.

## Phases (ETA from whenever the bus reconnects + vj-refuter PASSes the prereg v2)

**Phase 0 — close v2's open items (~half a day):** vj-refuter's PASS on v2; confirmation of the
R3-exclusion text (truncated in relay); ask linker where 25–27 Sep PQM truth lives (order says
"pull later days via the linker pqm_truth" — path not found under
`~/eta-data/gcp-archive/voice-lab-1/home/vj/link/`, may be a different store); pull the other named
doctors' `doctor_uid`s (Prashanth N, Abrar, Avinash, Prathik) for the exclusivity check.

**Phase 1 — Sep 9–24 pass, cheap (a day or so of engineering, no new embedding/clustering):**
for every eligible (window, room) pair from the prereg's §3 table (and the same computation
extended to 21–24 Sep's remaining dates plus a 9–17 Sep pull once PQM data for those days is in
hand), find the dominant cluster, link identity across occurrences by centroid cosine (§4), score
coverage/exclusivity. This alone may already answer most of the order's question for more than half
the target window, using existing embeddings only.

**Phase 2 — backfill August + 25–27 Sep (ETA genuinely uncertain, sized by a pilot, not guessed):**
the room-days needing a fresh (existing-tool, no training) embed+cluster+pairs run: roughly
31 (Aug) + 3 (25–27 Sep) = 34 calendar days, at the ~5 room-days/day rate the Sep sample shows
(80 room-days / 16 days) ≈ **~170 more room-days**. File mtimes on the existing 80 don't cleanly
separate embedding time from a batch write, so I can't responsibly quote a per-room-day cost yet —
**first step of Phase 2 is a timed pilot on 2–3 room-days** to get a real number, then I'll post a
firm ETA for the rest rather than a guess. Box-only compute (not the Mini), scheduled outside any
load-sensitive window; no audio moves off box/R2.

**Phase 3 — report + blind clips (~half a day once Phase 1/2 data exists):** coverage k/n,
exclusivity shares, voiceprint table, ≤25-line bus summary, and the 6 blind clip specs (4 inside his
slots across different days/rooms, 2 decoys including one explicit Manoj-C-evening clip) for
lab-viewer's card set — clips stay behind Access, spec only (ids/times), no audio in git.

**Rough total, once unblocked:** Phase 0–1 could report a first real coverage/exclusivity number
within about a day of vj-refuter's PASS, covering 9–24 Sep. Phase 2's August/25–27 Sep backfill is
the long pole and gets a real ETA after its pilot, not before.

## Blocked on right now
1. `eta-bus`/`even-jev` MCP disconnected — still down as of this write, even though vj-refuter's
   #5296/#5297 reached me by relay. Can't post v2 for PASS, can't confirm the truncated R3 text,
   can't ask linker about 25–27 Sep PQM truth or pull the other doctors' uids. Retrying each
   session; see HANDOVER.
2. Everything above this line needed no bus and is already done/drafted/computed (arithmetic only).
