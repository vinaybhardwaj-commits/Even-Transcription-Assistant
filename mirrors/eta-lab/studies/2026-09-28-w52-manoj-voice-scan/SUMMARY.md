# W52-B voice scan — status (lx, 28 Sep)

Order: `/home/eta/oc/W52-FACTS.txt` (Fable 11:5x, V priority, first cut due 13:30/15:00). My part:
voice scan of OPD 4 + OPD 7 for Dr Manoj Kumar S (`doctor_uid` `Tbvyk1V5ijpcD194ZOWi`), every
room-day with tape, using the new enrolled centroid.

Data outputs (PHI-adjacent, box only, never git, per the facts file): `~/eta-data/manoj-package/
voice/scan-<room>-<date>.json` + `walk-ins.csv`. `~/eta-data/manoj-package/method/METHOD.md` is now
**reb's** consolidated package method doc (W52-D, integrator) — it correctly incorporates the
ruling below in its own "Per-encounter voice confidence" section; this file's method notes are
mine, for the voice-scan step specifically, not a duplicate of theirs.

## Timeline (three passes today, each a real correction, not a restyle)

1. **First cut** (12:02): `room_found` = any turn `cos>=0.55` inside a `±180s` PQM pad. vj-refuter's
   listen-free spot-check (`~/oc/vj-refuter/reviews/W52-spotcheck-RESULT.md`) found this put **49 of
   77 consult-tokens in BOTH OPD4 and OPD7 at once** (F5) — a real bug, not noise.
2. **My first fix** (56d06a91): tightened to `±30s` + `≥3 turns or ≥15s`, but used `cos>=0.65` — I
   misread vj-refuter's own number, which was **0.65 for the clip-level bar, 0.55 for per-turn**.
3. **Fable's 12:20 ruling** (current, adopting #5301 in full): `HIS_VOICE_COS=0.55` for ALL
   attribution (not just `room_found` — walk-ins too), `ATTRIBUTION_PAD_MS=30_000` replacing the
   wide `±180s` pad **entirely**, FOUND = `≥3 turns or ≥15s`, else WEAK (kept, flagged) or `null`
   (no evidence at all — still gets a PQM+Rx row elsewhere in the package, per the ruling).

Final (post-ruling) numbers: of 77 Kumar-S consult-tokens across the 22 scored room-days, **28
FOUND, 2 weak-only, 47 with zero OPD4/7 evidence**, zero double-room-assignments. **152 walk-in
blocks** (76 found, 76 weak) — up from 69 under the old 0.65/180s rule, because the tighter pad
also *shrinks* what counts as "inside a PQM window," so more genuine voice activity now falls
outside one and counts as a walk-in candidate.

## Coverage gap — corrected to 17 room-days (vj-refuter #5305)

Checked first (per the order): `~/eta-data/voice-linkage/dtree84`'s existing per-turn embeddings
are the SAME model as the centroid (`speechbrain/spkrec-ecapa-voxceleb`, 192-d) — reused directly.
**22 of 39** OPD4/OPD7 room-days with tape are covered this way. My own inventory originally
stopped at 27 Sep (15 gap room-days) per the order's literal wording; vj-refuter's #5305 pointed
out today's (28 Sep) own in-progress tape should count too — extended `room_day_inventory.py`
through 28 Sep, confirmed **exactly their number: 39 total, 17 gap (162.9 tape hours)**. Gap
specced in `w52-embed-job-spec.json` (git-tracked here; not shipped in the delivered package per
eta-refuter-3's hygiene pass). **Fable's 12:15 update**: box T4 is now available for W52 (was
"busy, do not use" at first) and V is on a spotty hotspot — updated the spec to say the gap job
should run locally on box T4, no upload, no $40 GPU cap, no waiting on Fable. Still hf-fleet's
role to execute (GPU/embedding jobs are their lane per the facts file), not run by lx.

**`voice/unscanned.csv`** (new, per vj-refuter's explicit ask: "until then reb marks those 49 as
NOT SCANNED, not NOT-IN-OPD4-7"): every Kumar-S PQM token whose date has an unscanned room AND
isn't already resolved FOUND/WEAK by a room this scan DID cover. **63 tokens** by my own
definition (a token counts as still-ambiguous only if no covered room that date gave it a real
answer) — this doesn't line up exactly with the "49" figure in vj-refuter's message (their own
per-date numbers, as I received them, actually sum closer to 70; likely a "tokens that date"
count vs. my "tokens still genuinely unresolved" count — e.g. 16 Sep: they cite 9, I get 2, because
7 of those 9 are already resolved via 16 Sep OPD4, which IS scanned). Their message was also
truncated in relay before I could confirm. Shipping my number since it's independently derived and
internally consistent, and erring inclusive is the safe direction here — flagged for reconciliation
once the bus is back, not presented as authoritative over theirs.

## Possible follow-up (not yet raised — bus still down)

reb's own `METHOD.md` "Room attribution" section (a *different* decision from my FOUND/WEAK
confidence — theirs decides which room an encounter's audio gets cut from) uses `>=60s of
cos>=0.65` for `lx_confirmed`. That predates Fable's 12:20 ruling on the per-turn bar (0.55, not
0.65) — worth flagging to reb once the bus is back, in case it's making real schedule-matches read
as `lx_override`/`schedule_prior_unverified` more often than the now-official bar would.

## Scripts (this dir)

`room_day_inventory.py` → `pqm_pull.py` → `embed_job_spec.py` → `voice_scan.py` (reads
`covered.json` + `kumars-pqm.json`, writes to `~/eta-data/manoj-package/`). JSON outputs
(`covered.json`, `gap.json`, `kumars-pqm.json`) are not committed — `kumars-pqm.json` carries
opaque `token_uid`s, kept off git per the pane rule on committed outputs.
