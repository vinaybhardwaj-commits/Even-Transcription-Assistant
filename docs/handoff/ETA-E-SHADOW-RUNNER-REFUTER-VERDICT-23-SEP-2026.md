# ETA — E-shadow runner. REFUTER VERDICT. 23 Sep 2026

`vinay/e-shadow-runner` **@ `a6ad1db`** (builder split-speaker), two commits on the deploy base: `lib/encounter-clock/shadow.ts` (new, pure), `lib/encounter-clock/shadow-io.ts` (new), the `scribe_encounter_shadow_run` MCP tool, a docs note and 260 lines of test. Own detached worktree `/tmp/refute-esh`, HEAD asserted before the run. Nothing pushed, **no run invoked, no row written**. Mini kept out — every run on the Yoga fast runner. `c23f056` (deployed) is upstream of it.

**This runs for real tonight**, so the review is weighted to what can go wrong unattended: what it writes, and whether the safety reporting can be relied on.

## PASS-WITH-FIXES — the run is safe and the triggers fire; the one-line alarm they feed is unpinned

### Mutations — 8 run, 0 runner errors, 7 killed

**Every rollback trigger can actually fire.** Replacing each `tripped` expression with a constant `false` is caught for all five — `encounter_over_2h`, `unjudged_over_90pct`, `median_over_60min`, `encounters_over_15`, and `zero_encounters_with_transcripts`. So does widening the 2 h limit (T6) and loosening its `>` to `>=` (T8). A trigger that silently never fires is the failure mode that matters for an unattended run, and none of the five has it.

### Verified against the plan, not against itself

The trigger limits were cross-checked **line by line against `ETA-ENCOUNTER-CLOCK-FLAG-ON-PLAN-23-SEP-2026.md`**, not merely for internal consistency:

| plan | code |
|---|---|
| "any > 2 h — the bridging rule has a hole" | `limit: 120`, `> 120` |
| "unjudged passes 90%" | `limit: 0.9`, `> 0.9` |
| "median > 60 min" | `limit: 60`, `> 60` |
| "0 on a day with transcripts, or >15" | `encounters > 15`; `encounters === 0 && windows.placed > 0` |

All four match. A limit copied wrong produces a trigger that never fires and never says it didn't, so this was the check worth doing before tonight rather than after.

### Two things that looked wrong and are not

- **`scope: "invoke"` on a tool that writes DB rows.** Checked against the repo's convention rather than assumed: the four `invoke` tools are `scribe_extract_audio`, `scribe_transcribe_range`, `scribe_jev_window_run` and `scribe_job_submit` — all *run-a-pipeline* tools that persist their own output — while the thirteen `write` tools mutate operational state (`start_recording`, `post_cue`, `set_visit_clinician`). A shadow run that stores its own result row is `scribe_jev_window_run` almost exactly. **Correct as declared.**
- **Purity.** `shadow.ts` imports only gate, probe, smooth, hypotheses types, bench-levels types and window-measure. No audio path, no STT. The "no STT, no audio fetch, no clinician-facing write" claim holds by construction, and the only write is the E-5 store's own insert.

`triggers_tripped` is reported rather than used to gate the write, so a run that trips still leaves its row. That is the right way round: the row is the evidence.

### FINDING — the aggregate alarm bit is the one thing nothing guards

**T7 survives:** `triggers_tripped: triggers.some((t) => t.tripped)` → `.every(...)` leaves the suite green.

Under `every`, the flag is true only when **all five** triggers trip at once — in practice never. A run whose longest encounter ran to three hours would report `triggers_tripped: false`.

The per-trigger array is still correct and still pinned, so the information is not lost to a careful reader. But `triggers_tripped` is precisely the field the module's own header exists for — *"every rollback trigger … is evaluated against it here, so a run that should stop the experiment says so in its own answer rather than waiting for a reader to notice"* — and it is the field an operator glancing at the answer, or any script keying off it, would read first. The detail is guarded; the headline is not.

**Fix:** one assertion — a summary with exactly one trigger tripped has `triggers_tripped === true`. Worth having before tonight, since the run is unattended and this is the bit that would be believed.

### The append-vs-replace deviation — correctly flagged, and I agree with the builder

The order asks a rerun to replace its previous rows; the E-5 store is append-only, so the runner appends and names the run it supersedes. The builder flagged it to Fable rather than changing my module, which is the right division.

**My assessment, for Fable's ruling and not mine to make:** the append-only design should win over the order's wording. `0114`'s own header says *"APPEND-ONLY. A rerun is a new run; nothing is updated or deleted by the writer. Readers take the latest run; the older runs stay as history for the evaluation."* Literal replacement would delete exactly the history E-7 needs to score the clock against V's labels, and on a shadow run whose purpose is accumulating evidence, destroying the prior attempt is the one operation that cannot be undone. Appending gives the same reader-facing answer — the MCP description already documents it (*"A rerun appends a new run; readers take the latest"*) — with the history intact.

## Jev — run, and reported as weak evidence

Called per the standing rule. **Confidences came back 0–0.32, several literally 0**, because I sent an abridged diff of a 195-line module rather than the whole thing. Scores 5.6–7.1, all `low`, with `correctness` ("requested behaviour appears missing or incomplete") as top priority — which *could* be the T7 gap or could be an artifact of the elision. **I am not citing it as corroboration.** A near-zero-confidence score is not independent confirmation of anything, and treating it as such would be exactly the mining-for-agreement this rule exists to avoid. Recorded so the call is on the record and its weight is stated.

## Gate

- **Mine:** 8 mutations through the Yoga fast runner, 0 runner errors, worktree HEAD asserted before the run and verified clean after.
- **The builder's, quoted as theirs:** Yoga green, 174 files / 3,904 passed.

**Verdict: PASS-WITH-FIXES.** Safe to run tonight: it reads only what is already stored, writes only its own run row, declares the right scope, and every rollback trigger both matches the plan and can fire. The single fix is one assertion on `triggers_tripped`, so the summary's headline cannot quietly disagree with the detail underneath it.
