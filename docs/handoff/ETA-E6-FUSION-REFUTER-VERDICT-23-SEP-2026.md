# ETA — E-6 fusion (shadow-runner v2). REFUTER VERDICT. 23 Sep 2026

`vinay/e6-fusion` **@ `31fb712`** (builder lx), base `7fea600` (prod `a104723` merged into jev-core `b1618b0`). Order: `~/dev/eta-lab/orders/E6-FUSION.md`. Own detached worktree `/tmp/refute-e6`, HEAD asserted, clean after every run. Nothing pushed, migration 0118 applied nowhere, no database touched. **No Docker on the Mini** (Fable, RULINGS-23-SEP-1540 #6), so I did not re-run lx's postgres:16 migration proof — that is theirs, quoted as theirs, and re-running it belongs on the E2E box.

**11 mutations applied, 1 void, 7 killed, 3 survived** — of which one is a designed control, one is a finding, and one is not a defect. Baselines verified green pristine (33, 33, 31, 66) before any survivor was believed.

## PASS-WITH-FIXES — one real finding, in the old path the new code now affects

### The two production files are genuinely additive

`smooth.ts` and `shadow.ts` are live today, and lx's summary described the new modules without calling these out, so I read the diffs first.

- **`shadow.ts`** only widens what `runShadow` returns (`verdicts`, `transcript`, and two extra fields per probe). `run`, `summary` and `encounters` are untouched. No behaviour change.
- **`smooth.ts`** adds `"content_boundary"` to `CLOSED_BY` — which the acoustic smoother never emits, only `fusion.ts` does — and exports `summariseSpan`, a pass-through to the private `summarise` so a split piece is re-tallied with the smoother's own arithmetic instead of invented counts. That is the right call: it makes the fusion unable to disagree with the smoother about a span it did not compute itself.

### The drift guard survived its own widening, and got better

Widening `CLOSED_BY` touches the exact array↔CHECK coupling I refuted at `d3378dc`. A guard adapted to let a new value through is how such guards die, so this got the most attention.

`effectiveCheckValues` is the right answer to a real hazard: it scans every migration in order and takes the **last** one that defines the constraint, because 0118 drops and re-adds `encounter_hypothesis_closed_by_chk` with six values, so 0114's five are no longer what the database enforces. A drift test pinned to the first file would have compared the code against a list no longer in force. Comment-stripping is preserved on both paths, so my earlier finding stays closed.

| mutation | result |
|---|---|
| **E1** a 7th value in `CLOSED_BY`, 0118 untouched | **killed** |
| **E2** shrink the array alone | **killed** |
| **E3** shrink **both** array and 0118 together, sets still agreeing | **killed**, by `expect(CLOSED_BY).toHaveLength(6)` |
| **E4 CONTROL** reformat 0118's CHECK — reordered, re-line-broken, extra whitespace between `CONSTRAINT`, the name and `CHECK` | **survives, as designed** |

E3 is the one that matters: the F4 guard I verified last round survived the widening and was updated to 6 with its reason kept in the comment. The test also now pins `eff.file` to `0118_encounter_fusion.sql`, so a later migration silently taking over the constraint is caught, and separately asserts 0114 still carries its original five — history not rewritten. E4 confirms the new `constraintAt` whitespace tolerance (lx's flag (f)) did not cost layout-independence.

0118 itself is idempotent by construction: `ADD COLUMN IF NOT EXISTS`, and every constraint `DROP CONSTRAINT IF EXISTS` then re-added.

### The fusion core is well pinned

| mutation | result |
|---|---|
| **P1** the boundary test `<` → `<=` (off-by-one at `START_P`) | **killed** |
| **P2** `START_P` 0.9 → 0.5 | **killed** |
| **P4** the U1/U6 contradiction never flagged | **killed, 2** |
| **P6** a split allowed on a **non-clinical** probe | **killed, 2** |

Worth naming: `no_clinical_probe` vs `no_judged_probe` is the **third independent appearance today** of one distinction — content was judged and none of it was clinical, versus nothing could be judged at all. It is the same shape as the diarizer's "nobody matched" vs "nobody was compared" and the level gate's `silent` vs `unknown`. lx states the reason in the header: E-7 must see how many encounters were rejected *for lack of* evidence separately from those rejected *on* it. Both reject; only one is a measurement.

### FINDING — the v1 path still reads source-blind, so `supersedes` can name a fused run

**E5 survives.** Making `shadow-io.ts:134` source-scoped — `readLatestRun(room_day_id, SMOOTHER_VERSION, "acoustic")` — changes nothing observable: 66/66 on the fusion and hypotheses suites, and **31/31 on `encounter-shadow.test.ts`, the suite that actually drives v1.** So the behaviour is unpinned in either direction.

lx flagged this as (b) — "a read with no source returns the latest run of any source" — and documented it in the tool notes. The part the documentation does not cover is that **an existing production caller is affected**. `shadow-io.ts` is the v1 shadow runner, live today. Its read is by `SMOOTHER_VERSION` with no source, and the acoustic and fused runs **share that version** (`shadow-v2.ts:221–222` reads both under `acousticRun.smoother_version`). So once a fused run exists for a room-day, a subsequent v1 run reports:

```
supersedes: previous.run?.id ?? null      // shadow-io.ts:137 — now possibly a FUSED run's id
```

Nothing is lost — the store is append-only and no row is rewritten — but the claim is false: an acoustic v1 run does not displace a fused run for any reader who asks for fused. The field's own comment says it names "the run this one displaces for readers", and with two sources in play that sentence no longer has one meaning.

**The reason this is worth a fix rather than a note: `shadow-v2.ts:235` already does it correctly**, two files away — `supersedes: { acoustic: prevAcoustic.run?.id ?? null, fused: prevFused.run?.id ?? null }`, each from an explicitly source-scoped read. The new code knows the property; the old path it now affects was not brought along. That is the same class I filed twice on the diarize branch today: **handled where the author was thinking, not at the boundary where the change lands.** One argument and one test close it.

### OBSERVATION — a defensive guard with no test, and no producer that can reach it

**P5 survives**: `if (!j.judged || !j.kind)` → `if (!j.judged)` leaves 33/33 green. I nearly filed this as a gap. It is not one: `shadow-v2.ts:172` sets `judged: kind !== undefined`, so the sole producer cannot emit a judged probe without a kind, and the guard is belt-and-braces relative to it.

It is still worth one line, because `fusion.ts` is documented as PURE and exports its API, the type permits `{ judged: true }` with `kind` absent, and a second producer (an E-7 replay, a harness) could construct it — at which point `phaseOf`'s `default:` branch reads a missing kind as **`consult`**, the clinical answer. The clean resolutions are the ones this programme has converged on today: a test that constructs the state, or a discriminated union (`{judged:false} | {judged:true, kind}`) that makes it unrepresentable and deletes the category, as `engineProvenance` did on the diarize branch.

### VOID, disclosed — one of my mutations proved nothing

**P3 changed text without changing behaviour.** I reordered the `RejectReason` type union (`"no_clinical_probe" | "no_judged_probe"` → the reverse), which is semantically identical, so its 33/33 is not a survivor and is excluded from the counts above. My `git diff` applied-check passed it. This is exactly the failure split-speaker described to me an hour ago — a mutation must change what the code *does*, not what it says — arriving in my own work the same afternoon. The distinction is not reject-reason logic; it is a type declaration.

### Their flags, and what I can say about each

- **(a) U1 asked nine-way, mapped in code** — confirmed, `phaseOf` maps nine choices to four phases plus `unknown`. Right way round: the trialled wording is preserved and the collapse is ours.
- **(b) read with no source** — this is the FINDING above; the tool-notes entry is accurate but incomplete.
- **(c) v2 writes `jev_decision` rows; tool notes corrected** — confirmed present.
- **(d) SQL INFERRED except where the postgres test proves it** — correctly stated. I did not re-run that test (no Docker on the Mini) and do not count it as mine.
- **(e) `START_P` 0.9 provisional** — flagged in the source as PROVISIONAL and pinned by P2, so a change to it cannot pass silently. Correct handling of a provisional number.
- **(f) whitespace tolerance in the constraint matcher** — confirmed by E4; it did not cost layout-independence.

## Verdict: PASS-WITH-FIXES
The production files are additive, the drift guard survived the widening it was most at risk from, and the fusion core's decision boundaries are pinned including the provisional threshold. The one finding is one line and one test, in the old path rather than the new one — the new code already models the property correctly, which is why the gap is worth closing rather than documenting.
