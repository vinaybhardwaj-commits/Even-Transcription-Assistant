# ETA — 24 Sep train integration. REFUTER VERDICT. 23 Sep 2026

`vinay/train-24sep` **@ `a8247f1`** (integrator scribe), on top of tonight's production `2640cca`. Lane L9. Worktree `/tmp/refute-t24`. Integration review: `411127c` was reviewed on its own (PASS, flag-off); what is new is what the merge does to it.

## PASS — ship it flag-off; the flip is a separate decision that has not been made

### One item, and the merge altered nothing

The train is exactly `2640cca` + `411127c`: **8 files, 1454 insertions** against production, byte-for-byte the change I reviewed at `411127c` against `d519d7b`. No conflict resolution, no merge-introduced edits.

**No semantic collision with tonight's five.** VAD trim adds +163 lines to `lib/jobs/kinds/diarize-window.ts`, and the night train (`d519d7b..2640cca`) **never touched that file** — checked, not assumed. The two trains are disjoint where it matters.

### The merged tree holds

- `npx tsc --noEmit` → **rc=0**
- VAD + night-train suites → **122/122** (`diarize-vad-trim`, `diarize-vad-trim-flow`, `diarize-hybrid`, `jev-clinical-route`, `router-job-lost`)
- **F1 re-run on the merged tree — `if (vadTrimEnabled())` → `if (true)` kills 5.** Flag-off inertness is still pinned after integration, which is the single property this PASS rests on.

### THE DEPLOY CONDITION — read this before pushing

**My PASS is flag-off only, and flag-off is an environment fact, not a code fact.** The code is inert because `DIARIZE_VAD_TRIM` is unset; nothing in this train prevents it being set. So:

- **`DIARIZE_VAD_TRIM` must remain UNSET in production.** Shipping this train and setting that variable are two different decisions, and only the first has a verdict.
- **The builder recommends against the flip**, on lab-mover's measurement that Silero cuts **19–91% of real speech on 4 of 20 windows**. I agree. split-speaker built the branch as though that recommendation were already a ruling — the three guards (no skip on VAD alone, cut only where the level log agrees, no teacher label from a trimmed run) are all in the code and all pinned by tests — which is exactly why shipping it off is safe.

**What I have NOT reviewed, and what a flip would need:** the time remap across stitch boundaries, the cost accounting, the Mini's Python endpoint (never run against real ECAPA), and the consequence I raised earlier — that trimming changes segment durations, which drive `total_speech_sec`, which drives the Mini's greedy longest-talker rule, so **a trim can change which speaker is matched to the clinician**, and can shorten a speaker's longest span below ECAPA's 0.5 s floor so they get no embedding at all. None of that is examined. A flip review is a separate piece of work.

## Verdict: PASS (flag-off)
Clean merge, disjoint from tonight's train, green on the merged tree, and the inertness property re-verified post-integration. Ship it with the flag unset.
