# SURGICAL-CHAIN-LINKER P1: pre-registration v7 (linker, 24 Sep 2026; the git commit time is the timestamp): A+ final; maturity applies to absence, not presence

Addendum to v1 to v6.1; nothing earlier is edited. **No link-3 score exists** and no label has been accepted for any downstream claim. The code for C2 is `p1/build_chains.py` stage L with `L_RELAX=1`, committed with this file; it runs afterwards.

## C1. Ruling 179: A+ is FINAL
V confirmed A+ as final for "proposed-and-done" (Fable ruling 179, replacing "provisional" in ruling 173). B (same indication, different technique) stays a sensitivity stratum next to every A+ number; a B relabel comes from the stored stratum with no re-run. Nothing else in v6.1 changes.

## C2. Maturity applies to absence of evidence, not to presence of it (a design change, disclosed)
**Why.** v1 applied the mature cutoff (Rx on or before 22 Aug for a 30-day follow-up) to positives and negatives alike. The cutoff exists because a recent prescription has not had time to show an outcome: it protects the class defined by the **absence** of a record (N1). A positive already has its done evidence; waiting for it to mature adds nothing to its label. The recorder's tape sits mostly in September (Neon `bench_chunk`, by IST day: 4, 18, 19, 20, 22 Aug have 18, 1, 171, 18, 108 chunks; 23 to 25 Aug have 237, 212, 136; 9 to 24 Sep have 317 to 1,227 a day), so **the mature rule strands the positives away from the audio: of 50 mature A+ positives, 6 fall on a day with any chunk and 2 on a day with 100 or more; of 92 A+ positives whatever their date, 24 fall on a day with 100 or more.** This was decided **after** seeing those counts (disclosed), and only to remove a constraint that does no work for positives.
**Rule.**
- **Positives (A+ units):** any prescription date, provided done evidence (OT note or procedure billing) is already present within the follow-up window as far as it has run. Reported split **mature / immature** in every table.
- **N1** (advised, no evidence of done in our records): **mature only**, as in v1.
- **N2** (no procedure advised, explicit no by a surgical-clinic doctor): **any date** (nothing about it depends on a later outcome).
- **Matching.** Draw as in v6.1 (same doctor and ISO week, else adjacent week, flagged). A positive with no N1 draw (typical for immature ones) is reported, not filled. **A label-rate claim uses positives against negatives of the same maturity class only**, and the immature positive count is shown beside it: immature positives are selected for fast surgeries, so the two maturity classes are never pooled into one rate.
- The v6.1 `mature` worklist stays as produced (`labels_worklist_*d.json`); the relaxed one is written beside it (`labels_worklist_*d_relaxed.json`).

## C3. Tape is the binding constraint on link 3 (a measurement, no rule)
Day-level tape is necessary, not sufficient: hist-miner found 125 of 174 anchored visits had no audio in any room in their window even on days with chunks. Visit-level coverage (a chunk in [start - 10 min, end + 10 min] in any room) comes next, from the box worklist, with hist-miner's inventory or `energy_shortlist.py`. The count of chains that survive it is the real yield and is reported before any scoring.
