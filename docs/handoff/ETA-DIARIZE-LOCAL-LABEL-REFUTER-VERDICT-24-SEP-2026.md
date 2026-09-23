# ETA — DIARIZE_LOCAL_LABEL. REFUTER VERDICT. 24 Sep 2026

`vinay/diarize-local-label-flag` **@ `0e96d39`** (builder split-speaker), one commit on `dee7a34`. L1 urgent, deadline 02:40. Worktree `/tmp/refute-dll`. `tsc --noEmit` **rc=0**; `diarize-hybrid.test.ts` **51/51**. **5 mutations, 5 killed, 0 survived, 0 void.**

## PASS

### The problem and the shape of the fix

Every running diarize job sat in `local_label` — the teacher-labels comparison run of the **local** diarizer on the Mini — while ~90 windows waited for clinical diarization. Production diarizes via pyannote.ai, so that local pass is pure overhead per window, on RAM shared with whisper, the router and the recorder. Gating it frees every slot.

| mutation | result |
|---|---|
| **D1** unset no longer follows `DIARIZE_TEACHER_LABELS` | **killed, 5** |
| **D2** drops the `&& teacherLabelsEnabled(env)` conjunct | **killed** |
| **D3** the step-entry re-read removed (a parked job calls the Mini anyway) | **killed** |
| **D4** the skip made indistinguishable from a failure | **killed** |
| **D5** the handoff ignores the flag entirely | **killed, 3** |

### Four properties that matter, each verified rather than taken

**It ships as a no-op.** `localLabelEnabled()` returns `teacherLabelsEnabled(env)` when the variable is unset, so with `DIARIZE_TEACHER_LABELS=1` in production the default is *on* and nothing changes on merge. D1 pins it.

**It is NOT frozen at import.** `localLabelEnabled(env = process.env)` is a **function**, evaluated at call time — unlike `EMOTION_BATCH_LIMIT`, which I had to flag this evening for exactly that. And it is called **twice**: at the handoff (`:503`) and again on step entry (`:533`), so a job already parked in `local_label` when the flag goes off exits at once without calling the Mini. D3 pins the second call. That is what makes this usable tonight rather than next deploy.

**A skip is distinguishable from a failure — and it is tested.** The gated exit records `local_label: "skipped_flag_off"`, not a failure code. This was the gap I expected to find, because the L4 training programme reads these rows to measure the local-vs-teacher gap, and "we chose not to run it" must never read as "the local diarizer broke". **D4 kills**, so the distinct value is pinned rather than incidental.

**The clinical row is written before the gated handoff.** `storeAndFinish` runs first; the handoff is `if (localLabelEnabled() && stored.kind === "done")`, and the gated path simply `return stored`. So turning the flag off cannot lose a clinical result, and it only ever hands off after a successful store. The comment says why — *"after production is safely stored"* — and D5 pins the guard.

**The teacher label is untouched.** `localLabelEnabled()` appears at `:503` and `:533` only. The pyannote.ai label at `:486` is guarded by `if (!trim)` and by `labelWindow`'s own `teacherLabelsEnabled()` check. So the valuable half of the training data keeps coming with the comparison switched off — which is the whole point of giving it its own flag.

**The `&& teacherLabelsEnabled` conjunct is right, not redundant.** With teacher labels off, the local run's only output would be discarded, so running it would be pure waste. D2 pins it.

### FLAG — a trade that should be recorded, not a defect

Switching this off stops the local-vs-teacher comparison the teacher plan depends on (*"keep the local diarizer running alongside… so the lab can measure the gap night by night"*). The backlog justifies it and it is Fable's call, not mine to reopen. What I would ask is that the **off period is recorded somewhere the lab will see** — windows diarized while the comparison was off are not missing data by accident, they are a deliberate gap, and next week that distinction will be invisible. `local_label: "skipped_flag_off"` on each row already carries it; the flag is only whether anyone looks.

## Verdict: PASS
Ships as a no-op, live-readable at both the handoff and the step, records its skip distinguishably, cannot lose a clinical row, and leaves the teacher labels alone. Five mutations, five dead.
