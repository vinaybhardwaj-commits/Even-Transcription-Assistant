# ETA — diarize hybrid, M1 + L1 re-check. REFUTER. 23 Sep 2026

`vinay/diarize-pyannoteai` **@ `2337c8e`** (builder split-speaker), three commits on `286db74`: `cefbf4b` (M1), `4e43eae` (L1), `2337c8e` (a third their own generalisation turned up). Own detached worktree `/tmp/refute-hyb2`, HEAD asserted, clean after every run. Baseline verified green pristine: **102/102** (was 91 — eleven new tests).

## PASS — both findings closed, checked against the new anchors rather than the old ones

**11 mutations, 11 killed, 0 void**, all mine and none of them the eight the builder ran.

### M1 — closed, and closed by removing the category rather than the instance

The builder states my exact mutation is now unexpressible. **That claim is the one thing in a fix report that most needs checking, because "the mutation cannot be written" and "the mutation was made to survive" look identical from outside.** It holds, and structurally: `lib/jobs/kinds/diarize-window.ts:460` now types the argument as `Partial<DiarizeEngineProvenance> & { attribution: "voiceprint" | "none"; … }`, so `attribution` is a **required** member of an otherwise-partial object. There is no default left to mutate. The anchor is gone, not hidden.

Their reasoning for doing it that way is correct and worth keeping: a default that is always overridden is unreachable code, and **unreachable code is precisely what no mutation can be caught changing** — which is why M1 survived in the first place. Making the compiler demand the value at every site converts a runtime convention into a compile-time obligation, and it surfaced two skip paths (`:205`, `:238`) that had been silently inheriting a claim nobody had thought about.

| my mutation, on the new anchors | result |
|---|---|
| **R1** zero-centroid guard deleted | **killed, 3** |
| **R2** `<= 0` weakened to `< 0` (zero centroids pass) | **killed, 3** |
| **R3** an empty-string embedding counts as one | **killed** |
| **R4** the level-skip path claims `voiceprint` | **killed** |
| **R5** the VAD-skip path claims `voiceprint` | **killed** |
| **R8** `centroids_offered` hardcoded to 1 | **killed** |

They also report the mirror hole on their own arm — counting embeddings without asking whether any centroid was offered — which **I did not claim and did not find**. On a day with nobody enrolled the Mini returns embeddings, compares them against nothing, and the old rule called that an attribution. One rule now, `attributionFor` in `lib/stt/diarize-window.ts`, used by both arms: a comparison happened only when there was something to compare **and** something to compare it against, with `centroids_offered` stored beside the label so it carries the evidence for its own claim.

### L1 — closed, and the new tests are not vacuous in either direction

| | result |
|---|---|
| **R6** — L1 exactly: `=== "silent"` → `!== "has_sound"` | **killed, 3** |
| **R7** — VACUITY CONTROL: skip condition → `if (false)`, never skip at all | **killed, 2** |

R7 is the one that decides whether the fix is real. Tests that only pin "do not skip too much" would pass a gate that never skips at all, and a reviewer reading three new green tests could not tell the difference. Both directions die, so they pin a **boundary**, not a side of one. The builder's own account of why matters too: their two new tests also assert that a `bench_level_sample` read actually happened, because without it they would pass for the wrong reason the moment the gate stopped being called — which is the exact shape of the hole they close, closed against itself.

### B12 — their own finding, from applying the generalisation rather than the two findings

They took "pinned in the module where I was thinking, not at the boundary where it is consumed" and ran it across the branch: twelve decision-boundary mutations, ten already dead, and one that mattered — **the centroids were never asserted to reach the request**. Verified independently:

| | result |
|---|---|
| **W1** centroids sent as `[]` while `centroids_offered` counts them | **killed** |
| **W2** seconds silently sent as milliseconds | **killed, 2** |
| **W3** `batch_threshold` dropped, service default silently used | **killed** |

W1 is the attribution bug one layer down — a row claiming a comparison against something that was never sent — and it was found by generalising a finding rather than closing it. That is the most valuable thing in this round and none of it is mine.

### The Mini, which is outside their gate and therefore checked by me

`/diarize` still byte-identical: `diff` of lines 1–419 against the pre-change backup is empty; the file is now 587 lines. The `total_speech_sec` fix does what they say, verified line by line at `:511–:519`: `None` refuses, a non-`float` refuses, `f != f` (NaN) refuses, `f < 0` refuses, an explicit `0` stays legal — correct, since a speaker really can hold no time — and `if i not in embs: continue` means a row already dropped for a bad span cannot refuse the whole call. My observation is fully closed, and they were right to treat it as a finding rather than the aside I filed it as.

Minor, no action: `total_sec.get(i, 0.0)` survives at `:525`, but every key of `embs` is now validated before it, so the default is unreachable — by their own argument about `engineProvenance`, unreachable code is also unmutatable. Cosmetic.

### Their correction to my void-mutation rule, which is better than my rule

I reported two void mutations last round and added "assert the edit applied" (`git diff --quiet` → void). They point out their own first B8 was void in a way **that check would not catch**: the text changed, so the assertion passed, but `[...xs].reverse().map(x=>x).reverse()` is the same array, so the behaviour did not. **A mutation has to change what the code does, not merely what it says.** A text-identical edit and a behaviour-identical edit both produce a survivor that means nothing, and only the first is caught by diffing. Adopted: the text assertion stays as the cheap first filter, and a survivor on a mutation whose semantics I have not argued is now treated as unproven rather than as a result.

### Still not proven, unchanged and not improved by this round

The Mini endpoint has never run against the real ECAPA model. No window has been through the hybrid end to end. Migration 0117 has been applied nowhere. The 21:15 restart moves the first of those and nothing else.

## Verdict: PASS
Both findings are closed against anchors I chose, not the ones they tested. M1 is closed by deleting the category — the default that could not be caught changing no longer exists — and L1 by tests that die in both directions. The branch is clean for merge on my account; the three unproven items above are live-verification work, not review work.
