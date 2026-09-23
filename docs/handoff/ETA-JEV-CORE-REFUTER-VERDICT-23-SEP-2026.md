# ETA — J-CORE-1..3, the shared Jev layer. REFUTER VERDICT. 23 Sep 2026

`vinay/jev-core` **@ `e391d24`** (builder fleet), one commit cut from production `c91264e`: `lib/jev/` (client, registry, ask, confidence, counters, decision-store, bench, types, prompts), `db/migrations/0116_jev_decision.sql`, the `jev_decisions` MCP tool, and eight test files — 1,604 insertions. Own detached worktree `/tmp/refute-jc`, HEAD asserted. Nothing pushed, no migration applied, no Jev call made.

**SCOPE FACT: not on `origin`.** `vinay/jev-core` exists on the Yoga mirror and as a local worktree; the objects are reachable only because the panes share one clone. **This verdict is on the code, not on a gate**, and it cannot deploy until pushed.

**Migration number: 0116**, which PLAN-v3 §0 names as next-free and §2 assigns to `jev_decision`. Correct, and no other branch claims it.

## PASS-WITH-FIXES — the layer conforms to the plan, and the no-text guarantee is structural. One half of the flag convention is unpinned

### §2 J-CORE-2 — the migration, checked column by column against the plan

All eleven columns the plan names are present: `subject_type`, `subject_id`, `question_id`, `prompt_version`, `model`, `answer`, `probabilities`, `confidence`, `latency_ms`, `input_tokens`, `created_at`. **`subject_type` carries the exact closed set** the plan specifies — `('window','turn','note_sentence','encounter','collapse')` — and **J5 dies** when the CHECK is removed. **There is no text column.**

### The no-text guarantee is structural, not conventional — the strongest thing in this diff

`answer` is `jsonb`, which is the obvious leak vector, so I traced what can reach it. `JevAnswer` is a **closed discriminated union**:

```ts
| { type: "noul";   noul: number }
| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
| { type: "score";  score: number; probabilities: …; legend: Record<string, string>; confidence: number }
```

The only strings are `choice` (a label) and `legend` (label descriptions), and **both come from the question definition, not from the input state**. So a decision row cannot carry transcript text unless a question is authored with an option label that *is* text — a question-design error, not a layer defect. That is the same discipline as `segments-route`'s literal-field shaper, and it is the right place for it: at the type, where every future use inherits it.

The insert reinforces it — a named-column `jsonb_to_recordset` whitelist. **J6 survives** (adding an unused `extra text` column to the recordset spec) and is an **equivalent mutant**: the INSERT's column list and its SELECT both name the columns explicitly, so a declared-but-unselected column is inert.

### §1 principles, checked one at a time

- **P1 — Jev judges meaning, never acoustics.** No registered question asks whether text was invented from silence. The only occurrence of "silence" is an *option label* inside the clinical-or-not question ("staff talking among themselves, phone calls, silence, noise, admin work"), which is a meaning judgement about what is happening, not an acoustic one about whether text is real. The J-A failure is not repeated.
- **P4 — confidence bands.** `DEFAULT_CONFIDENCE_THRESHOLDS = { act: 0.9, caution: 0.5 }`, exactly the plan's bands, and **J3 dies** when they are moved.
- **P6 — `prompt_version` on every stored answer.** It is not merely stored, it is **part of the upsert key**: `ON CONFLICT (subject_type, subject_id, question_id, prompt_version)`. **J4 dies** when `prompt_version` is dropped from that key. This is the subtle half and it is right — a re-ask at the *same* wording updates in place, while a **wording change creates a new row rather than overwriting the old answer**, so a prompt trial cannot silently destroy the evidence it is being compared against.
- **P6 — metadata-only logs.** `lib/jev/` contains exactly **one** log statement: `console.warn("[jev] decision persist failed", JSON.stringify({ error, rows: rows.length }))`. An error string and a **count**. No state text, no key, no answer.
- **Flag gate.** `ETA_JEV_ENABLED` unset throws `JevDisabledError` **before any fetch**, and **J1b dies** when the gate is removed.

### FINDING — only the truthy half of the flag convention is pinned

**J2b survives:** replacing `parseFlag(name)` with `Boolean(process.env[name])` leaves the suite green.

**J2c dies**, so the convention is partly protected: the hand-rolled `=== "on"` is caught, because the test sets `ETA_JEV_ENABLED = "1"` and `=== "on"` would read that as off. Truthy values work and are tested.

What is not tested is the **falsy half and the throw**. Under `Boolean(env)`, `ETA_JEV_ENABLED=off`, `=false` or `=0` would all **enable** Jev, and an unrecognised value would enable it too rather than throwing. For a layer whose flags are specified as **default-OFF, one per use, turned on one at a time behind evidence**, that is the dangerous direction: the failure mode is *enabling by accident*, and it is the failure mode nothing catches.

**This is the same gap I found on the retention route this morning (R2), now one layer up** — and it matters more here, because §2 puts five future flags (`JEV_NOTE_FAITHFULNESS`, `JEV_ENCOUNTER_CONTENT`, `JEV_SPEAKER_ROLE`, `JEV_COLLAPSE_VETO`, `JEV_CLINICAL_ROUTE`) through this one helper. One gap, five uses.

**Fix:** one test — `ETA_JEV_ENABLED=off` disables, and an unrecognised value throws `FlagValueError` rather than enabling.

### Two errors of my own, recorded

1. I passed five test filenames comma-joined as a single argument, so vitest matched no file: **six ERROR rows, rc=1 with no result**. My harness classified them as ERROR rather than as kills, which is the guard working — but the run was wasted. `local_mutate.py` now splits on commas.
2. I then ran the flag mutations **without `jev-client.test.ts`**, the file whose name the module header actually cites, and J1/J2 survived as a result. Re-run with the right file, J1b dies. **The first survival was my spec, not their gap** — recorded because a survivor attributed to the wrong cause is exactly what I spend my day telling other people to check.

## Gate

- **Mine:** 9 mutations locally across two runs, worktree asserted clean at `e391d24` after each.
- **The builder's:** not quoted — the branch is unpushed and I have no gate result for it.

**Jev — not run**, and the reason is structural rather than a preference: this diff *is* the Jev layer. Scoring it with `jev_review` would ask the tool to assess its own client, and PLAN-v3 §G puts Jev in my hands as a second opinion on other people's code, not as a judge of its own plumbing.

**Verdict: PASS-WITH-FIXES on the code.** The migration matches the plan exactly, the no-text guarantee is enforced at the type rather than by convention, `prompt_version` is in the upsert key where it protects prior evidence, and the principles are respected where I could check them. One fix: pin the falsy half of the flag convention, before five uses ride on it. And it needs pushing and gating before any of this is real.
