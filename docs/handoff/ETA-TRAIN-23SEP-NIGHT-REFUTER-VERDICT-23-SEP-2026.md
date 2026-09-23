# ETA — night train integration. REFUTER VERDICT. 23 Sep 2026

`vinay/s1-auto-drain` **@ `2640cca`** (integrator scribe), production moved from `d519d7b`. Lane L9. Worktree `/tmp/refute-train`, HEAD asserted. This is an **integration** review — each branch was reviewed on its own; what is new here is what the merge does to them. The full gate (GitHub shards + box) is scribe's, not reproduced here.

## PASS

### 1. Nothing reached production without a verdict

Five items, every one citing a verdict of mine, and every SHA matching what I actually reviewed:

| in the train | my verdict |
|---|---|
| `d232232` note-safety Jev U4/U8 | PASS |
| `0d5e529` Jev U6 clinical-or-not routing | PASS-WITH-FIXES |
| `81cec3a` E-6.1 Jev proposal guard | PASS |
| `18accb1` router_job_lost | PASS |
| `5301fd7` drain-join-busy | PASS |

**`411127c` VAD trim is correctly absent**, matching split-speaker's own recommendation not to flip tonight and LANES L2's 24 Sep slot. A branch I passed but which its builder argued against shipping stayed out — the right outcome, and worth recording because it is the case where a PASS could have been mistaken for a ship-it.

### 2. The cross-branch ruling is verified, not assumed

My one open finding on this train was U6's: deleting the `U6_OPTIONS.includes(...)` check at `clinical-route.ts:68` survived, leaving an off-vocabulary `choice` free to become an arbitrary model-supplied **key** in `byCategory`. Fable ruled it *covered once note-safety merges*, because `d232232` added the same property centrally in `ask.ts`.

It has now merged, and the coverage depends on a correspondence between two files that came from **two different branches and had never been put side by side**:

- `ask.ts:128` rejects a choice answer when `!isValidChoice(question, choice)`, i.e. `hasOwnProperty(question.criteria, choice)` is false — *before the row is built*.
- U6's registered question is `type: "choice"` with `criteria` keyed by **exactly** its six options: `clinical_consultation`, `staff_or_admin_talk`, `phone_call`, `social_chatter`, `garbled_or_no_real_speech`, `cannot_tell`.

The key sets correspond, so an off-vocabulary choice is rejected upstream and cannot reach `byCategory`. **The ruling holds.** U6's local check is now genuine defence-in-depth rather than the only guard — which is the state I said was worth *noticing* rather than discovering, and it is now noticed on the record.

A mutation could not have established this: deleting the local check still survives, because a redundant guard and an absent one look identical to the suite. The evidence had to be the key-set correspondence.

### 3. The integration itself is clean

- `npx tsc --noEmit` on the merged tree → **rc=0**.
- The seven suites belonging to the five merged branches → **152/152**: `jev-clinical-route`, `jev-ask`, `jev-http-error`, `jev-note-safety-shadow`, `router-job-lost`, `c1b-room-window-job`, `encounter-fusion`.

## Verdict: PASS
Every item carries a verdict, the one item that should not ship did not, the cross-branch ruling is verified against the merged tree rather than taken on trust, and nothing broke at integration. The full gate remains scribe's to run and Fable's to push.
