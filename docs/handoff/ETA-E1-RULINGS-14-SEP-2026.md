# ETA-E1 — rulings on the multi-centroid plan · 14 Sep 2026 · Orchestrator

Rules on `ETA-E1-MULTI-CENTROID-PLAN-14-SEP-2026.md`. I ran four read-only queries against live Neon
before ruling; their results are in §0 and they move three of the seven forks.

## 0. What the live data says (read-only, by me)

| | |
|---|---|
| `voice_print` rows | **7** |
| `voice_sample` rows | **17** — and **5 of the 7 doctors have exactly ONE sample**, all enrolled 13 Sep. Two older doctors have 6 each, from 30 May and 1 Jun. |
| `voice_sample.source` values in use | **`enrollment`, and nothing else** (17 of 17, all 7 doctors) |
| `room_turn_speaker` rows | **317** |
| …of those, named | **ZERO.** `role` is NULL on all 317. |
| `no_role_reason` | `straddle` **166** · `no_match` **151** |
| Clinicians with a cross-device blend (assumption 6) | **zero** — every doctor is single-source |

## 1. F3 — DOWNGRADED, and the real finding is underneath it

F3 warned that flipping `ROOM_DIARIZE_ENABLED` turns room naming on at `DIARIZE_BATCH_THRESHOLD = 0.65`,
the number the PRD says names the wrong doctor. I flipped that flag this afternoon, so I checked what it
has actually written.

**It has named nobody. 317 turns, 0 roles, 151 `no_match`.** The threshold has never produced a name,
wrong or right, so the flag is not writing bad attribution today and it stays on for `ETA-E5`.

Three rulings come out of that instead:

- **R-F3a. The three thresholds get unified, and the value is measured, not chosen.** 0.65 (room,
  a bare constant at `diarize-window.ts:35`), 0.70 (encounter, the service default at `server.py:294`)
  and 0.78 (phone, `voice/identify`) are three unratified numbers answering one clinical question —
  *is this that doctor?* One named setting, one default, read in all three paths. Which number it
  holds is not settled by this document and nobody should pick it by feel.

- **R-F3b. Record the best score even when it loses. This lands in E1, not later.**
  `match_confidence` is NULL on every unnamed row, so the database cannot currently tell us whether
  those 151 no-matches were near misses at 0.63 or nowhere near at 0.31 — **and that is precisely the
  number needed to set the threshold in R-F3a.** The system discards the only evidence that would
  settle its own open question. This is testing rule 12 in a new place: a refusal that does not become
  data leaves you arguing instead of measuring. Write the winning cosine and the winning
  `clinician_id` alongside `no_role_reason = 'no_match'`, with the role still NULL.

- **R-F3c. Enrolment depth is the likelier cause of the 151, and it is an operational job, not a
  build one.** Five doctors are carrying a centroid built from a single sample. Multi-centroid is the
  right architecture and it does not rescue a one-sample enrolment. Raised with V separately.

## 2. The seven forks

**W — option A (app-side), with one correction to the plan.**
Build A. But the plan says a failure to reproduce the Mini's 3-dp `confidence` gives the turn **no
role**, and that is too strong: the Mini made the match and is authoritative for *who*; the app is only
establishing *which centroid* won. A rounding disagreement is not evidence the name is wrong.
**On disagreement, drop `centroid_id` and record `centroid_unresolved`; keep the role.** Never let a
provenance detail delete a correct name.
The Builder is right that A re-implements the match in the app (testing rule 3) and right that the
exact-agreement check is the guard against it. So make the guard a measurement: **count
`centroid_unresolved` and report the rate.** If it is more than a trickle, A's premise (assumption 2,
unmeasured) is false and we do B. B is the better long-term answer — the matcher knows which centroid
won and should say so — and "the Mini service is unversioned" is an argument for versioning it, not
for a shadow implementation in the app. A now, B on evidence.

**S — a closed vocabulary, enforced by CHECK, and it is genuinely new.**
The census settles the premise: `voice_sample.source` is capture *method* — all 17 rows say
`enrollment` — not device. There is no device or microphone dimension anywhere in the data.
A free-text required field would give us `tonor`, `TONOR`, `Tonor usb` and a broken unique index
within a month, and `capture_source` is a **key** in `voice_centroid (clinician_id, capture_source)
WHERE active`, not a label. So: closed `CHECK` vocabulary; `legacy_unspecified` for the backfill as
planned; the other members come from an actual count of what devices are deployed, which I will get
from V rather than invent. Adding a member is a migration, deliberately.
**Good news in the same breath: zero doctors have a cross-device blend today,** so D1's forbidden
blend is a hazard being prevented, not damage being repaired. The backfill is clean.

**R — freeze `voice_print`; do not drop it.**
Two writers to one identity fact is how they diverge. Frozen, it is a legacy snapshot with a known
shape; live, it is a second source of truth. It stays in the schema — the PRD forbids deleting single
centroids, and it is the rollback.

**I — in scope, and forced there by R.**
`voice/identify/route.ts:36` reads `voice_print` directly. Freeze that table and the phone path stops
seeing every doctor enrolled after the migration — silently, which is the worst way for it to fail.
So the minimum change is in: `voice/identify` reads `voice_centroid`, best-of across that doctor's
active centroids. Nothing else about that route changes. Its 0.78 is part of R-F3a.

**L — yes, filter under-floor centroids at read, and count what the filter removes.**
`checkCentroid` (`MIN_CENTROID_L2 = 20`) already runs on every write path, so a read-side filter
should never fire. That is exactly why it is worth having: **if the count is ever non-zero, a write
path is bypassing `checkCentroid`, and the filter has found a defect rather than done a job.** A
silent filter would just hide it (testing rule 12 again). Filter, and emit the count.

**T — rewrite, never adapt.**
`c2-e2e-runner.test.ts:1107` asserts the *source text* contains the old function name. That is the
assertion testing rule 2 forbids, and renaming the string inside it would keep a test that proves
nothing. Replace it with the behaviour: call the loader, assert it returns N centroids for a doctor
with N active, and zero for one whose centroids are retired, whose account is disabled, or who is
deleted. Rule 1: the replacement asserts the original's subject, not the rename.

## 3. On the assumptions

- **#6 — answered above: zero blends.** No longer an assumption.
- **#1 (that PID 84377 on `127.0.0.1:8001` is running the `server.py` that was read) is the one to
  close before building W.** A whole fork rests on a file nobody confirmed is the running code. One
  command, at the start of the build round.
- **#7 — closed by S.**
- #2 (float64 cosine reproduces numpy at 3 dp) stays open by design; W's `centroid_unresolved` counter
  is what measures it.
- #3, #4, #5 stand as flagged.

## 4. Sequence

E1 does **not** start until `ETA-E5` reports. E5 measures whether the pipeline this identity work sits
inside can run at all, and that answer may change E1's priority. When E1 does start, R-F3b (record the
losing score) goes first and alone if necessary — it is small, it is independent of the migration, and
every threshold decision after it depends on having that number.

Orchestrator. Queries run read-only against live Neon by me. No subagents.

---

## 5. AMENDMENT — fork S closed, 14 Sep 2026, 16:40

V has given the device inventory. The `capture_source` vocabulary is **closed at four members**,
enforced by CHECK on `voice_centroid.capture_source`:

| value | device |
|---|---|
| `tonor` | TONOR room microphones |
| `logitech_c270` | Logitech C270 webcam microphones |
| `phone` | mobile phone microphones (PWA capture) |
| `legacy_unspecified` | backfill only — every row the 0094 migration copies from `voice_print` |

Adding a fifth member is a migration, deliberately. No enrol path may write a value outside this set,
and no path may write `legacy_unspecified` after the backfill — that value is historical, not a
fallback for "we don't know". A path that cannot determine the device must fail loudly rather than
mislabel the centroid, because `capture_source` is half of the unique key that decides which
centroids a doctor has at all.

Note the consequence for the room path: a room's audio arrives from `tonor` **or** `logitech_c270`
depending on how that room was installed, so the device — not the room — is the dimension, exactly as
D1 requires and as the plan's "no room column" already has it.

## 6. AMENDMENT — R-F3c answered: harvest, don't re-enrol by hand

V's answer to the one-sample problem is to **scrub existing recorded audio** for more of each doctor's
voice rather than call doctors back for enrolment sessions. That is the better answer — it is the only
one that can produce `tonor` and `logitech_c270` centroids for doctors who have only ever enrolled on
one device, because the room audio already exists on those devices.

Scoped as `ETA-E7` (`ETA-E7-VOICE-HARVEST-INVENTORY-CC-KICKOFF-14-SEP-2026.md`), inventory first.
