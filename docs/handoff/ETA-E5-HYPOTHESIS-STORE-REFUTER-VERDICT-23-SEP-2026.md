# ETA — E-5 encounter hypothesis store. REFUTER VERDICT. 23 Sep 2026

`vinay/encounter-hypothesis` **@ `39e6b1a`**, one commit on `248c2ae`: `db/migrations/0114_encounter_hypothesis.sql`, `lib/encounter-hypotheses.ts`, the `scribe_encounter_hypotheses` MCP tool in `lib/mcp/tools/voice.ts`, its test, and a docs note. Own read of the tree; nothing pushed; **no migration applied** and no database touched. Mini kept out per Fable's order — night-drain live, swap at 555 MB.

**Builder: lx**, confirmed by lx directly (see the addendum). The commit itself carries no pane attribution — the git author is V, as on every commit here, and the only trailer is the model.

## FAIL — the store cannot hold three of the five verdicts the smoother produces

`db/migrations/0114_encounter_hypothesis.sql`:

```sql
CONSTRAINT encounter_hypothesis_closed_by_chk CHECK (closed_by IN ('non_speech', 'end_of_input')),
```

`lib/encounter-clock/smooth.ts`, both at the merged state on the deploy branch (`2203873`) and at the current head (`c19ece8`):

```ts
closed_by: "non_speech" | "unjudged_gap" | "tape_off" | "dead_mic" | "end_of_input";
```

**`unjudged_gap`, `tape_off` and `dead_mic` cannot be stored.** Those are exactly the three closes Fable's 22 Sep bridging ruling introduced, and that I verified on `0a48bb6` and `c19ece8` earlier today.

### Why it drifted, which is the part worth fixing

`lib/encounter-hypotheses.ts` imports `nanoid` and `sql` and **nothing else**. It re-declares the smoother's contract by hand at `:31` instead of importing it, so there is no compile-time link between the two modules and the typechecker cannot see the divergence — the gate stays green while the two halves disagree. And `smooth.ts` **does not exist at `248c2ae`**, the base this branch is cut from, so the shape was copied from a tree the builder was not on, and the copy was of an older smoother. Field for field the shape is otherwise correct (`version` lives on the run row as `smoother_version`, which is the right normalisation); it is the **value domain** alone that is stale.

### It fails in four places, and the last one silently

| where | what happens |
|---|---|
| `lib/encounter-hypotheses.ts:31` | the TS union has two members, so the smoother's output is not assignable — but nothing imports it, so nothing catches this |
| `:86` validator | `h.closed_by === "non_speech" \|\| h.closed_by === "end_of_input"` → the interval is `bad_interval`, and **the whole run's write is refused** |
| `0114` CHECK | the row is rejected by the database |
| `:212` reader | `r.closed_by === "non_speech" ? "non_speech" : "end_of_input"` — **any unknown value is silently reported as `end_of_input`** |

The coercion is the worst of the four because it does not fail. It also reaches the operator surface: `scribe_encounter_hypotheses` returns `closed_by` straight from the reader, so a `tape_off` row would be shown to an operator as `end_of_input` — an encounter that ended because the recorder stopped, presented as one that ended because the probes ran out.

### This is not an edge case

`tape_off` closes an encounter whenever the recorder stops after the last speech probe. Recording is not 24/7, so **the last encounter of an ordinary room-day closes as `tape_off`**, and `unjudged_gap` fires on any evidence gap beyond the 180 s bridge. On the current smoother most days would produce at least one interval this store refuses — and by the validator's own all-or-nothing rule, refusing one interval refuses the entire run, including the intervals that were fine.

## The fix — Fable's ruling of 23 Sep, named so the builder can work to it

1. **`smooth.ts` exports the `closed_by` values as one `const` array and derives the `Encounter` type from it** (`export const CLOSED_BY = [...] as const;` → `closed_by: typeof CLOSED_BY[number]`).
2. **`encounter-hypotheses.ts` imports that array and stops re-declaring the shape**, so the typechecker enforces the link.
3. **0114's CHECK admits all five values.** 0114 is applied nowhere in production — production is at 112 — so it may be **amended in place ONLY if the builder proves it is applied on no persistent database, Neon branches included**; otherwise it needs a new migration. That proof is the builder's to produce and is not optional: an amended migration that some branch has already applied recreates the exact 0113 trap the voice-centroid work has just finished escaping.
4. **The reader at `:212` must never coerce** — an unknown `closed_by` is an error, not `end_of_input`.
5. **A drift test** that reads the CHECK's value list out of the migration SQL and compares it to the exported array, so this cannot happen a third time.

On (5), the mechanism is already in the repo: this branch's own test reads `0114_encounter_hypothesis.sql` off disk and asserts against its text, and `voice-centroid`'s test does the same for 0113/0115. Parsing the `IN (...)` list and comparing it to `CLOSED_BY` is a few lines in a pattern the repo already uses.

## What is sound, and should survive the fix

Reported so the fix is not mistaken for a rewrite — the rest of this commit is careful work.

- **The two-table design is right.** One row per run, written **even when the run found no encounter**, so "ran and found nothing" and "never ran" cannot share a value — a distinction the MCP tool's description states explicitly (`run:null` vs `n_hypotheses 0`). Append-only, readers take the latest run, older runs stay as history.
- **The counts CHECK is real arithmetic**, not decoration: `probes_speech + probes_non_speech + probes_unjudged = probes_total` on the run, and on the interval `longest_unjudged_run_ms <= unjudged_ms` and `dead_mic_ms <= unjudged_ms`. I traced both against the smoother's `tally()` and they are invariants it actually maintains, not hopeful bounds.
- **`encounter_hypothesis_identity_chk` is the right shape**: a `clinician_id` may be named only together with the `match_source` and `doctor_cosine` that named it, so an identity can never appear without its provenance. The migration comment is explicit that a heuristic role — the diarize service's guess, a Jev label — is never written here as identity. That is the same discipline as `segments-route`.
- **The MCP tool is read-only and text-free**: `scope: "read"`, `additionalProperties: false`, `failSafe`, times and counts and ids only.
- **Ordering is fine.** 0114 is independent of 0113/0115 — its only `REFERENCES` is to its own run table — the runner applies by individual version rather than a high-water mark, and no other branch claims 0114. Detail and evidence in `ETA-VOICE-CENTROID-0115-REFUTER-RECHECK-23-SEP-2026.md`.

### Smaller notes, not blockers

- **`match_source` has no constrained vocabulary.** `clinician_id` is guarded by the identity CHECK, but `match_source` is free text. Given that this column is what distinguishes a voiceprint match from a heuristic — the distinction the migration's own comment is most insistent about — a CHECK on its allowed values would make that promise enforceable rather than conventional. The same class as `closed_by`, one size smaller, and worth fixing while the file is open.
- **Process — WITHDRAWN, my error.** I first noted that the commit records `Full suite 163/163 under /tmp/eta-heavy.lock` against Fable's standing change that full suites run on the Yoga. **That note was wrong and I withdraw it.** lx corrected me with times, and the times check out: the E-5 suite ran 22:32:01–22:41:19 and this commit is timestamped **22:42:20**, while the standing change arrived at **22:50**. The run predates the rule by eight minutes; the heavy lock *was* the rule in force. lx has used the Yoga for everything since (`c652cd2`, `e26c4e2`, `50ff9b6`), and killed the one Mini run still queued when the rule landed. The original note stands only as a record of a Refuter claim that did not survive its own check.

## Mutations — not run

Deliberate. Mutation testing measures whether tests pin the behaviour the code has; here the code's behaviour is wrong against its contract, and the tests pin the wrong vocabulary faithfully — a mutation run would report a high kill rate and tell us nothing. It belongs on the re-check, where the drift test in (5) is the first thing I will try to kill.

## Jev — not run

Same reason. The defect is a contract mismatch between two modules, one of which is not in this diff; a scalar score on the diff alone cannot see it. I will call it on the re-check, when the fix makes the link explicit and there is a design to score.

**Verdict: FAIL.** The design, the constraints and the identity discipline are sound, and the store is close to right. But it was built against a stale copy of the smoother's contract, it silently rewrites the one field that drifted, and on the current smoother most room-days would produce an interval it refuses — which, by its own all-or-nothing validator, means losing the whole day's run.

---

# Addendum — builder confirmed, and the "applied nowhere" condition, 23 Sep

**Builder: lx**, confirmed by lx directly. Branch `vinay/encounter-hypothesis` off `origin/vinay/s1-auto-drain` at `248c2ae`. lx agrees the FAIL is correct, confirmed the drift independently against `c19ece8`, and names the reader's coercion as the worst of the four sites "because it invents a value rather than failing" — which is the right reading.

## Fable's condition (3) — separating what I verified from what is lx's word

Fable's ruling allows 0114 to be amended in place **only if the builder proves it is applied on no persistent database, Neon branches included**. lx has produced that evidence. Marking it by source, because the whole point of the condition is that it not rest on assertion:

**Verified by me, independently, just now:**

- **Production, read-only** (`docs/handoff/scratch/ro_query.py`, `BEGIN READ ONLY`, counts and booleans only): `max(version) = 112`, `106` applied, `has_113 = 0`, `has_114 = 0`, `has_115 = 0`; and `to_regclass` returns false for `encounter_hypothesis`, `encounter_hypothesis_run` and `voice_centroid`. Exactly as lx reported.
- **The 0114 file exists on exactly one ref.** I had already checked every remote branch while answering the ordering question: `0114_encounter_hypothesis.sql` appears only on `origin/vinay/encounter-hypothesis` (and its Yoga mirror), so no other pane's runner could have applied it.

**Verified by Fable, 23 Sep — the half I could not see:**

- Fable checked the Neon control plane directly: **exactly one branch, `br-still-fog-aondvfod` (`main`), production at 112.** No test branch survives. Recorded as Fable's verification, not lx's report — which is what the condition required, since the control plane is the Orchestrator's to see and the pane that wants the amendment should not be the only source for it.

- Still lx's word, and immaterial once the above holds: that the suite's postgres test containers are ephemeral and swept.

**Fable's condition (3) is therefore SATISFIED on verified evidence from both sides — mine for the database and the refs, Fable's for the branch inventory. The in-place amendment of 0114 is authorised on the facts.**

## A sequencing consequence Fable's ruling creates, which needs the order to say

lx raises it and it is real: **fix (2) makes this branch stop building until the encounter-clock branch is in its base.** Importing `CLOSED_BY` from `lib/encounter-clock/smooth.ts` requires that file to exist, and it does not exist at `248c2ae`. So the order must choose one:

- **rebase `vinay/encounter-hypothesis` onto the encounter-clock branch** — available immediately, but it couples the E-5 store's merge to a branch that is itself still blocked (the smoother fix `0a48bb6`/`c19ece8` is not yet on `origin/vinay/s1-auto-drain`, per `ETA-SMOOTHER-BRIDGING-REFUTER-RECHECK-23-SEP-2026.md`); or
- **wait for encounter-clock to merge**, then apply the fix — cleaner history, but E-5 waits on that merge.

Either is defensible and the choice is Fable's; what it cannot be is unstated, because the builder cannot start (2) without it. Noting one consequence of the second option: while E-5 waits, the drift it is fixing stays only as documentation, so if anything else is built against the smoother's contract in the meantime it should import the array rather than copy it — which is the whole point of fix (1).
