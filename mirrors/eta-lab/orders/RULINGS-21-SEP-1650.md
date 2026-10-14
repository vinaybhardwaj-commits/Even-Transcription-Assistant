# RULINGS — 21 Sep 16:50 (Fable)

## split-speaker — j0-abstain: fix the Refuter's G1–G3 (docs/handoff/ETA-J0-ABSTAIN-REFUTER-VERDICT-21-SEP-2026.md)
- G1: add a test that kills N13. A window voting all-three-English with a null or empty transcript_original must NOT produce native_en and must NOT throw; use the shape of the live window bw_wwq9p6eb_1789821900000_primary. Fix the code if it throws.
- G2: add a tally test where two windows share the same vote record, so the count must be 2 (kills N17).
- G3: fix the voteFull/voteSarvam comment to match the code (returns `other`). Keep the conservative behaviour.
Then run the full suite. The e31b-atomicity R58 flake is known and not yours; note it if it recurs. Commit and report READY FOR REFUTER with the hash.

## ETA-Refuter — go
1. Now: `vinay/overnight-translate` (scribe3; take HEAD). Closest look at switch_override: it must require WRITE scope. Also check the 07:10 IST stop, the clock gate, the canary, the deploy-order guard, transcript-off rooms passed per job, and the room setting never written.
2. Then re-check scribe's speech-gate fixes (`vinay/speech-gate` + `~/eta-router vinay/vad-endpoint`, take HEADs): F1 wiring, F2 mutation kills, F3 comment, flag-off byte-identity, the /vad size cap, and the queue behaviour. M8/M12 are accepted as unkillable (same class as `if (!base)`).
3. Then split-speaker's G1–G3 fixes on `vinay/j0-abstain`.
4. Then `vinay/join-only-clips` @ 3ca19d5.

## scribe3 — hold. Router split decision (for deploy, don't do it now)
yoga-drain measured: Yoga SraVaani RTF 0.052 vs Mini 0.201 (4x faster); Yoga IndicConformer 0.110 vs Mini 0.037 (3x slower); output identical. Decision: point ONLY `ETA_SRAVAANI_URL` at the Yoga and keep IndicConformer on the Mini. Put that in your deploy notes as a router env change plus restart, done in the same closed-hours window as the overnight deploy. Re-estimate the nights under this split (a number only, from your existing model).

## scribe, yoga-drain, lx, fleet — idle
