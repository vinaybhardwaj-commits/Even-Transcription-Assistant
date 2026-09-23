# ETA — dead-air VAD trim, FLAG-OFF review. REFUTER VERDICT. 23 Sep 2026

`vinay/diarize-vad-trim` **@ `411127c`** (builder split-speaker), on production `d519d7b`. Worktree `/tmp/refute-vad`, HEAD asserted, clean after every run. **Scope: flag-off safety**, per Fable — the flip is not happening tonight. I did not review the trim's numerical correctness, the remap across stitch boundaries, or the Mini's Python endpoint; those belong to a flip review.

Baselines verified pristine (95/95, 75/75). **5 mutations, 5 killed, 0 survived.**

## PASS — flag-off is inert by construction, and all three rulings are pinned

### Flag-off

```ts
let sendKey = w.clip_r2_key;      // the untrimmed clip
let sentSeconds = audioSeconds;   // the untrimmed length
if (vadTrimEnabled()) { … }       // everything trim-related lives in here
```

The defaults **are** the pre-trim values, so with the flag off the object sent to pyannote.ai and the seconds billed are the originals — inert by construction rather than by a guard that has to be right.

| mutation | result |
|---|---|
| **F1** the trim runs regardless of the flag | **killed, 5** |
| **F2** the flag inverted (trims when OFF) | **killed, 27** |
| **F3** `parseFlag` replaced by a truthy `Boolean(env[...])` | **killed** |

F3 is the **seventh** sighting today of the only-the-truthy-half class, and the third consecutive branch on which it was already closed before I looked. It has stopped being a finding and become a habit.

### Fable's three rulings, each pinned rather than merely present

**(a) No skip on VAD alone — killed (G1).** Making a `regionsEmpty` answer skip the window fails a test. The code marks `trimNote = "vad_empty"` and diarizes the window **whole**, and the comment carries lab-mover's measurement as its reason: *"On some rooms Silero confidently finds none through real, normal-level speech (19-91% of real speech lost on 4 of 20 windows), so 'no speech' from VAD alone is never allowed to decide what a clinician's window loses."* This is the "absence of evidence convicts" failure the programme has now closed four times, and here it is closed **before** the feature ever ran.

**(b) Cut only where the level log agrees.** `observedQuietSpans(levelSamples, …)` supplies the permitted spans, and `allowCut.length === 0` skips the VAD call entirely — no point spending a Mini pass on a window nothing may be cut from. Corroboration by a second, independent signal is the right shape for a judgement this consequential.

**(c) No teacher label from a trimmed run — killed (G2).** `if (!trim)` guards the `pyannoteai` label write, and the comment states the risk better than I would: *"pyannote.ai heard only what VAD kept; on the windows where VAD is wrong that is exactly the speech missing from its answer, and a label missing speech teaches the local model to miss it too."* The run is still stored for production and marked `timing_json.engine.vad_trim`, so it is kept out of the training set without being lost. The other two `labelWindow` call sites are `engine: "local"`, which runs on the full clip and is correctly left ungated.

**Every failure falls back to the whole clip.** An unreachable VAD, a malformed map or a failed upload is *"we could not trim"*, never *"there was nothing to hear"* — stated in the code and consistent with (a).

### On the builder's recommendation

split-speaker recommends `DIARIZE_VAD_TRIM` is **not** flipped tonight, on lab-mover's measurement that Silero cuts 19–91% of real speech on 4 of 20 windows. **I agree, and the branch is built as if that recommendation were already a ruling** — which is why a flag-off merge carries no risk: the rulings that make a future flip survivable are already in the code and already tested.

A builder recommending against shipping their own work, and then hardening it against the flip anyway, is the behaviour that makes the rest of this review cheap.

## Verdict: PASS (flag-off)
Nothing reaches production while the flag is off, and the three properties that would matter on a flip are pinned by tests rather than asserted in comments. **Merging flag-off is safe; the flip is a separate decision and needs a separate review** — the remap across stitch boundaries, the cost accounting, the Mini endpoint and the speaker-order consequence I raised earlier are all still unexamined by me.
