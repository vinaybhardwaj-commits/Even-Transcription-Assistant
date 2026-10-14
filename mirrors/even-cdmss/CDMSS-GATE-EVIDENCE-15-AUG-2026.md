# CDMSS rerank telemetry: gate evidence

Raw captured output. Nothing here is transcribed or summarised — every block below is the real
stdout and stderr of the command named above it, with its exit status.

```text
Date          15 August 2026
Worktree      /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry
Branch        exp/rerank-telemetry
HEAD          15d5e8f12c5b450f2fdaf6d69d4aab7490ce211c
HEAD subject  fix(telemetry): deliver the defect map, and stop reading silence as a clean manifest
Tree at start clean
```

## The nine governing commands

Defined at `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md` lines 1191-1212 and
`CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md` lines 496-512. Both lists agree.

```bash
npm test                       # 1. all green, state the count
npm run typecheck              # 2. clean
npm run build                  # 3. green
npm run architecture:check     # 4.
npm run architecture:map       # 5.
git add lib/architecture/map.generated.ts && npm run architecture:map \
  && git diff --exit-code lib/architecture/map.generated.ts   # 6. determinism
npm run reasoning:registry \
  && git diff --exit-code data/reasoning-registry/prompts.generated.json  # 7.
npm run reasoning:governance   # 8.
npm run changelog:coverage     # 9. read-only regression gate
```

Followed by the keyed and unkeyed production build split required by addendum v1 lines 510-512: an
unkeyed production build must FAIL and must name `CDMSS_TELEMETRY_HMAC_KEY`; a keyed build must
succeed.


---

## 1. npm test

```console
$ npm test

> even-cdmss@2.0.0 test
> node --test --import tsx "lib/**/__tests__/*.test.ts"

TAP version 13
# Subtest: verdict normalization maps each store vocab into the right family; needs_action & faithful-as-TP are refused
ok 1 - verdict normalization maps each store vocab into the right family; needs_action & faithful-as-TP are refused
  ---
  duration_ms: 1.582333
  type: 'test'
  ...
# Subtest: precision = (TP+ValidExtra)/(TP+ValidExtra+False); Nitpick/Contested excluded from the denominator
ok 2 - precision = (TP+ValidExtra)/(TP+ValidExtra+False); Nitpick/Contested excluded from the denominator
  ---
  duration_ms: 0.585
  type: 'test'
  ...
# Subtest: precision groups by SURFACE (headline); engine version is the drill-in — same convention
ok 3 - precision groups by SURFACE (headline); engine version is the drill-in — same convention
  ---
  duration_ms: 10.787833
  type: 'test'
  ...
# Subtest: two-page split at the DATA layer: selectFinding drops fidelity; selectFidelity drops finding
ok 4 - two-page split at the DATA layer: selectFinding drops fidelity; selectFidelity drops finding
  ---
  duration_ms: 0.528333
  type: 'test'
  ...
# Subtest: fidelity is NEVER folded into precision — separate rollup, own family
ok 5 - fidelity is NEVER folded into precision — separate rollup, own family
  ---
  duration_ms: 0.223334
  type: 'test'
  ...
# Subtest: GUARDRAIL: no machine/judge verdict store is in the federation set
ok 6 - GUARDRAIL: no machine/judge verdict store is in the federation set
  ---
  duration_ms: 0.436292
  type: 'test'
  ...
# Subtest: ADVISORY: no rollup keys by reviewer — two reviewers on the same (surface,engine) collapse
ok 7 - ADVISORY: no rollup keys by reviewer — two reviewers on the same (surface,engine) collapse
  ---
  duration_ms: 0.57725
  type: 'test'
  ...
# Subtest: ADVISORY: neither the core nor the surface aggregates a per-reviewer accuracy scorecard
ok 8 - ADVISORY: neither the core nor the surface aggregates a per-reviewer accuracy scorecard
  ---
  duration_ms: 3.332209
  type: 'test'
  ...
# Subtest: the two-page split is enforced in the SOURCE — ledger renders no fidelity, fidelity renders no precision
ok 9 - the two-page split is enforced in the SOURCE — ledger renders no fidelity, fidelity renders no precision
  ---
  duration_ms: 0.874209
  type: 'test'
  ...
# Subtest: a name is required and must survive a trim at >= 2 characters
ok 10 - a name is required and must survive a trim at >= 2 characters
  ---
  duration_ms: 1.454708
  type: 'test'
  ...
# Subtest: PERSISTED VERBATIM — trimmed and capped, never title-cased or matched to a roster
ok 11 - PERSISTED VERBATIM — trimmed and capped, never title-cased or matched to a roster
  ---
  duration_ms: 0.096667
  type: 'test'
  ...
# Subtest: THE RULE: no browser storage API is referenced from ANY of the three surfaces
ok 12 - THE RULE: no browser storage API is referenced from ANY of the three surfaces
  ---
  duration_ms: 0.457291
  type: 'test'
  ...
# Subtest: the storage helpers and the key are GONE from the shared module
ok 13 - the storage helpers and the key are GONE from the shared module
  ---
  duration_ms: 0.118792
  type: 'test'
  ...
# Subtest: EACH FIELD RENDERS EMPTY ON MOUNT — no default, no "last used" hint
ok 14 - EACH FIELD RENDERS EMPTY ON MOUNT — no default, no "last used" hint
  ---
  duration_ms: 1.544416
  type: 'test'
  ...
# Subtest: the name is still typed fresh and still sent by all three surfaces
ok 15 - the name is still typed fresh and still sent by all three surfaces
  ---
  duration_ms: 0.098916
  type: 'test'
  ...
# Subtest: THE SAFETY PROPERTY: every route rejects a missing name, not just the UI
ok 16 - THE SAFETY PROPERTY: every route rejects a missing name, not just the UI
  ---
  duration_ms: 0.072875
  type: 'test'
  ...
# Subtest: the routes persist the CLEANED value, not the raw body field
ok 17 - the routes persist the CLEANED value, not the raw body field
  ---
  duration_ms: 0.176458
  type: 'test'
  ...
# Subtest: the UI disables the action until BOTH rationale and name are filled
ok 18 - the UI disables the action until BOTH rationale and name are filled
  ---
  duration_ms: 0.241
  type: 'test'
  ...
# Subtest: the name is actually SENT by all three surfaces
ok 19 - the name is actually SENT by all three surfaces
  ---
  duration_ms: 0.292584
  type: 'test'
  ...
# Subtest: the round-trip guarantee is NOT weakened — a zero-diff re-upload still demands nothing
ok 20 - the round-trip guarantee is NOT weakened — a zero-diff re-upload still demands nothing
  ---
  duration_ms: 0.054708
  type: 'test'
  ...
# Subtest: THE LABEL IS HONEST: "Your name", and the helper text says it is self-declared
ok 21 - THE LABEL IS HONEST: "Your name", and the helper text says it is self-declared
  ---
  duration_ms: 0.051833
  type: 'test'
  ...
# Subtest: nothing anywhere implies authentication
ok 22 - nothing anywhere implies authentication
  ---
  duration_ms: 0.375291
  type: 'test'
  ...
# Subtest: NO MIGRATION WAS CREATED for Phase D
ok 23 - NO MIGRATION WAS CREATED for Phase D
  ---
  duration_ms: 0.728209
  type: 'test'
  ...
# Subtest: NO BACKFILL — existing Unknown/null rows are never rewritten or substituted on read
ok 24 - NO BACKFILL — existing Unknown/null rows are never rewritten or substituted on read
  ---
  duration_ms: 0.686667
  type: 'test'
  ...
# Subtest: D-3 KEPT: a name-only edit is savable, so an old review can gain an author
ok 25 - D-3 KEPT: a name-only edit is savable, so an old review can gain an author
  ---
  duration_ms: 0.1815
  type: 'test'
  ...
# Subtest: the shared error message is the one users actually see, and names no roster
ok 26 - the shared error message is the one users actually see, and names no roster
  ---
  duration_ms: 0.197292
  type: 'test'
  ...
# Subtest: semantics \#4: a DOWNGRADE adjudication preserves every original evidence field
ok 27 - semantics \#4: a DOWNGRADE adjudication preserves every original evidence field
  ---
  duration_ms: 1.218709
  type: 'test'
  ...
# Subtest: semantics \#4: a DROP adjudication still records the original finding_ref in the ledger (auditability)
ok 28 - semantics \#4: a DROP adjudication still records the original finding_ref in the ledger (auditability)
  ---
  duration_ms: 0.169417
  type: 'test'
  ...
# Subtest: semantics \#4: adjudication never MUTATES the original finding object
ok 29 - semantics \#4: adjudication never MUTATES the original finding object
  ---
  duration_ms: 0.139542
  type: 'test'
  ...
# Subtest: semantics \#5a: the advisory CONTEXT_STYLE palette is disjoint from the scored-band palette
ok 30 - semantics \#5a: the advisory CONTEXT_STYLE palette is disjoint from the scored-band palette
  ---
  duration_ms: 2.341458
  type: 'test'
  ...
# Subtest: semantics \#5b: no advisory render line reaches for bandColor/scoreColor (source assertion)
ok 31 - semantics \#5b: no advisory render line reaches for bandColor/scoreColor (source assertion)
  ---
  duration_ms: 0.247541
  type: 'test'
  ...
# Subtest: semantics \#5c: the scored-band palette itself is intact (guards against gaming 5a by editing the bands)
ok 32 - semantics \#5c: the scored-band palette itself is intact (guards against gaming 5a by editing the bands)
  ---
  duration_ms: 0.115083
  type: 'test'
  ...
# Subtest: semantics \#3: a finding-shaped object mints NO MedicationAssertion
ok 33 - semantics \#3: a finding-shaped object mints NO MedicationAssertion
  ---
  duration_ms: 1.216584
  type: 'test'
  ...
# Subtest: semantics \#3: a finding-shaped row through assemble→build mints no problem/medication/investigation
ok 34 - semantics \#3: a finding-shaped row through assemble→build mints no problem/medication/investigation
  ---
  duration_ms: 2.006834
  type: 'test'
  ...
# Subtest: semantics: inquiry output never carries scored-band language
ok 35 - semantics: inquiry output never carries scored-band language
  ---
  duration_ms: 2.242875
  type: 'test'
  ...
# Subtest: semantics: scored cores do not import lib/inquiry (rule 5 reverse direction, source-pinned)
ok 36 - semantics: scored cores do not import lib/inquiry (rule 5 reverse direction, source-pinned)
  ---
  duration_ms: 3.069958
  type: 'test'
  ...
# Subtest: map generation is deterministic and the committed map is current
ok 37 - map generation is deterministic and the committed map is current
  ---
  duration_ms: 573.138625
  type: 'test'
  ...
# Subtest: coverage is a true partition and matches the UNREGISTERED allowlist
ok 38 - coverage is a true partition and matches the UNREGISTERED allowlist
  ---
  duration_ms: 0.510708
  type: 'test'
  ...
# Subtest: the governed modules appear on the map with their INVENTORY planes
ok 39 - the governed modules appear on the map with their INVENTORY planes
  ---
  duration_ms: 0.221958
  type: 'test'
  ...
# Subtest: version registry: declared *_VERSION constants only, live value round-trips
ok 40 - version registry: declared *_VERSION constants only, live value round-trips
  ---
  duration_ms: 0.751792
  type: 'test'
  ...
# Subtest: edges: no self-loops, and the map shows the Slice-1 boundaries clean
ok 41 - edges: no self-loops, and the map shows the Slice-1 boundaries clean
  ---
  duration_ms: 0.773333
  type: 'test'
  ...
# Subtest: ChangeEntry is a true superset: the audit changelog conforms with no data change
ok 42 - ChangeEntry is a true superset: the audit changelog conforms with no data change
  ---
  duration_ms: 0.081375
  type: 'test'
  ...
# Subtest: semantics \#1: silence in a later encounter NEVER resolves a problem (→ uncertain, not resolved)
ok 43 - semantics \#1: silence in a later encounter NEVER resolves a problem (→ uncertain, not resolved)
  ---
  duration_ms: 1.656667
  type: 'test'
  ...
# Subtest: semantics \#1: only an EXPLICIT documented-resolved occurrence flips the status
ok 44 - semantics \#1: only an EXPLICIT documented-resolved occurrence flips the status
  ---
  duration_ms: 0.392125
  type: 'test'
  ...
# Subtest: semantics \#1: a problem documented ON the as-of day stays active — never inferred beyond the evidence
ok 45 - semantics \#1: a problem documented ON the as-of day stays active — never inferred beyond the evidence
  ---
  duration_ms: 0.133625
  type: 'test'
  ...
# Subtest: semantics \#2: a med line maps to status "prescribed" — never a taking/adherence status
ok 46 - semantics \#2: a med line maps to status "prescribed" — never a taking/adherence status
  ---
  duration_ms: 1.131083
  type: 'test'
  ...
# Subtest: semantics \#2: EVERY line of a prescription maps to "prescribed" (bulk path)
ok 47 - semantics \#2: EVERY line of a prescription maps to "prescribed" (bulk path)
  ---
  duration_ms: 0.365166
  type: 'test'
  ...
# Subtest: D2 cut: strict prior-day — same-day and future excluded, prior included
ok 48 - D2 cut: strict prior-day — same-day and future excluded, prior included
  ---
  duration_ms: 0.718917
  type: 'test'
  ...
# Subtest: D2 cut: the audited encounterRef is always dropped even if prior-dated
ok 49 - D2 cut: the audited encounterRef is always dropped even if prior-dated
  ---
  duration_ms: 0.080084
  type: 'test'
  ...
# Subtest: D2 cut: applies identically to care_call / PROM-fold kinds
ok 50 - D2 cut: applies identically to care_call / PROM-fold kinds
  ---
  duration_ms: 0.057
  type: 'test'
  ...
# Subtest: D2 cut: empty when nothing survives (no-prior-history honesty)
ok 51 - D2 cut: empty when nothing survives (no-prior-history honesty)
  ---
  duration_ms: 0.055958
  type: 'test'
  ...
# Subtest: D2 cut: ISO timestamps are compared at day precision
ok 52 - D2 cut: ISO timestamps are compared at day precision
  ---
  duration_ms: 0.0445
  type: 'test'
  ...
# Subtest: D2 cut: does not mutate the input array
ok 53 - D2 cut: does not mutate the input array
  ---
  duration_ms: 0.040334
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: aspirinMaxDailyMg: scheduled regimens sum to perUnitMg × units × doses/day
ok 54 - aspirinMaxDailyMg: scheduled regimens sum to perUnitMg × units × doses/day
  ---
  duration_ms: 2.978208
  type: 'test'
  ...
# Subtest: aspirinMaxDailyMg: D-2 — any unparseable contributing line makes the whole total null
ok 55 - aspirinMaxDailyMg: D-2 — any unparseable contributing line makes the whole total null
  ---
  duration_ms: 0.393375
  type: 'test'
  ...
# Subtest: acetylsalicylic acid is the same molecule as aspirin
ok 56 - acetylsalicylic acid is the same molecule as aspirin
  ---
  duration_ms: 0.801833
  type: 'test'
  ...
# Subtest: §2.3 row 1 — aspirin 75 mg OD + telmisartan: NOTHING fires (was Interaction (moderate))
ok 57 - §2.3 row 1 — aspirin 75 mg OD + telmisartan: NOTHING fires (was Interaction (moderate))
  ---
  duration_ms: 0.112708
  type: 'test'
  ...
# Subtest: §2.3 row 2 — aspirin 75 mg OD + clopidogrel: DAPT (moderate) still fires, unchanged
ok 58 - §2.3 row 2 — aspirin 75 mg OD + clopidogrel: DAPT (moderate) still fires, unchanged
  ---
  duration_ms: 0.280833
  type: 'test'
  ...
# Subtest: §2.3 row 3 — aspirin 75 mg OD + enoxaparin: major still fires, unchanged
ok 59 - §2.3 row 3 — aspirin 75 mg OD + enoxaparin: major still fires, unchanged
  ---
  duration_ms: 0.115958
  type: 'test'
  ...
# Subtest: §2.3 row 4 — aspirin 75 mg OD + diclofenac: Antiplatelet + NSAID (moderate) fires instead of Two NSAIDs
ok 60 - §2.3 row 4 — aspirin 75 mg OD + diclofenac: Antiplatelet + NSAID (moderate) fires instead of Two NSAIDs
  ---
  duration_ms: 0.27225
  type: 'test'
  ...
# Subtest: §2.3 row 5 — aspirin 650 mg TDS + telmisartan: unchanged, 1950 mg/day > 100
ok 61 - §2.3 row 5 — aspirin 650 mg TDS + telmisartan: unchanged, 1950 mg/day > 100
  ---
  duration_ms: 0.15025
  type: 'test'
  ...
# Subtest: §2.3 row 6 — aspirin with an unreadable strength + telmisartan: NOTHING fires (D-2)
ok 62 - §2.3 row 6 — aspirin with an unreadable strength + telmisartan: NOTHING fires (D-2)
  ---
  duration_ms: 0.319167
  type: 'test'
  ...
# Subtest: §2.3 row 7 — aspirin 150 mg OD + telmisartan: unchanged, 150 > 100 (D-1 accepted consequence)
ok 63 - §2.3 row 7 — aspirin 150 mg OD + telmisartan: unchanged, 150 > 100 (D-1 accepted consequence)
  ---
  duration_ms: 0.33675
  type: 'test'
  ...
# Subtest: the threshold is INCLUSIVE at 100 mg/day and exclusive above it
ok 64 - the threshold is INCLUSIVE at 100 mg/day and exclusive above it
  ---
  duration_ms: 0.202791
  type: 'test'
  ...
# Subtest: med-order invariance: the aspirin class does not depend on meds[] order (G-1 stays green)
ok 65 - med-order invariance: the aspirin class does not depend on meds[] order (G-1 stays green)
  ---
  duration_ms: 0.526167
  type: 'test'
  ...
# Subtest: scope guard: a non-aspirin NSAID pair is byte-identical to before the change
ok 66 - scope guard: a non-aspirin NSAID pair is byte-identical to before the change
  ---
  duration_ms: 0.193833
  type: 'test'
  ...
# Subtest: a combination line carrying a NON-aspirin NSAID is never de-classed by the aspirin rule
ok 67 - a combination line carrying a NON-aspirin NSAID is never de-classed by the aspirin rule
  ---
  duration_ms: 0.100167
  type: 'test'
  ...
# Subtest: tagInteractions: suppressNsaid drops only the nsaid tag; antiplatelet survives
ok 68 - tagInteractions: suppressNsaid drops only the nsaid tag; antiplatelet survives
  ---
  duration_ms: 0.104458
  type: 'test'
  ...
# Subtest: SQL twin and canonicalByUid select the SAME row — all traps
ok 69 - SQL twin and canonicalByUid select the SAME row — all traps
  ---
  duration_ms: 1.451125
  type: 'test'
  ...
# Subtest: the ordering is the one THE RULE states — reverting it fails this test
ok 70 - the ordering is the one THE RULE states — reverting it fails this test
  ---
  duration_ms: 0.131625
  type: 'test'
  ...
# Subtest: §6 — SCAN lib/ and app/: nobody hand-writes a note-identity dedup on opd_note_audits
ok 71 - §6 — SCAN lib/ and app/: nobody hand-writes a note-identity dedup on opd_note_audits
  ---
  duration_ms: 96.003959
  type: 'test'
  ...
# Subtest: no doctor-facing surface writes its own NOTE-IDENTITY dedup
ok 72 - no doctor-facing surface writes its own NOTE-IDENTITY dedup
  ---
  duration_ms: 0.287292
  type: 'test'
  ...
# Subtest: ONE RULE across every surface — governance and stewardship included (addendum D)
ok 73 - ONE RULE across every surface — governance and stewardship included (addendum D)
  ---
  duration_ms: 0.304791
  type: 'test'
  ...
# Subtest: a non-numeric tail that is NOT -mini cannot reach the cast — shape, not suffix (learning.ts)
ok 74 - a non-numeric tail that is NOT -mini cannot reach the cast — shape, not suffix (learning.ts)
  ---
  duration_ms: 0.883334
  type: 'test'
  ...
# Subtest: canonicalDistinctOnSql composes the identity, the columns and the rank tail
ok 75 - canonicalDistinctOnSql composes the identity, the columns and the rank tail
  ---
  duration_ms: 0.221583
  type: 'test'
  ...
# Subtest: the migration adds provider to BOTH audit tables
ok 76 - the migration adds provider to BOTH audit tables
  ---
  duration_ms: 0.659583
  type: 'test'
  ...
# Subtest: IT IS IDEMPOTENT — running it twice is a no-op
ok 77 - IT IS IDEMPOTENT — running it twice is a no-op
  ---
  duration_ms: 0.586125
  type: 'test'
  ...
# Subtest: NO index, NO default, NO backfill — a null provider must stay distinguishable
ok 78 - NO index, NO default, NO backfill — a null provider must stay distinguishable
  ---
  duration_ms: 0.283625
  type: 'test'
  ...
# Subtest: the migration records WHY the column exists
ok 79 - the migration records WHY the column exists
  ---
  duration_ms: 0.219333
  type: 'test'
  ...
# Subtest: a saved OPD row carries BOTH provider and model
ok 80 - a saved OPD row carries BOTH provider and model
  ---
  duration_ms: 0.125625
  type: 'test'
  ...
# Subtest: OPD: a re-audit RE-ATTRIBUTES — provider is in the conflict SET, like model
ok 81 - OPD: a re-audit RE-ATTRIBUTES — provider is in the conflict SET, like model
  ---
  duration_ms: 0.053166
  type: 'test'
  ...
# Subtest: OPD: the column is PROBED, so the deploy is safe before the migration runs
ok 82 - OPD: the column is PROBED, so the deploy is safe before the migration runs
  ---
  duration_ms: 0.110709
  type: 'test'
  ...
# Subtest: a saved IPD row carries BOTH provider and model
ok 83 - a saved IPD row carries BOTH provider and model
  ---
  duration_ms: 0.054959
  type: 'test'
  ...
# Subtest: IPD: the column is PROBED too, against its OWN table
ok 84 - IPD: the column is PROBED too, against its OWN table
  ---
  duration_ms: 0.181792
  type: 'test'
  ...
# Subtest: both workers read model AND provider from ONE row of ONE query
ok 85 - both workers read model AND provider from ONE row of ONE query
  ---
  duration_ms: 1.381125
  type: 'test'
  ...
# Subtest: THE MINI PATH RECORDS ollama
ok 86 - THE MINI PATH RECORDS ollama
  ---
  duration_ms: 0.184708
  type: 'test'
  ...
# Subtest: NEVER FROM A CONSTANT — the D-D defect that bit twice
ok 87 - NEVER FROM A CONSTANT — the D-D defect that bit twice
  ---
  duration_ms: 0.247459
  type: 'test'
  ...
# Subtest: a NULL provider is accepted and stored as null, not the string "null"
ok 88 - a NULL provider is accepted and stored as null, not the string "null"
  ---
  duration_ms: 0.176875
  type: 'test'
  ...
# Subtest: lib/audit-canonical.ts is UNTOUCHED — the grader tier is Unit C
ok 89 - lib/audit-canonical.ts is UNTOUCHED — the grader tier is Unit C
  ---
  duration_ms: 0.473292
  type: 'test'
  ...
# Subtest: applyDemotes: match → informational + quieted_by; stored fields untouched; non-match untouched
ok 90 - applyDemotes: match → informational + quieted_by; stored fields untouched; non-match untouched
  ---
  duration_ms: 1.309584
  type: 'test'
  ...
# Subtest: applyDemotes: lvc_category is exact + case-insensitive; subject_contains reuses the matcher
ok 91 - applyDemotes: lvc_category is exact + case-insensitive; subject_contains reuses the matcher
  ---
  duration_ms: 0.256667
  type: 'test'
  ...
# Subtest: applyDemotes: proposed / retired / inactive rules quiet NOTHING (a proposal scores nothing)
ok 92 - applyDemotes: proposed / retired / inactive rules quiet NOTHING (a proposal scores nothing)
  ---
  duration_ms: 0.316417
  type: 'test'
  ...
# Subtest: applyDemotes: already-informational findings are left alone (never re-badged as quieted)
ok 93 - applyDemotes: already-informational findings are left alone (never re-badged as quieted)
  ---
  duration_ms: 0.160334
  type: 'test'
  ...
# Subtest: severity floor, store half: a rule on ANY deterministic safety signal type is refused, for EVERY action
ok 94 - severity floor, store half: a rule on ANY deterministic safety signal type is refused, for EVERY action
  ---
  duration_ms: 0.442084
  type: 'test'
  ...
# Subtest: severity floor, engine half (drop/downgrade): a drop rule can NEVER remove a banned_fdc finding
ok 95 - severity floor, engine half (drop/downgrade): a drop rule can NEVER remove a banned_fdc finding
  ---
  duration_ms: 0.246042
  type: 'test'
  ...
# Subtest: severity floor, engine half (drop/downgrade): a downgrade rule can NEVER informational-ise a high-alert finding
ok 96 - severity floor, engine half (drop/downgrade): a downgrade rule can NEVER informational-ise a high-alert finding
  ---
  duration_ms: 0.227042
  type: 'test'
  ...
# Subtest: severity floor does not over-reach: a drop rule on a NON-safety type still drops (regression guard)
ok 97 - severity floor does not over-reach: a drop rule on a NON-safety type still drops (regression guard)
  ---
  duration_ms: 0.1345
  type: 'test'
  ...
# Subtest: zero-delta: applySuppressions with no rules returns the input findings unchanged
ok 98 - zero-delta: applySuppressions with no rules returns the input findings unchanged
  ---
  duration_ms: 1.879333
  type: 'test'
  ...
# Subtest: severity floor, engine half: safety findings are skipped even when a rule somehow matches them
ok 99 - severity floor, engine half: safety findings are skipped even when a rule somehow matches them
  ---
  duration_ms: 0.513042
  type: 'test'
  ...
# Subtest: demote rules never flow through applySuppressions semantics (quieting is its own seam)
ok 100 - demote rules never flow through applySuppressions semantics (quieting is its own seam)
  ---
  duration_ms: 0.088
  type: 'test'
  ...
# Subtest: §8.1 paired scoring: same note, rule active vs not — demoted finding contributes exactly zero
ok 101 - §8.1 paired scoring: same note, rule active vs not — demoted finding contributes exactly zero
  ---
  duration_ms: 0.663291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: store half: a drop/downgrade/demote rule on ANY safety signal type is refused before the INSERT
ok 102 - store half: a drop/downgrade/demote rule on ANY safety signal type is refused before the INSERT
  ---
  duration_ms: 1.719792
  type: 'test'
  ...
# Subtest: store half: the floor does not over-reach — a non-safety type gets past validation
ok 103 - store half: the floor does not over-reach — a non-safety type gets past validation
  ---
  duration_ms: 0.299792
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a run names bedrock or vertex — qwen is retired from backfill, and the refusal says so
ok 104 - a run names bedrock or vertex — qwen is retired from backfill, and the refusal says so
  ---
  duration_ms: 5.068833
  type: 'test'
  ...
# Subtest: the cursor STARTS at day_to and the range is validated
ok 105 - the cursor STARTS at day_to and the range is validated
  ---
  duration_ms: 0.499
  type: 'test'
  ...
# Subtest: n_per_tick clamps to 1..8 and junk becomes the default, never 0
ok 106 - n_per_tick clamps to 1..8 and junk becomes the default, never 0
  ---
  duration_ms: 0.140459
  type: 'test'
  ...
# Subtest: §4.3.1 — one active run per worker, and it is a typed refusal not a queue
ok 107 - §4.3.1 — one active run per worker, and it is a typed refusal not a queue
  ---
  duration_ms: 0.171209
  type: 'test'
  ...
# Subtest: no active run ⇒ IDLE, which is a normal state and not an error
ok 108 - no active run ⇒ IDLE, which is a normal state and not an error
  ---
  duration_ms: 0.158917
  type: 'test'
  ...
# Subtest: a non-active run is skipped, and a spent cursor reads as done
ok 109 - a non-active run is skipped, and a spent cursor reads as done
  ---
  duration_ms: 0.200542
  type: 'test'
  ...
# Subtest: a run whose cursor was lost resumes at day_to instead of stalling
ok 110 - a run whose cursor was lost resumes at day_to instead of stalling
  ---
  duration_ms: 0.104666
  type: 'test'
  ...
# Subtest: ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY
ok 111 - ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY
  ---
  duration_ms: 0.2985
  type: 'test'
  ...
# Subtest: the run is DONE when the cursor passes below day_from — inclusive at both ends
ok 112 - the run is DONE when the cursor passes below day_from — inclusive at both ends
  ---
  duration_ms: 0.761084
  type: 'test'
  ...
# Subtest: prevDay is UTC date arithmetic — no timezone drift across a month or year boundary
ok 113 - prevDay is UTC date arithmetic — no timezone drift across a month or year boundary
  ---
  duration_ms: 0.37125
  type: 'test'
  ...
# Subtest: a failed NOTE is counted and the run continues; a failed TICK errors the run
ok 114 - a failed NOTE is counted and the run continues; a failed TICK errors the run
  ---
  duration_ms: 0.120125
  type: 'test'
  ...
# Subtest: accounting never poisons a total with NaN, and never runs backwards
ok 115 - accounting never poisons a total with NaN, and never runs backwards
  ---
  duration_ms: 0.113667
  type: 'test'
  ...
# Subtest: an errored run is RESUMABLE — the whole point of erroring rather than stopping
ok 116 - an errored run is RESUMABLE — the whole point of erroring rather than stopping
  ---
  duration_ms: 0.129291
  type: 'test'
  ...
# Subtest: the DDL is the PRD’s, idempotent, with a partial unique index behind the one-run rule
ok 117 - the DDL is the PRD’s, idempotent, with a partial unique index behind the one-run rule
  ---
  duration_ms: 2.070709
  type: 'test'
  ...
# Subtest: run accounting is an in-SQL increment, so overlapping ticks cannot lose counts
ok 118 - run accounting is an in-SQL increment, so overlapping ticks cannot lose counts
  ---
  duration_ms: 0.698458
  type: 'test'
  ...
# Subtest: ⚠️ FILL-ONLY: the skip rule is unchanged, and it is what makes a prod-line label safe
ok 119 - ⚠️ FILL-ONLY: the skip rule is unchanged, and it is what makes a prod-line label safe
  ---
  duration_ms: 0.926792
  type: 'test'
  ...
# Subtest: the row is PROD-LINE and stamped with WHAT SERVED, never MINI_MODEL
ok 120 - the row is PROD-LINE and stamped with WHAT SERVED, never MINI_MODEL
  ---
  duration_ms: 0.854292
  type: 'test'
  ...
# Subtest: scheduling: the night window and the lab-batch yield are gone, the soft lock stays
ok 121 - scheduling: the night window and the lab-batch yield are gone, the soft lock stays
  ---
  duration_ms: 0.256916
  type: 'test'
  ...
# Subtest: reachability is re-checked EVERY tick, for the RUN’S provider, so unsetting a var is a clean rollback
ok 122 - reachability is re-checked EVERY tick, for the RUN’S provider, so unsetting a var is a clean rollback
  ---
  duration_ms: 0.231958
  type: 'test'
  ...
# Subtest: the control endpoint speaks the five actions, on this route
ok 123 - the control endpoint speaks the five actions, on this route
  ---
  duration_ms: 0.127458
  type: 'test'
  ...
# Subtest: a bedrock row is a CLOUD grader and a CANDIDATE model — for EVERY id the transport accepts
ok 124 - a bedrock row is a CLOUD grader and a CANDIDATE model — for EVERY id the transport accepts
  ---
  duration_ms: 0.155
  type: 'test'
  ...
# Subtest: a bedrock row beats a qwen row, and loses to Gemini at the same version
ok 125 - a bedrock row beats a qwen row, and loses to Gemini at the same version
  ---
  duration_ms: 0.194167
  type: 'test'
  ...
# Subtest: cost_usd is real dollars, and costInr composes from it
ok 126 - cost_usd is real dollars, and costInr composes from it
  ---
  duration_ms: 0.111167
  type: 'test'
  ...
# Subtest: C2: a vertex run is refused unless it names the Gemini this deployment will actually use
ok 127 - C2: a vertex run is refused unless it names the Gemini this deployment will actually use
  ---
  duration_ms: 0.093833
  type: 'test'
  ...
# Subtest: C2: cost accrues on a vertex run through the SAME pricing path as a bedrock one
ok 128 - C2: cost accrues on a vertex run through the SAME pricing path as a bedrock one
  ---
  duration_ms: 0.287375
  type: 'test'
  ...
# Subtest: C4: a STOP issued mid-tick survives the tick’s completion write
ok 129 - C4: a STOP issued mid-tick survives the tick’s completion write
  ---
  duration_ms: 0.332291
  type: 'test'
  ...
# Subtest: C3: pace is weighted by notes, and only this run’s productive ticks count
ok 130 - C3: pace is weighted by notes, and only this run’s productive ticks count
  ---
  duration_ms: 0.122209
  type: 'test'
  ...
# Subtest: C3: the ETA says what it is BASED on, and stays null rather than guessing
ok 131 - C3: the ETA says what it is BASED on, and stays null rather than guessing
  ---
  duration_ms: 0.177292
  type: 'test'
  ...
# Subtest: C3: a stall is 300s of silence on an ACTIVE worker — never on a paused or idle one
ok 132 - C3: a stall is 300s of silence on an ACTIVE worker — never on a paused or idle one
  ---
  duration_ms: 0.076
  type: 'test'
  ...
# Subtest: C3: the monitor exposes ETA + stall for BOTH arms of the bake-off
ok 133 - C3: the monitor exposes ETA + stall for BOTH arms of the bake-off
  ---
  duration_ms: 0.187625
  type: 'test'
  ...
# Subtest: C1: the batch accepts bedrock, refuses every other provider, and no model ⇒ the mini path
ok 134 - C1: the batch accepts bedrock, refuses every other provider, and no model ⇒ the mini path
  ---
  duration_ms: 0.203084
  type: 'test'
  ...
# Subtest: C1: a bedrock batch is TRACED and verified against that trace — a paid claim must be provable
ok 135 - C1: a bedrock batch is TRACED and verified against that trace — a paid claim must be provable
  ---
  duration_ms: 0.109458
  type: 'test'
  ...
# Subtest: C1: the row carries who SERVED, and that is what makes the paid ceiling count it
ok 136 - C1: the row carries who SERVED, and that is what makes the paid ceiling count it
  ---
  duration_ms: 0.188084
  type: 'test'
  ...
# Subtest: C1: the bedrock arm does not yield to the Mac-mini it never touches
ok 137 - C1: the bedrock arm does not yield to the Mac-mini it never touches
  ---
  duration_ms: 0.092292
  type: 'test'
  ...
# Subtest: C1: the poison-note budget covers the PAID arm, or a bad note retries for ever at a price
ok 138 - C1: the poison-note budget covers the PAID arm, or a bad note retries for ever at a price
  ---
  duration_ms: 0.125667
  type: 'test'
  ...
# Subtest: C1: lab_batch_start writes the model key on EVERY start, so a paid arm cannot leak forward
ok 139 - C1: lab_batch_start writes the model key on EVERY start, so a paid arm cannot leak forward
  ---
  duration_ms: 0.378042
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the five membership cases from the kickoff, exactly
ok 140 - the five membership cases from the kickoff, exactly
  ---
  duration_ms: 0.65475
  type: 'test'
  ...
# Subtest: a future version does not sneak in via its tag either
ok 141 - a future version does not sneak in via its tag either
  ---
  duration_ms: 0.067708
  type: 'test'
  ...
# Subtest: the engine NAME keeps its own hyphens — a naive split on "-" would be wrong
ok 142 - the engine NAME keeps its own hyphens — a naive split on "-" would be wrong
  ---
  duration_ms: 0.095833
  type: 'test'
  ...
# Subtest: stripping takes the FIRST hyphen after the version, however many follow
ok 143 - stripping takes the FIRST hyphen after the version, however many follow
  ---
  duration_ms: 0.043917
  type: 'test'
  ...
# Subtest: an untagged string is returned unchanged, and the helper is total
ok 144 - an untagged string is returned unchanged, and the helper is total
  ---
  duration_ms: 0.105583
  type: 'test'
  ...
# Subtest: EVERY member of the family list is in its own line, tagged or not
ok 145 - EVERY member of the family list is in its own line, tagged or not
  ---
  duration_ms: 0.079417
  type: 'test'
  ...
# Subtest: auditedUidsForDay is UNCHANGED — still the exact-version, unfiltered read (DEC-3)
ok 146 - auditedUidsForDay is UNCHANGED — still the exact-version, unfiltered read (DEC-3)
  ---
  duration_ms: 0.134625
  type: 'test'
  ...
# Subtest: the day filter on the new read is byte-identical to auditedUidsForDay
ok 147 - the day filter on the new read is byte-identical to auditedUidsForDay
  ---
  duration_ms: 0.047708
  type: 'test'
  ...
# Subtest: the new read does NOT swallow its own errors — an empty skip list would re-audit everything
ok 148 - the new read does NOT swallow its own errors — an empty skip list would re-audit everything
  ---
  duration_ms: 0.230042
  type: 'test'
  ...
# Subtest: the four mini-backfill call sites use the line rule; the Gemini worker is untouched
ok 149 - the four mini-backfill call sites use the line rule; the Gemini worker is untouched
  ---
  duration_ms: 0.773375
  type: 'test'
  ...
# Subtest: the work selection and the day-complete decision use the SAME rule
ok 150 - the work selection and the day-complete decision use the SAME rule
  ---
  duration_ms: 0.12225
  type: 'test'
  ...
# Subtest: superset fires: the banned pair plus one extra molecule
ok 151 - superset fires: the banned pair plus one extra molecule
  ---
  duration_ms: 0.817
  type: 'test'
  ...
# Subtest: subset-missing-one fires: two of a banned three
ok 152 - subset-missing-one fires: two of a banned three
  ---
  duration_ms: 0.116375
  type: 'test'
  ...
# Subtest: an exact match does NOT also near-miss — and neither does the entry it matched
ok 153 - an exact match does NOT also near-miss — and neither does the entry it matched
  ---
  duration_ms: 0.528792
  type: 'test'
  ...
# Subtest: missing TWO molecules is silent (|E| − |S| = 1 only)
ok 154 - missing TWO molecules is silent (|E| − |S| = 1 only)
  ---
  duration_ms: 0.080625
  type: 'test'
  ...
# Subtest: a single-molecule product is silent — |S| ≥ 2, inherited from the exact-match check
ok 155 - a single-molecule product is silent — |S| ≥ 2, inherited from the exact-match check
  ---
  duration_ms: 0.121833
  type: 'test'
  ...
# Subtest: overlap without containment is silent (neither superset nor subset)
ok 156 - overlap without containment is silent (neither superset nor subset)
  ---
  duration_ms: 0.057125
  type: 'test'
  ...
# Subtest: cap: at most 3 near-miss findings per note, in ENTRY order
ok 157 - cap: at most 3 near-miss findings per note, in ENTRY order
  ---
  duration_ms: 0.388709
  type: 'test'
  ...
# Subtest: one finding per ENTRY even when several products near-miss it
ok 158 - one finding per ENTRY even when several products near-miss it
  ---
  duration_ms: 0.125292
  type: 'test'
  ...
# Subtest: malformed / empty tables and meds are silent — never throw (§7 posture, inherited)
ok 159 - malformed / empty tables and meds are silent — never throw (§7 posture, inherited)
  ---
  duration_ms: 0.289375
  type: 'test'
  ...
# Subtest: the finding is non-scoring by construction: informational + confidence 0 + uncertain
ok 160 - the finding is non-scoring by construction: informational + confidence 0 + uncertain
  ---
  duration_ms: 0.346084
  type: 'test'
  ...
# Subtest: signal_type resolves to banned_fdc_near_miss (and does not collide with banned_fdc)
ok 161 - signal_type resolves to banned_fdc_near_miss (and does not collide with banned_fdc)
  ---
  duration_ms: 3.442875
  type: 'test'
  ...
# Subtest: tier resolves to 3 — log only, never an action row (D-3)
ok 162 - tier resolves to 3 — log only, never an action row (D-3)
  ---
  duration_ms: 0.510791
  type: 'test'
  ...
# Subtest: ⚠️ THE MINT IS THE IAM CREDENTIALS API, NOT THE JWT-BEARER TOKEN ENDPOINT
ok 163 - ⚠️ THE MINT IS THE IAM CREDENTIALS API, NOT THE JWT-BEARER TOKEN ENDPOINT
  ---
  duration_ms: 1.488333
  type: 'test'
  ...
# Subtest: step 1 is the EXISTING access-token flow, reused rather than duplicated
ok 164 - step 1 is the EXISTING access-token flow, reused rather than duplicated
  ---
  duration_ms: 0.19225
  type: 'test'
  ...
# Subtest: step 2 is :generateIdToken with {audience, includeEmail}, and reads `token`
ok 165 - step 2 is :generateIdToken with {audience, includeEmail}, and reads `token`
  ---
  duration_ms: 0.333042
  type: 'test'
  ...
# Subtest: the failure carries the BODY and both identities — a 403 here is ambiguous without them
ok 166 - the failure carries the BODY and both identities — a 403 here is ambiguous without them
  ---
  duration_ms: 0.144
  type: 'test'
  ...
# Subtest: cached per audience, 55 minutes of usable life, exp never decoded
ok 167 - cached per audience, 55 minutes of usable life, exp never decoded
  ---
  duration_ms: 0.194666
  type: 'test'
  ...
# Subtest: no log line in the auth chain can print a token, key or credential
ok 168 - no log line in the auth chain can print a token, key or credential
  ---
  duration_ms: 0.490959
  type: 'test'
  ...
# Subtest: the refresh decision: fresh reuses, inside-the-skew re-mints, expired re-mints
ok 169 - the refresh decision: fresh reuses, inside-the-skew re-mints, expired re-mints
  ---
  duration_ms: 0.154792
  type: 'test'
  ...
# Subtest: VERIFICATION 8, without a warm instance: two calls 61 minutes apart cannot share credentials
ok 170 - VERIFICATION 8, without a warm instance: two calls 61 minutes apart cannot share credentials
  ---
  duration_ms: 0.710458
  type: 'test'
  ...
# Subtest: an undatable credential is UNUSABLE — never reused on the benefit of the doubt
ok 171 - an undatable credential is UNUSABLE — never reused on the benefit of the doubt
  ---
  duration_ms: 0.252833
  type: 'test'
  ...
# Subtest: the STS call is the reference’s call: role, session name, 60 minutes, unsigned client
ok 172 - the STS call is the reference’s call: role, session name, 60 minutes, unsigned client
  ---
  duration_ms: 0.326834
  type: 'test'
  ...
# Subtest: bedrockConfigured needs all four vars — and never gates on AWS_REGION
ok 173 - bedrockConfigured needs all four vars — and never gates on AWS_REGION
  ---
  duration_ms: 0.619958
  type: 'test'
  ...
# Subtest: exactly three model ids, and an unlisted one is REFUSED rather than sent
ok 174 - exactly three model ids, and an unlisted one is REFUSED rather than sent
  ---
  duration_ms: 0.298209
  type: 'test'
  ...
# Subtest: OpenAI chat params → Converse: system split out, roles mapped, inferenceConfig built
ok 175 - OpenAI chat params → Converse: system split out, roles mapped, inferenceConfig built
  ---
  duration_ms: 0.199292
  type: 'test'
  ...
# Subtest: consecutive same-role turns MERGE — Converse rejects them and dropping one would edit the prompt
ok 176 - consecutive same-role turns MERGE — Converse rejects them and dropping one would edit the prompt
  ---
  duration_ms: 0.081917
  type: 'test'
  ...
# Subtest: mapping degrades safely on shapes the repo does not send today
ok 177 - mapping degrades safely on shapes the repo does not send today
  ---
  duration_ms: 0.15525
  type: 'test'
  ...
# Subtest: Converse response → the OpenAI shape every consumer in this repo already reads
ok 178 - Converse response → the OpenAI shape every consumer in this repo already reads
  ---
  duration_ms: 0.176917
  type: 'test'
  ...
# Subtest: ⚠️ stopReason → finish_reason is load-bearing: end_turn MUST become stop
ok 179 - ⚠️ stopReason → finish_reason is load-bearing: end_turn MUST become stop
  ---
  duration_ms: 0.053375
  type: 'test'
  ...
# Subtest: usage degrades safely: a missing total is derived, a missing usage is zero (never null cost)
ok 180 - usage degrades safely: a missing total is derived, a missing usage is zero (never null cost)
  ---
  duration_ms: 0.065292
  type: 'test'
  ...
# Subtest: the stream shim satisfies a `for await` caller and carries the usage chunk
ok 181 - the stream shim satisfies a `for await` caller and carries the usage chunk
  ---
  duration_ms: 0.10725
  type: 'test'
  ...
# Subtest: an explicit bedrock target OUTRANKS both cloud tiers and has no ladder behind it
ok 182 - an explicit bedrock target OUTRANKS both cloud tiers and has no ladder behind it
  ---
  duration_ms: 0.17975
  type: 'test'
  ...
# Subtest: ⚠️ the bedrock target reaches BOTH governedChat arms — the traceless one cannot drop it
ok 183 - ⚠️ the bedrock target reaches BOTH governedChat arms — the traceless one cannot drop it
  ---
  duration_ms: 0.082209
  type: 'test'
  ...
# Subtest: the budget reaches the transport, and its default is READ FROM THE TABLE
ok 184 - the budget reaches the transport, and its default is READ FROM THE TABLE
  ---
  duration_ms: 0.106417
  type: 'test'
  ...
# Subtest: the provider_error record names BOTH identities in the chain
ok 185 - the provider_error record names BOTH identities in the chain
  ---
  duration_ms: 0.123042
  type: 'test'
  ...
# Subtest: the override gate and the routing map carry bedrock end to end
ok 186 - the override gate and the routing map carry bedrock end to end
  ---
  duration_ms: 0.064958
  type: 'test'
  ...
# Subtest: each model prices at its published global-endpoint rate, and never at a Gemini rate
ok 187 - each model prices at its published global-endpoint rate, and never at a Gemini rate
  ---
  duration_ms: 0.141041
  type: 'test'
  ...
# Subtest: ⚠️ the cost tracker actually SELECTS Bedrock rows — rates alone would have shown ₹0
ok 188 - ⚠️ the cost tracker actually SELECTS Bedrock rows — rates alone would have shown ₹0
  ---
  duration_ms: 0.031833
  type: 'test'
  ...
# Subtest: with no bedrock target the dispatch is the pre-existing one, line for line
ok 189 - with no bedrock target the dispatch is the pre-existing one, line for line
  ---
  duration_ms: 1.11525
  type: 'test'
  ...
# Subtest: labRoutingOpts is still {} with no override — the spread stays byte-identical
ok 190 - labRoutingOpts is still {} with no override — the spread stays byte-identical
  ---
  duration_ms: 0.058667
  type: 'test'
  ...
# Subtest: mini_analyze refuses a provider its seam cannot serve, instead of stamping the row anyway
ok 191 - mini_analyze refuses a provider its seam cannot serve, instead of stamping the row anyway
  ---
  duration_ms: 0.416709
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: default BM25 SQL is byte-identical to the shipped plainto-AND leg
ok 192 - default BM25 SQL is byte-identical to the shipped plainto-AND leg
  ---
  duration_ms: 1.11525
  type: 'test'
  ...
# Subtest: discriminating selection drops common terms (DF > dfMax) and OR-joins the rare ones
ok 193 - discriminating selection drops common terms (DF > dfMax) and OR-joins the rare ones
  ---
  duration_ms: 0.5205
  type: 'test'
  ...
# Subtest: parseTsqueryLexemes extracts bare lexemes from a plainto ::text
ok 194 - parseTsqueryLexemes extracts bare lexemes from a plainto ::text
  ---
  duration_ms: 0.202417
  type: 'test'
  ...
# Subtest: discriminating BM25 SQL always caps the candidate set before ranking
ok 195 - discriminating BM25 SQL always caps the candidate set before ranking
  ---
  duration_ms: 0.075625
  type: 'test'
  ...
# Subtest: only-common-terms yields no discriminating lexemes ⇒ empty tsquery ⇒ BM25 leg is skipped
ok 196 - only-common-terms yields no discriminating lexemes ⇒ empty tsquery ⇒ BM25 leg is skipped
  ---
  duration_ms: 0.133458
  type: 'test'
  ...
# Subtest: the DF-estimate SQL is the bounded planner EXPLAIN, never a COUNT over the corpus
ok 197 - the DF-estimate SQL is the bounded planner EXPLAIN, never a COUNT over the corpus
  ---
  duration_ms: 0.658208
  type: 'test'
  ...
# Subtest: buildAskSet: high-alert med first
ok 198 - buildAskSet: high-alert med first
  ---
  duration_ms: 2.747708
  type: 'test'
  ...
# Subtest: buildAskSet: med cap 3 (4th med → overflow)
ok 199 - buildAskSet: med cap 3 (4th med → overflow)
  ---
  duration_ms: 0.167208
  type: 'test'
  ...
# Subtest: buildAskSet: overall cap 5, rest overflow
ok 200 - buildAskSet: overall cap 5, rest overflow
  ---
  duration_ms: 0.163667
  type: 'test'
  ...
# Subtest: buildAskSet: follow-up keyword extraction (advice "repeat")
ok 201 - buildAskSet: follow-up keyword extraction (advice "repeat")
  ---
  duration_ms: 0.178291
  type: 'test'
  ...
# Subtest: buildAskSet: no follow-up when no keyword and no followUpType
ok 202 - buildAskSet: no follow-up when no keyword and no followUpType
  ---
  duration_ms: 0.110583
  type: 'test'
  ...
# Subtest: buildAskSet: followUpType real + no date → follow-up ask
ok 203 - buildAskSet: followUpType real + no date → follow-up ask
  ---
  duration_ms: 0.077208
  type: 'test'
  ...
# Subtest: buildAskSet: complaint cap 2
ok 204 - buildAskSet: complaint cap 2
  ---
  duration_ms: 0.103583
  type: 'test'
  ...
# Subtest: buildAskSet: allergy only when the note field is blank
ok 205 - buildAskSet: allergy only when the note field is blank
  ---
  duration_ms: 0.143458
  type: 'test'
  ...
# Subtest: buildAskSet: outside-records is generated last if room
ok 206 - buildAskSet: outside-records is generated last if room
  ---
  duration_ms: 1.293417
  type: 'test'
  ...
# Subtest: buildAskSet: empty-ish case → just the outside-records ask
ok 207 - buildAskSet: empty-ish case → just the outside-records ask
  ---
  duration_ms: 2.853542
  type: 'test'
  ...
# Subtest: buildAskSet: deterministic ask ids + deep-equal on re-run
ok 208 - buildAskSet: deterministic ask ids + deep-equal on re-run
  ---
  duration_ms: 1.068666
  type: 'test'
  ...
# Subtest: deriveAssertions: med chips → statuses; stopped carries reason; parse generic/brand
ok 209 - deriveAssertions: med chips → statuses; stopped carries reason; parse generic/brand
  ---
  duration_ms: 0.254
  type: 'test'
  ...
# Subtest: deriveAssertions: skip produces NO assertion
ok 210 - deriveAssertions: skip produces NO assertion
  ---
  duration_ms: 0.040709
  type: 'test'
  ...
# Subtest: deriveAssertions: complaint + follow-up + allergy chips
ok 211 - deriveAssertions: complaint + follow-up + allergy chips
  ---
  duration_ms: 0.118542
  type: 'test'
  ...
# Subtest: deriveAssertions: reported_allergy carries the free-text substance
ok 212 - deriveAssertions: reported_allergy carries the free-text substance
  ---
  duration_ms: 0.636
  type: 'test'
  ...
# Subtest: deriveAssertions: every derived assertion carries valid clinical-state/1.2 patient-reported Provenance
ok 213 - deriveAssertions: every derived assertion carries valid clinical-state/1.2 patient-reported Provenance
  ---
  duration_ms: 0.079792
  type: 'test'
  ...
# Subtest: deriveAssertions: deterministic (twice → deep-equal)
ok 214 - deriveAssertions: deterministic (twice → deep-equal)
  ---
  duration_ms: 0.150291
  type: 'test'
  ...
# Subtest: escalationFlag: complaint worse → symptom_worse
ok 215 - escalationFlag: complaint worse → symptom_worse
  ---
  duration_ms: 0.073292
  type: 'test'
  ...
# Subtest: escalationFlag: high-alert med stopped → high_alert_med_stopped
ok 216 - escalationFlag: high-alert med stopped → high_alert_med_stopped
  ---
  duration_ms: 0.037667
  type: 'test'
  ...
# Subtest: escalationFlag: non-high-alert stopped → null
ok 217 - escalationFlag: non-high-alert stopped → null
  ---
  duration_ms: 0.030792
  type: 'test'
  ...
# Subtest: escalationFlag: not_taking high-alert → escalation
ok 218 - escalationFlag: not_taking high-alert → escalation
  ---
  duration_ms: 0.031625
  type: 'test'
  ...
# Subtest: validateOutcome: illegal disposition · foreign askId · legal partial
ok 219 - validateOutcome: illegal disposition · foreign askId · legal partial
  ---
  duration_ms: 0.0905
  type: 'test'
  ...
# Subtest: validateOutcome: illegal enum answer rejected
ok 220 - validateOutcome: illegal enum answer rejected
  ---
  duration_ms: 0.032333
  type: 'test'
  ...
# Subtest: version constants
ok 221 - version constants
  ---
  duration_ms: 0.036334
  type: 'test'
  ...
# Subtest: trackFromReasonType maps reasons + type precedence
ok 222 - trackFromReasonType maps reasons + type precedence
  ---
  duration_ms: 0.541208
  type: 'test'
  ...
# Subtest: healthFormsSql is injection-safe and targets the right table/key
ok 223 - healthFormsSql is injection-safe and targets the right table/key
  ---
  duration_ms: 0.301125
  type: 'test'
  ...
# Subtest: parseStrArray handles JS arrays, JSON text, and Postgres {a,b} text
ok 224 - parseStrArray handles JS arrays, JSON text, and Postgres {a,b} text
  ---
  duration_ms: 0.418625
  type: 'test'
  ...
# Subtest: parseFollowups normalizes booked/completed from real jsonb shape
ok 225 - parseFollowups normalizes booked/completed from real jsonb shape
  ---
  duration_ms: 0.218584
  type: 'test'
  ...
# Subtest: parseFollowups dedupes repeated orders (best status wins)
ok 226 - parseFollowups dedupes repeated orders (best status wins)
  ---
  duration_ms: 0.114167
  type: 'test'
  ...
# Subtest: parseNextFollowup handles date object, reason object, and bare string
ok 227 - parseNextFollowup handles date object, reason object, and bare string
  ---
  duration_ms: 0.118834
  type: 'test'
  ...
# Subtest: posthosp: "not required" reason → next-followup met, not garbage
ok 228 - posthosp: "not required" reason → next-followup met, not garbage
  ---
  duration_ms: 0.273875
  type: 'test'
  ...
# Subtest: autoTrack reads the most recent form (rows DESC)
ok 229 - autoTrack reads the most recent form (rows DESC)
  ---
  duration_ms: 3.416667
  type: 'test'
  ...
# Subtest: fever: context + expectations (day ≥5, danger sign, disposition gap)
ok 230 - fever: context + expectations (day ≥5, danger sign, disposition gap)
  ---
  duration_ms: 1.09975
  type: 'test'
  ...
# Subtest: fever recovered → mostly met
ok 231 - fever recovered → mostly met
  ---
  duration_ms: 0.947791
  type: 'test'
  ...
# Subtest: posthosp: unbooked items → gap; next follow-up met
ok 232 - posthosp: unbooked items → gap; next follow-up met
  ---
  duration_ms: 0.296042
  type: 'test'
  ...
# Subtest: aihs: HbA1c recency drives the marker expectation
ok 233 - aihs: HbA1c recency drives the marker expectation
  ---
  duration_ms: 0.349667
  type: 'test'
  ...
# Subtest: registry has the three deep tracks
ok 234 - registry has the three deep tracks
  ---
  duration_ms: 0.057083
  type: 'test'
  ...
# Subtest: extractJson strips code fences and parses
ok 235 - extractJson strips code fences and parses
  ---
  duration_ms: 1.372208
  type: 'test'
  ...
# Subtest: normalizeFinding ENFORCES cite-or-label: corpus_cited without citations is downgraded
ok 236 - normalizeFinding ENFORCES cite-or-label: corpus_cited without citations is downgraded
  ---
  duration_ms: 0.150125
  type: 'test'
  ...
# Subtest: parseClinical clamps citation ids to [1..max] and de-dupes finding ids
ok 237 - parseClinical clamps citation ids to [1..max] and de-dupes finding ids
  ---
  duration_ms: 0.109541
  type: 'test'
  ...
# Subtest: pitchGate opens ONLY on a specific, cited, high-confidence surgical_indication
ok 238 - pitchGate opens ONLY on a specific, cited, high-confidence surgical_indication
  ---
  duration_ms: 3.85825
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT for an uncited surgical indication
ok 239 - pitchGate stays SHUT for an uncited surgical indication
  ---
  duration_ms: 0.304834
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT for a cited NON-surgical finding
ok 240 - pitchGate stays SHUT for a cited NON-surgical finding
  ---
  duration_ms: 0.235708
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT with no findings
ok 241 - pitchGate stays SHUT with no findings
  ---
  duration_ms: 0.13175
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT on generic/conditional textbook "indications" (the ~80% false positives)
ok 242 - pitchGate stays SHUT on generic/conditional textbook "indications" (the ~80% false positives)
  ---
  duration_ms: 1.308292
  type: 'test'
  ...
# Subtest: isSpecificSurgicalIndication accepts an assertive member-specific indication
ok 243 - isSpecificSurgicalIndication accepts an assertive member-specific indication
  ---
  duration_ms: 0.738958
  type: 'test'
  ...
# Subtest: the tightened patterns catch the residual generics seen in the backtest
ok 244 - the tightened patterns catch the residual generics seen in the backtest
  ---
  duration_ms: 0.636125
  type: 'test'
  ...
# Subtest: pitchGate enforces the confidence floor
ok 245 - pitchGate enforces the confidence floor
  ---
  duration_ms: 0.159125
  type: 'test'
  ...
# Subtest: pitchGate opts reproduce the OLD (pre-calibration) gate for the backtest
ok 246 - pitchGate opts reproduce the OLD (pre-calibration) gate for the backtest
  ---
  duration_ms: 0.122375
  type: 'test'
  ...
# Subtest: buildCommercial: walled-off when not allowed; default priority follows referral
ok 247 - buildCommercial: walled-off when not allowed; default priority follows referral
  ---
  duration_ms: 0.291833
  type: 'test'
  ...
# Subtest: groundingSummary counts by grounding and distinct cited sources
ok 248 - groundingSummary counts by grounding and distinct cited sources
  ---
  duration_ms: 0.211084
  type: 'test'
  ...
# Subtest: parseCommercial defaults priority to med and coerces script
ok 249 - parseCommercial defaults priority to med and coerces script
  ---
  duration_ms: 0.153375
  type: 'test'
  ...
# Subtest: parseExtractedReport keeps clinical content only
ok 250 - parseExtractedReport keeps clinical content only
  ---
  duration_ms: 0.44625
  type: 'test'
  ...
# Subtest: composeEpisodeText is de-identified and notes order-only coverage
ok 251 - composeEpisodeText is de-identified and notes order-only coverage
  ---
  duration_ms: 0.244541
  type: 'test'
  ...
# Subtest: retrievalQuery surfaces the clinical content
ok 252 - retrievalQuery surfaces the clinical content
  ---
  duration_ms: 0.101333
  type: 'test'
  ...
# Subtest: assembleEnvelope carries member_ref for join-back + the disclaimer
ok 253 - assembleEnvelope carries member_ref for join-back + the disclaimer
  ---
  duration_ms: 1.166333
  type: 'test'
  ...
# Subtest: isSnapshotFresh: just inside the TTL is fresh
ok 254 - isSnapshotFresh: just inside the TTL is fresh
  ---
  duration_ms: 0.5615
  type: 'test'
  ...
# Subtest: isSnapshotFresh: exactly at the TTL is NOT fresh (strict <)
ok 255 - isSnapshotFresh: exactly at the TTL is NOT fresh (strict <)
  ---
  duration_ms: 0.064208
  type: 'test'
  ...
# Subtest: isSnapshotFresh: just outside the TTL is stale
ok 256 - isSnapshotFresh: just outside the TTL is stale
  ---
  duration_ms: 0.50175
  type: 'test'
  ...
# Subtest: isSnapshotFresh: zero age is fresh
ok 257 - isSnapshotFresh: zero age is fresh
  ---
  duration_ms: 0.061833
  type: 'test'
  ...
# Subtest: isSnapshotFresh: negative age (clock skew, refreshed in the future) is fresh
ok 258 - isSnapshotFresh: negative age (clock skew, refreshed in the future) is fresh
  ---
  duration_ms: 0.050917
  type: 'test'
  ...
# Subtest: isSnapshotFresh: a non-positive TTL means never fresh, not unbounded
ok 259 - isSnapshotFresh: a non-positive TTL means never fresh, not unbounded
  ---
  duration_ms: 0.040875
  type: 'test'
  ...
# Subtest: isSnapshotFresh: non-finite inputs are never fresh
ok 260 - isSnapshotFresh: non-finite inputs are never fresh
  ---
  duration_ms: 0.105708
  type: 'test'
  ...
# Subtest: isSnapshotFresh: a sub-hour TTL still works
ok 261 - isSnapshotFresh: a sub-hour TTL still works
  ---
  duration_ms: 0.043542
  type: 'test'
  ...
# Subtest: snapshotTtlHours: parses a valid value
ok 262 - snapshotTtlHours: parses a valid value
  ---
  duration_ms: 0.158416
  type: 'test'
  ...
# Subtest: snapshotTtlHours: unset / junk / non-positive fall back to the default
ok 263 - snapshotTtlHours: unset / junk / non-positive fall back to the default
  ---
  duration_ms: 0.292958
  type: 'test'
  ...
# Subtest: snapshotTtlHours default is 24
ok 264 - snapshotTtlHours default is 24
  ---
  duration_ms: 0.04725
  type: 'test'
  ...
# Subtest: toEpochMs accepts Date, ISO string, and epoch number
ok 265 - toEpochMs accepts Date, ISO string, and epoch number
  ---
  duration_ms: 2.887708
  type: 'test'
  ...
# Subtest: toEpochMs rejects everything else
ok 266 - toEpochMs rejects everything else
  ---
  duration_ms: 0.074083
  type: 'test'
  ...
# Subtest: mapSnapshotRow maps a jsonb object row
ok 267 - mapSnapshotRow maps a jsonb object row
  ---
  duration_ms: 0.224708
  type: 'test'
  ...
# Subtest: mapSnapshotRow maps a row whose snapshot arrived as a JSON string
ok 268 - mapSnapshotRow maps a row whose snapshot arrived as a JSON string
  ---
  duration_ms: 0.23375
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null for a missing row (cache miss)
ok 269 - mapSnapshotRow returns null for a missing row (cache miss)
  ---
  duration_ms: 0.077833
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null for an unparseable or non-object snapshot
ok 270 - mapSnapshotRow returns null for an unparseable or non-object snapshot
  ---
  duration_ms: 0.068708
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null when refreshed_at is unreadable
ok 271 - mapSnapshotRow returns null when refreshed_at is unreadable
  ---
  duration_ms: 0.039958
  type: 'test'
  ...
# Subtest: mapSnapshotRow never throws on hostile input
ok 272 - mapSnapshotRow never throws on hostile input
  ---
  duration_ms: 0.075667
  type: 'test'
  ...
# Subtest: SNAPSHOT_SCHEMA_VERSION is 2 (v1 = P1 rows, unstamped)
ok 273 - SNAPSHOT_SCHEMA_VERSION is 2 (v1 = P1 rows, unstamped)
  ---
  duration_ms: 0.026916
  type: 'test'
  ...
# Subtest: a P1 bundle (no _schemaVersion) is a MISS, so the enriched timeline appears without waiting out the TTL
ok 274 - a P1 bundle (no _schemaVersion) is a MISS, so the enriched timeline appears without waiting out the TTL
  ---
  duration_ms: 0.036292
  type: 'test'
  ...
# Subtest: a bundle stamped with any other version is a MISS (older or newer)
ok 275 - a bundle stamped with any other version is a MISS (older or newer)
  ---
  duration_ms: 0.048
  type: 'test'
  ...
# Subtest: a correctly stamped bundle is servable, and the stamp rides along harmlessly
ok 276 - a correctly stamped bundle is servable, and the stamp rides along harmlessly
  ---
  duration_ms: 0.034459
  type: 'test'
  ...
# Subtest: the version guard also applies to a snapshot that arrived as a JSON string
ok 277 - the version guard also applies to a snapshot that arrived as a JSON string
  ---
  duration_ms: 0.042666
  type: 'test'
  ...
# Subtest: docSha is deterministic
ok 278 - docSha is deterministic
  ---
  duration_ms: 0.069083
  type: 'test'
  ...
# Subtest: docSha diverges for different URLs
ok 279 - docSha diverges for different URLs
  ---
  duration_ms: 0.043125
  type: 'test'
  ...
# Subtest: docSha is 64 lowercase hex chars
ok 280 - docSha is 64 lowercase hex chars
  ---
  duration_ms: 0.079625
  type: 'test'
  ...
# Subtest: docSha matches the known SHA-256 of a fixed string
ok 281 - docSha matches the known SHA-256 of a fixed string
  ---
  duration_ms: 0.088209
  type: 'test'
  ...
# Subtest: docSha does NOT normalise — a byte of difference is a different document
ok 282 - docSha does NOT normalise — a byte of difference is a different document
  ---
  duration_ms: 0.058042
  type: 'test'
  ...
# Subtest: docSha handles the empty string and unicode without throwing
ok 283 - docSha handles the empty string and unicode without throwing
  ---
  duration_ms: 0.052792
  type: 'test'
  ...
# Subtest: builders target the right tables and validate ids
ok 284 - builders target the right tables and validate ids
  ---
  duration_ms: 0.932334
  type: 'test'
  ...
# Subtest: builders reject junk ids (injection guard)
ok 285 - builders reject junk ids (injection guard)
  ---
  duration_ms: 0.179583
  type: 'test'
  ...
# Subtest: parseSpeciality pulls the trailing parens; prettyPrescriptionType humanizes
ok 286 - parseSpeciality pulls the trailing parens; prettyPrescriptionType humanizes
  ---
  duration_ms: 0.164792
  type: 'test'
  ...
# Subtest: mapEpisodeRow validates + coerces
ok 287 - mapEpisodeRow validates + coerces
  ---
  duration_ms: 0.081
  type: 'test'
  ...
# Subtest: parseDiagnosisNames extracts readable names from the dpipe JSON array
ok 288 - parseDiagnosisNames extracts readable names from the dpipe JSON array
  ---
  duration_ms: 0.454334
  type: 'test'
  ...
# Subtest: cleanComplaint collapses whitespace and truncates
ok 289 - cleanComplaint collapses whitespace and truncates
  ---
  duration_ms: 0.087875
  type: 'test'
  ...
# Subtest: opdTimeline folds clean complaint + parsed dx names into the subtitle (no raw JSON leak)
ok 290 - opdTimeline folds clean complaint + parsed dx names into the subtitle (no raw JSON leak)
  ---
  duration_ms: 0.196709
  type: 'test'
  ...
# Subtest: reportTimeline falls back to a generic label and appends vendor
ok 291 - reportTimeline falls back to a generic label and appends vendor
  ---
  duration_ms: 0.130792
  type: 'test'
  ...
# Subtest: ipdTimeline computes LOS and labels discharge vs admission
ok 292 - ipdTimeline computes LOS and labels discharge vs admission
  ---
  duration_ms: 0.315791
  type: 'test'
  ...
# Subtest: mergeTimeline sorts newest-first and sinks undated rows
ok 293 - mergeTimeline sorts newest-first and sinks undated rows
  ---
  duration_ms: 14.464667
  type: 'test'
  ...
# Subtest: computeSnapshot counts + lastContact + medsLastVisit
ok 294 - computeSnapshot counts + lastContact + medsLastVisit
  ---
  duration_ms: 1.038792
  type: 'test'
  ...
# Subtest: buildMember shapes identity + age + allergies
ok 295 - buildMember shapes identity + age + allergies
  ---
  duration_ms: 0.397417
  type: 'test'
  ...
# Subtest: prescription comes first and is labelled "Encounter note"
ok 296 - prescription comes first and is labelled "Encounter note"
  ---
  duration_ms: 0.5665
  type: 'test'
  ...
# Subtest: reports keep bundle order after the prescription
ok 297 - reports keep bundle order after the prescription
  ---
  duration_ms: 0.384292
  type: 'test'
  ...
# Subtest: labels derive from kind + IST day
ok 298 - labels derive from kind + IST day
  ---
  duration_ms: 0.109542
  type: 'test'
  ...
# Subtest: an unknown report kind falls back to a generic label, never blank
ok 299 - an unknown report kind falls back to a generic label, never blank
  ---
  duration_ms: 0.079
  type: 'test'
  ...
# Subtest: an unparseable date yields no date suffix rather than a broken label
ok 300 - an unparseable date yields no date suffix rather than a broken label
  ---
  duration_ms: 0.098334
  type: 'test'
  ...
# Subtest: documents with no url are dropped — there is nothing to frame
ok 301 - documents with no url are dropped — there is nothing to frame
  ---
  duration_ms: 0.063125
  type: 'test'
  ...
# Subtest: an order-only episode (no prescription pdf, no reports) yields an empty list
ok 302 - an order-only episode (no prescription pdf, no reports) yields an empty list
  ---
  duration_ms: 0.092625
  type: 'test'
  ...
# Subtest: duplicate urls collapse to the first occurrence
ok 303 - duplicate urls collapse to the first occurrence
  ---
  duration_ms: 0.061667
  type: 'test'
  ...
# Subtest: processedUrl is present in the shape and null today (ReportDoc carries no such column)
ok 304 - processedUrl is present in the shape and null today (ReportDoc carries no such column)
  ---
  duration_ms: 0.186958
  type: 'test'
  ...
# Subtest: a null / undefined / malformed bundle yields [] and never throws
ok 305 - a null / undefined / malformed bundle yields [] and never throws
  ---
  duration_ms: 0.39725
  type: 'test'
  ...
# Subtest: validators accept real ids/days and reject junk
ok 306 - validators accept real ids/days and reject junk
  ---
  duration_ms: 3.408333
  type: 'test'
  ...
# Subtest: dayOf truncates a timestamp to the IST calendar day; bad input throws
ok 307 - dayOf truncates a timestamp to the IST calendar day; bad input throws
  ---
  duration_ms: 0.56
  type: 'test'
  ...
# Subtest: bundleWindow is asymmetric (reports land after the visit) and crosses month boundaries
ok 308 - bundleWindow is asymmetric (reports land after the visit) and crosses month boundaries
  ---
  duration_ms: 5.638125
  type: 'test'
  ...
# Subtest: SQL builders target the right tables/keys and embed only validated values
ok 309 - SQL builders target the right tables/keys and embed only validated values
  ---
  duration_ms: 0.2675
  type: 'test'
  ...
# Subtest: SQL builders refuse injection (throw, never interpolate)
ok 310 - SQL builders refuse injection (throw, never interpolate)
  ---
  duration_ms: 0.086583
  type: 'test'
  ...
# Subtest: specialityFromLabel parses the trailing-parens speciality
ok 311 - specialityFromLabel parses the trailing-parens speciality
  ---
  duration_ms: 0.095292
  type: 'test'
  ...
# Subtest: mapPrescription extracts keys + coerces array/json fields
ok 312 - mapPrescription extracts keys + coerces array/json fields
  ---
  duration_ms: 0.230042
  type: 'test'
  ...
# Subtest: mapPrescription prefers the clean CleanCase content when supplied
ok 313 - mapPrescription prefers the clean CleanCase content when supplied
  ---
  duration_ms: 0.078209
  type: 'test'
  ...
# Subtest: mapReports filters null urls; episodeCoverage flips on PDF presence
ok 314 - mapReports filters null urls; episodeCoverage flips on PDF presence
  ---
  duration_ms: 0.2365
  type: 'test'
  ...
# Subtest: buildBundle assembles + sets coverage
ok 315 - buildBundle assembles + sets coverage
  ---
  duration_ms: 0.326625
  type: 'test'
  ...
# Subtest: member ID (12 digits) routes to member-id + phone probes, not name
ok 316 - member ID (12 digits) routes to member-id + phone probes, not name
  ---
  duration_ms: 0.671167
  type: 'test'
  ...
# Subtest: individual UID (Firestore doc id) routes to a uid probe, not name/phone
ok 317 - individual UID (Firestore doc id) routes to a uid probe, not name/phone
  ---
  duration_ms: 0.599875
  type: 'test'
  ...
# Subtest: 10-digit phone and +91/spaced variants all normalize to +91XXXXXXXXXX
ok 318 - 10-digit phone and +91/spaced variants all normalize to +91XXXXXXXXXX
  ---
  duration_ms: 0.136958
  type: 'test'
  ...
# Subtest: UHID routes to a uhid probe
ok 319 - UHID routes to a uhid probe
  ---
  duration_ms: 0.048667
  type: 'test'
  ...
# Subtest: a name phrase routes to name tokens (and not to a uid probe)
ok 320 - a name phrase routes to name tokens (and not to a uid probe)
  ---
  duration_ms: 2.086792
  type: 'test'
  ...
# Subtest: a single plain word is a name, not an id
ok 321 - a single plain word is a name, not an id
  ---
  duration_ms: 0.189542
  type: 'test'
  ...
# Subtest: too-short / empty queries yield no probe
ok 322 - too-short / empty queries yield no probe
  ---
  duration_ms: 0.134417
  type: 'test'
  ...
# Subtest: name builder can not break out of its string literal (quotes balanced, no statement break)
ok 323 - name builder can not break out of its string literal (quotes balanced, no statement break)
  ---
  duration_ms: 0.15025
  type: 'test'
  ...
# Subtest: sanitizeNameToken removes metacharacters but keeps real names
ok 324 - sanitizeNameToken removes metacharacters but keeps real names
  ---
  duration_ms: 0.199292
  type: 'test'
  ...
# Subtest: id/phone builders reject junk and embed only validated values
ok 325 - id/phone builders reject junk and embed only validated values
  ---
  duration_ms: 1.009459
  type: 'test'
  ...
# Subtest: individualsByUidsSql batches identity by uid and validates
ok 326 - individualsByUidsSql batches identity by uid and validates
  ---
  duration_ms: 0.112417
  type: 'test'
  ...
# Subtest: episodes builder targets prescriptions with validated uids + types
ok 327 - episodes builder targets prescriptions with validated uids + types
  ---
  duration_ms: 0.1605
  type: 'test'
  ...
# Subtest: computeAge / fullName behave
ok 328 - computeAge / fullName behave
  ---
  duration_ms: 1.005917
  type: 'test'
  ...
# Subtest: buildHits groups episodes, ranks has-episodes first, and picks the latest
ok 329 - buildHits groups episodes, ranks has-episodes first, and picks the latest
  ---
  duration_ms: 0.488291
  type: 'test'
  ...
# Subtest: mapIndividualRow validates the uid and coerces arrays
ok 330 - mapIndividualRow validates the uid and coerces arrays
  ---
  duration_ms: 0.20825
  type: 'test'
  ...
# Subtest: every builder rejects a junk individual_uid
ok 331 - every builder rejects a junk individual_uid
  ---
  duration_ms: 1.137792
  type: 'test'
  ...
# Subtest: the kx order builder rejects a junk uhid
ok 332 - the kx order builder rejects a junk uhid
  ---
  duration_ms: 0.187625
  type: 'test'
  ...
# Subtest: no builder ever emits a quote from a rejected id (nothing interpolates before validation)
ok 333 - no builder ever emits a quote from a rejected id (nothing interpolates before validation)
  ---
  duration_ms: 0.113833
  type: 'test'
  ...
# Subtest: kx order builders key on uhid — NOT individual_uid — and hit the right table
ok 334 - kx order builders key on uhid — NOT individual_uid — and hit the right table
  ---
  duration_ms: 0.116416
  type: 'test'
  ...
# Subtest: the radiology order builder selects body_part + laterality; the lab one does not
ok 335 - the radiology order builder selects body_part + laterality; the lab one does not
  ---
  duration_ms: 0.108791
  type: 'test'
  ...
# Subtest: surgery keys on individual_uid; hcu keys on _parent_id; ip_events keys on individual_uid
ok 336 - surgery keys on individual_uid; hcu keys on _parent_id; ip_events keys on individual_uid
  ---
  duration_ms: 0.047417
  type: 'test'
  ...
# Subtest: hyphenated table names are double-quoted
ok 337 - hyphenated table names are double-quoted
  ---
  duration_ms: 0.085
  type: 'test'
  ...
# Subtest: every builder renders its date to the IST calendar day
ok 338 - every builder renders its date to the IST calendar day
  ---
  duration_ms: 0.054542
  type: 'test'
  ...
# Subtest: _create_time is cast to timestamptz before the timezone shift (column may be text)
ok 339 - _create_time is cast to timestamptz before the timezone shift (column may be text)
  ---
  duration_ms: 0.182167
  type: 'test'
  ...
# Subtest: every builder caps its result set, and the cap is clamped
ok 340 - every builder caps its result set, and the cap is clamped
  ---
  duration_ms: 0.277209
  type: 'test'
  ...
# Subtest: hcu selects all three url columns so the mapper can coalesce them
ok 341 - hcu selects all three url columns so the mapper can coalesce them
  ---
  duration_ms: 0.050375
  type: 'test'
  ...
# Subtest: ip_events selects only the verified column (no guessed label column)
ok 342 - ip_events selects only the verified column (no guessed label column)
  ---
  duration_ms: 0.912167
  type: 'test'
  ...
# Subtest: kxOrderTimeline shapes a lab order
ok 343 - kxOrderTimeline shapes a lab order
  ---
  duration_ms: 0.309583
  type: 'test'
  ...
# Subtest: kxOrderTimeline folds body_part + laterality into a radiology order
ok 344 - kxOrderTimeline folds body_part + laterality into a radiology order
  ---
  duration_ms: 0.118959
  type: 'test'
  ...
# Subtest: kxOrderTimeline tolerates every field being null
ok 345 - kxOrderTimeline tolerates every field being null
  ---
  duration_ms: 0.100584
  type: 'test'
  ...
# Subtest: furthestSurgeryStage prefers ot > clinical > status
ok 346 - furthestSurgeryStage prefers ot > clinical > status
  ---
  duration_ms: 0.23375
  type: 'test'
  ...
# Subtest: surgeryTimeline titles from procedure_name and subtitles the furthest stage
ok 347 - surgeryTimeline titles from procedure_name and subtitles the furthest stage
  ---
  duration_ms: 0.171584
  type: 'test'
  ...
# Subtest: surgeryTimeline falls back to a generic title when procedure_name is missing
ok 348 - surgeryTimeline falls back to a generic title when procedure_name is missing
  ---
  duration_ms: 0.09525
  type: 'test'
  ...
# Subtest: hcuDocUrl coalesces processed → consolidated → report
ok 349 - hcuDocUrl coalesces processed → consolidated → report
  ---
  duration_ms: 0.11375
  type: 'test'
  ...
# Subtest: hcuTimeline attaches docUrl when a report exists, and OMITS the key when it does not
ok 350 - hcuTimeline attaches docUrl when a report exists, and OMITS the key when it does not
  ---
  duration_ms: 0.151292
  type: 'test'
  ...
# Subtest: ipEventTimeline titles generically when no label column was selected
ok 351 - ipEventTimeline titles generically when no label column was selected
  ---
  duration_ms: 0.121459
  type: 'test'
  ...
# Subtest: ipEventTimeline uses a label opportunistically if one ever appears in the row
ok 352 - ipEventTimeline uses a label opportunistically if one ever appears in the row
  ---
  duration_ms: 0.131375
  type: 'test'
  ...
# Subtest: every mapper returns [] for empty input and never throws
ok 353 - every mapper returns [] for empty input and never throws
  ---
  duration_ms: 0.716041
  type: 'test'
  ...
# Subtest: flaggedListSql keeps every normative fragment of the page query
ok 354 - flaggedListSql keeps every normative fragment of the page query
  ---
  duration_ms: 0.912584
  type: 'test'
  ...
# Subtest: flaggedListSql preserves both ORDER BY clauses exactly
ok 355 - flaggedListSql preserves both ORDER BY clauses exactly
  ---
  duration_ms: 0.18625
  type: 'test'
  ...
# Subtest: flaggedListSql mirrors the jsonb_typeof guards on both coalesce branches
ok 356 - flaggedListSql mirrors the jsonb_typeof guards on both coalesce branches
  ---
  duration_ms: 0.294708
  type: 'test'
  ...
# Subtest: flaggedListSql takes the engine version as $1 and never interpolates it
ok 357 - flaggedListSql takes the engine version as $1 and never interpolates it
  ---
  duration_ms: 0.115417
  type: 'test'
  ...
# Subtest: flaggedListSql is a constant — no argument can change the text
ok 358 - flaggedListSql is a constant — no argument can change the text
  ---
  duration_ms: 0.105666
  type: 'test'
  ...
# Subtest: pickSignal: a gated_on claim beats the surgical_indication fallback
ok 359 - pickSignal: a gated_on claim beats the surgical_indication fallback
  ---
  duration_ms: 0.269833
  type: 'test'
  ...
# Subtest: pickSignal: falls back to surgical_indication when nothing is gated
ok 360 - pickSignal: falls back to surgical_indication when nothing is gated
  ---
  duration_ms: 0.244291
  type: 'test'
  ...
# Subtest: pickSignal: falls back to speciality when no surgical_indication exists
ok 361 - pickSignal: falls back to speciality when no surgical_indication exists
  ---
  duration_ms: 0.115459
  type: 'test'
  ...
# Subtest: pickSignal: gated_on picks the FIRST matching finding in array order
ok 362 - pickSignal: gated_on picks the FIRST matching finding in array order
  ---
  duration_ms: 0.421625
  type: 'test'
  ...
# Subtest: pickSignal: a gated hit with a null claim coalesces to branch 2, not to the next gated hit
ok 363 - pickSignal: a gated hit with a null claim coalesces to branch 2, not to the next gated hit
  ---
  duration_ms: 0.3365
  type: 'test'
  ...
# Subtest: pickSignal: no qualifying finding returns null
ok 364 - pickSignal: no qualifying finding returns null
  ---
  duration_ms: 0.058
  type: 'test'
  ...
# Subtest: pickSignal: malformed and non-array envelope shapes degrade to null, never throw
ok 365 - pickSignal: malformed and non-array envelope shapes degrade to null, never throw
  ---
  duration_ms: 0.205458
  type: 'test'
  ...
# Subtest: pickSignal: non-string gated_on entries are ignored, not coerced
ok 366 - pickSignal: non-string gated_on entries are ignored, not coerced
  ---
  duration_ms: 0.040083
  type: 'test'
  ...
# Subtest: boundedRace returns the fallback when the inner promise never resolves
ok 367 - boundedRace returns the fallback when the inner promise never resolves
  ---
  duration_ms: 31.642375
  type: 'test'
  ...
# Subtest: boundedRace passes a fast result straight through
ok 368 - boundedRace passes a fast result straight through
  ---
  duration_ms: 0.655625
  type: 'test'
  ...
# Subtest: boundedRace resolves the fallback when the inner promise rejects — never rejects
ok 369 - boundedRace resolves the fallback when the inner promise rejects — never rejects
  ---
  duration_ms: 1.361417
  type: 'test'
  ...
# Subtest: boundedRace resolves the fallback on a synchronous throw inside the promise
ok 370 - boundedRace resolves the fallback on a synchronous throw inside the promise
  ---
  duration_ms: 0.135083
  type: 'test'
  ...
# Subtest: boundedRace does not hold the event loop open after a fast win
ok 371 - boundedRace does not hold the event loop open after a fast win
  ---
  duration_ms: 0.082875
  type: 'test'
  ...
# Subtest: boundedRace preserves falsy results rather than substituting the fallback
ok 372 - boundedRace preserves falsy results rather than substituting the fallback
  ---
  duration_ms: 0.169166
  type: 'test'
  ...
# Subtest: identity failure ⇒ the page still renders, with {} identities (uhid-only labels)
ok 373 - identity failure ⇒ the page still renders, with {} identities (uhid-only labels)
  ---
  duration_ms: 31.056875
  type: 'test'
  ...
# Subtest: a healthy identity lookup still labels the row
ok 374 - a healthy identity lookup still labels the row
  ---
  duration_ms: 0.253875
  type: 'test'
  ...
# Subtest: exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale
ok 375 - exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale
  ---
  duration_ms: 0.967542
  type: 'test'
  ...
# Subtest: C5 boundary: superset does NOT fire (banned core + one extra molecule)
ok 376 - C5 boundary: superset does NOT fire (banned core + one extra molecule)
  ---
  duration_ms: 0.366666
  type: 'test'
  ...
# Subtest: C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)
ok 377 - C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)
  ---
  duration_ms: 0.326167
  type: 'test'
  ...
# Subtest: order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]
ok 378 - order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]
  ---
  duration_ms: 0.313042
  type: 'test'
  ...
# Subtest: unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss
ok 379 - unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss
  ---
  duration_ms: 0.132833
  type: 'test'
  ...
# Subtest: empty / malformed table → empty array, never a throw (§7 fail-safe)
ok 380 - empty / malformed table → empty array, never a throw (§7 fail-safe)
  ---
  duration_ms: 0.074083
  type: 'test'
  ...
# Subtest: same banned combination in two products → ONE finding (per-entry dedupe)
ok 381 - same banned combination in two products → ONE finding (per-entry dedupe)
  ---
  duration_ms: 0.1045
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 15 (v2.0): loaded seed is v2.0 with 308 firing entries; withheld/rescinded/not_representable never fire
ok 382 - 0.81.14 Ruling 15 (v2.0): loaded seed is v2.0 with 308 firing entries; withheld/rescinded/not_representable never fire
  ---
  duration_ms: 17.479834
  type: 'test'
  ...
# Subtest: stampFindingIdentity: banned-FDC keeps banned_fdc (C4 protection holds under the 0.81.10 generalisation)
ok 383 - stampFindingIdentity: banned-FDC keeps banned_fdc (C4 protection holds under the 0.81.10 generalisation)
  ---
  duration_ms: 1.49375
  type: 'test'
  ...
# Subtest: severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule
ok 384 - severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule
  ---
  duration_ms: 0.454416
  type: 'test'
  ...
# Subtest: tierForCareSetting maps free-text care settings to a tariff tier
ok 385 - tierForCareSetting maps free-text care settings to a tariff tier
  ---
  duration_ms: 0.603458
  type: 'test'
  ...
# Subtest: priceAtTier reads the right column and falls back when a tier is absent
ok 386 - priceAtTier reads the right column and falls back when a tier is absent
  ---
  duration_ms: 0.14125
  type: 'test'
  ...
# Subtest: roomCategoryInflation = extra cost vs general ward; 0 at general/opd
ok 387 - roomCategoryInflation = extra cost vs general ward; 0 at general/opd
  ---
  duration_ms: 0.088875
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §6.8 BUG 9a: the citation is stripped and evidence moves to estimates
ok 388 - §6.8 BUG 9a: the citation is stripped and evidence moves to estimates
  ---
  duration_ms: 1.049167
  type: 'test'
  ...
# Subtest: §6.7 THE 700-CHAR REASON: support beyond character 600 still counts
ok 389 - §6.7 THE 700-CHAR REASON: support beyond character 600 still counts
  ---
  duration_ms: 0.220625
  type: 'test'
  ...
# Subtest: a supporting excerpt naming the molecule keeps the citation
ok 390 - a supporting excerpt naming the molecule keeps the citation
  ---
  duration_ms: 0.059167
  type: 'test'
  ...
# Subtest: CONSERVATIVE: an undeterminable molecule ⇒ do nothing
ok 391 - CONSERVATIVE: an undeterminable molecule ⇒ do nothing
  ---
  duration_ms: 0.153416
  type: 'test'
  ...
# Subtest: CONSERVATIVE: a cited excerpt with no text available ⇒ do nothing
ok 392 - CONSERVATIVE: a cited excerpt with no text available ⇒ do nothing
  ---
  duration_ms: 0.129958
  type: 'test'
  ...
# Subtest: deterministic findings and uncited findings are untouched
ok 393 - deterministic findings and uncited findings are untouched
  ---
  duration_ms: 0.060583
  type: 'test'
  ...
# Subtest: §6.9: the check does NOT run on the reuse path — empty hits, untouched findings
ok 394 - §6.9: the check does NOT run on the reuse path — empty hits, untouched findings
  ---
  duration_ms: 7.655167
  type: 'test'
  ...
# Subtest: the guard is structural in the engine: latestHits is set ONLY on the generation path
ok 395 - the guard is structural in the engine: latestHits is set ONLY on the generation path
  ---
  duration_ms: 16.003042
  type: 'test'
  ...
# Subtest: §6.10: stripping a citation does NOT change the index
ok 396 - §6.10: stripping a citation does NOT change the index
  ---
  duration_ms: 0.89575
  type: 'test'
  ...
# Subtest: §6.11: groundingKind, SEVERITY, PENALTY_BASE and findingPenalty are BYTE-IDENTICAL
ok 397 - §6.11: groundingKind, SEVERITY, PENALTY_BASE and findingPenalty are BYTE-IDENTICAL
  ---
  duration_ms: 1.127125
  type: 'test'
  ...
# Subtest: a stripped finding really does render as no_source
ok 398 - a stripped finding really does render as no_source
  ---
  duration_ms: 11.143375
  type: 'test'
  ...
# Subtest: the 600 and 700 constants are byte-identical — the gap this design exists for
ok 399 - the 600 and 700 constants are byte-identical — the gap this design exists for
  ---
  duration_ms: 0.244209
  type: 'test'
  ...
# Subtest: sourceUrl links journal PMIDs but not textbook item numbers
ok 400 - sourceUrl links journal PMIDs but not textbook item numbers
  ---
  duration_ms: 0.524709
  type: 'test'
  ...
# Subtest: hitsToSources numbers, previews, derives url, rounds similarity
ok 401 - hitsToSources numbers, previews, derives url, rounds similarity
  ---
  duration_ms: 0.153166
  type: 'test'
  ...
# Subtest: sourceLabel shows PMID for journals, item id for textbooks
ok 402 - sourceLabel shows PMID for journals, item id for textbooks
  ---
  duration_ms: 0.108
  type: 'test'
  ...
# Subtest: buildCitedContext emits [n] provenance + full text
ok 403 - buildCitedContext emits [n] provenance + full text
  ---
  duration_ms: 0.083667
  type: 'test'
  ...
# Subtest: validateCitationIds clamps to [1..max], dedupes, drops junk
ok 404 - validateCitationIds clamps to [1..max], dedupes, drops junk
  ---
  duration_ms: 0.361042
  type: 'test'
  ...
# Subtest: usedSources filters to cited n only
ok 405 - usedSources filters to cited n only
  ---
  duration_ms: 0.07275
  type: 'test'
  ...
# Subtest: sourceUrl derives a live NBK link for Bookshelf, not PubMed
ok 406 - sourceUrl derives a live NBK link for Bookshelf, not PubMed
  ---
  duration_ms: 0.12625
  type: 'test'
  ...
# Subtest: a Bookshelf citation renders with a working NBK link + NBK label (not PMID)
ok 407 - a Bookshelf citation renders with a working NBK link + NBK label (not PMID)
  ---
  duration_ms: 0.063791
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: BUG 8: 17 and 18 ng/mL land in the SAME band — the acceptance test for this batch
ok 408 - BUG 8: 17 and 18 ng/mL land in the SAME band — the acceptance test for this batch
  ---
  duration_ms: 0.539792
  type: 'test'
  ...
# Subtest: §6.1: the full band table, boundaries exact and CONTIGUOUS
ok 409 - §6.1: the full band table, boundaries exact and CONTIGUOUS
  ---
  duration_ms: 0.134334
  type: 'test'
  ...
# Subtest: the boundary constants and the standard are named, verbatim
ok 410 - the boundary constants and the standard are named, verbatim
  ---
  duration_ms: 0.054
  type: 'test'
  ...
# Subtest: an unusable level yields NO band — never a guess
ok 411 - an unusable level yields NO band — never a guess
  ---
  duration_ms: 0.044916
  type: 'test'
  ...
# Subtest: the level is read only when BOTH a vitamin-D token and ng/mL are present
ok 412 - the level is read only when BOTH a vitamin-D token and ng/mL are present
  ---
  duration_ms: 0.263542
  type: 'test'
  ...
# Subtest: FAIL-SAFE: a bare number, a different unit, or no vitamin-D token reads as NOTHING
ok 413 - FAIL-SAFE: a bare number, a different unit, or no vitamin-D token reads as NOTHING
  ---
  duration_ms: 0.049875
  type: 'test'
  ...
# Subtest: §6.2/§6.3: the matrix holds EXACTLY the two ratified rows
ok 414 - §6.2/§6.3: the matrix holds EXACTLY the two ratified rows
  ---
  duration_ms: 0.328625
  type: 'test'
  ...
# Subtest: row 1: deficient + 60,000 IU weekly × 8 weeks is concordant
ok 415 - row 1: deficient + 60,000 IU weekly × 8 weeks is concordant
  ---
  duration_ms: 0.102208
  type: 'test'
  ...
# Subtest: row 2: insufficient + the same regimen is concordant (Dr Zaki, Indian context)
ok 416 - row 2: insufficient + the same regimen is concordant (Dr Zaki, Indian context)
  ---
  duration_ms: 0.189083
  type: 'test'
  ...
# Subtest: §6.4: EVERY unratified pair yields null — and null means EMIT NOTHING, never discordance
ok 417 - §6.4: EVERY unratified pair yields null — and null means EMIT NOTHING, never discordance
  ---
  duration_ms: 0.3005
  type: 'test'
  ...
# Subtest: §6.5: the retest prompt fires for INSUFFICIENT as well as deficient, still informational
ok 418 - §6.5: the retest prompt fires for INSUFFICIENT as well as deficient, still informational
  ---
  duration_ms: 1.167125
  type: 'test'
  ...
# Subtest: the prompt keeps signal_type vitamin_d_repletion_duration through stampFindingIdentity
ok 419 - the prompt keeps signal_type vitamin_d_repletion_duration through stampFindingIdentity
  ---
  duration_ms: 8.474666
  type: 'test'
  ...
# Subtest: a SUFFICIENT level with the same regimen emits nothing — silence is the default
ok 420 - a SUFFICIENT level with the same regimen emits nothing — silence is the default
  ---
  duration_ms: 0.22925
  type: 'test'
  ...
# Subtest: NO BAND (unreadable level) emits nothing for an 8-week course — never band on a guess
ok 421 - NO BAND (unreadable level) emits nothing for an 8-week course — never band on a guess
  ---
  duration_ms: 0.351708
  type: 'test'
  ...
# Subtest: the >8-week Ruling 13 prompt is UNCHANGED and still band-independent
ok 422 - the >8-week Ruling 13 prompt is UNCHANGED and still band-independent
  ---
  duration_ms: 0.320542
  type: 'test'
  ...
# Subtest: FAIL-SAFE doctrine intact: an unparseable duration emits NOTHING in either mode
ok 423 - FAIL-SAFE doctrine intact: an unparseable duration emits NOTHING in either mode
  ---
  duration_ms: 5.67625
  type: 'test'
  ...
# Subtest: the system prompt names vitamin D dose adequacy beside muscle relaxants
ok 424 - the system prompt names vitamin D dose adequacy beside muscle relaxants
  ---
  duration_ms: 0.931542
  type: 'test'
  ...
# Subtest: the engine version is current and the read family keeps the older versions
ok 425 - the engine version is current and the read family keeps the older versions
  ---
  duration_ms: 2.235916
  type: 'test'
  ...
# Subtest: auditShadowReport: full + minimal findings round-trip byte-lossless
ok 426 - auditShadowReport: full + minimal findings round-trip byte-lossless
  ---
  duration_ms: 1.365959
  type: 'test'
  ...
# Subtest: auditShadowReport: empty findings → vacuously ok, zero counts
ok 427 - auditShadowReport: empty findings → vacuously ok, zero counts
  ---
  duration_ms: 0.08
  type: 'test'
  ...
# Subtest: flag-OFF byte-identical: the shadow never mutates the persisted findings array
ok 428 - flag-OFF byte-identical: the shadow never mutates the persisted findings array
  ---
  duration_ms: 0.288333
  type: 'test'
  ...
# Subtest: auditShadowReport: flags a lossy finding (missing verdict/domain gain empty-string keys)
ok 429 - auditShadowReport: flags a lossy finding (missing verdict/domain gain empty-string keys)
  ---
  duration_ms: 0.088791
  type: 'test'
  ...
# Subtest: lossyKeys: detects dropped, added, and value-changed keys; empty on identity
ok 430 - lossyKeys: detects dropped, added, and value-changed keys; empty on identity
  ---
  duration_ms: 0.077375
  type: 'test'
  ...
# Subtest: demographics: structured input wins; band derived
ok 431 - demographics: structured input wins; band derived
  ---
  duration_ms: 4.091958
  type: 'test'
  ...
# Subtest: "No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)
ok 432 - "No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)
  ---
  duration_ms: 0.989
  type: 'test'
  ...
# Subtest: "Denies vomiting" is a negation too; complaint carries its duration
ok 433 - "Denies vomiting" is a negation too; complaint carries its duration
  ---
  duration_ms: 0.1265
  type: 'test'
  ...
# Subtest: accepted complaint field names are pinned — a rename at a call site is a silent positives:0
ok 434 - accepted complaint field names are pinned — a rename at a call site is a silent positives:0
  ---
  duration_ms: 0.2265
  type: 'test'
  ...
# Subtest: vitals: parsed reads + instability from adult thresholds
ok 435 - vitals: parsed reads + instability from adult thresholds
  ---
  duration_ms: 0.212
  type: 'test'
  ...
# Subtest: instability three-state: no vitals → not_assessable, all 5 channels missing
ok 436 - instability three-state: no vitals → not_assessable, all 5 channels missing
  ---
  duration_ms: 0.076
  type: 'test'
  ...
# Subtest: instability three-state: full normal vitals → no_instability_detected, all 5 assessed
ok 437 - instability three-state: full normal vitals → no_instability_detected, all 5 assessed
  ---
  duration_ms: 0.151458
  type: 'test'
  ...
# Subtest: instability three-state: partial vitals (temperature only) → assessed [T], rest missing
ok 438 - instability three-state: partial vitals (temperature only) → assessed [T], rest missing
  ---
  duration_ms: 0.758083
  type: 'test'
  ...
# Subtest: instability three-state: breach → unstable, reasons byte-identical to unchanged logic
ok 439 - instability three-state: breach → unstable, reasons byte-identical to unchanged logic
  ---
  duration_ms: 5.497542
  type: 'test'
  ...
# Subtest: instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod
ok 440 - instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod
  ---
  duration_ms: 2.227625
  type: 'test'
  ...
# Subtest: normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED
ok 441 - normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED
  ---
  duration_ms: 0.582959
  type: 'test'
  ...
# Subtest: mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives
ok 442 - mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives
  ---
  duration_ms: 0.521834
  type: 'test'
  ...
# Subtest: polarity MARKER: a negation-headed span labelled present is MARKED and KEPT — the live case
ok 443 - polarity MARKER: a negation-headed span labelled present is MARKED and KEPT — the live case
  ---
  duration_ms: 2.822375
  type: 'test'
  ...
# Subtest: polarity MARKER: the bank cases that killed the FILTER are kept, and merely annotated
ok 444 - polarity MARKER: the bank cases that killed the FILTER are kept, and merely annotated
  ---
  duration_ms: 0.257417
  type: 'test'
  ...
# Subtest: polarity MARKER: cue immediately LEFT of the span marks too
ok 445 - polarity MARKER: cue immediately LEFT of the span marks too
  ---
  duration_ms: 0.145459
  type: 'test'
  ...
# Subtest: polarity MARKER: head-governed ONLY — a mid-span cue is a modifier, and absent/historical are untouched
ok 446 - polarity MARKER: head-governed ONLY — a mid-span cue is a modifier, and absent/historical are untouched
  ---
  duration_ms: 0.087375
  type: 'test'
  ...
# Subtest: polarity MARKER: a marked finding still validates against the .strict() schema
ok 447 - polarity MARKER: a marked finding still validates against the .strict() schema
  ---
  duration_ms: 2.2975
  type: 'test'
  ...
# Subtest: applyParsedInvestigations: rows land verbatim; only abnormals become positive findings
ok 448 - applyParsedInvestigations: rows land verbatim; only abnormals become positive findings
  ---
  duration_ms: 0.906375
  type: 'test'
  ...
# Subtest: buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through
ok 449 - buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through
  ---
  duration_ms: 0.47325
  type: 'test'
  ...
# Subtest: runGuards: clean deterministic state — every asserted rawText verbatim, sentinel exempt
ok 450 - runGuards: clean deterministic state — every asserted rawText verbatim, sentinel exempt
  ---
  duration_ms: 0.73925
  type: 'test'
  ...
# Subtest: runGuards: a finding whose rawText is NOT in its field is caught as fabricated
ok 451 - runGuards: a finding whose rawText is NOT in its field is caught as fabricated
  ---
  duration_ms: 0.193125
  type: 'test'
  ...
# Subtest: runGuards: sentinel unknown is never a fabrication even though "(not mentioned)" is not in the text
ok 452 - runGuards: sentinel unknown is never a fabrication even though "(not mentioned)" is not in the text
  ---
  duration_ms: 0.078083
  type: 'test'
  ...
# Subtest: runGuards: offset validation flags a wrong span; correct offsets pass
ok 453 - runGuards: offset validation flags a wrong span; correct offsets pass
  ---
  duration_ms: 0.080209
  type: 'test'
  ...
# Subtest: parseJudgeResponse: fenced JSON, clamps out-of-range, defaults bad verdict, keeps missed[]
ok 454 - parseJudgeResponse: fenced JSON, clamps out-of-range, defaults bad verdict, keeps missed[]
  ---
  duration_ms: 1.744125
  type: 'test'
  ...
# Subtest: summarizePath: guard means aggregate; judge is ALWAYS calibrated:false
ok 455 - summarizePath: guard means aggregate; judge is ALWAYS calibrated:false
  ---
  duration_ms: 1.513
  type: 'test'
  ...
# Subtest: headToHead: llm − det deltas; judge deltas null when a path lacks judge
ok 456 - headToHead: llm − det deltas; judge deltas null when a path lacks judge
  ---
  duration_ms: 0.309709
  type: 'test'
  ...
# Subtest: proposePromotionThreshold: never armed; floor = det baseline + noise margin
ok 457 - proposePromotionThreshold: never armed; floor = det baseline + noise margin
  ---
  duration_ms: 0.239333
  type: 'test'
  ...
# Subtest: scoreExtractorVsGold: recall/status matched; word-boundary match avoids ces⊂abscess
ok 458 - scoreExtractorVsGold: recall/status matched; word-boundary match avoids ces⊂abscess
  ---
  duration_ms: 6.610042
  type: 'test'
  ...
# Subtest: scoreExtractorVsGold: vitals granularity fold — HR/BP names+split match gold abbrev+value
ok 459 - scoreExtractorVsGold: vitals granularity fold — HR/BP names+split match gold abbrev+value
  ---
  duration_ms: 4.671542
  type: 'test'
  ...
# Subtest: calibrateJudge: low MAE ⇒ trustworthy; high MAE ⇒ retune
ok 460 - calibrateJudge: low MAE ⇒ trustworthy; high MAE ⇒ retune
  ---
  duration_ms: 0.217084
  type: 'test'
  ...
# Subtest: buildJudgeUser / judgeStateView: present the state without ids or offsets
ok 461 - buildJudgeUser / judgeStateView: present the state without ids or offsets
  ---
  duration_ms: 0.260291
  type: 'test'
  ...
# Subtest: adaptGoldSeed: flattens present/absent/unknown lanes; excludes riskFactors/investigations
ok 462 - adaptGoldSeed: flattens present/absent/unknown lanes; excludes riskFactors/investigations
  ---
  duration_ms: 0.16
  type: 'test'
  ...
# Subtest: EXTRACTION_BANK is pinned to the frozen bank
ok 463 - EXTRACTION_BANK is pinned to the frozen bank
  ---
  duration_ms: 0.032625
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: real db13 line → prescribed assertion with mapped fields + provenance
ok 464 - medicationLineToAssertion: real db13 line → prescribed assertion with mapped fields + provenance
  ---
  duration_ms: 0.67775
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: DFO + Optiqmega → brand/generic mapped; generic optional
ok 465 - medicationLineToAssertion: DFO + Optiqmega → brand/generic mapped; generic optional
  ---
  duration_ms: 0.245584
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: both brand + generic empty → null (skip the line)
ok 466 - medicationLineToAssertion: both brand + generic empty → null (skip the line)
  ---
  duration_ms: 0.241208
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: NKA notations → one denied; empty → []; substantive → reported_allergy
ok 467 - allergyTextToAssertions: NKA notations → one denied; empty → []; substantive → reported_allergy
  ---
  duration_ms: 2.9995
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: "NK" (not-known) → denied; substantive text containing nk is NOT swept
ok 468 - allergyTextToAssertions: "NK" (not-known) → denied; substantive text containing nk is NOT swept
  ---
  duration_ms: 0.182667
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: substantive text → one reported_allergy, raw preserved, reaction null
ok 469 - allergyTextToAssertions: substantive text → one reported_allergy, raw preserved, reaction null
  ---
  duration_ms: 0.205209
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: full 2-line array + "No" allergy → 2 med + 1 denied
ok 470 - prescriptionToAssertions: full 2-line array + "No" allergy → 2 med + 1 denied
  ---
  duration_ms: 0.552583
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: accepts a JSON string array; skips empty lines
ok 471 - prescriptionToAssertions: accepts a JSON string array; skips empty lines
  ---
  duration_ms: 0.105083
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: malformed / non-array input → empty, never throws
ok 472 - prescriptionToAssertions: malformed / non-array input → empty, never throws
  ---
  duration_ms: 0.37925
  type: 'test'
  ...
# Subtest: id determinism: same input → same id across calls (both assertion kinds)
ok 473 - id determinism: same input → same id across calls (both assertion kinds)
  ---
  duration_ms: 0.334041
  type: 'test'
  ...
# Subtest: schema: emptyClinicalState is 1.1 with empty assertion arrays and passes the updated zod
ok 474 - schema: emptyClinicalState is 1.1 with empty assertion arrays and passes the updated zod
  ---
  duration_ms: 3.239542
  type: 'test'
  ...
# Subtest: Provenance trust axis (1.2): optional reporter/trust validate; absent still validates
ok 475 - Provenance trust axis (1.2): optional reporter/trust validate; absent still validates
  ---
  duration_ms: 2.146708
  type: 'test'
  ...
# Subtest: MedicationAssertion.stopReason enum validates through the state
ok 476 - MedicationAssertion.stopReason enum validates through the state
  ---
  duration_ms: 0.30325
  type: 'test'
  ...
# Subtest: zComplaintStatusAssertion validates ComplaintStatus, rejects bogus
ok 477 - zComplaintStatusAssertion validates ComplaintStatus, rejects bogus
  ---
  duration_ms: 0.162958
  type: 'test'
  ...
# Subtest: zFollowUpAssertion validates FollowUpAction (+ optional targetDate), rejects bogus
ok 478 - zFollowUpAssertion validates FollowUpAction (+ optional targetDate), rejects bogus
  ---
  duration_ms: 0.233917
  type: 'test'
  ...
# Subtest: emptyClinicalState validates and carries the version literal
ok 479 - emptyClinicalState validates and carries the version literal
  ---
  duration_ms: 1.576291
  type: 'test'
  ...
# Subtest: a populated state validates: findings, audit ext, timeline, adminFacts
ok 480 - a populated state validates: findings, audit ext, timeline, adminFacts
  ---
  duration_ms: 0.9905
  type: 'test'
  ...
# Subtest: validation rejects a bad finding status, a missing provenance, an unknown ext kind
ok 481 - validation rejects a bad finding status, a missing provenance, an unknown ext kind
  ---
  duration_ms: 0.478875
  type: 'test'
  ...
# Subtest: mkFindingId is deterministic and status-sensitive
ok 482 - mkFindingId is deterministic and status-sensitive
  ---
  duration_ms: 0.146708
  type: 'test'
  ...
# Subtest: stateCounts mirrors the arrays
ok 483 - stateCounts mirrors the arrays
  ---
  duration_ms: 0.075167
  type: 'test'
  ...
# Subtest: formatClinicalState renders every populated section, skips empty ones
ok 484 - formatClinicalState renders every populated section, skips empty ones
  ---
  duration_ms: 0.242167
  type: 'test'
  ...
# Subtest: clinicalStateResultField: flag OFF returns {} — result payload byte-identical
ok 485 - clinicalStateResultField: flag OFF returns {} — result payload byte-identical
  ---
  duration_ms: 1.762083
  type: 'test'
  ...
# Subtest: clinicalStateResultField: null/undefined state returns {} even when enabled
ok 486 - clinicalStateResultField: null/undefined state returns {} even when enabled
  ---
  duration_ms: 0.17025
  type: 'test'
  ...
# Subtest: clinicalStateResultField: flag ON attaches the trimmed view
ok 487 - clinicalStateResultField: flag ON attaches the trimmed view
  ---
  duration_ms: 0.424917
  type: 'test'
  ...
# Subtest: toClinicalStateUiView: counts mirror stateCounts; provenance preserved for hover
ok 488 - toClinicalStateUiView: counts mirror stateCounts; provenance preserved for hover
  ---
  duration_ms: 0.167292
  type: 'test'
  ...
# Subtest: the production exhibit shape: "Diagnosis documented without a code" → coding_completeness
ok 489 - the production exhibit shape: "Diagnosis documented without a code" → coding_completeness
  ---
  duration_ms: 0.760625
  type: 'test'
  ...
# Subtest: the regex catches the documented phrasings
ok 490 - the regex catches the documented phrasings
  ---
  duration_ms: 0.569542
  type: 'test'
  ...
# Subtest: a CLINICAL diagnosis-missing finding is NOT a coding gap and passes through
ok 491 - a CLINICAL diagnosis-missing finding is NOT a coding gap and passes through
  ---
  duration_ms: 0.533666
  type: 'test'
  ...
# Subtest: deterministic findings pass through the metadata neutralizer untouched
ok 492 - deterministic findings pass through the metadata neutralizer untouched
  ---
  duration_ms: 0.121292
  type: 'test'
  ...
# Subtest: CODING_GAP_RE is byte-identical — the batch changed nothing
ok 493 - CODING_GAP_RE is byte-identical — the batch changed nothing
  ---
  duration_ms: 1.459416
  type: 'test'
  ...
# Subtest: branchForVerdict maps verdicts to branches
ok 494 - branchForVerdict maps verdicts to branches
  ---
  duration_ms: 0.535208
  type: 'test'
  ...
# Subtest: floorFor detects in-scope analytes and dedups
ok 495 - floorFor detects in-scope analytes and dedups
  ---
  duration_ms: 0.185917
  type: 'test'
  ...
# Subtest: prompt injects the cannot-miss floor for the analyte
ok 496 - prompt injects the cannot-miss floor for the analyte
  ---
  duration_ms: 0.614709
  type: 'test'
  ...
# Subtest: parser extracts a single committed verdict
ok 497 - parser extracts a single committed verdict
  ---
  duration_ms: 0.418125
  type: 'test'
  ...
# Subtest: parser flags multiple verdicts (the A1 mini failure mode)
ok 498 - parser flags multiple verdicts (the A1 mini failure mode)
  ---
  duration_ms: 0.2295
  type: 'test'
  ...
# Subtest: scoreCase: correct branch-A verdict + gap hit + cannot-miss covered
ok 499 - scoreCase: correct branch-A verdict + gap hit + cannot-miss covered
  ---
  duration_ms: 0.1155
  type: 'test'
  ...
# Subtest: scoreCase: control marked discordant is over-flagged
ok 500 - scoreCase: control marked discordant is over-flagged
  ---
  duration_ms: 0.508667
  type: 'test'
  ...
# Subtest: inferUnit picks the unit by magnitude and flags the ambiguous zone
ok 501 - inferUnit picks the unit by magnitude and flags the ambiguous zone
  ---
  duration_ms: 0.088583
  type: 'test'
  ...
# Subtest: resultHasUnit / unitAnnotations only annotate when no unit is typed
ok 502 - resultHasUnit / unitAnnotations only annotate when no unit is typed
  ---
  duration_ms: 0.260916
  type: 'test'
  ...
# Subtest: unitContext flags ambiguity for a clarifying question, assumes otherwise
ok 503 - unitContext flags ambiguity for a clarifying question, assumes otherwise
  ---
  duration_ms: 0.308625
  type: 'test'
  ...
# Subtest: populationLines flags an extreme value against real base rates
ok 504 - populationLines flags an extreme value against real base rates
  ---
  duration_ms: 0.179792
  type: 'test'
  ...
# Subtest: populationLines handles comma numbers and returns nothing off-scope
ok 505 - populationLines handles comma numbers and returns nothing off-scope
  ---
  duration_ms: 0.064292
  type: 'test'
  ...
# Subtest: POPULATION_PRIORS covers the tight analyte set
ok 506 - POPULATION_PRIORS covers the tight analyte set
  ---
  duration_ms: 0.094708
  type: 'test'
  ...
# Subtest: normalizeBelief sums to 1 and topBelief picks the leader
ok 507 - normalizeBelief sums to 1 and topBelief picks the leader
  ---
  duration_ms: 0.091583
  type: 'test'
  ...
# Subtest: isUnknownAnswer recognises "I don't have this" variants
ok 508 - isUnknownAnswer recognises "I don't have this" variants
  ---
  duration_ms: 0.270334
  type: 'test'
  ...
# Subtest: shouldStop fires on cap, confidence, unknown-streak, and belief threshold
ok 509 - shouldStop fires on cap, confidence, unknown-streak, and belief threshold
  ---
  duration_ms: 0.084125
  type: 'test'
  ...
# Subtest: recordTurn tracks unknown streak (resets on an answer) and lifts leadConfidence
ok 510 - recordTurn tracks unknown streak (resets on an answer) and lifts leadConfidence
  ---
  duration_ms: 0.091375
  type: 'test'
  ...
# Subtest: recordTurn logs an open gap on "I don't have this" and increments count
ok 511 - recordTurn logs an open gap on "I don't have this" and increments count
  ---
  duration_ms: 0.049583
  type: 'test'
  ...
# Subtest: toVerdictContext folds transcript + open gaps into the context
ok 512 - toVerdictContext folds transcript + open gaps into the context
  ---
  duration_ms: 0.102916
  type: 'test'
  ...
# Subtest: parseSeed reads branch|weight|cause lines and normalises
ok 513 - parseSeed reads branch|weight|cause lines and normalises
  ---
  duration_ms: 0.158416
  type: 'test'
  ...
# Subtest: parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)
ok 514 - parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)
  ---
  duration_ms: 0.046
  type: 'test'
  ...
# Subtest: parseNextQuestion parses a question and detects STOP
ok 515 - parseNextQuestion parses a question and detects STOP
  ---
  duration_ms: 0.221917
  type: 'test'
  ...
# Subtest: extractDemographics reads compact and worded forms, else null
ok 516 - extractDemographics reads compact and worded forms, else null
  ---
  duration_ms: 0.356875
  type: 'test'
  ...
# Subtest: coarseBand maps age to the mined bands
ok 517 - coarseBand maps age to the mined bands
  ---
  duration_ms: 0.039417
  type: 'test'
  ...
# Subtest: effectivePrior uses the sex cell (Hb F<M) and falls back when a cell is sparse/missing
ok 518 - effectivePrior uses the sex cell (Hb F<M) and falls back when a cell is sparse/missing
  ---
  duration_ms: 0.132
  type: 'test'
  ...
# Subtest: populationLines is sex-stratified when the context gives age/sex
ok 519 - populationLines is sex-stratified when the context gives age/sex
  ---
  duration_ms: 0.09375
  type: 'test'
  ...
# Subtest: buildRunRecord is de-identified: analytes + verdict + counts, no raw text
ok 520 - buildRunRecord is de-identified: analytes + verdict + counts, no raw text
  ---
  duration_ms: 0.162417
  type: 'test'
  ...
# Subtest: summarize aggregates the bank
ok 521 - summarize aggregates the bank
  ---
  duration_ms: 0.116417
  type: 'test'
  ...
# Subtest: (1) SEPARATION: the consensus store is ipd_gold_adjudication, never ipd_audit_feedback
ok 522 - (1) SEPARATION: the consensus store is ipd_gold_adjudication, never ipd_audit_feedback
  ---
  duration_ms: 0.619666
  type: 'test'
  ...
# Subtest: (2) VOCABULARY: exactly tp | valid_extra | false | nitpick | contested
ok 523 - (2) VOCABULARY: exactly tp | valid_extra | false | nitpick | contested
  ---
  duration_ms: 0.758042
  type: 'test'
  ...
# Subtest: (3a) DE-IDENTIFICATION: the harness gates finding text against URLs and PHI
ok 524 - (3a) DE-IDENTIFICATION: the harness gates finding text against URLs and PHI
  ---
  duration_ms: 0.474292
  type: 'test'
  ...
# Subtest: (3b) DE-IDENTIFICATION: the store schema carries no name/UHID column
ok 525 - (3b) DE-IDENTIFICATION: the store schema carries no name/UHID column
  ---
  duration_ms: 0.527417
  type: 'test'
  ...
# Subtest: (4) ONE MATCHER: rescore + harness share the matcher, neither keeps a copy
ok 526 - (4) ONE MATCHER: rescore + harness share the matcher, neither keeps a copy
  ---
  duration_ms: 0.608083
  type: 'test'
  ...
# Subtest: TarReader emits regular files with exact bytes, ignores dirs, across arbitrary chunk splits
ok 527 - TarReader emits regular files with exact bytes, ignores dirs, across arbitrary chunk splits
  ---
  duration_ms: 18.585
  type: 'test'
  ...
# Subtest: TarReader honours an early stop (onFile → false) and drops the rest
ok 528 - TarReader honours an early stop (onFile → false) and drops the rest
  ---
  duration_ms: 0.528083
  type: 'test'
  ...
# Subtest: parseCsv handles quoted fields with embedded commas
ok 529 - parseCsv handles quoted fields with embedded commas
  ---
  duration_ms: 0.095625
  type: 'test'
  ...
# Subtest: parseOaManifest reads File/Title/Publisher/Accession by header position
ok 530 - parseOaManifest reads File/Title/Publisher/Accession by header position
  ---
  duration_ms: 0.147667
  type: 'test'
  ...
# Subtest: selectSeedBooks resolves the allowlist, excludes StatPearls, surfaces missing ids
ok 531 - selectSeedBooks resolves the allowlist, excludes StatPearls, surfaces missing ids
  ---
  duration_ms: 0.897167
  type: 'test'
  ...
# Subtest: sanitizeBookChunk strips NCBI cross-link label runs but keeps prose
ok 532 - sanitizeBookChunk strips NCBI cross-link label runs but keeps prose
  ---
  duration_ms: 0.903625
  type: 'test'
  ...
# Subtest: parseVerdict is fail-safe: valid → verdict; junk/empty/invalid → not_assessable, never a guess
ok 533 - parseVerdict is fail-safe: valid → verdict; junk/empty/invalid → not_assessable, never a guess
  ---
  duration_ms: 1.315917
  type: 'test'
  ...
# Subtest: support rate = directly / assessable; not_assessable excluded from the denominator
ok 534 - support rate = directly / assessable; not_assessable excluded from the denominator
  ---
  duration_ms: 0.378166
  type: 'test'
  ...
# Subtest: Wilson CI: sane bounds, tightens with n, all-supports stays < 1
ok 535 - Wilson CI: sane bounds, tightens with n, all-supports stays < 1
  ---
  duration_ms: 0.917875
  type: 'test'
  ...
# Subtest: cite-or-label fraction
ok 536 - cite-or-label fraction
  ---
  duration_ms: 0.199584
  type: 'test'
  ...
# Subtest: coverage-deficit histogram: deciles + median/p90, clamped
ok 537 - coverage-deficit histogram: deciles + median/p90, clamped
  ---
  duration_ms: 0.359583
  type: 'test'
  ...
# Subtest: the verifier prompt is registry-named + judges from excerpts alone (no patient record)
ok 538 - the verifier prompt is registry-named + judges from excerpts alone (no patient record)
  ---
  duration_ms: 0.878958
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: (a) priced output is total − prompt (reasoning-inclusive), never completion alone
ok 539 - (a) priced output is total − prompt (reasoning-inclusive), never completion alone
  ---
  duration_ms: 0.6015
  type: 'test'
  ...
# Subtest: (a) the rule degrades safely: no total ⇒ completion; never negative; missing usage ⇒ 0
ok 540 - (a) the rule degrades safely: no total ⇒ completion; never negative; missing usage ⇒ 0
  ---
  duration_ms: 0.076292
  type: 'test'
  ...
# Subtest: (b) a multimodal event’s envelope carries the model and reasoning-inclusive tokens_out
ok 541 - (b) a multimodal event’s envelope carries the model and reasoning-inclusive tokens_out
  ---
  duration_ms: 0.341084
  type: 'test'
  ...
# Subtest: (b) the multimodal transport passes an envelope with the reasoning-inclusive rule
ok 542 - (b) the multimodal transport passes an envelope with the reasoning-inclusive rule
  ---
  duration_ms: 0.4505
  type: 'test'
  ...
# Subtest: (c) the multimodal read is logged exactly once — no double count
ok 543 - (c) the multimodal read is logged exactly once — no double count
  ---
  duration_ms: 0.345708
  type: 'test'
  ...
# Subtest: (3) the IPD extract call passes traceId — without it the read self-logs nothing at all
ok 544 - (3) the IPD extract call passes traceId — without it the read self-logs nothing at all
  ---
  duration_ms: 0.1345
  type: 'test'
  ...
# Subtest: the historic backfill touches ONLY the four cost columns, and never re-derives the rule
ok 545 - the historic backfill touches ONLY the four cost columns, and never re-derives the rule
  ---
  duration_ms: 0.21775
  type: 'test'
  ...
# Subtest: the column path and the payload path state the SAME rule (they must never drift)
ok 546 - the column path and the payload path state the SAME rule (they must never drift)
  ---
  duration_ms: 0.256458
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: orderPair: canonical order on the normalised lowercase name; original names preserved; same norm as pairKey
ok 547 - orderPair: canonical order on the normalised lowercase name; original names preserved; same norm as pairKey
  ---
  duration_ms: 1.653667
  type: 'test'
  ...
# Subtest: all three construction sites emit the canonical order regardless of input order
ok 548 - all three construction sites emit the canonical order regardless of input order
  ---
  duration_ms: 24.65675
  type: 'test'
  ...
# Subtest: ddiFindings: the same two drugs in either meds[] order produce an identical finding_ref and stable_ref
ok 549 - ddiFindings: the same two drugs in either meds[] order produce an identical finding_ref and stable_ref
  ---
  duration_ms: 7.069667
  type: 'test'
  ...
# Subtest: ddiFindings: a three-drug script is ref-stable under full reversal (multiple pairs at once)
ok 550 - ddiFindings: a three-drug script is ref-stable under full reversal (multiple pairs at once)
  ---
  duration_ms: 4.768208
  type: 'test'
  ...
# Subtest: involvesTopical (ddiToFinding): topical de-escalation identical in either order
ok 551 - involvesTopical (ddiToFinding): topical de-escalation identical in either order
  ---
  duration_ms: 0.996875
  type: 'test'
  ...
# Subtest: bothNsaid (Ruling 1 suppression): topical NSAID–NSAID suppressed entirely in either order
ok 552 - bothNsaid (Ruling 1 suppression): topical NSAID–NSAID suppressed entirely in either order
  ---
  duration_ms: 10.888208
  type: 'test'
  ...
# Subtest: scope guard: canonicalisation changed no firing decision — pair count and content match a reversed run everywhere
ok 553 - scope guard: canonicalisation changed no firing decision — pair count and content match a reversed run everywhere
  ---
  duration_ms: 13.872833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: THE PREMISE: resolveMedRoute returns null for the real gel — its name has no form word
ok 554 - THE PREMISE: resolveMedRoute returns null for the real gel — its name has no form word
  ---
  duration_ms: 1.343542
  type: 'test'
  ...
# Subtest: a med with dosageForm topical and a NULL resolveMedRoute now enters the topical set
ok 555 - a med with dosageForm topical and a NULL resolveMedRoute now enters the topical set
  ---
  duration_ms: 2.14575
  type: 'test'
  ...
# Subtest: THE REAL CASE: oral NSAID + the gel with dosageForm topical produces NO drug_interaction
ok 556 - THE REAL CASE: oral NSAID + the gel with dosageForm topical produces NO drug_interaction
  ---
  duration_ms: 0.26725
  type: 'test'
  ...
# Subtest: THE CONTROL: the same pair with dosageForm UNSET still leaks — so the test measures the new path
ok 557 - THE CONTROL: the same pair with dosageForm UNSET still leaks — so the test measures the new path
  ---
  duration_ms: 0.239542
  type: 'test'
  ...
# Subtest: two ORAL NSAIDs still produce the finding, unchanged
ok 558 - two ORAL NSAIDs still produce the finding, unchanged
  ---
  duration_ms: 0.202875
  type: 'test'
  ...
# Subtest: drops, inhaler and injection do NOT enter the topical set (DEC-4 keeps this narrow)
ok 559 - drops, inhaler and injection do NOT enter the topical set (DEC-4 keeps this narrow)
  ---
  duration_ms: 0.842875
  type: 'test'
  ...
# Subtest: resolveMedRoute === topical still qualifies on its own — the original path is intact
ok 560 - resolveMedRoute === topical still qualifies on its own — the original path is intact
  ---
  duration_ms: 0.227917
  type: 'test'
  ...
# Subtest: the NSAID–NSAID restriction holds: a topical NSAID + a NON-NSAID still fires
ok 561 - the NSAID–NSAID restriction holds: a topical NSAID + a NON-NSAID still fires
  ---
  duration_ms: 0.096917
  type: 'test'
  ...
# Subtest: a non-NSAID pair is unaffected — the QT rule still fires
ok 562 - a non-NSAID pair is unaffected — the QT rule still fires
  ---
  duration_ms: 0.665208
  type: 'test'
  ...
# Subtest: fewer than two eligible meds still returns nothing
ok 563 - fewer than two eligible meds still returns nothing
  ---
  duration_ms: 2.143
  type: 'test'
  ...
# Subtest: the topical set reads BOTH sources, and Ruling 1 is byte-identical
ok 564 - the topical set reads BOTH sources, and Ruling 1 is byte-identical
  ---
  duration_ms: 13.647084
  type: 'test'
  ...
# Subtest: matchDx: normalized substring match, tolerant of qualifiers and punctuation
ok 565 - matchDx: normalized substring match, tolerant of qualifiers and punctuation
  ---
  duration_ms: 5.085625
  type: 'test'
  ...
# Subtest: matchDx: synonyms match when the literal expected string does not
ok 566 - matchDx: synonyms match when the literal expected string does not
  ---
  duration_ms: 0.449458
  type: 'test'
  ...
# Subtest: matchDx: negatives — unrelated diagnoses and short-token false hits rejected
ok 567 - matchDx: negatives — unrelated diagnoses and short-token false hits rejected
  ---
  duration_ms: 0.701125
  type: 'test'
  ...
# Subtest: matchDx v3: INTERIOR mid-word hit rejected, but boundary-anchored matches preserved
ok 568 - matchDx v3: INTERIOR mid-word hit rejected, but boundary-anchored matches preserved
  ---
  duration_ms: 0.416833
  type: 'test'
  ...
# Subtest: rankedDifferential is most_likely order; allEntries spans the three axes
ok 569 - rankedDifferential is most_likely order; allEntries spans the three axes
  ---
  duration_ms: 0.417459
  type: 'test'
  ...
# Subtest: fabricated-finding heuristic: flags asserted-but-unstated findings only
ok 570 - fabricated-finding heuristic: flags asserted-but-unstated findings only
  ---
  duration_ms: 0.784542
  type: 'test'
  ...
# Subtest: scoreDdxCase: clean fixture — top-1 hit, cannot-miss covered, nothing flagged
ok 571 - scoreDdxCase: clean fixture — top-1 hit, cannot-miss covered, nothing flagged
  ---
  duration_ms: 1.5965
  type: 'test'
  ...
# Subtest: scoreDdxCase: dirty fixture — every failure mode fires
ok 572 - scoreDdxCase: dirty fixture — every failure mode fires
  ---
  duration_ms: 0.430292
  type: 'test'
  ...
# Subtest: scoreDdxCase: synonym match covers cannot-miss ("AAA rupture" counts as ruptured AAA)
ok 573 - scoreDdxCase: synonym match covers cannot-miss ("AAA rupture" counts as ruptured AAA)
  ---
  duration_ms: 0.526125
  type: 'test'
  ...
# Subtest: scoreDdxCase: empty result — misses everything, never throws
ok 574 - scoreDdxCase: empty result — misses everything, never throws
  ---
  duration_ms: 0.396167
  type: 'test'
  ...
# Subtest: summarizeDdx: rates over the right denominators, incl. the null cannot-miss path
ok 575 - summarizeDdx: rates over the right denominators, incl. the null cannot-miss path
  ---
  duration_ms: 0.230209
  type: 'test'
  ...
# Subtest: summarizeDdx: no case specifies cannot-miss → recall defaults to 1; empty bank never divides by 0
ok 576 - summarizeDdx: no case specifies cannot-miss → recall defaults to 1; empty bank never divides by 0
  ---
  duration_ms: 0.058875
  type: 'test'
  ...
# Subtest: A1 matcher v2: British↔American spelling variants now match
ok 577 - A1 matcher v2: British↔American spelling variants now match
  ---
  duration_ms: 0.093958
  type: 'test'
  ...
# Subtest: A1 matcher v2: does NOT over-match unrelated diagnoses (containment unchanged)
ok 578 - A1 matcher v2: does NOT over-match unrelated diagnoses (containment unchanged)
  ---
  duration_ms: 0.053792
  type: 'test'
  ...
# Subtest: A2 lane coverage: covered iff ≥1 lane dx matches any engine axis
ok 579 - A2 lane coverage: covered iff ≥1 lane dx matches any engine axis
  ---
  duration_ms: 0.1585
  type: 'test'
  ...
# Subtest: A2 lane coverage: null (skipped) when a case defines no expectedLanes
ok 580 - A2 lane coverage: null (skipped) when a case defines no expectedLanes
  ---
  duration_ms: 0.088792
  type: 'test'
  ...
# Subtest: A2 laneCoverageRate: mean per-case rate over labelled cases only; null when none labelled
ok 581 - A2 laneCoverageRate: mean per-case rate over labelled cases only; null when none labelled
  ---
  duration_ms: 0.115875
  type: 'test'
  ...
# Subtest: A3 negative misuse: fires when a considered dx asserts a documented-negative finding
ok 582 - A3 negative misuse: fires when a considered dx asserts a documented-negative finding
  ---
  duration_ms: 0.265083
  type: 'test'
  ...
# Subtest: A3 cannot-miss over-flag: fires when an unsupported cannot-miss dx is surfaced
ok 583 - A3 cannot-miss over-flag: fires when an unsupported cannot-miss dx is surfaced
  ---
  duration_ms: 0.140541
  type: 'test'
  ...
# Subtest: A3 summary rates: denominated over labelled cases; null when none labelled
ok 584 - A3 summary rates: denominated over labelled cases; null when none labelled
  ---
  duration_ms: 0.065042
  type: 'test'
  ...
# Subtest: A4 latency: nearest-rank P50/P90 from supplied ms; null when none
ok 585 - A4 latency: nearest-rank P50/P90 from supplied ms; null when none
  ---
  duration_ms: 0.121458
  type: 'test'
  ...
# Subtest: A6 version stamping: summary carries matcher + bank versions
ok 586 - A6 version stamping: summary carries matcher + bank versions
  ---
  duration_ms: 0.054125
  type: 'test'
  ...
# Subtest: A6 freeze guard: dormant passes; active passes on match, fails on mismatch
ok 587 - A6 freeze guard: dormant passes; active passes on match, fails on mismatch
  ---
  duration_ms: 0.075917
  type: 'test'
  ...
# Subtest: A5 scoreFromResultsJson: re-scores a saved results file with no network
ok 588 - A5 scoreFromResultsJson: re-scores a saved results file with no network
  ---
  duration_ms: 0.978375
  type: 'test'
  ...
# Subtest: FREEZE: pinned pair is ddx-eval/3 + ddx-case-bank/1.0 and matches the committed bank
ok 589 - FREEZE: pinned pair is ddx-eval/3 + ddx-case-bank/1.0 and matches the committed bank
  ---
  duration_ms: 0.459292
  type: 'test'
  ...
# Subtest: F3 collision guard: no two cannot-miss dx in any case collapse under matcher + synonyms
ok 590 - F3 collision guard: no two cannot-miss dx in any case collapse under matcher + synonyms
  ---
  duration_ms: 1.696792
  type: 'test'
  ...
# Subtest: existing 7 summary metrics are byte-identical on an unchanged score set
ok 591 - existing 7 summary metrics are byte-identical on an unchanged score set
  ---
  duration_ms: 0.062709
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: r1 — the callback type carries the map, and it is TRAILING and OPTIONAL
ok 592 - r1 — the callback type carries the map, and it is TRAILING and OPTIONAL
  ---
  duration_ms: 3.059541
  type: 'test'
  ...
# Subtest: r2 — the two DECLARATION publications pass no map
ok 593 - r2 — the two DECLARATION publications pass no map
  ---
  duration_ms: 6.60125
  type: 'test'
  ...
# Subtest: r3 — BOTH terminal publications pass a SHALLOW SNAPSHOT, never the live object
ok 594 - r3 — BOTH terminal publications pass a SHALLOW SNAPSHOT, never the live object
  ---
  duration_ms: 0.552167
  type: 'test'
  ...
# Subtest: r3b — a shallow snapshot really is immune to the mutation that follows it
ok 595 - r3b — a shallow snapshot really is immune to the mutation that follows it
  ---
  duration_ms: 0.385208
  type: 'test'
  ...
# Subtest: r5 — NO owner reads `?? {}` any more, anywhere in the repository
ok 596 - r5 — NO owner reads `?? {}` any more, anywhere in the repository
  ---
  duration_ms: 1.329375
  type: 'test'
  ...
# Subtest: r4 — every owner prefers the ATTACHED map, then the CALLBACK map, then undefined
ok 597 - r4 — every owner prefers the ATTACHED map, then the CALLBACK map, then undefined
  ---
  duration_ms: 1.146667
  type: 'test'
  ...
# Subtest: r4b — the selection order, exercised against the REAL attach and read
ok 598 - r4b — the selection order, exercised against the REAL attach and read
  ---
  duration_ms: 0.111916
  type: 'test'
  ...
# Subtest: r4c — the two callback sites that read NO map were not changed
ok 599 - r4c — the two callback sites that read NO map were not changed
  ---
  duration_ms: 0.538125
  type: 'test'
  ...
# Subtest: r11 — line 1723 is not wrapped, not rewritten, and still the only unattached return
ok 600 - r11 — line 1723 is not wrapped, not rewritten, and still the only unattached return
  ---
  duration_ms: 0.726042
  type: 'test'
  ...
# Subtest: §4.1 CHECK 1: the prefix alone does NOT set direction when class-absence objects
ok 601 - §4.1 CHECK 1: the prefix alone does NOT set direction when class-absence objects
  ---
  duration_ms: 0.671666
  type: 'test'
  ...
# Subtest: with no objection, the prefix sets direction — both values
ok 602 - with no objection, the prefix sets direction — both values
  ---
  duration_ms: 0.163708
  type: 'test'
  ...
# Subtest: an absent/blank/foreign concept_id yields NO direction — undetermined is the honest default
ok 603 - an absent/blank/foreign concept_id yields NO direction — undetermined is the honest default
  ---
  duration_ms: 0.060792
  type: 'test'
  ...
# Subtest: deterministic findings are never stamped
ok 604 - deterministic findings are never stamped
  ---
  duration_ms: 0.044875
  type: 'test'
  ...
# Subtest: the class-absence predicate has ONE implementation
ok 605 - the class-absence predicate has ONE implementation
  ---
  duration_ms: 0.245167
  type: 'test'
  ...
# Subtest: §4.3: an underuse finding scores IDENTICALLY to a note with no finding at all
ok 606 - §4.3: an underuse finding scores IDENTICALLY to a note with no finding at all
  ---
  duration_ms: 0.33525
  type: 'test'
  ...
# Subtest: …while the SAME finding marked overuse (or unmarked) still penalises — the control
ok 607 - …while the SAME finding marked overuse (or unmarked) still penalises — the control
  ---
  duration_ms: 0.147
  type: 'test'
  ...
# Subtest: §4.4: SEVERITY and PENALTY_BASE are BYTE-IDENTICAL — no new member, no re-weighting
ok 608 - §4.4: SEVERITY and PENALTY_BASE are BYTE-IDENTICAL — no new member, no re-weighting
  ---
  duration_ms: 0.386875
  type: 'test'
  ...
# Subtest: NetValue is untouched — no member meaning underuse was added
ok 609 - NetValue is untouched — no member meaning underuse was added
  ---
  duration_ms: 0.331833
  type: 'test'
  ...
# Subtest: §4.5: an underuse finding receives NO lvc_category
ok 610 - §4.5: an underuse finding receives NO lvc_category
  ---
  duration_ms: 0.6905
  type: 'test'
  ...
# Subtest: §4.5: an underuse finding does not keep signal_type low_value_care
ok 611 - §4.5: an underuse finding does not keep signal_type low_value_care
  ---
  duration_ms: 0.260917
  type: 'test'
  ...
# Subtest: §4.6 THE REGRESSION THAT MATTERS: an OVERUSE finding is stamped exactly as before
ok 612 - §4.6 THE REGRESSION THAT MATTERS: an OVERUSE finding is stamped exactly as before
  ---
  duration_ms: 0.415625
  type: 'test'
  ...
# Subtest: finding ORDER is preserved by the gate — the report numbers findings by position
ok 613 - finding ORDER is preserved by the gate — the report numbers findings by position
  ---
  duration_ms: 0.2755
  type: 'test'
  ...
# Subtest: direction is stamped BEFORE stampLvcMetadata
ok 614 - direction is stamped BEFORE stampLvcMetadata
  ---
  duration_ms: 0.660292
  type: 'test'
  ...
# Subtest: the contradicted-by-structure neutraliser is GONE (0.81.19) and CODING_GAP_RE is byte-identical
ok 615 - the contradicted-by-structure neutraliser is GONE (0.81.19) and CODING_GAP_RE is byte-identical
  ---
  duration_ms: 1.070459
  type: 'test'
  ...
# Subtest: (1) ADAPTER: dischargeToEncounter → admission encounter, provenance preserved, no fabrication
ok 616 - (1) ADAPTER: dischargeToEncounter → admission encounter, provenance preserved, no fabrication
  ---
  duration_ms: 0.726833
  type: 'test'
  ...
# Subtest: (2) COMPOSITION: flag ON appends the admission at the tail
ok 617 - (2) COMPOSITION: flag ON appends the admission at the tail
  ---
  duration_ms: 0.429375
  type: 'test'
  ...
# Subtest: (3) BYTE-IDENTICAL: the OPD+labs encounters are EXACTLY the frozen output; admission is additive
ok 618 - (3) BYTE-IDENTICAL: the OPD+labs encounters are EXACTLY the frozen output; admission is additive
  ---
  duration_ms: 0.328625
  type: 'test'
  ...
# Subtest: (3) DEFAULT-OFF: flag off (or no episode) ⇒ deep-equal to the frozen assembleEvidence
ok 619 - (3) DEFAULT-OFF: flag off (or no episode) ⇒ deep-equal to the frozen assembleEvidence
  ---
  duration_ms: 0.337584
  type: 'test'
  ...
# Subtest: the adapter reads the spine by TYPE only + composes, never edits (structural)
ok 620 - the adapter reads the spine by TYPE only + composes, never edits (structural)
  ---
  duration_ms: 0.964083
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a write degrades to "skipped" and a read to null — never a throw
ok 621 - a write degrades to "skipped" and a read to null — never a throw
  ---
  duration_ms: 0.562459
  type: 'test'
  ...
# Subtest: absent and unreachable are the same answer to the reader: extract it yourself
ok 622 - absent and unreachable are the same answer to the reader: extract it yourself
  ---
  duration_ms: 0.072625
  type: 'test'
  ...
# Subtest: rowToStoredCase round-trips a stored row
ok 623 - rowToStoredCase round-trips a stored row
  ---
  duration_ms: 0.941875
  type: 'test'
  ...
# Subtest: a jsonb column handed back as TEXT is tolerated; unusable payloads are refused, not guessed
ok 624 - a jsonb column handed back as TEXT is tolerated; unusable payloads are refused, not guessed
  ---
  duration_ms: 0.36175
  type: 'test'
  ...
# Subtest: the extraction version is a shared constant both readers move on together
ok 625 - the extraction version is a shared constant both readers move on together
  ---
  duration_ms: 0.140542
  type: 'test'
  ...
# [doc-audit-core] normNetValue: unparseable verdict "nonsense" → 'uncertain' (parse fallback, not a clinical judgment)
# Subtest: normDocType maps synonyms + defaults to discharge_summary
ok 626 - normDocType maps synonyms + defaults to discharge_summary
  ---
  duration_ms: 1.721042
  type: 'test'
  ...
# Subtest: normFieldStatus + normNetValue map + default
ok 627 - normFieldStatus + normNetValue map + default
  ---
  duration_ms: 0.582208
  type: 'test'
  ...
# Subtest: parseExtraction reads a fenced extraction, honours docTypeHint, de-id age/sex only, + completeness/adminFacts
ok 628 - parseExtraction reads a fenced extraction, honours docTypeHint, de-id age/sex only, + completeness/adminFacts
  ---
  duration_ms: 0.369875
  type: 'test'
  ...
# Subtest: parseExtraction docTypeHint overrides detected
ok 629 - parseExtraction docTypeHint overrides detected
  ---
  duration_ms: 0.069541
  type: 'test'
  ...
# Subtest: parseExtraction returns null when nothing was read
ok 630 - parseExtraction returns null when nothing was read
  ---
  duration_ms: 0.052375
  type: 'test'
  ...
# Subtest: parseAnalysis parses findings/diff/suggestions (no completeness); maps diff kinds; sorts suggestions
ok 631 - parseAnalysis parses findings/diff/suggestions (no completeness); maps diff kinds; sorts suggestions
  ---
  duration_ms: 0.521
  type: 'test'
  ...
# Subtest: parseAnalysis returns null on empty/garbage; survives on idealised-only
ok 632 - parseAnalysis returns null on empty/garbage; survives on idealised-only
  ---
  duration_ms: 0.064625
  type: 'test'
  ...
# Subtest: parseStatusList + normAdminFacts: status-only, day-count not dates
ok 633 - parseStatusList + normAdminFacts: status-only, day-count not dates
  ---
  duration_ms: 0.081875
  type: 'test'
  ...
# Subtest: assembleCompleteness scores present/partial/na/missing over non-conditional mandatory fields
ok 634 - assembleCompleteness scores present/partial/na/missing over non-conditional mandatory fields
  ---
  duration_ms: 0.28925
  type: 'test'
  ...
# Subtest: assembleCompleteness counts partial as 0.5 and includes an applicable conditional field
ok 635 - assembleCompleteness counts partial as 0.5 and includes an applicable conditional field
  ---
  duration_ms: 0.285291
  type: 'test'
  ...
# Subtest: PX-R3: OLD-shape extraction (no risk_factors/aftercare) parses with every pre-existing field unchanged + safe defaults for the new keys
ok 636 - PX-R3: OLD-shape extraction (no risk_factors/aftercare) parses with every pre-existing field unchanged + safe defaults for the new keys
  ---
  duration_ms: 0.110208
  type: 'test'
  ...
# Subtest: PX-G2 pin: buildAnalyzeUser includes stated risk factors so safety findings (e.g. allergy breaches) stay visible to the analyze pass
ok 637 - PX-G2 pin: buildAnalyzeUser includes stated risk factors so safety findings (e.g. allergy breaches) stay visible to the analyze pass
  ---
  duration_ms: 0.1645
  type: 'test'
  ...
# Subtest: PX-R3: NEW-shape extraction parses risk_factors + aftercare; empty aftercare collapses to undefined
ok 638 - PX-R3: NEW-shape extraction parses risk_factors + aftercare; empty aftercare collapses to undefined
  ---
  duration_ms: 0.955416
  type: 'test'
  ...
# Subtest: enrichQueryForFinding joins subject + evidence + rationale, trims blanks, length-bounds
ok 639 - enrichQueryForFinding joins subject + evidence + rationale, trims blanks, length-bounds
  ---
  duration_ms: 0.247417
  type: 'test'
  ...
# Subtest: unionEnrichedHits keeps base as an identity prefix, dedupes by id, appends net-new, respects cap
ok 640 - unionEnrichedHits keeps base as an identity prefix, dedupes by id, appends net-new, respects cap
  ---
  duration_ms: 0.510333
  type: 'test'
  ...
# Subtest: unionEnrichedHits keys by String(id) — DB returns bigint chunk ids as STRINGS (regression)
ok 641 - unionEnrichedHits keys by String(id) — DB returns bigint chunk ids as STRINGS (regression)
  ---
  duration_ms: 0.258708
  type: 'test'
  ...
# Subtest: SL2: AUDIT_REVISE_SYSTEM carries the empty-citation→estimates discipline for the enriched pool
ok 642 - SL2: AUDIT_REVISE_SYSTEM carries the empty-citation→estimates discipline for the enriched pool
  ---
  duration_ms: 0.168417
  type: 'test'
  ...
# Subtest: applyCitationGate: partial drop keeps evidence + surviving citations
ok 643 - applyCitationGate: partial drop keeps evidence + surviving citations
  ---
  duration_ms: 0.28775
  type: 'test'
  ...
# Subtest: applyCitationGate: dropping ALL citations relabels evidence→estimates (cite-or-label)
ok 644 - applyCitationGate: dropping ALL citations relabels evidence→estimates (cite-or-label)
  ---
  duration_ms: 0.113792
  type: 'test'
  ...
# Subtest: applyCitationGate: no drops → untouched; multi-finding indices are respected
ok 645 - applyCitationGate: no drops → untouched; multi-finding indices are respected
  ---
  duration_ms: 0.119375
  type: 'test'
  ...
# Subtest: applyCitationGate: emptying a finding with NO evidence drops cites without relabel
ok 646 - applyCitationGate: emptying a finding with NO evidence drops cites without relabel
  ---
  duration_ms: 0.224375
  type: 'test'
  ...
# Subtest: §2.3: magic numbers identify the document
ok 647 - §2.3: magic numbers identify the document
  ---
  duration_ms: 0.59
  type: 'test'
  ...
# Subtest: §2.3: an unsupported body returns NULL — the old code guessed application/pdf
ok 648 - §2.3: an unsupported body returns NULL — the old code guessed application/pdf
  ---
  duration_ms: 1.664709
  type: 'test'
  ...
# Subtest: §2.3: the URL-extension guess is GONE from ccb-brief; the bytes decide and null ⇒ unreadable
ok 649 - §2.3: the URL-extension guess is GONE from ccb-brief; the bytes decide and null ⇒ unreadable
  ---
  duration_ms: 0.090375
  type: 'test'
  ...
# Subtest: §2.3: the Record-audit upload sniffs too — the client mime is only a hint
ok 650 - §2.3: the Record-audit upload sniffs too — the client mime is only a hint
  ---
  duration_ms: 0.046916
  type: 'test'
  ...
# Subtest: §2.1: EXTRACT_SYSTEM demands an explicit marker and FORBIDS empty-fields-as-signal
ok 651 - §2.1: EXTRACT_SYSTEM demands an explicit marker and FORBIDS empty-fields-as-signal
  ---
  duration_ms: 0.06075
  type: 'test'
  ...
# Subtest: §2.1: the marker is honoured, in either shape
ok 652 - §2.1: the marker is honoured, in either shape
  ---
  duration_ms: 0.176334
  type: 'test'
  ...
# Subtest: §2.1 THE MEASURED FAILURE: a well-formed all-empty extract is a FAILED READ, not a report
ok 653 - §2.1 THE MEASURED FAILURE: a well-formed all-empty extract is a FAILED READ, not a report
  ---
  duration_ms: 0.142833
  type: 'test'
  ...
# Subtest: §2.1 control: ANY real clinical content survives — one field is enough
ok 654 - §2.1 control: ANY real clinical content survives — one field is enough
  ---
  duration_ms: 0.061666
  type: 'test'
  ...
# Subtest: §2.2: putExtract REFUSES an empty extract, at the write, before the immutable insert
ok 655 - §2.2: putExtract REFUSES an empty extract, at the write, before the immutable insert
  ---
  duration_ms: 0.202041
  type: 'test'
  ...
# Subtest: §1: the PDF engine is native, pinned explicitly — never the default that falls to mistral-ocr
ok 656 - §1: the PDF engine is native, pinned explicitly — never the default that falls to mistral-ocr
  ---
  duration_ms: 0.62
  type: 'test'
  ...
# Subtest: §4: mistral-ocr appears NOWHERE in the shipped transport
ok 657 - §4: mistral-ocr appears NOWHERE in the shipped transport
  ---
  duration_ms: 0.238167
  type: 'test'
  ...
# Subtest: §3: the Google-only provider pin rides EVERY document call
ok 658 - §3: the Google-only provider pin rides EVERY document call
  ---
  duration_ms: 0.072125
  type: 'test'
  ...
# Subtest: §3: PDFs ride type:file; images ride type:image_url (built, but UNEXERCISED by production traffic)
ok 659 - §3: PDFs ride type:file; images ride type:image_url (built, but UNEXERCISED by production traffic)
  ---
  duration_ms: 0.103708
  type: 'test'
  ...
# Subtest: §3: token headroom — Pro spends output budget on reasoning first
ok 660 - §3: token headroom — Pro spends output budget on reasoning first
  ---
  duration_ms: 0.036833
  type: 'test'
  ...
# Subtest: §3: a TIMEOUT bounds the read — its absence is why Record audit HUNG instead of failing
ok 661 - §3: a TIMEOUT bounds the read — its absence is why Record audit HUNG instead of failing
  ---
  duration_ms: 0.047333
  type: 'test'
  ...
# Subtest: §3: failures surface as provider_error AND as unreadable (null), never as an empty extract
ok 662 - §3: failures surface as provider_error AND as unreadable (null), never as an empty extract
  ---
  duration_ms: 0.726209
  type: 'test'
  ...
# Subtest: §4: the Vertex path is untouched and is what runs with the flag unset
ok 663 - §4: the Vertex path is untouched and is what runs with the flag unset
  ---
  duration_ms: 0.068917
  type: 'test'
  ...
# Subtest: normalizeDoctorName: order-independent, Dr/punct stripped
ok 664 - normalizeDoctorName: order-independent, Dr/punct stripped
  ---
  duration_ms: 0.457667
  type: 'test'
  ...
# Subtest: mobileLast4
ok 665 - mobileLast4
  ---
  duration_ms: 0.099333
  type: 'test'
  ...
# Subtest: isGenericDoctorRow: system/placeholder rows dropped
ok 666 - isGenericDoctorRow: system/placeholder rows dropped
  ---
  duration_ms: 0.153625
  type: 'test'
  ...
# Subtest: buildRoster: drops generics, dedupes same-person by mobile, folds activity
ok 667 - buildRoster: drops generics, dedupes same-person by mobile, folds activity
  ---
  duration_ms: 9.947791
  type: 'test'
  ...
# Subtest: buildRoster: no-mobile rows are never merged with each other
ok 668 - buildRoster: no-mobile rows are never merged with each other
  ---
  duration_ms: 0.320583
  type: 'test'
  ...
# Subtest: parseFrequency: dosing grid sums slots
ok 669 - parseFrequency: dosing grid sums slots
  ---
  duration_ms: 0.8815
  type: 'test'
  ...
# Subtest: parseFrequency: spoken/abbreviated frequencies
ok 670 - parseFrequency: spoken/abbreviated frequencies
  ---
  duration_ms: 0.666833
  type: 'test'
  ...
# Subtest: parseFrequency: SOS is a ceiling, not a fixed dose
ok 671 - parseFrequency: SOS is a ceiling, not a fixed dose
  ---
  duration_ms: 0.135875
  type: 'test'
  ...
# Subtest: parseFrequency: empty/garbage → unknown
ok 672 - parseFrequency: empty/garbage → unknown
  ---
  duration_ms: 0.050667
  type: 'test'
  ...
# Subtest: unitsPerDose
ok 673 - unitsPerDose
  ---
  duration_ms: 0.2
  type: 'test'
  ...
# Subtest: strengthTokenToMg: unit conversion
ok 674 - strengthTokenToMg: unit conversion
  ---
  duration_ms: 0.567083
  type: 'test'
  ...
# Subtest: canonicalMolecule maps synonyms + ignores non-ceiling co-molecules
ok 675 - canonicalMolecule maps synonyms + ignores non-ceiling co-molecules
  ---
  duration_ms: 1.556125
  type: 'test'
  ...
# Subtest: moleculesOf zips + aligns per-molecule strengths in a combo
ok 676 - moleculesOf zips + aligns per-molecule strengths in a combo
  ---
  duration_ms: 0.7355
  type: 'test'
  ...
# Subtest: moleculesOf: parenthetical strength list in the generic name does not misalign (real EMR shape)
ok 677 - moleculesOf: parenthetical strength list in the generic name does not misalign (real EMR shape)
  ---
  duration_ms: 3.108334
  type: 'test'
  ...
# Subtest: CASE A — paracetamol stacking across products flags an exceedance
ok 678 - CASE A — paracetamol stacking across products flags an exceedance
  ---
  duration_ms: 2.511792
  type: 'test'
  ...
# Subtest: CASE B — a single correctly-dosed NSAID + a different-indication drug does NOT flag
ok 679 - CASE B — a single correctly-dosed NSAID + a different-indication drug does NOT flag
  ---
  duration_ms: 0.157
  type: 'test'
  ...
# Subtest: single product over its own ceiling still flags (no stacking required)
ok 680 - single product over its own ceiling still flags (no stacking required)
  ---
  duration_ms: 0.184584
  type: 'test'
  ...
# Subtest: SOS-only exceedance is a softer, lower-confidence advisory
ok 681 - SOS-only exceedance is a softer, lower-confidence advisory
  ---
  duration_ms: 0.105833
  type: 'test'
  ...
# Subtest: paediatric liquid/suspension (concentration strength, ml dose) is excluded — no false flag
ok 682 - paediatric liquid/suspension (concentration strength, ml dose) is excluded — no false flag
  ---
  duration_ms: 0.071958
  type: 'test'
  ...
# Subtest: same molecule in two products but within ceiling → informational only
ok 683 - same molecule in two products but within ceiling → informational only
  ---
  duration_ms: 0.075958
  type: 'test'
  ...
# Subtest: BUG-0.8-13: a syrup dosed "10ml (2 tsp)" is volumetric and its volume is never a tablet count
ok 684 - BUG-0.8-13: a syrup dosed "10ml (2 tsp)" is volumetric and its volume is never a tablet count
  ---
  duration_ms: 0.048
  type: 'test'
  ...
# Subtest: §3.1 parseDurationDays (moved to the pure core) parses days/weeks/months, null for chronic/unparseable
ok 685 - §3.1 parseDurationDays (moved to the pure core) parses days/weeks/months, null for chronic/unparseable
  ---
  duration_ms: 0.243542
  type: 'test'
  ...
# Subtest: Decision 5 — naproxen: 1250 mg over a 1-day course does NOT fire; over 5 days it fires
ok 686 - Decision 5 — naproxen: 1250 mg over a 1-day course does NOT fire; over 5 days it fires
  ---
  duration_ms: 0.204042
  type: 'test'
  ...
# Subtest: Decision 6 — etoricoxib: 120 with gout → no finding; 120 without → fires; 90 without → no finding
ok 687 - Decision 6 — etoricoxib: 120 with gout → no finding; 120 without → fires; 90 without → no finding
  ---
  duration_ms: 0.141875
  type: 'test'
  ...
# Subtest: §4 fail-safe — omitting ctx is identical to passing it for molecules without conditional fields
ok 688 - §4 fail-safe — omitting ctx is identical to passing it for molecules without conditional fields
  ---
  duration_ms: 0.555958
  type: 'test'
  ...
# Subtest: Decision 7/8 — metformin: 500+500 within ceiling → informational (conf 0); 1500+2000 → scoring exceedance (clinician-signed)
ok 689 - Decision 7/8 — metformin: 500+500 within ceiling → informational (conf 0); 1500+2000 → scoring exceedance (clinician-signed)
  ---
  duration_ms: 0.162209
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS
ok 690 - the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS
  ---
  duration_ms: 0.619875
  type: 'test'
  ...
# Subtest: every Part C relation is VACUOUS in the state that makes IT untestable
ok 691 - every Part C relation is VACUOUS in the state that makes IT untestable
  ---
  duration_ms: 0.102417
  type: 'test'
  ...
# Subtest: L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires
ok 692 - L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires
  ---
  duration_ms: 0.063125
  type: 'test'
  ...
# Subtest: with the precondition met, the verdicts are the relation's own — HOLDS and FAILS both reachable
ok 693 - with the precondition met, the verdicts are the relation's own — HOLDS and FAILS both reachable
  ---
  duration_ms: 0.127375
  type: 'test'
  ...
# Subtest: RATIFIED_AT_ENGINE is pinned to the version the map was measured at — now 0.81.21
ok 694 - RATIFIED_AT_ENGINE is pinned to the version the map was measured at — now 0.81.21
  ---
  duration_ms: 0.047875
  type: 'test'
  ...
# Subtest: the drift warning is null at the deployed engine, and exact when a version differs
ok 695 - the drift warning is null at the deployed engine, and exact when a version differs
  ---
  duration_ms: 0.051208
  type: 'test'
  ...
# Subtest: the panel renders the constant, not a hard-coded version string
ok 696 - the panel renders the constant, not a hard-coded version string
  ---
  duration_ms: 0.231208
  type: 'test'
  ...
# Subtest: RATIFIED_RELATION_STATUS: D-5 stays a pinned failure; D-7 was FIXED and re-ratified
ok 697 - RATIFIED_RELATION_STATUS: D-5 stays a pinned failure; D-7 was FIXED and re-ratified
  ---
  duration_ms: 0.045625
  type: 'test'
  ...
# Subtest: §4.7: opts.engineVersion threads through on the PRODUCTION path, verbatim per the kickoff
ok 698 - §4.7: opts.engineVersion threads through on the PRODUCTION path, verbatim per the kickoff
  ---
  duration_ms: 0.527375
  type: 'test'
  ...
# Subtest: §4.8: absent opts.engineVersion, the production path still yields OPD_ENGINE_VERSION
ok 699 - §4.8: absent opts.engineVersion, the production path still yields OPD_ENGINE_VERSION
  ---
  duration_ms: 0.104917
  type: 'test'
  ...
# Subtest: the MINI path is untouched by the override — and always writes -<tag> (D1, 2 Aug 2026)
ok 700 - the MINI path is untouched by the override — and always writes -<tag> (D1, 2 Aug 2026)
  ---
  duration_ms: 0.124625
  type: 'test'
  ...
# Subtest: AuditOpdOpts declares engineVersion as an optional string
ok 701 - AuditOpdOpts declares engineVersion as an optional string
  ---
  duration_ms: 0.061458
  type: 'test'
  ...
# Subtest: §4.10 THE INVARIANT: updateOpdAudit keys engine_version in WHERE and never SETs it
ok 702 - §4.10 THE INVARIANT: updateOpdAudit keys engine_version in WHERE and never SETs it
  ---
  duration_ms: 0.098125
  type: 'test'
  ...
# Subtest: the re-score path is an UPDATE, never an INSERT — no second row, no double counting
ok 703 - the re-score path is an UPDATE, never an INSERT — no second row, no double counting
  ---
  duration_ms: 0.057708
  type: 'test'
  ...
# Subtest: the doctor read really has no per-uid dedup — which is WHY the invariant matters
ok 704 - the doctor read really has no per-uid dedup — which is WHY the invariant matters
  ---
  duration_ms: 0.203959
  type: 'test'
  ...
# Subtest: §4.9: ?engine= defaults to OPD_ENGINE_VERSION when absent
ok 705 - §4.9: ?engine= defaults to OPD_ENGINE_VERSION when absent
  ---
  duration_ms: 0.0385
  type: 'test'
  ...
# Subtest: the SELECT targets the SOURCE version as a BOUND parameter — unknown ⇒ zero rows, never a throw
ok 706 - the SELECT targets the SOURCE version as a BOUND parameter — unknown ⇒ zero rows, never a throw
  ---
  duration_ms: 0.189
  type: 'test'
  ...
# Subtest: the same version threads into the audit call, so the UPDATE finds its row
ok 707 - the same version threads into the audit call, so the UPDATE finds its row
  ---
  duration_ms: 0.275083
  type: 'test'
  ...
# Subtest: ?apply=1 remains the ONLY write switch — read-only without it
ok 708 - ?apply=1 remains the ONLY write switch — read-only without it
  ---
  duration_ms: 0.058375
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: toKxEnvelope drops ALL PHI — no sentinel value survives anywhere in the output
ok 709 - toKxEnvelope drops ALL PHI — no sentinel value survives anywhere in the output
  ---
  duration_ms: 1.311334
  type: 'test'
  ...
# Subtest: toKxEnvelope is a WHITELIST — output keys are exactly the non-PHI set
ok 710 - toKxEnvelope is a WHITELIST — output keys are exactly the non-PHI set
  ---
  duration_ms: 0.763209
  type: 'test'
  ...
# Subtest: toKxEnvelope keys on any available link-back id, and returns null when there is none
ok 711 - toKxEnvelope keys on any available link-back id, and returns null when there is none
  ---
  duration_ms: 0.227791
  type: 'test'
  ...
# Subtest: the mapper never spreads the header (a structural guard against future PHI fields)
ok 712 - the mapper never spreads the header (a structural guard against future PHI fields)
  ---
  duration_ms: 0.539458
  type: 'test'
  ...
# Subtest: persist is BEST-EFFORT: never throws, and runs AFTER the audit is saved
ok 713 - persist is BEST-EFFORT: never throws, and runs AFTER the audit is saved
  ---
  duration_ms: 0.63525
  type: 'test'
  ...
# Subtest: the store is idempotent + de-identified (UPSERT on document_id+version, no PHI columns)
ok 714 - the store is idempotent + de-identified (UPSERT on document_id+version, no PHI columns)
  ---
  duration_ms: 0.402792
  type: 'test'
  ...
# Subtest: EpisodeState stays STANDALONE — the namespace never imports ipd-audit
ok 715 - EpisodeState stays STANDALONE — the namespace never imports ipd-audit
  ---
  duration_ms: 0.5165
  type: 'test'
  ...
# Subtest: (timeline reuse) admission events become TimelineItem[] ordered by mergeTimeline (discharge first)
ok 716 - (timeline reuse) admission events become TimelineItem[] ordered by mergeTimeline (discharge first)
  ---
  duration_ms: 6.885709
  type: 'test'
  ...
# Subtest: (timeline reuse) no admission dates ⇒ no timeline rows (undated facts are not forced onto it)
ok 717 - (timeline reuse) no admission dates ⇒ no timeline rows (undated facts are not forced onto it)
  ---
  duration_ms: 0.342709
  type: 'test'
  ...
# Subtest: (facts-only) the render introduces no band/CVI/scored/predicted field or palette
ok 718 - (facts-only) the render introduces no band/CVI/scored/predicted field or palette
  ---
  duration_ms: 0.254125
  type: 'test'
  ...
# Subtest: (read-only) the store read is a SELECT; the page renders it best-effort
ok 719 - (read-only) the store read is a SELECT; the page renders it best-effort
  ---
  duration_ms: 0.212208
  type: 'test'
  ...
# Subtest: projectOpdLinkage is a WHITELIST — no PHI value survives; only ICD/drug/date reach the facts
ok 720 - projectOpdLinkage is a WHITELIST — no PHI value survives; only ICD/drug/date reach the facts
  ---
  duration_ms: 1.222584
  type: 'test'
  ...
# Subtest: the projector never reads a PHI field name (structural guard against a future column)
ok 721 - the projector never reads a PHI field name (structural guard against a future column)
  ---
  duration_ms: 0.237166
  type: 'test'
  ...
# Subtest: the builder fills pre/post from the OPD linkage — reported facts, no fabrication
ok 722 - the builder fills pre/post from the OPD linkage — reported facts, no fabrication
  ---
  duration_ms: 3.396417
  type: 'test'
  ...
# Subtest: the unlinked tail is graceful — null/empty OPD linkage ⇒ empty pre/post, never an error
ok 723 - the unlinked tail is graceful — null/empty OPD linkage ⇒ empty pre/post, never an error
  ---
  duration_ms: 0.294
  type: 'test'
  ...
# Subtest: the committed recon gold is frozen, ratified, and hash-pinned
ok 724 - the committed recon gold is frozen, ratified, and hash-pinned
  ---
  duration_ms: 0.769875
  type: 'test'
  ...
# Subtest: the gold carries V's genuine verdicts: all 70 faithful, NO negative examples (CC test posts excluded)
ok 725 - the gold carries V's genuine verdicts: all 70 faithful, NO negative examples (CC test posts excluded)
  ---
  duration_ms: 0.546125
  type: 'test'
  ...
# Subtest: the gold spans strata (speciality + linked/intra-only)
ok 726 - the gold spans strata (speciality + linked/intra-only)
  ---
  duration_ms: 0.120833
  type: 'test'
  ...
# Subtest: the recon gold is de-identified: no UHID / phone / honorific-name / URL anywhere
ok 727 - the recon gold is de-identified: no UHID / phone / honorific-name / URL anywhere
  ---
  duration_ms: 0.331917
  type: 'test'
  ...
# Subtest: loadEpisodeReconGold rejects drift: edited verdict, wrong version/status/validator, dup id, bad verdict/phase
ok 728 - loadEpisodeReconGold rejects drift: edited verdict, wrong version/status/validator, dup id, bad verdict/phase
  ---
  duration_ms: 0.429459
  type: 'test'
  ...
# Subtest: (1) SEPARATION: ratings go to episode_recon_ratings, never the other adjudication stores
ok 729 - (1) SEPARATION: ratings go to episode_recon_ratings, never the other adjudication stores
  ---
  duration_ms: 0.612375
  type: 'test'
  ...
# Subtest: (2) VOCABULARY: exactly the four fidelity verdicts and three phases
ok 730 - (2) VOCABULARY: exactly the four fidelity verdicts and three phases
  ---
  duration_ms: 0.506916
  type: 'test'
  ...
# Subtest: (3) READ-ONLY: the queue reads the persisted episode, never re-builds/re-extracts
ok 731 - (3) READ-ONLY: the queue reads the persisted episode, never re-builds/re-extracts
  ---
  duration_ms: 0.258208
  type: 'test'
  ...
# Subtest: (4) DE-IDENTIFIED: the store has no PHI/URL column; the PDF is read-time only
ok 732 - (4) DE-IDENTIFIED: the store has no PHI/URL column; the PDF is read-time only
  ---
  duration_ms: 0.278292
  type: 'test'
  ...
# Subtest: (1) SCHEMA: the built object validates as the current version; pre/post empty without OPD
ok 733 - (1) SCHEMA: the built object validates as the current version; pre/post empty without OPD
  ---
  duration_ms: 2.506917
  type: 'test'
  ...
# Subtest: (2) NO FABRICATION: every emitted fact traces to a verbatim substring of its source
ok 734 - (2) NO FABRICATION: every emitted fact traces to a verbatim substring of its source
  ---
  duration_ms: 0.256084
  type: 'test'
  ...
# Subtest: (2b) NO FABRICATION: a fact whose rawText is NOT in its source is DROPPED, never invented
ok 735 - (2b) NO FABRICATION: a fact whose rawText is NOT in its source is DROPPED, never invented
  ---
  duration_ms: 0.204375
  type: 'test'
  ...
# Subtest: (3) DETERMINISM: identical inputs give byte-identical output
ok 736 - (3) DETERMINISM: identical inputs give byte-identical output
  ---
  duration_ms: 0.113667
  type: 'test'
  ...
# Subtest: (4) FACTS-ONLY + DE-IDENTIFIED: no score/prediction field, no PHI, no URL anywhere
ok 737 - (4) FACTS-ONLY + DE-IDENTIFIED: no score/prediction field, no PHI, no URL anywhere
  ---
  duration_ms: 0.137167
  type: 'test'
  ...
# Subtest: the schema source itself carries no score/prediction vocabulary (facts-only by construction)
ok 738 - the schema source itself carries no score/prediction vocabulary (facts-only by construction)
  ---
  duration_ms: 0.292166
  type: 'test'
  ...
# Subtest: counts helper reflects the populated intra + empty pre/post
ok 739 - counts helper reflects the populated intra + empty pre/post
  ---
  duration_ms: 0.096625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: error_type reads the response body error taxonomy — type beats code beats metadata
ok 740 - error_type reads the response body error taxonomy — type beats code beats metadata
  ---
  duration_ms: 0.636708
  type: 'test'
  ...
# Subtest: error_type is null when absent, and envelope capture is still TOTAL on junk
ok 741 - error_type is null when absent, and envelope capture is still TOTAL on junk
  ---
  duration_ms: 0.205458
  type: 'test'
  ...
# Subtest: withEnvelope attaches both envelope and error_type; null-safe
ok 742 - withEnvelope attaches both envelope and error_type; null-safe
  ---
  duration_ms: 0.082083
  type: 'test'
  ...
# Subtest: 3× EMPTY CONTENT: the final throw carries the last real envelope, not a truncated string
ok 743 - 3× EMPTY CONTENT: the final throw carries the last real envelope, not a truncated string
  ---
  duration_ms: 19.301083
  type: 'test'
  ...
# Subtest: non-retryable HTTP: the envelope is read FROM THE ERROR BODY, taxonomy included
ok 744 - non-retryable HTTP: the envelope is read FROM THE ERROR BODY, taxonomy included
  ---
  duration_ms: 0.306292
  type: 'test'
  ...
# Subtest: 3× transport failure: envelope attached (empty is honest — nothing came off the wire)
ok 745 - 3× transport failure: envelope attached (empty is honest — nothing came off the wire)
  ---
  duration_ms: 0.305708
  type: 'test'
  ...
# Subtest: deadline throws carry the envelope too — the tombstone must never lose the R2 evidence
ok 746 - deadline throws carry the envelope too — the tombstone must never lose the R2 evidence
  ---
  duration_ms: 0.344125
  type: 'test'
  ...
# Subtest: the success path is untouched — no envelope property on a returned string
ok 747 - the success path is untouched — no envelope property on a returned string
  ---
  duration_ms: 0.32375
  type: 'test'
  ...
# Subtest: the guard messages are EXACTLY the §4 normative strings
ok 748 - the guard messages are EXACTLY the §4 normative strings
  ---
  duration_ms: 0.196167
  type: 'test'
  ...
# Subtest: the guards sit at the CALL SITE, gated on opts.evalModel, in the §4 order
ok 749 - the guards sit at the CALL SITE, gated on opts.evalModel, in the §4 order
  ---
  duration_ms: 0.348708
  type: 'test'
  ...
# Subtest: PRODUCTION IS BYTE-IDENTICAL: evalModel absent keeps the lenient parse exactly
ok 750 - PRODUCTION IS BYTE-IDENTICAL: evalModel absent keeps the lenient parse exactly
  ---
  duration_ms: 0.180916
  type: 'test'
  ...
# Subtest: parseAttemptsState: absent, malformed, or another experiment ⇒ EMPTY, never an error
ok 751 - parseAttemptsState: absent, malformed, or another experiment ⇒ EMPTY, never an error
  ---
  duration_ms: 0.44725
  type: 'test'
  ...
# Subtest: parseAttemptsState round-trips a real map and sanitises junk counters
ok 752 - parseAttemptsState round-trips a real map and sanitises junk counters
  ---
  duration_ms: 0.123208
  type: 'test'
  ...
# Subtest: THE D4 RULE: a deadline abandonment increments deadline_abandons and NEVER failures
ok 753 - THE D4 RULE: a deadline abandonment increments deadline_abandons and NEVER failures
  ---
  duration_ms: 0.127
  type: 'test'
  ...
# Subtest: terminal failures budget to the tombstone at exactly 3, evidence carried
ok 754 - terminal failures budget to the tombstone at exactly 3, evidence carried
  ---
  duration_ms: 0.067791
  type: 'test'
  ...
# Subtest: mixed history: abandons interleaved with failures — only the failures count
ok 755 - mixed history: abandons interleaved with failures — only the failures count
  ---
  duration_ms: 0.10775
  type: 'test'
  ...
# Subtest: the budget is PAID-BRANCH ONLY and its read degrades to empty, never throws
ok 756 - the budget is PAID-BRANCH ONLY and its read degrades to empty, never throws
  ---
  duration_ms: 0.073958
  type: 'test'
  ...
# Subtest: doneUids has NO kind filter — a tombstone row makes the uid done, so the batch can finish
ok 757 - doneUids has NO kind filter — a tombstone row makes the uid done, so the batch can finish
  ---
  duration_ms: 0.035917
  type: 'test'
  ...
# Subtest: the tombstone is written INSTEAD of attempting, with the D5 payload, kind eval_failed
ok 758 - the tombstone is written INSTEAD of attempting, with the D5 payload, kind eval_failed
  ---
  duration_ms: 0.057791
  type: 'test'
  ...
# Subtest: the summary gains tombstoned + failed_uids, inside the eval-only spread
ok 759 - the summary gains tombstoned + failed_uids, inside the eval-only spread
  ---
  duration_ms: 0.0425
  type: 'test'
  ...
# Subtest: lab-batch-core is untouched: constants, drainPlan, locks all stand
ok 760 - lab-batch-core is untouched: constants, drainPlan, locks all stand
  ---
  duration_ms: 0.052458
  type: 'test'
  ...
# Subtest: the attempts key is the documented name and OPENROUTER_TIMEOUT_MS did not move
ok 761 - the attempts key is the documented name and OPENROUTER_TIMEOUT_MS did not move
  ---
  duration_ms: 0.111708
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: remainingBudgetMs is pure, floors at 0, and never returns a negative
ok 762 - remainingBudgetMs is pure, floors at 0, and never returns a negative
  ---
  duration_ms: 0.560875
  type: 'test'
  ...
# Subtest: EVAL_TICK_DEADLINE_MS defaults to 240s and is env-overridable
ok 763 - EVAL_TICK_DEADLINE_MS defaults to 240s and is env-overridable
  ---
  duration_ms: 0.10275
  type: 'test'
  ...
# Subtest: the two tuned numbers are consistent: a note can spend its whole retry budget inside a tick
ok 764 - the two tuned numbers are consistent: a note can spend its whole retry budget inside a tick
  ---
  duration_ms: 0.072625
  type: 'test'
  ...
# Subtest: THE FIX: an already-blown deadline throws BEFORE attempt 1 — no fetch, no sleep
ok 765 - THE FIX: an already-blown deadline throws BEFORE attempt 1 — no fetch, no sleep
  ---
  duration_ms: 0.72725
  type: 'test'
  ...
# Subtest: the deadline is checked before EVERY attempt, not just the first
ok 766 - the deadline is checked before EVERY attempt, not just the first
  ---
  duration_ms: 77.887333
  type: 'test'
  ...
# Subtest: a note that FINISHES inside its budget is completely unaffected
ok 767 - a note that FINISHES inside its budget is completely unaffected
  ---
  duration_ms: 5.220292
  type: 'test'
  ...
# Subtest: a backoff that would cross the deadline throws NOW rather than sleeping through it
ok 768 - a backoff that would cross the deadline throws NOW rather than sleeping through it
  ---
  duration_ms: 0.492958
  type: 'test'
  ...
# Subtest: the deadline error carries the LAST envelope — it is the only surviving record
ok 769 - the deadline error carries the LAST envelope — it is the only surviving record
  ---
  duration_ms: 0.337875
  type: 'test'
  ...
# Subtest: with no envelope yet, every field reads null rather than the message failing to build
ok 770 - with no envelope yet, every field reads null rather than the message failing to build
  ---
  duration_ms: 0.166083
  type: 'test'
  ...
# Subtest: the deadline message is EXACTLY the three normative lines
ok 771 - the deadline message is EXACTLY the three normative lines
  ---
  duration_ms: 0.282
  type: 'test'
  ...
# Subtest: the prefix the tick counts on is defined once, beside the builder
ok 772 - the prefix the tick counts on is defined once, beside the builder
  ---
  duration_ms: 0.069291
  type: 'test'
  ...
# Subtest: a deadline hit is NOT confused with the empty-content failure — they are different faults
ok 773 - a deadline hit is NOT confused with the empty-content failure — they are different faults
  ---
  duration_ms: 0.630542
  type: 'test'
  ...
# Subtest: the AbortController timeout is clamped to the remaining budget when a deadline is present
ok 774 - the AbortController timeout is clamped to the remaining budget when a deadline is present
  ---
  duration_ms: 0.157042
  type: 'test'
  ...
# Subtest: the clamped timeout is REPORTED in the timeout message, so the log is truthful
ok 775 - the clamped timeout is REPORTED in the timeout message, so the log is truthful
  ---
  duration_ms: 52.327084
  type: 'test'
  ...
# Subtest: THE SAFETY PROPERTY: with deadlineAt absent, nothing about the retry loop changes
ok 776 - THE SAFETY PROPERTY: with deadlineAt absent, nothing about the retry loop changes
  ---
  duration_ms: 4.394375
  type: 'test'
  ...
# Subtest: deadlineAt is APPENDED — every existing positional call site still binds correctly
ok 777 - deadlineAt is APPENDED — every existing positional call site still binds correctly
  ---
  duration_ms: 1.028167
  type: 'test'
  ...
# Subtest: auditOpdNote threads opts.deadlineAt and nothing else changed on the call
ok 778 - auditOpdNote threads opts.deadlineAt and nothing else changed on the call
  ---
  duration_ms: 0.366958
  type: 'test'
  ...
# Subtest: batchTick computes the deadline ONCE, from tickStart, and only in eval mode
ok 779 - batchTick computes the deadline ONCE, from tickStart, and only in eval mode
  ---
  duration_ms: 0.460792
  type: 'test'
  ...
# Subtest: THE MINI BRANCH IS BYTE-IDENTICAL — it never receives a deadline
ok 780 - THE MINI BRANCH IS BYTE-IDENTICAL — it never receives a deadline
  ---
  duration_ms: 0.204166
  type: 'test'
  ...
# Subtest: D3: the bounded pool is AWAITED, never raced — racing recreates the bed1449 duplicate rows
ok 781 - D3: the bounded pool is AWAITED, never raced — racing recreates the bed1449 duplicate rows
  ---
  duration_ms: 0.1345
  type: 'test'
  ...
# Subtest: deadline_hits counts deadline errors and nothing else
ok 782 - deadline_hits counts deadline errors and nothing else
  ---
  duration_ms: 0.15825
  type: 'test'
  ...
# Subtest: drainPlan, labLockHeld, ttlBreach and LB_LOCK_TTL_MS are untouched
ok 783 - drainPlan, labLockHeld, ttlBreach and LB_LOCK_TTL_MS are untouched
  ---
  duration_ms: 0.301416
  type: 'test'
  ...
# Subtest: the eval deadline never reaches a production audit path
ok 784 - the eval deadline never reaches a production audit path
  ---
  duration_ms: 1.606875
  type: 'test'
  ...
# Subtest: normalizeConceptSubject is byte-identical to the house normalizeSubject
ok 785 - normalizeConceptSubject is byte-identical to the house normalizeSubject
  ---
  duration_ms: 0.678542
  type: 'test'
  ...
# Subtest: normalizeSlot strips inner colons so a slot can never inject an extra id segment
ok 786 - normalizeSlot strips inner colons so a slot can never inject an extra id segment
  ---
  duration_ms: 0.108542
  type: 'test'
  ...
# Subtest: composeConceptId builds direction:action:target and refuses a bad direction or blank action
ok 787 - composeConceptId builds direction:action:target and refuses a bad direction or blank action
  ---
  duration_ms: 0.090916
  type: 'test'
  ...
# Subtest: §3.1 sentinel: an empty target composes to :regimen with a valid direction + action
ok 788 - §3.1 sentinel: an empty target composes to :regimen with a valid direction + action
  ---
  duration_ms: 0.079125
  type: 'test'
  ...
# Subtest: §3.1 the named case: overuse:polypharmacy: ⇒ overuse:polypharmacy:regimen
ok 789 - §3.1 the named case: overuse:polypharmacy: ⇒ overuse:polypharmacy:regimen
  ---
  duration_ms: 0.045083
  type: 'test'
  ...
# Subtest: §3.1 the sentinel is NOT a catch-all: exclude_test_note is still rejected, never routed to it
ok 790 - §3.1 the sentinel is NOT a catch-all: exclude_test_note is still rejected, never routed to it
  ---
  duration_ms: 0.157041
  type: 'test'
  ...
# Subtest: §3.1 the sentinel is NOT a catch-all: an out-of-vocabulary direction is still rejected
ok 791 - §3.1 the sentinel is NOT a catch-all: an out-of-vocabulary direction is still rejected
  ---
  duration_ms: 0.106709
  type: 'test'
  ...
# Subtest: §3.1 the sentinel recovers ONLY an empty target — a blank ACTION is still a reject
ok 792 - §3.1 the sentinel recovers ONLY an empty target — a blank ACTION is still a reject
  ---
  duration_ms: 0.048667
  type: 'test'
  ...
# Subtest: §3.1 an extraction with an empty target validates to the sentinel, slots and id agreeing
ok 793 - §3.1 an extraction with an empty target validates to the sentinel, slots and id agreeing
  ---
  duration_ms: 0.227208
  type: 'test'
  ...
# Subtest: §3.1 review_lane computes normally for a sentinel concept
ok 794 - §3.1 review_lane computes normally for a sentinel concept
  ---
  duration_ms: 0.396333
  type: 'test'
  ...
# Subtest: baseConceptId folds a context-qualified id onto its base
ok 795 - baseConceptId folds a context-qualified id onto its base
  ---
  duration_ms: 0.051583
  type: 'test'
  ...
# Subtest: the direction vocabulary is closed to exactly the four structural values
ok 796 - the direction vocabulary is closed to exactly the four structural values
  ---
  duration_ms: 0.330333
  type: 'test'
  ...
# Subtest: §7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime
ok 797 - §7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime
  ---
  duration_ms: 0.154167
  type: 'test'
  ...
# Subtest: §7 stage order: the collapse rule runs AFTER formulary resolution
ok 798 - §7 stage order: the collapse rule runs AFTER formulary resolution
  ---
  duration_ms: 0.048958
  type: 'test'
  ...
# Subtest: a resolver that throws never loses the literal target
ok 799 - a resolver that throws never loses the literal target
  ---
  duration_ms: 0.044959
  type: 'test'
  ...
# Subtest: §9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing
ok 800 - §9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing
  ---
  duration_ms: 0.123625
  type: 'test'
  ...
# Subtest: §9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)
ok 801 - §9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)
  ---
  duration_ms: 0.034583
  type: 'test'
  ...
# Subtest: review_lane is a deterministic threshold on the context-free VOLUME share
ok 802 - review_lane is a deterministic threshold on the context-free VOLUME share
  ---
  duration_ms: 0.037375
  type: 'test'
  ...
# Subtest: §9: a valid extraction composes; context is optional and normalised
ok 803 - §9: a valid extraction composes; context is optional and normalised
  ---
  duration_ms: 0.058584
  type: 'test'
  ...
# Subtest: §9: unparseable extraction ⇒ reject, no stamp
ok 804 - §9: unparseable extraction ⇒ reject, no stamp
  ---
  duration_ms: 0.073959
  type: 'test'
  ...
# Subtest: §9: a direction outside the closed vocabulary is rejected, never coerced
ok 805 - §9: a direction outside the closed vocabulary is rejected, never coerced
  ---
  duration_ms: 0.034459
  type: 'test'
  ...
# Subtest: a missing ACTION is a reject, not a partial stamp; a missing TARGET takes the §3.1 sentinel
ok 806 - a missing ACTION is a reject, not a partial stamp; a missing TARGET takes the §3.1 sentinel
  ---
  duration_ms: 0.041791
  type: 'test'
  ...
# Subtest: a ```json fence is tolerated; nothing else is repaired
ok 807 - a ```json fence is tolerated; nothing else is repaired
  ---
  duration_ms: 0.0395
  type: 'test'
  ...
# Subtest: §9 exact-lookup hit stamps the seeded concept with ZERO model calls
ok 808 - §9 exact-lookup hit stamps the seeded concept with ZERO model calls
  ---
  duration_ms: 0.098125
  type: 'test'
  ...
# Subtest: a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)
ok 809 - a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)
  ---
  duration_ms: 0.038709
  type: 'test'
  ...
# Subtest: an already-coded finding is never re-stamped (a string is extracted once, ever)
ok 810 - an already-coded finding is never re-stamped (a string is extracted once, ever)
  ---
  duration_ms: 0.033417
  type: 'test'
  ...
# Subtest: only low-value, non-informational findings are codable
ok 811 - only low-value, non-informational findings are codable
  ---
  duration_ms: 0.103958
  type: 'test'
  ...
# Subtest: a throwing lookup never throws out of stampConcepts
ok 812 - a throwing lookup never throws out of stampConcepts
  ---
  duration_ms: 0.046917
  type: 'test'
  ...
# Subtest: pendingSubjects dedupes, skips coded/uncodable, and honours the known-set
ok 813 - pendingSubjects dedupes, skips coded/uncodable, and honours the known-set
  ---
  duration_ms: 0.082959
  type: 'test'
  ...
# Subtest: §9 cache miss → extract once → cached; a repeated string makes NO second call
ok 814 - §9 cache miss → extract once → cached; a repeated string makes NO second call
  ---
  duration_ms: 0.211417
  type: 'test'
  ...
# Subtest: CONCEPT_CRON_MIN matches the schedule in vercel.json (the panel renders this number)
ok 815 - CONCEPT_CRON_MIN matches the schedule in vercel.json (the panel renders this number)
  ---
  duration_ms: 0.583125
  type: 'test'
  ...
# Subtest: deriveConceptState: disabled outranks paused outranks pending work
ok 816 - deriveConceptState: disabled outranks paused outranks pending work
  ---
  duration_ms: 0.158042
  type: 'test'
  ...
# Subtest: codedPct is a clamped percentage, null when the denominator is unknown or zero
ok 817 - codedPct is a clamped percentage, null when the denominator is unknown or zero
  ---
  duration_ms: 0.674334
  type: 'test'
  ...
# Subtest: cacheHitPct is the share of stamps needing no model call; null before anything is stamped
ok 818 - cacheHitPct is the share of stamps needing no model call; null before anything is stamped
  ---
  duration_ms: 0.23325
  type: 'test'
  ...
# Subtest: rejectedRecent sums across ticks and is 0 (never null) so the tile always renders a number
ok 819 - rejectedRecent sums across ticks and is 0 (never null) so the tile always renders a number
  ---
  duration_ms: 0.132791
  type: 'test'
  ...
# Subtest: buildConceptStatus shapes the payload and carries all four per-tick counts through
ok 820 - buildConceptStatus shapes the payload and carries all four per-tick counts through
  ---
  duration_ms: 0.233416
  type: 'test'
  ...
# Subtest: ZERO-STATE renders honestly: seed loaded, no ticks, nothing stamped
ok 821 - ZERO-STATE renders honestly: seed loaded, no ticks, nothing stamped
  ---
  duration_ms: 0.149709
  type: 'test'
  ...
# Subtest: a fully-degraded payload (every aggregate null) still shapes without throwing
ok 822 - a fully-degraded payload (every aggregate null) still shapes without throwing
  ---
  duration_ms: 0.103166
  type: 'test'
  ...
# Subtest: the disabled state is reachable and keeps its counts (the panel explains itself)
ok 823 - the disabled state is reachable and keeps its counts (the panel explains itself)
  ---
  duration_ms: 0.095875
  type: 'test'
  ...
# Subtest: §9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence
ok 824 - §9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence
  ---
  duration_ms: 13.495292
  type: 'test'
  ...
# Subtest: §3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else
ok 825 - §3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else
  ---
  duration_ms: 0.309125
  type: 'test'
  ...
# Subtest: findingKey is deterministic + stable across normalized subject variants; distinct on real change
ok 826 - findingKey is deterministic + stable across normalized subject variants; distinct on real change
  ---
  duration_ms: 0.764708
  type: 'test'
  ...
# Subtest: subjectHash is subject-sensitive (cache miss on a re-worded finding)
ok 827 - subjectHash is subject-sensitive (cache miss on a re-worded finding)
  ---
  duration_ms: 0.129917
  type: 'test'
  ...
# Subtest: isNoteStale: no watermark OR watermark < epoch ⇒ stale
ok 828 - isNoteStale: no watermark OR watermark < epoch ⇒ stale
  ---
  duration_ms: 0.0595
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations drops retired even-lvc citations, renumbers refs, keeps CW/guideline/other intact
ok 829 - stripRetiredEvenCitations drops retired even-lvc citations, renumbers refs, keeps CW/guideline/other intact
  ---
  duration_ms: 0.47575
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations is a byte-identical no-op when nothing is retired / no retired source present
ok 830 - stripRetiredEvenCitations is a byte-identical no-op when nothing is retired / no retired source present
  ---
  duration_ms: 0.064
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations never touches non-even citations even if their id collides numerically
ok 831 - stripRetiredEvenCitations never touches non-even citations even if their id collides numerically
  ---
  duration_ms: 0.101291
  type: 'test'
  ...
# Subtest: deriveGroundState precedence: disabled > paused > draining > idle
ok 832 - deriveGroundState precedence: disabled > paused > draining > idle
  ---
  duration_ms: 0.059666
  type: 'test'
  ...
# Subtest: drainPct + drainEtaMinutes
ok 833 - drainPct + drainEtaMinutes
  ---
  duration_ms: 0.063459
  type: 'test'
  ...
# Subtest: buildGroundStatus shapes the payload + derives state/drain_pct
ok 834 - buildGroundStatus shapes the payload + derives state/drain_pct
  ---
  duration_ms: 0.178542
  type: 'test'
  ...
# Subtest: formatAgo: seconds / minutes / hours / days; UTC-assumed; malformed ⇒ —
ok 835 - formatAgo: seconds / minutes / hours / days; UTC-assumed; malformed ⇒ —
  ---
  duration_ms: 0.359042
  type: 'test'
  ...
# Subtest: nextTickInSec: (0, everyMin*60]; wraps at the boundary
ok 836 - nextTickInSec: (0, everyMin*60]; wraps at the boundary
  ---
  duration_ms: 0.104458
  type: 'test'
  ...
# Subtest: score-invariance: stripRetiredEvenCitations preserves every non-citation finding field
ok 837 - score-invariance: stripRetiredEvenCitations preserves every non-citation finding field
  ---
  duration_ms: 0.075333
  type: 'test'
  ...
# Subtest: buildDigest qualifies at the CATEGORY grain (≥ CAT_MIN total), drops singletons, emits ONLY {subject,count} + total
ok 838 - buildDigest qualifies at the CATEGORY grain (≥ CAT_MIN total), drops singletons, emits ONLY {subject,count} + total
  ---
  duration_ms: 1.399792
  type: 'test'
  ...
# Subtest: buildDigest: a FRAGMENTED category qualifies on TOTAL even when no single subject hits the old ≥20 floor (§1.1 core fix)
ok 839 - buildDigest: a FRAGMENTED category qualifies on TOTAL even when no single subject hits the old ≥20 floor (§1.1 core fix)
  ---
  duration_ms: 10.719542
  type: 'test'
  ...
# Subtest: buildDigest: topK truncates to the highest-count exemplars
ok 840 - buildDigest: topK truncates to the highest-count exemplars
  ---
  duration_ms: 0.115208
  type: 'test'
  ...
# Subtest: normalizeSubject collapses casing/whitespace/trailing period
ok 841 - normalizeSubject collapses casing/whitespace/trailing period
  ---
  duration_ms: 0.105583
  type: 'test'
  ...
# Subtest: isDuplicateCandidate drops same-category text-eq / cosine≥0.90, incl. against rejected; keeps cross-category
ok 842 - isDuplicateCandidate drops same-category text-eq / cosine≥0.90, incl. against rejected; keeps cross-category
  ---
  duration_ms: 0.195708
  type: 'test'
  ...
# Subtest: dedupeCandidates removes intra-batch dupes and caps
ok 843 - dedupeCandidates removes intra-batch dupes and caps
  ---
  duration_ms: 0.178958
  type: 'test'
  ...
# Subtest: rollupContests counts per assertion and flips ONLY active→contested at ≥ flag; never auto-retires
ok 844 - rollupContests counts per assertion and flips ONLY active→contested at ≥ flag; never auto-retires
  ---
  duration_ms: 0.202291
  type: 'test'
  ...
# Subtest: computeOwnCases true only when ratifier name is among the supporting doctor_uids
ok 845 - computeOwnCases true only when ratifier name is among the supporting doctor_uids
  ---
  duration_ms: 0.060042
  type: 'test'
  ...
# Subtest: id-ordinal: elv-<category>-<padded>, per-category, monotone; batch ids do not collide
ok 846 - id-ordinal: elv-<category>-<padded>, per-category, monotone; batch ids do not collide
  ---
  duration_ms: 4.448791
  type: 'test'
  ...
# Subtest: parseCandidatesJson: tolerant of fences/prose/object-wrap; drops malformed + hallucinated categories
ok 847 - parseCandidatesJson: tolerant of fences/prose/object-wrap; drops malformed + hallucinated categories
  ---
  duration_ms: 0.569375
  type: 'test'
  ...
# Subtest: evenGenUserMessage only references shown categories/subjects + surfaces the category total (§1.1)
ok 848 - evenGenUserMessage only references shown categories/subjects + surfaces the category total (§1.1)
  ---
  duration_ms: 0.137041
  type: 'test'
  ...
# Subtest: isRunStale: a fresh run is not stale; a >10-min run is; a malformed timestamp is safe-false (§1.2)
ok 849 - isRunStale: a fresh run is not stale; a >10-min run is; a malformed timestamp is safe-false (§1.2)
  ---
  duration_ms: 0.074917
  type: 'test'
  ...
# Subtest: evenChunkSection / normalizeAssertionText helpers
ok 850 - evenChunkSection / normalizeAssertionText helpers
  ---
  duration_ms: 0.050667
  type: 'test'
  ...
# Subtest: §4.2 every read of opd_audit_feedback is study-filtered — three D12-allowlisted, commented
ok 851 - §4.2 every read of opd_audit_feedback is study-filtered — three D12-allowlisted, commented
  ---
  duration_ms: 168.003833
  type: 'test'
  ...
# Subtest: §4.2 the write paths: main INSERT names study; assertion_contest and doctor-response never set it
ok 852 - §4.2 the write paths: main INSERT names study; assertion_contest and doctor-response never set it
  ---
  duration_ms: 0.225625
  type: 'test'
  ...
# Subtest: 8.3 the predicate is parameterised IS NOT DISTINCT FROM — never = or a hardcoded IS NULL
ok 853 - 8.3 the predicate is parameterised IS NOT DISTINCT FROM — never = or a hardcoded IS NULL
  ---
  duration_ms: 0.469417
  type: 'test'
  ...
# Subtest: buildFindingAuthorCurrentSql: DISTINCT ON (audit_id, finding_ref, author), order leads with the same three
ok 854 - buildFindingAuthorCurrentSql: DISTINCT ON (audit_id, finding_ref, author), order leads with the same three
  ---
  duration_ms: 0.181625
  type: 'test'
  ...
# Subtest: §8.5 rollup finding builder: study absent ⇒ SAME SQL text, param NULL — NULL matches NULL
ok 855 - §8.5 rollup finding builder: study absent ⇒ SAME SQL text, param NULL — NULL matches NULL
  ---
  duration_ms: 0.394125
  type: 'test'
  ...
# Subtest: §8.5 parseFeedbackBody: study absent ⇒ behaviour identical, study null; D8 author rule enforced
ok 856 - §8.5 parseFeedbackBody: study absent ⇒ behaviour identical, study null; D8 author rule enforced
  ---
  duration_ms: 0.252667
  type: 'test'
  ...
# Subtest: jaccard basics + empty-set guard
ok 857 - jaccard basics + empty-set guard
  ---
  duration_ms: 1.199625
  type: 'test'
  ...
# Subtest: exact finding_ref match when both stamped — regardless of subject
ok 858 - exact finding_ref match when both stamped — regardless of subject
  ---
  duration_ms: 0.376375
  type: 'test'
  ...
# Subtest: fuzzy match needs signal_type equality AND Jaccard ≥ threshold
ok 859 - fuzzy match needs signal_type equality AND Jaccard ≥ threshold
  ---
  duration_ms: 0.420125
  type: 'test'
  ...
# Subtest: tie-break prefers the domain-equal student at equal Jaccard
ok 860 - tie-break prefers the domain-equal student at equal Jaccard
  ---
  duration_ms: 0.169292
  type: 'test'
  ...
# Subtest: disagreementsOf classifies tier-differs / teacher-only / student-only with reasons
ok 861 - disagreementsOf classifies tier-differs / teacher-only / student-only with reasons
  ---
  duration_ms: 0.86075
  type: 'test'
  ...
# Subtest: agreeing matched pairs are NOT disagreements
ok 862 - agreeing matched pairs are NOT disagreements
  ---
  duration_ms: 0.13475
  type: 'test'
  ...
# Subtest: every measured target resolves to a class containing Antibiotic, with the [0] invariant
ok 863 - every measured target resolves to a class containing Antibiotic, with the [0] invariant
  ---
  duration_ms: 4.431958
  type: 'test'
  ...
# Subtest: the cefpodoxime line: ester + salt variants both resolve — one entry per resolving fragment
ok 864 - the cefpodoxime line: ester + salt variants both resolve — one entry per resolving fragment
  ---
  duration_ms: 0.875958
  type: 'test'
  ...
# Subtest: the three-molecule kit resolves per fragment: Antifungal + Antibiotic (Secnidazole absent from the formulary)
ok 865 - the three-molecule kit resolves per fragment: Antifungal + Antibiotic (Secnidazole absent from the formulary)
  ---
  duration_ms: 0.294292
  type: 'test'
  ...
# Subtest: a bracketed strength group can never split the line
ok 866 - a bracketed strength group can never split the line
  ---
  duration_ms: 0.186083
  type: 'test'
  ...
# Subtest: the four regression lines keep resolving exactly as today
ok 867 - the four regression lines keep resolving exactly as today
  ---
  duration_ms: 0.217375
  type: 'test'
  ...
# Subtest: a line resolving to no class anywhere carries neither field
ok 868 - a line resolving to no class anywhere carries neither field
  ---
  duration_ms: 0.072125
  type: 'test'
  ...
# Subtest: noAntibioticClassOnNote (its own logic UNCHANGED) now sees the cefpodoxime antibiotic
ok 869 - noAntibioticClassOnNote (its own logic UNCHANGED) now sees the cefpodoxime antibiotic
  ---
  duration_ms: 0.303417
  type: 'test'
  ...
# Subtest: this build's bump (0.81.20) stays in the read family, and the engine is current
ok 870 - this build's bump (0.81.20) stays in the read family, and the engine is current
  ---
  duration_ms: 0.059292
  type: 'test'
  ...
# Subtest: normalizeDosageForm: parses raw formulary form (strength/junk stripped) to the coarse vocabulary
ok 871 - normalizeDosageForm: parses raw formulary form (strength/junk stripped) to the coarse vocabulary
  ---
  duration_ms: 1.874708
  type: 'test'
  ...
# Subtest: normalizeDrugName strips dose, form and marketing tail; keeps product-distinguishing suffix
ok 872 - normalizeDrugName strips dose, form and marketing tail; keeps product-distinguishing suffix
  ---
  duration_ms: 0.116792
  type: 'test'
  ...
# Subtest: brand-exact resolves the molecule + class + schedule (confident)
ok 873 - brand-exact resolves the molecule + class + schedule (confident)
  ---
  duration_ms: 0.485125
  type: 'test'
  ...
# Subtest: brand-token resolves an unambiguous brand family with no exact row (Wysolone → Prednisolone)
ok 874 - brand-token resolves an unambiguous brand family with no exact row (Wysolone → Prednisolone)
  ---
  duration_ms: 0.150292
  type: 'test'
  ...
# Subtest: embedded-generic recovers a molecule named verbatim — and NOT a combination canon
ok 875 - embedded-generic recovers a molecule named verbatim — and NOT a combination canon
  ---
  duration_ms: 0.071458
  type: 'test'
  ...
# Subtest: brand-prefix is an APPROX match (not confident) — combo suffix may drop a molecule
ok 876 - brand-prefix is an APPROX match (not confident) — combo suffix may drop a molecule
  ---
  duration_ms: 0.131042
  type: 'test'
  ...
# Subtest: an ambiguous brand family (different canons) does NOT brand-token; exact still wins
ok 877 - an ambiguous brand family (different canons) does NOT brand-token; exact still wins
  ---
  duration_ms: 0.049959
  type: 'test'
  ...
# Subtest: source-generic is trusted as-is (confident)
ok 878 - source-generic is trusted as-is (confident)
  ---
  duration_ms: 0.044292
  type: 'test'
  ...
# Subtest: high-alert + schedule X carried through
ok 879 - high-alert + schedule X carried through
  ---
  duration_ms: 0.208166
  type: 'test'
  ...
# Subtest: unmatched returns null and classifies nutraceutical/cosmetic vs off-formulary
ok 880 - unmatched returns null and classifies nutraceutical/cosmetic vs off-formulary
  ---
  duration_ms: 0.706542
  type: 'test'
  ...
# Subtest: BUG-0.8-15: a single molecule wins its class over a combination that contains it (any array order)
ok 881 - BUG-0.8-15: a single molecule wins its class over a combination that contains it (any array order)
  ---
  duration_ms: 0.183709
  type: 'test'
  ...
# Subtest: flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1
ok 882 - flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1
  ---
  duration_ms: 0.5545
  type: 'test'
  ...
# Subtest: flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined
ok 883 - flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined
  ---
  duration_ms: 0.132125
  type: 'test'
  ...
# Subtest: trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h
ok 884 - trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h
  ---
  duration_ms: 0.148792
  type: 'test'
  ...
# Subtest: trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte
ok 885 - trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte
  ---
  duration_ms: 0.37675
  type: 'test'
  ...
# Subtest: trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST
ok 886 - trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST
  ---
  duration_ms: 0.057458
  type: 'test'
  ...
# Subtest: trap 3: the Vertex thinking budget is TRANSLATED to reasoning.max_tokens, and `google` never travels
ok 887 - trap 3: the Vertex thinking budget is TRANSLATED to reasoning.max_tokens, and `google` never travels
  ---
  duration_ms: 0.052042
  type: 'test'
  ...
# Subtest: trap 3: NO DEFAULT IS INVENTED — no budget in, no reasoning out (byte-identical to before)
ok 888 - trap 3: NO DEFAULT IS INVENTED — no budget in, no reasoning out (byte-identical to before)
  ---
  duration_ms: 0.176584
  type: 'test'
  ...
# Subtest: trap 3: the reader is pure and total — any shape yields a budget or undefined
ok 889 - trap 3: the reader is pure and total — any shape yields a budget or undefined
  ---
  duration_ms: 0.050042
  type: 'test'
  ...
# Subtest: trap 3: an explicit OpenRouter reasoning block WINS — translation never overwrites it
ok 890 - trap 3: an explicit OpenRouter reasoning block WINS — translation never overwrites it
  ---
  duration_ms: 0.192959
  type: 'test'
  ...
# Subtest: trap 3: the VERTEX path is untouched — it still sends the google form and no reasoning block
ok 891 - trap 3: the VERTEX path is untouched — it still sends the google form and no reasoning block
  ---
  duration_ms: 0.321125
  type: 'test'
  ...
# Subtest: the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026
ok 892 - the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026
  ---
  duration_ms: 0.06
  type: 'test'
  ...
# Subtest: both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence
ok 893 - both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence
  ---
  duration_ms: 0.067583
  type: 'test'
  ...
# Subtest: the Ollama last-leg fallback is untouched in both transports
ok 894 - the Ollama last-leg fallback is untouched in both transports
  ---
  duration_ms: 0.08625
  type: 'test'
  ...
# Subtest: T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days
ok 895 - T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days
  ---
  duration_ms: 0.048083
  type: 'test'
  ...
# Subtest: T-5: servedCallFor reads the POST-fallback model from the audit trace, null when unknown
ok 896 - T-5: servedCallFor reads the POST-fallback model from the audit trace, null when unknown
  ---
  duration_ms: 0.046458
  type: 'test'
  ...
# Subtest: changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration
ok 897 - changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration
  ---
  duration_ms: 0.134625
  type: 'test'
  ...
# Subtest: GATE: a cloud row at 0.81.17 beats a qwen row at 0.81.20 — the exact live shape
ok 898 - GATE: a cloud row at 0.81.17 beats a qwen row at 0.81.20 — the exact live shape
  ---
  duration_ms: 0.565292
  type: 'test'
  ...
# Subtest: GATE: two cloud rows at different versions ⇒ the HIGHER version still wins
ok 899 - GATE: two cloud rows at different versions ⇒ the HIGHER version still wins
  ---
  duration_ms: 0.151292
  type: 'test'
  ...
# Subtest: isLocalGrader catches BOTH signals: the qwen model and the -mini suffix
ok 900 - isLocalGrader catches BOTH signals: the qwen model and the -mini suffix
  ---
  duration_ms: 0.070791
  type: 'test'
  ...
# Subtest: the grader tier is a SEPARATE question from REFERENCE_MODELS — neither list is overloaded
ok 901 - the grader tier is a SEPARATE question from REFERENCE_MODELS — neither list is overloaded
  ---
  duration_ms: 0.240625
  type: 'test'
  ...
# Subtest: CANONICAL_RANK_SQL leads with the grader tier, then version, then reference, then audited_at
ok 902 - CANONICAL_RANK_SQL leads with the grader tier, then version, then reference, then audited_at
  ---
  duration_ms: 0.064625
  type: 'test'
  ...
# Subtest: D1: prodTag and the mini_backfill_prod settings keys are DELETED repo-wide
ok 903 - D1: prodTag and the mini_backfill_prod settings keys are DELETED repo-wide
  ---
  duration_ms: 0.456084
  type: 'test'
  ...
# Subtest: the trap comment no longer claims a guard is unnecessary
ok 904 - the trap comment no longer claims a guard is unnecessary
  ---
  duration_ms: 0.142
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: stripEvenNonProse removes base64 blobs and image refs, keeps prose
ok 905 - stripEvenNonProse removes base64 blobs and image refs, keeps prose
  ---
  duration_ms: 0.735625
  type: 'test'
  ...
# Subtest: parseEvenProtocols splits on H1/H2/H3 with group-prefixed section paths + slug anchors
ok 906 - parseEvenProtocols splits on H1/H2/H3 with group-prefixed section paths + slug anchors
  ---
  duration_ms: 0.318375
  type: 'test'
  ...
# Subtest: chunkSections drops < 120-char chunks, stamps guideline type + section anchor
ok 907 - chunkSections drops < 120-char chunks, stamps guideline type + section anchor
  ---
  duration_ms: 7.455584
  type: 'test'
  ...
# Subtest: each built row re-chunks to exactly one piece (per-row insert stays 1:1)
ok 908 - each built row re-chunks to exactly one piece (per-row insert stays 1:1)
  ---
  duration_ms: 0.942167
  type: 'test'
  ...
# Subtest: parseIcmr yields page-anchored sections with detected chapter headings
ok 909 - parseIcmr yields page-anchored sections with detected chapter headings
  ---
  duration_ms: 0.849958
  type: 'test'
  ...
# Subtest: detectIcmrHeading: title/upper headings yes, sentences no
ok 910 - detectIcmrHeading: title/upper headings yes, sentences no
  ---
  duration_ms: 0.420708
  type: 'test'
  ...
# Subtest: slugify → stable kebab anchor fragment
ok 911 - slugify → stable kebab anchor fragment
  ---
  duration_ms: 0.453791
  type: 'test'
  ...
# Subtest: CORPUS_QUARANTINE_INSERT_SQL — item_number is still column $5; F13 provenance appended ONLY
ok 912 - CORPUS_QUARANTINE_INSERT_SQL — item_number is still column $5; F13 provenance appended ONLY
  ---
  duration_ms: 0.143542
  type: 'test'
  ...
# Subtest: the artifact is the full master: version, size, key shape
ok 913 - the artifact is the full master: version, size, key shape
  ---
  duration_ms: 88.328959
  type: 'test'
  ...
# Subtest: PRD spot-checks resolve to real master labels
ok 914 - PRD spot-checks resolve to real master labels
  ---
  duration_ms: 0.38075
  type: 'test'
  ...
# Subtest: override precedence: a code in both layers renders the curated phrasing
ok 915 - override precedence: a code in both layers renders the curated phrasing
  ---
  duration_ms: 0.139583
  type: 'test'
  ...
# Subtest: category fallback is EXACT-KEY only; junk still gets the neutral fallback
ok 916 - category fallback is EXACT-KEY only; junk still gets the neutral fallback
  ---
  duration_ms: 77.21825
  type: 'test'
  ...
# Subtest: Decision-D order unchanged: source display text still wins over every bundled layer
ok 917 - Decision-D order unchanged: source display text still wins over every bundled layer
  ---
  duration_ms: 0.172
  type: 'test'
  ...
# Subtest: slice-2 payload: META carries duration + high-risk in the ratified shape (not consumed yet)
ok 918 - slice-2 payload: META carries duration + high-risk in the ratified shape (not consumed yet)
  ---
  duration_ms: 104.260125
  type: 'test'
  ...
# Subtest: a formulary-resolved combination missing ONLY strength → NO finding
ok 919 - a formulary-resolved combination missing ONLY strength → NO finding
  ---
  duration_ms: 0.936542
  type: 'test'
  ...
# Subtest: a formulary-resolved combination missing strength AND frequency → finding, gaps list frequency ONLY
ok 920 - a formulary-resolved combination missing strength AND frequency → finding, gaps list frequency ONLY
  ---
  duration_ms: 0.633917
  type: 'test'
  ...
# Subtest: a combination with nonFormulary set → finding, strength gap STILL present (DEC-2)
ok 921 - a combination with nonFormulary set → finding, strength gap STILL present (DEC-2)
  ---
  duration_ms: 0.427125
  type: 'test'
  ...
# Subtest: a single-molecule drug missing strength → finding, unchanged
ok 922 - a single-molecule drug missing strength → finding, unchanged
  ---
  duration_ms: 0.206334
  type: 'test'
  ...
# Subtest: the combination exemption needs BOTH conditions — a "+" alone is not enough
ok 923 - the combination exemption needs BOTH conditions — a "+" alone is not enough
  ---
  duration_ms: 0.06425
  type: 'test'
  ...
# Subtest: dosageForm 'topical' missing strength AND route → NO finding
ok 924 - dosageForm 'topical' missing strength AND route → NO finding
  ---
  duration_ms: 0.155458
  type: 'test'
  ...
# Subtest: dosageForm 'topical' missing duration → finding, duration ONLY
ok 925 - dosageForm 'topical' missing duration → finding, duration ONLY
  ---
  duration_ms: 0.061708
  type: 'test'
  ...
# Subtest: dosageForm 'drops' behaves exactly like topical
ok 926 - dosageForm 'drops' behaves exactly like topical
  ---
  duration_ms: 0.062542
  type: 'test'
  ...
# Subtest: dosageForm 'inhaler' and 'injection' are UNCHANGED — strength and route still gap
ok 927 - dosageForm 'inhaler' and 'injection' are UNCHANGED — strength and route still gap
  ---
  duration_ms: 1.082084
  type: 'test'
  ...
# Subtest: the other four DosageForm members are untouched: tablet, capsule, syrup, other
ok 928 - the other four DosageForm members are untouched: tablet, capsule, syrup, other
  ---
  duration_ms: 0.336333
  type: 'test'
  ...
# Subtest: a complete line emits nothing, before and after
ok 929 - a complete line emits nothing, before and after
  ---
  duration_ms: 0.062333
  type: 'test'
  ...
# Subtest: the existing isDoseExempt cases behave exactly as before — wholesale suppression intact
ok 930 - the existing isDoseExempt cases behave exactly as before — wholesale suppression intact
  ---
  duration_ms: 0.123084
  type: 'test'
  ...
# Subtest: the rationale wording is byte-identical — only the gap list inside it changes
ok 931 - the rationale wording is byte-identical — only the gap list inside it changes
  ---
  duration_ms: 0.040458
  type: 'test'
  ...
# Subtest: the emitted rationale still parses for severity-tier-core (the tier keys on this string)
ok 932 - the emitted rationale still parses for severity-tier-core (the tier keys on this string)
  ---
  duration_ms: 0.085917
  type: 'test'
  ...
# Subtest: the four contested subjects produce NO strength gap
ok 933 - the four contested subjects produce NO strength gap
  ---
  duration_ms: 0.069375
  type: 'test'
  ...
# Subtest: …but each of the four still fires when a REAL gap is present (DEC-1)
ok 934 - …but each of the four still fires when a REAL gap is present (DEC-1)
  ---
  duration_ms: 0.090667
  type: 'test'
  ...
# Subtest: a topical combination gets BOTH exemptions and still fires on frequency
ok 935 - a topical combination gets BOTH exemptions and still fires on frequency
  ---
  duration_ms: 0.03675
  type: 'test'
  ...
# Subtest: version constants match the PRD exactly
ok 936 - version constants match the PRD exactly
  ---
  duration_ms: 0.594875
  type: 'test'
  ...
# Subtest: candidate mapping per kind (PRD §5 table) — family and skeleton per kind
ok 937 - candidate mapping per kind (PRD §5 table) — family and skeleton per kind
  ---
  duration_ms: 1.118
  type: 'test'
  ...
# Subtest: baseline buildAskSet asks are also candidates (why baseline, unknownIds [])
ok 938 - baseline buildAskSet asks are also candidates (why baseline, unknownIds [])
  ---
  duration_ms: 0.518667
  type: 'test'
  ...
# Subtest: instability_input / unmappable unknowns produce no candidate and land in dropped
ok 939 - instability_input / unmappable unknowns produce no candidate and land in dropped
  ---
  duration_ms: 0.159
  type: 'test'
  ...
# Subtest: same-id candidates merge (allergy unknown merges into the baseline allergy ask)
ok 940 - same-id candidates merge (allergy unknown merges into the baseline allergy ask)
  ---
  duration_ms: 0.183375
  type: 'test'
  ...
# Subtest: validateSelection (B6 numbers, B7 phrase-all): out-of-range / non-integer n rejected; duplicate rejected; NO pick cap
ok 941 - validateSelection (B6 numbers, B7 phrase-all): out-of-range / non-integer n rejected; duplicate rejected; NO pick cap
  ---
  duration_ms: 0.642833
  type: 'test'
  ...
# Subtest: validateSelection: rewritten family/subject never survive — candidate fields win
ok 942 - validateSelection: rewritten family/subject never survive — candidate fields win
  ---
  duration_ms: 0.095708
  type: 'test'
  ...
# Subtest: validateSelection: over-length and empty questions are rejected
ok 943 - validateSelection: over-length and empty questions are rejected
  ---
  duration_ms: 0.130916
  type: 'test'
  ...
# Subtest: validateSelection: a generic question (no subject token) is replaced by the candidate skeleton
ok 944 - validateSelection: a generic question (no subject token) is replaced by the candidate skeleton
  ---
  duration_ms: 0.23125
  type: 'test'
  ...
# Subtest: assembly: every high-alert MED_STATUS ask is ALWAYS first (ladder rank 0), regardless of picks
ok 945 - assembly: every high-alert MED_STATUS ask is ALWAYS first (ladder rank 0), regardless of picks
  ---
  duration_ms: 0.55125
  type: 'test'
  ...
# Subtest: K2 ladder (B5 ranks): rungs serve in order 0<1<3<4<5<6<7<8 regardless of the pick order fed in
ok 946 - K2 ladder (B5 ranks): rungs serve in order 0<1<3<4<5<6<7<8 regardless of the pick order fed in
  ---
  duration_ms: 0.412541
  type: 'test'
  ...
# Subtest: B5 new-med rung: a med absent from a NON-EMPTY snapshot ranks 2 and leads over a care-gap; empty/absent snapshot stays routine 5
ok 947 - B5 new-med rung: a med absent from a NON-EMPTY snapshot ranks 2 and leads over a care-gap; empty/absent snapshot stays routine 5
  ---
  duration_ms: 13.159625
  type: 'test'
  ...
# Subtest: assembly: total cap stays 5 and the overflow list is preserved
ok 948 - assembly: total cap stays 5 and the overflow list is preserved
  ---
  duration_ms: 0.225334
  type: 'test'
  ...
# Subtest: K2: zero-valid-picks (parsed) is NOT a fallback — ladder assembles with skeleton phrasing, source inquiry
ok 949 - K2: zero-valid-picks (parsed) is NOT a fallback — ladder assembles with skeleton phrasing, source inquiry
  ---
  duration_ms: 0.599125
  type: 'test'
  ...
# Subtest: K2: transport failure retries ONCE, then falls back byte-identical to buildAskSet
ok 950 - K2: transport failure retries ONCE, then falls back byte-identical to buildAskSet
  ---
  duration_ms: 28.062334
  type: 'test'
  ...
# Subtest: runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation
ok 951 - runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation
  ---
  duration_ms: 0.457333
  type: 'test'
  ...
# Subtest: B7 phrase-all: with a phrasing for EVERY candidate, all 5 ladder-served asks carry Gemini phrasing (no skeleton)
ok 952 - B7 phrase-all: with a phrasing for EVERY candidate, all 5 ladder-served asks carry Gemini phrasing (no skeleton)
  ---
  duration_ms: 0.642541
  type: 'test'
  ...
# Subtest: parseSelection tolerates prose around the JSON and rejects malformed shapes
ok 953 - parseSelection tolerates prose around the JSON and rejects malformed shapes
  ---
  duration_ms: 0.077292
  type: 'test'
  ...
# Subtest: B6: parseSelection strips markdown code fences (the live-prod fallback root cause)
ok 954 - B6: parseSelection strips markdown code fences (the live-prod fallback root cause)
  ---
  duration_ms: 0.069291
  type: 'test'
  ...
# Subtest: B6 end-to-end: a fenced, number-based Gemini response serves source inquiry with Gemini phrasing
ok 955 - B6 end-to-end: a fenced, number-based Gemini response serves source inquiry with Gemini phrasing
  ---
  duration_ms: 0.227083
  type: 'test'
  ...
# Subtest: fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)
ok 956 - fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)
  ---
  duration_ms: 0.339125
  type: 'test'
  ...
# Subtest: scorer is deterministic and the metric arithmetic is exact
ok 957 - scorer is deterministic and the metric arithmetic is exact
  ---
  duration_ms: 1.495791
  type: 'test'
  ...
# Subtest: A1 split: family-legality is vocabulary-only; legalSlots23 lands in slotAppropriate, not the gate
ok 958 - A1 split: family-legality is vocabulary-only; legalSlots23 lands in slotAppropriate, not the gate
  ---
  duration_ms: 0.142459
  type: 'test'
  ...
# Subtest: baseline harness runs on the shipped RATIFIED bank (deterministic arm, no LLM)
ok 959 - baseline harness runs on the shipped RATIFIED bank (deterministic arm, no LLM)
  ---
  duration_ms: 46.61125
  type: 'test'
  ...
# Subtest: askset route: INQUIRY_ENABLED unset ⇒ byte-identical deterministic path
ok 960 - askset route: INQUIRY_ENABLED unset ⇒ byte-identical deterministic path
  ---
  duration_ms: 0.481542
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: insert is idempotent on id (ON CONFLICT (id) DO NOTHING) and repeat saves succeed
ok 961 - insert is idempotent on id (ON CONFLICT (id) DO NOTHING) and repeat saves succeed
  ---
  duration_ms: 1.900083
  type: 'test'
  ...
# Subtest: reads soft-fail to empty when the table is missing / DB is down
ok 962 - reads soft-fail to empty when the table is missing / DB is down
  ---
  duration_ms: 0.238583
  type: 'test'
  ...
# Subtest: K1.1: recomputeOutcomes preserves each row's served ask_set_version (ask-set/0.2 survives)
ok 963 - K1.1: recomputeOutcomes preserves each row's served ask_set_version (ask-set/0.2 survives)
  ---
  duration_ms: 14.593334
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order generic
# Subtest: 1a — retrieve: no capture, and two uninstrumented runs are identical statement for statement
ok 964 - 1a — retrieve: no capture, and two uninstrumented runs are identical statement for statement
  ---
  duration_ms: 125.065792
  type: 'test'
  ...
# Subtest: 1a' — and adding a capture to ONE side only leaves the returned value identical
ok 965 - 1a' — and adding a capture to ONE side only leaves the returned value identical
  ---
  duration_ms: 0.7245
  type: 'test'
  ...
# Subtest: 2 — rerank: undefined reaches judgeFn and cohereFn as the third argument, and soft failure returns early
ok 966 - 2 — rerank: undefined reaches judgeFn and cohereFn as the third argument, and soft failure returns early
  ---
  duration_ms: 0.461584
  type: 'test'
  ...
# Subtest: 3 — rerankJudge: identical array and identical request bodies, with and without a capture
ok 967 - 3 — rerankJudge: identical array and identical request bodies, with and without a capture
  ---
  duration_ms: 25.117542
  type: 'test'
  ...
# Subtest: 4 — rerankCohere: the CapturedBatch literal at :162-174 is never constructed
ok 968 - 4 — rerankCohere: the CapturedBatch literal at :162-174 is never constructed
  ---
  duration_ms: 0.8545
  type: 'test'
  ...
# Subtest: 5 — expandQuery: capture.expansion is never set, and here evidenceFromCompletion is INSIDE the guard
ok 969 - 5 — expandQuery: capture.expansion is never set, and here evidenceFromCompletion is INSIDE the guard
  ---
  duration_ms: 4.151083
  type: 'test'
  ...
# Subtest: 6 — retrieveMultiQuery: armCaptures undefined, arms called with undefined, children never set
ok 970 - 6 — retrieveMultiQuery: armCaptures undefined, arms called with undefined, children never set
  ---
  duration_ms: 1.756417
  type: 'test'
  ...
# Subtest: 7 — the MatchInput seam: no telemetry field means no capture, no declaration and no write
ok 971 - 7 — the MatchInput seam: no telemetry field means no capture, no declaration and no write
  ---
  duration_ms: 7.121959
  type: 'test'
  ...
# Subtest: v7 §5 — Vertex is the first target when Gemini is on and the bridge flag is off
ok 972 - v7 §5 — Vertex is the first target when Gemini is on and the bridge flag is off
  ---
  duration_ms: 276.756459
  type: 'test'
  ...
# Subtest: v7 §5 — OpenRouter is the first target when the bridge flag produces a slug
ok 973 - v7 §5 — OpenRouter is the first target when the bridge flag produces a slug
  ---
  duration_ms: 351.937333
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: v7 §5 — Ollama with JUDGE_MODEL when no cloud tier is available, and that pair IS sanctioned
ok 974 - v7 §5 — Ollama with JUDGE_MODEL when no cloud tier is available, and that pair IS sanctioned
  ---
  duration_ms: 96.688875
  type: 'test'
  ...
# Subtest: v7 §5 — LLM_PIPELINE=mini forces local, whatever the Gemini flags say
ok 975 - v7 §5 — LLM_PIPELINE=mini forces local, whatever the Gemini flags say
  ---
  duration_ms: 7.528958
  type: 'test'
  ...
# Subtest: v7 §5 — Gemini flags with NO provider configuration still resolve local, not Vertex
ok 976 - v7 §5 — Gemini flags with NO provider configuration still resolve local, not Vertex
  ---
  duration_ms: 1.963833
  type: 'test'
  ...
# Subtest: v7 §5 — Cohere resolves to OpenRouter with the effective Cohere model
ok 977 - v7 §5 — Cohere resolves to OpenRouter with the effective Cohere model
  ---
  duration_ms: 2.569209
  type: 'test'
  ...
# Subtest: v7 §5 — the guard rejects the exact pair that reached the manifest, and accepts all four sanctioned ones
ok 978 - v7 §5 — the guard rejects the exact pair that reached the manifest, and accepts all four sanctioned ones
  ---
  duration_ms: 8.992292
  type: 'test'
  ...
# Subtest: v7 §5 — EVERY target the resolver can produce is a sanctioned pairing, across the matrix
ok 979 - v7 §5 — EVERY target the resolver can produce is a sanctioned pairing, across the matrix
  ---
  duration_ms: 5.130417
  type: 'test'
  ...
# Subtest: v7 §5 — no site hardcodes the impossible pair any more, and the correct Cohere site is pinned
ok 980 - v7 §5 — no site hardcodes the impossible pair any more, and the correct Cohere site is pinned
  ---
  duration_ms: 0.278584
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: v7 §6 — a generic Cohere failure records unattributed, because the proof rule governs
ok 981 - v7 §6 — a generic Cohere failure records unattributed, because the proof rule governs
  ---
  duration_ms: 20.416792
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic
# Subtest: v7 §6 — the resolved intended pairing survives on the soft-failure record too
ok 982 - v7 §6 — the resolved intended pairing survives on the soft-failure record too
  ---
  duration_ms: 3.312291
  type: 'test'
  ...
# Subtest: v7 §10 — a fresh capture carries the no-rerank values, not zeros
ok 983 - v7 §10 — a fresh capture carries the no-rerank values, not zeros
  ---
  duration_ms: 6.510666
  type: 'test'
  ...
# Subtest: v7 §10 — Cohere records neither a temperature nor a seed, because it takes neither
ok 984 - v7 §10 — Cohere records neither a temperature nor a seed, because it takes neither
  ---
  duration_ms: 3.722584
  type: 'test'
  ...
# Subtest: v7 §10 — the judge records its real temperature and `unseeded`, and the call uses the same constant
ok 985 - v7 §10 — the judge records its real temperature and `unseeded`, and the call uses the same constant
  ---
  duration_ms: 0.126916
  type: 'test'
  ...
# Subtest: v7 §10 — the seed status vocabulary distinguishes a stripped seed from an applied one
ok 986 - v7 §10 — the seed status vocabulary distinguishes a stripped seed from an applied one
  ---
  duration_ms: 2.022625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: PHI: the billing reader never names a PHI column from kx_billing_records
ok 987 - PHI: the billing reader never names a PHI column from kx_billing_records
  ---
  duration_ms: 1.00475
  type: 'test'
  ...
# Subtest: semantics: the ₹ panel never touches the scored-band palette
ok 988 - semantics: the ₹ panel never touches the scored-band palette
  ---
  duration_ms: 0.268542
  type: 'test'
  ...
# Subtest: recon: a billed clinical category whose NABH field is missing is a gap
ok 989 - recon: a billed clinical category whose NABH field is missing is a gap
  ---
  duration_ms: 0.278875
  type: 'test'
  ...
# Subtest: recon: present/partial/na/absent are NOT gaps — only an explicit missing is
ok 990 - recon: present/partial/na/absent are NOT gaps — only an explicit missing is
  ---
  duration_ms: 0.239208
  type: 'test'
  ...
# Subtest: recon: documented-but-not-billed is the other direction, at the same coarseness
ok 991 - recon: documented-but-not-billed is the other direction, at the same coarseness
  ---
  duration_ms: 0.417417
  type: 'test'
  ...
# Subtest: recon: a PACKAGE-billed admission suppresses documented-but-not-billed (bundling artefact)
ok 992 - recon: a PACKAGE-billed admission suppresses documented-but-not-billed (bundling artefact)
  ---
  duration_ms: 0.173291
  type: 'test'
  ...
# Subtest: recon: a documented kind of care that IS billed raises nothing in either direction
ok 993 - recon: a documented kind of care that IS billed raises nothing in either direction
  ---
  duration_ms: 0.132833
  type: 'test'
  ...
# Subtest: bill match: only POSITIVE matches are asserted — by molecule or by drug class
ok 994 - bill match: only POSITIVE matches are asserted — by molecule or by drug class
  ---
  duration_ms: 0.229333
  type: 'test'
  ...
# Subtest: bill match: the panel never asserts the negative (the measured false-"script?" trap)
ok 995 - bill match: the panel never asserts the negative (the measured false-"script?" trap)
  ---
  duration_ms: 0.326042
  type: 'test'
  ...
# Subtest: moleculeOf: db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK
ok 996 - moleculeOf: db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK
  ---
  duration_ms: 0.28725
  type: 'test'
  ...
# Subtest: categories: the clinical/facility split is the reconciliation boundary
ok 997 - categories: the clinical/facility split is the reconciliation boundary
  ---
  duration_ms: 0.060833
  type: 'test'
  ...
# Subtest: billed_total: the row assembler carries the ₹ scalar and it is still not PHI
ok 998 - billed_total: the row assembler carries the ₹ scalar and it is still not PHI
  ---
  duration_ms: 1.220792
  type: 'test'
  ...
# Subtest: the committed gold artifact is frozen, ratified, and hash-pinned
ok 999 - the committed gold artifact is frozen, ratified, and hash-pinned
  ---
  duration_ms: 1.243334
  type: 'test'
  ...
# Subtest: K=5 distribution block (carried from 1.1): every case has the modal band + ranges; S4 drift cases ratified
ok 1000 - K=5 distribution block (carried from 1.1): every case has the modal band + ranges; S4 drift cases ratified
  ---
  duration_ms: 1.258792
  type: 'test'
  ...
# Subtest: 2.0 theme upgrade: material themes expanded via V-ratified extras; nitpick sits in a separate minor tier
ok 1001 - 2.0 theme upgrade: material themes expanded via V-ratified extras; nitpick sits in a separate minor tier
  ---
  duration_ms: 1.116666
  type: 'test'
  ...
# Subtest: the gold is de-identified: no UHID / phone / honorific-name patterns anywhere
ok 1002 - the gold is de-identified: no UHID / phone / honorific-name patterns anywhere
  ---
  duration_ms: 1.641334
  type: 'test'
  ...
# Subtest: loadIpdAuditGold rejects drift: edited case, wrong version/status, dup id, bad verdict
ok 1003 - loadIpdAuditGold rejects drift: edited case, wrong version/status, dup id, bad verdict
  ---
  duration_ms: 4.038792
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: semantics: the adjudication component never touches the scored-band palette
ok 1004 - semantics: the adjudication component never touches the scored-band palette
  ---
  duration_ms: 0.530917
  type: 'test'
  ...
# Subtest: semantics: the LVC summary strip renders without band language; the finding list exists once
ok 1005 - semantics: the LVC summary strip renders without band language; the finding list exists once
  ---
  duration_ms: 0.173875
  type: 'test'
  ...
# Subtest: CaseAuditReport: the findingActions slot is optional — absent means unchanged for other callers
ok 1006 - CaseAuditReport: the findingActions slot is optional — absent means unchanged for other callers
  ---
  duration_ms: 0.14
  type: 'test'
  ...
# Subtest: PHI posture: the row assembler cannot place a name/UHID on the audit row
ok 1007 - PHI posture: the row assembler cannot place a name/UHID on the audit row
  ---
  duration_ms: 0.536458
  type: 'test'
  ...
# Subtest: PHI posture: neither the table nor the store INSERT carries a name/UHID column
ok 1008 - PHI posture: neither the table nor the store INSERT carries a name/UHID column
  ---
  duration_ms: 0.3295
  type: 'test'
  ...
# Subtest: PHI posture: db13 PHI fields are read-time only — never passed to the row assembler
ok 1009 - PHI posture: db13 PHI fields are read-time only — never passed to the row assembler
  ---
  duration_ms: 0.128791
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: IPNO-229: the Internal Medicine audit resolves to Dr Darshana R, NOT Dr Vinod Kumar
ok 1010 - IPNO-229: the Internal Medicine audit resolves to Dr Darshana R, NOT Dr Vinod Kumar
  ---
  duration_ms: 1.549625
  type: 'test'
  ...
# Subtest: IPNO-229: the Orthopedics audit resolves to Dr Vinod Kumar
ok 1011 - IPNO-229: the Orthopedics audit resolves to Dr Vinod Kumar
  ---
  duration_ms: 0.151709
  type: 'test'
  ...
# Subtest: NEVER take the first row — order of the input must not change the answer
ok 1012 - NEVER take the first row — order of the input must not change the answer
  ---
  duration_ms: 0.278709
  type: 'test'
  ...
# Subtest: step 2 — still ambiguous after the speciality match ⇒ most recent discharge_date_time wins
ok 1013 - step 2 — still ambiguous after the speciality match ⇒ most recent discharge_date_time wins
  ---
  duration_ms: 0.170292
  type: 'test'
  ...
# Subtest: step 3 — a null audit speciality (4 of 345) takes the most recent and marks it unconfirmed
ok 1014 - step 3 — a null audit speciality (4 of 345) takes the most recent and marks it unconfirmed
  ---
  duration_ms: 0.24575
  type: 'test'
  ...
# Subtest: a speciality that matches NOTHING falls back to recency and is marked unconfirmed
ok 1015 - a speciality that matches NOTHING falls back to recency and is marked unconfirmed
  ---
  duration_ms: 0.157833
  type: 'test'
  ...
# Subtest: step 4 — a null treating doctor falls back to admitting
ok 1016 - step 4 — a null treating doctor falls back to admitting
  ---
  duration_ms: 0.213542
  type: 'test'
  ...
# Subtest: step 5 — nothing usable ⇒ Unattributed, never a guess and never a throw
ok 1017 - step 5 — nothing usable ⇒ Unattributed, never a guess and never a throw
  ---
  duration_ms: 0.463416
  type: 'test'
  ...
# Subtest: speciality matching tolerates case and whitespace but nothing more
ok 1018 - speciality matching tolerates case and whitespace but nothing more
  ---
  duration_ms: 0.465458
  type: 'test'
  ...
# Subtest: rows with no timestamp sort last and never win over a dated row
ok 1019 - rows with no timestamp sort last and never win over a dated row
  ---
  duration_ms: 0.641834
  type: 'test'
  ...
# Subtest: groupByDoctor aggregates count, mean completeness and band distribution
ok 1020 - groupByDoctor aggregates count, mean completeness and band distribution
  ---
  duration_ms: 0.928916
  type: 'test'
  ...
# Subtest: groupByDoctor: unknown ip_uids become Unattributed, and it always sorts LAST
ok 1021 - groupByDoctor: unknown ip_uids become Unattributed, and it always sorts LAST
  ---
  duration_ms: 0.211416
  type: 'test'
  ...
# Subtest: groupByDoctor: a null completeness does not poison the mean
ok 1022 - groupByDoctor: a null completeness does not poison the mean
  ---
  duration_ms: 0.156334
  type: 'test'
  ...
# Subtest: a group is only "speciality unconfirmed" if EVERY member is
ok 1023 - a group is only "speciality unconfirmed" if EVERY member is
  ---
  duration_ms: 0.115208
  type: 'test'
  ...
# Subtest: groupByDoctor never throws on rubbish input
ok 1024 - groupByDoctor never throws on rubbish input
  ---
  duration_ms: 0.102542
  type: 'test'
  ...
# Subtest: the DEFAULT is Last 3 months (§6.2)
ok 1025 - the DEFAULT is Last 3 months (§6.2)
  ---
  duration_ms: 0.460917
  type: 'test'
  ...
# Subtest: This month / Last month
ok 1026 - This month / Last month
  ---
  duration_ms: 0.219042
  type: 'test'
  ...
# Subtest: Last month across a year boundary, and February leap-year length
ok 1027 - Last month across a year boundary, and February leap-year length
  ---
  duration_ms: 0.231791
  type: 'test'
  ...
# Subtest: Last 3 months across a year boundary
ok 1028 - Last 3 months across a year boundary
  ---
  duration_ms: 0.102125
  type: 'test'
  ...
# Subtest: custom: both bounds, one bound, or neither
ok 1029 - custom: both bounds, one bound, or neither
  ---
  duration_ms: 0.24425
  type: 'test'
  ...
# Subtest: the IST boundary is respected — 23:00 UTC is already tomorrow in Kolkata
ok 1030 - the IST boundary is respected — 23:00 UTC is already tomorrow in Kolkata
  ---
  duration_ms: 0.126875
  type: 'test'
  ...
# Subtest: THE DEFECT, reproduced: counting rows gives 27 orthopaedic, counting documents gives 22
ok 1031 - THE DEFECT, reproduced: counting rows gives 27 orthopaedic, counting documents gives 22
  ---
  duration_ms: 1.645833
  type: 'test'
  ...
# Subtest: ACCEPTANCE: the speciality chip and the list total are EQUAL for every speciality
ok 1032 - ACCEPTANCE: the speciality chip and the list total are EQUAL for every speciality
  ---
  duration_ms: 10.034541
  type: 'test'
  ...
# Subtest: ACCEPTANCE holds for every range × speciality combination
ok 1033 - ACCEPTANCE holds for every range × speciality combination
  ---
  duration_ms: 0.266875
  type: 'test'
  ...
# Subtest: the winner is the HIGHEST engine version, ties broken by latest audited_at
ok 1034 - the winner is the HIGHEST engine version, ties broken by latest audited_at
  ---
  duration_ms: 0.21825
  type: 'test'
  ...
# Subtest: input order never changes the winner
ok 1035 - input order never changes the winner
  ---
  duration_ms: 0.150125
  type: 'test'
  ...
# Subtest: version comparison is NUMERIC, so 0.10 beats 0.2 (a plain DESC sort gets this wrong)
ok 1036 - version comparison is NUMERIC, so 0.10 beats 0.2 (a plain DESC sort gets this wrong)
  ---
  duration_ms: 0.349417
  type: 'test'
  ...
# Subtest: mini/Qwen backfill rows never win a document
ok 1037 - mini/Qwen backfill rows never win a document
  ---
  duration_ms: 0.168417
  type: 'test'
  ...
# Subtest: canonicalByDocument is a READ FILTER — it never mutates the rows it is given
ok 1038 - canonicalByDocument is a READ FILTER — it never mutates the rows it is given
  ---
  duration_ms: 0.226708
  type: 'test'
  ...
# Subtest: rows with no document_id are PASSED THROUGH, never silently dropped
ok 1039 - rows with no document_id are PASSED THROUGH, never silently dropped
  ---
  duration_ms: 0.127417
  type: 'test'
  ...
# Subtest: canonicalByDocument preserves the SQL ordering of the survivors
ok 1040 - canonicalByDocument preserves the SQL ordering of the survivors
  ---
  duration_ms: 0.360084
  type: 'test'
  ...
# Subtest: canonicalByDocument never throws on rubbish
ok 1041 - canonicalByDocument never throws on rubbish
  ---
  duration_ms: 0.0655
  type: 'test'
  ...
# Subtest: specialityCounts buckets blank/null speciality as Unassigned and sorts by count desc
ok 1042 - specialityCounts buckets blank/null speciality as Unassigned and sorts by count desc
  ---
  duration_ms: 0.087917
  type: 'test'
  ...
# Subtest: every read surface goes through the ONE rule — no surface writes its own DISTINCT ON
ok 1043 - every read surface goes through the ONE rule — no surface writes its own DISTINCT ON
  ---
  duration_ms: 1.012625
  type: 'test'
  ...
# Subtest: NOTHING IS WRITTEN OR DELETED — this is a read filter only
ok 1044 - NOTHING IS WRITTEN OR DELETED — this is a read filter only
  ---
  duration_ms: 0.774875
  type: 'test'
  ...
# Subtest: the migration runner applies 0028 too, idempotently (§1.2 B-3)
ok 1045 - the migration runner applies 0028 too, idempotently (§1.2 B-3)
  ---
  duration_ms: 0.37875
  type: 'test'
  ...
# Subtest: the runner and 0028_review_notes.sql agree on every object
ok 1046 - the runner and 0028_review_notes.sql agree on every object
  ---
  duration_ms: 0.340583
  type: 'test'
  ...
# Subtest: the doctor lookup uses the VALIDATED table and join key, and none of the three rejected ones
ok 1047 - the doctor lookup uses the VALIDATED table and join key, and none of the three rejected ones
  ---
  duration_ms: 0.333
  type: 'test'
  ...
# Subtest: the doctor lookup is BATCHED — one call per page, never one per row
ok 1048 - the doctor lookup is BATCHED — one call per page, never one per row
  ---
  duration_ms: 0.150834
  type: 'test'
  ...
# Subtest: the doctor lookup FAILS SOFT — the catch returns Unattributed, never throws
ok 1049 - the doctor lookup FAILS SOFT — the catch returns Unattributed, never throws
  ---
  duration_ms: 0.1245
  type: 'test'
  ...
# Subtest: inputs are validated and escaped before interpolation (no bound params in a native query)
ok 1050 - inputs are validated and escaped before interpolation (no bound params in a native query)
  ---
  duration_ms: 0.089625
  type: 'test'
  ...
# Subtest: migration 0028 is additive and idempotent; existing rows keep reading
ok 1051 - migration 0028 is additive and idempotent; existing rows keep reading
  ---
  duration_ms: 0.179959
  type: 'test'
  ...
# Subtest: the review route writes kind=review with a null finding_ref, and overwrites in place
ok 1052 - the review route writes kind=review with a null finding_ref, and overwrites in place
  ---
  duration_ms: 0.107125
  type: 'test'
  ...
# Subtest: the list query degrades when 0028 has not run — it never 500s
ok 1053 - the list query degrades when 0028 has not run — it never 500s
  ---
  duration_ms: 0.412042
  type: 'test'
  ...
# Subtest: the speciality filter renders RAW values and offers Unassigned for the nulls (§6.1)
ok 1054 - the speciality filter renders RAW values and offers Unassigned for the nulls (§6.1)
  ---
  duration_ms: 0.307166
  type: 'test'
  ...
# Subtest: the shared report renderer stays byte-identical for callers that pass no Phase B props
ok 1055 - the shared report renderer stays byte-identical for callers that pass no Phase B props
  ---
  duration_ms: 0.152625
  type: 'test'
  ...
# Subtest: vercel.json HAS an /api/ipd-audit/worker cron again
ok 1056 - vercel.json HAS an /api/ipd-audit/worker cron again
  ---
  duration_ms: 0.503292
  type: 'test'
  ...
# Subtest: THE COUPLING: the cron interval EXCEEDS the route maxDuration, so runs cannot overlap
ok 1057 - THE COUPLING: the cron interval EXCEEDS the route maxDuration, so runs cannot overlap
  ---
  duration_ms: 0.139833
  type: 'test'
  ...
# Subtest: restoring the cron did not disturb any other schedule
ok 1058 - restoring the cron did not disturb any other schedule
  ---
  duration_ms: 0.056875
  type: 'test'
  ...
# Subtest: the route records the correction, not the withdrawn claim
ok 1059 - the route records the correction, not the withdrawn claim
  ---
  duration_ms: 0.052584
  type: 'test'
  ...
# Subtest: the defaults are max 3 and conc 3 — ONE wave, not three
ok 1060 - the defaults are max 3 and conc 3 — ONE wave, not three
  ---
  duration_ms: 0.05325
  type: 'test'
  ...
# Subtest: THE ARITHMETIC the defaults rest on: one wave fits 800 s, three do not
ok 1061 - THE ARITHMETIC the defaults rest on: one wave fits 800 s, three do not
  ---
  duration_ms: 0.063042
  type: 'test'
  ...
# Subtest: the ?max= and ?conc= overrides and their caps still work
ok 1062 - the ?max= and ?conc= overrides and their caps still work
  ---
  duration_ms: 0.121458
  type: 'test'
  ...
# Subtest: servedCallFor queries stage doc_audit_analyze — NOT opd_audit_analyze
ok 1063 - servedCallFor queries stage doc_audit_analyze — NOT opd_audit_analyze
  ---
  duration_ms: 0.257458
  type: 'test'
  ...
# Subtest: the model column is no longer a constant on the cloud path
ok 1064 - the model column is no longer a constant on the cloud path
  ---
  duration_ms: 0.161084
  type: 'test'
  ...
# Subtest: THE MINI PATH IS UNCHANGED — it still records MINI_MODEL
ok 1065 - THE MINI PATH IS UNCHANGED — it still records MINI_MODEL
  ---
  duration_ms: 0.287542
  type: 'test'
  ...
# Subtest: servedCallFor soft-fails: null on a missing traceId, null on a query failure, never throws
ok 1066 - servedCallFor soft-fails: null on a missing traceId, null on a query failure, never throws
  ---
  duration_ms: 0.181416
  type: 'test'
  ...
# [lab-override] route=app/api/ask provider=bedrock model=global.anthropic.claude-haiku-4-5-20251001-v1:0 paid=true caller=lab-mcp
# [lab-override] route=app/api/ask REFUSED reason=not_admin
# [lab-override] route=app/api/ask REFUSED reason=not_admin
# [lab-override] route=app/api/ask REFUSED reason=clinician_session
# Subtest: AN MCP-ORIGIN OVERRIDE NOW PASSES THE GATE — the 7 Aug run, with the credential
ok 1067 - AN MCP-ORIGIN OVERRIDE NOW PASSES THE GATE — the 7 Aug run, with the credential
  ---
  duration_ms: 1.217541
  type: 'test'
  ...
# Subtest: THE SAME REQUEST WITHOUT THE CREDENTIAL STILL REFUSES — nothing was widened
ok 1068 - THE SAME REQUEST WITHOUT THE CREDENTIAL STILL REFUSES — nothing was widened
  ---
  duration_ms: 0.603167
  type: 'test'
  ...
# Subtest: a WRONG credential is refused, and a right one is compared timing-safely
ok 1069 - a WRONG credential is refused, and a right one is compared timing-safely
  ---
  duration_ms: 0.234917
  type: 'test'
  ...
# Subtest: ADMIN_TOKEN UNSET ⇒ refusal stays the default, on BOTH sides independently
ok 1070 - ADMIN_TOKEN UNSET ⇒ refusal stays the default, on BOTH sides independently
  ---
  duration_ms: 0.351209
  type: 'test'
  ...
# Subtest: the credential never logs, never echoes into a row, never reaches a trace
ok 1071 - the credential never logs, never echoes into a row, never reaches a trace
  ---
  duration_ms: 0.63575
  type: 'test'
  ...
# Subtest: the header unlocks the F11 gate ONLY — isAdminUnlocked gains no new caller
ok 1072 - the header unlocks the F11 gate ONLY — isAdminUnlocked gains no new caller
  ---
  duration_ms: 0.132083
  type: 'test'
  ...
# Subtest: the credential rides TLS or loopback only — never plain http to a foreign host
ok 1073 - the credential rides TLS or loopback only — never plain http to a foreign host
  ---
  duration_ms: 0.348625
  type: 'test'
  ...
# Subtest: only the two WIRED probes send it, and only when an override is requested
ok 1074 - only the two WIRED probes send it, and only when an override is requested
  ---
  duration_ms: 0.280542
  type: 'test'
  ...
# Subtest: decideOverride is untouched — the gate still DEMANDS isAdmin, it is only satisfiable now
ok 1075 - decideOverride is untouched — the gate still DEMANDS isAdmin, it is only satisfiable now
  ---
  duration_ms: 0.262792
  type: 'test'
  ...
# Subtest: a real clinician session refuses the MCP credential too (end to end)
ok 1076 - a real clinician session refuses the MCP credential too (end to end)
  ---
  duration_ms: 0.415125
  type: 'test'
  ...
# Subtest: the deps seam defaults to the real guards — production passes nothing
ok 1077 - the deps seam defaults to the real guards — production passes nothing
  ---
  duration_ms: 0.225333
  type: 'test'
  ...
# Subtest: ⚠️ THE 7 AUG RUN: a bedrock-target ask whose legs resolved to ollama is REFUSED, not stored
ok 1078 - ⚠️ THE 7 AUG RUN: a bedrock-target ask whose legs resolved to ollama is REFUSED, not stored
  ---
  duration_ms: 0.698416
  type: 'test'
  ...
# Subtest: the refused row stops asserting the model, and keeps the evidence
ok 1079 - the refused row stops asserting the model, and keeps the evidence
  ---
  duration_ms: 0.380791
  type: 'test'
  ...
# Subtest: a genuinely-served run verifies, and is stored as what SERVED
ok 1080 - a genuinely-served run verifies, and is stored as what SERVED
  ---
  duration_ms: 0.113667
  type: 'test'
  ...
# Subtest: vertex ≡ gemini across the seam — the two vocabularies are one provider
ok 1081 - vertex ≡ gemini across the seam — the two vocabularies are one provider
  ---
  duration_ms: 0.058792
  type: 'test'
  ...
# Subtest: a legitimate V-a2 ladder hop is not an error — but the row records who ANSWERED
ok 1082 - a legitimate V-a2 ladder hop is not an error — but the row records who ANSWERED
  ---
  duration_ms: 0.105458
  type: 'test'
  ...
# Subtest: utility legs are out of scope — only the legs an override steers are judged
ok 1083 - utility legs are out of scope — only the legs an override steers are judged
  ---
  duration_ms: 0.0635
  type: 'test'
  ...
# Subtest: THE LIST MUST NOT FALL BEHIND THE ROUTES: every `...LAB` traced leg is judged
ok 1084 - THE LIST MUST NOT FALL BEHIND THE ROUTES: every `...LAB` traced leg is judged
  ---
  duration_ms: 0.283
  type: 'test'
  ...
# Subtest: a PAID claim with no recorded call is refused; a free one stores unverified
ok 1085 - a PAID claim with no recorded call is refused; a free one stores unverified
  ---
  duration_ms: 0.061083
  type: 'test'
  ...
# Subtest: empty/garbage legs are treated as no evidence, never as agreement
ok 1086 - empty/garbage legs are treated as no evidence, never as agreement
  ---
  duration_ms: 0.188917
  type: 'test'
  ...
# Subtest: both F11-wired probes carry the attribution config, and the unwired ones do not
ok 1087 - both F11-wired probes carry the attribution config, and the unwired ones do not
  ---
  duration_ms: 0.432375
  type: 'test'
  ...
# Subtest: the refusal happens BEFORE the row is stored as done, or it is not a refusal
ok 1088 - the refusal happens BEFORE the row is stored as done, or it is not a refusal
  ---
  duration_ms: 0.145333
  type: 'test'
  ...
# Subtest: the probe no longer echoes the REQUESTED model into the stored output or summary
ok 1089 - the probe no longer echoes the REQUESTED model into the stored output or summary
  ---
  duration_ms: 0.128042
  type: 'test'
  ...
# Subtest: the trace id reaches the probe: routes emit it, the reducers keep it
ok 1090 - the trace id reaches the probe: routes emit it, the reducers keep it
  ---
  duration_ms: 0.126417
  type: 'test'
  ...
# Subtest: clampN clamps to 1..LB_MAX_N and floors garbage to 1
ok 1091 - clampN clamps to 1..LB_MAX_N and floors garbage to 1
  ---
  duration_ms: 0.526459
  type: 'test'
  ...
# Subtest: sanitizeUids: id-safe, de-duped, capped
ok 1092 - sanitizeUids: id-safe, de-duped, capped
  ---
  duration_ms: 3.222125
  type: 'test'
  ...
# Subtest: remainingUids removes the done-set, order preserved
ok 1093 - remainingUids removes the done-set, order preserved
  ---
  duration_ms: 0.202041
  type: 'test'
  ...
# Subtest: parseBatchState parses settings map
ok 1094 - parseBatchState parses settings map
  ---
  duration_ms: 0.31425
  type: 'test'
  ...
# Subtest: parseBatchState defaults
ok 1095 - parseBatchState defaults
  ---
  duration_ms: 0.260958
  type: 'test'
  ...
# Subtest: evalRerankBackend (Addendum C): exact match only — judge/cohere parse, everything else is null
ok 1096 - evalRerankBackend (Addendum C): exact match only — judge/cohere parse, everything else is null
  ---
  duration_ms: 0.35125
  type: 'test'
  ...
# Subtest: evalRerankBackend threads batch state → evalCfg → runMiniOpdToLab (source-pinned)
ok 1097 - evalRerankBackend threads batch state → evalCfg → runMiniOpdToLab (source-pinned)
  ---
  duration_ms: 0.733709
  type: 'test'
  ...
# Subtest: batchGate precedence
ok 1098 - batchGate precedence
  ---
  duration_ms: 0.163834
  type: 'test'
  ...
# Subtest: LB_LOCK_TTL_MS is 900s and is NOT the prod worker's TTL (D1)
ok 1099 - LB_LOCK_TTL_MS is 900s and is NOT the prod worker's TTL (D1)
  ---
  duration_ms: 0.428625
  type: 'test'
  ...
# Subtest: labLockHeld mirrors mini-backfill.lockHeld exactly, differing ONLY in the TTL
ok 1100 - labLockHeld mirrors mini-backfill.lockHeld exactly, differing ONLY in the TTL
  ---
  duration_ms: 4.902292
  type: 'test'
  ...
# Subtest: THE DEFECT, reproduced: the average note outlived the old TTL
ok 1101 - THE DEFECT, reproduced: the average note outlived the old TTL
  ---
  duration_ms: 0.093208
  type: 'test'
  ...
# Subtest: ttlBreach reports the max observed ms and whether it reached the TTL
ok 1102 - ttlBreach reports the max observed ms and whether it reached the TTL
  ---
  duration_ms: 0.209125
  type: 'test'
  ...
# Subtest: ttlBreach is pure observation: never throws, ignores non-numeric ms, empty ⇒ 0
ok 1103 - ttlBreach is pure observation: never throws, ignores non-numeric ms, empty ⇒ 0
  ---
  duration_ms: 0.157166
  type: 'test'
  ...
# Subtest: the breach message is verbatim per PRD §5, with both numbers interpolated
ok 1104 - the breach message is verbatim per PRD §5, with both numbers interpolated
  ---
  duration_ms: 0.060708
  type: 'test'
  ...
# Subtest: batchGate ordering is UNCHANGED by this build
ok 1105 - batchGate ordering is UNCHANGED by this build
  ---
  duration_ms: 0.090209
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured
ok 1106 - mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured
  ---
  duration_ms: 0.879959
  type: 'test'
  ...
# Subtest: eval path (evalModel set): drains exactly ONE WAVE and skips the mini-yield
ok 1107 - eval path (evalModel set): drains exactly ONE WAVE and skips the mini-yield
  ---
  duration_ms: 0.112208
  type: 'test'
  ...
# Subtest: eval sliceSize == concurrency across the whole clamped range (1..EVAL_CONCURRENCY_MAX)
ok 1108 - eval sliceSize == concurrency across the whole clamped range (1..EVAL_CONCURRENCY_MAX)
  ---
  duration_ms: 0.165584
  type: 'test'
  ...
# Subtest: THE DEFECT: the old slice was ~890s of work in one invocation; the new one is one audit
ok 1109 - THE DEFECT: the old slice was ~890s of work in one invocation; the new one is one audit
  ---
  duration_ms: 0.05475
  type: 'test'
  ...
# Subtest: EVAL_TICK_MAX remains a hard ceiling on the slice (D2)
ok 1110 - EVAL_TICK_MAX remains a hard ceiling on the slice (D2)
  ---
  duration_ms: 0.094208
  type: 'test'
  ...
# Subtest: the mini branch of drainPlan is UNTOUCHED by the one-wave change
ok 1111 - the mini branch of drainPlan is UNTOUCHED by the one-wave change
  ---
  duration_ms: 0.1015
  type: 'test'
  ...
# Subtest: clampEvalConcurrency: default 10, clamp 1..25
ok 1112 - clampEvalConcurrency: default 10, clamp 1..25
  ---
  duration_ms: 0.043041
  type: 'test'
  ...
# Subtest: boundedPool never exceeds its concurrency limit and preserves result order
ok 1113 - boundedPool never exceeds its concurrency limit and preserves result order
  ---
  duration_ms: 18.271625
  type: 'test'
  ...
# Subtest: boundedPool handles limit > items and empty input
ok 1114 - boundedPool handles limit > items and empty input
  ---
  duration_ms: 0.754167
  type: 'test'
  ...
# Subtest: openRouterGenerate retries 429 then succeeds; sleeps between attempts
ok 1115 - openRouterGenerate retries 429 then succeeds; sleeps between attempts
  ---
  duration_ms: 13.991042
  type: 'test'
  ...
# Subtest: openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback
ok 1116 - openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback
  ---
  duration_ms: 0.7495
  type: 'test'
  ...
# Subtest: non-transient status (400) throws immediately — no retry
ok 1117 - non-transient status (400) throws immediately — no retry
  ---
  duration_ms: 0.201959
  type: 'test'
  ...
# Subtest: retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive
ok 1118 - retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive
  ---
  duration_ms: 0.061
  type: 'test'
  ...
# Subtest: the eval drain still writes lab_analyses only — never opd_note_audits
ok 1119 - the eval drain still writes lab_analyses only — never opd_note_audits
  ---
  duration_ms: 0.2295
  type: 'test'
  ...
# Subtest: the tick summary carries tick_ms / slice_planned / slice_drained (D3)
ok 1120 - the tick summary carries tick_ms / slice_planned / slice_drained (D3)
  ---
  duration_ms: 0.219541
  type: 'test'
  ...
# Subtest: the D3 fields are OBSERVATION ONLY — never branched on, never thrown from
ok 1121 - the D3 fields are OBSERVATION ONLY — never branched on, never thrown from
  ---
  duration_ms: 0.465167
  type: 'test'
  ...
# Subtest: LB_LOCK_TTL_MS / labLockHeld / ttlBreach survive this build unchanged
ok 1122 - LB_LOCK_TTL_MS / labLockHeld / ttlBreach survive this build unchanged
  ---
  duration_ms: 0.2
  type: 'test'
  ...
# Subtest: parseBatchState reads evalConcurrency; absent ⇒ default 10
ok 1123 - parseBatchState reads evalConcurrency; absent ⇒ default 10
  ---
  duration_ms: 0.124125
  type: 'test'
  ...
# Subtest: parseNdjson tolerates blank + garbled lines
ok 1124 - parseNdjson tolerates blank + garbled lines
  ---
  duration_ms: 0.625958
  type: 'test'
  ...
# Subtest: reduceDdxEvents folds a full stream
ok 1125 - reduceDdxEvents folds a full stream
  ---
  duration_ms: 3.765875
  type: 'test'
  ...
# Subtest: reduceDdxEvents surfaces an error stream as not-ok
ok 1126 - reduceDdxEvents surfaces an error stream as not-ok
  ---
  duration_ms: 0.211334
  type: 'test'
  ...
# Subtest: extractCitationIds pulls distinct sorted numeric ids
ok 1127 - extractCitationIds pulls distinct sorted numeric ids
  ---
  duration_ms: 0.140875
  type: 'test'
  ...
# Subtest: reduceAskEvents keeps the revised answer, flags uncited
ok 1128 - reduceAskEvents keeps the revised answer, flags uncited
  ---
  duration_ms: 0.156834
  type: 'test'
  ...
# Subtest: reduceAskEvents flags a long uncited answer (cite-or-label canary)
ok 1129 - reduceAskEvents flags a long uncited answer (cite-or-label canary)
  ---
  duration_ms: 0.068584
  type: 'test'
  ...
# Subtest: reduceAppropriatenessEvents captures fired CW statements (over-flag surface)
ok 1130 - reduceAppropriatenessEvents captures fired CW statements (over-flag surface)
  ---
  duration_ms: 0.137791
  type: 'test'
  ...
# Subtest: reduceAppropriatenessEvents handles the empty (nothing-fired) case
ok 1131 - reduceAppropriatenessEvents handles the empty (nothing-fired) case
  ---
  duration_ms: 0.060084
  type: 'test'
  ...
# Subtest: reduceDocAuditEvents pulls the scorecard headline/band
ok 1132 - reduceDocAuditEvents pulls the scorecard headline/band
  ---
  duration_ms: 0.254208
  type: 'test'
  ...
# Subtest: reduceDocAuditEvents surfaces a stream error
ok 1133 - reduceDocAuditEvents surfaces a stream error
  ---
  duration_ms: 0.291416
  type: 'test'
  ...
# Subtest: labSelfBaseUrl prefers explicit, then VERCEL_URL, then localhost
ok 1134 - labSelfBaseUrl prefers explicit, then VERCEL_URL, then localhost
  ---
  duration_ms: 0.1045
  type: 'test'
  ...
# Subtest: labLabel sanitises to a safe slug
ok 1135 - labLabel sanitises to a safe slug
  ---
  duration_ms: 0.48975
  type: 'test'
  ...
# Subtest: chunkText splits on paragraphs, drops tiny fragments, respects the window
ok 1136 - chunkText splits on paragraphs, drops tiny fragments, respects the window
  ---
  duration_ms: 0.202
  type: 'test'
  ...
# Subtest: chunkText hard-splits a single monster paragraph
ok 1137 - chunkText hard-splits a single monster paragraph
  ---
  duration_ms: 0.098625
  type: 'test'
  ...
# Subtest: chunkText returns empty for whitespace-only input
ok 1138 - chunkText returns empty for whitespace-only input
  ---
  duration_ms: 0.287875
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: quarantine INSERT carries visible in the columns and false in the values
ok 1139 - quarantine INSERT carries visible in the columns and false in the values
  ---
  duration_ms: 0.535125
  type: 'test'
  ...
# Subtest: activation UPDATE sets both source and visible = true
ok 1140 - activation UPDATE sets both source and visible = true
  ---
  duration_ms: 0.864333
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: G2/A10.3: the two SCOPES constants differ and are NOT unified
ok 1141 - G2/A10.3: the two SCOPES constants differ and are NOT unified
  ---
  duration_ms: 0.935708
  type: 'test'
  ...
# Subtest: F6: parseFeedbackBody REFUSES scope=missed without a category
ok 1142 - F6: parseFeedbackBody REFUSES scope=missed without a category
  ---
  duration_ms: 0.205834
  type: 'test'
  ...
# Subtest: F6: accepts every whitelisted category, rejects an unknown one
ok 1143 - F6: accepts every whitelisted category, rejects an unknown one
  ---
  duration_ms: 0.166333
  type: 'test'
  ...
# Subtest: F6: the required-category change touches ONLY scope=missed
ok 1144 - F6: the required-category change touches ONLY scope=missed
  ---
  duration_ms: 0.149708
  type: 'test'
  ...
# Subtest: F6: rollup groups missed by CATEGORY and reports recall_proxy as a lower bound
ok 1145 - F6: rollup groups missed by CATEGORY and reports recall_proxy as a lower bound
  ---
  duration_ms: 0.627541
  type: 'test'
  ...
# Subtest: F6: recall_proxy is null on a zero denominator, never NaN
ok 1146 - F6: recall_proxy is null on a zero denominator, never NaN
  ---
  duration_ms: 0.2585
  type: 'test'
  ...
# Subtest: F6: the category→signal map is deliberately partial
ok 1147 - F6: the category→signal map is deliberately partial
  ---
  duration_ms: 0.255083
  type: 'test'
  ...
# Subtest: F17: impact fold reports both tags and coverage_of_tp
ok 1148 - F17: impact fold reports both tags and coverage_of_tp
  ---
  duration_ms: 0.285333
  type: 'test'
  ...
# Subtest: F17: absent impact rows degrade to zeroes and a null coverage, never a throw
ok 1149 - F17: absent impact rows degrade to zeroes and a null coverage, never a throw
  ---
  duration_ms: 0.415041
  type: 'test'
  ...
# Subtest: F11: resolver maps all three prefixes and marks paid correctly
ok 1150 - F11: resolver maps all three prefixes and marks paid correctly
  ---
  duration_ms: 0.794125
  type: 'test'
  ...
# Subtest: F11: omitted model = the local mini, behaviour unchanged
ok 1151 - F11: omitted model = the local mini, behaviour unchanged
  ---
  duration_ms: 0.125791
  type: 'test'
  ...
# Subtest: F11: an unknown provider ERRORS LOUD and never falls back to the mini
ok 1152 - F11: an unknown provider ERRORS LOUD and never falls back to the mini
  ---
  duration_ms: 0.143167
  type: 'test'
  ...
# Subtest: F11: paid ceiling defaults to 250, stops at N and reports
ok 1153 - F11: paid ceiling defaults to 250, stops at N and reports
  ---
  duration_ms: 0.198625
  type: 'test'
  ...
# Subtest: F12b: allowlisted source files are readable
ok 1154 - F12b: allowlisted source files are readable
  ---
  duration_ms: 0.80625
  type: 'test'
  ...
# Subtest: F12b: ../ traversal cannot escape, even disguised behind an allowed prefix
ok 1155 - F12b: ../ traversal cannot escape, even disguised behind an allowed prefix
  ---
  duration_ms: 0.185333
  type: 'test'
  ...
# Subtest: F12b: denylisted names are refused wherever they sit, including under lib/
ok 1156 - F12b: denylisted names are refused wherever they sit, including under lib/
  ---
  duration_ms: 0.25825
  type: 'test'
  ...
# Subtest: F12b: absolute paths, non-source files and anything outside the seam are refused
ok 1157 - F12b: absolute paths, non-source files and anything outside the seam are refused
  ---
  duration_ms: 0.118334
  type: 'test'
  ...
# Subtest: F13: corpus_add refuses a chunk with no citation
ok 1158 - F13: corpus_add refuses a chunk with no citation
  ---
  duration_ms: 0.391583
  type: 'test'
  ...
# Subtest: F13: accepts any ONE of url/doi/pmid with year + licence
ok 1159 - F13: accepts any ONE of url/doi/pmid with year + licence
  ---
  duration_ms: 0.185166
  type: 'test'
  ...
# Subtest: F13: the internal-protocol escape bypasses the gate entirely
ok 1160 - F13: the internal-protocol escape bypasses the gate entirely
  ---
  duration_ms: 0.093334
  type: 'test'
  ...
# Subtest: F13: year and licence are validated, not merely present
ok 1161 - F13: year and licence are validated, not merely present
  ---
  duration_ms: 0.065375
  type: 'test'
  ...
# Subtest: F14: lvc_propose refuses an uncited proposal
ok 1162 - F14: lvc_propose refuses an uncited proposal
  ---
  duration_ms: 0.168625
  type: 'test'
  ...
# Subtest: F14 (A10.4): lvc_propose REFUSES a near-duplicate unless supersedes_id is supplied
ok 1163 - F14 (A10.4): lvc_propose REFUSES a near-duplicate unless supersedes_id is supplied
  ---
  duration_ms: 0.748541
  type: 'test'
  ...
# Subtest: F14: a genuinely distinct cited statement is accepted
ok 1164 - F14: a genuinely distinct cited statement is accepted
  ---
  duration_ms: 0.15475
  type: 'test'
  ...
# Subtest: F14: the duplicate detector recognises the measured rulebook variants
ok 1165 - F14: the duplicate detector recognises the measured rulebook variants
  ---
  duration_ms: 0.075208
  type: 'test'
  ...
# Subtest: F14: lvc_ratify refuses without confirm, with the default author, or without a rationale
ok 1166 - F14: lvc_ratify refuses without confirm, with the default author, or without a rationale
  ---
  duration_ms: 0.102708
  type: 'test'
  ...
# Subtest: F14: lvc_ratify is PROMOTE-ONLY — it cannot create de novo
ok 1167 - F14: lvc_ratify is PROMOTE-ONLY — it cannot create de novo
  ---
  duration_ms: 0.039333
  type: 'test'
  ...
# Subtest: F14: only a proposed row is promotable; rejection is first-class, never a delete
ok 1168 - F14: only a proposed row is promotable; rejection is first-class, never a delete
  ---
  duration_ms: 0.066584
  type: 'test'
  ...
# Subtest: F14: lvc_gaps calls a never-fired rule a RETIREMENT candidate, not a citation candidate
ok 1169 - F14: lvc_gaps calls a never-fired rule a RETIREMENT candidate, not a citation candidate
  ---
  duration_ms: 0.119875
  type: 'test'
  ...
# Subtest: F14: gaps rank by fires within class
ok 1170 - F14: gaps rank by fires within class
  ---
  duration_ms: 0.03675
  type: 'test'
  ...
# Subtest: F16: lab:/labq: weights are clamped at 0.855 until promoted
ok 1171 - F16: lab:/labq: weights are clamped at 0.855 until promoted
  ---
  duration_ms: 0.06225
  type: 'test'
  ...
# Subtest: F17: feedback_detail ADMITS scope=impact (it was write-only) and validates its tags
ok 1172 - F17: feedback_detail ADMITS scope=impact (it was write-only) and validates its tags
  ---
  duration_ms: 0.374166
  type: 'test'
  ...
# Subtest: F6 UI: SavedEvent carries category; applySaved dedupe semantics are unchanged
ok 1173 - F6 UI: SavedEvent carries category; applySaved dedupe semantics are unchanged
  ---
  duration_ms: 0.093375
  type: 'test'
  ...
# Subtest: F6 UI: every category the controls offer is one the write path accepts
ok 1174 - F6 UI: every category the controls offer is one the write path accepts
  ---
  duration_ms: 0.097416
  type: 'test'
  ...
# Subtest: wiring: the four new tools are registered with their required args
ok 1175 - wiring: the four new tools are registered with their required args
  ---
  duration_ms: 0.13375
  type: 'test'
  ...
# Subtest: wiring: corpus_add exposes all six F13 provenance fields
ok 1176 - wiring: corpus_add exposes all six F13 provenance fields
  ---
  duration_ms: 0.042291
  type: 'test'
  ...
# Subtest: wiring: F13 provenance reaches the INSERT, and quarantine stays invisible
ok 1177 - wiring: F13 provenance reaches the INSERT, and quarantine stays invisible
  ---
  duration_ms: 0.0465
  type: 'test'
  ...
# Subtest: wiring: every new tool description states its WRITE-CLASS (F3 discipline held)
ok 1178 - wiring: every new tool description states its WRITE-CLASS (F3 discipline held)
  ---
  duration_ms: 0.045916
  type: 'test'
  ...
# Subtest: wiring: lvc_propose never claims to write the rulebook; lvc_ratify is promote-only
ok 1179 - wiring: lvc_propose never claims to write the rulebook; lvc_ratify is promote-only
  ---
  duration_ms: 0.060792
  type: 'test'
  ...
# Subtest: F14 faults 1a + 7: ALL THREE lvc_recommendations query sites use `society`, never `source`
ok 1180 - F14 faults 1a + 7: ALL THREE lvc_recommendations query sites use `society`, never `source`
  ---
  duration_ms: 0.323209
  type: 'test'
  ...
# Subtest: F14 fault 6: region is supplied — the NOT NULL set is exactly id, region, society, statement
ok 1181 - F14 fault 6: region is supplied — the NOT NULL set is exactly id, region, society, statement
  ---
  duration_ms: 0.102792
  type: 'test'
  ...
# Subtest: F14 fault 1b: the promoted row is society=EHRC, UPPERCASE
ok 1182 - F14 fault 1b: the promoted row is society=EHRC, UPPERCASE
  ---
  duration_ms: 0.524084
  type: 'test'
  ...
# Subtest: F14 faults 2-4: the promotion INSERT names the three audit columns 0024 adds
ok 1183 - F14 faults 2-4: the promotion INSERT names the three audit columns 0024 adds
  ---
  duration_ms: 0.295291
  type: 'test'
  ...
# Subtest: F14 fault 5: `id` is supplied explicitly, matching the ehrc-<uuid> convention
ok 1184 - F14 fault 5: `id` is supplied explicitly, matching the ehrc-<uuid> convention
  ---
  duration_ms: 0.390459
  type: 'test'
  ...
# Subtest: F14: migration 0024 is additive, idempotent, and targets ONE table
ok 1185 - F14: migration 0024 is additive, idempotent, and targets ONE table
  ---
  duration_ms: 0.568291
  type: 'test'
  ...
# Subtest: migration 0023 targets mksap_chunks and never a table called `corpus`
ok 1186 - migration 0023 targets mksap_chunks and never a table called `corpus`
  ---
  duration_ms: 0.263125
  type: 'test'
  ...
# Subtest: 0023 and the runtime DDL agree on lvc_ratifications.promoted_id
ok 1187 - 0023 and the runtime DDL agree on lvc_ratifications.promoted_id
  ---
  duration_ms: 0.741084
  type: 'test'
  ...
# Subtest: 0023 remains a NO-OP on re-run: every statement is guarded, nothing destructive
ok 1188 - 0023 remains a NO-OP on re-run: every statement is guarded, nothing destructive
  ---
  duration_ms: 0.642958
  type: 'test'
  ...
# Subtest: F11: exactly the three honourable probe tools expose `model` and `ceiling`
ok 1189 - F11: exactly the three honourable probe tools expose `model` and `ceiling`
  ---
  duration_ms: 0.060041
  type: 'test'
  ...
# Subtest: F11: the three unwired-route probes have NO model param and SAY why (A4)
ok 1190 - F11: the three unwired-route probes have NO model param and SAY why (A4)
  ---
  duration_ms: 0.061375
  type: 'test'
  ...
# Subtest: F11: the model param resolves all three prefixes and errors loud on unknown
ok 1191 - F11: the model param resolves all three prefixes and errors loud on unknown
  ---
  duration_ms: 0.069667
  type: 'test'
  ...
# Subtest: F11: omitted model ⇒ the local mini, byte-identical, and NOT paid
ok 1192 - F11: omitted model ⇒ the local mini, byte-identical, and NOT paid
  ---
  duration_ms: 0.331833
  type: 'test'
  ...
# Subtest: F11: the paid ceiling stops at N and reports; free runs never count
ok 1193 - F11: the paid ceiling stops at N and reports; free runs never count
  ---
  duration_ms: 0.048
  type: 'test'
  ...
# Subtest: F11: provider is recorded on lab_analyses alongside the RESOLVED model
ok 1194 - F11: provider is recorded on lab_analyses alongside the RESOLVED model
  ---
  duration_ms: 0.298667
  type: 'test'
  ...
# Subtest: F11: NO route file was touched in this build
ok 1195 - F11: NO route file was touched in this build
  ---
  duration_ms: 0.292583
  type: 'test'
  ...
# Subtest: F11: the engine label is DERIVED from the resolved provider, not hardcoded
ok 1196 - F11: the engine label is DERIVED from the resolved provider, not hardcoded
  ---
  duration_ms: 0.328875
  type: 'test'
  ...
# Subtest: F11: ollama maps back to "mini" so every historical label is preserved exactly
ok 1197 - F11: ollama maps back to "mini" so every historical label is preserved exactly
  ---
  duration_ms: 0.198042
  type: 'test'
  ...
# Subtest: F11: mini_analyze TEXT mode refuses a model rather than accepting and ignoring it
ok 1198 - F11: mini_analyze TEXT mode refuses a model rather than accepting and ignoring it
  ---
  duration_ms: 0.212708
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"
ok 1199 - BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"
  ---
  duration_ms: 5.328292
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing
ok 1200 - BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing
  ---
  duration_ms: 0.400625
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (c): EVERY routing site in EVERY wired route threads ...LAB — none left behind
ok 1201 - BYTE-IDENTITY (c): EVERY routing site in EVERY wired route threads ...LAB — none left behind
  ---
  duration_ms: 0.501375
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY per route: each wired route calls the gate and takes labModel additively
ok 1202 - BYTE-IDENTITY per route: each wired route calls the gate and takes labModel additively
  ---
  duration_ms: 0.195125
  type: 'test'
  ...
# Subtest: the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged
ok 1203 - the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged
  ---
  duration_ms: 0.067125
  type: 'test'
  ...
# Subtest: every wired route records the RESOLVED model on the trace, never the requested string
ok 1204 - every wired route records the RESOLVED model on the trace, never the requested string
  ---
  duration_ms: 0.068958
  type: 'test'
  ...
# Subtest: CONTAINMENT: exactly the two model-string routes are wired; the three forceOllama routes are NOT
ok 1205 - CONTAINMENT: exactly the two model-string routes are wired; the three forceOllama routes are NOT
  ---
  duration_ms: 0.326417
  type: 'test'
  ...
# Subtest: CONTAINMENT: no SIXTH route imports the gate
ok 1206 - CONTAINMENT: no SIXTH route imports the gate
  ---
  duration_ms: 24.971334
  type: 'test'
  ...
# Subtest: selfPostNdjson can now carry the lab-origin header (gate condition 2)
ok 1207 - selfPostNdjson can now carry the lab-origin header (gate condition 2)
  ---
  duration_ms: 0.550583
  type: 'test'
  ...
# Subtest: routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini
ok 1208 - routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini
  ---
  duration_ms: 0.725292
  type: 'test'
  ...
# Subtest: condition 6 probe is deterministic and refuses an unknown provider
ok 1209 - condition 6 probe is deterministic and refuses an unknown provider
  ---
  duration_ms: 0.220667
  type: 'test'
  ...
# Subtest: THE INVARIANT: no model requested ⇒ no override — this is what keeps the five routes byte-identical
ok 1210 - THE INVARIANT: no model requested ⇒ no override — this is what keeps the five routes byte-identical
  ---
  duration_ms: 0.588458
  type: 'test'
  ...
# Subtest: the full pass path honours the override and reports the RESOLVED model
ok 1211 - the full pass path honours the override and reports the RESOLVED model
  ---
  duration_ms: 0.090333
  type: 'test'
  ...
# Subtest: 1 — env flag: absent, unset or anything but "1" ⇒ OFF (the kill switch)
ok 1212 - 1 — env flag: absent, unset or anything but "1" ⇒ OFF (the kill switch)
  ---
  duration_ms: 0.079708
  type: 'test'
  ...
# Subtest: 2 — lab-origin marker: a header, and only the exact value passes
ok 1213 - 2 — lab-origin marker: a header, and only the exact value passes
  ---
  duration_ms: 0.066
  type: 'test'
  ...
# Subtest: 3 — admin auth must pass on the same request
ok 1214 - 3 — admin auth must pass on the same request
  ---
  duration_ms: 0.048667
  type: 'test'
  ...
# Subtest: 4 — a clinician session REFUSES the override even when 1-3 all pass
ok 1215 - 4 — a clinician session REFUSES the override even when 1-3 all pass
  ---
  duration_ms: 0.106667
  type: 'test'
  ...
# Subtest: 5 — an unknown provider prefix falls through to the production default
ok 1216 - 5 — an unknown provider prefix falls through to the production default
  ---
  duration_ms: 0.054167
  type: 'test'
  ...
# Subtest: 6 — an unreachable model falls through to default, and UNPROBED counts as unreachable
ok 1217 - 6 — an unreachable model falls through to default, and UNPROBED counts as unreachable
  ---
  duration_ms: 0.04
  type: 'test'
  ...
# Subtest: the gate NEVER throws and NEVER returns an error, whatever it is handed
ok 1218 - the gate NEVER throws and NEVER returns an error, whatever it is handed
  ---
  duration_ms: 0.237666
  type: 'test'
  ...
# Subtest: condition ORDER is the safety property — the kill switch is evaluated first
ok 1219 - condition ORDER is the safety property — the kill switch is evaluated first
  ---
  duration_ms: 0.300291
  type: 'test'
  ...
# Subtest: an honoured override logs route · provider · resolved model · caller (A12)
ok 1220 - an honoured override logs route · provider · resolved model · caller (A12)
  ---
  duration_ms: 0.161709
  type: 'test'
  ...
# Subtest: refusals are logged except the normal no-override path
ok 1221 - refusals are logged except the normal no-override path
  ---
  duration_ms: 0.056917
  type: 'test'
  ...
# Subtest: ollama and vertex both pass the gate when everything else does
ok 1222 - ollama and vertex both pass the gate when everything else does
  ---
  duration_ms: 0.054292
  type: 'test'
  ...
# Subtest: ROUND TRIP: serialise → parse returns a deeply equal package set
ok 1223 - ROUND TRIP: serialise → parse returns a deeply equal package set
  ---
  duration_ms: 1.2965
  type: 'test'
  ...
# Subtest: ROUND TRIP: re-importing an unmodified export yields a ZERO-ROW DIFF
ok 1224 - ROUND TRIP: re-importing an unmodified export yields a ZERO-ROW DIFF
  ---
  duration_ms: 0.323625
  type: 'test'
  ...
# Subtest: ROUND TRIP: the import route refuses to create a version when the diff is empty
ok 1225 - ROUND TRIP: the import route refuses to create a version when the diff is empty
  ---
  duration_ms: 0.10275
  type: 'test'
  ...
# Subtest: ROUND TRIP survives the awkward characters — quotes, commas, semicolons, unicode
ok 1226 - ROUND TRIP survives the awkward characters — quotes, commas, semicolons, unicode
  ---
  duration_ms: 0.149333
  type: 'test'
  ...
# Subtest: ROUND TRIP is stable across CRLF and a BOM (what Excel actually writes)
ok 1227 - ROUND TRIP is stable across CRLF and a BOM (what Excel actually writes)
  ---
  duration_ms: 0.189375
  type: 'test'
  ...
# Subtest: an empty package set round-trips to a header-only file and back
ok 1228 - an empty package set round-trips to a header-only file and back
  ---
  duration_ms: 0.138208
  type: 'test'
  ...
# Subtest: CSV validation rejects each invalid case named in §7.3, and applies nothing
ok 1229 - CSV validation rejects each invalid case named in §7.3, and applies nothing
  ---
  duration_ms: 1.594541
  type: 'test'
  ...
# Subtest: CSV validation rejects an oversize row count and a non-.csv extension
ok 1230 - CSV validation rejects an oversize row count and a non-.csv extension
  ---
  duration_ms: 2.790584
  type: 'test'
  ...
# Subtest: constituents and aliases are trimmed and de-duplicated case-insensitively on ingest
ok 1231 - constituents and aliases are trimmed and de-duplicated case-insensitively on ingest
  ---
  duration_ms: 0.795542
  type: 'test'
  ...
# Subtest: the low-level CSV splitters handle quotes, doubled quotes and embedded newlines
ok 1232 - the low-level CSV splitters handle quotes, doubled quotes and embedded newlines
  ---
  duration_ms: 1.015625
  type: 'test'
  ...
# Subtest: the diff lists REMOVALS explicitly — they can never be inferred from a count alone
ok 1233 - the diff lists REMOVALS explicitly — they can never be inferred from a count alone
  ---
  duration_ms: 0.237833
  type: 'test'
  ...
# Subtest: the diff reports constituent and alias movement per package
ok 1234 - the diff reports constituent and alias movement per package
  ---
  duration_ms: 11.4885
  type: 'test'
  ...
# Subtest: EQUIVALENCE: an empty or malformed package set leaves the judge prompt BYTE-IDENTICAL
ok 1235 - EQUIVALENCE: an empty or malformed package set leaves the judge prompt BYTE-IDENTICAL
  ---
  duration_ms: 0.887291
  type: 'test'
  ...
# Subtest: EQUIVALENCE holds with the other optional context blocks present too
ok 1236 - EQUIVALENCE holds with the other optional context blocks present too
  ---
  duration_ms: 0.078917
  type: 'test'
  ...
# Subtest: a REAL package set adds a factual block and changes nothing else
ok 1237 - a REAL package set adds a factual block and changes nothing else
  ---
  duration_ms: 0.282541
  type: 'test'
  ...
# Subtest: the LVC judge call fails OPEN — a package-context error cannot cost a judgement
ok 1238 - the LVC judge call fails OPEN — a package-context error cannot cost a judgement
  ---
  duration_ms: 0.138
  type: 'test'
  ...
# Subtest: the applicability rubric itself is UNTOUCHED — this build adds context, not policy
ok 1239 - the applicability rubric itself is UNTOUCHED — this build adds context, not policy
  ---
  duration_ms: 0.142084
  type: 'test'
  ...
# Subtest: parseStoredLabPackages is the ARRAY branch of the divergent weights shape (§12.3)
ok 1240 - parseStoredLabPackages is the ARRAY branch of the divergent weights shape (§12.3)
  ---
  duration_ms: 0.140333
  type: 'test'
  ...
# Subtest: the publish path branches on shape so an array is not hashed against field keys
ok 1241 - the publish path branches on shape so an array is not hashed against field keys
  ---
  duration_ms: 0.123833
  type: 'test'
  ...
# Subtest: the generator de-duplicates the doubled source strings and drops self-references
ok 1242 - the generator de-duplicates the doubled source strings and drops self-references
  ---
  duration_ms: 0.07575
  type: 'test'
  ...
# Subtest: data/lab-packages.json is valid JSON and safe whatever state it is in
ok 1243 - data/lab-packages.json is valid JSON and safe whatever state it is in
  ---
  duration_ms: 0.377792
  type: 'test'
  ...
# Subtest: NULL means UNKNOWN, never zero — the single most important rule here
ok 1244 - NULL means UNKNOWN, never zero — the single most important rule here
  ---
  duration_ms: 0.065083
  type: 'test'
  ...
# Subtest: "None ordered" matches = 0 EXPLICITLY; unknown survives neither filtered view
ok 1245 - "None ordered" matches = 0 EXPLICITLY; unknown survives neither filtered view
  ---
  duration_ms: 0.047959
  type: 'test'
  ...
# Subtest: the lookup merges duplicate prescription rows so ORDERED never loses to a sibling 0
ok 1246 - the lookup merges duplicate prescription rows so ORDERED never loses to a sibling 0
  ---
  duration_ms: 0.308667
  type: 'test'
  ...
# Subtest: FAIL-SOFT: an unavailable lookup makes the filter INERT, not empty
ok 1247 - FAIL-SOFT: an unavailable lookup makes the filter INERT, not empty
  ---
  duration_ms: 0.493042
  type: 'test'
  ...
# Subtest: the investigations query uses the VALIDATED, DOUBLE-QUOTED hyphenated table
ok 1248 - the investigations query uses the VALIDATED, DOUBLE-QUOTED hyphenated table
  ---
  duration_ms: 0.356916
  type: 'test'
  ...
# Subtest: the OPD filter control disables itself rather than disappearing when db13 is down
ok 1249 - the OPD filter control disables itself rather than disappearing when db13 is down
  ---
  duration_ms: 0.114167
  type: 'test'
  ...
# Subtest: FIX 0 ACCEPTANCE: 2026-07-25 collapses 532 audit rows to 429 notes
ok 1250 - FIX 0 ACCEPTANCE: 2026-07-25 collapses 532 audit rows to 429 notes
  ---
  duration_ms: 0.758625
  type: 'test'
  ...
# Subtest: FIX 0: numeric version comparison — 0.81.14 beats 0.81.9 (lexicographic gets this wrong)
ok 1251 - FIX 0: numeric version comparison — 0.81.14 beats 0.81.9 (lexicographic gets this wrong)
  ---
  duration_ms: 0.055792
  type: 'test'
  ...
# Subtest: FIX 0: ONE implementation — canonicalByUid and canonicalByDocument are the same function
ok 1252 - FIX 0: ONE implementation — canonicalByUid and canonicalByDocument are the same function
  ---
  duration_ms: 0.158958
  type: 'test'
  ...
# Subtest: FIX 0: the OPD aggregates filter on the canonical set, and now FAIL CLOSED
ok 1253 - FIX 0: the OPD aggregates filter on the canonical set, and now FAIL CLOSED
  ---
  duration_ms: 0.486083
  type: 'test'
  ...
# Subtest: subjectSignature clusters near-verbatim subjects, ignores dose/case/parentheticals
ok 1254 - subjectSignature clusters near-verbatim subjects, ignores dose/case/parentheticals
  ---
  duration_ms: 1.064333
  type: 'test'
  ...
# Subtest: mineRuleCandidates: passes the volume + evidence gates, excludes the rest
ok 1255 - mineRuleCandidates: passes the volume + evidence gates, excludes the rest
  ---
  duration_ms: 0.808541
  type: 'test'
  ...
# Subtest: parseCanonicalMap maps indices → labels, ignores out-of-range
ok 1256 - parseCanonicalMap maps indices → labels, ignores out-of-range
  ---
  duration_ms: 0.12275
  type: 'test'
  ...
# Subtest: canonical label MERGES paraphrases that the deterministic signature would fragment
ok 1257 - canonical label MERGES paraphrases that the deterministic signature would fragment
  ---
  duration_ms: 0.266208
  type: 'test'
  ...
# Subtest: mineHarvestGaps: predominantly-UNCITED practices become harvest topics; well-cited/sparse do not
ok 1258 - mineHarvestGaps: predominantly-UNCITED practices become harvest topics; well-cited/sparse do not
  ---
  duration_ms: 0.627375
  type: 'test'
  ...
# Subtest: mineRuleCandidates: context-dependent → limit; prescribing domain → pharmacy_ams
ok 1259 - mineRuleCandidates: context-dependent → limit; prescribing domain → pharmacy_ams
  ---
  duration_ms: 0.117208
  type: 'test'
  ...
# Subtest: truncateCard: caps + ellipsis at the 140 boundary, collapses whitespace
ok 1260 - truncateCard: caps + ellipsis at the 140 boundary, collapses whitespace
  ---
  duration_ms: 0.063083
  type: 'test'
  ...
# Subtest: mineMissedFlags: same-signature flags cluster; a singleton is its own cluster (≥1 harvests)
ok 1261 - mineMissedFlags: same-signature flags cluster; a singleton is its own cluster (≥1 harvests)
  ---
  duration_ms: 0.490625
  type: 'test'
  ...
# Subtest: mineMissedFlags: citable cluster → deterministic missed_rule draft
ok 1262 - mineMissedFlags: citable cluster → deterministic missed_rule draft
  ---
  duration_ms: 0.228958
  type: 'test'
  ...
# Subtest: mineMissedFlags: uncitable → harvest_topic (evidence over frequency)
ok 1263 - mineMissedFlags: uncitable → harvest_topic (evidence over frequency)
  ---
  duration_ms: 0.314792
  type: 'test'
  ...
# Subtest: mineFalseClusters: ≥3 false/nitpick across ≥2 reviewers AND precision <0.5 → suppression
ok 1264 - mineFalseClusters: ≥3 false/nitpick across ≥2 reviewers AND precision <0.5 → suppression
  ---
  duration_ms: 0.212958
  type: 'test'
  ...
# Subtest: mineFalseClusters: precision ≥0.5 blocks the candidate even at volume
ok 1265 - mineFalseClusters: precision ≥0.5 blocks the candidate even at volume
  ---
  duration_ms: 0.065291
  type: 'test'
  ...
# Subtest: mineFalseClusters: single-reviewer cluster blocked (needs ≥2)
ok 1266 - mineFalseClusters: single-reviewer cluster blocked (needs ≥2)
  ---
  duration_ms: 0.047708
  type: 'test'
  ...
# Subtest: gate constants pinned to normative values (§2.3 + HARVEST-DEMAND-RANK §2.3)
ok 1267 - gate constants pinned to normative values (§2.3 + HARVEST-DEMAND-RANK §2.3)
  ---
  duration_ms: 0.043542
  type: 'test'
  ...
# Subtest: demandRankScore: zero → 0, full saturation → 100
ok 1268 - demandRankScore: zero → 0, full saturation → 100
  ---
  duration_ms: 0.061917
  type: 'test'
  ...
# Subtest: demandRankScore: deficit outweighs volume outweighs breadth at equal magnitude
ok 1269 - demandRankScore: deficit outweighs volume outweighs breadth at equal magnitude
  ---
  duration_ms: 0.076792
  type: 'test'
  ...
# Subtest: demandRankScore: monotone non-decreasing in each term; clamps junk input
ok 1270 - demandRankScore: monotone non-decreasing in each term; clamps junk input
  ---
  duration_ms: 0.062416
  type: 'test'
  ...
# Subtest: coverageDeficitOf: 1 − topSim, clamped
ok 1271 - coverageDeficitOf: 1 − topSim, clamped
  ---
  duration_ms: 0.0435
  type: 'test'
  ...
# Subtest: mineHarvestGaps: back-compat — no probe injected → ranks by uncited volume, no demandRank
ok 1272 - mineHarvestGaps: back-compat — no probe injected → ranks by uncited volume, no demandRank
  ---
  duration_ms: 1.961084
  type: 'test'
  ...
# Subtest: mineHarvestGaps: live probe DROPS a covered topic even though citedFrac passed it
ok 1273 - mineHarvestGaps: live probe DROPS a covered topic even though citedFrac passed it
  ---
  duration_ms: 0.575666
  type: 'test'
  ...
# Subtest: mineHarvestGaps: a low-volume/high-deficit cluster outranks a high-volume/partly-covered one
ok 1274 - mineHarvestGaps: a low-volume/high-deficit cluster outranks a high-volume/partly-covered one
  ---
  duration_ms: 0.674708
  type: 'test'
  ...
# Subtest: mineHarvestGaps: unprobed (deferred) clusters survive, unranked — never dropped
ok 1275 - mineHarvestGaps: unprobed (deferred) clusters survive, unranked — never dropped
  ---
  duration_ms: 0.501083
  type: 'test'
  ...
# Subtest: missed rail: ONE uncovered flag yields a demand-ranked harvest candidate
ok 1276 - missed rail: ONE uncovered flag yields a demand-ranked harvest candidate
  ---
  duration_ms: 0.560417
  type: 'test'
  ...
# Subtest: missed rail: ONE flag NEVER yields a rule, however well the corpus covers it
ok 1277 - missed rail: ONE flag NEVER yields a rule, however well the corpus covers it
  ---
  duration_ms: 0.255041
  type: 'test'
  ...
# Subtest: missed rail: ≥2 flags + covered corpus → missed_rule (unchanged bar)
ok 1278 - missed rail: ≥2 flags + covered corpus → missed_rule (unchanged bar)
  ---
  duration_ms: 0.147333
  type: 'test'
  ...
# Subtest: routeAdjudication: suppress → vouch, fix → surfaced-only, accept/defer/monitor → no-op
ok 1279 - routeAdjudication: suppress → vouch, fix → surfaced-only, accept/defer/monitor → no-op
  ---
  duration_ms: 0.126458
  type: 'test'
  ...
# Subtest: adjudicationSignalType: parses the coarse <signal_type>@<engine_version> key
ok 1280 - adjudicationSignalType: parses the coarse <signal_type>@<engine_version> key
  ---
  duration_ms: 0.111542
  type: 'test'
  ...
# Subtest: routeAdjudications: the 6 ratified decisions → 1 vouch, 5 surfaced fixes, 0 harvest
ok 1281 - routeAdjudications: the 6 ratified decisions → 1 vouch, 5 surfaced fixes, 0 harvest
  ---
  duration_ms: 0.3585
  type: 'test'
  ...
# Subtest: routeAdjudications: accept/defer/monitor vouch nothing and surface nothing
ok 1282 - routeAdjudications: accept/defer/monitor vouch nothing and surface nothing
  ---
  duration_ms: 0.131792
  type: 'test'
  ...
# Subtest: suppression vouch: an adjudicated suppress lets a ONE-reviewer cluster propose
ok 1283 - suppression vouch: an adjudicated suppress lets a ONE-reviewer cluster propose
  ---
  duration_ms: 0.661916
  type: 'test'
  ...
# Subtest: suppression vouch: relaxes ONLY the reviewer gate — volume + precision still bind
ok 1284 - suppression vouch: relaxes ONLY the reviewer gate — volume + precision still bind
  ---
  duration_ms: 0.829708
  type: 'test'
  ...
# Subtest: ratio: null on zero denominator, value otherwise
ok 1285 - ratio: null on zero denominator, value otherwise
  ---
  duration_ms: 0.416292
  type: 'test'
  ...
# Subtest: pct: "—" for null, whole-percent otherwise
ok 1286 - pct: "—" for null, whole-percent otherwise
  ---
  duration_ms: 0.082333
  type: 'test'
  ...
# Subtest: buildFlywheel: perDay rounds audits over elapsed days; ≥1 divisor
ok 1287 - buildFlywheel: perDay rounds audits over elapsed days; ≥1 divisor
  ---
  duration_ms: 0.161291
  type: 'test'
  ...
# Subtest: buildFlywheel: attribution + grounded ratios (the two first-ever headline numbers)
ok 1288 - buildFlywheel: attribution + grounded ratios (the two first-ever headline numbers)
  ---
  duration_ms: 0.051
  type: 'test'
  ...
# Subtest: buildFlywheel: zero corpus denominators → null → "—", never a fake 0%
ok 1289 - buildFlywheel: zero corpus denominators → null → "—", never a fake 0%
  ---
  duration_ms: 0.0565
  type: 'test'
  ...
# Subtest: buildFlywheel: approved list drops zero-count types
ok 1290 - buildFlywheel: approved list drops zero-count types
  ---
  duration_ms: 0.44125
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: T1: defaults are 90000 / 0 / 600000
ok 1291 - T1: defaults are 90000 / 0 / 600000
  ---
  duration_ms: 0.641
  type: 'test'
  ...
# Subtest: T2: resolvers honour numeric overrides and fall back on garbage
ok 1292 - T2: resolvers honour numeric overrides and fall back on garbage
  ---
  duration_ms: 0.224125
  type: 'test'
  ...
# Subtest: T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries
ok 1293 - T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries
  ---
  duration_ms: 0.341875
  type: 'test'
  ...
# Subtest: T4: the audit call site passes an audit-class ceiling that clears measured latency
ok 1294 - T4: the audit call site passes an audit-class ceiling that clears measured latency
  ---
  duration_ms: 0.988208
  type: 'test'
  ...
# Subtest: T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)
ok 1295 - T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)
  ---
  duration_ms: 310.7245
  type: 'test'
  ...
# Subtest: priceFor matches flash before pro, and falls back
ok 1296 - priceFor matches flash before pro, and falls back
  ---
  duration_ms: 0.394667
  type: 'test'
  ...
# Subtest: perCallInr computes ₹ from tokens (Pro base tier)
ok 1297 - perCallInr computes ₹ from tokens (Pro base tier)
  ---
  duration_ms: 0.148667
  type: 'test'
  ...
# Subtest: perCallInr applies the >200k Pro high tier
ok 1298 - perCallInr applies the >200k Pro high tier
  ---
  duration_ms: 0.074375
  type: 'test'
  ...
# Subtest: costInr with explicit tier (aggregate path) matches base rate for summed tokens
ok 1299 - costInr with explicit tier (aggregate path) matches base rate for summed tokens
  ---
  duration_ms: 0.046625
  type: 'test'
  ...
# Subtest: fmtInr rounds with Indian grouping; paise for tiny amounts
ok 1300 - fmtInr rounds with Indian grouping; paise for tiny amounts
  ---
  duration_ms: 43.563792
  type: 'test'
  ...
# Subtest: keywordRecall: substring match on normalized haystack; <3-char keywords ignored
ok 1301 - keywordRecall: substring match on normalized haystack; <3-char keywords ignored
  ---
  duration_ms: 1.913542
  type: 'test'
  ...
# Subtest: passesFloor: only "applies" above the surface floor fires (two-tier)
ok 1302 - passesFloor: only "applies" above the surface floor fires (two-tier)
  ---
  duration_ms: 0.257833
  type: 'test'
  ...
# Subtest: assembleFlags: gates, sorts by confidence desc, maps citation
ok 1303 - assembleFlags: gates, sorts by confidence desc, maps citation
  ---
  duration_ms: 2.378417
  type: 'test'
  ...
# Subtest: dedupeById keeps first occurrence across lists
ok 1304 - dedupeById keeps first occurrence across lists
  ---
  duration_ms: 1.360209
  type: 'test'
  ...
# Subtest: identical runs: full agreement, no flips, zero confidence drift
ok 1305 - identical runs: full agreement, no flips, zero confidence drift
  ---
  duration_ms: 0.935375
  type: 'test'
  ...
# Subtest: pairing is by rec id, never by position — reordering is not a flip
ok 1306 - pairing is by rec id, never by position — reordering is not a flip
  ---
  duration_ms: 0.102166
  type: 'test'
  ...
# Subtest: a flip is recorded in the matrix with its direction, and the delta is signed
ok 1307 - a flip is recorded in the matrix with its direction, and the delta is signed
  ---
  duration_ms: 0.152625
  type: 'test'
  ...
# Subtest: a rec present in only one run is unmatched, never silently dropped or counted as a flip
ok 1308 - a rec present in only one run is unmatched, never silently dropped or counted as a flip
  ---
  duration_ms: 0.07175
  type: 'test'
  ...
# Subtest: an empty comparable set is NOT agreement — it is nothing measured
ok 1309 - an empty comparable set is NOT agreement — it is nothing measured
  ---
  duration_ms: 0.114917
  type: 'test'
  ...
# Subtest: summary: percentages are over what actually compared, and the matrix sums across cases
ok 1310 - summary: percentages are over what actually compared, and the matrix sums across cases
  ---
  duration_ms: 0.178959
  type: 'test'
  ...
# Subtest: degenerate input never throws: nulls, missing recs, duplicate ids, non-numeric confidence
ok 1311 - degenerate input never throws: nulls, missing recs, duplicate ids, non-numeric confidence
  ---
  duration_ms: 0.171833
  type: 'test'
  ...
# Subtest: the verdict vocabulary is the judge's own three
ok 1312 - the verdict vocabulary is the judge's own three
  ---
  duration_ms: 0.150917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] judge attempt 1/2 attribution UNKNOWN (no model reported by transport or body) — verdict accepted per D-6, not retried
# [lvc] judge attempt 1/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (body_names_other_model): served 'qwen2.5:14b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_names_other_model: transport 'llama3.1:8b', body 'none' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_names_other_model: transport 'llama3.1:8b', body 'none' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_names_other_model): served 'llama3.1:8b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_body_conflict): served 'gemini-2.5-pro' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'llama3.1:8b', body 'gemini-2.5-pro' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_body_conflict: transport 'llama3.1:8b', body 'gemini-2.5-pro' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_body_conflict): served 'llama3.1:8b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed vertex 403
# [lvc] judge attempt 2/2 failed vertex 403
# [lvc] judge REFUSED (call_failed): served 'none' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed transient 429
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# Subtest: 1: empty body model + no transport evidence + valid content → verdict served, ONE call, unknown
ok 1313 - 1: empty body model + no transport evidence + valid content → verdict served, ONE call, unknown
  ---
  duration_ms: 3.082625
  type: 'test'
  ...
# Subtest: 2: transport names the intended Gemini model → ONE call, verified
ok 1314 - 2: transport names the intended Gemini model → ONE call, verified
  ---
  duration_ms: 1.536667
  type: 'test'
  ...
# Subtest: 3: body names a DIFFERENT model → two calls, refusal, every rec insufficient_info, wrong_model
ok 1315 - 3: body names a DIFFERENT model → two calls, refusal, every rec insufficient_info, wrong_model
  ---
  duration_ms: 1.396667
  type: 'test'
  ...
# Subtest: 4: transport names the LOCAL model → wrong_model, the verdict is never accepted
ok 1316 - 4: transport names the LOCAL model → wrong_model, the verdict is never accepted
  ---
  duration_ms: 1.067541
  type: 'test'
  ...
# Subtest: 5: a CONFLICT between the two sources is wrong_model — in BOTH directions
ok 1317 - 5: a CONFLICT between the two sources is wrong_model — in BOTH directions
  ---
  duration_ms: 1.962041
  type: 'test'
  ...
# Subtest: 6: body-only verified — no transport evidence, body names the intended Gemini → verified, ONE call
ok 1318 - 6: body-only verified — no transport evidence, body names the intended Gemini → verified, ONE call
  ---
  duration_ms: 0.93575
  type: 'test'
  ...
# Subtest: 7: a provider THROW retries once then refuses — and stays distinct from unknown
ok 1319 - 7: a provider THROW retries once then refuses — and stays distinct from unknown
  ---
  duration_ms: 0.604333
  type: 'test'
  ...
# Subtest: 7b: a first-attempt throw followed by a verified answer is served — the retry still recovers
ok 1320 - 7b: a first-attempt throw followed by a verified answer is served — the retry still recovers
  ---
  duration_ms: 0.282166
  type: 'test'
  ...
# Subtest: 8: the REAL judge call passes noLocalFallback: true — mechanically, through llmCall
ok 1321 - 8: the REAL judge call passes noLocalFallback: true — mechanically, through llmCall
  ---
  duration_ms: 0.363
  type: 'test'
  ...
# Subtest: 8b: candidate extraction does NOT pass noLocalFallback — its options object is byte-identical
ok 1322 - 8b: candidate extraction does NOT pass noLocalFallback — its options object is byte-identical
  ---
  duration_ms: 0.623125
  type: 'test'
  ...
# Subtest: 9: attempt + invocation payloads — absent stays null, both sources stay separately visible
ok 1323 - 9: attempt + invocation payloads — absent stays null, both sources stay separately visible
  ---
  duration_ms: 0.458084
  type: 'test'
  ...
# Subtest: 9b: the pure builders — nothing absent is invented, retry_count is 0 on a single attempt
ok 1324 - 9b: the pure builders — nothing absent is invented, retry_count is 0 on a single attempt
  ---
  duration_ms: 0.204416
  type: 'test'
  ...
# Subtest: 9c: a throwing recorder can never cost a verdict
ok 1325 - 9c: a throwing recorder can never cost a verdict
  ---
  duration_ms: 0.173875
  type: 'test'
  ...
# Subtest: 10: resolveJudgeAttribution — every row of the table, exhaustively
ok 1326 - 10: resolveJudgeAttribution — every row of the table, exhaustively
  ---
  duration_ms: 0.781709
  type: 'test'
  ...
# Subtest: transport attribution is a NON-ENUMERABLE property — no existing consumer can see it
ok 1327 - transport attribution is a NON-ENUMERABLE property — no existing consumer can see it
  ---
  duration_ms: 0.088958
  type: 'test'
  ...
# Subtest: attaching to a frozen or non-object result never throws — evidence must not cost a call
ok 1328 - attaching to a frozen or non-object result never throws — evidence must not cost a call
  ---
  duration_ms: 0.171333
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] judge attempt 1/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (body_names_other_model): served 'qwen2.5:14b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 attribution UNKNOWN (no model reported by transport or body) — verdict accepted per D-6, not retried
# [lvc] judge attempt 1/2 failed vertex 403
# [lvc] judge attempt 2/2 failed vertex 403
# [lvc] judge REFUSED (call_failed): served 'none' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed transient 429
# [lvc] judge REFUSED (force_ollama_requested): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# Subtest: D-1: the judge call body carries temperature 0, the fixed seed and top_p 1
ok 1329 - D-1: the judge call body carries temperature 0, the fixed seed and top_p 1
  ---
  duration_ms: 4.295542
  type: 'test'
  ...
# Subtest: D-1: the autoflag surface is pinned identically — one judge, one configuration
ok 1330 - D-1: the autoflag surface is pinned identically — one judge, one configuration
  ---
  duration_ms: 0.634083
  type: 'test'
  ...
# Subtest: D-2: a non-Gemini served model is retried ONCE, then the whole batch refuses
ok 1331 - D-2: a non-Gemini served model is retried ONCE, then the whole batch refuses
  ---
  duration_ms: 1.209959
  type: 'test'
  ...
# Subtest: D-2 → D-6: an EMPTY served model is UNKNOWN attribution, not a failure (see lvc-judge-attribution.test.ts)
ok 1332 - D-2 → D-6: an EMPTY served model is UNKNOWN attribution, not a failure (see lvc-judge-attribution.test.ts)
  ---
  duration_ms: 0.36425
  type: 'test'
  ...
# Subtest: D-2: a throw is retried once and then refuses — no soft-fail to a local answer
ok 1333 - D-2: a throw is retried once and then refuses — no soft-fail to a local answer
  ---
  duration_ms: 0.340416
  type: 'test'
  ...
# Subtest: D-2: a FIRST-attempt failure followed by an agreeing Gemini answer is served normally
ok 1334 - D-2: a FIRST-attempt failure followed by an agreeing Gemini answer is served normally
  ---
  duration_ms: 1.094791
  type: 'test'
  ...
# Subtest: D-2: the publisher prefix is not a disagreement — google/<slug> still serves
ok 1335 - D-2: the publisher prefix is not a disagreement — google/<slug> still serves
  ---
  duration_ms: 0.194958
  type: 'test'
  ...
# Subtest: D-2: forceOllama refuses BEFORE any call — no ollama call may serve a judge verdict
ok 1336 - D-2: forceOllama refuses BEFORE any call — no ollama call may serve a judge verdict
  ---
  duration_ms: 0.180791
  type: 'test'
  ...
# Subtest: D-2: with no Gemini available there is no slug to retry against — immediate refusal
ok 1337 - D-2: with no Gemini available there is no slug to retry against — immediate refusal
  ---
  duration_ms: 0.300041
  type: 'test'
  ...
# Subtest: D-2: the refusal event kind is the one the PRD names
ok 1338 - D-2: the refusal event kind is the one the PRD names
  ---
  duration_ms: 0.2655
  type: 'test'
  ...
# Subtest: §4: valid round tags resolve to themselves
ok 1339 - §4: valid round tags resolve to themselves
  ---
  duration_ms: 0.113167
  type: 'test'
  ...
# Subtest: §4: junk falls back to the r1 default — the route can never write an unfindable tag
ok 1340 - §4: junk falls back to the r1 default — the route can never write an unfindable tag
  ---
  duration_ms: 0.060542
  type: 'test'
  ...
# Subtest: §4: surrounding whitespace is trimmed, not rejected
ok 1341 - §4: surrounding whitespace is trimmed, not rejected
  ---
  duration_ms: 0.030417
  type: 'test'
  ...
# [lvc-wording] CDMSS-LVC-JUDGE-PINNING-PRD-v1.0-10-AUG-2026.md absent (root *.md is gitignored) — the .sql round trip is the anchor here
# Subtest: §3: seven preconditions, two retirements, nine distinct rows
ok 1342 - §3: seven preconditions, two retirements, nine distinct rows
  ---
  duration_ms: 2.858875
  type: 'test'
  ...
# Subtest: §3: the ids are exactly the ones the PRD names
ok 1343 - §3: the ids are exactly the ones the PRD names
  ---
  duration_ms: 0.3295
  type: 'test'
  ...
# Subtest: every shipped precondition round-trips byte-for-byte through the .sql record
ok 1344 - every shipped precondition round-trips byte-for-byte through the .sql record
  ---
  duration_ms: 2.90825
  type: 'test'
  ...
# Subtest: §3.2 round-trips byte-for-byte — the MERGED safety-netting record (D-5a)
ok 1345 - §3.2 round-trips byte-for-byte — the MERGED safety-netting record (D-5a)
  ---
  duration_ms: 0.184333
  type: 'test'
  ...
# Subtest: §3.8 round-trips byte-for-byte — the vitamin-D carve-out (D-5c)
ok 1346 - §3.8 round-trips byte-for-byte — the vitamin-D carve-out (D-5c)
  ---
  duration_ms: 0.178333
  type: 'test'
  ...
# Subtest: when the ratified PRD is present, every text still matches it byte-for-byte
ok 1347 - when the ratified PRD is present, every text still matches it byte-for-byte
  ---
  duration_ms: 0.376167
  type: 'test'
  ...
# Subtest: the .sql record and the shipped constants cannot drift
ok 1348 - the .sql record and the shipped constants cannot drift
  ---
  duration_ms: 0.29875
  type: 'test'
  ...
# Subtest: every shipped precondition encodes the ratified drafting convention
ok 1349 - every shipped precondition encodes the ratified drafting convention
  ---
  duration_ms: 0.39925
  type: 'test'
  ...
# Subtest: first run updates all nine rows and verifies them
ok 1350 - first run updates all nine rows and verifies them
  ---
  duration_ms: 2.179458
  type: 'test'
  ...
# Subtest: IDEMPOTENCE: the second run changes zero rows
ok 1351 - IDEMPOTENCE: the second run changes zero rows
  ---
  duration_ms: 1.805167
  type: 'test'
  ...
# Subtest: the readback runs FIRST, so a broken schema writes nothing at all
ok 1352 - the readback runs FIRST, so a broken schema writes nothing at all
  ---
  duration_ms: 0.138459
  type: 'test'
  ...
# Subtest: a dry run reads and plans without writing
ok 1353 - a dry run reads and plans without writing
  ---
  duration_ms: 0.132125
  type: 'test'
  ...
# Subtest: a missing id is reported, never silently skipped
ok 1354 - a missing id is reported, never silently skipped
  ---
  duration_ms: 0.107125
  type: 'test'
  ...
# Subtest: a row already carrying the ratified value is left alone even on the first run
ok 1355 - a row already carrying the ratified value is left alone even on the first run
  ---
  duration_ms: 0.12875
  type: 'test'
  ...
# Subtest: sameInstant compares instants, not strings — a Postgres timestamptz still verifies
ok 1356 - sameInstant compares instants, not strings — a Postgres timestamptz still verifies
  ---
  duration_ms: 0.042041
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §2/§7: LVC params (reasoning present) ⇒ no injected reasoning:{enabled:false}; the caller value survives
ok 1357 - §2/§7: LVC params (reasoning present) ⇒ no injected reasoning:{enabled:false}; the caller value survives
  ---
  duration_ms: 1.401375
  type: 'test'
  ...
# Subtest: §2/§7: a caller with NO reasoning (citation critic / Qwen3) still receives reasoning:{enabled:false}
ok 1358 - §2/§7: a caller with NO reasoning (citation critic / Qwen3) still receives reasoning:{enabled:false}
  ---
  duration_ms: 0.159042
  type: 'test'
  ...
# Subtest: §3/§7: the both-failed error contains BOTH the provider and the Ollama fallback messages
ok 1359 - §3/§7: the both-failed error contains BOTH the provider and the Ollama fallback messages
  ---
  duration_ms: 0.346417
  type: 'test'
  ...
# Subtest: §3/§7: runOllamaFallback returns the fallback result unchanged on success; throws both-failed on error
ok 1360 - §3/§7: runOllamaFallback returns the fallback result unchanged on success; throws both-failed on error
  ---
  duration_ms: 0.580625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 02a4b2bd-bd58-4f9a-b01c-236ee07b4ded
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 1cc61d04-ddb0-4a91-9f18-30af2d1e2ee9
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 20645379-a289-47e2-8f6f-e9d7e5234b6f
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall c587f8e8-2c03-4500-8565-5458c877e915
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall d6dcbc98-83a6-4d47-84c0-714f2c840e80
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 3a9996c6-4529-4573-b12b-29b243f40fa6
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 8b7fc61a-a731-4636-9792-db891b699a71
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 8808b942-6d64-42ba-92d4-3f7080cfd48b
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 6b354cde-2f36-4481-8674-6d78056db94a
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 9449d99c-5034-4724-97ad-fb6dd2b39c34
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# Subtest: 42 A1 — A/A pass 0 uses DEFAULT recall and declares with role lvc_recall on route lvc_judge_aa
ok 1361 - 42 A1 — A/A pass 0 uses DEFAULT recall and declares with role lvc_recall on route lvc_judge_aa
  ---
  duration_ms: 25.965084
  type: 'test'
  ...
# Subtest: 42 A2 — the PINNED passes declare nothing: one declaration per case, not three
ok 1362 - 42 A2 — the PINNED passes declare nothing: one declaration per case, not three
  ---
  duration_ms: 7.908083
  type: 'test'
  ...
# Subtest: 42 A3 — exactly ONE lvc_recall row per pass-0 recall, not two and not zero
ok 1363 - 42 A3 — exactly ONE lvc_recall row per pass-0 recall, not two and not zero
  ---
  duration_ms: 9.414375
  type: 'test'
  ...
# Subtest: 42 A4 — ONE CONTEXT PER REQUEST: one id across a request, and a different id for the next
ok 1364 - 42 A4 — ONE CONTEXT PER REQUEST: one id across a request, and a different id for the next
  ---
  duration_ms: 17.988875
  type: 'test'
  ...
# Subtest: 42 B5 — the appropriateness route passes unknown_route (SOURCE: its POST cannot be driven here)
ok 1365 - 42 B5 — the appropriateness route passes unknown_route (SOURCE: its POST cannot be driven here)
  ---
  duration_ms: 0.261208
  type: 'test'
  ...
# Subtest: 42 B6 — both right-care probe scripts write nothing (SOURCE: neither can be driven from a test)
ok 1366 - 42 B6 — both right-care probe scripts write nothing (SOURCE: neither can be driven from a test)
  ---
  duration_ms: 0.199209
  type: 'test'
  ...
# Subtest: 42 B7 — the A/A route's existing surface is unchanged (SOURCE: read from the diff, not a request)
ok 1367 - 42 B7 — the A/A route's existing surface is unchanged (SOURCE: read from the diff, not a request)
  ---
  duration_ms: 0.165208
  type: 'test'
  ...
# Subtest: 42 B7b — the context is minted ONCE, in GET, and threaded (SOURCE, alongside A4)
ok 1368 - 42 B7b — the context is minted ONCE, in GET, and threaded (SOURCE, alongside A4)
  ---
  duration_ms: 0.081125
  type: 'test'
  ...
# Subtest: lvc-value defaultRetrieveHits does NOT set useNormativeLeg (no normative frame in the judge prompt)
ok 1369 - lvc-value defaultRetrieveHits does NOT set useNormativeLeg (no normative frame in the judge prompt)
  ---
  duration_ms: 0.429291
  type: 'test'
  ...
# Subtest: linked: continued / newly-started / gap classified, provenance on the sides that exist
ok 1370 - linked: continued / newly-started / gap classified, provenance on the sides that exist
  ---
  duration_ms: 16.417333
  type: 'test'
  ...
# Subtest: unlinked: admission-list-only, no reconciliation rows (missing baseline stays visible)
ok 1371 - unlinked: admission-list-only, no reconciliation rows (missing baseline stays visible)
  ---
  duration_ms: 0.279041
  type: 'test'
  ...
# Subtest: linked but no pre-admission OPD meds: still admission-only (no baseline to compare)
ok 1372 - linked but no pre-admission OPD meds: still admission-only (no baseline to compare)
  ---
  duration_ms: 0.374958
  type: 'test'
  ...
# Subtest: flag off: the composition never fires — no admission occurrence is reconciled
ok 1373 - flag off: the composition never fires — no admission occurrence is reconciled
  ---
  duration_ms: 3.607833
  type: 'test'
  ...
# Subtest: med-rec ONLY: the view exposes no problem / allergy continuity field (Gate D scope)
ok 1374 - med-rec ONLY: the view exposes no problem / allergy continuity field (Gate D scope)
  ---
  duration_ms: 0.440542
  type: 'test'
  ...
# Subtest: version
ok 1375 - version
  ---
  duration_ms: 0.54
  type: 'test'
  ...
# Subtest: resolveProblemLabel: map hit, source-text preference, unknown → neutral
ok 1376 - resolveProblemLabel: map hit, source-text preference, unknown → neutral
  ---
  duration_ms: 0.552042
  type: 'test'
  ...
# Subtest: classifyProblemTier: active/background/historical (recency, recurrence, incidental)
ok 1377 - classifyProblemTier: active/background/historical (recency, recurrence, incidental)
  ---
  duration_ms: 0.311875
  type: 'test'
  ...
# Subtest: flagAbnormalLabs: banding, unit-mismatch = no flag, sex-specific, trend
ok 1378 - flagAbnormalLabs: banding, unit-mismatch = no flag, sex-specific, trend
  ---
  duration_ms: 0.568291
  type: 'test'
  ...
# Subtest: computeCareGaps: abnormal-not-rechecked > 6mo; recent excluded; normal excluded
ok 1379 - computeCareGaps: abnormal-not-rechecked > 6mo; recent excluded; normal excluded
  ---
  duration_ms: 0.289542
  type: 'test'
  ...
# Subtest: computePictureConfidence: Ravali-like → THIN; in-person recent → GOOD
ok 1380 - computePictureConfidence: Ravali-like → THIN; in-person recent → GOOD
  ---
  duration_ms: 0.280209
  type: 'test'
  ...
# Subtest: buildVitalsView: numbers + EWS surfaced when present; honest absence otherwise
ok 1381 - buildVitalsView: numbers + EWS surfaced when present; honest absence otherwise
  ---
  duration_ms: 0.289667
  type: 'test'
  ...
# Subtest: buildAttentionFlags: medication conflict + critical lab surface as flags
ok 1382 - buildAttentionFlags: medication conflict + critical lab surface as flags
  ---
  duration_ms: 0.233709
  type: 'test'
  ...
# Subtest: patch/1: canonicalAnalyte tolerant match — real Vit D db name → severe band
ok 1383 - patch/1: canonicalAnalyte tolerant match — real Vit D db name → severe band
  ---
  duration_ms: 0.207916
  type: 'test'
  ...
# Subtest: patch/1: real Vit D (8.01 ng/mL) surfaces in labs, gaps AND attention
ok 1384 - patch/1: real Vit D (8.01 ng/mL) surfaces in labs, gaps AND attention
  ---
  duration_ms: 0.408375
  type: 'test'
  ...
# Subtest: patch/2: safety-net item is SURFACED (labs) but NOT PROMOTED (no gap, no attention flag)
ok 1385 - patch/2: safety-net item is SURFACED (labs) but NOT PROMOTED (no gap, no attention flag)
  ---
  duration_ms: 0.079416
  type: 'test'
  ...
# Subtest: patch/2: latest source-NORMAL + no range → NOT surfaced (nothing over-flagged)
ok 1386 - patch/2: latest source-NORMAL + no range → NOT surfaced (nothing over-flagged)
  ---
  duration_ms: 0.064917
  type: 'test'
  ...
# Subtest: patch/3: trend de-clutter — stable repeats collapse, differing values surface
ok 1387 - patch/3: trend de-clutter — stable repeats collapse, differing values surface
  ---
  duration_ms: 0.069875
  type: 'test'
  ...
# Subtest: determinism: fns twice → deep-equal
ok 1388 - determinism: fns twice → deep-equal
  ---
  duration_ms: 0.153292
  type: 'test'
  ...
# Subtest: inv1 / stratum4: problem omitted at a later encounter → uncertain_current_status, never resolved
ok 1389 - inv1 / stratum4: problem omitted at a later encounter → uncertain_current_status, never resolved
  ---
  duration_ms: 2.074542
  type: 'test'
  ...
# Subtest: inv1 / stratum3: explicit later resolved → documented_resolved
ok 1390 - inv1 / stratum3: explicit later resolved → documented_resolved
  ---
  duration_ms: 0.14425
  type: 'test'
  ...
# Subtest: inv2: empty memberRef is a hard error (single-member invariant)
ok 1391 - inv2: empty memberRef is a hard error (single-member invariant)
  ---
  duration_ms: 0.143708
  type: 'test'
  ...
# Subtest: inv3: two distinct raws with no dictionary hit stay separate (no fuzzy merge)
ok 1392 - inv3: two distinct raws with no dictionary hit stay separate (no fuzzy merge)
  ---
  duration_ms: 0.23275
  type: 'test'
  ...
# Subtest: inv4 + inv5: every occurrence carries provenance and the derived status keeps its occurrences
ok 1393 - inv4 + inv5: every occurrence carries provenance and the derived status keeps its occurrences
  ---
  duration_ms: 0.181
  type: 'test'
  ...
# Subtest: inv6 / stratum5: contradictory allergy → reported_allergy AND a safety_critical status_conflict
ok 1394 - inv6 / stratum5: contradictory allergy → reported_allergy AND a safety_critical status_conflict
  ---
  duration_ms: 0.406208
  type: 'test'
  ...
# Subtest: inv7: buildMemberState is reproducible — same evidence + versions → deep-equal
ok 1395 - inv7: buildMemberState is reproducible — same evidence + versions → deep-equal
  ---
  duration_ms: 0.768375
  type: 'test'
  ...
# Subtest: inv7 / stratum13: buildMemberState does not mutate input; corrected evidence → corrected snapshot
ok 1396 - inv7 / stratum13: buildMemberState does not mutate input; corrected evidence → corrected snapshot
  ---
  duration_ms: 0.202042
  type: 'test'
  ...
# Subtest: inv9: version + as-of metadata is mandatory and stamped
ok 1397 - inv9: version + as-of metadata is mandatory and stamped
  ---
  duration_ms: 0.208041
  type: 'test'
  ...
# Subtest: inv10: unresolved concept flows through as data (null id, relation unresolved)
ok 1398 - inv10: unresolved concept flows through as data (null id, relation unresolved)
  ---
  duration_ms: 0.856084
  type: 'test'
  ...
# Subtest: stratum1: persistent chronic (multi-touch, span>1yr, no long gap) → persistent + active
ok 1399 - stratum1: persistent chronic (multi-touch, span>1yr, no long gap) → persistent + active
  ---
  duration_ms: 0.092583
  type: 'test'
  ...
# Subtest: stratum2: recurrent (present → long gap → present) → recurrent [EPISODIC concept]
ok 1400 - stratum2: recurrent (present → long gap → present) → recurrent [EPISODIC concept]
  ---
  duration_ms: 0.071875
  type: 'test'
  ...
# Subtest: R1: a chronic concept re-documented ≥2× is persistent regardless of gap length
ok 1401 - R1: a chronic concept re-documented ≥2× is persistent regardless of gap length
  ---
  duration_ms: 0.07625
  type: 'test'
  ...
# Subtest: R1 guard: an episodic concept with dense touches within a year is NOT forced persistent
ok 1402 - R1 guard: an episodic concept with dense touches within a year is NOT forced persistent
  ---
  duration_ms: 0.055458
  type: 'test'
  ...
# Subtest: R2: patient-reported stop then a LATER prescription → status stopped + one medication/temporal_conflict/review (both provenances)
ok 1403 - R2: patient-reported stop then a LATER prescription → status stopped + one medication/temporal_conflict/review (both provenances)
  ---
  duration_ms: 0.167125
  type: 'test'
  ...
# Subtest: R2 guard: prescribe THEN patient-reported stop (no re-script) stays a status_conflict, not temporal
ok 1404 - R2 guard: prescribe THEN patient-reported stop (no re-script) stays a status_conflict, not temporal
  ---
  duration_ms: 0.084209
  type: 'test'
  ...
# Subtest: stratum6: medication prescribed → status prescribed, currentness never inferred to taking
ok 1405 - stratum6: medication prescribed → status prescribed, currentness never inferred to taking
  ---
  duration_ms: 0.05
  type: 'test'
  ...
# Subtest: stratum7: medication explicitly stopped → status stopped + a medication status_conflict
ok 1406 - stratum7: medication explicitly stopped → status stopped + a medication status_conflict
  ---
  duration_ms: 0.064042
  type: 'test'
  ...
# Subtest: stratum8: broader/narrower wording NOT merged (diabetes vs type-2-diabetes → 2 problems)
ok 1407 - stratum8: broader/narrower wording NOT merged (diabetes vs type-2-diabetes → 2 problems)
  ---
  duration_ms: 0.050209
  type: 'test'
  ...
# Subtest: stratum9: same analyte, different units → one series, unit null, value_conflict Discrepancy
ok 1408 - stratum9: same analyte, different units → one series, unit null, value_conflict Discrepancy
  ---
  duration_ms: 0.082
  type: 'test'
  ...
# Subtest: stratum10: abnormal→normal investigation series is date-ordered, unit preserved
ok 1409 - stratum10: abnormal→normal investigation series is date-ordered, unit preserved
  ---
  duration_ms: 0.0645
  type: 'test'
  ...
# Subtest: stratum12: two simultaneous conditions → two parallel problems
ok 1410 - stratum12: two simultaneous conditions → two parallel problems
  ---
  duration_ms: 0.094084
  type: 'test'
  ...
# Subtest: stratum14: "rule out PE" is never merged with confirmed PE
ok 1411 - stratum14: "rule out PE" is never merged with confirmed PE
  ---
  duration_ms: 0.057792
  type: 'test'
  ...
# Subtest: demographic identity_conflict: sex flip across encounters → review Discrepancy
ok 1412 - demographic identity_conflict: sex flip across encounters → review Discrepancy
  ---
  duration_ms: 0.13125
  type: 'test'
  ...
# Subtest: single occurrence → single_episode course
ok 1413 - single occurrence → single_episode course
  ---
  duration_ms: 0.039
  type: 'test'
  ...
# Subtest: normal aging does NOT raise an identity_conflict (consistent birth year)
ok 1414 - normal aging does NOT raise an identity_conflict (consistent birth year)
  ---
  duration_ms: 0.041125
  type: 'test'
  ...
# Subtest: assembleEvidence: prescription row → opd EncounterEvidence (meds, denied allergy, icd problem, demographics)
ok 1415 - assembleEvidence: prescription row → opd EncounterEvidence (meds, denied allergy, icd problem, demographics)
  ---
  duration_ms: 1.581125
  type: 'test'
  ...
# Subtest: assembleEvidence: lab rows → lab encounters grouped by booking, investigation points
ok 1416 - assembleEvidence: lab rows → lab encounters grouped by booking, investigation points
  ---
  duration_ms: 0.288042
  type: 'test'
  ...
# Subtest: assembleEvidence → buildMemberState: creatinine series spans both bookings, unit consistent
ok 1417 - assembleEvidence → buildMemberState: creatinine series spans both bookings, unit consistent
  ---
  duration_ms: 1.8065
  type: 'test'
  ...
# Subtest: assembleEvidence: identifier-free — no name/mobile/dob leaks into evidence
ok 1418 - assembleEvidence: identifier-free — no name/mobile/dob leaks into evidence
  ---
  duration_ms: 0.235083
  type: 'test'
  ...
# Subtest: assembleEvidence: diagnosis_icd_codes bare-string arrays — empty elements/arrays skipped
ok 1419 - assembleEvidence: diagnosis_icd_codes bare-string arrays — empty elements/arrays skipped
  ---
  duration_ms: 0.2505
  type: 'test'
  ...
# Subtest: assembleEvidence: malformed / missing rows degrade to empty, never throw
ok 1420 - assembleEvidence: malformed / missing rows degrade to empty, never throw
  ---
  duration_ms: 0.134583
  type: 'test'
  ...
# Subtest: careCallOutcomeToEncounter: stopped+reason → care_call encounter, identifier-free, deterministic
ok 1421 - careCallOutcomeToEncounter: stopped+reason → care_call encounter, identifier-free, deterministic
  ---
  duration_ms: 1.286708
  type: 'test'
  ...
# Subtest: careCallOutcomeToEncounter: complaint resolved → complaintStatuses; empty derived → empty arrays
ok 1422 - careCallOutcomeToEncounter: complaint resolved → complaintStatuses; empty derived → empty arrays
  ---
  duration_ms: 0.587709
  type: 'test'
  ...
# Subtest: Patch B: care-call encounter dated at called_at (fresh observation), not the episode note_date
ok 1423 - Patch B: care-call encounter dated at called_at (fresh observation), not the episode note_date
  ---
  duration_ms: 0.233292
  type: 'test'
  ...
# Subtest: loop closure: opd prescribes X + care_call reports X stopped → frozen buildMemberState currentness = stopped
ok 1424 - loop closure: opd prescribes X + care_call reports X stopped → frozen buildMemberState currentness = stopped
  ---
  duration_ms: 2.698625
  type: 'test'
  ...
# Subtest: loop closure R2: a LATER re-prescription after the patient-reported stop → medication/temporal_conflict/review
ok 1425 - loop closure R2: a LATER re-prescription after the patient-reported stop → medication/temporal_conflict/review
  ---
  duration_ms: 0.227458
  type: 'test'
  ...
# Subtest: gold seed is FROZEN: 20 strata, every case ratified:true, member-bank/1.0
ok 1426 - gold seed is FROZEN: 20 strata, every case ratified:true, member-bank/1.0
  ---
  duration_ms: 0.559
  type: 'test'
  ...
# Subtest: frozen baseline member-state-baseline/1.0: the seed clears every floor (no breaches)
ok 1427 - frozen baseline member-state-baseline/1.0: the seed clears every floor (no breaches)
  ---
  duration_ms: 3.364916
  type: 'test'
  ...
# Subtest: HARD gates hold for EVERY case: retention/provenance/trust 100%, incorrect-resolution 0
ok 1428 - HARD gates hold for EVERY case: retention/provenance/trust 100%, incorrect-resolution 0
  ---
  duration_ms: 1.72225
  type: 'test'
  ...
# Subtest: EVERY invariant-class case scores zero invariantViolations against the frozen core
ok 1429 - EVERY invariant-class case scores zero invariantViolations against the frozen core
  ---
  duration_ms: 1.06425
  type: 'test'
  ...
# Subtest: S3: explicit resolution → documented_resolved
ok 1430 - S3: explicit resolution → documented_resolved
  ---
  duration_ms: 0.244709
  type: 'test'
  ...
# Subtest: S4: omitted later → uncertain, never resolved
ok 1431 - S4: omitted later → uncertain, never resolved
  ---
  duration_ms: 0.184292
  type: 'test'
  ...
# Subtest: S5: allergy reported dominates denied + safety_critical conflict
ok 1432 - S5: allergy reported dominates denied + safety_critical conflict
  ---
  duration_ms: 0.187208
  type: 'test'
  ...
# Subtest: S6: prescribed, currentness never inferred to taking
ok 1433 - S6: prescribed, currentness never inferred to taking
  ---
  duration_ms: 0.1555
  type: 'test'
  ...
# Subtest: S8: broader/narrower not merged → 2 distinct problems
ok 1434 - S8: broader/narrower not merged → 2 distinct problems
  ---
  duration_ms: 0.2205
  type: 'test'
  ...
# Subtest: S9: mixed units → unit:null + value_conflict
ok 1435 - S9: mixed units → unit:null + value_conflict
  ---
  duration_ms: 0.392583
  type: 'test'
  ...
# Subtest: S12: two simultaneous → 2 parallel problems
ok 1436 - S12: two simultaneous → 2 parallel problems
  ---
  duration_ms: 0.076541
  type: 'test'
  ...
# Subtest: S14: "rule out PE" not merged with confirmed PE
ok 1437 - S14: "rule out PE" not merged with confirmed PE
  ---
  duration_ms: 0.053417
  type: 'test'
  ...
# Subtest: S15: patient complaint resolved → documented_resolved occurrence (explicit, not silence)
ok 1438 - S15: patient complaint resolved → documented_resolved occurrence (explicit, not silence)
  ---
  duration_ms: 0.062625
  type: 'test'
  ...
# Subtest: S16: patient-reported stopped overrides prescription
ok 1439 - S16: patient-reported stopped overrides prescription
  ---
  duration_ms: 0.061291
  type: 'test'
  ...
# Subtest: S17: allergy trust-conflict records BOTH trusts in the Discrepancy detail
ok 1440 - S17: allergy trust-conflict records BOTH trusts in the Discrepancy detail
  ---
  duration_ms: 0.117708
  type: 'test'
  ...
# Subtest: S18: followUps carried, deduped by id, no overlay
ok 1441 - S18: followUps carried, deduped by id, no overlay
  ---
  duration_ms: 0.135291
  type: 'test'
  ...
# Subtest: S20: neutrality — zero patient-reported → empty followUps + 1.0 statuses
ok 1442 - S20: neutrality — zero patient-reported → empty followUps + 1.0 statuses
  ---
  duration_ms: 0.063333
  type: 'test'
  ...
# Subtest: S1: chronic re-documented across years → persistent (R1 chronicity fix)
ok 1443 - S1: chronic re-documented across years → persistent (R1 chronicity fix)
  ---
  duration_ms: 0.054791
  type: 'test'
  ...
# Subtest: S2: episodic present-gap-present → recurrent (unchanged by R1)
ok 1444 - S2: episodic present-gap-present → recurrent (unchanged by R1)
  ---
  duration_ms: 0.050208
  type: 'test'
  ...
# Subtest: S7: explicit stopped reflected in status
ok 1445 - S7: explicit stopped reflected in status
  ---
  duration_ms: 0.0485
  type: 'test'
  ...
# Subtest: S19: keeps stopped after a re-prescription + one medication/temporal_conflict/review (both trusts)
ok 1446 - S19: keeps stopped after a re-prescription + one medication/temporal_conflict/review (both trusts)
  ---
  duration_ms: 0.066125
  type: 'test'
  ...
# Subtest: S13: evidence is not mutated; a corrected copy recomputes to a different snapshot
ok 1447 - S13: evidence is not mutated; a corrected copy recomputes to a different snapshot
  ---
  duration_ms: 0.131542
  type: 'test'
  ...
# Subtest: aggregate over the full seed: retention 1.0, zero invariant violations, zero incorrect resolutions
ok 1448 - aggregate over the full seed: retention 1.0, zero invariant violations, zero incorrect resolutions
  ---
  duration_ms: 0.42175
  type: 'test'
  ...
# Subtest: normalizeConcept: exact hit → relation exact + canonical id
ok 1449 - normalizeConcept: exact hit → relation exact + canonical id
  ---
  duration_ms: 0.93575
  type: 'test'
  ...
# Subtest: normalizeConcept: synonym hit → relation synonym, same canonical id
ok 1450 - normalizeConcept: synonym hit → relation synonym, same canonical id
  ---
  duration_ms: 0.216625
  type: 'test'
  ...
# Subtest: normalizeConcept: no dictionary hit → unresolved (null id), never a guess
ok 1451 - normalizeConcept: no dictionary hit → unresolved (null id), never a guess
  ---
  duration_ms: 0.131333
  type: 'test'
  ...
# Subtest: normalizeConcept: broader/narrower are NEVER merged (diabetes ≠ type-2-diabetes)
ok 1452 - normalizeConcept: broader/narrower are NEVER merged (diabetes ≠ type-2-diabetes)
  ---
  duration_ms: 0.082834
  type: 'test'
  ...
# Subtest: normalizeConcept: domain-scoped dictionaries (creatinine only resolves as investigation)
ok 1453 - normalizeConcept: domain-scoped dictionaries (creatinine only resolves as investigation)
  ---
  duration_ms: 0.125459
  type: 'test'
  ...
# Subtest: normalizeConcept: deterministic — same input → identical result
ok 1454 - normalizeConcept: deterministic — same input → identical result
  ---
  duration_ms: 0.359208
  type: 'test'
  ...
# Subtest: groupingKey: resolved → canonical id; two unresolved merge only on identical normalized raw
ok 1455 - groupingKey: resolved → canonical id; two unresolved merge only on identical normalized raw
  ---
  duration_ms: 0.115
  type: 'test'
  ...
# Subtest: normalizeRaw: lowercases, strips punctuation, collapses whitespace
ok 1456 - normalizeRaw: lowercases, strips punctuation, collapses whitespace
  ---
  duration_ms: 0.046125
  type: 'test'
  ...
# Subtest: complaint resolved → problem documented_resolved (explicit signal)
ok 1457 - complaint resolved → problem documented_resolved (explicit signal)
  ---
  duration_ms: 1.600167
  type: 'test'
  ...
# Subtest: complaint worse → active (never resolved)
ok 1458 - complaint worse → active (never resolved)
  ---
  duration_ms: 0.138208
  type: 'test'
  ...
# Subtest: resolved-then-silent stays resolved (a later unrelated encounter does not re-open it)
ok 1459 - resolved-then-silent stays resolved (a later unrelated encounter does not re-open it)
  ---
  duration_ms: 0.29025
  type: 'test'
  ...
# Subtest: a complaint whose concept matches no documented problem still forms its own problem
ok 1460 - a complaint whose concept matches no documented problem still forms its own problem
  ---
  duration_ms: 1.635875
  type: 'test'
  ...
# Subtest: patient-reported stopped overrides a prescription prescribed
ok 1461 - patient-reported stopped overrides a prescription prescribed
  ---
  duration_ms: 0.771709
  type: 'test'
  ...
# Subtest: patient-reported reported_taking sets taking; currentness not synthesized otherwise
ok 1462 - patient-reported reported_taking sets taking; currentness not synthesized otherwise
  ---
  duration_ms: 0.1205
  type: 'test'
  ...
# Subtest: most-recent patient-reported wins over an older patient-reported
ok 1463 - most-recent patient-reported wins over an older patient-reported
  ---
  duration_ms: 0.140333
  type: 'test'
  ...
# Subtest: stopReason is carried on the occurrence
ok 1464 - stopReason is carried on the occurrence
  ---
  duration_ms: 0.068708
  type: 'test'
  ...
# Subtest: patient_reported denied + structured_db reported_allergy → reported_allergy + safety_critical conflict recording both trusts
ok 1465 - patient_reported denied + structured_db reported_allergy → reported_allergy + safety_critical conflict recording both trusts
  ---
  duration_ms: 0.972542
  type: 'test'
  ...
# Subtest: followUps carried onto the snapshot, deduped by id, date-sorted
ok 1466 - followUps carried onto the snapshot, deduped by id, date-sorted
  ---
  duration_ms: 1.664083
  type: 'test'
  ...
# Subtest: neutrality: no patient-reported evidence → 1.0 behaviour + empty followUps
ok 1467 - neutrality: no patient-reported evidence → 1.0 behaviour + empty followUps
  ---
  duration_ms: 0.151833
  type: 'test'
  ...
# Subtest: version + provenance passthrough
ok 1468 - version + provenance passthrough
  ---
  duration_ms: 1.713333
  type: 'test'
  ...
# Subtest: course: chronic re-documented → Persistent (warn)
ok 1469 - course: chronic re-documented → Persistent (warn)
  ---
  duration_ms: 0.818417
  type: 'test'
  ...
# Subtest: status: an omitted/silent problem renders Uncertain, NEVER Active
ok 1470 - status: an omitted/silent problem renders Uncertain, NEVER Active
  ---
  duration_ms: 0.280458
  type: 'test'
  ...
# Subtest: medication currentness: prescribed carries "not confirmed taken"; stopped → Stopped
ok 1471 - medication currentness: prescribed carries "not confirmed taken"; stopped → Stopped
  ---
  duration_ms: 0.157333
  type: 'test'
  ...
# Subtest: allergy: reported_allergy + matching allergy Discrepancy → conflicted:true, critical
ok 1472 - allergy: reported_allergy + matching allergy Discrepancy → conflicted:true, critical
  ---
  duration_ms: 0.134458
  type: 'test'
  ...
# Subtest: series: two-point HbA1c → direction down; mixed-unit creatinine → mixedUnits true
ok 1473 - series: two-point HbA1c → direction down; mixed-unit creatinine → mixedUnits true
  ---
  duration_ms: 0.131542
  type: 'test'
  ...
# Subtest: conflicts sorted safety_critical → review → informational; counts.safetyCritical
ok 1474 - conflicts sorted safety_critical → review → informational; counts.safetyCritical
  ---
  duration_ms: 0.303625
  type: 'test'
  ...
# Subtest: counts reflect the view arrays
ok 1475 - counts reflect the view arrays
  ---
  duration_ms: 0.117334
  type: 'test'
  ...
# Subtest: Patch A: view dates render as YYYY-MM-DD (dayOnly, idempotent on already-day strings)
ok 1476 - Patch A: view dates render as YYYY-MM-DD (dayOnly, idempotent on already-day strings)
  ---
  duration_ms: 2.094125
  type: 'test'
  ...
# Subtest: presentMemberState is deterministic (twice → deep-equal)
ok 1477 - presentMemberState is deterministic (twice → deep-equal)
  ---
  duration_ms: 1.22025
  type: 'test'
  ...
# Subtest: version constants are the Stage-0 pinned triple
ok 1478 - version constants are the Stage-0 pinned triple
  ---
  duration_ms: 0.356959
  type: 'test'
  ...
# Subtest: emptyMemberStateSnapshot: passed-in computedAt/asOf, empty arrays, passes zod
ok 1479 - emptyMemberStateSnapshot: passed-in computedAt/asOf, empty arrays, passes zod
  ---
  duration_ms: 1.058709
  type: 'test'
  ...
# Subtest: a built snapshot validates against the zod schema
ok 1480 - a built snapshot validates against the zod schema
  ---
  duration_ms: 1.504208
  type: 'test'
  ...
# Subtest: version constant
ok 1481 - version constant
  ---
  duration_ms: 1.090541
  type: 'test'
  ...
# Subtest: retention/provenance/trust-provenance = 1.0 on well-formed input
ok 1482 - retention/provenance/trust-provenance = 1.0 on well-formed input
  ---
  duration_ms: 2.788084
  type: 'test'
  ...
# Subtest: falseMerges=1 when two distinct expected concepts collapse (synonyms merge)
ok 1483 - falseMerges=1 when two distinct expected concepts collapse (synonyms merge)
  ---
  duration_ms: 0.271
  type: 'test'
  ...
# Subtest: falseSplits=1 when one expected concept becomes two entities
ok 1484 - falseSplits=1 when one expected concept becomes two entities
  ---
  duration_ms: 0.421334
  type: 'test'
  ...
# Subtest: conflictRecall [1,1] on a seeded allergy conflict
ok 1485 - conflictRecall [1,1] on a seeded allergy conflict
  ---
  duration_ms: 1.262792
  type: 'test'
  ...
# Subtest: problemCourseAgree [1,1] on a correctly-scored course
ok 1486 - problemCourseAgree [1,1] on a correctly-scored course
  ---
  duration_ms: 0.601667
  type: 'test'
  ...
# Subtest: incorrectResolutions=1 for a documented_resolved occurrence with no explicit basis
ok 1487 - incorrectResolutions=1 for a documented_resolved occurrence with no explicit basis
  ---
  duration_ms: 1.873584
  type: 'test'
  ...
# Subtest: scoreCase is deterministic (twice → deep-equal)
ok 1488 - scoreCase is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.245458
  type: 'test'
  ...
# Subtest: aggregate rolls up the Part-C metric set
ok 1489 - aggregate rolls up the Part-C metric set
  ---
  duration_ms: 0.345833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: prescriptionsSql is byte-identical to shadow.mjs (drift fails CI)
ok 1490 - prescriptionsSql is byte-identical to shadow.mjs (drift fails CI)
  ---
  duration_ms: 0.544875
  type: 'test'
  ...
# Subtest: labsSql is byte-identical to shadow.mjs (drift fails CI)
ok 1491 - labsSql is byte-identical to shadow.mjs (drift fails CI)
  ---
  duration_ms: 0.124375
  type: 'test'
  ...
# Subtest: individualForPrescSql: pinned shape + injection guard (bad uid throws)
ok 1492 - individualForPrescSql: pinned shape + injection guard (bad uid throws)
  ---
  duration_ms: 0.232875
  type: 'test'
  ...
# Subtest: individualUidForPresc: a bad uid returns null WITHOUT touching the DB
ok 1493 - individualUidForPresc: a bad uid returns null WITHOUT touching the DB
  ---
  duration_ms: 0.078167
  type: 'test'
  ...
# Subtest: vitalsEver true → GREEN with the unchanged label, whatever the modality
ok 1494 - vitalsEver true → GREEN with the unchanged label, whatever the modality
  ---
  duration_ms: 0.80525
  type: 'test'
  ...
# Subtest: vitalsEver false + majority unknown → AMBER, with the new label
ok 1495 - vitalsEver false + majority unknown → AMBER, with the new label
  ---
  duration_ms: 0.111417
  type: 'test'
  ...
# Subtest: vitalsEver false + majority remote + inPerson 0 → RED, label BYTE-IDENTICAL to today
ok 1496 - vitalsEver false + majority remote + inPerson 0 → RED, label BYTE-IDENTICAL to today
  ---
  duration_ms: 0.104625
  type: 'test'
  ...
# Subtest: vitalsEver false + inPerson > 0 → AMBER, label BYTE-IDENTICAL to today
ok 1497 - vitalsEver false + inPerson > 0 → AMBER, label BYTE-IDENTICAL to today
  ---
  duration_ms: 0.05725
  type: 'test'
  ...
# Subtest: the no-visits variant of the old label is preserved (opd 0 ⇒ no count suffix)
ok 1498 - the no-visits variant of the old label is preserved (opd 0 ⇒ no count suffix)
  ---
  duration_ms: 0.055458
  type: 'test'
  ...
# Subtest: the vitals factor stays counted: true in every case
ok 1499 - the vitals factor stays counted: true in every case
  ---
  duration_ms: 0.226
  type: 'test'
  ...
# Subtest: the MODALITY factor is unaffected in all four cases — this build did not touch it
ok 1500 - the MODALITY factor is unaffected in all four cases — this build did not touch it
  ---
  duration_ms: 0.099541
  type: 'test'
  ...
# Subtest: the contact and labs factors are unaffected
ok 1501 - the contact and labs factors are unaffected
  ---
  duration_ms: 0.355792
  type: 'test'
  ...
# Subtest: the unknown case is reachable through the OR, and remote is not
ok 1502 - the unknown case is reachable through the OR, and remote is not
  ---
  duration_ms: 3.554125
  type: 'test'
  ...
# Subtest: D-B case 1 — ALL rows documented: the ladder is unchanged
ok 1503 - D-B case 1 — ALL rows documented: the ladder is unchanged
  ---
  duration_ms: 0.547667
  type: 'test'
  ...
# Subtest: D-B case 2 — NO rows documented with total > 0 ⇒ majority unknown
ok 1504 - D-B case 2 — NO rows documented with total > 0 ⇒ majority unknown
  ---
  duration_ms: 0.083792
  type: 'test'
  ...
# Subtest: D-B case 3 — total === 0 still returns unknown, as it always did
ok 1505 - D-B case 3 — total === 0 still returns unknown, as it always did
  ---
  duration_ms: 0.057458
  type: 'test'
  ...
# Subtest: picture confidence: unknown is AMBER, still counted, with the exact label
ok 1506 - picture confidence: unknown is AMBER, still counted, with the exact label
  ---
  duration_ms: 0.274834
  type: 'test'
  ...
# Subtest: picture confidence: in_person, mixed and remote branches are byte-identical
ok 1507 - picture confidence: in_person, mixed and remote branches are byte-identical
  ---
  duration_ms: 0.15275
  type: 'test'
  ...
# Subtest: buildVitalsView: unknown gets the exact note; the other branch is unchanged
ok 1508 - buildVitalsView: unknown gets the exact note; the other branch is unchanged
  ---
  duration_ms: 0.607709
  type: 'test'
  ...
# Subtest: the call-context sentence no longer claims remote care when the modality is unknown
ok 1509 - the call-context sentence no longer claims remote care when the modality is unknown
  ---
  duration_ms: 0.495458
  type: 'test'
  ...
# Subtest: THE JOIN KEY: consult_uid is matched FIRST, prescription_uid is the fallback
ok 1510 - THE JOIN KEY: consult_uid is matched FIRST, prescription_uid is the fallback
  ---
  duration_ms: 0.081792
  type: 'test'
  ...
# Subtest: the vitals SELECT now carries consult_uid, and fetchRows exposes it
ok 1511 - the vitals SELECT now carries consult_uid, and fetchRows exposes it
  ---
  duration_ms: 0.213333
  type: 'test'
  ...
# Subtest: the resolver copies individualUidForPresc: isUid guard, LIMIT 1, soft-fail
ok 1512 - the resolver copies individualUidForPresc: isUid guard, LIMIT 1, soft-fail
  ---
  duration_ms: 1.478583
  type: 'test'
  ...
# Subtest: readEncounterVitals still never throws, and readMemberVitals is untouched
ok 1513 - readEncounterVitals still never throws, and readMemberVitals is untouched
  ---
  duration_ms: 0.141667
  type: 'test'
  ...
# Subtest: Gate D · no regression: every ratified gold case is byte-identical flag-on vs flag-off
ok 1514 - Gate D · no regression: every ratified gold case is byte-identical flag-on vs flag-off
  ---
  duration_ms: 4.432042
  type: 'test'
  ...
# Subtest: Gate D · additive-only: composing an admission preserves every baseline occurrence, all deltas admission-anchored
ok 1515 - Gate D · additive-only: composing an admission preserves every baseline occurrence, all deltas admission-anchored
  ---
  duration_ms: 3.224375
  type: 'test'
  ...
# Subtest: Gate D · flag-off: the fixture is byte-identical to the frozen spine (composition does not fire)
ok 1516 - Gate D · flag-off: the fixture is byte-identical to the frozen spine (composition does not fire)
  ---
  duration_ms: 0.176041
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: every relation has a ratified status, and every ratified status has a relation
ok 1517 - every relation has a ratified status, and every ratified status has a relation
  ---
  duration_ms: 0.787917
  type: 'test'
  ...
# Subtest: no relation THREW — a crash is never a legitimate relation outcome
ok 1518 - no relation THREW — a crash is never a legitimate relation outcome
  ---
  duration_ms: 0.132416
  type: 'test'
  ...
# Subtest: D-1 Dose context is read — holds
ok 1519 - D-1 Dose context is read — holds
  ---
  duration_ms: 0.049458
  type: 'test'
  ...
# Subtest: D-2 Dose context, inverse — holds
ok 1520 - D-2 Dose context, inverse — holds
  ---
  duration_ms: 0.030167
  type: 'test'
  ...
# Subtest: D-3 SOS cap is applied — holds
ok 1521 - D-3 SOS cap is applied — holds
  ---
  duration_ms: 0.0345
  type: 'test'
  ...
# Subtest: D-4 Dose completeness — holds
ok 1522 - D-4 Dose completeness — holds
  ---
  duration_ms: 0.026875
  type: 'test'
  ...
# Subtest: D-5 Formulation is read — reproduces the observed defect (pinned)
ok 1523 - D-5 Formulation is read — reproduces the observed defect (pinned)
  ---
  duration_ms: 0.025875
  type: 'test'
  ...
# Subtest: D-6 Interaction needs both members — holds
ok 1524 - D-6 Interaction needs both members — holds
  ---
  duration_ms: 0.075084
  type: 'test'
  ...
# Subtest: D-7 Interaction ignores non-analgesic dose — holds
ok 1525 - D-7 Interaction ignores non-analgesic dose — holds
  ---
  duration_ms: 0.171125
  type: 'test'
  ...
# Subtest: G-1 Order independence — holds
ok 1526 - G-1 Order independence — holds
  ---
  duration_ms: 0.241834
  type: 'test'
  ...
# Subtest: G-2 Unrelated addition — holds
ok 1527 - G-2 Unrelated addition — holds
  ---
  duration_ms: 0.03275
  type: 'test'
  ...
# Subtest: G-3 Empty-field safety — holds
ok 1528 - G-3 Empty-field safety — holds
  ---
  duration_ms: 0.02525
  type: 'test'
  ...
# Subtest: G-4 Unit invariance — holds
ok 1529 - G-4 Unit invariance — holds
  ---
  duration_ms: 0.020875
  type: 'test'
  ...
# Subtest: G-5 Duplicate line — holds
ok 1530 - G-5 Duplicate line — holds
  ---
  duration_ms: 0.020209
  type: 'test'
  ...
# Subtest: G-6 Teleconsult context — holds
ok 1531 - G-6 Teleconsult context — holds
  ---
  duration_ms: 0.02
  type: 'test'
  ...
# Subtest: G-7 Referral handoff — holds
ok 1532 - G-7 Referral handoff — holds
  ---
  duration_ms: 0.060041
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: removes: base HAS the state, transformed does NOT → HOLDS
ok 1533 - removes: base HAS the state, transformed does NOT → HOLDS
  ---
  duration_ms: 0.67225
  type: 'test'
  ...
# Subtest: removes: base HAS the state, transformed STILL has it → FAILS
ok 1534 - removes: base HAS the state, transformed STILL has it → FAILS
  ---
  duration_ms: 0.071125
  type: 'test'
  ...
# Subtest: removes: base LACKS the state → VACUOUS, with today's exact reason string
ok 1535 - removes: base LACKS the state → VACUOUS, with today's exact reason string
  ---
  duration_ms: 0.068917
  type: 'test'
  ...
# Subtest: adds: base LACKS the state, transformed HAS it → HOLDS
ok 1536 - adds: base LACKS the state, transformed HAS it → HOLDS
  ---
  duration_ms: 0.053333
  type: 'test'
  ...
# Subtest: adds: base LACKS the state, transformed ALSO lacks it → FAILS
ok 1537 - adds: base LACKS the state, transformed ALSO lacks it → FAILS
  ---
  duration_ms: 0.047625
  type: 'test'
  ...
# Subtest: adds: base ALREADY fires → VACUOUS with the new reason, and NEVER HOLDS
ok 1538 - adds: base ALREADY fires → VACUOUS with the new reason, and NEVER HOLDS
  ---
  duration_ms: 0.061791
  type: 'test'
  ...
# Subtest: L-1 fires on a finding naming the antibiotic
ok 1539 - L-1 fires on a finding naming the antibiotic
  ---
  duration_ms: 0.198958
  type: 'test'
  ...
# Subtest: L-1 does NOT fire on a finding whose only match is the word cellulitis — the original defect
ok 1540 - L-1 does NOT fire on a finding whose only match is the word cellulitis — the original defect
  ---
  duration_ms: 0.096958
  type: 'test'
  ...
# Subtest: L-1 ignores informational findings and praise
ok 1541 - L-1 ignores informational findings and praise
  ---
  duration_ms: 0.208542
  type: 'test'
  ...
# Subtest: L-1: ONLY the symptom line and the diagnosis text change between the arms
ok 1542 - L-1: ONLY the symptom line and the diagnosis text change between the arms
  ---
  duration_ms: 0.704708
  type: 'test'
  ...
# Subtest: L-2: the DRUGS stay and the REASON goes
ok 1543 - L-2: the DRUGS stay and the REASON goes
  ---
  duration_ms: 0.097
  type: 'test'
  ...
# Subtest: L-2: the referral the old fixture rested on is GONE from both arms
ok 1544 - L-2: the referral the old fixture rested on is GONE from both arms
  ---
  duration_ms: 0.063875
  type: 'test'
  ...
# Subtest: L-3: the base earns praise through a named drug, and the transformation is untouched
ok 1545 - L-3: the base earns praise through a named drug, and the transformation is untouched
  ---
  duration_ms: 0.087
  type: 'test'
  ...
# Subtest: every relation carries an active flag, and it is a boolean
ok 1546 - every relation carries an active flag, and it is a boolean
  ---
  duration_ms: 0.034458
  type: 'test'
  ...
# Subtest: EXACTLY ONE relation is active — L-1; L-2 and L-3 are retired
ok 1547 - EXACTLY ONE relation is active — L-1; L-2 and L-3 are retired
  ---
  duration_ms: 0.041041
  type: 'test'
  ...
# Subtest: RETIRED IS NOT DELETED — both objects stay complete and usable as fixtures
ok 1548 - RETIRED IS NOT DELETED — both objects stay complete and usable as fixtures
  ---
  duration_ms: 0.211667
  type: 'test'
  ...
# Subtest: the runner and the panel both filter on active — retired relations are skipped, not shown
ok 1549 - the runner and the panel both filter on active — retired relations are skipped, not shown
  ---
  duration_ms: 0.161625
  type: 'test'
  ...
# Subtest: the panel states the leg's scope and the retirement, without overclaiming
ok 1550 - the panel states the leg's scope and the retirement, without overclaiming
  ---
  duration_ms: 0.153084
  type: 'test'
  ...
# Subtest: every relation in PART_C_RELATIONS carries a direction, and it is one of the two
ok 1551 - every relation in PART_C_RELATIONS carries a direction, and it is one of the two
  ---
  duration_ms: 0.04225
  type: 'test'
  ...
# Subtest: ids, experiment names and titles are preserved — the lab history must stay joinable
ok 1552 - ids, experiment names and titles are preserved — the lab history must stay joinable
  ---
  duration_ms: 0.121959
  type: 'test'
  ...
# Subtest: the generalising tests still cover ALL THREE relations, active or retired
ok 1553 - the generalising tests still cover ALL THREE relations, active or retired
  ---
  duration_ms: 0.039125
  type: 'test'
  ...
# Subtest: every fixture is synthetic — no db13 uid may reach the lab runner (§9.3)
ok 1554 - every fixture is synthetic — no db13 uid may reach the lab runner (§9.3)
  ---
  duration_ms: 0.064583
  type: 'test'
  ...
# Subtest: no relation throws on its own transform, and both arms stay well-formed rows
ok 1555 - no relation throws on its own transform, and both arms stay well-formed rows
  ---
  duration_ms: 0.069917
  type: 'test'
  ...
# Subtest: every statement the route runs is in the .sql, and every statement in the .sql is run
ok 1556 - every statement the route runs is in the .sql, and every statement in the .sql is run
  ---
  duration_ms: 6.967208
  type: 'test'
  ...
# Subtest: the parity comparison cannot pass vacuously
ok 1557 - the parity comparison cannot pass vacuously
  ---
  duration_ms: 3.084666
  type: 'test'
  ...
# Subtest: every CHECK value in the route is in the .sql, and the reverse
ok 1558 - every CHECK value in the route is in the .sql, and the reverse
  ---
  duration_ms: 1.257917
  type: 'test'
  ...
# Subtest: the value lists are GENERATED, never hand-typed into the route
ok 1559 - the value lists are GENERATED, never hand-typed into the route
  ---
  duration_ms: 0.115958
  type: 'test'
  ...
# Subtest: the retrieval_role CHECK is generated from RETRIEVAL_ROLES and rejects an unknown role
ok 1560 - the retrieval_role CHECK is generated from RETRIEVAL_ROLES and rejects an unknown role
  ---
  duration_ms: 0.178291
  type: 'test'
  ...
# Subtest: the conditional NOT NULL is the ONE allowed difference, and the .sql states the rule
ok 1561 - the conditional NOT NULL is the ONE allowed difference, and the .sql states the rule
  ---
  duration_ms: 0.509417
  type: 'test'
  ...
# Subtest: every statement is idempotent, and each ADD CONSTRAINT is preceded by its own DROP
ok 1562 - every statement is idempotent, and each ADD CONSTRAINT is preceded by its own DROP
  ---
  duration_ms: 0.393167
  type: 'test'
  ...
# Subtest: the index count in the .sql is the real total
ok 1563 - the index count in the .sql is the real total
  ---
  duration_ms: 0.423416
  type: 'test'
  ...
# Subtest: each table comment is written for its own table, not pasted three times
ok 1564 - each table comment is written for its own table, not pasted three times
  ---
  duration_ms: 0.392875
  type: 'test'
  ...
# Subtest: the route halts, changes nothing and reports counts when the table exists with rows
ok 1565 - the route halts, changes nothing and reports counts when the table exists with rows
  ---
  duration_ms: 0.373708
  type: 'test'
  ...
# Subtest: the outcome CHECK partitions the states, and the .sql says so where it cannot branch
ok 1566 - the outcome CHECK partitions the states, and the .sql says so where it cannot branch
  ---
  duration_ms: 0.159
  type: 'test'
  ...
# Subtest: the mirror names the route, and the route names the mirror
ok 1567 - the mirror names the route, and the route names the mirror
  ---
  duration_ms: 0.265583
  type: 'test'
  ...
# Subtest: D1 FIRST: the rendered prompt contains NO human label, reviewer name, or triage field
ok 1568 - D1 FIRST: the rendered prompt contains NO human label, reviewer name, or triage field
  ---
  duration_ms: 1.447666
  type: 'test'
  ...
# Subtest: D1 structural: the renderer accepts ONLY the finding + note context — no third argument
ok 1569 - D1 structural: the renderer accepts ONLY the finding + note context — no third argument
  ---
  duration_ms: 0.473666
  type: 'test'
  ...
# Subtest: D2: the model sees what a reviewer sees — all six finding fields plus the note context
ok 1570 - D2: the model sees what a reviewer sees — all six finding fields plus the note context
  ---
  duration_ms: 0.162458
  type: 'test'
  ...
# Subtest: the rubric uses the reviewer surface's own definitions, verbatim
ok 1571 - the rubric uses the reviewer surface's own definitions, verbatim
  ---
  duration_ms: 0.108375
  type: 'test'
  ...
# Subtest: the parser accepts exactly the three classes
ok 1572 - the parser accepts exactly the three classes
  ---
  duration_ms: 0.602833
  type: 'test'
  ...
# Subtest: anything outside the three classes is `unparseable` and COUNTED — never coerced
ok 1573 - anything outside the three classes is `unparseable` and COUNTED — never coerced
  ---
  duration_ms: 0.850542
  type: 'test'
  ...
# Subtest: cohenKappa: perfect agreement 1, computed example exact, degenerate cases total
ok 1574 - cohenKappa: perfect agreement 1, computed example exact, degenerate cases total
  ---
  duration_ms: 0.499917
  type: 'test'
  ...
# Subtest: D5: contested rows are EXCLUDED from κ and every rate, but present and described
ok 1575 - D5: contested rows are EXCLUDED from κ and every rate, but present and described
  ---
  duration_ms: 0.50225
  type: 'test'
  ...
# Subtest: unparseable is a COUNTED outcome: disagreement, never dropped, never coerced
ok 1576 - unparseable is a COUNTED outcome: disagreement, never dropped, never coerced
  ---
  duration_ms: 0.278667
  type: 'test'
  ...
# Subtest: κ by engine version partitions the scored set
ok 1577 - κ by engine version partitions the scored set
  ---
  duration_ms: 0.38975
  type: 'test'
  ...
# Subtest: self-agreement is its own readout, and the kill-condition comparison is computed
ok 1578 - self-agreement is its own readout, and the kill-condition comparison is computed
  ---
  duration_ms: 0.100708
  type: 'test'
  ...
# Subtest: per-class precision/recall come from the pooled confusion matrix
ok 1579 - per-class precision/recall come from the pooled confusion matrix
  ---
  duration_ms: 0.086333
  type: 'test'
  ...
# Subtest: planTrial: 778 scored + 39 contested ⇒ 1,634 planned calls, under the cap
ok 1580 - planTrial: 778 scored + 39 contested ⇒ 1,634 planned calls, under the cap
  ---
  duration_ms: 0.056208
  type: 'test'
  ...
# Subtest: planTrial REFUSES over the cap — before the first call, not after
ok 1581 - planTrial REFUSES over the cap — before the first call, not after
  ---
  duration_ms: 0.103584
  type: 'test'
  ...
# Subtest: prompt version is pinned and single-sourced
ok 1582 - prompt version is pinned and single-sourced
  ---
  duration_ms: 0.046541
  type: 'test'
  ...
# Subtest: no write path to opd_audit_feedback exists anywhere in the trial code
ok 1583 - no write path to opd_audit_feedback exists anywhere in the trial code
  ---
  duration_ms: 0.544333
  type: 'test'
  ...
# Subtest: label_source shape is the ruling's, and the id comes from the RESPONSE
ok 1584 - label_source shape is the ruling's, and the id comes from the RESPONSE
  ---
  duration_ms: 0.143959
  type: 'test'
  ...
# Subtest: C1: dedup is one-row-per-key, LATEST artefact wins — a re-run supersedes its failures
ok 1585 - C1: dedup is one-row-per-key, LATEST artefact wins — a re-run supersedes its failures
  ---
  duration_ms: 22.984459
  type: 'test'
  ...
# Subtest: §4: cross-invocation agreement is its own figure and ignores unresolved invocations
ok 1586 - §4: cross-invocation agreement is its own figure and ignores unresolved invocations
  ---
  duration_ms: 5.009792
  type: 'test'
  ...
# Subtest: C3: the route accepts a keyed top-up that bypasses the offset plan gate but not the auth
ok 1587 - C3: the route accepts a keyed top-up that bypasses the offset plan gate but not the auth
  ---
  duration_ms: 0.163708
  type: 'test'
  ...
# Subtest: C2: the summary reports distinct keys vs the set WITH the missing-key list and the dedup rule
ok 1588 - C2: the summary reports distinct keys vs the set WITH the missing-key list and the dedup rule
  ---
  duration_ms: 0.106083
  type: 'test'
  ...
# Subtest: applyCohort: frozen labels win, extras separated, missing listed, revisions counted
ok 1589 - applyCohort: frozen labels win, extras separated, missing listed, revisions counted
  ---
  duration_ms: 5.501583
  type: 'test'
  ...
# Subtest: the cohort is immutable and the summary carries cohortId beside the metrics
ok 1590 - the cohort is immutable and the summary carries cohortId beside the metrics
  ---
  duration_ms: 0.400208
  type: 'test'
  ...
# Subtest: pre-freeze (version absent): four model-side meters armed, value null, armed label
ok 1591 - pre-freeze (version absent): four model-side meters armed, value null, armed label
  ---
  duration_ms: 0.538625
  type: 'test'
  ...
# Subtest: pre-freeze: reviewer cadence ALWAYS live (never armed, never faked)
ok 1592 - pre-freeze: reviewer cadence ALWAYS live (never armed, never faked)
  ---
  duration_ms: 0.125125
  type: 'test'
  ...
# Subtest: post-freeze: model-side meters unarm and carry real values + fill
ok 1593 - post-freeze: model-side meters unarm and carry real values + fill
  ---
  duration_ms: 0.073083
  type: 'test'
  ...
# Subtest: meters returned in mockup order
ok 1594 - meters returned in mockup order
  ---
  duration_ms: 0.33025
  type: 'test'
  ...
# Subtest: fill clamps to [0,1] even when value exceeds target
ok 1595 - fill clamps to [0,1] even when value exceeds target
  ---
  duration_ms: 0.0595
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: bm25_rank surviving from a later variant is preserved (the exact bug being fixed)
ok 1596 - bm25_rank surviving from a later variant is preserved (the exact bug being fixed)
  ---
  duration_ms: 0.779917
  type: 'test'
  ...
# Subtest: bm25_variant_ranks aligns to variants and is null where the chunk did not arrive via that BM25 leg
ok 1597 - bm25_variant_ranks aligns to variants and is null where the chunk did not arrive via that BM25 leg
  ---
  duration_ms: 0.439917
  type: 'test'
  ...
# Subtest: scalar bm25_rank is the best (min) non-null across variants
ok 1598 - scalar bm25_rank is the best (min) non-null across variants
  ---
  duration_ms: 0.125875
  type: 'test'
  ...
# Subtest: a chunk that never arrived via any BM25 leg has bm25_rank null
ok 1599 - a chunk that never arrived via any BM25 leg has bm25_rank null
  ---
  duration_ms: 0.122833
  type: 'test'
  ...
# Subtest: variant_ranks and rrf_score are unchanged by the provenance addition
ok 1600 - variant_ranks and rrf_score are unchanged by the provenance addition
  ---
  duration_ms: 0.284583
  type: 'test'
  ...
# Subtest: each per-variant retrieve() is called with withDiagnostics true (so bm25_rank is populated)
ok 1601 - each per-variant retrieve() is called with withDiagnostics true (so bm25_rank is populated)
  ---
  duration_ms: 0.119708
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: expandQuery runs exactly once, on the original question
ok 1602 - expandQuery runs exactly once, on the original question
  ---
  duration_ms: 0.785834
  type: 'test'
  ...
# Subtest: the original arm retrieves on expanded text; variant arms retrieve on variant text
ok 1603 - the original arm retrieves on expanded text; variant arms retrieve on variant text
  ---
  duration_ms: 0.493333
  type: 'test'
  ...
# Subtest: variant generation runs on the original question, never the expanded paragraph
ok 1604 - variant generation runs on the original question, never the expanded paragraph
  ---
  duration_ms: 0.121959
  type: 'test'
  ...
# Subtest: skipExpand:true from the caller turns expansion OFF — expandQuery is not called
ok 1605 - skipExpand:true from the caller turns expansion OFF — expandQuery is not called
  ---
  duration_ms: 0.112125
  type: 'test'
  ...
# Subtest: expansion fail-open (returns the original question) leaves the original arm on the raw question
ok 1606 - expansion fail-open (returns the original question) leaves the original arm on the raw question
  ---
  duration_ms: 0.300667
  type: 'test'
  ...
# Subtest: per-variant retrieve() keeps reranker/weights OFF after expansion is restored
ok 1607 - per-variant retrieve() keeps reranker/weights OFF after expansion is restored
  ---
  duration_ms: 0.21325
  type: 'test'
  ...
# Subtest: expandedQuery is returned on MultiRetrieveResult
ok 1608 - expandedQuery is returned on MultiRetrieveResult
  ---
  duration_ms: 0.131667
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: RRF fusion: a chunk ranked \#1 by two variants beats a chunk ranked \#1 by one variant with higher cosine
ok 1609 - RRF fusion: a chunk ranked \#1 by two variants beats a chunk ranked \#1 by one variant with higher cosine
  ---
  duration_ms: 1.062166
  type: 'test'
  ...
# Subtest: rerank runs once over the fused pool against the original question — never a variant
ok 1610 - rerank runs once over the fused pool against the original question — never a variant
  ---
  duration_ms: 0.235167
  type: 'test'
  ...
# Subtest: source weighting: a guidelines (0.95) chunk outranks an unknown-journal (0.80) chunk at equal rerank score
ok 1611 - source weighting: a guidelines (0.95) chunk outranks an unknown-journal (0.80) chunk at equal rerank score
  ---
  duration_ms: 0.286334
  type: 'test'
  ...
# Subtest: per-variant retrieve() runs with useReranker/useSourceWeights false; fusion reranks once
ok 1612 - per-variant retrieve() runs with useReranker/useSourceWeights false; fusion reranks once
  ---
  duration_ms: 1.084167
  type: 'test'
  ...
# Subtest: variant generation returning nothing falls back to the original query alone, no throw
ok 1613 - variant generation returning nothing falls back to the original query alone, no throw
  ---
  duration_ms: 0.438875
  type: 'test'
  ...
# Subtest: multi-query hits always carry rrf_score + variant_ranks — no includeQuarantined needed
ok 1614 - multi-query hits always carry rrf_score + variant_ranks — no includeQuarantined needed
  ---
  duration_ms: 0.557542
  type: 'test'
  ...
# Subtest: R-6 guard: assertEmbeddingV2Available throws a named error when v2 is on but the column is absent
ok 1615 - R-6 guard: assertEmbeddingV2Available throws a named error when v2 is on but the column is absent
  ---
  duration_ms: 0.2785
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: every arm now RECEIVES a capture, and the fusion lifts index_version from the first that has one
ok 1616 - every arm now RECEIVES a capture, and the fusion lifts index_version from the first that has one
  ---
  duration_ms: 1.128333
  type: 'test'
  ...
# Subtest: the manifest that results carries a non-null index_version, and validates clean on that field
ok 1617 - the manifest that results carries a non-null index_version, and validates clean on that field
  ---
  duration_ms: 1.4595
  type: 'test'
  ...
# Subtest: an arm that stamps nothing leaves a null, and the null is recorded rather than invented
ok 1618 - an arm that stamps nothing leaves a null, and the null is recorded rather than invented
  ---
  duration_ms: 0.186084
  type: 'test'
  ...
# Subtest: INSTRUMENTATION OFF: no arm capture is made, and the arms are called with an undefined third argument
ok 1619 - INSTRUMENTATION OFF: no arm capture is made, and the arms are called with an undefined third argument
  ---
  duration_ms: 0.247959
  type: 'test'
  ...
# Subtest: 63 — the fail-open early exit still has its literal form, and this file does not quote it in a comment
ok 1620 - 63 — the fail-open early exit still has its literal form, and this file does not quote it in a comment
  ---
  duration_ms: 0.09225
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: DEFAULT_NORMATIVE_SOURCES = choosing-wisely + the two activated guideline keys, in order
ok 1621 - DEFAULT_NORMATIVE_SOURCES = choosing-wisely + the two activated guideline keys, in order
  ---
  duration_ms: 0.826041
  type: 'test'
  ...
# Subtest: the added keys target ACTIVATED sources (lab:), never quarantined (labq:) — inert until activation
ok 1622 - the added keys target ACTIVATED sources (lab:), never quarantined (labq:) — inert until activation
  ---
  duration_ms: 0.2745
  type: 'test'
  ...
# Subtest: sourceLabel renders "Even Guidelines" / "ICMR Guidelines" for the activated sources
ok 1623 - sourceLabel renders "Even Guidelines" / "ICMR Guidelines" for the activated sources
  ---
  duration_ms: 0.115083
  type: 'test'
  ...
# Subtest: labels are INERT while quarantined: a labq: chunk falls back to book (unchanged today)
ok 1624 - labels are INERT while quarantined: a labq: chunk falls back to book (unchanged today)
  ---
  duration_ms: 0.050167
  type: 'test'
  ...
# Subtest: choosing-wisely and every other source are byte-identical (book-driven, no override)
ok 1625 - choosing-wisely and every other source are byte-identical (book-driven, no override)
  ---
  duration_ms: 0.060667
  type: 'test'
  ...
# Subtest: the guideline anchors resolve to NO url (category/internal authority, not deterministic)
ok 1626 - the guideline anchors resolve to NO url (category/internal authority, not deterministic)
  ---
  duration_ms: 0.096917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [normative-grounding] CW leg failed db down
# [normative-grounding] guideline leg failed db down
# Subtest: CW gate: accept the top candidate only when its statement category == finding.lvc_category AND cosine ≥ τ
ok 1627 - CW gate: accept the top candidate only when its statement category == finding.lvc_category AND cosine ≥ τ
  ---
  duration_ms: 1.530333
  type: 'test'
  ...
# Subtest: guideline gate: accept iff cosine ≥ τ (no category constraint)
ok 1628 - guideline gate: accept iff cosine ≥ τ (no category constraint)
  ---
  duration_ms: 0.158209
  type: 'test'
  ...
# Subtest: mergeNormativeCitations attaches both accepted legs and dedupes against existing
ok 1629 - mergeNormativeCitations attaches both accepted legs and dedupes against existing
  ---
  duration_ms: 0.589917
  type: 'test'
  ...
# Subtest: hitToSource: guideline anchor resolves to NO url (no fake identifier), CW keeps its source/item
ok 1630 - hitToSource: guideline anchor resolves to NO url (no fake identifier), CW keeps its source/item
  ---
  duration_ms: 0.058458
  type: 'test'
  ...
# Subtest: SCORE-INVARIANCE: attaching citations leaves verdict/score/band/lvc_category byte-identical
ok 1631 - SCORE-INVARIANCE: attaching citations leaves verdict/score/band/lvc_category byte-identical
  ---
  duration_ms: 0.777958
  type: 'test'
  ...
# Subtest: attachNormativeCitations is IDEMPOTENT — a re-run adds nothing
ok 1632 - attachNormativeCitations is IDEMPOTENT — a re-run adds nothing
  ---
  duration_ms: 0.106334
  type: 'test'
  ...
# Subtest: groundFinding attaches CW+guideline when both legs return accepted hits
ok 1633 - groundFinding attaches CW+guideline when both legs return accepted hits
  ---
  duration_ms: 0.30725
  type: 'test'
  ...
# Subtest: groundFinding grounds nothing on cross-category CW / below-τ guideline, and SOFT-FAILS on throw
ok 1634 - groundFinding grounds nothing on cross-category CW / below-τ guideline, and SOFT-FAILS on throw
  ---
  duration_ms: 0.302792
  type: 'test'
  ...
# Subtest: even gate: accept iff cosine ≥ τ AND the dynamic lookup category == finding.lvc_category
ok 1635 - even gate: accept iff cosine ≥ τ AND the dynamic lookup category == finding.lvc_category
  ---
  duration_ms: 0.25875
  type: 'test'
  ...
# Subtest: citation ordering: external legs first, even-lvc LAST; dedup by (source,item_number)
ok 1636 - citation ordering: external legs first, even-lvc LAST; dedup by (source,item_number)
  ---
  duration_ms: 1.526334
  type: 'test'
  ...
# Subtest: groundFinding runs the even leg ONLY with a lookup; attaches it last, inert without a lookup
ok 1637 - groundFinding runs the even leg ONLY with a lookup; attaches it last, inert without a lookup
  ---
  duration_ms: 0.194584
  type: 'test'
  ...
# Subtest: --legs cw runs ONLY the CW leg (guideline omitted, guideline retrieve not even called)
ok 1638 - --legs cw runs ONLY the CW leg (guideline omitted, guideline retrieve not even called)
  ---
  duration_ms: 0.088375
  type: 'test'
  ...
# Subtest: --legs guideline runs ONLY the guideline leg (CW omitted)
ok 1639 - --legs guideline runs ONLY the guideline leg (CW omitted)
  ---
  duration_ms: 0.055584
  type: 'test'
  ...
# Subtest: --categories filters eligibility: a finding whose lvc_category is not listed grounds nothing
ok 1640 - --categories filters eligibility: a finding whose lvc_category is not listed grounds nothing
  ---
  duration_ms: 0.142417
  type: 'test'
  ...
# Subtest: --tau raises/lowers acceptance (same match math, different threshold)
ok 1641 - --tau raises/lowers acceptance (same match math, different threshold)
  ---
  duration_ms: 0.086459
  type: 'test'
  ...
# Subtest: DEFAULT options reproduce today's behaviour byte-identically (regression guard)
ok 1642 - DEFAULT options reproduce today's behaviour byte-identically (regression guard)
  ---
  duration_ms: 0.116875
  type: 'test'
  ...
# Subtest: CW category map: every id maps to a known lvc_category; the strong categories are covered
ok 1643 - CW category map: every id maps to a known lvc_category; the strong categories are covered
  ---
  duration_ms: 0.064708
  type: 'test'
  ...
# Subtest: isGroundableFinding: only non-informational low-value findings
ok 1644 - isGroundableFinding: only non-informational low-value findings
  ---
  duration_ms: 0.04425
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: resolveNormativeSources defaults to choosing-wisely + the two activated guideline keys; never labq:% by default
ok 1645 - resolveNormativeSources defaults to choosing-wisely + the two activated guideline keys; never labq:% by default
  ---
  duration_ms: 3.416792
  type: 'test'
  ...
# Subtest: normativeLegK reads env NORMATIVE_LEG_K, defaults 5
ok 1646 - normativeLegK reads env NORMATIVE_LEG_K, defaults 5
  ---
  duration_ms: 0.260833
  type: 'test'
  ...
# Subtest: the normative leg is the vector SQL filtered to source = ANY, capped at N_norm
ok 1647 - the normative leg is the vector SQL filtered to source = ANY, capped at N_norm
  ---
  duration_ms: 0.276958
  type: 'test'
  ...
# Subtest: the normative leg leaves the default filter clauses byte-identical
ok 1648 - the normative leg leaves the default filter clauses byte-identical
  ---
  duration_ms: 0.122666
  type: 'test'
  ...
# Subtest: useNormativeLeg + normativeSources thread through retrieveMultiQuery to each per-variant retrieve
ok 1649 - useNormativeLeg + normativeSources thread through retrieveMultiQuery to each per-variant retrieve
  ---
  duration_ms: 1.368167
  type: 'test'
  ...
# Subtest: engine bumped to 0.81.19 (neutraliser removal) and the read family includes 0.81.8…0.81.17
ok 1650 - engine bumped to 0.81.19 (neutraliser removal) and the read family includes 0.81.8…0.81.17
  ---
  duration_ms: 0.950125
  type: 'test'
  ...
# Subtest: bug 9: an unresolved brand is surfaced but informational (never scores)
ok 1651 - bug 9: an unresolved brand is surfaced but informational (never scores)
  ---
  duration_ms: 1.7075
  type: 'test'
  ...
# Subtest: bug 6: an unresolved line never ALSO stacks incomplete dosing (consolidated)
ok 1652 - bug 6: an unresolved line never ALSO stacks incomplete dosing (consolidated)
  ---
  duration_ms: 2.007
  type: 'test'
  ...
# Subtest: bug 7: an off-formulary cosmetic (by name) is exempt from incomplete dosing
ok 1653 - bug 7: an off-formulary cosmetic (by name) is exempt from incomplete dosing
  ---
  duration_ms: 0.2745
  type: 'test'
  ...
# Subtest: a RESOLVED real drug missing its dose STILL scores incomplete dosing
ok 1654 - a RESOLVED real drug missing its dose STILL scores incomplete dosing
  ---
  duration_ms: 0.270833
  type: 'test'
  ...
# Subtest: bug 2: a health-check package encounter is recognised and neutralises screening critiques
ok 1655 - bug 2: a health-check package encounter is recognised and neutralises screening critiques
  ---
  duration_ms: 0.497083
  type: 'test'
  ...
# Subtest: bug 10: a biotin-before-thyroid over-flag is neutralised to informational
ok 1656 - bug 10: a biotin-before-thyroid over-flag is neutralised to informational
  ---
  duration_ms: 0.796542
  type: 'test'
  ...
# Subtest: bug 5: the Antispasmodic/anticholinergic reclass does NOT change DDI tags
ok 1657 - bug 5: the Antispasmodic/anticholinergic reclass does NOT change DDI tags
  ---
  duration_ms: 0.815417
  type: 'test'
  ...
# Subtest: Part B: the 3 base categories are unchanged
ok 1658 - Part B: the 3 base categories are unchanged
  ---
  duration_ms: 0.903042
  type: 'test'
  ...
# Subtest: Part B: residual other splits into overuse sub-tags by priority
ok 1659 - Part B: residual other splits into overuse sub-tags by priority
  ---
  duration_ms: 2.697916
  type: 'test'
  ...
# Subtest: Part B: the omission guard keeps missing-safety-net / mismatch findings in other
ok 1660 - Part B: the omission guard keeps missing-safety-net / mismatch findings in other
  ---
  duration_ms: 0.408667
  type: 'test'
  ...
# Subtest: Part B: priority order — therapeutic_duplication wins over a steroid mention
ok 1661 - Part B: priority order — therapeutic_duplication wins over a steroid mention
  ---
  duration_ms: 0.041917
  type: 'test'
  ...
# Subtest: Part B: every category has a shared human label (no raw slug can render)
ok 1662 - Part B: every category has a shared human label (no raw slug can render)
  ---
  duration_ms: 0.053417
  type: 'test'
  ...
# Subtest: Part C: frequentFlierCmp orders per Decision 12
ok 1663 - Part C: frequentFlierCmp orders per Decision 12
  ---
  duration_ms: 0.380958
  type: 'test'
  ...
# Subtest: Part C: default (index) order is untouched by the comparator module
ok 1664 - Part C: default (index) order is untouched by the comparator module
  ---
  duration_ms: 0.176833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 0.81.10 S1: the muscle-relaxant finding is emitted informational (surfaced, out of the score)
ok 1665 - 0.81.10 S1: the muscle-relaxant finding is emitted informational (surfaced, out of the score)
  ---
  duration_ms: 0.674209
  type: 'test'
  ...
# Subtest: bug 1: xanthine for an acute URTI fires (context-guarded)
ok 1666 - bug 1: xanthine for an acute URTI fires (context-guarded)
  ---
  duration_ms: 0.44575
  type: 'test'
  ...
# Subtest: bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)
ok 1667 - bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)
  ---
  duration_ms: 0.252
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 12: acebrophylline + acetylcysteine in an acute URTI → NO finding (rule dormant for it)
ok 1668 - 0.81.14 Ruling 12: acebrophylline + acetylcysteine in an acute URTI → NO finding (rule dormant for it)
  ---
  duration_ms: 0.063
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 11: antihistamine + montelukast emits NO finding at any duration
ok 1669 - 0.81.13 Decision 11: antihistamine + montelukast emits NO finding at any duration
  ---
  duration_ms: 0.177292
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 11: a xanthine AND antihistamine+montelukast → exactly ONE finding (the xanthine)
ok 1670 - 0.81.13 Decision 11: a xanthine AND antihistamine+montelukast → exactly ONE finding (the xanthine)
  ---
  duration_ms: 0.122334
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 3: xanthine subject/rationale carry no "mucolytic"; guard + confidence unchanged
ok 1671 - 0.81.13 Decision 3: xanthine subject/rationale carry no "mucolytic"; guard + confidence unchanged
  ---
  duration_ms: 0.205208
  type: 'test'
  ...
# Subtest: bug 1: no acute-URTI context → nothing fires
ok 1672 - bug 1: no acute-URTI context → nothing fires
  ---
  duration_ms: 0.041375
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 4: 5 → none; 7 → none; 8 and 15 → 0.7; 16 and 1 month → 0.85; unparseable → none
ok 1673 - 0.81.13 Decision 4: 5 → none; 7 → none; 8 and 15 → 0.7; 16 and 1 month → 0.85; unparseable → none
  ---
  duration_ms: 0.542292
  type: 'test'
  ...
# Subtest: 0.81.13: parseDurationDays (exported) parses days/weeks/months and returns null for chronic/unparseable
ok 1674 - 0.81.13: parseDurationDays (exported) parses days/weeks/months and returns null for chronic/unparseable
  ---
  duration_ms: 0.332792
  type: 'test'
  ...
# Subtest: bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)
ok 1675 - bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)
  ---
  duration_ms: 1.31
  type: 'test'
  ...
# Subtest: bug 8: topical + systemic sharing a molecule is not a duplicate
ok 1676 - bug 8: topical + systemic sharing a molecule is not a duplicate
  ---
  duration_ms: 0.464917
  type: 'test'
  ...
# Subtest: bug 8: a genuine same-route duplicate is KEPT
ok 1677 - bug 8: a genuine same-route duplicate is KEPT
  ---
  duration_ms: 0.366125
  type: 'test'
  ...
# Subtest: bug 8: an LLM finding (non-deterministic) is never touched by the route filter
ok 1678 - bug 8: an LLM finding (non-deterministic) is never touched by the route filter
  ---
  duration_ms: 0.120791
  type: 'test'
  ...
# Subtest: bug 4: opdCaseText surfaces the consult date exactly once with a historical guard
ok 1679 - bug 4: opdCaseText surfaces the consult date exactly once with a historical guard
  ---
  duration_ms: 0.348959
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 1: an oral + topical NSAID pair emits NO interaction finding
ok 1680 - 0.81.14 Ruling 1: an oral + topical NSAID pair emits NO interaction finding
  ---
  duration_ms: 4.274083
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 1: two ORAL NSAIDs still produce an interaction finding (unchanged)
ok 1681 - 0.81.14 Ruling 1: two ORAL NSAIDs still produce an interaction finding (unchanged)
  ---
  duration_ms: 0.916584
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 4: muscle relaxant with MSK context → none; without → fires; ctx omitted → today
ok 1682 - 0.81.14 Ruling 4: muscle relaxant with MSK context → none; without → fires; ctx omitted → today
  ---
  duration_ms: 0.151875
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 4: mskContextDocumented — "low back pain" true, ICD M54.5 true, "fever, cough" false
ok 1683 - 0.81.14 Ruling 4: mskContextDocumented — "low back pain" true, ICD M54.5 true, "fever, cough" false
  ---
  duration_ms: 0.6475
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 13: 60,000 IU weekly for >8 weeks fires informational; 8 weeks / daily / low-strength / unparseable → none
ok 1684 - 0.81.14 Ruling 13: 60,000 IU weekly for >8 weeks fires informational; 8 weeks / daily / low-strength / unparseable → none
  ---
  duration_ms: 0.839125
  type: 'test'
  ...
# Subtest: 0.81.14 Rulings 5–8: pregnancy advisory fires only in the 36–90d window with a trigger drug, always informational
ok 1685 - 0.81.14 Rulings 5–8: pregnancy advisory fires only in the 36–90d window with a trigger drug, always informational
  ---
  duration_ms: 1.9105
  type: 'test'
  ...
# Subtest: 0.81.14: lmpIntervalDays parses ISO dates + fail-safe on missing/garbage
ok 1686 - 0.81.14: lmpIntervalDays parses ISO dates + fail-safe on missing/garbage
  ---
  duration_ms: 0.132458
  type: 'test'
  ...
# Subtest: wrapText: short text stays on one line
ok 1687 - wrapText: short text stays on one line
  ---
  duration_ms: 0.981
  type: 'test'
  ...
# Subtest: wrapText: wraps on word boundaries when a line would overflow
ok 1688 - wrapText: wraps on word boundaries when a line would overflow
  ---
  duration_ms: 0.371292
  type: 'test'
  ...
# Subtest: wrapText: hard-breaks a single word longer than maxWidth
ok 1689 - wrapText: hard-breaks a single word longer than maxWidth
  ---
  duration_ms: 0.348917
  type: 'test'
  ...
# Subtest: wrapText: mixes a long word with normal words, never exceeding maxWidth
ok 1690 - wrapText: mixes a long word with normal words, never exceeding maxWidth
  ---
  duration_ms: 0.14675
  type: 'test'
  ...
# Subtest: wrapText: collapses whitespace and handles empty input
ok 1691 - wrapText: collapses whitespace and handles empty input
  ---
  duration_ms: 0.255084
  type: 'test'
  ...
# Subtest: paginate: packs items greedily within capacity
ok 1692 - paginate: packs items greedily within capacity
  ---
  duration_ms: 0.279709
  type: 'test'
  ...
# Subtest: paginate: an item taller than capacity gets its own page, never dropped
ok 1693 - paginate: an item taller than capacity gets its own page, never dropped
  ---
  duration_ms: 0.141125
  type: 'test'
  ...
# Subtest: paginate: empty input → no pages
ok 1694 - paginate: empty input → no pages
  ---
  duration_ms: 0.182875
  type: 'test'
  ...
# Subtest: paginate: everything fits on one page when capacity is large
ok 1695 - paginate: everything fits on one page when capacity is large
  ---
  duration_ms: 0.5215
  type: 'test'
  ...
# Subtest: migration 0025 is exactly one additive, idempotent statement
ok 1696 - migration 0025 is exactly one additive, idempotent statement
  ---
  duration_ms: 1.001416
  type: 'test'
  ...
# Subtest: ALL THREE write paths carry the scorecard — a row written without one is a bug
ok 1697 - ALL THREE write paths carry the scorecard — a row written without one is a bug
  ---
  duration_ms: 0.152083
  type: 'test'
  ...
# Subtest: the A.1 column is APPENDED — no established placeholder index moved
ok 1698 - the A.1 column is APPENDED — no established placeholder index moved
  ---
  duration_ms: 0.125083
  type: 'test'
  ...
# Subtest: INSERT: columns and arguments align in ALL SIXTEEN branches
ok 1699 - INSERT: columns and arguments align in ALL SIXTEEN branches
  ---
  duration_ms: 1.985791
  type: 'test'
  ...
# Subtest: INSERT: every jsonb column is cast, including the A.1 one
ok 1700 - INSERT: every jsonb column is cast, including the A.1 one
  ---
  duration_ms: 0.08025
  type: 'test'
  ...
# Subtest: UPDATE placeholders align in all four branches; scorecard $20, excluded_reason $21, quieting_gen $22
ok 1701 - UPDATE placeholders align in all four branches; scorecard $20, excluded_reason $21, quieting_gen $22
  ---
  duration_ms: 0.066959
  type: 'test'
  ...
# Subtest: serialisation is FAIL-SAFE: a scorecard fault must never cost an audit
ok 1702 - serialisation is FAIL-SAFE: a scorecard fault must never cost an audit
  ---
  duration_ms: 0.315791
  type: 'test'
  ...
# Subtest: the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed
ok 1703 - the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed
  ---
  duration_ms: 0.263458
  type: 'test'
  ...
# Subtest: THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis
ok 1704 - THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis
  ---
  duration_ms: 1.758292
  type: 'test'
  ...
# Subtest: an ASSESSED note keeps a non-zero note_quality weight — the control
ok 1705 - an ASSESSED note keeps a non-zero note_quality weight — the control
  ---
  duration_ms: 0.934167
  type: 'test'
  ...
# Subtest: matches a low-value investigation to its line
ok 1706 - matches a low-value investigation to its line
  ---
  duration_ms: 0.678709
  type: 'test'
  ...
# Subtest: matches a dosing finding to the specific medication line
ok 1707 - matches a dosing finding to the specific medication line
  ---
  duration_ms: 0.103959
  type: 'test'
  ...
# Subtest: prescribing finding prefers the med line on a tie
ok 1708 - prescribing finding prefers the med line on a tie
  ---
  duration_ms: 0.060416
  type: 'test'
  ...
# Subtest: documentation finding falls back to keyword section
ok 1709 - documentation finding falls back to keyword section
  ---
  duration_ms: 0.086708
  type: 'test'
  ...
# Subtest: follow-up keyword routes to followup section
ok 1710 - follow-up keyword routes to followup section
  ---
  duration_ms: 0.095625
  type: 'test'
  ...
# Subtest: unmatched appropriateness finding falls back to investigations section
ok 1711 - unmatched appropriateness finding falls back to investigations section
  ---
  duration_ms: 0.147833
  type: 'test'
  ...
# Subtest: appropriateness fallback goes to diagnosis when no investigations exist
ok 1712 - appropriateness fallback goes to diagnosis when no investigations exist
  ---
  duration_ms: 0.166292
  type: 'test'
  ...
# Subtest: note_quality findings anchor to the whole note
ok 1713 - note_quality findings anchor to the whole note
  ---
  duration_ms: 0.050583
  type: 'test'
  ...
# Subtest: numbers follow findings order and grouping keys are stable
ok 1714 - numbers follow findings order and grouping keys are stable
  ---
  duration_ms: 0.620667
  type: 'test'
  ...
# Subtest: stopwords alone never force a spurious med match
ok 1715 - stopwords alone never force a spurious med match
  ---
  duration_ms: 0.328583
  type: 'test'
  ...
# Subtest: chronicPoints tiers: 0 | 1–2 | 3+ → 0 | 1 | 2
ok 1716 - chronicPoints tiers: 0 | 1–2 | 3+ → 0 | 1 | 2
  ---
  duration_ms: 0.496708
  type: 'test'
  ...
# Subtest: lab/util points fire at their thresholds (3 abnormal / 4 encounters)
ok 1717 - lab/util points fire at their thresholds (3 abnormal / 4 encounters)
  ---
  duration_ms: 0.100209
  type: 'test'
  ...
# Subtest: bandFor: full point table (LOW/MODERATE/HIGH boundaries)
ok 1718 - bandFor: full point table (LOW/MODERATE/HIGH boundaries)
  ---
  duration_ms: 0.092666
  type: 'test'
  ...
# Subtest: NEW_TO_US precedence: zero encounters in prior 24m overrides the point band
ok 1719 - NEW_TO_US precedence: zero encounters in prior 24m overrides the point band
  ---
  duration_ms: 0.048375
  type: 'test'
  ...
# Subtest: complexityPoints sums the three legs
ok 1720 - complexityPoints sums the three legs
  ---
  duration_ms: 0.048292
  type: 'test'
  ...
# Subtest: buildComplexity returns band + echoes inputs
ok 1721 - buildComplexity returns band + echoes inputs
  ---
  duration_ms: 0.058167
  type: 'test'
  ...
# Subtest: windowStart: 12m / 24m before the index date (UTC month math)
ok 1722 - windowStart: 12m / 24m before the index date (UTC month math)
  ---
  duration_ms: 1.074458
  type: 'test'
  ...
# Subtest: db13-row parsers: distinct chronic ICDs, abnormal count, scalar count; NULL-safe
ok 1723 - db13-row parsers: distinct chronic ICDs, abnormal count, scalar count; NULL-safe
  ---
  duration_ms: 0.125875
  type: 'test'
  ...
# Subtest: index-encounter exclusion is an as-of property: with only the index in-window, prior counts are 0 → NEW_TO_US
ok 1724 - index-encounter exclusion is an as-of property: with only the index in-window, prior counts are 0 → NEW_TO_US
  ---
  duration_ms: 0.192958
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: no eval config ⇒ opdRetrieveOpts byte-identical to today
ok 1725 - no eval config ⇒ opdRetrieveOpts byte-identical to today
  ---
  duration_ms: 0.875083
  type: 'test'
  ...
# Subtest: evalNormativeLeg:true ⇒ useNormativeLeg true regardless of mini / env
ok 1726 - evalNormativeLeg:true ⇒ useNormativeLeg true regardless of mini / env
  ---
  duration_ms: 0.104041
  type: 'test'
  ...
# Subtest: buildOpenRouterBody carries the eval determinism config: temp0 + top_p1 + seed + reasoning-pin + provider-pin
ok 1727 - buildOpenRouterBody carries the eval determinism config: temp0 + top_p1 + seed + reasoning-pin + provider-pin
  ---
  duration_ms: 0.168833
  type: 'test'
  ...
# Subtest: production defaultGenerate: Vertex-Gemini path gets temp0 + seed + top_p + fixed thinking, GATED on onGemini; mini/Ollama unchanged
ok 1728 - production defaultGenerate: Vertex-Gemini path gets temp0 + seed + top_p + fixed thinking, GATED on onGemini; mini/Ollama unchanged
  ---
  duration_ms: 0.431459
  type: 'test'
  ...
# Subtest: LVC/Kimi adjudication params: temp0 + seed + top_p + OpenRouter provider-pin
ok 1729 - LVC/Kimi adjudication params: temp0 + seed + top_p + OpenRouter provider-pin
  ---
  duration_ms: 0.157083
  type: 'test'
  ...
# Subtest: openRouterGenerate posts to the OpenRouter endpoint at temp 0 and returns the completion
ok 1730 - openRouterGenerate posts to the OpenRouter endpoint at temp 0 and returns the completion
  ---
  duration_ms: 20.836083
  type: 'test'
  ...
# Subtest: openRouterGenerate throws (does not silently fall back) when the key is missing
ok 1731 - openRouterGenerate throws (does not silently fall back) when the key is missing
  ---
  duration_ms: 0.277833
  type: 'test'
  ...
# Subtest: the lab-batch eval path never writes opd_note_audits (structural guard)
ok 1732 - the lab-batch eval path never writes opd_note_audits (structural guard)
  ---
  duration_ms: 0.776542
  type: 'test'
  ...
# Subtest: parseBatchState reads the eval config; absent ⇒ off / null
ok 1733 - parseBatchState reads the eval config; absent ⇒ off / null
  ---
  duration_ms: 0.356708
  type: 'test'
  ...
# Subtest: verdict sets are wired by scope
ok 1734 - verdict sets are wired by scope
  ---
  duration_ms: 0.839459
  type: 'test'
  ...
# Subtest: impact scope: TP-only second tap — valid tag + finding_ref required, category always null
ok 1735 - impact scope: TP-only second tap — valid tag + finding_ref required, category always null
  ---
  duration_ms: 0.288958
  type: 'test'
  ...
# Subtest: missed scope: category is REQUIRED (F6/A10.1) and whitelisted; unknown category rejected
ok 1736 - missed scope: category is REQUIRED (F6/A10.1) and whitelisted; unknown category rejected
  ---
  duration_ms: 0.204834
  type: 'test'
  ...
# Subtest: non-missed/impact scopes carry category=null
ok 1737 - non-missed/impact scopes carry category=null
  ---
  duration_ms: 0.066
  type: 'test'
  ...
# Subtest: bad auditId is rejected before anything else
ok 1738 - bad auditId is rejected before anything else
  ---
  duration_ms: 0.050583
  type: 'test'
  ...
# Subtest: unknown scope is rejected
ok 1739 - unknown scope is rejected
  ---
  duration_ms: 0.043
  type: 'test'
  ...
# Subtest: legacy audit scope: bare comment allowed, defaults to audit, verdict optional
ok 1740 - legacy audit scope: bare comment allowed, defaults to audit, verdict optional
  ---
  duration_ms: 0.1045
  type: 'test'
  ...
# Subtest: audit scope: valid verdict kept, invalid verdict dropped to null
ok 1741 - audit scope: valid verdict kept, invalid verdict dropped to null
  ---
  duration_ms: 0.062542
  type: 'test'
  ...
# Subtest: audit scope: empty body (no verdict, no comment) rejected
ok 1742 - audit scope: empty body (no verdict, no comment) rejected
  ---
  duration_ms: 0.200792
  type: 'test'
  ...
# Subtest: finding scope: requires a finding verdict
ok 1743 - finding scope: requires a finding verdict
  ---
  duration_ms: 0.302417
  type: 'test'
  ...
# Subtest: finding scope: requires finding_ref
ok 1744 - finding scope: requires finding_ref
  ---
  duration_ms: 0.0595
  type: 'test'
  ...
# Subtest: finding scope: all four verdicts accepted, carries ref + signal_type + optional comment
ok 1745 - finding scope: all four verdicts accepted, carries ref + signal_type + optional comment
  ---
  duration_ms: 0.069167
  type: 'test'
  ...
# Subtest: missed scope: verdict forced to missed, comment required
ok 1746 - missed scope: verdict forced to missed, comment required
  ---
  duration_ms: 0.059417
  type: 'test'
  ...
# Subtest: fields are trimmed, empties collapse to null, oversized values are capped
ok 1747 - fields are trimmed, empties collapse to null, oversized values are capped
  ---
  duration_ms: 0.054042
  type: 'test'
  ...
# Subtest: dedup expression selects latest per (audit_id, finding_ref), tie-break highest id
ok 1748 - dedup expression selects latest per (audit_id, finding_ref), tie-break highest id
  ---
  duration_ms: 0.807375
  type: 'test'
  ...
# Subtest: precision_strict excludes contested; zero denominator → null
ok 1749 - precision_strict excludes contested; zero denominator → null
  ---
  duration_ms: 0.514625
  type: 'test'
  ...
# Subtest: coverage_pct = triaged/fired as a one-decimal percentage
ok 1750 - coverage_pct = triaged/fired as a one-decimal percentage
  ---
  duration_ms: 0.150625
  type: 'test'
  ...
# Subtest: parseAdjudicateArgs: valid log accepted; bad decision/action/missing rationale rejected
ok 1751 - parseAdjudicateArgs: valid log accepted; bad decision/action/missing rationale rejected
  ---
  duration_ms: 0.121167
  type: 'test'
  ...
# Subtest: parseAdjudicateArgs: monitor and all five decisions accepted; list defaults + clamp
ok 1752 - parseAdjudicateArgs: monitor and all five decisions accepted; list defaults + clamp
  ---
  duration_ms: 0.15475
  type: 'test'
  ...
# Subtest: missed rows: grouped by category; null category labelled (unclassified); unjoined engine preserved
ok 1753 - missed rows: grouped by category; null category labelled (unclassified); unjoined engine preserved
  ---
  duration_ms: 0.136917
  type: 'test'
  ...
# Subtest: buildDetailSql: whitelist rejects bad scope/verdict; param slots line up
ok 1754 - buildDetailSql: whitelist rejects bad scope/verdict; param slots line up
  ---
  duration_ms: 0.289292
  type: 'test'
  ...
# Subtest: rollup SQL builders parameterize every arg (no interpolation) and count slots
ok 1755 - rollup SQL builders parameterize every arg (no interpolation) and count slots
  ---
  duration_ms: 0.388458
  type: 'test'
  ...
# Subtest: isEscalationComment + rollup n_escalations count only the marker prefix
ok 1756 - isEscalationComment + rollup n_escalations count only the marker prefix
  ---
  duration_ms: 0.215875
  type: 'test'
  ...
# Subtest: ratio/pct guard zero denominators to null and round
ok 1757 - ratio/pct guard zero denominators to null and round
  ---
  duration_ms: 0.706292
  type: 'test'
  ...
# Subtest: open_adjudications: ≥3 false+nitpick opens; defer/absent open; fix|monitor close
ok 1758 - open_adjudications: ≥3 false+nitpick opens; defer/absent open; fix|monitor close
  ---
  duration_ms: 0.9265
  type: 'test'
  ...
# Subtest: reduceLedgerList marks the newest row per cluster_key as current
ok 1759 - reduceLedgerList marks the newest row per cluster_key as current
  ---
  duration_ms: 0.291334
  type: 'test'
  ...
# Subtest: shapeDetailRow resolves the finding from finding_raw; ref_resolved + history flags
ok 1760 - shapeDetailRow resolves the finding from finding_raw; ref_resolved + history flags
  ---
  duration_ms: 0.363458
  type: 'test'
  ...
# Subtest: adjudication insert/list builders parameterize; clusterKey convention
ok 1761 - adjudication insert/list builders parameterize; clusterKey convention
  ---
  duration_ms: 0.254584
  type: 'test'
  ...
# Subtest: planTap: same-pill tap is a no-op (toggle-off removed)
ok 1762 - planTap: same-pill tap is a no-op (toggle-off removed)
  ---
  duration_ms: 0.746459
  type: 'test'
  ...
# Subtest: revertOnFail restores the previous verdict from the attempt
ok 1763 - revertOnFail restores the previous verdict from the attempt
  ---
  duration_ms: 0.115125
  type: 'test'
  ...
# Subtest: makeAttempt preserves the exact retry payload (verdict + comment)
ok 1764 - makeAttempt preserves the exact retry payload (verdict + comment)
  ---
  duration_ms: 0.652667
  type: 'test'
  ...
# Subtest: savedLabel formats "Saved HH:MM · name" in 24h IST; anon fallback
ok 1765 - savedLabel formats "Saved HH:MM · name" in 24h IST; anon fallback
  ---
  duration_ms: 0.128042
  type: 'test'
  ...
# Subtest: Feature B: saved dedupes by findingRef; caps at total
ok 1766 - Feature B: saved dedupes by findingRef; caps at total
  ---
  duration_ms: 0.110459
  type: 'test'
  ...
# Subtest: Feature B: missed increments its own counter, not triaged
ok 1767 - Feature B: missed increments its own counter, not triaged
  ---
  duration_ms: 0.053666
  type: 'test'
  ...
# Subtest: Feature B: initProgress clamps seed triaged to total and de-dupes/ignores empty refs
ok 1768 - Feature B: initProgress clamps seed triaged to total and de-dupes/ignores empty refs
  ---
  duration_ms: 0.098208
  type: 'test'
  ...
# Subtest: the zero-import SHA-1 matches the standard test vector (addendum A3)
ok 1769 - the zero-import SHA-1 matches the standard test vector (addendum A3)
  ---
  duration_ms: 0.720166
  type: 'test'
  ...
# Subtest: normStableText: NFKC, lowercase, whitespace collapse, trailing punctuation/quotes stripped
ok 1770 - normStableText: NFKC, lowercase, whitespace collapse, trailing punctuation/quotes stripped
  ---
  duration_ms: 0.537625
  type: 'test'
  ...
# Subtest: stable_ref is deterministic and full 40-char lowercase hex
ok 1771 - stable_ref is deterministic and full 40-char lowercase hex
  ---
  duration_ms: 0.154375
  type: 'test'
  ...
# Subtest: A1: the SAME (signal_type, subject) on two DIFFERENT notes produces the SAME ref — by design
ok 1772 - A1: the SAME (signal_type, subject) on two DIFFERENT notes produces the SAME ref — by design
  ---
  duration_ms: 0.072875
  type: 'test'
  ...
# Subtest: stable_ref survives an engine bump: same note re-audited under two engine versions ⇒ same ref
ok 1773 - stable_ref survives an engine bump: same note re-audited under two engine versions ⇒ same ref
  ---
  duration_ms: 0.829583
  type: 'test'
  ...
# Subtest: stable_ref differs when signal_type differs, even for an identical subject
ok 1774 - stable_ref differs when signal_type differs, even for an identical subject
  ---
  duration_ms: 0.082
  type: 'test'
  ...
# Subtest: THE ONE-FUNCTION INVARIANT: engine stamp and backfill produce byte-identical refs
ok 1775 - THE ONE-FUNCTION INVARIANT: engine stamp and backfill produce byte-identical refs
  ---
  duration_ms: 0.218375
  type: 'test'
  ...
# Subtest: null — never a hash of "" — on an empty subject or signal_type
ok 1776 - null — never a hash of "" — on an empty subject or signal_type
  ---
  duration_ms: 0.077083
  type: 'test'
  ...
# Subtest: U+0001 delimiter: a subject containing "|" cannot collide across fields
ok 1777 - U+0001 delimiter: a subject containing "|" cannot collide across fields
  ---
  duration_ms: 0.225792
  type: 'test'
  ...
# Subtest: stampFindingIdentity keeps its ORIGINAL signature and always stamps (addenda A1/A4)
ok 1778 - stampFindingIdentity keeps its ORIGINAL signature and always stamps (addenda A1/A4)
  ---
  duration_ms: 1.401958
  type: 'test'
  ...
# Subtest: finding_ref behaviour is untouched: same hash, same within-note \#2 suffixing
ok 1779 - finding_ref behaviour is untouched: same hash, same within-note \#2 suffixing
  ---
  duration_ms: 0.367375
  type: 'test'
  ...
# Subtest: resolveLabel matches by stable_ref first
ok 1780 - resolveLabel matches by stable_ref first
  ---
  duration_ms: 0.213792
  type: 'test'
  ...
# Subtest: resolveLabel falls back to finding_ref when the stable_ref is absent or dead
ok 1781 - resolveLabel falls back to finding_ref when the stable_ref is absent or dead
  ---
  duration_ms: 0.545
  type: 'test'
  ...
# Subtest: collision ⇒ null + ambiguous:true; never a guess
ok 1782 - collision ⇒ null + ambiguous:true; never a guess
  ---
  duration_ms: 0.157833
  type: 'test'
  ...
# Subtest: A1: uid scoping picks the right finding when two notes share a stable_ref
ok 1783 - A1: uid scoping picks the right finding when two notes share a stable_ref
  ---
  duration_ms: 0.127792
  type: 'test'
  ...
# Subtest: a blank uid resolves to nothing — never an unscoped lookup (A1)
ok 1784 - a blank uid resolves to nothing — never an unscoped lookup (A1)
  ---
  duration_ms: 0.12375
  type: 'test'
  ...
# Subtest: normalizeClusterKey strips "@version" and leaves a bare key unchanged
ok 1785 - normalizeClusterKey strips "@version" and leaves a bare key unchanged
  ---
  duration_ms: 0.124458
  type: 'test'
  ...
# Subtest: F2 min_triaged excludes zero-triaged buckets while every total still reconciles
ok 1786 - F2 min_triaged excludes zero-triaged buckets while every total still reconciles
  ---
  duration_ms: 1.239916
  type: 'test'
  ...
# Subtest: F2 mode=summary respects the 20k budget and sets truncated + n_buckets_omitted
ok 1787 - F2 mode=summary respects the 20k budget and sets truncated + n_buckets_omitted
  ---
  duration_ms: 45.107
  type: 'test'
  ...
# Subtest: F2 summary keeps the top-20 by fired AND every bucket with triaged >= 5
ok 1788 - F2 summary keeps the top-20 by fired AND every bucket with triaged >= 5
  ---
  duration_ms: 3.201792
  type: 'test'
  ...
# Subtest: F4 reviewers_current sums to totals.triaged; reviewers_all_rows keeps its own basis
ok 1789 - F4 reviewers_current sums to totals.triaged; reviewers_all_rows keeps its own basis
  ---
  duration_ms: 2.97525
  type: 'test'
  ...
# Subtest: F4 reviewers_current degrades to [] when its query fails, without breaking the rollup
ok 1790 - F4 reviewers_current degrades to [] when its query fails, without breaking the rollup
  ---
  duration_ms: 0.409625
  type: 'test'
  ...
# Subtest: open_adjudications uses the BARE signal_type and honours a normalised historical ledger key
ok 1791 - open_adjudications uses the BARE signal_type and honours a normalised historical ledger key
  ---
  duration_ms: 0.234208
  type: 'test'
  ...
# Subtest: ledger folding is newest-first-wins when several versioned keys normalise onto one
ok 1792 - ledger folding is newest-first-wins when several versioned keys normalise onto one
  ---
  duration_ms: 0.057042
  type: 'test'
  ...
# Subtest: reduceLedgerList decides currency on the NORMALISED key (normative detail 5)
ok 1793 - reduceLedgerList decides currency on the NORMALISED key (normative detail 5)
  ---
  duration_ms: 0.079625
  type: 'test'
  ...
# Subtest: ageBandOf boundaries
ok 1794 - ageBandOf boundaries
  ---
  duration_ms: 1.200625
  type: 'test'
  ...
# Subtest: stratum fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global
ok 1795 - stratum fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global
  ---
  duration_ms: 0.42925
  type: 'test'
  ...
# Subtest: age unavailable (null) collapses band×age → band marginal (reproduces the gate)
ok 1796 - age unavailable (null) collapses band×age → band marginal (reproduces the gate)
  ---
  duration_ms: 0.149333
  type: 'test'
  ...
# Subtest: O/E arithmetic: expected = Σ n·stratumMean; raw = O/n; oe = O/E
ok 1797 - O/E arithmetic: expected = Σ n·stratumMean; raw = O/n; oe = O/E
  ---
  duration_ms: 0.353
  type: 'test'
  ...
# Subtest: zero denominator → oe null; unbanded cells excluded
ok 1798 - zero denominator → oe null; unbanded cells excluded
  ---
  duration_ms: 0.193334
  type: 'test'
  ...
# Subtest: exclusion-set filtering: excluded doctor drops from output AND from stratum means
ok 1799 - exclusion-set filtering: excluded doctor drops from output AND from stratum means
  ---
  duration_ms: 0.178834
  type: 'test'
  ...
# Subtest: funnel limits vs hand-computed
ok 1800 - funnel limits vs hand-computed
  ---
  duration_ms: 0.810167
  type: 'test'
  ...
# Subtest: funnelCurve dedupes+sorts n; funnelPosition classifies vs limits + building
ok 1801 - funnelCurve dedupes+sorts n; funnelPosition classifies vs limits + building
  ---
  duration_ms: 0.298834
  type: 'test'
  ...
# Subtest: reference format + parse round-trips and validates
ok 1802 - reference format + parse round-trips and validates
  ---
  duration_ms: 0.957833
  type: 'test'
  ...
# Subtest: SLA only when a timely response is owed; privilege-review escalates on mint
ok 1803 - SLA only when a timely response is owed; privilege-review escalates on mint
  ---
  duration_ms: 0.787125
  type: 'test'
  ...
# Subtest: isOverdue: only a routed, past-SLA, response-owed signal is overdue
ok 1804 - isOverdue: only a routed, past-SLA, response-owed signal is overdue
  ---
  duration_ms: 0.077583
  type: 'test'
  ...
# Subtest: status machine: response + action transitions
ok 1805 - status machine: response + action transitions
  ---
  duration_ms: 0.063458
  type: 'test'
  ...
# Subtest: validateDoctorResponse: type must match; explanation needs comment+verdict; guards
ok 1806 - validateDoctorResponse: type must match; explanation needs comment+verdict; guards
  ---
  duration_ms: 0.148791
  type: 'test'
  ...
# Subtest: validateSignalAction: enum guard + normalize
ok 1807 - validateSignalAction: enum guard + normalize
  ---
  duration_ms: 0.067584
  type: 'test'
  ...
# Subtest: signalObject: shape + overdue + label; no patient fields
ok 1808 - signalObject: shape + overdue + label; no patient fields
  ---
  duration_ms: 0.159708
  type: 'test'
  ...
# Subtest: healthy attribute produces no signal
ok 1809 - healthy attribute produces no signal
  ---
  duration_ms: 1.476542
  type: 'test'
  ...
# Subtest: act_now severity below 2.5, watch below 3.5
ok 1810 - act_now severity below 2.5, watch below 3.5
  ---
  duration_ms: 0.479541
  type: 'test'
  ...
# Subtest: trend computed vs prior window with ±0.3 threshold
ok 1811 - trend computed vs prior window with ±0.3 threshold
  ---
  duration_ms: 0.273583
  type: 'test'
  ...
# Subtest: no baseline ⇒ no_baseline trend
ok 1812 - no baseline ⇒ no_baseline trend
  ---
  duration_ms: 0.141917
  type: 'test'
  ...
# Subtest: systemic scope when most eligible doctors are affected — hospital-level action
ok 1813 - systemic scope when most eligible doctors are affected — hospital-level action
  ---
  duration_ms: 0.457708
  type: 'test'
  ...
# Subtest: concentrated scope names the affected doctors, worst first
ok 1814 - concentrated scope names the affected doctors, worst first
  ---
  duration_ms: 0.322666
  type: 'test'
  ...
# Subtest: mixed scope appends the lowest-scoring doctors to the systemic action
ok 1815 - mixed scope appends the lowest-scoring doctors to the systemic action
  ---
  duration_ms: 0.342542
  type: 'test'
  ...
# Subtest: insufficient eligible doctors falls back to systemic wording
ok 1816 - insufficient eligible doctors falls back to systemic wording
  ---
  duration_ms: 0.104208
  type: 'test'
  ...
# Subtest: doctors below doctorMinNotes are not eligible
ok 1817 - doctors below doctorMinNotes are not eligible
  ---
  duration_ms: 0.22925
  type: 'test'
  ...
# Subtest: ranking: act_now before watch, then mean ascending; healthy sorted best-first
ok 1818 - ranking: act_now before watch, then mean ascending; healthy sorted best-first
  ---
  duration_ms: 0.667125
  type: 'test'
  ...
# Subtest: thresholds are overridable
ok 1819 - thresholds are overridable
  ---
  duration_ms: 0.0755
  type: 'test'
  ...
# Subtest: lower_worse severity: completeness 74 act_now, 88 watch, 96 healthy
ok 1820 - lower_worse severity: completeness 74 act_now, 88 watch, 96 healthy
  ---
  duration_ms: 3.229875
  type: 'test'
  ...
# Subtest: higher_worse severity: interactions 25/100 act_now, 12 watch, 8 healthy
ok 1821 - higher_worse severity: interactions 25/100 act_now, 12 watch, 8 healthy
  ---
  duration_ms: 0.105375
  type: 'test'
  ...
# Subtest: direction-aware trend: rising interactions = worsening, rising completeness = improving
ok 1822 - direction-aware trend: rising interactions = worsening, rising completeness = improving
  ---
  duration_ms: 0.070958
  type: 'test'
  ...
# Subtest: scope: systemic when most doctors low; concentrated names them worst-first (higher_worse)
ok 1823 - scope: systemic when most doctors low; concentrated names them worst-first (higher_worse)
  ---
  duration_ms: 0.172708
  type: 'test'
  ...
# Subtest: placeholders substituted; fallbacks when absent
ok 1824 - placeholders substituted; fallbacks when absent
  ---
  duration_ms: 0.1885
  type: 'test'
  ...
# Subtest: low_value_rate is HELD by default; included with includeHeld + confidence estimate
ok 1825 - low_value_rate is HELD by default; included with includeHeld + confidence estimate
  ---
  duration_ms: 0.065792
  type: 'test'
  ...
# Subtest: kind discriminator and unit present on every domain signal
ok 1826 - kind discriminator and unit present on every domain signal
  ---
  duration_ms: 0.097917
  type: 'test'
  ...
# Subtest: mixed scope appends most-affected list to systemic action
ok 1827 - mixed scope appends most-affected list to systemic action
  ---
  duration_ms: 0.082208
  type: 'test'
  ...
# Subtest: bandFor and its thresholds are BYTE-IDENTICAL — hysteresis wraps, never replaces
ok 1828 - bandFor and its thresholds are BYTE-IDENTICAL — hysteresis wraps, never replaces
  ---
  duration_ms: 0.520709
  type: 'test'
  ...
# Subtest: NULL prior (first score at this version) ⇒ bandFor(index) — the anchor is set normally
ok 1829 - NULL prior (first score at this version) ⇒ bandFor(index) — the anchor is set normally
  ---
  duration_ms: 0.139875
  type: 'test'
  ...
# Subtest: THE TABLE (g = 3.87): each held band leaves exactly at its ± g edges
ok 1830 - THE TABLE (g = 3.87): each held band leaves exactly at its ± g edges
  ---
  duration_ms: 0.070167
  type: 'test'
  ...
# Subtest: a decisive crossing lands on bandFor(index), even across MULTIPLE bands
ok 1831 - a decisive crossing lands on bandFor(index), even across MULTIPLE bands
  ---
  duration_ms: 0.037542
  type: 'test'
  ...
# Subtest: THE POINT: a threshold-proximity wobble no longer flips the displayed band
ok 1832 - THE POINT: a threshold-proximity wobble no longer flips the displayed band
  ---
  duration_ms: 0.055625
  type: 'test'
  ...
# Subtest: the SQL CASE mirrors the pure function EXACTLY, built from the same HYSTERESIS_G
ok 1833 - the SQL CASE mirrors the pure function EXACTLY, built from the same HYSTERESIS_G
  ---
  duration_ms: 0.146584
  type: 'test'
  ...
# Subtest: all three write paths set displayed_band: insert anchor, conflict CASE, update CASE
ok 1834 - all three write paths set displayed_band: insert anchor, conflict CASE, update CASE
  ---
  duration_ms: 0.106625
  type: 'test'
  ...
# Subtest: deploy-before-migrate tolerance on BOTH writers and readers — 0029 not yet run ⇒ raw band, never a blank page
ok 1835 - deploy-before-migrate tolerance on BOTH writers and readers — 0029 not yet run ⇒ raw band, never a blank page
  ---
  duration_ms: 0.297875
  type: 'test'
  ...
# Subtest: every per-note band display renders displayed_band with the raw-band fallback
ok 1836 - every per-note band display renders displayed_band with the raw-band fallback
  ---
  duration_ms: 0.41375
  type: 'test'
  ...
# Subtest: migration 0029 is exactly one additive, idempotent statement
ok 1837 - migration 0029 is exactly one additive, idempotent statement
  ---
  duration_ms: 0.416125
  type: 'test'
  ...
# Subtest: engine version is current AND the read family includes it (the classic error, not repeated)
ok 1838 - engine version is current AND the read family includes it (the classic error, not repeated)
  ---
  duration_ms: 0.062042
  type: 'test'
  ...
# Subtest: S0 behaviour and worker dedup are UNTOUCHED by S1
ok 1839 - S0 behaviour and worker dedup are UNTOUCHED by S1
  ---
  duration_ms: 0.26
  type: 'test'
  ...
# Subtest: the lab eval path knows nothing of hysteresis or displayed_band
ok 1840 - the lab eval path knows nothing of hysteresis or displayed_band
  ---
  duration_ms: 0.252166
  type: 'test'
  ...
# Subtest: precedence: explicit consult_type regex wins over everything
ok 1841 - precedence: explicit consult_type regex wins over everything
  ---
  duration_ms: 0.580792
  type: 'test'
  ...
# Subtest: consult_types markers: VISITING_HOSPITAL / EMERGENCY → in-person, and WIN over CHAT
ok 1842 - consult_types markers: VISITING_HOSPITAL / EMERGENCY → in-person, and WIN over CHAT
  ---
  duration_ms: 0.708834
  type: 'test'
  ...
# Subtest: consult_types markers: CHAT → tele (when no in-person marker); HOSPITAL_* + CHAT = tele
ok 1843 - consult_types markers: CHAT → tele (when no in-person marker); HOSPITAL_* + CHAT = tele
  ---
  duration_ms: 0.205041
  type: 'test'
  ...
# Subtest: fallback: form-type default when no markers (GENERAL_PRACTITIONER → tele; HOSPITAL_* → in-person)
ok 1844 - fallback: form-type default when no markers (GENERAL_PRACTITIONER → tele; HOSPITAL_* → in-person)
  ---
  duration_ms: 0.269791
  type: 'test'
  ...
# Subtest: hands-on-exam downgrade still applies AFTER classification (unchanged)
ok 1845 - hands-on-exam downgrade still applies AFTER classification (unchanged)
  ---
  duration_ms: 0.699416
  type: 'test'
  ...
# Subtest: formatEncounterChip: channel first, form second
ok 1846 - formatEncounterChip: channel first, form second
  ---
  duration_ms: 0.170333
  type: 'test'
  ...
# Subtest: parseConsultTypes: JS array / JSON string / PG array literal / empty → clean string[]
ok 1847 - parseConsultTypes: JS array / JSON string / PG array literal / empty → clean string[]
  ---
  duration_ms: 1.09775
  type: 'test'
  ...
# Subtest: currentVisitNote: prefers show_in_prescription; falls back to latest non-carried date_of_visit
ok 1848 - currentVisitNote: prefers show_in_prescription; falls back to latest non-carried date_of_visit
  ---
  duration_ms: 13.057916
  type: 'test'
  ...
# Subtest: parseTrimester: numeric / worded / derived-from-GA-weeks; null when unparseable
ok 1849 - parseTrimester: numeric / worded / derived-from-GA-weeks; null when unparseable
  ---
  duration_ms: 0.443916
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: llmLegFailedAfterParse: failed when the parse produced nothing PDQI-9-usable
ok 1850 - llmLegFailedAfterParse: failed when the parse produced nothing PDQI-9-usable
  ---
  duration_ms: 0.552417
  type: 'test'
  ...
# Subtest: the predicate is DELIBERATELY weaker than the lab guard — partial PDQI-9 passes in production
ok 1851 - the predicate is DELIBERATELY weaker than the lab guard — partial PDQI-9 passes in production
  ---
  duration_ms: 0.073625
  type: 'test'
  ...
# Subtest: exactly ONE bounded retry, gated on !opts.evalModel, whether the leg THREW or parsed to nothing
ok 1852 - exactly ONE bounded retry, gated on !opts.evalModel, whether the leg THREW or parsed to nothing
  ---
  duration_ms: 0.20375
  type: 'test'
  ...
# Subtest: a worse retry never replaces a partial first attempt
ok 1853 - a worse retry never replaces a partial first attempt
  ---
  duration_ms: 0.056709
  type: 'test'
  ...
# Subtest: the signal can NEVER be set on the eval path — lab rows must not carry production marks
ok 1854 - the signal can NEVER be set on the eval path — lab rows must not carry production marks
  ---
  duration_ms: 0.05625
  type: 'test'
  ...
# Subtest: the det-only fallback is marked UNCONDITIONALLY — every fallback row is a failed measurement
ok 1855 - the det-only fallback is marked UNCONDITIONALLY — every fallback row is a failed measurement
  ---
  duration_ms: 0.073125
  type: 'test'
  ...
# Subtest: the eval-path parse guards are UNCHANGED — d08bba7 is not the pattern here, but it still stands
ok 1856 - the eval-path parse guards are UNCHANGED — d08bba7 is not the pattern here, but it still stands
  ---
  duration_ms: 0.119958
  type: 'test'
  ...
# Subtest: saveOpdAudit writes the mark only when signal AND stored pdqi9 are both empty
ok 1857 - saveOpdAudit writes the mark only when signal AND stored pdqi9 are both empty
  ---
  duration_ms: 0.048625
  type: 'test'
  ...
# Subtest: a successful re-audit CLEARS a stale mark; house_account is preserved verbatim — both paths
ok 1858 - a successful re-audit CLEARS a stale mark; house_account is preserved verbatim — both paths
  ---
  duration_ms: 0.159375
  type: 'test'
  ...
# Subtest: D6 — the trap survives in its NARROWED form: only an incident makes a note re-auditable
ok 1859 - D6 — the trap survives in its NARROWED form: only an incident makes a note re-auditable
  ---
  duration_ms: 0.407666
  type: 'test'
  ...
# Subtest: addendum F v2 task 2 — a failed row never blocks a retry, a successful row is never overwritten
ok 1860 - addendum F v2 task 2 — a failed row never blocks a retry, a successful row is never overwritten
  ---
  duration_ms: 0.126167
  type: 'test'
  ...
# Subtest: the canonical id set still excludes marked rows — the mark IS the aggregate exclusion
ok 1861 - the canonical id set still excludes marked rows — the mark IS the aggregate exclusion
  ---
  duration_ms: 0.033917
  type: 'test'
  ...
# Subtest: EVERY enumerated aggregate/display reader excludes marked rows
ok 1862 - EVERY enumerated aggregate/display reader excludes marked rows
  ---
  duration_ms: 0.770625
  type: 'test'
  ...
# Subtest: the detail page suppresses the score and says exactly "Not assessed at this engine version"
ok 1863 - the detail page suppresses the score and says exactly "Not assessed at this engine version"
  ---
  duration_ms: 0.149834
  type: 'test'
  ...
# Subtest: the escalation package never hands a failed measurement to an external reviewer
ok 1864 - the escalation package never hands a failed measurement to an external reviewer
  ---
  duration_ms: 0.035667
  type: 'test'
  ...
# Subtest: the backfill predicate is the §5 / S0-gate predicate VERBATIM
ok 1865 - the backfill predicate is the §5 / S0-gate predicate VERBATIM
  ---
  duration_ms: 0.029167
  type: 'test'
  ...
# Subtest: DRY-RUN BY DEFAULT: the write happens only under ?apply=1, and the delta is always reported
ok 1866 - DRY-RUN BY DEFAULT: the write happens only under ?apply=1, and the delta is always reported
  ---
  duration_ms: 0.113
  type: 'test'
  ...
# Subtest: opd-note-score-core.ts knows nothing of any of this — no scoring change, no engine bump
ok 1867 - opd-note-score-core.ts knows nothing of any of this — no scoring change, no engine bump
  ---
  duration_ms: 0.090916
  type: 'test'
  ...
# Subtest: parseOpdAnalysis is untouched — the guard sits at the call site, production keeps the leniency
ok 1868 - parseOpdAnalysis is untouched — the guard sits at the call site, production keeps the leniency
  ---
  duration_ms: 0.064833
  type: 'test'
  ...
# Subtest: the lab batch path knows nothing of llmLegFailed
ok 1869 - the lab batch path knows nothing of llmLegFailed
  ---
  duration_ms: 0.212791
  type: 'test'
  ...
# Subtest: L1: TSH re-ordered within 42-day interval → one repeat_test finding citing the prior value
ok 1870 - L1: TSH re-ordered within 42-day interval → one repeat_test finding citing the prior value
  ---
  duration_ms: 1.214292
  type: 'test'
  ...
# Subtest: L1: HbA1c prior is OUTSIDE its 90-day interval → no finding
ok 1871 - L1: HbA1c prior is OUTSIDE its 90-day interval → no finding
  ---
  duration_ms: 0.111458
  type: 'test'
  ...
# Subtest: L1: an unmatched analyte (CBC — no canonical id) yields NO finding
ok 1872 - L1: an unmatched analyte (CBC — no canonical id) yields NO finding
  ---
  duration_ms: 0.326334
  type: 'test'
  ...
# Subtest: L1: analyte normalization matches note ↔ state (Vitamin D synonym within 90d)
ok 1873 - L1: analyte normalization matches note ↔ state (Vitamin D synonym within 90d)
  ---
  duration_ms: 0.264
  type: 'test'
  ...
# Subtest: L1: the retest table keys on canonical analyte ids (house defaults)
ok 1874 - L1: the retest table keys on canonical analyte ids (house defaults)
  ---
  duration_ms: 0.145083
  type: 'test'
  ...
# Subtest: L2: re-prescription of a patient-reported-stopped drug → med_reconciliation citing the stop
ok 1875 - L2: re-prescription of a patient-reported-stopped drug → med_reconciliation citing the stop
  ---
  duration_ms: 0.617875
  type: 'test'
  ...
# Subtest: L2: continuation of an active prior prescription → med_reconciliation (duplicate continuation)
ok 1876 - L2: continuation of an active prior prescription → med_reconciliation (duplicate continuation)
  ---
  duration_ms: 0.1975
  type: 'test'
  ...
# Subtest: L2: no false match — a drug not in the prior state produces nothing
ok 1877 - L2: no false match — a drug not in the prior state produces nothing
  ---
  duration_ms: 1.073458
  type: 'test'
  ...
# Subtest: L2: both cases fire together for a mixed note
ok 1878 - L2: both cases fire together for a mixed note
  ---
  duration_ms: 0.366334
  type: 'test'
  ...
# Subtest: L3-det: a severe open care gap not re-ordered / not mentioned → missed_followup
ok 1879 - L3-det: a severe open care gap not re-ordered / not mentioned → missed_followup
  ---
  duration_ms: 1.953375
  type: 'test'
  ...
# Subtest: L3-det: ORDERING the analyte in the note suppresses the finding (addressed)
ok 1880 - L3-det: ORDERING the analyte in the note suppresses the finding (addressed)
  ---
  duration_ms: 0.417958
  type: 'test'
  ...
# Subtest: L3-det: MENTIONING the analyte in the impression suppresses the finding
ok 1881 - L3-det: MENTIONING the analyte in the impression suppresses the finding
  ---
  duration_ms: 0.260417
  type: 'test'
  ...
# Subtest: battery: the full deterministic pass yields L1 + L2×2 + L3 on the fixture
ok 1882 - battery: the full deterministic pass yields L1 + L2×2 + L3 on the fixture
  ---
  duration_ms: 0.296625
  type: 'test'
  ...
# Subtest: serializer: emits the priority-ordered sections and stays under the char budget
ok 1883 - serializer: emits the priority-ordered sections and stays under the char budget
  ---
  duration_ms: 0.550375
  type: 'test'
  ...
# Subtest: serializer: validMonths grounds only real encounter months
ok 1884 - serializer: validMonths grounds only real encounter months
  ---
  duration_ms: 0.131291
  type: 'test'
  ...
# Subtest: serializer: truncates tail-first when over budget (header survives, last section dropped)
ok 1885 - serializer: truncates tail-first when over budget (header survives, last section dropped)
  ---
  duration_ms: 0.507583
  type: 'test'
  ...
# Subtest: serializer: de-identified — no uid / member identifier can leak (serializer takes none)
ok 1886 - serializer: de-identified — no uid / member identifier can leak (serializer takes none)
  ---
  duration_ms: 0.128417
  type: 'test'
  ...
# Subtest: buildLongitudinalUser: notes the teleconsult fairness guard in the payload
ok 1887 - buildLongitudinalUser: notes the teleconsult fairness guard in the payload
  ---
  duration_ms: 0.287209
  type: 'test'
  ...
# Subtest: LLM parse: a grounded finding is kept and mapped to the right signal type
ok 1888 - LLM parse: a grounded finding is kept and mapped to the right signal type
  ---
  duration_ms: 0.238083
  type: 'test'
  ...
# Subtest: LLM parse: an UNGROUNDED finding (cited date not in context) is dropped (no hindsight)
ok 1889 - LLM parse: an UNGROUNDED finding (cited date not in context) is dropped (no hindsight)
  ---
  duration_ms: 0.103459
  type: 'test'
  ...
# Subtest: LLM parse: continuity is the default type; malformed JSON → []
ok 1890 - LLM parse: continuity is the default type; malformed JSON → []
  ---
  duration_ms: 0.325333
  type: 'test'
  ...
# Subtest: stampLongitudinal: assigns a finding_ref but PRESERVES the explicit longitudinal signal_type
ok 1891 - stampLongitudinal: assigns a finding_ref but PRESERVES the explicit longitudinal signal_type
  ---
  duration_ms: 1.408916
  type: 'test'
  ...
# Subtest: suppression pass-through: an active suppression drops a longitudinal type like any finding
ok 1892 - suppression pass-through: an active suppression drops a longitudinal type like any finding
  ---
  duration_ms: 0.431666
  type: 'test'
  ...
# Subtest: confidenceFor: 0 → none, 1-2 → thin, ≥3 → established
ok 1893 - confidenceFor: 0 → none, 1-2 → thin, ≥3 → established
  ---
  duration_ms: 0.037625
  type: 'test'
  ...
# Subtest: emptyLongitudinalBlock: carries the honest excluded_reason and zero findings
ok 1894 - emptyLongitudinalBlock: carries the honest excluded_reason and zero findings
  ---
  duration_ms: 0.049834
  type: 'test'
  ...
# Subtest: buildLongitudinalInput: null without uid/date; a clean projection that never mutates the case
ok 1895 - buildLongitudinalInput: null without uid/date; a clean projection that never mutates the case
  ---
  duration_ms: 0.108
  type: 'test'
  ...
# Subtest: zero-drift: the battery + serializer + stamp never mutate the snapshot or note input
ok 1896 - zero-drift: the battery + serializer + stamp never mutate the snapshot or note input
  ---
  duration_ms: 2.153167
  type: 'test'
  ...
# Subtest: buildLongitudinalGates seeds all 5 longitudinal types at 0/0
ok 1897 - buildLongitudinalGates seeds all 5 longitudinal types at 0/0
  ---
  duration_ms: 1.560875
  type: 'test'
  ...
# Subtest: overlays signal-health decided → labelled and fp_rate → fpRate for longitudinal types
ok 1898 - overlays signal-health decided → labelled and fp_rate → fpRate for longitudinal types
  ---
  duration_ms: 0.340375
  type: 'test'
  ...
# Subtest: ignores non-longitudinal (routable) signal types from signal-health
ok 1899 - ignores non-longitudinal (routable) signal types from signal-health
  ---
  duration_ms: 0.25425
  type: 'test'
  ...
# Subtest: clamps out-of-range / non-finite fp_rate and negative decided
ok 1900 - clamps out-of-range / non-finite fp_rate and negative decided
  ---
  duration_ms: 0.269916
  type: 'test'
  ...
# Subtest: gates feed buildLabelLane → promotion status matches promotionGate directly
ok 1901 - gates feed buildLabelLane → promotion status matches promotionGate directly
  ---
  duration_ms: 0.705
  type: 'test'
  ...
# Subtest: lane only contains non-routable longitudinal types (routable dropped)
ok 1902 - lane only contains non-routable longitudinal types (routable dropped)
  ---
  duration_ms: 0.182166
  type: 'test'
  ...
# Subtest: classifyLvcCategory: antibiotic | imaging | supplement | other
ok 1903 - classifyLvcCategory: antibiotic | imaging | supplement | other
  ---
  duration_ms: 12.055041
  type: 'test'
  ...
# Subtest: stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved
ok 1904 - stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved
  ---
  duration_ms: 0.226541
  type: 'test'
  ...
# Subtest: stampLvcMetadata preserves an existing rule_ref
ok 1905 - stampLvcMetadata preserves an existing rule_ref
  ---
  duration_ms: 0.064708
  type: 'test'
  ...
# Subtest: classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC
ok 1906 - classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC
  ---
  duration_ms: 0.109209
  type: 'test'
  ...
# Subtest: classifyLvcFinding: stamped row passes its metadata through
ok 1907 - classifyLvcFinding: stamped row passes its metadata through
  ---
  duration_ms: 0.415583
  type: 'test'
  ...
# Subtest: classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)
ok 1908 - classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)
  ---
  duration_ms: 0.871541
  type: 'test'
  ...
# Subtest: precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all
ok 1909 - precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all
  ---
  duration_ms: 0.286042
  type: 'test'
  ...
# Subtest: LVC_CATEGORIES vocabulary — 3 base + 8 overuse sub-tags + other (0.81.8 Part B)
ok 1910 - LVC_CATEGORIES vocabulary — 3 base + 8 overuse sub-tags + other (0.81.8 Part B)
  ---
  duration_ms: 0.955084
  type: 'test'
  ...
# Subtest: matcher v3: OR across keywords — alternative trigger phrases (the CW-rule fix)
ok 1911 - matcher v3: OR across keywords — alternative trigger phrases (the CW-rule fix)
  ---
  duration_ms: 0.72175
  type: 'test'
  ...
# Subtest: matcher v3: AND within a keyword — every token must be a whole word
ok 1912 - matcher v3: AND within a keyword — every token must be a whole word
  ---
  duration_ms: 0.410083
  type: 'test'
  ...
# Subtest: matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null
ok 1913 - matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null
  ---
  duration_ms: 1.026416
  type: 'test'
  ...
# Subtest: matcher v3: bare 1-token keyword over-matches under OR (why CBP is re-authored in data, 26a)
ok 1914 - matcher v3: bare 1-token keyword over-matches under OR (why CBP is re-authored in data, 26a)
  ---
  duration_ms: 0.198834
  type: 'test'
  ...
# Subtest: matcher v3: zero-keyword / empty-token rules never match; category from matched rule
ok 1915 - matcher v3: zero-keyword / empty-token rules never match; category from matched rule
  ---
  duration_ms: 0.086583
  type: 'test'
  ...
# Subtest: stampLvcMetadata: no rules → rule_ref null; non-low-value + informational skipped; scores untouched
ok 1916 - stampLvcMetadata: no rules → rule_ref null; non-low-value + informational skipped; scores untouched
  ---
  duration_ms: 0.08275
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: no normative hits ⇒ assembleAuditContext is byte-identical to today's assembly
ok 1917 - no normative hits ⇒ assembleAuditContext is byte-identical to today's assembly
  ---
  duration_ms: 3.787625
  type: 'test'
  ...
# Subtest: channel mode: the literature retrieve opts are unchanged — useNormativeLeg is NOT set
ok 1918 - channel mode: the literature retrieve opts are unchanged — useNormativeLeg is NOT set
  ---
  duration_ms: 0.28375
  type: 'test'
  ...
# Subtest: normativeChannelOpts: standalone CW-only search — restrictSources, topK 4, leg NOT set
ok 1919 - normativeChannelOpts: standalone CW-only search — restrictSources, topK 4, leg NOT set
  ---
  duration_ms: 0.178458
  type: 'test'
  ...
# Subtest: channel context: literature [1-8] then the labelled normative block [9+]
ok 1920 - channel context: literature [1-8] then the labelled normative block [9+]
  ---
  duration_ms: 0.13125
  type: 'test'
  ...
# Subtest: numbering adapts when fewer than 8 literature excerpts return
ok 1921 - numbering adapts when fewer than 8 literature excerpts return
  ---
  duration_ms: 0.134333
  type: 'test'
  ...
# Subtest: buildNormativeBlock: empty hits ⇒ empty string (audit proceeds on literature alone)
ok 1922 - buildNormativeBlock: empty hits ⇒ empty string (audit proceeds on literature alone)
  ---
  duration_ms: 0.039709
  type: 'test'
  ...
# Subtest: evalNormativeChannel is independent of evalNormativeLeg — no union, no eviction
ok 1923 - evalNormativeChannel is independent of evalNormativeLeg — no union, no eviction
  ---
  duration_ms: 0.157667
  type: 'test'
  ...
# Subtest: the eval path still writes lab_analyses only — never opd_note_audits
ok 1924 - the eval path still writes lab_analyses only — never opd_note_audits
  ---
  duration_ms: 0.241958
  type: 'test'
  ...
# Subtest: OPD_AUDIT_SYSTEM is untouched — the channel header is not injected into the system prompt
ok 1925 - OPD_AUDIT_SYSTEM is untouched — the channel header is not injected into the system prompt
  ---
  duration_ms: 0.341959
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: flag off ⇒ opts byte-identical to today (no useNormativeLeg key)
ok 1926 - flag off ⇒ opts byte-identical to today (no useNormativeLeg key)
  ---
  duration_ms: 0.801875
  type: 'test'
  ...
# Subtest: flag on + non-mini ⇒ useNormativeLeg: true
ok 1927 - flag on + non-mini ⇒ useNormativeLeg: true
  ---
  duration_ms: 0.08625
  type: 'test'
  ...
# Subtest: flag on + mini ⇒ no useNormativeLeg key (mini path can never enable the leg)
ok 1928 - flag on + mini ⇒ no useNormativeLeg key (mini path can never enable the leg)
  ---
  duration_ms: 0.052208
  type: 'test'
  ...
# Subtest: only OPD_NORMATIVE_LEG_ENABLED === "1" enables the leg
ok 1929 - only OPD_NORMATIVE_LEG_ENABLED === "1" enables the leg
  ---
  duration_ms: 0.176666
  type: 'test'
  ...
# Subtest: rowToOpdCase parses stringified JSONB + separates de-identified case from keys
ok 1930 - rowToOpdCase parses stringified JSONB + separates de-identified case from keys
  ---
  duration_ms: 3.169
  type: 'test'
  ...
# Subtest: rowToOpdCase reads the NESTED GP fields (the extraction fix)
ok 1931 - rowToOpdCase reads the NESTED GP fields (the extraction fix)
  ---
  duration_ms: 1.994958
  type: 'test'
  ...
# Subtest: rowToOpdCase prefers the dpipe pipeline content over the nested source fields
ok 1932 - rowToOpdCase prefers the dpipe pipeline content over the nested source fields
  ---
  duration_ms: 0.371792
  type: 'test'
  ...
# Subtest: 0.6: referral handoff — leaflet excluded, referral + teleconsult surfaced
ok 1933 - 0.6: referral handoff — leaflet excluded, referral + teleconsult surfaced
  ---
  duration_ms: 1.187708
  type: 'test'
  ...
# Subtest: 0.6: teleconsult completeness — examination is not scored (N/A), referral counts as the plan
ok 1934 - 0.6: teleconsult completeness — examination is not scored (N/A), referral counts as the plan
  ---
  duration_ms: 1.544791
  type: 'test'
  ...
# Subtest: opdCompleteness flags the real gaps; allergy + history items removed
ok 1935 - opdCompleteness flags the real gaps; allergy + history items removed
  ---
  duration_ms: 4.286709
  type: 'test'
  ...
# Subtest: route inference: documented → used; blank → inferred from form; no form → null (real gap)
ok 1936 - route inference: documented → used; blank → inferred from form; no form → null (real gap)
  ---
  duration_ms: 1.086292
  type: 'test'
  ...
# Subtest: dose documented from the field, the strength field, or the strength embedded in the drug name
ok 1937 - dose documented from the field, the strength field, or the strength embedded in the drug name
  ---
  duration_ms: 1.034708
  type: 'test'
  ...
# Subtest: prescribingChecks: dosing gap only when route is truly ambiguous / amount is absent (0.5)
ok 1938 - prescribingChecks: dosing gap only when route is truly ambiguous / amount is absent (0.5)
  ---
  duration_ms: 1.896
  type: 'test'
  ...
# Subtest: prescribingChecks: unverified brand, duplicate by RESOLVED generic, high-alert info (v0.4)
ok 1939 - prescribingChecks: unverified brand, duplicate by RESOLVED generic, high-alert info (v0.4)
  ---
  duration_ms: 1.386958
  type: 'test'
  ...
# Subtest: parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations
ok 1940 - parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations
  ---
  duration_ms: 0.355459
  type: 'test'
  ...
# Subtest: C1: parseOpdAnalysis strips a reasoning <think> block (DeepSeek-R1) before parsing
ok 1941 - C1: parseOpdAnalysis strips a reasoning <think> block (DeepSeek-R1) before parsing
  ---
  duration_ms: 0.113667
  type: 'test'
  ...
# Subtest: opdSignalType maps every deterministic subject shape to the controlled vocab
ok 1942 - opdSignalType maps every deterministic subject shape to the controlled vocab
  ---
  duration_ms: 0.480541
  type: 'test'
  ...
# Subtest: opdSignalType: LLM subjects — antibiotic rule, coarse domain×verdict buckets, general fallback
ok 1943 - opdSignalType: LLM subjects — antibiotic rule, coarse domain×verdict buckets, general fallback
  ---
  duration_ms: 0.436459
  type: 'test'
  ...
# Subtest: stampFindingIdentity: stable refs, severity-change stable, distinct details distinct
ok 1944 - stampFindingIdentity: stable refs, severity-change stable, distinct details distinct
  ---
  duration_ms: 0.753916
  type: 'test'
  ...
# Subtest: 0.81.11: form/dosageForm are inert — prescribingChecks output is byte-identical with them present vs absent
ok 1945 - 0.81.11: form/dosageForm are inert — prescribingChecks output is byte-identical with them present vs absent
  ---
  duration_ms: 0.470417
  type: 'test'
  ...
# Subtest: 0.81.12 CANARY: guideline-recommended vaccine co-administration produces NO finding (LASA deleted)
ok 1946 - 0.81.12 CANARY: guideline-recommended vaccine co-administration produces NO finding (LASA deleted)
  ---
  duration_ms: 0.112
  type: 'test'
  ...
# Subtest: 0.81.12 (Stage 2a): the SCORING molecule-subset dedup is NOT present — a mono+FDC produces no new penalty
ok 1947 - 0.81.12 (Stage 2a): the SCORING molecule-subset dedup is NOT present — a mono+FDC produces no new penalty
  ---
  duration_ms: 0.094167
  type: 'test'
  ...
# Subtest: 0.81.10: a low-value deterministic finding RETAINS its specific signal_type (no collapse to low_value_care)
ok 1948 - 0.81.10: a low-value deterministic finding RETAINS its specific signal_type (no collapse to low_value_care)
  ---
  duration_ms: 0.322041
  type: 'test'
  ...
# Subtest: 0.81.10: the muscle-relaxant documentation subject maps to signal_type muscle_relaxant_indication
ok 1949 - 0.81.10: the muscle-relaxant documentation subject maps to signal_type muscle_relaxant_indication
  ---
  duration_ms: 0.041875
  type: 'test'
  ...
# Subtest: stampFindingIdentity: within-note collision suffixes \#2, \#3 deterministically
ok 1950 - stampFindingIdentity: within-note collision suffixes \#2, \#3 deterministically
  ---
  duration_ms: 0.14375
  type: 'test'
  ...
# Subtest: stampFindingIdentity: every finding stamped non-empty (acceptance, spec §2)
ok 1951 - stampFindingIdentity: every finding stamped non-empty (acceptance, spec §2)
  ---
  duration_ms: 0.158541
  type: 'test'
  ...
# Subtest: opdCaseText includes the treating specialty line when provided (B4)
ok 1952 - opdCaseText includes the treating specialty line when provided (B4)
  ---
  duration_ms: 0.409083
  type: 'test'
  ...
# Subtest: followUpDocumented + completeness: UNKNOWN/blank excluded, real dispositions count (B2)
ok 1953 - followUpDocumented + completeness: UNKNOWN/blank excluded, real dispositions count (B2)
  ---
  duration_ms: 0.360375
  type: 'test'
  ...
# Subtest: completeness coverage excludes continuity fields — scored once (0.8)
ok 1954 - completeness coverage excludes continuity fields — scored once (0.8)
  ---
  duration_ms: 0.51925
  type: 'test'
  ...
# Subtest: opdCaseText marks a zero-medication note explicitly (B1)
ok 1955 - opdCaseText marks a zero-medication note explicitly (B1)
  ---
  duration_ms: 0.0805
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-04: HOSPITAL_* prescription types are IN-PERSON, not teleconsult
ok 1956 - v0.81 BUG-0.8-04: HOSPITAL_* prescription types are IN-PERSON, not teleconsult
  ---
  duration_ms: 0.042958
  type: 'test'
  ...
# Subtest: v0.81 FIX I: a documented hands-on exam downgrades a teleconsult classification
ok 1957 - v0.81 FIX I: a documented hands-on exam downgrades a teleconsult classification
  ---
  duration_ms: 0.110834
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-04: HOSPITAL_GP in-person note IS scored on examination
ok 1958 - v0.81 BUG-0.8-04: HOSPITAL_GP in-person note IS scored on examination
  ---
  duration_ms: 0.071042
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-05/07: stacked findings degrade gracefully, never a flat 0; single finding unchanged
ok 1959 - v0.81 BUG-0.8-05/07: stacked findings degrade gracefully, never a flat 0; single finding unchanged
  ---
  duration_ms: 1.276333
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-03: a formal referral counts as documented follow-up
ok 1960 - v0.81 BUG-0.8-03: a formal referral counts as documented follow-up
  ---
  duration_ms: 0.303792
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-01: injectable concentration is not a dose; oral strength still counts
ok 1961 - v0.81 BUG-0.8-01: injectable concentration is not a dose; oral strength still counts
  ---
  duration_ms: 0.1325
  type: 'test'
  ...
# Subtest: v0.81.1 P1: reasoning rubric judges by presentation, not sparseness
ok 1962 - v0.81.1 P1: reasoning rubric judges by presentation, not sparseness
  ---
  duration_ms: 0.361083
  type: 'test'
  ...
# Subtest: v0.81.1 P/O/F/N: prompt-hardening guards are present
ok 1963 - v0.81.1 P/O/F/N: prompt-hardening guards are present
  ---
  duration_ms: 0.061917
  type: 'test'
  ...
# Subtest: v0.81.1 O-render: an impression without an ICD code is not shown as "(none documented)"
ok 1964 - v0.81.1 O-render: an impression without an ICD code is not shown as "(none documented)"
  ---
  duration_ms: 0.11325
  type: 'test'
  ...
# Subtest: v0.81.1 D (BUG-0.8-02): a nested diagnosis is not dropped when dpipe captured only one
ok 1965 - v0.81.1 D (BUG-0.8-02): a nested diagnosis is not dropped when dpipe captured only one
  ---
  duration_ms: 0.09025
  type: 'test'
  ...
# Subtest: v0.81.1 K: in-person febrile note with no vitals gets a documentation gap; controls do not
ok 1966 - v0.81.1 K: in-person febrile note with no vitals gets a documentation gap; controls do not
  ---
  duration_ms: 0.376834
  type: 'test'
  ...
# Subtest: BUG-0.8-12: consolidateDecisions merges the deterministic NSAID interaction + LLM duplication
ok 1967 - BUG-0.8-12: consolidateDecisions merges the deterministic NSAID interaction + LLM duplication
  ---
  duration_ms: 1.116083
  type: 'test'
  ...
# Subtest: BUG-0.8-12: consolidateDecisions is a no-op when there is no deterministic NSAID interaction
ok 1968 - BUG-0.8-12: consolidateDecisions is a no-op when there is no deterministic NSAID interaction
  ---
  duration_ms: 0.140167
  type: 'test'
  ...
# Subtest: BUG-0.8-16: an "inaccurate drug class" finding is neutralised (non-scoring) not a clinician penalty
ok 1969 - BUG-0.8-16: an "inaccurate drug class" finding is neutralised (non-scoring) not a clinician penalty
  ---
  duration_ms: 1.372125
  type: 'test'
  ...
# Subtest: Q (0.8-10): an NSAID ingredient is detected inside a combination whose primary is a non-NSAID
ok 1970 - Q (0.8-10): an NSAID ingredient is detected inside a combination whose primary is a non-NSAID
  ---
  duration_ms: 0.36075
  type: 'test'
  ...
# Subtest: R (0.8-11): a muscle relaxant is detected + consolidateDecisions drops the LLM version when a deterministic one exists
ok 1971 - R (0.8-11): a muscle relaxant is detected + consolidateDecisions drops the LLM version when a deterministic one exists
  ---
  duration_ms: 0.134292
  type: 'test'
  ...
# Subtest: Part 1: an ICD/coding-completeness gap finding is neutralised to non-scoring
ok 1972 - Part 1: an ICD/coding-completeness gap finding is neutralised to non-scoring
  ---
  duration_ms: 0.226792
  type: 'test'
  ...
# Subtest: obstetric adapter (flag ON): populates canonical fields from the obstetric template + current-visit selection
ok 1973 - obstetric adapter (flag ON): populates canonical fields from the obstetric template + current-visit selection
  ---
  duration_ms: 0.710875
  type: 'test'
  ...
# Subtest: obstetric adapter (flag OFF): the obstetric note audits via the GP path, byte-identical (no isObstetric)
ok 1974 - obstetric adapter (flag OFF): the obstetric note audits via the GP path, byte-identical (no isObstetric)
  ---
  duration_ms: 0.111208
  type: 'test'
  ...
# Subtest: obstetric mandatory set: SFH/FHR/presentation required only in the 2nd/3rd trimester
ok 1975 - obstetric mandatory set: SFH/FHR/presentation required only in the 2nd/3rd trimester
  ---
  duration_ms: 0.281584
  type: 'test'
  ...
# Subtest: obstetric vitals: BP never mandatory (credited if present); weight is the required vital
ok 1976 - obstetric vitals: BP never mandatory (credited if present); weight is the required vital
  ---
  duration_ms: 0.115458
  type: 'test'
  ...
# Subtest: obstetric mandatory set: rich note near-complete; follow-up scored in Continuity not Documentation
ok 1977 - obstetric mandatory set: rich note near-complete; follow-up scored in Continuity not Documentation
  ---
  duration_ms: 0.073542
  type: 'test'
  ...
# Subtest: obstetricDosingComplete: a 1-0-1 schedule counts even with a blank frequency field
ok 1978 - obstetricDosingComplete: a 1-0-1 schedule counts even with a blank frequency field
  ---
  duration_ms: 0.056583
  type: 'test'
  ...
# Subtest: bpDocumented reads BP from the obstetric narrative (no structured BP column in db13, §9)
ok 1979 - bpDocumented reads BP from the obstetric narrative (no structured BP column in db13, §9)
  ---
  duration_ms: 0.05775
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 2: high-alert name-collision artifacts excluded at molecule level; real high-alerts + injectable MgSO4 still fire
ok 1980 - 0.81.14 Ruling 2: high-alert name-collision artifacts excluded at molecule level; real high-alerts + injectable MgSO4 still fire
  ---
  duration_ms: 0.310583
  type: 'test'
  ...
# Subtest: A-9: a non-obstetric note with an LMP gains NO mandatory LMP field; the obstetric path keeps it mandatory
ok 1981 - A-9: a non-obstetric note with an LMP gains NO mandatory LMP field; the obstetric path keeps it mandatory
  ---
  duration_ms: 0.12275
  type: 'test'
  ...
# Subtest: a complete, high-quality note scores in band A
ok 1982 - a complete, high-quality note scores in band A
  ---
  duration_ms: 0.717334
  type: 'test'
  ...
# Subtest: CANARY: three co-prescribed major interactions score prescribing safety 26/100, never 100
ok 1983 - CANARY: three co-prescribed major interactions score prescribing safety 26/100, never 100
  ---
  duration_ms: 0.188583
  type: 'test'
  ...
# Subtest: 0.81.10: an informational finding (the retired muscle-relaxant prompt) does NOT enter the score
ok 1984 - 0.81.10: an informational finding (the retired muscle-relaxant prompt) does NOT enter the score
  ---
  duration_ms: 0.093958
  type: 'test'
  ...
# Subtest: a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low
ok 1985 - a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low
  ---
  duration_ms: 0.114833
  type: 'test'
  ...
# Subtest: PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)
ok 1986 - PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)
  ---
  duration_ms: 0.123167
  type: 'test'
  ...
# Subtest: PDQI-9 partial ratings average only the provided attributes
ok 1987 - PDQI-9 partial ratings average only the provided attributes
  ---
  duration_ms: 0.067208
  type: 'test'
  ...
# Subtest: weights are sane
ok 1988 - weights are sane
  ---
  duration_ms: 0.108917
  type: 'test'
  ...
# Subtest: documentationAdequacyFlag fires only when fields (near-)complete AND thoroughness/synthesis low
ok 1989 - documentationAdequacyFlag fires only when fields (near-)complete AND thoroughness/synthesis low
  ---
  duration_ms: 0.068291
  type: 'test'
  ...
# Subtest: computeOpdScore surfaces the thin-documentation flag without changing scores
ok 1990 - computeOpdScore surfaces the thin-documentation flag without changing scores
  ---
  duration_ms: 0.203833
  type: 'test'
  ...
# Subtest: §4.1: concept_id "underuse:…" + source llm ⇒ direction underuse
ok 1991 - §4.1: concept_id "underuse:…" + source llm ⇒ direction underuse
  ---
  duration_ms: 1.869333
  type: 'test'
  ...
# Subtest: §4.1: an underuse finding contributes ZERO penalty
ok 1992 - §4.1: an underuse finding contributes ZERO penalty
  ---
  duration_ms: 0.912709
  type: 'test'
  ...
# Subtest: §4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible
ok 1993 - §4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible
  ---
  duration_ms: 0.083708
  type: 'test'
  ...
# Subtest: overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)
ok 1994 - overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)
  ---
  duration_ms: 0.139
  type: 'test'
  ...
# Subtest: §4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default
ok 1995 - §4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default
  ---
  duration_ms: 0.065459
  type: 'test'
  ...
# Subtest: §4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency
ok 1996 - §4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency
  ---
  duration_ms: 0.401208
  type: 'test'
  ...
# Subtest: the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only
ok 1997 - the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only
  ---
  duration_ms: 2.389666
  type: 'test'
  ...
# Subtest: the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update
ok 1998 - the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update
  ---
  duration_ms: 0.210583
  type: 'test'
  ...
# Subtest: candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw
ok 1999 - candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw
  ---
  duration_ms: 1.723834
  type: 'test'
  ...
# Subtest: candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed
ok 2000 - candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed
  ---
  duration_ms: 0.678875
  type: 'test'
  ...
# Subtest: candidate SQL tolerates migration 0029 not having run (displayed_band variant)
ok 2001 - candidate SQL tolerates migration 0029 not having run (displayed_band variant)
  ---
  duration_ms: 0.166958
  type: 'test'
  ...
# Subtest: ?limit= — default 800, clamped 1..3000, junk lands on the default
ok 2002 - ?limit= — default 800, clamped 1..3000, junk lands on the default
  ---
  duration_ms: 0.171
  type: 'test'
  ...
# Subtest: A-1 §1: resolveEngineFilter(null) returns the whole family
ok 2003 - A-1 §1: resolveEngineFilter(null) returns the whole family
  ---
  duration_ms: 0.944458
  type: 'test'
  ...
# Subtest: A-1 §2: an exact family member narrows to exactly that one version
ok 2004 - A-1 §2: an exact family member narrows to exactly that one version
  ---
  duration_ms: 0.143584
  type: 'test'
  ...
# Subtest: A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope
ok 2005 - A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope
  ---
  duration_ms: 0.11125
  type: 'test'
  ...
# Subtest: A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term
ok 2006 - A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term
  ---
  duration_ms: 0.089958
  type: 'test'
  ...
# Subtest: A-1 §5: the report's engine_versions reflects the FILTERED list, not the family
ok 2007 - A-1 §5: the report's engine_versions reflects the FILTERED list, not the family
  ---
  duration_ms: 0.104708
  type: 'test'
  ...
# Subtest: a candidate-query error degrades to an EMPTY report — never a 500
ok 2008 - a candidate-query error degrades to an EMPTY report — never a 500
  ---
  duration_ms: 0.416958
  type: 'test'
  ...
# Subtest: finalize() runs stampDirection on the reuse path — the moment that already works
ok 2009 - finalize() runs stampDirection on the reuse path — the moment that already works
  ---
  duration_ms: 0.230792
  type: 'test'
  ...
# Subtest: the route threads each row's OWN engine_version into auditOpdNote, so the UPDATE is in place
ok 2010 - the route threads each row's OWN engine_version into auditOpdNote, so the UPDATE is in place
  ---
  duration_ms: 0.106125
  type: 'test'
  ...
# Subtest: ?apply=1 is the ONLY write switch — read-only without it
ok 2011 - ?apply=1 is the ONLY write switch — read-only without it
  ---
  duration_ms: 0.1255
  type: 'test'
  ...
# Subtest: §2.7: no cron, no ?auto=1, no scheduler — cadence is V's decision, later
ok 2012 - §2.7: no cron, no ?auto=1, no scheduler — cadence is V's decision, later
  ---
  duration_ms: 0.239667
  type: 'test'
  ...
# Subtest: hysteresis is NOT this build's code — the band rides updateOpdAudit (D-4), the report only mirrors it
ok 2013 - hysteresis is NOT this build's code — the band rides updateOpdAudit (D-4), the report only mirrors it
  ---
  duration_ms: 0.097583
  type: 'test'
  ...
# Subtest: reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers
ok 2014 - reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers
  ---
  duration_ms: 0.20425
  type: 'test'
  ...
# Subtest: A-2 §1: one skipped + one error outcome count into apply_skipped 1 / apply_error 1
ok 2015 - A-2 §1: one skipped + one error outcome count into apply_skipped 1 / apply_error 1
  ---
  duration_ms: 0.133375
  type: 'test'
  ...
# Subtest: A-2 §2: first_apply_error is the FIRST non-empty error message, null when none occurred
ok 2016 - A-2 §2: first_apply_error is the FIRST non-empty error message, null when none occurred
  ---
  duration_ms: 0.239625
  type: 'test'
  ...
# Subtest: A-2 §3: an applyError longer than 300 characters is truncated to 300
ok 2017 - A-2 §3: an applyError longer than 300 characters is truncated to 300
  ---
  duration_ms: 0.110792
  type: 'test'
  ...
# Subtest: A-2 §4: missing_audit_uid counts apply-path outcomes whose auditUid is null or empty
ok 2018 - A-2 §4: missing_audit_uid counts apply-path outcomes whose auditUid is null or empty
  ---
  duration_ms: 0.1155
  type: 'test'
  ...
# Subtest: A-2: the route records updateOpdAudit's outcome and never console-logs the driver message
ok 2019 - A-2: the route records updateOpdAudit's outcome and never console-logs the driver message
  ---
  duration_ms: 0.114542
  type: 'test'
  ...
# Subtest: directionGained counts findings that GAINED a direction; underuseCount feeds the sample
ok 2020 - directionGained counts findings that GAINED a direction; underuseCount feeds the sample
  ---
  duration_ms: 0.196708
  type: 'test'
  ...
# Subtest: pdqi9 stored rows-array reconstructs to the computeOpdScore object form
ok 2021 - pdqi9 stored rows-array reconstructs to the computeOpdScore object form
  ---
  duration_ms: 0.191417
  type: 'test'
  ...
# Subtest: A-3 §1: hysteresisCaseSql('displayed_band','$3','$2::int') emits $2::int in every comparison, $3 as every result
ok 2022 - A-3 §1: hysteresisCaseSql('displayed_band','$3','$2::int') emits $2::int in every comparison, $3 as every result
  ---
  duration_ms: 0.381458
  type: 'test'
  ...
# Subtest: A-3 §2: the UPDATE statement deduces $2 from the SET clause and casts it in the CASE
ok 2023 - A-3 §2: the UPDATE statement deduces $2 from the SET clause and casts it in the CASE
  ---
  duration_ms: 0.109666
  type: 'test'
  ...
# Subtest: A-3 §3: saveOpdAudit's conflict clause still reads EXCLUDED.note_quality_index — the two call sites must never be "unified" back into this bug
ok 2024 - A-3 §3: saveOpdAudit's conflict clause still reads EXCLUDED.note_quality_index — the two call sites must never be "unified" back into this bug
  ---
  duration_ms: 0.078792
  type: 'test'
  ...
# Subtest: A-3 §4: the pure twin hysteresisBand is untouched — same thresholds, same g
ok 2025 - A-3 §4: the pure twin hysteresisBand is untouched — same thresholds, same g
  ---
  duration_ms: 0.14075
  type: 'test'
  ...
# Subtest: A-4 §1 (defect 1): the candidate comparison truncates the DB side to the watermark's precision
ok 2026 - A-4 §1 (defect 1): the candidate comparison truncates the DB side to the watermark's precision
  ---
  duration_ms: 0.09275
  type: 'test'
  ...
# Subtest: A-4 §2 (defect 2): an underuse finding carrying lvc_category on input emerges WITHOUT it — every other key survives
ok 2027 - A-4 §2 (defect 2): an underuse finding carrying lvc_category on input emerges WITHOUT it — every other key survives
  ---
  duration_ms: 0.411834
  type: 'test'
  ...
# Subtest: A-4 §3 (defect 2): a non-underuse finding is unchanged — it still receives stamped[i] with its lvc_category
ok 2028 - A-4 §3 (defect 2): a non-underuse finding is unchanged — it still receives stamped[i] with its lvc_category
  ---
  duration_ms: 0.327459
  type: 'test'
  ...
# Subtest: A-4 §4 (defect 2): underuse + signal_type low_value_care — specific type restored AND lvc_category dropped, both on one finding
ok 2029 - A-4 §4 (defect 2): underuse + signal_type low_value_care — specific type restored AND lvc_category dropped, both on one finding
  ---
  duration_ms: 1.491375
  type: 'test'
  ...
# Subtest: A-4 §5 (defect 3): the pass lock — lab_batch semantics, TTL pinned, held ⇒ empty report, never a 500
ok 2030 - A-4 §5 (defect 3): the pass lock — lab_batch semantics, TTL pinned, held ⇒ empty report, never a 500
  ---
  duration_ms: 1.672208
  type: 'test'
  ...
# Subtest: migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)
ok 2031 - migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)
  ---
  duration_ms: 0.257167
  type: 'test'
  ...
# Subtest: severityOf + importanceHint: known types weighted, unknown → med
ok 2032 - severityOf + importanceHint: known types weighted, unknown → med
  ---
  duration_ms: 0.516875
  type: 'test'
  ...
# Subtest: buildQueue groups by doctor→signal_type, counts, and drops informational
ok 2033 - buildQueue groups by doctor→signal_type, counts, and drops informational
  ---
  duration_ms: 1.399875
  type: 'test'
  ...
# Subtest: buildQueue ranks types by severity×frequency; noisiest marked; doctors by attention
ok 2034 - buildQueue ranks types by severity×frequency; noisiest marked; doctors by attention
  ---
  duration_ms: 0.178
  type: 'test'
  ...
# Subtest: buildQueue overlays the latest type decision; status filter hides triaged
ok 2035 - buildQueue overlays the latest type decision; status filter hides triaged
  ---
  duration_ms: 0.368584
  type: 'test'
  ...
# Subtest: buildQueue concentrated flag: doctor holding the whole window share of a type
ok 2036 - buildQueue concentrated flag: doctor holding the whole window share of a type
  ---
  duration_ms: 0.081625
  type: 'test'
  ...
# Subtest: validateDecision: valid batch route decision normalizes
ok 2037 - validateDecision: valid batch route decision normalizes
  ---
  duration_ms: 0.117334
  type: 'test'
  ...
# Subtest: validateDecision: audit_bug forces routed=false and requires bug_type
ok 2038 - validateDecision: audit_bug forces routed=false and requires bug_type
  ---
  duration_ms: 0.11025
  type: 'test'
  ...
# Subtest: validateDecision: valid_signal requires importance; routed requires response_required
ok 2039 - validateDecision: valid_signal requires importance; routed requires response_required
  ---
  duration_ms: 0.055833
  type: 'test'
  ...
# Subtest: validateDecision: instance scope requires audit_id + finding_ref; bad enums rejected
ok 2040 - validateDecision: instance scope requires audit_id + finding_ref; bad enums rejected
  ---
  duration_ms: 0.164958
  type: 'test'
  ...
# Subtest: classifyTransition: audit_bug & not-routed → dismiss; routed → resolution
ok 2041 - classifyTransition: audit_bug & not-routed → dismiss; routed → resolution
  ---
  duration_ms: 0.58225
  type: 'test'
  ...
# Subtest: requireChip: dismiss/resolution require an in-vocabulary chip
ok 2042 - requireChip: dismiss/resolution require an in-vocabulary chip
  ---
  duration_ms: 0.104083
  type: 'test'
  ...
# Subtest: buildTriageEvent: enforces chip, free text optional, telemetry columns normalized
ok 2043 - buildTriageEvent: enforces chip, free text optional, telemetry columns normalized
  ---
  duration_ms: 0.100875
  type: 'test'
  ...
# Subtest: buildQueue: representative carries complexity_band/inputs + lvc_category (passthrough)
ok 2044 - buildQueue: representative carries complexity_band/inputs + lvc_category (passthrough)
  ---
  duration_ms: 0.062708
  type: 'test'
  ...
# Subtest: buildQueue: missing complexity → representative fields null (no placeholder)
ok 2045 - buildQueue: missing complexity → representative fields null (no placeholder)
  ---
  duration_ms: 0.040416
  type: 'test'
  ...
# Subtest: maxTries: 1 makes exactly ONE attempt — no retry at all
ok 2046 - maxTries: 1 makes exactly ONE attempt — no retry at all
  ---
  duration_ms: 0.990542
  type: 'test'
  ...
# Subtest: maxTries: 2 makes exactly TWO attempts
ok 2047 - maxTries: 2 makes exactly TWO attempts
  ---
  duration_ms: 0.221042
  type: 'test'
  ...
# Subtest: a shortened ladder still SUCCEEDS on a later attempt within it
ok 2048 - a shortened ladder still SUCCEEDS on a later attempt within it
  ---
  duration_ms: 0.288125
  type: 'test'
  ...
# Subtest: the empty-200 class respects the shortened budget too
ok 2049 - the empty-200 class respects the shortened budget too
  ---
  duration_ms: 0.143584
  type: 'test'
  ...
# Subtest: the terminal timeout message reports the ladder ACTUALLY used, not the constant
ok 2050 - the terminal timeout message reports the ladder ACTUALLY used, not the constant
  ---
  duration_ms: 9.891625
  type: 'test'
  ...
# Subtest: maxTries absent ⇒ 3 attempts, unchanged from today
ok 2051 - maxTries absent ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.374042
  type: 'test'
  ...
# Subtest: maxTries zero ⇒ 3 attempts, unchanged from today
ok 2052 - maxTries zero ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.173125
  type: 'test'
  ...
# Subtest: maxTries negative ⇒ 3 attempts, unchanged from today
ok 2053 - maxTries negative ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.138083
  type: 'test'
  ...
# Subtest: maxTries NaN ⇒ 3 attempts, unchanged from today
ok 2054 - maxTries NaN ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.253833
  type: 'test'
  ...
# Subtest: maxTries Infinity ⇒ 3 attempts, unchanged from today
ok 2055 - maxTries Infinity ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.341417
  type: 'test'
  ...
# Subtest: maxTries a fraction below one ⇒ 3 attempts, unchanged from today
ok 2056 - maxTries a fraction below one ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.130708
  type: 'test'
  ...
# Subtest: maxTries a string ⇒ 3 attempts, unchanged from today
ok 2057 - maxTries a string ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.080541
  type: 'test'
  ...
# Subtest: a fractional maxTries above one TRUNCATES rather than rounding up
ok 2058 - a fractional maxTries above one TRUNCATES rather than rounding up
  ---
  duration_ms: 0.106959
  type: 'test'
  ...
# Subtest: OPENROUTER_MAX_TRIES still exports 3 and stays the default
ok 2059 - OPENROUTER_MAX_TRIES still exports 3 and stays the default
  ---
  duration_ms: 0.175208
  type: 'test'
  ...
# Subtest: the loop body reads the LOCAL maxTries, never the constant
ok 2060 - the loop body reads the LOCAL maxTries, never the constant
  ---
  duration_ms: 0.109708
  type: 'test'
  ...
# Subtest: chatWithFallback takes maxTries fifth and uses it only where a retry loop exists
ok 2061 - chatWithFallback takes maxTries fifth and uses it only where a retry loop exists
  ---
  duration_ms: 0.24725
  type: 'test'
  ...
# Subtest: governedChat threads maxTries down BOTH arms
ok 2062 - governedChat threads maxTries down BOTH arms
  ---
  duration_ms: 0.163917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the lab path and the production wrapper share ONE policy — identical bindings, not copies
ok 2063 - the lab path and the production wrapper share ONE policy — identical bindings, not copies
  ---
  duration_ms: 1.905125
  type: 'test'
  ...
# Subtest: policy values are unchanged by the move: 3 tries, 429/5xx retryable, 110s deadline, jittered backoff
ok 2064 - policy values are unchanged by the move: 3 tries, 429/5xx retryable, 110s deadline, jittered backoff
  ---
  duration_ms: 0.144417
  type: 'test'
  ...
# Subtest: a clean completion returns on attempt 1 — one call, no sleep, no failure report
ok 2065 - a clean completion returns on attempt 1 — one call, no sleep, no failure report
  ---
  duration_ms: 0.754417
  type: 'test'
  ...
# Subtest: every attempt carries OUR deadline and the SDK retries OFF — the budget must not multiply
ok 2066 - every attempt carries OUR deadline and the SDK retries OFF — the budget must not multiply
  ---
  duration_ms: 0.282667
  type: 'test'
  ...
# Subtest: a transport error (no HTTP status) is retryable; success on attempt 2 returns normally
ok 2067 - a transport error (no HTTP status) is retryable; success on attempt 2 returns normally
  ---
  duration_ms: 0.336209
  type: 'test'
  ...
# Subtest: 429/5xx retry on the bounded budget; the FINAL attempt rethrows the provider error
ok 2068 - 429/5xx retry on the bounded budget; the FINAL attempt rethrows the provider error
  ---
  duration_ms: 1.299834
  type: 'test'
  ...
# Subtest: a non-transient status (4xx) throws IMMEDIATELY — the call site fallback path is unchanged for it
ok 2069 - a non-transient status (4xx) throws IMMEDIATELY — the call site fallback path is unchanged for it
  ---
  duration_ms: 0.276792
  type: 'test'
  ...
# Subtest: an EMPTY 200 is a retryable failure, not a terminal one — d6efe39 made it visible, this makes it survivable
ok 2070 - an EMPTY 200 is a retryable failure, not a terminal one — d6efe39 made it visible, this makes it survivable
  ---
  duration_ms: 0.358875
  type: 'test'
  ...
# Subtest: an empty 200 on the FINAL attempt throws the MARKED error so call sites refuse the Ollama fallback (§2.3)
ok 2071 - an empty 200 on the FINAL attempt throws the MARKED error so call sites refuse the Ollama fallback (§2.3)
  ---
  duration_ms: 0.581166
  type: 'test'
  ...
# Subtest: an abort error is retryable — an abort that was not retryable would make the deadline strictly worse than no deadline
ok 2072 - an abort error is retryable — an abort that was not retryable would make the deadline strictly worse than no deadline
  ---
  duration_ms: 0.409875
  type: 'test'
  ...
# Subtest: the onAttemptFailure hook can never be the thing that fails the call
ok 2073 - the onAttemptFailure hook can never be the thing that fails the call
  ---
  duration_ms: 0.1205
  type: 'test'
  ...
# Subtest: streams are the CALLER's exclusion, not the wrapper's — the governed call sites keep the bare create() for stream:true
ok 2074 - streams are the CALLER's exclusion, not the wrapper's — the governed call sites keep the bare create() for stream:true
  ---
  duration_ms: 0.473334
  type: 'test'
  ...
# Subtest: NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before
ok 2075 - NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before
  ---
  duration_ms: 0.7585
  type: 'test'
  ...
# Subtest: timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000
ok 2076 - timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000
  ---
  duration_ms: 0.115833
  type: 'test'
  ...
# Subtest: timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt
ok 2077 - timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt
  ---
  duration_ms: 0.868083
  type: 'test'
  ...
# Subtest: a junk timeoutMs degrades to the default — a deadline may never be switched off
ok 2078 - a junk timeoutMs degrades to the default — a deadline may never be switched off
  ---
  duration_ms: 0.184042
  type: 'test'
  ...
# Subtest: the terminal error message reports the APPLIED timeout, not the constant
ok 2079 - the terminal error message reports the APPLIED timeout, not the constant
  ---
  duration_ms: 26.216875
  type: 'test'
  ...
# Subtest: OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000
ok 2080 - OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000
  ---
  duration_ms: 0.518375
  type: 'test'
  ...
# Subtest: retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not
ok 2081 - retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not
  ---
  duration_ms: 0.201292
  type: 'test'
  ...
# Subtest: a 4xx throws immediately — one attempt, no retry
ok 2082 - a 4xx throws immediately — one attempt, no retry
  ---
  duration_ms: 0.668458
  type: 'test'
  ...
# Subtest: a 429 retries the full budget
ok 2083 - a 429 retries the full budget
  ---
  duration_ms: 0.768167
  type: 'test'
  ...
# Subtest: an ABORT retries — a deadline that ended the call must not end the budget
ok 2084 - an ABORT retries — a deadline that ended the call must not end the budget
  ---
  duration_ms: 17.568416
  type: 'test'
  ...
# Subtest: the backoff curve is untouched
ok 2085 - the backoff curve is untouched
  ---
  duration_ms: 0.252542
  type: 'test'
  ...
# Subtest: EVERY openrouterCreateWithRetry call site forwards the caller timeout AND maxTries
ok 2086 - EVERY openrouterCreateWithRetry call site forwards the caller timeout AND maxTries
  ---
  duration_ms: 0.747792
  type: 'test'
  ...
# Subtest: there are exactly FOUR provider call sites — a fifth must be enumerated
ok 2087 - there are exactly FOUR provider call sites — a fifth must be enumerated
  ---
  duration_ms: 3.392167
  type: 'test'
  ...
# Subtest: chatWithFallback's OpenRouter branch passes the caller's timeout through
ok 2088 - chatWithFallback's OpenRouter branch passes the caller's timeout through
  ---
  duration_ms: 0.30875
  type: 'test'
  ...
# Subtest: tracedChat's OpenRouter branch — THE PRODUCTION PATH — passes both through
ok 2089 - tracedChat's OpenRouter branch — THE PRODUCTION PATH — passes both through
  ---
  duration_ms: 0.141334
  type: 'test'
  ...
# Subtest: the IPD worker box is 800 s, matching the OPD worker
ok 2090 - the IPD worker box is 800 s, matching the OPD worker
  ---
  duration_ms: 0.142916
  type: 'test'
  ...
# Subtest: this build did not disturb the OPD cron window
ok 2091 - this build did not disturb the OPD cron window
  ---
  duration_ms: 0.078459
  type: 'test'
  ...
# Subtest: §2.1 — the DDL re-applies BOTH failure-table constraints, in one keyed statement
ok 2092 - §2.1 — the DDL re-applies BOTH failure-table constraints, in one keyed statement
  ---
  duration_ms: 0.693459
  type: 'test'
  ...
# Subtest: §2.1 — the re-applied CHECKs carry the widened phase list
ok 2093 - §2.1 — the re-applied CHECKs carry the widened phase list
  ---
  duration_ms: 0.14375
  type: 'test'
  ...
# Subtest: §2.1 — the statement is idempotent: DROP tolerates absence, ADD names a now-free constraint
ok 2094 - §2.1 — the statement is idempotent: DROP tolerates absence, ADD names a now-free constraint
  ---
  duration_ms: 0.122209
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §2.1 — a FRESH table run issues create, then the one ALTER, in order
ok 2095 - §2.1 — a FRESH table run issues create, then the one ALTER, in order
  ---
  duration_ms: 49.169209
  type: 'test'
  ...
# Subtest: §2.1 — a PRE-EXISTING table carrying the OLD constraints still ends with the widened form
ok 2096 - §2.1 — a PRE-EXISTING table carrying the OLD constraints still ends with the widened form
  ---
  duration_ms: 3.711584
  type: 'test'
  ...
# Subtest: §2.1 — migrations/0035 is in parity with the re-applied constraints
ok 2097 - §2.1 — migrations/0035 is in parity with the re-applied constraints
  ---
  duration_ms: 0.337791
  type: 'test'
  ...
# Subtest: §2.2 — the version is 3, and a payload built today claims 3
ok 2098 - §2.2 — the version is 3, and a payload built today claims 3
  ---
  duration_ms: 0.589084
  type: 'test'
  ...
# Subtest: §2.2 — a VERSION-2 manifest is unrecognized, which is the point of the bump
ok 2099 - §2.2 — a VERSION-2 manifest is unrecognized, which is the point of the bump
  ---
  duration_ms: 0.328958
  type: 'test'
  ...
# Subtest: §2.2 — ABSENT and explicit NULL stay distinguishable, which is why `has` is used
ok 2100 - §2.2 — ABSENT and explicit NULL stay distinguishable, which is why `has` is used
  ---
  duration_ms: 0.285625
  type: 'test'
  ...
# Subtest: §2.2 — both fields are TYPE-checked, not merely present
ok 2101 - §2.2 — both fields are TYPE-checked, not merely present
  ---
  duration_ms: 1.477833
  type: 'test'
  ...
# Subtest: §2.2 — the duplicated seed vocabulary cannot drift
ok 2102 - §2.2 — the duplicated seed vocabulary cannot drift
  ---
  duration_ms: 0.210959
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — the JUDGE arm no longer claims an unproven not_served
ok 2103 - §2.3 — the JUDGE arm no longer claims an unproven not_served
  ---
  duration_ms: 98.582
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — the COHERE arm is unchanged from pass 0
ok 2104 - §2.3 — the COHERE arm is unchanged from pass 0
  ---
  duration_ms: 3.748708
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — THE REGRESSION GUARD: no synthesised boundary on EITHER arm may assert proof
ok 2105 - §2.3 — THE REGRESSION GUARD: no synthesised boundary on EITHER arm may assert proof
  ---
  duration_ms: 8.94075
  type: 'test'
  ...
# Subtest: §2.3 — where transport proof EXISTS, the served class still stands
ok 2106 - §2.3 — where transport proof EXISTS, the served class still stands
  ---
  duration_ms: 0.083208
  type: 'test'
  ...
# Subtest: parseSkeleton forces DDx hand-off on a low-certainty / anchored diagnosis
ok 2107 - parseSkeleton forces DDx hand-off on a low-certainty / anchored diagnosis
  ---
  duration_ms: 0.884084
  type: 'test'
  ...
# Subtest: normStageKind maps synonyms + defaults to assessment
ok 2108 - normStageKind maps synonyms + defaults to assessment
  ---
  duration_ms: 0.527583
  type: 'test'
  ...
# Subtest: normStageFlag maps synonyms + defaults to routine
ok 2109 - normStageFlag maps synonyms + defaults to routine
  ---
  duration_ms: 0.7605
  type: 'test'
  ...
# Subtest: orderAndIdStages enforces canonical order, stable within kind, sequential ids
ok 2110 - orderAndIdStages enforces canonical order, stable within kind, sequential ids
  ---
  duration_ms: 0.399333
  type: 'test'
  ...
# Subtest: orderAndIdStages caps the spine
ok 2111 - orderAndIdStages caps the spine
  ---
  duration_ms: 0.079375
  type: 'test'
  ...
# Subtest: STAGE_ORDER is strictly increasing along the canonical path
ok 2112 - STAGE_ORDER is strictly increasing along the canonical path
  ---
  duration_ms: 0.04825
  type: 'test'
  ...
# Subtest: parseSkeleton parses a fenced JSON skeleton
ok 2113 - parseSkeleton parses a fenced JSON skeleton
  ---
  duration_ms: 0.17325
  type: 'test'
  ...
# Subtest: parseSkeleton forces needsDdx for undifferentiated low-certainty presentation
ok 2114 - parseSkeleton forces needsDdx for undifferentiated low-certainty presentation
  ---
  duration_ms: 0.055583
  type: 'test'
  ...
# Subtest: parseSkeleton returns null on garbage / empty stages
ok 2115 - parseSkeleton returns null on garbage / empty stages
  ---
  duration_ms: 0.184166
  type: 'test'
  ...
# Subtest: parseEnrichment parses, filters unknown ids, dedups, separates evidence/estimates
ok 2116 - parseEnrichment parses, filters unknown ids, dedups, separates evidence/estimates
  ---
  duration_ms: 0.453917
  type: 'test'
  ...
# Subtest: parseEnrichment returns null on garbage
ok 2117 - parseEnrichment returns null on garbage
  ---
  duration_ms: 0.050917
  type: 'test'
  ...
# Subtest: mergeStages overlays enrichment by id and marks enriched
ok 2118 - mergeStages overlays enrichment by id and marks enriched
  ---
  duration_ms: 0.09875
  type: 'test'
  ...
# Subtest: §2.7.1 fact vs inference survives: provenance/extractionMethod/confidence pass through verbatim
ok 2119 - §2.7.1 fact vs inference survives: provenance/extractionMethod/confidence pass through verbatim
  ---
  duration_ms: 0.850209
  type: 'test'
  ...
# Subtest: §2.7.2 negatives ≠ unknowns, and assessedInputs ≠ missingInputs — never merged, never dropped when empty
ok 2120 - §2.7.2 negatives ≠ unknowns, and assessedInputs ≠ missingInputs — never merged, never dropped when empty
  ---
  duration_ms: 0.792834
  type: 'test'
  ...
# Subtest: §2.7.3 conflicts surface and are NEVER resolved, filtered or collapsed — including safety_critical
ok 2121 - §2.7.3 conflicts surface and are NEVER resolved, filtered or collapsed — including safety_critical
  ---
  duration_ms: 0.148208
  type: 'test'
  ...
# Subtest: §2.7.4 as_of comes from the snapshot's own field — never recomputed, only re-FORMATTED
ok 2122 - §2.7.4 as_of comes from the snapshot's own field — never recomputed, only re-FORMATTED
  ---
  duration_ms: 0.083666
  type: 'test'
  ...
# Subtest: §2.4 the LAST served observation wins, and a clean frontier run is not degraded
ok 2123 - §2.4 the LAST served observation wins, and a clean frontier run is not degraded
  ---
  duration_ms: 0.108834
  type: 'test'
  ...
# Subtest: §2.4 THE T-5 SCENARIO: a fallback leg ⇒ degraded, whatever the intent said
ok 2124 - §2.4 THE T-5 SCENARIO: a fallback leg ⇒ degraded, whatever the intent said
  ---
  duration_ms: 0.083875
  type: 'test'
  ...
# Subtest: §2.4 "we do not know" is DEGRADED — never the happy path
ok 2125 - §2.4 "we do not know" is DEGRADED — never the happy path
  ---
  duration_ms: 0.09625
  type: 'test'
  ...
# Subtest: §2.4 a partial assembly (a state leg failed) is degraded even when the model was clean
ok 2126 - §2.4 a partial assembly (a state leg failed) is degraded even when the model was clean
  ---
  duration_ms: 0.048917
  type: 'test'
  ...
# Subtest: §2.4 the wired reader takes provider/model from llm_response — NEVER llm_request (that is intent)
ok 2127 - §2.4 the wired reader takes provider/model from llm_response — NEVER llm_request (that is intent)
  ---
  duration_ms: 0.198625
  type: 'test'
  ...
# Subtest: §2.5 commercial is a SIBLING of clinical, never nested inside it, and carries its own definition
ok 2128 - §2.5 commercial is a SIBLING of clinical, never nested inside it, and carries its own definition
  ---
  duration_ms: 0.319875
  type: 'test'
  ...
# Subtest: §2.5 the commercial layer SHIPS — it is not omitted
ok 2129 - §2.5 the commercial layer SHIPS — it is not omitted
  ---
  duration_ms: 0.0575
  type: 'test'
  ...
# Subtest: §2.6 the disclaimer is rewritten for a physician pre-encounter and EMITTED in the JSON
ok 2130 - §2.6 the disclaimer is rewritten for a physician pre-encounter and EMITTED in the JSON
  ---
  duration_ms: 0.062417
  type: 'test'
  ...
# Subtest: §2.3 every namespace is present and the envelope carries its required fields
ok 2131 - §2.3 every namespace is present and the envelope carries its required fields
  ---
  duration_ms: 1.54475
  type: 'test'
  ...
# Subtest: §2.3 actions.follow_ups carries the snapshot's own followUps — never re-derived
ok 2132 - §2.3 actions.follow_ups carries the snapshot's own followUps — never re-derived
  ---
  duration_ms: 0.233542
  type: 'test'
  ...
# Subtest: §2.1 POST answers 202 with a job id and a poll url; the poll route returns 202/200/404
ok 2133 - §2.1 POST answers 202 with a job id and a poll url; the poll route returns 202/200/404
  ---
  duration_ms: 0.124167
  type: 'test'
  ...
# Subtest: §2.1 the 202 shape is documented as load-bearing — V2 precompute must not change the contract
ok 2134 - §2.1 the 202 shape is documented as load-bearing — V2 precompute must not change the contract
  ---
  duration_ms: 0.205834
  type: 'test'
  ...
# Subtest: §2.2 auth reuses CRON_SECRET and RECORDS that it is pilot-scoped and must be split
ok 2135 - §2.2 auth reuses CRON_SECRET and RECORDS that it is pilot-scoped and must be split
  ---
  duration_ms: 0.1195
  type: 'test'
  ...
# Subtest: the poll route tells Pulse it is REQUIRED to render a degraded package differently
ok 2136 - the poll route tells Pulse it is REQUIRED to render a degraded package differently
  ---
  duration_ms: 0.044292
  type: 'test'
  ...
# Subtest: job ids are well-formed and validated
ok 2137 - job ids are well-formed and validated
  ---
  duration_ms: 0.178417
  type: 'test'
  ...
# Subtest: §1.1 the CCB card and its live PHI count query are gone; OPD Audit Triage is untouched
ok 2138 - §1.1 the CCB card and its live PHI count query are gone; OPD Audit Triage is untouched
  ---
  duration_ms: 0.062291
  type: 'test'
  ...
# Subtest: §1.1 /care/briefs stays REACHABLE — no gate was added (V overruled 404-ing it)
ok 2139 - §1.1 /care/briefs stays REACHABLE — no gate was added (V overruled 404-ing it)
  ---
  duration_ms: 0.166542
  type: 'test'
  ...
# Subtest: §1.3 every preserved-mechanics file carries the RETIRED header WITH the CCB_ENABLED hazard
ok 2140 - §1.3 every preserved-mechanics file carries the RETIRED header WITH the CCB_ENABLED hazard
  ---
  duration_ms: 1.041334
  type: 'test'
  ...
# Subtest: §2.3 the ExtractedReport[] sink is ADDITIVE — the envelope and every existing caller are untouched
ok 2141 - §2.3 the ExtractedReport[] sink is ADDITIVE — the envelope and every existing caller are untouched
  ---
  duration_ms: 0.10475
  type: 'test'
  ...
# Subtest: ungrounded: citation_coverage_pct === 0 flips envelope.ungrounded — a zero-grounded package must not pass as well-grounded
ok 2142 - ungrounded: citation_coverage_pct === 0 flips envelope.ungrounded — a zero-grounded package must not pass as well-grounded
  ---
  duration_ms: 0.06175
  type: 'test'
  ...
# Subtest: state_llm: rejected[] is surfaced in the envelope — the hallucination meter is not discarded
ok 2143 - state_llm: rejected[] is surfaced in the envelope — the hallucination meter is not discarded
  ---
  duration_ms: 0.064833
  type: 'test'
  ...
# Subtest: state_conflicts: a concept in BOTH positives and negatives is surfaced, normalised, never resolved
ok 2144 - state_conflicts: a concept in BOTH positives and negatives is surfaced, normalised, never resolved
  ---
  duration_ms: 0.155958
  type: 'test'
  ...
# Subtest: a flag-on stage-2 failure is DEGRADED — the state shipped thinner than the default contract
ok 2145 - a flag-on stage-2 failure is DEGRADED — the state shipped thinner than the default contract
  ---
  duration_ms: 0.045042
  type: 'test'
  ...
# Subtest: the wired stage 2 is flag-gated DEFAULT ON, governed, and rides the brief trace
ok 2146 - the wired stage 2 is flag-gated DEFAULT ON, governed, and rides the brief trace
  ---
  duration_ms: 0.048042
  type: 'test'
  ...
# Subtest: stage 2 caps its thinking — the Vertex form, gated on a resolved Gemini model, never zero
ok 2147 - stage 2 caps its thinking — the Vertex form, gated on a resolved Gemini model, never zero
  ---
  duration_ms: 0.471
  type: 'test'
  ...
# Subtest: the audit budget is NOT changed by the stage-2 cap — separate constants, separate files
ok 2148 - the audit budget is NOT changed by the stage-2 cap — separate constants, separate files
  ---
  duration_ms: 0.273709
  type: 'test'
  ...
# Subtest: T-13 §5.1: the captured failure now reports degraded, naming the dead leg
ok 2149 - T-13 §5.1: the captured failure now reports degraded, naming the dead leg
  ---
  duration_ms: 0.064
  type: 'test'
  ...
# Subtest: T-13 §5.2: a HEALTHY package still reports degraded:false — the check must not mark everything
ok 2150 - T-13 §5.2: a HEALTHY package still reports degraded:false — the check must not mark everything
  ---
  duration_ms: 0.036791
  type: 'test'
  ...
# Subtest: T-13 §5.4: each check fires ALONE, with the other disabled
ok 2151 - T-13 §5.4: each check fires ALONE, with the other disabled
  ---
  duration_ms: 0.128084
  type: 'test'
  ...
# Subtest: T-13: the content check needs BOTH conditions — a grounded package with 0 findings, or an ungrounded one with findings, is not "empty"
ok 2152 - T-13: the content check needs BOTH conditions — a grounded package with 0 findings, or an ungrounded one with findings, is not "empty"
  ---
  duration_ms: 0.046833
  type: 'test'
  ...
# Subtest: T-13: failed legs are deduped and named in sorted order, and junk never crashes the reason
ok 2153 - T-13: failed legs are deduped and named in sorted order, and junk never crashes the reason
  ---
  duration_ms: 0.04925
  type: 'test'
  ...
# Subtest: T-13: the reasons compose — every independent cause is stated, none replaces another
ok 2154 - T-13: the reasons compose — every independent cause is stated, none replaces another
  ---
  duration_ms: 0.048125
  type: 'test'
  ...
# Subtest: T-13 §4: as_of is normalised to full ISO 8601 — a bare date keeps its calendar day
ok 2155 - T-13 §4: as_of is normalised to full ISO 8601 — a bare date keeps its calendar day
  ---
  duration_ms: 2.306041
  type: 'test'
  ...
# Subtest: T-13 §4: the snapshot itself is NOT recomputed — only the envelope is formatted
ok 2156 - T-13 §4: the snapshot itself is NOT recomputed — only the envelope is formatted
  ---
  duration_ms: 1.424458
  type: 'test'
  ...
# Subtest: T-13 §2: the envelope reads the failure signal that already existed on the trace
ok 2157 - T-13 §2: the envelope reads the failure signal that already existed on the trace
  ---
  duration_ms: 0.152541
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: THE DEFECT: a 200 with empty content THROWS instead of returning an empty string
ok 2158 - THE DEFECT: a 200 with empty content THROWS instead of returning an empty string
  ---
  duration_ms: 25.542542
  type: 'test'
  ...
# Subtest: empty content is RETRYABLE on the EXISTING budget — only the final attempt throws
ok 2159 - empty content is RETRYABLE on the EXISTING budget — only the final attempt throws
  ---
  duration_ms: 0.51575
  type: 'test'
  ...
# Subtest: the try budget is NOT raised — still exactly 3
ok 2160 - the try budget is NOT raised — still exactly 3
  ---
  duration_ms: 0.052292
  type: 'test'
  ...
# Subtest: persistent empty content exhausts the budget and throws — no silent fallback
ok 2161 - persistent empty content exhausts the budget and throws — no silent fallback
  ---
  duration_ms: 0.287
  type: 'test'
  ...
# Subtest: a NON-empty response still returns normally — the happy path is untouched
ok 2162 - a NON-empty response still returns normally — the happy path is untouched
  ---
  duration_ms: 0.195333
  type: 'test'
  ...
# Subtest: THE ERROR MESSAGE is verbatim per PRD §4 and carries the whole envelope
ok 2163 - THE ERROR MESSAGE is verbatim per PRD §4 and carries the whole envelope
  ---
  duration_ms: 0.061125
  type: 'test'
  ...
# Subtest: the message renders missing envelope fields as null rather than undefined or blank
ok 2164 - the message renders missing envelope fields as null rather than undefined or blank
  ---
  duration_ms: 0.053083
  type: 'test'
  ...
# Subtest: the thrown message actually reaches the caller with the envelope in it
ok 2165 - the thrown message actually reaches the caller with the envelope in it
  ---
  duration_ms: 0.418042
  type: 'test'
  ...
# Subtest: onEnvelope fires on EVERY attempt — success, empty content and HTTP failure alike
ok 2166 - onEnvelope fires on EVERY attempt — success, empty content and HTTP failure alike
  ---
  duration_ms: 0.774875
  type: 'test'
  ...
# Subtest: ENVELOPE CAPTURE NEVER THROWS — a broken callback cannot cost a real result
ok 2167 - ENVELOPE CAPTURE NEVER THROWS — a broken callback cannot cost a real result
  ---
  duration_ms: 0.689667
  type: 'test'
  ...
# Subtest: readLlmEnvelope is total — any shape yields a defined envelope, never a throw
ok 2168 - readLlmEnvelope is total — any shape yields a defined envelope, never a throw
  ---
  duration_ms: 0.16325
  type: 'test'
  ...
# Subtest: OPENROUTER_TIMEOUT_MS defaults to 110s and is env-overridable
ok 2169 - OPENROUTER_TIMEOUT_MS defaults to 110s and is env-overridable
  ---
  duration_ms: 0.130541
  type: 'test'
  ...
# Subtest: an AbortSignal is passed to the fetch, and the timer is always cleared
ok 2170 - an AbortSignal is passed to the fetch, and the timer is always cleared
  ---
  duration_ms: 0.14225
  type: 'test'
  ...
# Subtest: a timeout is a NORMAL RETRYABLE failure on the same bounded budget
ok 2171 - a timeout is a NORMAL RETRYABLE failure on the same bounded budget
  ---
  duration_ms: 0.179167
  type: 'test'
  ...
# Subtest: a persistent transport failure exhausts the budget and throws a named error
ok 2172 - a persistent transport failure exhausts the budget and throws a named error
  ---
  duration_ms: 0.206875
  type: 'test'
  ...
# Subtest: the transport catch still emits an envelope, so a hung attempt is visible
ok 2173 - the transport catch still emits an envelope, so a hung attempt is visible
  ---
  duration_ms: 0.199041
  type: 'test'
  ...
# Subtest: THE CATCH BLOCK rethrows ONLY for eval; the non-eval return is byte-identical
ok 2174 - THE CATCH BLOCK rethrows ONLY for eval; the non-eval return is byte-identical
  ---
  duration_ms: 0.082542
  type: 'test'
  ...
# Subtest: the production defaultGenerate params are byte-identical — no eval change leaked in
ok 2175 - the production defaultGenerate params are byte-identical — no eval change leaked in
  ---
  duration_ms: 0.115583
  type: 'test'
  ...
# Subtest: buildOpenRouterBody is BYTE-IDENTICAL — no max_tokens, no response_format (D3)
ok 2176 - buildOpenRouterBody is BYTE-IDENTICAL — no max_tokens, no response_format (D3)
  ---
  duration_ms: 0.213167
  type: 'test'
  ...
# Subtest: no engine version bump, and the retry predicate is unchanged
ok 2177 - no engine version bump, and the retry predicate is unchanged
  ---
  duration_ms: 0.245792
  type: 'test'
  ...
# Subtest: runMiniOpdToLab writes the envelope on success and cannot write one on failure
ok 2178 - runMiniOpdToLab writes the envelope on success and cannot write one on failure
  ---
  duration_ms: 0.1785
  type: 'test'
  ...
# Subtest: the lab-batch core is untouched — drainPlan and the locks still stand
ok 2179 - the lab-batch core is untouched — drainPlan and the locks still stand
  ---
  duration_ms: 0.091417
  type: 'test'
  ...
# Subtest: parses a full draft: caps, ranking, counts, version, disclaimer
ok 2180 - parses a full draft: caps, ranking, counts, version, disclaimer
  ---
  duration_ms: 0.838041
  type: 'test'
  ...
# Subtest: citation ids bounded by the SHARED source count
ok 2181 - citation ids bounded by the SHARED source count
  ---
  duration_ms: 0.616084
  type: 'test'
  ...
# Subtest: unknown enums fall to safe defaults
ok 2182 - unknown enums fall to safe defaults
  ---
  duration_ms: 0.08425
  type: 'test'
  ...
# Subtest: caps: complications 8, safety-net 10
ok 2183 - caps: complications 8, safety-net 10
  ---
  duration_ms: 0.155916
  type: 'test'
  ...
# Subtest: malformed / empty inputs return null
ok 2184 - malformed / empty inputs return null
  ---
  duration_ms: 0.102542
  type: 'test'
  ...
# Subtest: summary fallback built when model omits it
ok 2185 - summary fallback built when model omits it
  ---
  duration_ms: 0.466625
  type: 'test'
  ...
# Subtest: buildPxUser: lens per doc type + documented plan block + empty-plan fallback
ok 2186 - buildPxUser: lens per doc type + documented plan block + empty-plan fallback
  ---
  duration_ms: 1.622875
  type: 'test'
  ...
# Subtest: parsePxCritique reads PX-specific keys; needs_revision inferred from non-empty arrays
ok 2187 - parsePxCritique reads PX-specific keys; needs_revision inferred from non-empty arrays
  ---
  duration_ms: 0.320667
  type: 'test'
  ...
# Subtest: R5: offsetPrognosisCitations shifts every citation id by the analyze-source count
ok 2188 - R5: offsetPrognosisCitations shifts every citation id by the analyze-source count
  ---
  duration_ms: 0.993583
  type: 'test'
  ...
# Subtest: modifiers parsed with direction defaulting to raises; capped at 6
ok 2189 - modifiers parsed with direction defaulting to raises; capped at 6
  ---
  duration_ms: 0.355
  type: 'test'
  ...
# Subtest: §7.1 hash stability: spacing and casing variants produce the SAME hash
ok 2190 - §7.1 hash stability: spacing and casing variants produce the SAME hash
  ---
  duration_ms: 5.677333
  type: 'test'
  ...
# Subtest: the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned
ok 2191 - the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned
  ---
  duration_ms: 0.2255
  type: 'test'
  ...
# Subtest: ADDENDUM A §1.2 — the ten cross-engine vectors, pinned with their literal hashes
ok 2192 - ADDENDUM A §1.2 — the ten cross-engine vectors, pinned with their literal hashes
  ---
  duration_ms: 0.807375
  type: 'test'
  ...
# Subtest: normalization is trim + lower-case + collapse internal whitespace, nothing more
ok 2193 - normalization is trim + lower-case + collapse internal whitespace, nothing more
  ---
  duration_ms: 0.168167
  type: 'test'
  ...
# Subtest: §7.2 re-audit resilience: the array reorders, the hash still finds the right complication
ok 2194 - §7.2 re-audit resilience: the array reorders, the hash still finds the right complication
  ---
  duration_ms: 0.839458
  type: 'test'
  ...
# Subtest: §7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived
ok 2195 - §7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived
  ---
  duration_ms: 0.140917
  type: 'test'
  ...
# Subtest: §7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index
ok 2196 - §7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index
  ---
  duration_ms: 0.373416
  type: 'test'
  ...
# Subtest: a NULL hash reads as unpredicted, and junk shapes never throw
ok 2197 - a NULL hash reads as unpredicted, and junk shapes never throw
  ---
  duration_ms: 0.252875
  type: 'test'
  ...
# Subtest: §7.5 each classification is produced by the correct form state
ok 2198 - §7.5 each classification is produced by the correct form state
  ---
  duration_ms: 1.281292
  type: 'test'
  ...
# Subtest: §7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held
ok 2199 - §7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held
  ---
  duration_ms: 0.711125
  type: 'test'
  ...
# Subtest: the vocabularies are exactly the PRD’s
ok 2200 - the vocabularies are exactly the PRD’s
  ---
  duration_ms: 0.268583
  type: 'test'
  ...
# Subtest: §7.4 currentRows: the default view shows only non-superseded rows; history shows all
ok 2201 - §7.4 currentRows: the default view shows only non-superseded rows; history shows all
  ---
  duration_ms: 0.205416
  type: 'test'
  ...
# Subtest: §7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator
ok 2202 - §7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator
  ---
  duration_ms: 0.114375
  type: 'test'
  ...
# Subtest: §7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator
ok 2203 - §7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator
  ---
  duration_ms: 0.096334
  type: 'test'
  ...
# Subtest: §7.6 a no_adverse_outcome row admits the document; a superseded one does not
ok 2204 - §7.6 a no_adverse_outcome row admits the document; a superseded one does not
  ---
  duration_ms: 0.09025
  type: 'test'
  ...
# Subtest: §7.6 no_adverse alongside an event row: followed up, in the denominator, both persist
ok 2205 - §7.6 no_adverse alongside an event row: followed up, in the denominator, both persist
  ---
  duration_ms: 0.094542
  type: 'test'
  ...
# Subtest: §7.7 idempotent migration: every statement is IF NOT EXISTS — running it twice is a no-op
ok 2206 - §7.7 idempotent migration: every statement is IF NOT EXISTS — running it twice is a no-op
  ---
  duration_ms: 0.444417
  type: 'test'
  ...
# Subtest: P-7 in the store: supersede is ONE atomic statement — flag-flip CTE + insert, no content UPDATE, no DELETE
ok 2207 - P-7 in the store: supersede is ONE atomic statement — flag-flip CTE + insert, no content UPDATE, no DELETE
  ---
  duration_ms: 0.284709
  type: 'test'
  ...
# Subtest: §7.6 the view emits the not_followed_up bucket, and the over-warning columns go NULL outside it
ok 2208 - §7.6 the view emits the not_followed_up bucket, and the over-warning columns go NULL outside it
  ---
  duration_ms: 0.105667
  type: 'test'
  ...
# Subtest: the view reads only non-superseded rows and resolves by the SAME hash as the core
ok 2209 - the view reads only non-superseded rows and resolves by the SAME hash as the core
  ---
  duration_ms: 0.137042
  type: 'test'
  ...
# Subtest: the migrate route creates the table BEFORE the view, mirroring migrations/0033 exactly
ok 2210 - the migrate route creates the table BEFORE the view, mirroring migrations/0033 exactly
  ---
  duration_ms: 0.115708
  type: 'test'
  ...
# Subtest: P-8: the table and the view pass the SQL guard, and lib/sql-guard-core.ts is untouched
ok 2211 - P-8: the table and the view pass the SQL guard, and lib/sql-guard-core.ts is untouched
  ---
  duration_ms: 1.323125
  type: 'test'
  ...
# Subtest: A-2: horizon_days is DERIVED in SQL against the canonical discharged_at — never typed, never audited_at
ok 2212 - A-2: horizon_days is DERIVED in SQL against the canonical discharged_at — never typed, never audited_at
  ---
  duration_ms: 0.083916
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: SQL honesty: reads degrade to unavailable and writes to a refusal — never a throw (no DB in this sandbox)
ok 2213 - SQL honesty: reads degrade to unavailable and writes to a refusal — never a throw (no DB in this sandbox)
  ---
  duration_ms: 26.214417
  type: 'test'
  ...
# Subtest: promotion threshold is 5
ok 2214 - promotion threshold is 5
  ---
  duration_ms: 0.494083
  type: 'test'
  ...
# Subtest: a selection recurring ≥ threshold → promotion candidate
ok 2215 - a selection recurring ≥ threshold → promotion candidate
  ---
  duration_ms: 0.536916
  type: 'test'
  ...
# Subtest: below threshold → collecting
ok 2216 - below threshold → collecting
  ---
  duration_ms: 0.075375
  type: 'test'
  ...
# Subtest: threshold override is honoured
ok 2217 - threshold override is honoured
  ---
  duration_ms: 0.058917
  type: 'test'
  ...
# Subtest: dominant selection wins over a minority variant; edited count tracks divergence from generated
ok 2218 - dominant selection wins over a minority variant; edited count tracks divergence from generated
  ---
  duration_ms: 0.213583
  type: 'test'
  ...
# Subtest: selection order and duplicates do not split a recurring set
ok 2219 - selection order and duplicates do not split a recurring set
  ---
  duration_ms: 0.069084
  type: 'test'
  ...
# Subtest: records with no procedure context are skipped
ok 2220 - records with no procedure context are skipped
  ---
  duration_ms: 0.101917
  type: 'test'
  ...
# Subtest: procedure grouping is case/whitespace-insensitive
ok 2221 - procedure grouping is case/whitespace-insensitive
  ---
  duration_ms: 0.057666
  type: 'test'
  ...
# Subtest: candidates sort before collecting; ties by recurrence desc
ok 2222 - candidates sort before collecting; ties by recurrence desc
  ---
  duration_ms: 0.234667
  type: 'test'
  ...
# Subtest: grouping is deterministic (twice → deep-equal)
ok 2223 - grouping is deterministic (twice → deep-equal)
  ---
  duration_ms: 1.021791
  type: 'test'
  ...
# Subtest: empty input → empty queue
ok 2224 - empty input → empty queue
  ---
  duration_ms: 0.137875
  type: 'test'
  ...
# Subtest: suggestSetName maps a procedure to hs-<word>
ok 2225 - suggestSetName maps a procedure to hs-<word>
  ---
  duration_ms: 0.204458
  type: 'test'
  ...
# Subtest: a dominant selection of real bank ids survives validateAdhocSelection
ok 2226 - a dominant selection of real bank ids survives validateAdhocSelection
  ---
  duration_ms: 1.13625
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: scored instruments → one dated care_call encounter with investigation points
ok 2227 - promResponsesToEncounter: scored instruments → one dated care_call encounter with investigation points
  ---
  duration_ms: 0.504334
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: unscored (null) instruments are dropped from the fold
ok 2228 - promResponsesToEncounter: unscored (null) instruments are dropped from the fold
  ---
  duration_ms: 0.07575
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: empty / all-null → empty investigations, no date (fold filters it)
ok 2229 - promResponsesToEncounter: empty / all-null → empty investigations, no date (fold filters it)
  ---
  duration_ms: 0.054833
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: deterministic (twice → deep-equal)
ok 2230 - promResponsesToEncounter: deterministic (twice → deep-equal)
  ---
  duration_ms: 0.442125
  type: 'test'
  ...
# Subtest: versions
ok 2231 - versions
  ---
  duration_ms: 0.618084
  type: 'test'
  ...
# Subtest: classifyFamily: each regex family (order = first-match-wins)
ok 2232 - classifyFamily: each regex family (order = first-match-wins)
  ---
  duration_ms: 2.239709
  type: 'test'
  ...
# Subtest: classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled
ok 2233 - classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled
  ---
  duration_ms: 0.24925
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: main surgical families reach their existing packs
ok 2234 - classifyFamily v1.1: main surgical families reach their existing packs
  ---
  duration_ms: 0.235375
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: existing coarse families unregressed
ok 2235 - classifyFamily v1.1: existing coarse families unregressed
  ---
  duration_ms: 0.13875
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: proctology routes to its house pack end-to-end
ok 2236 - classifyFamily v1.1: proctology routes to its house pack end-to-end
  ---
  duration_ms: 1.882541
  type: 'test'
  ...
# Subtest: classifyFamily: the universal_core catch-all is never returned as a family
ok 2237 - classifyFamily: the universal_core catch-all is never returned as a family
  ---
  duration_ms: 0.142958
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: sample uid→family for the 5 ratified representatives
ok 2238 - UID_FAMILY_MAP: sample uid→family for the 5 ratified representatives
  ---
  duration_ms: 0.052667
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: uid-map beats the procedure_name regex (precedence)
ok 2239 - UID_FAMILY_MAP: uid-map beats the procedure_name regex (precedence)
  ---
  duration_ms: 0.207833
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: facial_ent resolves to STANDARD + CORE+PREM only (null primary/fallback, no crash)
ok 2240 - UID_FAMILY_MAP: facial_ent resolves to STANDARD + CORE+PREM only (null primary/fallback, no crash)
  ---
  duration_ms: 0.722584
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: every mapped value except "excluded" is a real FAMILY_PACKS family
ok 2241 - UID_FAMILY_MAP: every mapped value except "excluded" is a real FAMILY_PACKS family
  ---
  duration_ms: 0.090916
  type: 'test'
  ...
# Subtest: archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD
ok 2242 - archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD
  ---
  duration_ms: 0.055208
  type: 'test'
  ...
# Subtest: instrumentsDue: cancelled → empty
ok 2243 - instrumentsDue: cancelled → empty
  ---
  duration_ms: 0.038416
  type: 'test'
  ...
# Subtest: instrumentsDue: no discharge → pre-op (baseline) only
ok 2244 - instrumentsDue: no discharge → pre-op (baseline) only
  ---
  duration_ms: 0.059375
  type: 'test'
  ...
# Subtest: instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close
ok 2245 - instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close
  ---
  duration_ms: 0.113667
  type: 'test'
  ...
# Subtest: instrumentsDue: baseline — in_window before surgery, missed after
ok 2246 - instrumentsDue: baseline — in_window before surgery, missed after
  ---
  duration_ms: 0.144791
  type: 'test'
  ...
# Subtest: instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)
ok 2247 - instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)
  ---
  duration_ms: 0.074625
  type: 'test'
  ...
# Subtest: instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback
ok 2248 - instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback
  ---
  duration_ms: 0.059166
  type: 'test'
  ...
# Subtest: scoreInstrument: house simple sum; complete set scored
ok 2249 - scoreInstrument: house simple sum; complete set scored
  ---
  duration_ms: 0.198875
  type: 'test'
  ...
# Subtest: scoreInstrument: partial set → honest null
ok 2250 - scoreInstrument: partial set → honest null
  ---
  duration_ms: 0.444667
  type: 'test'
  ...
# Subtest: scoreInstrument: ⚠ items emit the escalation code
ok 2251 - scoreInstrument: ⚠ items emit the escalation code
  ---
  duration_ms: 1.100959
  type: 'test'
  ...
# Subtest: scoreInstrument: still-unfilled validated instrument → honest null (rule not encoded yet)
ok 2252 - scoreInstrument: still-unfilled validated instrument → honest null (rule not encoded yet)
  ---
  duration_ms: 0.111458
  type: 'test'
  ...
# Subtest: scoreInstrument: WHODAS-12 simple sum — full 12-item set on WHODAS5 → 0–48
ok 2253 - scoreInstrument: WHODAS-12 simple sum — full 12-item set on WHODAS5 → 0–48
  ---
  duration_ms: 0.285875
  type: 'test'
  ...
# Subtest: scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null
ok 2254 - scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null
  ---
  duration_ms: 0.116583
  type: 'test'
  ...
# Subtest: catalog: whodas12 has exactly 12 items, each on WHODAS5
ok 2255 - catalog: whodas12 has exactly 12 items, each on WHODAS5
  ---
  duration_ms: 0.102291
  type: 'test'
  ...
# Subtest: scoreInstrument: PREM experience sum of items 1–7 (EXP4 0–3); item 8 excluded; 0–21
ok 2256 - scoreInstrument: PREM experience sum of items 1–7 (EXP4 0–3); item 8 excluded; 0–21
  ---
  duration_ms: 0.496625
  type: 'test'
  ...
# Subtest: scoreInstrument: PREM partial (an EXP4 item missing) → honest null
ok 2257 - scoreInstrument: PREM partial (an EXP4 item missing) → honest null
  ---
  duration_ms: 0.115167
  type: 'test'
  ...
# Subtest: catalog: PREM_MODULE has 8 items (prem1..prem7 EXP4, prem8 NRS-11); service flag present
ok 2258 - catalog: PREM_MODULE has 8 items (prem1..prem7 EXP4, prem8 NRS-11); service flag present
  ---
  duration_ms: 0.215334
  type: 'test'
  ...
# Subtest: catalog: WHODAS5 + EXP4 registered in SHARED_SCALES; every WHODAS/PREM item scale resolves
ok 2259 - catalog: WHODAS5 + EXP4 registered in SHARED_SCALES; every WHODAS/PREM item scale resolves
  ---
  duration_ms: 0.25375
  type: 'test'
  ...
# Subtest: integrity: every FamilyPack primary/fallback resolves to a known instrument
ok 2260 - integrity: every FamilyPack primary/fallback resolves to a known instrument
  ---
  duration_ms: 0.190875
  type: 'test'
  ...
# Subtest: integrity: every HOUSE item uses a SHARED_SCALES scale
ok 2261 - integrity: every HOUSE item uses a SHARED_SCALES scale
  ---
  duration_ms: 0.271875
  type: 'test'
  ...
# Subtest: integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes
ok 2262 - integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes
  ---
  duration_ms: 0.102917
  type: 'test'
  ...
# Subtest: integrity: every house item scale has response options; whodas12 now carries its 12 items
ok 2263 - integrity: every house item scale has response options; whodas12 now carries its 12 items
  ---
  duration_ms: 0.103
  type: 'test'
  ...
# Subtest: 2b scoring: koos_jr / hoos_jr interval-table lookup (higher = better)
ok 2264 - 2b scoring: koos_jr / hoos_jr interval-table lookup (higher = better)
  ---
  duration_ms: 0.283542
  type: 'test'
  ...
# Subtest: 2b scoring: spadi total %, ndi sum, nose ×5, ipss qol-excluded, nyha class, rmdq count
ok 2265 - 2b scoring: spadi total %, ndi sum, nose ×5, ipss qol-excluded, nyha class, rmdq count
  ---
  duration_ms: 0.227667
  type: 'test'
  ...
# Subtest: 2b scoring: partial responses → null (koos_jr/hoos_jr/spadi/ndi/ipss/nose/nyha)
ok 2266 - 2b scoring: partial responses → null (koos_jr/hoos_jr/spadi/ndi/ipss/nose/nyha)
  ---
  duration_ms: 1.899458
  type: 'test'
  ...
# Subtest: 2b catalog integrity: scales present, item counts, scales resolve, 2 lic corrections
ok 2267 - 2b catalog integrity: scales present, item counts, scales resolve, 2 lic corrections
  ---
  duration_ms: 0.233916
  type: 'test'
  ...
# Subtest: 2a selection: each Pv family selects its hs-set fallback (not the unconfirmed primary)
ok 2268 - 2a selection: each Pv family selects its hs-set fallback (not the unconfirmed primary)
  ---
  duration_ms: 0.212417
  type: 'test'
  ...
# Subtest: 2a scoring: complete house set → numeric sum (scale house); partial → honest null
ok 2269 - 2a scoring: complete house set → numeric sum (scale house); partial → honest null
  ---
  duration_ms: 0.123
  type: 'test'
  ...
# Subtest: 2a escalation: red-flag responses fire the expected code
ok 2270 - 2a escalation: red-flag responses fire the expected code
  ---
  duration_ms: 0.057375
  type: 'test'
  ...
# Subtest: 2a integrity: 3 new scales verbatim; every hs-set option value resolves in SHARED_SCALES
ok 2271 - 2a integrity: 3 new scales verbatim; every hs-set option value resolves in SHARED_SCALES
  ---
  duration_ms: 0.192
  type: 'test'
  ...
# Subtest: determinism: classify / instrumentsDue / score twice → deep-equal
ok 2272 - determinism: classify / instrumentsDue / score twice → deep-equal
  ---
  duration_ms: 0.1255
  type: 'test'
  ...
# Subtest: tier3 versions + max are stamped
ok 2273 - tier3 versions + max are stamped
  ---
  duration_ms: 0.74625
  type: 'test'
  ...
# Subtest: compileItemBank is deterministic (twice → deep-equal)
ok 2274 - compileItemBank is deterministic (twice → deep-equal)
  ---
  duration_ms: 2.151208
  type: 'test'
  ...
# Subtest: bank is house-only: no validated-instrument id leaks in
ok 2275 - bank is house-only: no validated-instrument id leaks in
  ---
  duration_ms: 0.423209
  type: 'test'
  ...
# Subtest: bank is house-only: no PREM id leaks in
ok 2276 - bank is house-only: no PREM id leaks in
  ---
  duration_ms: 1.025792
  type: 'test'
  ...
# Subtest: every bank item is sourced from an hs-set (never a validated set or PREM)
ok 2277 - every bank item is sourced from an hs-set (never a validated set or PREM)
  ---
  duration_ms: 0.248084
  type: 'test'
  ...
# Subtest: bank ids are unique (dedupe holds)
ok 2278 - bank ids are unique (dedupe holds)
  ---
  duration_ms: 0.177791
  type: 'test'
  ...
# Subtest: bank covers all 21 hs-sets (item count = Σ set items, deduped)
ok 2279 - bank covers all 21 hs-sets (item count = Σ set items, deduped)
  ---
  duration_ms: 0.477375
  type: 'test'
  ...
# Subtest: bankById is first-wins and complete
ok 2280 - bankById is first-wins and complete
  ---
  duration_ms: 0.330583
  type: 'test'
  ...
# Subtest: every bank item scale exists in SHARED_SCALES
ok 2281 - every bank item scale exists in SHARED_SCALES
  ---
  duration_ms: 0.453542
  type: 'test'
  ...
# Subtest: validate drops unknown ids
ok 2282 - validate drops unknown ids
  ---
  duration_ms: 0.439042
  type: 'test'
  ...
# Subtest: validate dedupes repeated ids
ok 2283 - validate dedupes repeated ids
  ---
  duration_ms: 0.095583
  type: 'test'
  ...
# Subtest: validate caps at ADHOC_MAX_ITEMS, preserving order
ok 2284 - validate caps at ADHOC_MAX_ITEMS, preserving order
  ---
  duration_ms: 0.081667
  type: 'test'
  ...
# Subtest: validate: zero valid ids → empty set
ok 2285 - validate: zero valid ids → empty set
  ---
  duration_ms: 0.067
  type: 'test'
  ...
# Subtest: validate preserves selection order
ok 2286 - validate preserves selection order
  ---
  duration_ms: 0.063709
  type: 'test'
  ...
# Subtest: validate is deterministic (twice → deep-equal)
ok 2287 - validate is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.076083
  type: 'test'
  ...
# Subtest: scoreAdhocSet: house-sum correct on a fixture
ok 2288 - scoreAdhocSet: house-sum correct on a fixture
  ---
  duration_ms: 1.296791
  type: 'test'
  ...
# Subtest: scoreAdhocSet: any item unanswered → null (complete-gate)
ok 2289 - scoreAdhocSet: any item unanswered → null (complete-gate)
  ---
  duration_ms: 0.248041
  type: 'test'
  ...
# Subtest: scoreAdhocSet: a ⚠ item surfaces its escalation code
ok 2290 - scoreAdhocSet: a ⚠ item surfaces its escalation code
  ---
  duration_ms: 0.314542
  type: 'test'
  ...
# Subtest: ADHOC_GEN_PROMPT is present, selection-only, never-invent
ok 2291 - ADHOC_GEN_PROMPT is present, selection-only, never-invent
  ---
  duration_ms: 0.271667
  type: 'test'
  ...
# Subtest: regression: 21 sets — all-index-0 → score 0, escalations match the oracle
ok 2292 - regression: 21 sets — all-index-0 → score 0, escalations match the oracle
  ---
  duration_ms: 1.393
  type: 'test'
  ...
# Subtest: regression: 21 sets — complete-midpoint (all index 1) → score = item count
ok 2293 - regression: 21 sets — complete-midpoint (all index 1) → score = item count
  ---
  duration_ms: 0.363292
  type: 'test'
  ...
# Subtest: regression: 21 sets — any item unanswered → null
ok 2294 - regression: 21 sets — any item unanswered → null
  ---
  duration_ms: 0.217625
  type: 'test'
  ...
# Subtest: regression: 21 sets — red-flag escalations match the oracle AND kernel/adhoc agree with scoreInstrument
ok 2295 - regression: 21 sets — red-flag escalations match the oracle AND kernel/adhoc agree with scoreInstrument
  ---
  duration_ms: 0.945542
  type: 'test'
  ...
# Subtest: the citation-derived labels carry the caveat, VERBATIM per the kickoff
ok 2296 - the citation-derived labels carry the caveat, VERBATIM per the kickoff
  ---
  duration_ms: 0.547459
  type: 'test'
  ...
# Subtest: deterministic_rule and no_source labels are BYTE-IDENTICAL to before
ok 2297 - deterministic_rule and no_source labels are BYTE-IDENTICAL to before
  ---
  duration_ms: 0.088708
  type: 'test'
  ...
# Subtest: all four `elevated` values are unchanged — this is wording, not ranking
ok 2298 - all four `elevated` values are unchanged — this is wording, not ranking
  ---
  duration_ms: 0.0615
  type: 'test'
  ...
# Subtest: groundingKind returns the same kind for the same input as before — all four kinds
ok 2299 - groundingKind returns the same kind for the same input as before — all four kinds
  ---
  duration_ms: 0.07825
  type: 'test'
  ...
# Subtest: PROVENANCE_TIER_LABELS is byte-identical — the ledger map was not touched
ok 2300 - PROVENANCE_TIER_LABELS is byte-identical — the ledger map was not touched
  ---
  duration_ms: 0.343416
  type: 'test'
  ...
# Subtest: classifyProvenanceTier is untouched: never reads citation_ids, same verdicts on a fixture
ok 2301 - classifyProvenanceTier is untouched: never reads citation_ids, same verdicts on a fixture
  ---
  duration_ms: 0.19025
  type: 'test'
  ...
# Subtest: the page-level caveat renders ONCE per page, verbatim, in the findings area
ok 2302 - the page-level caveat renders ONCE per page, verbatim, in the findings area
  ---
  duration_ms: 0.23225
  type: 'test'
  ...
# Subtest: GREP TEST: no surface renders the bare pre-caveat strings, and the map has ONE home
ok 2303 - GREP TEST: no surface renders the bare pre-caveat strings, and the map has ONE home
  ---
  duration_ms: 89.447333
  type: 'test'
  ...
# Subtest: the label correction itself rode no bump — the version only moves for scoring changes
ok 2304 - the label correction itself rode no bump — the version only moves for scoring changes
  ---
  duration_ms: 0.68875
  type: 'test'
  ...
# Subtest: the provenance ledger page still reads ONLY the ledger map
ok 2305 - the provenance ledger page still reads ONLY the ledger map
  ---
  duration_ms: 0.743791
  type: 'test'
  ...
# Subtest: clinician-signed: derivation "clinician" → clinician_signed, NEVER internal_consensus / uncited_deterministic
ok 2306 - clinician-signed: derivation "clinician" → clinician_signed, NEVER internal_consensus / uncited_deterministic
  ---
  duration_ms: 1.605666
  type: 'test'
  ...
# Subtest: clinician-signed: existing external + llm derivations route exactly as before
ok 2307 - clinician-signed: existing external + llm derivations route exactly as before
  ---
  duration_ms: 0.120083
  type: 'test'
  ...
# Subtest: MANDATORY PIN: the 44 society rules' generic choosingwisely URL does NOT resolve
ok 2308 - MANDATORY PIN: the 44 society rules' generic choosingwisely URL does NOT resolve
  ---
  duration_ms: 0.195
  type: 'test'
  ...
# Subtest: resolving citations: DOI, PMID, instance-specific URLs
ok 2309 - resolving citations: DOI, PMID, instance-specific URLs
  ---
  duration_ms: 0.063917
  type: 'test'
  ...
# Subtest: non-resolving: null/empty, bare domains, bare resolver roots — never a mere null-check
ok 2310 - non-resolving: null/empty, bare domains, bare resolver roots — never a mere null-check
  ---
  duration_ms: 0.065625
  type: 'test'
  ...
# Subtest: rule 1: rule_ref + resolving citation → deterministic; generic/none/missing row → internal_consensus
ok 2311 - rule 1: rule_ref + resolving citation → deterministic; generic/none/missing row → internal_consensus
  ---
  duration_ms: 0.052875
  type: 'test'
  ...
# Subtest: rule 2: deterministic source without rule_ref → uncited_deterministic (even at low-value)
ok 2312 - rule 2: deterministic source without rule_ref → uncited_deterministic (even at low-value)
  ---
  duration_ms: 0.044083
  type: 'test'
  ...
# Subtest: rule 3: low-value without rule_ref → unattributed_sourceable
ok 2313 - rule 3: low-value without rule_ref → unattributed_sourceable
  ---
  duration_ms: 0.045
  type: 'test'
  ...
# Subtest: rule 4: judgement family → inherent_judgment
ok 2314 - rule 4: judgement family → inherent_judgment
  ---
  duration_ms: 1.169209
  type: 'test'
  ...
# Subtest: rule 5 direction: unknowns default to SOURCEABLE, never to inherent (the bias runs against us)
ok 2315 - rule 5 direction: unknowns default to SOURCEABLE, never to inherent (the bias runs against us)
  ---
  duration_ms: 0.722666
  type: 'test'
  ...
# Subtest: grounding: precedence + R-7 labels verbatim; internal corpus is never elevated
ok 2316 - grounding: precedence + R-7 labels verbatim; internal corpus is never elevated
  ---
  duration_ms: 0.823583
  type: 'test'
  ...
# Subtest: corpusCitationResolves: OpenFDA null-page label resolves (§4); StatPearls/UpToDate/PubMed resolve
ok 2317 - corpusCitationResolves: OpenFDA null-page label resolves (§4); StatPearls/UpToDate/PubMed resolve
  ---
  duration_ms: 0.14725
  type: 'test'
  ...
# Subtest: corpusCitationResolves: self-reference / empty / no-locator does NOT resolve
ok 2318 - corpusCitationResolves: self-reference / empty / no-locator does NOT resolve
  ---
  duration_ms: 0.114291
  type: 'test'
  ...
# Subtest: deterministic finding with a resolving corpus citation → deterministic
ok 2319 - deterministic finding with a resolving corpus citation → deterministic
  ---
  duration_ms: 0.10175
  type: 'test'
  ...
# Subtest: deterministic finding marked llm → internal_consensus
ok 2320 - deterministic finding marked llm → internal_consensus
  ---
  duration_ms: 0.0775
  type: 'test'
  ...
# Subtest: S1 (0.81.10): muscle_relaxant_indication → deterministic_completeness (documentation prompt, same class as incomplete_dosing)
ok 2321 - S1 (0.81.10): muscle_relaxant_indication → deterministic_completeness (documentation prompt, same class as incomplete_dosing)
  ---
  duration_ms: 0.17775
  type: 'test'
  ...
# Subtest: 0.81.14: vitamin_d_repletion_duration + pregnancy_risk_verify → deterministic_completeness (documentation prompts)
ok 2322 - 0.81.14: vitamin_d_repletion_duration + pregnancy_risk_verify → deterministic_completeness (documentation prompts)
  ---
  duration_ms: 0.083667
  type: 'test'
  ...
# Subtest: V1/V2: incomplete_dosing → deterministic_completeness; duplicate_* → deterministic_logical
ok 2323 - V1/V2: incomplete_dosing → deterministic_completeness; duplicate_* → deterministic_logical
  ---
  duration_ms: 0.079042
  type: 'test'
  ...
# Subtest: §3.3 unreachability: an in-scope deterministic signal type that carries provenance is NEVER uncited_deterministic
ok 2324 - §3.3 unreachability: an in-scope deterministic signal type that carries provenance is NEVER uncited_deterministic
  ---
  duration_ms: 0.134542
  type: 'test'
  ...
# Subtest: bedrock is in LAB_PROVIDERS, and the other three are untouched
ok 2325 - bedrock is in LAB_PROVIDERS, and the other three are untouched
  ---
  duration_ms: 0.815209
  type: 'test'
  ...
# Subtest: EVERY provider has an entry for EVERY call class
ok 2326 - EVERY provider has an entry for EVERY call class
  ---
  duration_ms: 0.212792
  type: 'test'
  ...
# Subtest: the measured table, verbatim
ok 2327 - the measured table, verbatim
  ---
  duration_ms: 0.212166
  type: 'test'
  ...
# Subtest: OLLAMA AUDIT IS SINGLE-TRY — a local box that missed the budget will not answer on a re-ask
ok 2328 - OLLAMA AUDIT IS SINGLE-TRY — a local box that missed the budget will not answer on a re-ask
  ---
  duration_ms: 0.080333
  type: 'test'
  ...
# Subtest: BOTH AUDIT CLASSES ARE SINGLE-TRY on every provider (DEC-B4, reversing Unit A)
ok 2329 - BOTH AUDIT CLASSES ARE SINGLE-TRY on every provider (DEC-B4, reversing Unit A)
  ---
  duration_ms: 0.059208
  type: 'test'
  ...
# Subtest: ollama does not serve doc_read at all — null, not a number
ok 2330 - ollama does not serve doc_read at all — null, not a number
  ---
  duration_ms: 0.04725
  type: 'test'
  ...
# Subtest: the backoff allowance is the exact upper bound of the shipped curve
ok 2331 - the backoff allowance is the exact upper bound of the shipped curve
  ---
  duration_ms: 0.1145
  type: 'test'
  ...
# Subtest: totalBudgetMs = perAttemptMs × maxTries + the backoff allowance
ok 2332 - totalBudgetMs = perAttemptMs × maxTries + the backoff allowance
  ---
  duration_ms: 0.062917
  type: 'test'
  ...
# Subtest: the allowance is never optimistic — the total is at least the naive product
ok 2333 - the allowance is never optimistic — the total is at least the naive product
  ---
  duration_ms: 0.223667
  type: 'test'
  ...
# Subtest: bedrock:anthropic.claude-x RESOLVES, and is marked paid
ok 2334 - bedrock:anthropic.claude-x RESOLVES, and is marked paid
  ---
  duration_ms: 0.343125
  type: 'test'
  ...
# Subtest: …and it PROBES REACHABLE only when the WHOLE OIDC chain is configured
ok 2335 - …and it PROBES REACHABLE only when the WHOLE OIDC chain is configured
  ---
  duration_ms: 0.189458
  type: 'test'
  ...
# Subtest: an unknown prefix STILL errors and never falls back
ok 2336 - an unknown prefix STILL errors and never falls back
  ---
  duration_ms: 0.065709
  type: 'test'
  ...
# Subtest: EXISTING resolution semantics are untouched
ok 2337 - EXISTING resolution semantics are untouched
  ---
  duration_ms: 0.086083
  type: 'test'
  ...
# Subtest: the paid ceiling is untouched
ok 2338 - the paid ceiling is untouched
  ---
  duration_ms: 0.076542
  type: 'test'
  ...
# Subtest: RESOLVED BY UNIT D: one audit leg now fits the worker box it runs in
ok 2339 - RESOLVED BY UNIT D: one audit leg now fits the worker box it runs in
  ---
  duration_ms: 0.037208
  type: 'test'
  ...
# Subtest: §4.1: a Vertex 403 body survives whole — status, message, details all captured
ok 2340 - §4.1: a Vertex 403 body survives whole — status, message, details all captured
  ---
  duration_ms: 2.281458
  type: 'test'
  ...
# Subtest: §4.1: the cap is 4000, not 200 — a diagnostic longer than 200 chars survives
ok 2341 - §4.1: the cap is 4000, not 200 — a diagnostic longer than 200 chars survives
  ---
  duration_ms: 0.087167
  type: 'test'
  ...
# Subtest: §4.1: nested {error:{error:{…}}} unwraps; plain Error and junk degrade safely, never throw
ok 2342 - §4.1: nested {error:{error:{…}}} unwraps; plain Error and junk degrade safely, never throw
  ---
  duration_ms: 0.115875
  type: 'test'
  ...
# Subtest: §4.2: begin/end account per provider; snapshot totals; end floors at 0
ok 2343 - §4.2: begin/end account per provider; snapshot totals; end floors at 0
  ---
  duration_ms: 0.406667
  type: 'test'
  ...
# Subtest: §4.2: providerErrorPayload carries inFlightAtError + provider/label/fellBackTo + the serialised error
ok 2344 - §4.2: providerErrorPayload carries inFlightAtError + provider/label/fellBackTo + the serialised error
  ---
  duration_ms: 0.099875
  type: 'test'
  ...
# Subtest: §4.1: the 200-char truncation is GONE from every provider-error path
ok 2345 - §4.1: the 200-char truncation is GONE from every provider-error path
  ---
  duration_ms: 0.099917
  type: 'test'
  ...
# Subtest: §4.3: the fallback is LOUD — console.error with the stable [provider-fallback] prefix, console.warn gone
ok 2346 - §4.3: the fallback is LOUD — console.error with the stable [provider-fallback] prefix, console.warn gone
  ---
  duration_ms: 0.133792
  type: 'test'
  ...
# Subtest: §4.2: both tracedChat catches emit a provider_error event through the existing logEvent path
ok 2347 - §4.2: both tracedChat catches emit a provider_error event through the existing logEvent path
  ---
  duration_ms: 0.080083
  type: 'test'
  ...
# Subtest: §4.2: the in-flight snapshot is taken BEFORE the decrement — the failing call counts itself
ok 2348 - §4.2: the in-flight snapshot is taken BEFORE the decrement — the failing call counts itself
  ---
  duration_ms: 0.174791
  type: 'test'
  ...
# Subtest: the payload names model, region and SA identity — and the SA getter exposes client_email ONLY
ok 2349 - the payload names model, region and SA identity — and the SA getter exposes client_email ONLY
  ---
  duration_ms: 0.3065
  type: 'test'
  ...
# Subtest: §5 superseded for OpenRouter ONLY by addendum F v2: retry exists, but ONLY via the shared policy module
ok 2350 - §5 superseded for OpenRouter ONLY by addendum F v2: retry exists, but ONLY via the shared policy module
  ---
  duration_ms: 0.158
  type: 'test'
  ...
# Subtest: §5.2: a good response is NOT reclassified — including a one-character answer
ok 2351 - §5.2: a good response is NOT reclassified — including a one-character answer
  ---
  duration_ms: 0.131333
  type: 'test'
  ...
# Subtest: §2.1: the three failure rules — no choices, empty content, unusable finish_reason
ok 2352 - §2.1: the three failure rules — no choices, empty content, unusable finish_reason
  ---
  duration_ms: 0.081958
  type: 'test'
  ...
# Subtest: §2.1: a STREAM is never judged — it has no choices yet and would fail every rule
ok 2353 - §2.1: a STREAM is never judged — it has no choices yet and would fail every rule
  ---
  duration_ms: 0.042542
  type: 'test'
  ...
# Subtest: §2.2: the event carries the FULL body, both finish reasons, the served endpoint and the error object
ok 2354 - §2.2: the event carries the FULL body, both finish reasons, the served endpoint and the error object
  ---
  duration_ms: 0.186084
  type: 'test'
  ...
# Subtest: §5.1: the caller sees a FAILURE, not an empty string — and the error is marked, not laundered
ok 2355 - §5.1: the caller sees a FAILURE, not an empty string — and the error is marked, not laundered
  ---
  duration_ms: 0.089333
  type: 'test'
  ...
# Subtest: §2.2/§2.3: the response is validated per attempt, the event is emitted, and the bad-200 path DOES NOT fall back
ok 2356 - §2.2/§2.3: the response is validated per attempt, the event is emitted, and the bad-200 path DOES NOT fall back
  ---
  duration_ms: 0.162417
  type: 'test'
  ...
# Subtest: §2.1: the check runs only when the provider actually served — never after a fallback
ok 2357 - §2.1: the check runs only when the provider actually served — never after a fallback
  ---
  duration_ms: 0.047958
  type: 'test'
  ...
# Subtest: §6 out of scope: no retry, no backoff, and the Google provider pin is untouched
ok 2358 - §6 out of scope: no retry, no backoff, and the Google provider pin is untouched
  ---
  duration_ms: 0.092625
  type: 'test'
  ...
# Subtest: modelsAgree: served matches intended across provider prefixes (verdict KEPT)
ok 2359 - modelsAgree: served matches intended across provider prefixes (verdict KEPT)
  ---
  duration_ms: 0.469625
  type: 'test'
  ...
# Subtest: modelsAgree: a silent drop to the local Ollama model is a MISMATCH (verdict EXCLUDED)
ok 2360 - modelsAgree: a silent drop to the local Ollama model is a MISMATCH (verdict EXCLUDED)
  ---
  duration_ms: 0.11375
  type: 'test'
  ...
# Subtest: guard both directions: Qwen kept, Ollama fallback flagged — the SL2 regression
ok 2361 - guard both directions: Qwen kept, Ollama fallback flagged — the SL2 regression
  ---
  duration_ms: 0.055834
  type: 'test'
  ...
# Subtest: every provider has a budget for every call class, and the classes are the four
ok 2362 - every provider has a budget for every call class, and the classes are the four
  ---
  duration_ms: 0.862208
  type: 'test'
  ...
# Subtest: audit_ipd exists on every provider and ollama serves it
ok 2363 - audit_ipd exists on every provider and ollama serves it
  ---
  duration_ms: 0.105458
  type: 'test'
  ...
# Subtest: the published totals are exactly what the arithmetic in the PRD says
ok 2364 - the published totals are exactly what the arithmetic in the PRD says
  ---
  duration_ms: 0.085833
  type: 'test'
  ...
# Subtest: BOTH audit classes are one try on every provider — the ladder is multiplicative
ok 2365 - BOTH audit classes are one try on every provider — the ladder is multiplicative
  ---
  duration_ms: 0.049667
  type: 'test'
  ...
# Subtest: analyzeCase accepts a budget and passes it down BOTH arms of the generate closure
ok 2366 - analyzeCase accepts a budget and passes it down BOTH arms of the generate closure
  ---
  duration_ms: 0.214792
  type: 'test'
  ...
# Subtest: the IPD callers read the budget from the TABLE, never as literals in their own file
ok 2367 - the IPD callers read the budget from the TABLE, never as literals in their own file
  ---
  duration_ms: 0.115208
  type: 'test'
  ...
# Subtest: a null budget throws rather than substituting a default
ok 2368 - a null budget throws rather than substituting a default
  ---
  duration_ms: 0.109584
  type: 'test'
  ...
# Subtest: the OPD audit call site sends a maxTries taken from the budget
ok 2369 - the OPD audit call site sends a maxTries taken from the budget
  ---
  duration_ms: 0.086791
  type: 'test'
  ...
# Subtest: ipd-audit-now records what SERVED — the constant model is gone
ok 2370 - ipd-audit-now records what SERVED — the constant model is gone
  ---
  duration_ms: 0.205792
  type: 'test'
  ...
# Subtest: ipd-audit-now got the box its work actually needs (DEC-B5)
ok 2371 - ipd-audit-now got the box its work actually needs (DEC-B5)
  ---
  duration_ms: 0.280166
  type: 'test'
  ...
# Subtest: PROVIDER_SWITCH_ENABLED defaults OFF and is read at call time
ok 2372 - PROVIDER_SWITCH_ENABLED defaults OFF and is read at call time
  ---
  duration_ms: 0.077833
  type: 'test'
  ...
# Subtest: both workers gate ?provider= AND errors-loud behind the flag
ok 2373 - both workers gate ?provider= AND errors-loud behind the flag
  ---
  duration_ms: 0.357333
  type: 'test'
  ...
# Subtest: DEC-2 writes NO ROW rather than a laundered one, and never fires on a mini run
ok 2374 - DEC-2 writes NO ROW rather than a laundered one, and never fires on a mini run
  ---
  duration_ms: 0.156
  type: 'test'
  ...
# Subtest: a provider that cannot serve a class is REFUSED, not defaulted
ok 2375 - a provider that cannot serve a class is REFUSED, not defaulted
  ---
  duration_ms: 0.103833
  type: 'test'
  ...
# Subtest: resolveWorkerProvider errors loud and never falls back
ok 2376 - resolveWorkerProvider errors loud and never falls back
  ---
  duration_ms: 0.218625
  type: 'test'
  ...
# Subtest: the view is created idempotently beside the other two
ok 2377 - the view is created idempotently beside the other two
  ---
  duration_ms: 0.046916
  type: 'test'
  ...
# Subtest: ⚠️ payload IS EXCLUDED — it is the only PHI-bearing column on the table
ok 2378 - ⚠️ payload IS EXCLUDED — it is the only PHI-bearing column on the table
  ---
  duration_ms: 0.07675
  type: 'test'
  ...
# Subtest: tokens_out is present — it is the determinism observable, not a bonus column
ok 2379 - tokens_out is present — it is the determinism observable, not a bonus column
  ---
  duration_ms: 0.079542
  type: 'test'
  ...
# Subtest: call_model / call_provider are read as REAL COLUMNS, not out of payload
ok 2380 - call_model / call_provider are read as REAL COLUMNS, not out of payload
  ---
  duration_ms: 0.047875
  type: 'test'
  ...
# Subtest: THE NAME PASSES THE SQL GUARD WITHOUT lib/sql-guard-core.ts CHANGING
ok 2381 - THE NAME PASSES THE SQL GUARD WITHOUT lib/sql-guard-core.ts CHANGING
  ---
  duration_ms: 0.563291
  type: 'test'
  ...
# Subtest: lib/sql-guard-core.ts was NOT edited by this build
ok 2382 - lib/sql-guard-core.ts was NOT edited by this build
  ---
  duration_ms: 0.0675
  type: 'test'
  ...
# Subtest: exactly one cron entry moved, and it is the OPD worker path
ok 2383 - exactly one cron entry moved, and it is the OPD worker path
  ---
  duration_ms: 0.179125
  type: 'test'
  ...
# Subtest: quantizeConfidence is DELETED — the function, its export, and every call
ok 2384 - quantizeConfidence is DELETED — the function, its export, and every call
  ---
  duration_ms: 0.511375
  type: 'test'
  ...
# Subtest: findingPenalty is the target text VERBATIM — raw clamped float, no level cliff
ok 2385 - findingPenalty is the target text VERBATIM — raw clamped float, no level cliff
  ---
  duration_ms: 0.077
  type: 'test'
  ...
# Subtest: the penalty is CONTINUOUS in confidence again — the 0.80 cliff is gone
ok 2386 - the penalty is CONTINUOUS in confidence again — the 0.80 cliff is gone
  ---
  duration_ms: 0.496958
  type: 'test'
  ...
# Subtest: THE KEPT BEHAVIOUR: junk confidence lands on the scale, not outside it
ok 2387 - THE KEPT BEHAVIOUR: junk confidence lands on the scale, not outside it
  ---
  duration_ms: 0.184333
  type: 'test'
  ...
# Subtest: the pre-S1 arithmetic is restored exactly: the triple-QT canary computes 26 again
ok 2388 - the pre-S1 arithmetic is restored exactly: the triple-QT canary computes 26 again
  ---
  duration_ms: 0.087375
  type: 'test'
  ...
# Subtest: PENALTY_BASE, SEVERITY and bandFor are byte-identical
ok 2389 - PENALTY_BASE, SEVERITY and bandFor are byte-identical
  ---
  duration_ms: 0.338583
  type: 'test'
  ...
# Subtest: hysteresis is ENDORSED and untouched: g, the rule, and the store CASE all stand
ok 2390 - hysteresis is ENDORSED and untouched: g, the rule, and the store CASE all stand
  ---
  duration_ms: 0.409417
  type: 'test'
  ...
# Subtest: engine is current and the family includes it (decision 21 — no orphaned corpus)
ok 2391 - engine is current and the family includes it (decision 21 — no orphaned corpus)
  ---
  duration_ms: 0.074958
  type: 'test'
  ...
# Subtest: pairs A→B→C into (A,B) and (B,C)
ok 2392 - pairs A→B→C into (A,B) and (B,C)
  ---
  duration_ms: 0.987
  type: 'test'
  ...
# Subtest: no pair beyond 90 days; exactly 90 days is IN the window
ok 2393 - no pair beyond 90 days; exactly 90 days is IN the window
  ---
  duration_ms: 0.089875
  type: 'test'
  ...
# Subtest: same-day / overlapping admissions never pair; ER encounters never pair
ok 2394 - same-day / overlapping admissions never pair; ER encounters never pair
  ---
  duration_ms: 0.147625
  type: 'test'
  ...
# Subtest: tight_7d / within_30d boundaries
ok 2395 - tight_7d / within_30d boundaries
  ---
  duration_ms: 1.397709
  type: 'test'
  ...
# Subtest: structural_bounce = same department OR same doctor
ok 2396 - structural_bounce = same department OR same doctor
  ---
  duration_ms: 0.240541
  type: 'test'
  ...
# Subtest: er_route via admission_type Emergency and via an ER encounter within 48h
ok 2397 - er_route via admission_type Emergency and via an ER encounter within 48h
  ---
  duration_ms: 0.232792
  type: 'test'
  ...
# Subtest: excluded_category fires on EITHER side, exact live strings
ok 2398 - excluded_category fires on EITHER side, exact live strings
  ---
  duration_ms: 0.428958
  type: 'test'
  ...
# Subtest: lane precedence: excluded → er_routed → tight_bounce → structural_30d → other
ok 2399 - lane precedence: excluded → er_routed → tight_bounce → structural_30d → other
  ---
  duration_ms: 0.108417
  type: 'test'
  ...
# Subtest: dedup keys: stable for the same pair, distinct for different pairs and classes
ok 2400 - dedup keys: stable for the same pair, distinct for different pairs and classes
  ---
  duration_ms: 0.243333
  type: 'test'
  ...
# Subtest: duplicate-MRN reconcile fires only on name AND dob — never on a shared identifier alone
ok 2401 - duplicate-MRN reconcile fires only on name AND dob — never on a shared identifier alone
  ---
  duration_ms: 0.393417
  type: 'test'
  ...
# Subtest: form within ±5d of a KX readmit dedupes into the pair and attaches the CM note
ok 2402 - form within ±5d of a KX readmit dedupes into the pair and attaches the CM note
  ---
  duration_ms: 1.098541
  type: 'test'
  ...
# Subtest: form with an Even index stay but NO matching KX readmit is out-of-network, index-side
ok 2403 - form with an Even index stay but NO matching KX readmit is out-of-network, index-side
  ---
  duration_ms: 0.26175
  type: 'test'
  ...
# Subtest: form patients with no Even IP stay are OUT of scope; blank readmission_date is counted, not audited
ok 2404 - form patients with no Even IP stay are OUT of scope; blank readmission_date is counted, not audited
  ---
  duration_ms: 0.140583
  type: 'test'
  ...
# Subtest: ADT mapping priority: the live-validated column wins each candidate list
ok 2405 - ADT mapping priority: the live-validated column wins each candidate list
  ---
  duration_ms: 0.268833
  type: 'test'
  ...
# Subtest: detectReadmissions lane counts + within-30 subset
ok 2406 - detectReadmissions lane counts + within-30 subset
  ---
  duration_ms: 0.155125
  type: 'test'
  ...
# Subtest: planned counts only when foreshadowed in the INDEX summary
ok 2407 - planned counts only when foreshadowed in the INDEX summary
  ---
  duration_ms: 4.188625
  type: 'test'
  ...
# Subtest: planned asserted ONLY in the readmit summary does NOT make it planned
ok 2408 - planned asserted ONLY in the readmit summary does NOT make it planned
  ---
  duration_ms: 0.631959
  type: 'test'
  ...
# Subtest: near-discharge abnormal → high-confidence omission
ok 2409 - near-discharge abnormal → high-confidence omission
  ---
  duration_ms: 0.366916
  type: 'test'
  ...
# Subtest: admission-only labs → lower-confidence, clearly-labelled — never a hard "discharged unstable"
ok 2410 - admission-only labs → lower-confidence, clearly-labelled — never a hard "discharged unstable"
  ---
  duration_ms: 0.314583
  type: 'test'
  ...
# Subtest: missing labs → prose-only track; "no contradicting lab" is NEVER "confirmed stable"
ok 2411 - missing labs → prose-only track; "no contradicting lab" is NEVER "confirmed stable"
  ---
  duration_ms: 0.459667
  type: 'test'
  ...
# Subtest: labTimingProfile: short_stay / has_late_labs / admission_only / no_labs
ok 2412 - labTimingProfile: short_stay / has_late_labs / admission_only / no_labs
  ---
  duration_ms: 0.194583
  type: 'test'
  ...
# Subtest: an uncorroborated exculpatory claim does NOT clear a flagged case
ok 2413 - an uncorroborated exculpatory claim does NOT clear a flagged case
  ---
  duration_ms: 0.532
  type: 'test'
  ...
# Subtest: a disinterested corroborator makes the exculpatory claim count
ok 2414 - a disinterested corroborator makes the exculpatory claim count
  ---
  duration_ms: 0.250709
  type: 'test'
  ...
# Subtest: same-condition decided on the analyte bundle even when the model followed the renamed diagnosis string
ok 2415 - same-condition decided on the analyte bundle even when the model followed the renamed diagnosis string
  ---
  duration_ms: 1.298708
  type: 'test'
  ...
# Subtest: analyte helpers: canonicalisation, ranges, bundles
ok 2416 - analyte helpers: canonicalisation, ranges, bundles
  ---
  duration_ms: 1.853792
  type: 'test'
  ...
# Subtest: two-pass: same verdict + overlapping evidence ids → avoidable emitted
ok 2417 - two-pass: same verdict + overlapping evidence ids → avoidable emitted
  ---
  duration_ms: 0.189958
  type: 'test'
  ...
# Subtest: two-pass: same verdict + DISJOINT evidence → needs_adjudication
ok 2418 - two-pass: same verdict + DISJOINT evidence → needs_adjudication
  ---
  duration_ms: 0.112334
  type: 'test'
  ...
# Subtest: two-pass: disagreeing verdicts → needs_adjudication; avoidable on interested evidence alone → needs_adjudication
ok 2419 - two-pass: disagreeing verdicts → needs_adjudication; avoidable on interested evidence alone → needs_adjudication
  ---
  duration_ms: 0.084208
  type: 'test'
  ...
# Subtest: hallucinated evidence ids are dropped before the overlap test
ok 2420 - hallucinated evidence ids are dropped before the overlap test
  ---
  duration_ms: 0.046417
  type: 'test'
  ...
# Subtest: a verdict resting only on treating-team prose auto-routes to human review
ok 2421 - a verdict resting only on treating-team prose auto-routes to human review
  ---
  duration_ms: 0.1445
  type: 'test'
  ...
# Subtest: lane-D condition pass: SAME condition sets promoteToFull; different does not
ok 2422 - lane-D condition pass: SAME condition sets promoteToFull; different does not
  ---
  duration_ms: 0.133958
  type: 'test'
  ...
# Subtest: out-of-network: index-side only, NO avoidable verdict, identity always resolved, patient-reported stated
ok 2423 - out-of-network: index-side only, NO avoidable verdict, identity always resolved, patient-reported stated
  ---
  duration_ms: 0.156833
  type: 'test'
  ...
# Subtest: out-of-network planned may come from the CM form flag
ok 2424 - out-of-network planned may come from the CM form flag
  ---
  duration_ms: 0.044042
  type: 'test'
  ...
# Subtest: parsePassClaims: fenced JSON with prose around it parses; junk returns null (fail-safe)
ok 2425 - parsePassClaims: fenced JSON with prose around it parses; junk returns null (fail-safe)
  ---
  duration_ms: 0.217667
  type: 'test'
  ...
# Subtest: extractJsonObject survives nested braces and invalid verdict values are dropped, not guessed
ok 2426 - extractJsonObject survives nested braces and invalid verdict values are dropped, not guessed
  ---
  duration_ms: 0.093667
  type: 'test'
  ...
# Subtest: tier routing: structured labs in window → tier1; none → tier2; no index case → tier3
ok 2427 - tier routing: structured labs in window → tier1; none → tier2; no index case → tier3
  ---
  duration_ms: 0.59575
  type: 'test'
  ...
# Subtest: inferLabTier reads a catalog for pre-1.5 callers: structured lab → tier1, narrative only → tier2, nothing → tier3
ok 2428 - inferLabTier reads a catalog for pre-1.5 callers: structured lab → tier1, narrative only → tier2, nothing → tier3
  ---
  duration_ms: 0.794542
  type: 'test'
  ...
# Subtest: tier-1 numeric omission: index "stable" contradicted by an abnormal value near discharge → high-confidence finding
ok 2429 - tier-1 numeric omission: index "stable" contradicted by an abnormal value near discharge → high-confidence finding
  ---
  duration_ms: 1.1475
  type: 'test'
  ...
# Subtest: the SAME value dated only at admission lowers the confidence and says why (§8c.3)
ok 2430 - the SAME value dated only at admission lowers the confidence and says why (§8c.3)
  ---
  duration_ms: 0.339125
  type: 'test'
  ...
# Subtest: no stability claim in the index narrative → no derived omission (there is nothing to contradict)
ok 2431 - no stability claim in the index narrative → no derived omission (there is nothing to contradict)
  ---
  duration_ms: 0.102167
  type: 'test'
  ...
# Subtest: only the LATEST value at/before discharge is audited — a corrected analyte is not flagged
ok 2432 - only the LATEST value at/before discharge is audited — a corrected analyte is not flagged
  ---
  duration_ms: 0.142167
  type: 'test'
  ...
# Subtest: a value drawn AFTER discharge cannot be an omission — the discharge decision could not have known it
ok 2433 - a value drawn AFTER discharge cannot be an omission — the discharge decision could not have known it
  ---
  duration_ms: 0.056875
  type: 'test'
  ...
# Subtest: the derived audit runs ONLY on an explicitly stated tier 1, never on an inferred one
ok 2434 - the derived audit runs ONLY on an explicitly stated tier 1, never on an inferred one
  ---
  duration_ms: 0.073125
  type: 'test'
  ...
# Subtest: stability claims are the discharge-condition kind, not any use of the word
ok 2435 - stability claims are the discharge-condition kind, not any use of the word
  ---
  duration_ms: 0.161625
  type: 'test'
  ...
# Subtest: tier 2 caps an omission at moderate — a summary-vs-summary contradiction is never high-confidence
ok 2436 - tier 2 caps an omission at moderate — a summary-vs-summary contradiction is never high-confidence
  ---
  duration_ms: 0.35
  type: 'test'
  ...
# Subtest: tier 3 emits no omissions at all and records the refusal
ok 2437 - tier 3 emits no omissions at all and records the refusal
  ---
  duration_ms: 0.167625
  type: 'test'
  ...
# Subtest: only a STRUCTURED value can corroborate a stability claim
ok 2438 - only a STRUCTURED value can corroborate a stability claim
  ---
  duration_ms: 0.139667
  type: 'test'
  ...
# Subtest: the range is a JSON OBJECT: bounds come from .l/.h numerically
ok 2439 - the range is a JSON OBJECT: bounds come from .l/.h numerically
  ---
  duration_ms: 0.309458
  type: 'test'
  ...
# Subtest: an UNPARSEABLE range yields no numeric flag — never a guessed one
ok 2440 - an UNPARSEABLE range yields no numeric flag — never a guessed one
  ---
  duration_ms: 0.188125
  type: 'test'
  ...
# Subtest: an abnormal value against the live object range flags; an in-range one does not
ok 2441 - an abnormal value against the live object range flags; an in-range one does not
  ---
  duration_ms: 0.052
  type: 'test'
  ...
# Subtest: a value whose range will not parse produces NO derived omission, even under an explicit tier 1
ok 2442 - a value whose range will not parse produces NO derived omission, even under an explicit tier 1
  ---
  duration_ms: 0.081
  type: 'test'
  ...
# Subtest: refRangeDisplay prefers the lab's own wording over our reconstruction
ok 2443 - refRangeDisplay prefers the lab's own wording over our reconstruction
  ---
  duration_ms: 0.064083
  type: 'test'
  ...
# Subtest: the analyte-name matcher handles the real db13 names (LOINC is absent, so this is the primary path)
ok 2444 - the analyte-name matcher handles the real db13 names (LOINC is absent, so this is the primary path)
  ---
  duration_ms: 0.510791
  type: 'test'
  ...
# Subtest: with loinc_id absent the NAME decides; the code is only the fallback
ok 2445 - with loinc_id absent the NAME decides; the code is only the fallback
  ---
  duration_ms: 0.052542
  type: 'test'
  ...
# Subtest: the LOINC table still resolves where a code exists — kept as the fallback, not the primary path
ok 2446 - the LOINC table still resolves where a code exists — kept as the fallback, not the primary path
  ---
  duration_ms: 0.088167
  type: 'test'
  ...
# Subtest: a renamed diagnosis cannot move the organ bundle: same failing organ both sides → SAME condition
ok 2447 - a renamed diagnosis cannot move the organ bundle: same failing organ both sides → SAME condition
  ---
  duration_ms: 0.193291
  type: 'test'
  ...
# Subtest: a derived omission and the model's version of the same one collapse to one row, derived winning
ok 2448 - a derived omission and the model's version of the same one collapse to one row, derived winning
  ---
  duration_ms: 0.178875
  type: 'test'
  ...
# Subtest: the tier and its provenance ride the finding for the reviewer
ok 2449 - the tier and its provenance ride the finding for the reviewer
  ---
  duration_ms: 0.13775
  type: 'test'
  ...
# Subtest: lanes render clearest-first, and an UNKNOWN lane never hides in the collapsed block
ok 2450 - lanes render clearest-first, and an UNKNOWN lane never hides in the collapsed block
  ---
  duration_ms: 1.276042
  type: 'test'
  ...
# Subtest: within a lane, needs_human_review comes first and then the most recent readmission
ok 2451 - within a lane, needs_human_review comes first and then the most recent readmission
  ---
  duration_ms: 0.240666
  type: 'test'
  ...
# Subtest: the review count is audited AND (avoidable | needs_adjudication) — nothing else
ok 2452 - the review count is audited AND (avoidable | needs_adjudication) — nothing else
  ---
  duration_ms: 0.095542
  type: 'test'
  ...
# Subtest: out-of-network never shows an avoidable verdict, and not_auditable says why
ok 2453 - out-of-network never shows an avoidable verdict, and not_auditable says why
  ---
  duration_ms: 0.074792
  type: 'test'
  ...
# Subtest: an excluded row says "Held out", never lane-D’s "No verdict"
ok 2454 - an excluded row says "Held out", never lane-D’s "No verdict"
  ---
  duration_ms: 0.133458
  type: 'test'
  ...
# Subtest: the held-out sample groups last and collapsed, with the audited lanes untouched
ok 2455 - the held-out sample groups last and collapsed, with the audited lanes untouched
  ---
  duration_ms: 0.710458
  type: 'test'
  ...
# Subtest: tiles are blind to excluded rows — the route filters, and the filter is the contract
ok 2456 - tiles are blind to excluded rows — the route filters, and the filter is the contract
  ---
  duration_ms: 0.399833
  type: 'test'
  ...
# Subtest: a badge is omitted rather than guessed — unknown planned, ambiguous department, absent tier
ok 2457 - a badge is omitted rather than guessed — unknown planned, ambiguous department, absent tier
  ---
  duration_ms: 1.254
  type: 'test'
  ...
# Subtest: the verdict chip never borrows another verdict’s confidence
ok 2458 - the verdict chip never borrows another verdict’s confidence
  ---
  duration_ms: 0.334459
  type: 'test'
  ...
# Subtest: the 30-day rate is null without a real denominator — never a rate over a guess
ok 2459 - the 30-day rate is null without a real denominator — never a rate over a guess
  ---
  duration_ms: 0.338208
  type: 'test'
  ...
# Subtest: a failed name join degrades to the UHID, never a blank card
ok 2460 - a failed name join degrades to the UHID, never a blank card
  ---
  duration_ms: 0.727292
  type: 'test'
  ...
# Subtest: every promptRef tag across all tagged files resolves to a real registry id
ok 2461 - every promptRef tag across all tagged files resolves to a real registry id
  ---
  duration_ms: 2.677167
  type: 'test'
  ...
# Subtest: governedChat is exact delegation (transport-equivalence pin)
ok 2462 - governedChat is exact delegation (transport-equivalence pin)
  ---
  duration_ms: 0.207125
  type: 'test'
  ...
# Subtest: governance config sanity: four call patterns, three governed files, fold declared
ok 2463 - governance config sanity: four call patterns, three governed files, fold declared
  ---
  duration_ms: 27.816459
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: promptFingerprint resolves from the committed registry; unknown id → null, never a throw
ok 2464 - promptFingerprint resolves from the committed registry; unknown id → null, never a throw
  ---
  duration_ms: 2.886333
  type: 'test'
  ...
# Subtest: buildEnvelope: promptRef set → fingerprint columns; unset → call facts only
ok 2465 - buildEnvelope: promptRef set → fingerprint columns; unset → call facts only
  ---
  duration_ms: 0.138791
  type: 'test'
  ...
# Subtest: ENVELOPE_UPDATE_SQL writes exactly the ten normative columns
ok 2466 - ENVELOPE_UPDATE_SQL writes exactly the ten normative columns
  ---
  duration_ms: 0.060917
  type: 'test'
  ...
# Subtest: withTrace finalizes exactly once — on success AND on throw
ok 2467 - withTrace finalizes exactly once — on success AND on throw
  ---
  duration_ms: 0.329292
  type: 'test'
  ...
# Subtest: migration 0012 is additive + idempotent and covers every normative column
ok 2468 - migration 0012 is additive + idempotent and covers every normative column
  ---
  duration_ms: 0.387167
  type: 'test'
  ...
# Subtest: governance gate (Stage 4): the repo scan is CLEAN; synthetic direct calls are flagged
ok 2469 - governance gate (Stage 4): the repo scan is CLEAN; synthetic direct calls are flagged
  ---
  duration_ms: 232.541458
  type: 'test'
  ...
# Subtest: every Right Care promptRef tag resolves to a REAL registry id
ok 2470 - every Right Care promptRef tag resolves to a REAL registry id
  ---
  duration_ms: 0.461583
  type: 'test'
  ...
# Subtest: countNonEnumVerdicts (A04) counts exactly the out-of-enum verdicts
ok 2471 - countNonEnumVerdicts (A04) counts exactly the out-of-enum verdicts
  ---
  duration_ms: 0.252791
  type: 'test'
  ...
# Subtest: outcomeForPrompt maps the committed scorecard to the right prompt version/hash
ok 2472 - outcomeForPrompt maps the committed scorecard to the right prompt version/hash
  ---
  duration_ms: 1.164
  type: 'test'
  ...
# Subtest: RECOMPUTE: arm stats re-derive from the raw runs via the harness scorer — no drift
ok 2473 - RECOMPUTE: arm stats re-derive from the raw runs via the harness scorer — no drift
  ---
  duration_ms: 0.673375
  type: 'test'
  ...
# Subtest: maturity gate: mature requires a cleared gold; the LIVE manifests pass (CI assertion)
ok 2474 - maturity gate: mature requires a cleared gold; the LIVE manifests pass (CI assertion)
  ---
  duration_ms: 0.552542
  type: 'test'
  ...
# Subtest: provenance rider: cwus-ahaacchrs-001 labels as guideline-derived
ok 2475 - provenance rider: cwus-ahaacchrs-001 labels as guideline-derived
  ---
  duration_ms: 0.208042
  type: 'test'
  ...
# Subtest: determinism + evidence currency
ok 2476 - determinism + evidence currency
  ---
  duration_ms: 0.30375
  type: 'test'
  ...
# Subtest: registry generation is deterministic and the committed artifact is current
ok 2477 - registry generation is deterministic and the committed artifact is current
  ---
  duration_ms: 256.4515
  type: 'test'
  ...
# Subtest: every extracted prompt has non-empty text and a valid sha256 of exactly that text
ok 2478 - every extracted prompt has non-empty text and a valid sha256 of exactly that text
  ---
  duration_ms: 0.566291
  type: 'test'
  ...
# Subtest: the research export contains prompt/rubric/metadata keys ONLY — no clinical/patient/trace content
ok 2479 - the research export contains prompt/rubric/metadata keys ONLY — no clinical/patient/trace content
  ---
  duration_ms: 1.195875
  type: 'test'
  ...
# Subtest: manifest merge: registered id gets its metadata; unknown id → unregistered, never a throw
ok 2480 - manifest merge: registered id gets its metadata; unknown id → unregistered, never a throw
  ---
  duration_ms: 0.477375
  type: 'test'
  ...
# Subtest: rubric inclusion: nabh/6e external-json + the five embedded-in-prompt rubrics
ok 2481 - rubric inclusion: nabh/6e external-json + the five embedded-in-prompt rubrics
  ---
  duration_ms: 0.092459
  type: 'test'
  ...
# Subtest: count invariant: counts match the committed artifact contents (30 prompts / 7 rubrics / 32 builders)
ok 2482 - count invariant: counts match the committed artifact contents (30 prompts / 7 rubrics / 32 builders)
  ---
  duration_ms: 0.056375
  type: 'test'
  ...
# Subtest: registryTabRows maps generated + manifest correctly
ok 2483 - registryTabRows maps generated + manifest correctly
  ---
  duration_ms: 0.909959
  type: 'test'
  ...
# Subtest: groupPromptVersionCost sums the 4th breakdown correctly
ok 2484 - groupPromptVersionCost sums the 4th breakdown correctly
  ---
  duration_ms: 0.159
  type: 'test'
  ...
# Subtest: fingerprint + rollup tolerate NULL columns (pre-Stage-1 rows) without throwing
ok 2485 - fingerprint + rollup tolerate NULL columns (pre-Stage-1 rows) without throwing
  ---
  duration_ms: 20.441125
  type: 'test'
  ...
# Subtest: PHI-safety: new views surface registry/envelope fields only
ok 2486 - PHI-safety: new views surface registry/envelope fields only
  ---
  duration_ms: 0.46725
  type: 'test'
  ...
# Subtest: shortVersion / shortPromptRef formatters
ok 2487 - shortVersion / shortPromptRef formatters
  ---
  duration_ms: 0.073875
  type: 'test'
  ...
# Subtest: promptVersionChanges detects a rollout inside the watch window
ok 2488 - promptVersionChanges detects a rollout inside the watch window
  ---
  duration_ms: 0.142167
  type: 'test'
  ...
# Subtest: GOVERNANCE_SNAPSHOT matches the live scan — the coverage panel cannot rot
ok 2489 - GOVERNANCE_SNAPSHOT matches the live scan — the coverage panel cannot rot
  ---
  duration_ms: 278.270458
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 55 — every failure-phase to reconciler-state mapping, all four rows of D13's table
ok 2490 - 55 — every failure-phase to reconciler-state mapping, all four rows of D13's table
  ---
  duration_ms: 0.607917
  type: 'test'
  ...
# Subtest: 55 — the selection is bounded, non-terminal only, and oldest first
ok 2491 - 55 — the selection is bounded, non-terminal only, and oldest first
  ---
  duration_ms: 0.16575
  type: 'test'
  ...
# Subtest: 55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row
ok 2492 - 55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row
  ---
  duration_ms: 0.111833
  type: 'test'
  ...
# Subtest: 55 — a revision mismatch causes ONE reread and reclassification, never a blind retry
ok 2493 - 55 — a revision mismatch causes ONE reread and reclassification, never a blind retry
  ---
  duration_ms: 0.09625
  type: 'test'
  ...
# Subtest: 55 — every state the reconciler can assign is a legal transition from where it assigns it
ok 2494 - 55 — every state the reconciler can assign is a legal transition from where it assigns it
  ---
  duration_ms: 0.092083
  type: 'test'
  ...
# Subtest: 55 — the reconciler owns an invocation of its own kind, and closes it
ok 2495 - 55 — the reconciler owns an invocation of its own kind, and closes it
  ---
  duration_ms: 0.204791
  type: 'test'
  ...
# Subtest: 55 runtime — an ordinary one-row pass: one pinned write, no reread
ok 2496 - 55 runtime — an ordinary one-row pass: one pinned write, no reread
  ---
  duration_ms: 10.833625
  type: 'test'
  ...
# Subtest: 55 runtime — the statement the route ACTUALLY SENT is the pinned one, complete
ok 2497 - 55 runtime — the statement the route ACTUALLY SENT is the pinned one, complete
  ---
  duration_ms: 1.945084
  type: 'test'
  ...
# Subtest: 55 runtime — each row's write binds ITS OWN revision
ok 2498 - 55 runtime — each row's write binds ITS OWN revision
  ---
  duration_ms: 1.03625
  type: 'test'
  ...
# Subtest: 55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state
ok 2499 - 55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state
  ---
  duration_ms: 1.540667
  type: 'test'
  ...
# Subtest: 55 runtime — a TERMINAL row wins, and no second write is issued
ok 2500 - 55 runtime — a TERMINAL row wins, and no second write is issued
  ---
  duration_ms: 0.839667
  type: 'test'
  ...
# Subtest: 55 runtime — the CUTOFF is the request time minus the preregistered grace
ok 2501 - 55 runtime — the CUTOFF is the request time minus the preregistered grace
  ---
  duration_ms: 0.638417
  type: 'test'
  ...
# Subtest: 55 runtime — a FORBIDDEN transition is refused, and nothing is written
ok 2502 - 55 runtime — a FORBIDDEN transition is refused, and nothing is written
  ---
  duration_ms: 1.288584
  type: 'test'
  ...
# Subtest: the stub fails CLOSED on every body it does not model
ok 2503 - the stub fails CLOSED on every body it does not model
  ---
  duration_ms: 0.76975
  type: 'test'
  ...
# Subtest: 55 behaviour — the SELECT sent at run time is the complete pinned selection
ok 2504 - 55 behaviour — the SELECT sent at run time is the complete pinned selection
  ---
  duration_ms: 1.82275
  type: 'test'
  ...
# Subtest: 55 behaviour — the first write binds the revision the SELECTION returned
ok 2505 - 55 behaviour — the first write binds the revision the SELECTION returned
  ---
  duration_ms: 3.42075
  type: 'test'
  ...
# Subtest: 55 behaviour — a transport error on the write is a 500, never a fabricated verdict
ok 2506 - 55 behaviour — a transport error on the write is a 500, never a fabricated verdict
  ---
  duration_ms: 3.931708
  type: 'test'
  ...
# Subtest: 55 behaviour — a SECOND conflict on the reread path stops after two writes and one reread
ok 2507 - 55 behaviour — a SECOND conflict on the reread path stops after two writes and one reread
  ---
  duration_ms: 0.488042
  type: 'test'
  ...
# Subtest: 55 summary — a slice of TERMINAL rows tallies no reconciliations at all
ok 2508 - 55 summary — a slice of TERMINAL rows tallies no reconciliations at all
  ---
  duration_ms: 0.313666
  type: 'test'
  ...
# Subtest: 55 summary — more_may_remain is TRUE on a full slice and FALSE on a short one
ok 2509 - 55 summary — more_may_remain is TRUE on a full slice and FALSE on a short one
  ---
  duration_ms: 0.567
  type: 'test'
  ...
# Subtest: 55 behaviour — an unauthenticated request is 401 and touches the database not at all
ok 2510 - 55 behaviour — an unauthenticated request is 401 and touches the database not at all
  ---
  duration_ms: 0.169084
  type: 'test'
  ...
# Subtest: 58 — WORKER_MAX_DURATION_SECONDS equals the worker route's own maxDuration literal
ok 2511 - 58 — WORKER_MAX_DURATION_SECONDS equals the worker route's own maxDuration literal
  ---
  duration_ms: 0.273042
  type: 'test'
  ...
# Subtest: 59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs
ok 2512 - 59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs
  ---
  duration_ms: 0.214375
  type: 'test'
  ...
# Subtest: 64 — both files assert 17, and neither still asserts 16
ok 2513 - 64 — both files assert 17, and neither still asserts 16
  ---
  duration_ms: 0.228958
  type: 'test'
  ...
# Subtest: 64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9
ok 2514 - 64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9
  ---
  duration_ms: 0.312417
  type: 'test'
  ...
# Subtest: 64 — provider-switch-unit-d's sql-guard assertion is untouched, and is nowhere near line 270
ok 2515 - 64 — provider-switch-unit-d's sql-guard assertion is untouched, and is nowhere near line 270
  ---
  duration_ms: 0.120458
  type: 'test'
  ...
# Subtest: artifact — THE ROUTE HAS NOT RUN IN THIS PROCESS
ok 2516 - artifact — THE ROUTE HAS NOT RUN IN THIS PROCESS
  ---
  duration_ms: 1.545041
  type: 'test'
  ...
# Subtest: artifact — the reconciler route is byte-for-byte the reviewed file
ok 2517 - artifact — the reconciler route is byte-for-byte the reviewed file
  ---
  duration_ms: 0.472917
  type: 'test'
  ...
# Subtest: artifact — what this pin does NOT cover
ok 2518 - artifact — what this pin does NOT cover
  ---
  duration_ms: 0.214834
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row already terminal (persisted_complete), preserved
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row already terminal (persisted_complete), preserved
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# Subtest: v7 §8 — a rejected terminal write now leaves DURABLE evidence, not just a console.warn
ok 2519 - v7 §8 — a rejected terminal write now leaves DURABLE evidence, not just a console.warn
  ---
  duration_ms: 3.446833
  type: 'test'
  ...
# Subtest: v7 §8 — the reread distinguishes an already-terminal row from a moved revision
ok 2520 - v7 §8 — the reread distinguishes an already-terminal row from a moved revision
  ---
  duration_ms: 1.899125
  type: 'test'
  ...
# Subtest: v7 §8 — an existing terminal row is NEVER downgraded, and that is structural
ok 2521 - v7 §8 — an existing terminal row is NEVER downgraded, and that is structural
  ---
  duration_ms: 0.352292
  type: 'test'
  ...
# Subtest: v7 §8 — the handle is returned unadvanced, and nothing is retried
ok 2522 - v7 §8 — the handle is returned unadvanced, and nothing is retried
  ---
  duration_ms: 1.099
  type: 'test'
  ...
# Subtest: v7 §8 — a failed reread still records the evidence, because the reread is diagnostic
ok 2523 - v7 §8 — a failed reread still records the evidence, because the reread is diagnostic
  ---
  duration_ms: 0.343291
  type: 'test'
  ...
# Subtest: v7 §8 — the new phase is run-scoped and in the vocabulary, and the reconciler deliberately ignores it
ok 2524 - v7 §8 — the new phase is run-scoped and in the vocabulary, and the reconciler deliberately ignores it
  ---
  duration_ms: 0.090709
  type: 'test'
  ...
# Subtest: v7 §8 — the generated CHECK and the mirrored .sql agree on the new phase
ok 2525 - v7 §8 — the generated CHECK and the mirrored .sql agree on the new phase
  ---
  duration_ms: 0.626708
  type: 'test'
  ...
# Subtest: v7 §7 — the field is present-and-null when there is no active run, and that validates clean
ok 2526 - v7 §7 — the field is present-and-null when there is no active run, and that validates clean
  ---
  duration_ms: 0.345208
  type: 'test'
  ...
# Subtest: v7 §7 — an ABSENT field is a defect, which is what makes the null a claim rather than a gap
ok 2527 - v7 §7 — an ABSENT field is a defect, which is what makes the null a claim rather than a gap
  ---
  duration_ms: 0.246083
  type: 'test'
  ...
# Subtest: v7 §7 — the definition is recorded, and BackfillRun still has no `target` field
ok 2528 - v7 §7 — the definition is recorded, and BackfillRun still has no `target` field
  ---
  duration_ms: 0.584584
  type: 'test'
  ...
# Subtest: v7 §7 — the writer maps no-active-run to null on all three fields
ok 2529 - v7 §7 — the writer maps no-active-run to null on all three fields
  ---
  duration_ms: 0.320292
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order transient 503
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (m): simulated 403
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' failed the discrimination probe (m): no discrimination
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' missing (m): 404
# [rerank] judge fallback failed → input order: judge is down too
# Subtest: resolveRerankBackend: explicit override wins, else env default; only judge|cohere
ok 2530 - resolveRerankBackend: explicit override wins, else env default; only judge|cohere
  ---
  duration_ms: 1.840042
  type: 'test'
  ...
# Subtest: no backend arg routes to the env default (judge in the test env), not cohere
ok 2531 - no backend arg routes to the env default (judge in the test env), not cohere
  ---
  duration_ms: 3.630625
  type: 'test'
  ...
# Subtest: assertRerankBackendHealthy passes when rel=0.8, irr=0.02
ok 2532 - assertRerankBackendHealthy passes when rel=0.8, irr=0.02
  ---
  duration_ms: 9.457041
  type: 'test'
  ...
# Subtest: probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)
ok 2533 - probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)
  ---
  duration_ms: 0.509292
  type: 'test'
  ...
# Subtest: probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)
ok 2534 - probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)
  ---
  duration_ms: 0.301
  type: 'test'
  ...
# Subtest: probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key
ok 2535 - probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key
  ---
  duration_ms: 0.270333
  type: 'test'
  ...
# Subtest: probe is memoized within the TTL — two calls ⇒ one fetch
ok 2536 - probe is memoized within the TTL — two calls ⇒ one fetch
  ---
  duration_ms: 2.485125
  type: 'test'
  ...
# Subtest: rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere
ok 2537 - rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere
  ---
  duration_ms: 16.946625
  type: 'test'
  ...
# Subtest: explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)
ok 2538 - explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)
  ---
  duration_ms: 1.530709
  type: 'test'
  ...
# Subtest: a TRANSIENT (generic, non-typed) failure still soft-falls to input order
ok 2539 - a TRANSIENT (generic, non-typed) failure still soft-falls to input order
  ---
  duration_ms: 1.210458
  type: 'test'
  ...
# Subtest: D2.1 env-default cohere: a typed cohere failure ⇒ falls back to JUDGE (tier 1), never throws
ok 2540 - D2.1 env-default cohere: a typed cohere failure ⇒ falls back to JUDGE (tier 1), never throws
  ---
  duration_ms: 0.581083
  type: 'test'
  ...
# Subtest: D2.2 env-default cohere: cohere AND judge both throw ⇒ INPUT ORDER (none), never throws
ok 2541 - D2.2 env-default cohere: cohere AND judge both throw ⇒ INPUT ORDER (none), never throws
  ---
  duration_ms: 0.406334
  type: 'test'
  ...
# Subtest: D2.3 EXPLICIT cohere: a typed cohere failure PROPAGATES (strict — NO fallback to judge)
ok 2542 - D2.3 EXPLICIT cohere: a typed cohere failure PROPAGATES (strict — NO fallback to judge)
  ---
  duration_ms: 0.134959
  type: 'test'
  ...
# Subtest: D2.4 env-default cohere HEALTHY ⇒ cohere scores; probe invoked once (memoization proven in §5.5)
ok 2543 - D2.4 env-default cohere HEALTHY ⇒ cohere scores; probe invoked once (memoization proven in §5.5)
  ---
  duration_ms: 0.081667
  type: 'test'
  ...
# Subtest: D3 a successful cohere rerank records ONE cost entry carrying the response usage.cost
ok 2544 - D3 a successful cohere rerank records ONE cost entry carrying the response usage.cost
  ---
  duration_ms: 0.592167
  type: 'test'
  ...
# Subtest: the rerank module no longer contains any bge symbol
ok 2545 - the rerank module no longer contains any bge symbol
  ---
  duration_ms: 0.295375
  type: 'test'
  ...
# Subtest: discrimination thresholds default to 0.40 / 0.15
ok 2546 - discrimination thresholds default to 0.40 / 0.15
  ---
  duration_ms: 0.042083
  type: 'test'
  ...
# Subtest: §5.1 the LIVE production case: RERANK_BACKEND=Cohere resolves to judge AND warns
ok 2547 - §5.1 the LIVE production case: RERANK_BACKEND=Cohere resolves to judge AND warns
  ---
  duration_ms: 0.044959
  type: 'test'
  ...
# Subtest: §5.1b …and the warning actually FIRES at real module load (cold-start proof, subprocess)
ok 2548 - §5.1b …and the warning actually FIRES at real module load (cold-start proof, subprocess)
  ---
  duration_ms: 335.929667
  type: 'test'
  ...
# Subtest: §5.2 exact lowercase cohere (whitespace-trimmed) selects cohere silently; COHERE warns to judge
ok 2549 - §5.2 exact lowercase cohere (whitespace-trimmed) selects cohere silently; COHERE warns to judge
  ---
  duration_ms: 0.104625
  type: 'test'
  ...
# Subtest: §5.3 judge, trimmed judge and unset are silent; any other value warns to judge
ok 2550 - §5.3 judge, trimmed judge and unset are silent; any other value warns to judge
  ---
  duration_ms: 0.224166
  type: 'test'
  ...
# Subtest: §5.4 miniPipeline normalizes: Mini and " mini " both select the mini pipeline
ok 2551 - §5.4 miniPipeline normalizes: Mini and " mini " both select the mini pipeline
  ---
  duration_ms: 0.087125
  type: 'test'
  ...
# Subtest: §5.5 INVARIANCE: no rerankBackend ⇒ retrieve options deep-equal to today, no extra key
ok 2552 - §5.5 INVARIANCE: no rerankBackend ⇒ retrieve options deep-equal to today, no extra key
  ---
  duration_ms: 0.168458
  type: 'test'
  ...
# Subtest: §5.6 rerankBackend:cohere reaches retrieve() — carried in the opts and threaded at the call sites
ok 2553 - §5.6 rerankBackend:cohere reaches retrieve() — carried in the opts and threaded at the call sites
  ---
  duration_ms: 0.536583
  type: 'test'
  ...
# Subtest: §5.7 explicit cohere via the threaded path stays STRICT — typed errors propagate, no fallback
ok 2554 - §5.7 explicit cohere via the threaded path stays STRICT — typed errors propagate, no fallback
  ---
  duration_ms: 0.172625
  type: 'test'
  ...
# Subtest: pickScoreFields drops text/section, keeps ids + scores
ok 2555 - pickScoreFields drops text/section, keeps ids + scores
  ---
  duration_ms: 0.092
  type: 'test'
  ...
# Subtest: THE EXHIBIT: "Atarax Cream…" resolves to NOTHING — not Hydroxyzine, not approximate
ok 2556 - THE EXHIBIT: "Atarax Cream…" resolves to NOTHING — not Hydroxyzine, not approximate
  ---
  duration_ms: 0.92075
  type: 'test'
  ...
# Subtest: the gate fires on the TEXT alone too — no route needed
ok 2557 - the gate fires on the TEXT alone too — no route needed
  ---
  duration_ms: 0.31825
  type: 'test'
  ...
# Subtest: the ORAL Atarax lines still resolve, confident — the gate is surgical
ok 2558 - the ORAL Atarax lines still resolve, confident — the gate is surgical
  ---
  duration_ms: 1.686875
  type: 'test'
  ...
# Subtest: a topical line matching a family that HAS a topical row still resolves
ok 2559 - a topical line matching a family that HAS a topical row still resolves
  ---
  duration_ms: 0.250167
  type: 'test'
  ...
# Subtest: route vocabulary: Topical, "topical " (trailing space) and local ALL count as topical
ok 2560 - route vocabulary: Topical, "topical " (trailing space) and local ALL count as topical
  ---
  duration_ms: 0.324
  type: 'test'
  ...
# Subtest: phase 1.1 route PHRASES: application/apply-locally/intranasal variants all count as topical
ok 2561 - phase 1.1 route PHRASES: application/apply-locally/intranasal variants all count as topical
  ---
  duration_ms: 0.244584
  type: 'test'
  ...
# Subtest: the topical-form regex is the normative one, and word boundaries hold
ok 2562 - the topical-form regex is the normative one, and word boundaries hold
  ---
  duration_ms: 2.105833
  type: 'test'
  ...
# Subtest: tier 5 (brand-prefix, APPROX): a topical line never takes an oral approximate match
ok 2563 - tier 5 (brand-prefix, APPROX): a topical line never takes an oral approximate match
  ---
  duration_ms: 0.166834
  type: 'test'
  ...
# Subtest: TIERS 1–3 UNCHANGED: source generic, exact brand and embedded molecule ignore the gate
ok 2564 - TIERS 1–3 UNCHANGED: source generic, exact brand and embedded molecule ignore the gate
  ---
  duration_ms: 0.79525
  type: 'test'
  ...
# Subtest: CONFIDENT_MATCH and classifyUnmatched/NUTRA are untouched
ok 2565 - CONFIDENT_MATCH and classifyUnmatched/NUTRA are untouched
  ---
  duration_ms: 1.210875
  type: 'test'
  ...
# Subtest: the category gate: the three enums, case-sensitive, trimmed — matcher skipped entirely
ok 2566 - the category gate: the three enums, case-sensitive, trimmed — matcher skipped entirely
  ---
  duration_ms: 56.304375
  type: 'test'
  ...
# Subtest: the category gate is CASE-SENSITIVE and enum-exact — near-misses fall through to the matcher
ok 2567 - the category gate is CASE-SENSITIVE and enum-exact — near-misses fall through to the matcher
  ---
  duration_ms: 13.946
  type: 'test'
  ...
# Subtest: rowToOpdCase carries default_opd_service_category verbatim, fail-safe on absence
ok 2568 - rowToOpdCase carries default_opd_service_category verbatim, fail-safe on absence
  ---
  duration_ms: 0.210333
  type: 'test'
  ...
# Subtest: §5.1: the gate still fires for a category-gated TOPICAL line — the Atarax exhibit
ok 2569 - §5.1: the gate still fires for a category-gated TOPICAL line — the Atarax exhibit
  ---
  duration_ms: 2.118
  type: 'test'
  ...
# Subtest: §5.2: a category-gated ORAL line runs the matcher — Crocin resolves to Paracetamol
ok 2570 - §5.2: a category-gated ORAL line runs the matcher — Crocin resolves to Paracetamol
  ---
  duration_ms: 1.915709
  type: 'test'
  ...
# Subtest: §5.3 THE PHASE-3 UNBLOCKER: Depura 60000 IU Vitamin D3 Oral Solution resolves to Vitamin D3
ok 2571 - §5.3 THE PHASE-3 UNBLOCKER: Depura 60000 IU Vitamin D3 Oral Solution resolves to Vitamin D3
  ---
  duration_ms: 1.21625
  type: 'test'
  ...
# Subtest: §5.4: category + BLANK route + form word in the brand ⇒ still gated (text is evidence)
ok 2572 - §5.4: category + BLANK route + form word in the brand ⇒ still gated (text is evidence)
  ---
  duration_ms: 1.772292
  type: 'test'
  ...
# Subtest: §5.5: category + blank route + NO form word ⇒ matcher runs — Zincovit Tablet
ok 2573 - §5.5: category + blank route + NO form word ⇒ matcher runs — Zincovit Tablet
  ---
  duration_ms: 2.385375
  type: 'test'
  ...
# Subtest: §5.7: the tier-4/5 form gate from phase 1 is unchanged for non-category topical lines
ok 2574 - §5.7: the tier-4/5 form gate from phase 1 is unchanged for non-category topical lines
  ---
  duration_ms: 1.35575
  type: 'test'
  ...
# Subtest: phase 1.1 direction check: the widened regex can only WITHHOLD matches, never create one
ok 2575 - phase 1.1 direction check: the widened regex can only WITHHOLD matches, never create one
  ---
  duration_ms: 0.22275
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 28 — ONE multi-row insert, app_source bound explicitly, no stamper involved
ok 2576 - 28 — ONE multi-row insert, app_source bound explicitly, no stamper involved
  ---
  duration_ms: 2.028959
  type: 'test'
  ...
# Subtest: 62 — app_source binds APP_SOURCE when set, and 'standalone' when absent, never null
ok 2577 - 62 — app_source binds APP_SOURCE when set, and 'standalone' when absent, never null
  ---
  duration_ms: 0.278458
  type: 'test'
  ...
# Subtest: the three A/A experiment columns are BOUND, so opd_art_experiment_idx is populable
ok 2578 - the three A/A experiment columns are BOUND, so opd_art_experiment_idx is populable
  ---
  duration_ms: 0.684417
  type: 'test'
  ...
# Subtest: declared_retrievals counts the rows that LANDED, not the rows that were asked for
ok 2579 - declared_retrievals counts the rows that LANDED, not the rows that were asked for
  ---
  duration_ms: 0.323375
  type: 'test'
  ...
# Subtest: a declaration that lands nothing bumps nothing at all
ok 2580 - a declaration that lands nothing bumps nothing at all
  ---
  duration_ms: 0.096042
  type: 'test'
  ...
# Subtest: an empty run list writes nothing and returns an empty handle
ok 2581 - an empty run list writes nothing and returns an empty handle
  ---
  duration_ms: 0.053625
  type: 'test'
  ...
# Subtest: 29 — a failed batch declaration writes ONE work_declaration failure row per generated run
ok 2582 - 29 — a failed batch declaration writes ONE work_declaration failure row per generated run
  ---
  duration_ms: 0.524125
  type: 'test'
  ...
# [retrieval-telemetry] failure row for a run-scoped phase has no run id or role work_declaration
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] telemetry_write_failures increment failed: Error connecting to database: NeonDbError (stub)
# Subtest: 29 — a run-scoped failure phase with no run id is refused before it reaches the CHECK
ok 2583 - 29 — a run-scoped failure phase with no run id is refused before it reaches the CHECK
  ---
  duration_ms: 26.626
  type: 'test'
  ...
# Subtest: 29 — when the failure store ITSELF fails, the invocation counter is the last evidence
ok 2584 - 29 — when the failure store ITSELF fails, the invocation counter is the last evidence
  ---
  duration_ms: 0.543833
  type: 'test'
  ...
# Subtest: 30 — an invocation insert failure is fail-open, and leaves evidence
ok 2585 - 30 — an invocation insert failure is fail-open, and leaves evidence
  ---
  duration_ms: 0.578084
  type: 'test'
  ...
# Subtest: 30 — the invocation row is inserted once, with its kind and route class
ok 2586 - 30 — the invocation row is inserted once, with its kind and route class
  ---
  duration_ms: 0.151208
  type: 'test'
  ...
# Subtest: closeInvocation is fail-open too, and records a closure failure
ok 2587 - closeInvocation is fail-open too, and records a closure failure
  ---
  duration_ms: 0.433583
  type: 'test'
  ...
# Subtest: the write-failure counter never throws, even when its own UPDATE fails
ok 2588 - the write-failure counter never throws, even when its own UPDATE fails
  ---
  duration_ms: 0.119833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: RETRIEVAL_LLM_SEED is the fixed shared seed (42), defined once in expand.ts
ok 2589 - RETRIEVAL_LLM_SEED is the fixed shared seed (42), defined once in expand.ts
  ---
  duration_ms: 0.414042
  type: 'test'
  ...
# Subtest: expand.ts: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
ok 2590 - expand.ts: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
  ---
  duration_ms: 0.123375
  type: 'test'
  ...
# Subtest: multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
ok 2591 - multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
  ---
  duration_ms: 0.069
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 60 A — useReranker false: instrumentation on and off return byte-identical results
ok 2592 - 60 A — useReranker false: instrumentation on and off return byte-identical results
  ---
  duration_ms: 891.149334
  type: 'test'
  ...
# Subtest: 60 B — useReranker true: identical results, batch boundaries and prompts across on and off
ok 2593 - 60 B — useReranker true: identical results, batch boundaries and prompts across on and off
  ---
  duration_ms: 82.27225
  type: 'test'
  ...
# Subtest: 60 C — the production opts: identical results with source weighting, expansion and embedding all live
ok 2594 - 60 C — the production opts: identical results with source weighting, expansion and embedding all live
  ---
  duration_ms: 35.957833
  type: 'test'
  ...
# Subtest: 60 — THE CALL-FORM PIN: one side omits the capture argument, per case
ok 2595 - 60 — THE CALL-FORM PIN: one side omits the capture argument, per case
  ---
  duration_ms: 0.905291
  type: 'test'
  ...
# Subtest: 60 — the seven routing fragments are pairwise non-overlapping on the statements that ran
ok 2596 - 60 — the seven routing fragments are pairwise non-overlapping on the statements that ran
  ---
  duration_ms: 0.8525
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] settlement rejected: no_row primary r1
# [retrieval-telemetry] settlement rejected: stale_revision primary expected 1, found 4
# [retrieval-telemetry] settlement rejected: already_terminal primary persisted_complete
# [retrieval-telemetry] settlement rejected: disallowed_transition primary started -> persisted_complete
# [retrieval-telemetry] settlement rejected: lost_update primary r1
# Subtest: 51 — every settlement outcome has a state, and the mapping is D9's table exactly
ok 2597 - 51 — every settlement outcome has a state, and the mapping is D9's table exactly
  ---
  duration_ms: 0.916041
  type: 'test'
  ...
# Subtest: 51 — saveOpdAudit's four return values each map to their D9 outcome, including skipped
ok 2598 - 51 — saveOpdAudit's four return values each map to their D9 outcome, including skipped
  ---
  duration_ms: 0.081875
  type: 'test'
  ...
# Subtest: 51 — settlement writes ONCE per run, and the write carries the mapped state and the audit id
ok 2599 - 51 — settlement writes ONCE per run, and the write carries the mapped state and the audit id
  ---
  duration_ms: 3.061291
  type: 'test'
  ...
# Subtest: 15 — a retrieval_failure with a persisted audit settles persisted_complete, not partial
ok 2600 - 15 — a retrieval_failure with a persisted audit settles persisted_complete, not partial
  ---
  duration_ms: 0.167208
  type: 'test'
  ...
# Subtest: 33 — primary settles, normative fails: one settled, one failed, one failure row, nothing thrown
ok 2601 - 33 — primary settles, normative fails: one settled, one failed, one failure row, nothing thrown
  ---
  duration_ms: 2.916041
  type: 'test'
  ...
# Subtest: 33 — a role still at revision 0 is NOT linked: audit id null, and the state is not the outcome's
ok 2602 - 33 — a role still at revision 0 is NOT linked: audit id null, and the state is not the outcome's
  ---
  duration_ms: 6.140208
  type: 'test'
  ...
# Subtest: revision 0 with retrieval_terminal evidence settles telemetry_persistence_failed
ok 2603 - revision 0 with retrieval_terminal evidence settles telemetry_persistence_failed
  ---
  duration_ms: 0.271292
  type: 'test'
  ...
# Subtest: revision 0 with NO evidence settles aborted
ok 2604 - revision 0 with NO evidence settles aborted
  ---
  duration_ms: 0.138958
  type: 'test'
  ...
# Subtest: revision 0 KEEPS an outcome a never-retrieved run can honestly carry
ok 2605 - revision 0 KEEPS an outcome a never-retrieved run can honestly carry
  ---
  duration_ms: 0.366542
  type: 'test'
  ...
# Subtest: a REJECTED write is reported as rejected, never as settled, and leaves durable evidence
ok 2606 - a REJECTED write is reported as rejected, never as settled, and leaves durable evidence
  ---
  duration_ms: 0.883125
  type: 'test'
  ...
# Subtest: an identical-content retry stays SETTLED and burns no revision
ok 2607 - an identical-content retry stays SETTLED and burns no revision
  ---
  duration_ms: 0.137458
  type: 'test'
  ...
# Subtest: v9 §4.2 — settlement REFUSES a duplicate role and reports it, rather than settling it twice
ok 2608 - v9 §4.2 — settlement REFUSES a duplicate role and reports it, rather than settling it twice
  ---
  duration_ms: 0.12125
  type: 'test'
  ...
# Subtest: v9 §4.2 — `status` stays at D12's three values; the new class rides in `rejection`
ok 2609 - v9 §4.2 — `status` stays at D12's three values; the new class rides in `rejection`
  ---
  duration_ms: 0.09125
  type: 'test'
  ...
# Subtest: v9 §4.2 — the vocabulary has SIX classes, and the sixth needs no migration
ok 2610 - v9 §4.2 — the vocabulary has SIX classes, and the sixth needs no migration
  ---
  duration_ms: 0.451667
  type: 'test'
  ...
# Subtest: v9 §4.2 — a duplicate role at the TERMINAL WRITE throws, as an undeclared role already does
ok 2611 - v9 §4.2 — a duplicate role at the TERMINAL WRITE throws, as an undeclared role already does
  ---
  duration_ms: 0.606625
  type: 'test'
  ...
# Subtest: v9 §4.2 — a handle with one run per role is untouched by the guard
ok 2612 - v9 §4.2 — a handle with one run per role is untouched by the guard
  ---
  duration_ms: 0.208709
  type: 'test'
  ...
# Subtest: v9 §4.1 — the base outcome type excludes persisted_dirty, and the mappers cannot produce it
ok 2613 - v9 §4.1 — the base outcome type excludes persisted_dirty, and the mappers cannot produce it
  ---
  duration_ms: 0.100791
  type: 'test'
  ...
# Subtest: the runtime states and the state CHECK are the same list, in the same order
ok 2614 - the runtime states and the state CHECK are the same list, in the same order
  ---
  duration_ms: 3.207959
  type: 'test'
  ...
# Subtest: the outcome CHECK pins its two state lists the same way, and neither slice is empty
ok 2615 - the outcome CHECK pins its two state lists the same way, and neither slice is empty
  ---
  duration_ms: 0.730042
  type: 'test'
  ...
# Subtest: the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted
ok 2616 - the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted
  ---
  duration_ms: 0.217208
  type: 'test'
  ...
# Subtest: two states are non-terminal, and a window cannot close on either
ok 2617 - two states are non-terminal, and a window cannot close on either
  ---
  duration_ms: 0.281084
  type: 'test'
  ...
# Subtest: the migration still declares its retention, access and deletion controls (§4.2)
ok 2618 - the migration still declares its retention, access and deletion controls (§4.2)
  ---
  duration_ms: 0.890417
  type: 'test'
  ...
# Subtest: the HMAC is keyed, versioned, and unreproducible with an unkeyed hash
ok 2619 - the HMAC is keyed, versioned, and unreproducible with an unkeyed hash
  ---
  duration_ms: 7.010208
  type: 'test'
  ...
# Subtest: key version travels with the value, so a rotation is visible rather than inferred
ok 2620 - key version travels with the value, so a rotation is visible rather than inferred
  ---
  duration_ms: 1.61375
  type: 'test'
  ...
# Subtest: a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)
ok 2621 - a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)
  ---
  duration_ms: 0.777334
  type: 'test'
  ...
# Subtest: every served class increments its OWN counter, and a null increments none
ok 2622 - every served class increments its OWN counter, and a null increments none
  ---
  duration_ms: 0.403542
  type: 'test'
  ...
# Subtest: counters derive from the manifest, so row and payload cannot disagree
ok 2623 - counters derive from the manifest, so row and payload cannot disagree
  ---
  duration_ms: 0.372167
  type: 'test'
  ...
# Subtest: rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)
ok 2624 - rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)
  ---
  duration_ms: 0.073041
  type: 'test'
  ...
# Subtest: batch order is a property of candidate boundaries, never of completion order (constraint 7)
ok 2625 - batch order is a property of candidate boundaries, never of completion order (constraint 7)
  ---
  duration_ms: 0.328792
  type: 'test'
  ...
# Subtest: neither field-bearing manifest declaration has a field that could carry clinical text
ok 2626 - neither field-bearing manifest declaration has a field that could carry clinical text
  ---
  duration_ms: 0.518916
  type: 'test'
  ...
# Subtest: the ban loop really bans — it fails when a banned field is added
ok 2627 - the ban loop really bans — it fails when a banned field is added
  ---
  duration_ms: 0.13825
  type: 'test'
  ...
# Subtest: TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)
ok 2628 - TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)
  ---
  duration_ms: 0.295625
  type: 'test'
  ...
# Subtest: StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it
ok 2629 - StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it
  ---
  duration_ms: 1.149916
  type: 'test'
  ...
# Subtest: every route maps to a class, and an unknown caller is never assigned to the nearest match
ok 2630 - every route maps to a class, and an unknown caller is never assigned to the nearest match
  ---
  duration_ms: 0.072667
  type: 'test'
  ...
# Subtest: the reconciler is an INVOCATION route and never a retrieval route (D17)
ok 2631 - the reconciler is an INVOCATION route and never a retrieval route (D17)
  ---
  duration_ms: 0.039916
  type: 'test'
  ...
# Subtest: the five roles are closed, and the appropriateness exclusion is by ROUTE not by role
ok 2632 - the five roles are closed, and the appropriateness exclusion is by ROUTE not by role
  ---
  duration_ms: 0.043417
  type: 'test'
  ...
# Subtest: usage aggregates by served provider/model, not by intended
ok 2633 - usage aggregates by served provider/model, not by intended
  ---
  duration_ms: 7.944292
  type: 'test'
  ...
# Subtest: a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)
ok 2634 - a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)
  ---
  duration_ms: 0.088167
  type: 'test'
  ...
# Subtest: partial usage is summed without inventing the missing half
ok 2635 - partial usage is summed without inventing the missing half
  ---
  duration_ms: 0.061208
  type: 'test'
  ...
# Subtest: local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not
ok 2636 - local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not
  ---
  duration_ms: 0.157
  type: 'test'
  ...
# Subtest: this module prices nothing — money has ONE source of truth
ok 2637 - this module prices nothing — money has ONE source of truth
  ---
  duration_ms: 0.367625
  type: 'test'
  ...
# Subtest: the row contract and the manifest contract version independently (§4.3)
ok 2638 - the row contract and the manifest contract version independently (§4.3)
  ---
  duration_ms: 0.112084
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] settlement rejected: stale_revision primary expected 0, found 1
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] telemetry_write_failures increment failed: Error connecting to database: DownToo (stub)
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# Subtest: 19 — the predeclared run id is the one every later write targets, and no second row is inserted
ok 2639 - 19 — the predeclared run id is the one every later write targets, and no second row is inserted
  ---
  duration_ms: 6.029291
  type: 'test'
  ...
# Subtest: 20 — declare returns 0, the terminal write returns 1, and a stale handle is REJECTED
ok 2640 - 20 — declare returns 0, the terminal write returns 1, and a stale handle is REJECTED
  ---
  duration_ms: 2.425875
  type: 'test'
  ...
# Subtest: 20 — revisions advance PER ROLE: a normative write cannot invalidate the primary's handle
ok 2641 - 20 — revisions advance PER ROLE: a normative write cannot invalidate the primary's handle
  ---
  duration_ms: 1.385542
  type: 'test'
  ...
# Subtest: 20 — a terminal write that matches nothing is NOT retried, and does not advance the handle
ok 2642 - 20 — a terminal write that matches nothing is NOT retried, and does not advance the handle
  ---
  duration_ms: 3.024166
  type: 'test'
  ...
# Subtest: 31 — the reuse guard returns BEFORE any telemetry statement exists
ok 2643 - 31 — the reuse guard returns BEFORE any telemetry statement exists
  ---
  duration_ms: 0.712
  type: 'test'
  ...
# Subtest: 32 — the attached handle is absent from JSON.stringify, from the keys, and from a spread
ok 2644 - 32 — the attached handle is absent from JSON.stringify, from the keys, and from a spread
  ---
  duration_ms: 0.266167
  type: 'test'
  ...
# Subtest: 34 — terminal write fails, failure row fails: the invocation counter is the only evidence left
ok 2645 - 34 — terminal write fails, failure row fails: the invocation counter is the only evidence left
  ---
  duration_ms: 0.8485
  type: 'test'
  ...
# Subtest: 34 — and when the counter ALSO fails: a log line, nothing else, still no propagation
ok 2646 - 34 — and when the counter ALSO fails: a log line, nothing else, still no propagation
  ---
  duration_ms: 0.718542
  type: 'test'
  ...
# Subtest: 34 — NO MODULE-LEVEL COUNTER EXISTS ANYWHERE, asserted by source search
ok 2647 - 34 — NO MODULE-LEVEL COUNTER EXISTS ANYWHERE, asserted by source search
  ---
  duration_ms: 1.303417
  type: 'test'
  ...
# Subtest: 52 — every owner in the D9 matrix settles, including both scripts and both MCP paths
ok 2648 - 52 — every owner in the D9 matrix settles, including both scripts and both MCP paths
  ---
  duration_ms: 2.036458
  type: 'test'
  ...
# Subtest: 53 — the callback carries the audit id, and its failure never changes the save result
ok 2649 - 53 — the callback carries the audit id, and its failure never changes the save result
  ---
  duration_ms: 0.481666
  type: 'test'
  ...
# [retrieval-telemetry] terminal write rejected (revision or state moved) normative_channel — row state unknown
# Subtest: CANARY-GATE HAZARD — primary rejected, normative lands: the audit persisted and the Stage 0b primary-link gate fails
ok 2650 - CANARY-GATE HAZARD — primary rejected, normative lands: the audit persisted and the Stage 0b primary-link gate fails
  ---
  duration_ms: 15.174417
  type: 'test'
  ...
# Subtest: CANARY-GATE HAZARD — the mirror: primary lands, normative rejected
ok 2651 - CANARY-GATE HAZARD — the mirror: primary lands, normative rejected
  ---
  duration_ms: 2.191416
  type: 'test'
  ...
# Subtest: 54 — fourteen states, two of them non-terminal, and the two sets partition the whole
ok 2652 - 54 — fourteen states, two of them non-terminal, and the two sets partition the whole
  ---
  duration_ms: 0.472083
  type: 'test'
  ...
# Subtest: 54 — the implemented table IS D12's table, in both directions
ok 2653 - 54 — the implemented table IS D12's table, in both directions
  ---
  duration_ms: 0.3565
  type: 'test'
  ...
# Subtest: 54 — every one of the 196 ordered pairs answers the way D12 says
ok 2654 - 54 — every one of the 196 ordered pairs answers the way D12 says
  ---
  duration_ms: 0.183292
  type: 'test'
  ...
# Subtest: 54 — TERMINAL STATES NEVER TRANSITION, to anything, including themselves
ok 2655 - 54 — TERMINAL STATES NEVER TRANSITION, to anything, including themselves
  ---
  duration_ms: 0.092917
  type: 'test'
  ...
# Subtest: 54 — the two deliberate asymmetries are both present, and are not accidents
ok 2656 - 54 — the two deliberate asymmetries are both present, and are not accidents
  ---
  duration_ms: 0.091375
  type: 'test'
  ...
# Subtest: 54 — every settlement outcome lands on a state, and the settlement table names none of the three reconciler-mapped states
ok 2657 - 54 — every settlement outcome lands on a state, and the settlement table names none of the three reconciler-mapped states
  ---
  duration_ms: 0.083458
  type: 'test'
  ...
# Subtest: 54 — every reconciler-assigned state is a LEGAL transition from the state it is assigned from
ok 2658 - 54 — every reconciler-assigned state is a LEGAL transition from the state it is assigned from
  ---
  duration_ms: 0.106167
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: default path: filter clause array is byte-identical to production, no params
ok 2659 - default path: filter clause array is byte-identical to production, no params
  ---
  duration_ms: 0.784
  type: 'test'
  ...
# Subtest: default path with structural filters keeps the base guards and remaps $FP offsets per leg
ok 2660 - default path with structural filters keeps the base guards and remaps $FP offsets per leg
  ---
  duration_ms: 0.096291
  type: 'test'
  ...
# Subtest: relaxed path: both quarantine guards gain a bound OR arm on both legs
ok 2661 - relaxed path: both quarantine guards gain a bound OR arm on both legs
  ---
  duration_ms: 0.191125
  type: 'test'
  ...
# Subtest: relaxed path ordering: the quarantine label takes $FP_0, structural filters follow
ok 2662 - relaxed path ordering: the quarantine label takes $FP_0, structural filters follow
  ---
  duration_ms: 0.083625
  type: 'test'
  ...
# Subtest: hostile labels are slugged by labLabel and cannot widen the filter
ok 2663 - hostile labels are slugged by labLabel and cannot widen the filter
  ---
  duration_ms: 0.216
  type: 'test'
  ...
# Subtest: empty/whitespace includeQuarantined is treated as omitted (byte-identical default path)
ok 2664 - empty/whitespace includeQuarantined is treated as omitted (byte-identical default path)
  ---
  duration_ms: 0.100542
  type: 'test'
  ...
# Subtest: clampLabRetrieveTopK clamps to [1,20], default 8
ok 2665 - clampLabRetrieveTopK clamps to [1,20], default 8
  ---
  duration_ms: 0.061208
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: restrictSources omitted ⇒ default clauses + no params (byte-identical)
ok 2666 - restrictSources omitted ⇒ default clauses + no params (byte-identical)
  ---
  duration_ms: 0.786125
  type: 'test'
  ...
# Subtest: restrictSources: [choosing-wisely] ⇒ both legs source = ANY, bound array param
ok 2667 - restrictSources: [choosing-wisely] ⇒ both legs source = ANY, bound array param
  ---
  duration_ms: 0.372208
  type: 'test'
  ...
# Subtest: a named labq: source is admitted through the quarantine guard; un-named stays excluded
ok 2668 - a named labq: source is admitted through the quarantine guard; un-named stays excluded
  ---
  duration_ms: 0.310125
  type: 'test'
  ...
# Subtest: empty or all-blank restrictSources falls back to the default filter (no restriction)
ok 2669 - empty or all-blank restrictSources falls back to the default filter (no restriction)
  ---
  duration_ms: 0.183209
  type: 'test'
  ...
# Subtest: restrictSources stacks with book/chunk filters and supersedes the single-source filter
ok 2670 - restrictSources stacks with book/chunk filters and supersedes the single-source filter
  ---
  duration_ms: 0.072208
  type: 'test'
  ...
# Subtest: group key exactness: same (subject, signal_type) groups; different signal splits
ok 2671 - group key exactness: same (subject, signal_type) groups; different signal splits
  ---
  duration_ms: 0.64975
  type: 'test'
  ...
# Subtest: '' signal folds like stewardship (empty signal groups together)
ok 2672 - '' signal folds like stewardship (empty signal groups together)
  ---
  duration_ms: 0.086875
  type: 'test'
  ...
# Subtest: ≥2 threshold: a pair groups, a singleton does not
ok 2673 - ≥2 threshold: a pair groups, a singleton does not
  ---
  duration_ms: 0.348375
  type: 'test'
  ...
# Subtest: section order + group sort (size desc, newest tie-break) + singles in queue order
ok 2674 - section order + group sort (size desc, newest tie-break) + singles in queue order
  ---
  duration_ms: 0.295583
  type: 'test'
  ...
# Subtest: disagreement pinning: disagreements section leads the order, groups/singles below
ok 2675 - disagreement pinning: disagreements section leads the order, groups/singles below
  ---
  duration_ms: 0.134042
  type: 'test'
  ...
# Subtest: traversal: within-group → next group → singles; wrap; exhausted → null
ok 2676 - traversal: within-group → next group → singles; wrap; exhausted → null
  ---
  duration_ms: 0.109958
  type: 'test'
  ...
# Subtest: skip sinks within its section and traversal passes it over
ok 2677 - skip sinks within its section and traversal passes it over
  ---
  duration_ms: 0.146208
  type: 'test'
  ...
# Subtest: labeled stays in place (not sunk) with its status; k/n progress counts labeled+skipped
ok 2678 - labeled stays in place (not sunk) with its status; k/n progress counts labeled+skipped
  ---
  duration_ms: 0.069208
  type: 'test'
  ...
# Subtest: determinism: same input → identical output
ok 2679 - determinism: same input → identical output
  ---
  duration_ms: 0.205541
  type: 'test'
  ...
# Subtest: hashBucket is deterministic and in 0..99
ok 2680 - hashBucket is deterministic and in 0..99
  ---
  duration_ms: 0.937125
  type: 'test'
  ...
# Subtest: overlap is ~20% and buckets < 20
ok 2681 - overlap is ~20% and buckets < 20
  ---
  duration_ms: 0.519542
  type: 'test'
  ...
# Subtest: overlap findings are served to EVERY reviewer; partitioned to exactly one
ok 2682 - overlap findings are served to EVERY reviewer; partitioned to exactly one
  ---
  duration_ms: 0.462583
  type: 'test'
  ...
# Subtest: a reviewer not on the roster still gets the overlap set (only)
ok 2683 - a reviewer not on the roster still gets the overlap set (only)
  ---
  duration_ms: 0.873042
  type: 'test'
  ...
# Subtest: partition is roughly even across the roster
ok 2684 - partition is roughly even across the roster
  ---
  duration_ms: 0.435041
  type: 'test'
  ...
# Subtest: balanceBySignalType interleaves types and is newest-first within a type
ok 2685 - balanceBySignalType interleaves types and is newest-first within a type
  ---
  duration_ms: 0.994916
  type: 'test'
  ...
# Subtest: disagreement items come first, then fresh; limit respected
ok 2686 - disagreement items come first, then fresh; limit respected
  ---
  duration_ms: 0.810833
  type: 'test'
  ...
# Subtest: passthrough: optional uid + prescription_url survive buildReviewQueue onto emitted items
ok 2687 - passthrough: optional uid + prescription_url survive buildReviewQueue onto emitted items
  ---
  duration_ms: 0.209375
  type: 'test'
  ...
# Subtest: excludes labeled-by-this-reviewer, informational, unassigned, and filtered-out findings
ok 2688 - excludes labeled-by-this-reviewer, informational, unassigned, and filtered-out findings
  ---
  duration_ms: 0.923958
  type: 'test'
  ...
# Subtest: parseGoal: valid / missing / garbage → exact defaults; personal ceil
ok 2689 - parseGoal: valid / missing / garbage → exact defaults; personal ceil
  ---
  duration_ms: 0.707625
  type: 'test'
  ...
# Subtest: prevDay + istWeekStart (Monday-start)
ok 2690 - prevDay + istWeekStart (Monday-start)
  ---
  duration_ms: 0.899917
  type: 'test'
  ...
# Subtest: countedLabels: impact excluded, missed included, roster filter, finding current-state (later wins)
ok 2691 - countedLabels: impact excluded, missed included, roster filter, finding current-state (later wins)
  ---
  duration_ms: 0.191792
  type: 'test'
  ...
# Subtest: streak: threshold exactly 15, consecutive, yesterday-grace, today-only, gap → 0
ok 2692 - streak: threshold exactly 15, consecutive, yesterday-grace, today-only, gap → 0
  ---
  duration_ms: 0.230709
  type: 'test'
  ...
# Subtest: agreement: pair construction (2 & 3 reviewers), tier match/mismatch, overlap-only
ok 2693 - agreement: pair construction (2 & 3 reviewers), tier match/mismatch, overlap-only
  ---
  duration_ms: 0.209958
  type: 'test'
  ...
# Subtest: agreement: current-state dedup feeds pairs (later verdict wins), then match recomputed
ok 2694 - agreement: current-state dedup feeds pairs (later verdict wins), then match recomputed
  ---
  duration_ms: 0.1185
  type: 'test'
  ...
# Subtest: computeReviewStats: ≥20-pair display boundary, week total, badges shape
ok 2695 - computeReviewStats: ≥20-pair display boundary, week total, badges shape
  ---
  duration_ms: 0.421167
  type: 'test'
  ...
# Subtest: the committed gold artifact is frozen, ratified, and catalog-consistent
ok 2696 - the committed gold artifact is frozen, ratified, and catalog-consistent
  ---
  duration_ms: 2.346959
  type: 'test'
  ...
# Subtest: loadCheckGold rejects drift: wrong version, unratified, polarity/target mismatch
ok 2697 - loadCheckGold rejects drift: wrong version, unratified, polarity/target mismatch
  ---
  duration_ms: 7.477875
  type: 'test'
  ...
# Subtest: the committed 2.0 artifact is frozen, ratified, family-split, and catalog-consistent
ok 2698 - the committed 2.0 artifact is frozen, ratified, family-split, and catalog-consistent
  ---
  duration_ms: 1.904625
  type: 'test'
  ...
# Subtest: loadCheckGold2: accepts the delivered shape — empty targets legal, L carries annex/memberHistory
ok 2699 - loadCheckGold2: accepts the delivered shape — empty targets legal, L carries annex/memberHistory
  ---
  duration_ms: 0.698792
  type: 'test'
  ...
# Subtest: loadCheckGold2 rejects drift: version, status, dup ids, missing verdict fields, annex misuse
ok 2700 - loadCheckGold2 rejects drift: version, status, dup ids, missing verdict fields, annex misuse
  ---
  duration_ms: 1.30075
  type: 'test'
  ...
# Subtest: splitCheckGold2: P/N/C form the scored floor, L is the annex — never folded together
ok 2701 - splitCheckGold2: P/N/C form the scored floor, L is the annex — never folded together
  ---
  duration_ms: 0.981667
  type: 'test'
  ...
# Subtest: checkGold2CatalogGaps: unbound polarity-side targets are flagged, bound ones are not
ok 2702 - checkGold2CatalogGaps: unbound polarity-side targets are flagged, bound ones are not
  ---
  duration_ms: 0.425542
  type: 'test'
  ...
# Subtest: scoreCheckAgainstGold: per-target-rec, deterministic, ignores non-target firings
ok 2703 - scoreCheckAgainstGold: per-target-rec, deterministic, ignores non-target firings
  ---
  duration_ms: 0.493375
  type: 'test'
  ...
# Subtest: aggregateCheckGold: hand-computed recall / specificity / precision / F1
ok 2704 - aggregateCheckGold: hand-computed recall / specificity / precision / F1
  ---
  duration_ms: 1.10825
  type: 'test'
  ...
# Subtest: Fix A: ANALYZE_SYSTEM carries the verdict discipline (uncertain = equipoise only)
ok 2705 - Fix A: ANALYZE_SYSTEM carries the verdict discipline (uncertain = equipoise only)
  ---
  duration_ms: 0.988125
  type: 'test'
  ...
# Subtest: Fix A: normNetValue contract unchanged, but the parse fallback is now visible
ok 2706 - Fix A: normNetValue contract unchanged, but the parse fallback is now visible
  ---
  duration_ms: 0.379542
  type: 'test'
  ...
# Subtest: Fix B: the two syncope recs are in the seed, verified, unique, well-formed
ok 2707 - Fix B: the two syncope recs are in the seed, verified, unique, well-formed
  ---
  duration_ms: 0.261083
  type: 'test'
  ...
# Subtest: Fix B gold: deterministic recall hits C04 with BOTH new recs, and no other check case
ok 2708 - Fix B gold: deterministic recall hits C04 with BOTH new recs, and no other check case
  ---
  duration_ms: 1.25925
  type: 'test'
  ...
# Subtest: flag-off byte-identical: every grounded builder without the param equals Slice 1 exactly
ok 2709 - flag-off byte-identical: every grounded builder without the param equals Slice 1 exactly
  ---
  duration_ms: 1.175375
  type: 'test'
  ...
# Subtest: grounded: the picture lands between the input and the downstream sections, verbatim
ok 2710 - grounded: the picture lands between the input and the downstream sections, verbatim
  ---
  duration_ms: 0.407458
  type: 'test'
  ...
# Subtest: patientPictureBlock: formatClinicalState content + the two prompt rules
ok 2711 - patientPictureBlock: formatClinicalState content + the two prompt rules
  ---
  duration_ms: 1.435625
  type: 'test'
  ...
# Subtest: grounding flag is double-gated on the master flag
ok 2712 - grounding flag is double-gated on the master flag
  ---
  duration_ms: 0.109375
  type: 'test'
  ...
# Subtest: frozen bank right-care-eval/1.0: pinned, unique ids, per-mode shape
ok 2713 - frozen bank right-care-eval/1.0: pinned, unique ids, per-mode shape
  ---
  duration_ms: 0.861416
  type: 'test'
  ...
# Subtest: pair-judge parser: defensive on directions, safety classes, fences
ok 2714 - pair-judge parser: defensive on directions, safety classes, fences
  ---
  duration_ms: 0.29475
  type: 'test'
  ...
# Subtest: deterministic check diff: added / removed / kept by rec id
ok 2715 - deterministic check diff: added / removed / kept by rec id
  ---
  duration_ms: 0.245625
  type: 'test'
  ...
# Subtest: scorecard gates: FAIL_SAFETY dominates; PASS needs net improvement clearing noise
ok 2716 - scorecard gates: FAIL_SAFETY dominates; PASS needs net improvement clearing noise
  ---
  duration_ms: 1.248292
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: Order check constructs a ClinicalState from the provided input with counts > 0
ok 2717 - Order check constructs a ClinicalState from the provided input with counts > 0
  ---
  duration_ms: 3.950709
  type: 'test'
  ...
# Subtest: Care pathway constructs from the presentation field with counts > 0
ok 2718 - Care pathway constructs from the presentation field with counts > 0
  ---
  duration_ms: 0.46825
  type: 'test'
  ...
# Subtest: Record audit adapts the existing ExtractedCase and round-trips on the shared fields
ok 2719 - Record audit adapts the existing ExtractedCase and round-trips on the shared fields
  ---
  duration_ms: 0.833917
  type: 'test'
  ...
# Subtest: fail-open: a throwing LLM stage keeps the deterministic state; junk input never throws
ok 2720 - fail-open: a throwing LLM stage keeps the deterministic state; junk input never throws
  ---
  duration_ms: 0.402042
  type: 'test'
  ...
# Subtest: flag-off neutrality: no gate flag → feature inert; UI field off → {}
ok 2721 - flag-off neutrality: no gate flag → feature inert; UI field off → {}
  ---
  duration_ms: 0.5505
  type: 'test'
  ...
# Subtest: save-run reconstruction: same pure builders, schema-valid, per mode
ok 2722 - save-run reconstruction: same pure builders, schema-valid, per mode
  ---
  duration_ms: 0.690875
  type: 'test'
  ...
# Subtest: member link: strict validation, and identity stays OUT of the state
ok 2723 - member link: strict validation, and identity stays OUT of the state
  ---
  duration_ms: 0.209291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 1 — a PRIMARY defect leaves the NORMATIVE run clean
ok 2724 - 1 — a PRIMARY defect leaves the NORMATIVE run clean
  ---
  duration_ms: 1.788167
  type: 'test'
  ...
# Subtest: 2 — a NORMATIVE defect leaves the PRIMARY run clean
ok 2725 - 2 — a NORMATIVE defect leaves the PRIMARY run clean
  ---
  duration_ms: 0.302584
  type: 'test'
  ...
# Subtest: 3 — both roles dirty: both settle dirty
ok 2726 - 3 — both roles dirty: both settle dirty
  ---
  duration_ms: 4.722
  type: 'test'
  ...
# Subtest: 4 — neither dirty: both settle clean
ok 2727 - 4 — neither dirty: both settle clean
  ---
  duration_ms: 0.298917
  type: 'test'
  ...
# Subtest: 4b — an EMPTY array is clean; an ABSENT key on a linkable run is NOT
ok 2728 - 4b — an EMPTY array is clean; an ABSENT key on a linkable run is NOT
  ---
  duration_ms: 6.526583
  type: 'test'
  ...
# Subtest: 5 — no map at all: a single-role save behaves exactly as before
ok 2729 - 5 — no map at all: a single-role save behaves exactly as before
  ---
  duration_ms: 17.411
  type: 'test'
  ...
# Subtest: 5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial
ok 2730 - 5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial
  ---
  duration_ms: 0.236708
  type: 'test'
  ...
# Subtest: 5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that
ok 2731 - 5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that
  ---
  duration_ms: 0.534709
  type: 'test'
  ...
# Subtest: 6 — every persistence owner passes the role map, and none passes an empty one where it holds defects
ok 2732 - 6 — every persistence owner passes the role map, and none passes an empty one where it holds defects
  ---
  duration_ms: 1.246875
  type: 'test'
  ...
# Subtest: 6b — the upgrade is applied in settlement, not by the owners
ok 2733 - 6b — the upgrade is applied in settlement, not by the owners
  ---
  duration_ms: 0.908083
  type: 'test'
  ...
# Subtest: 6c — settleOwned still takes ONE base outcome and makes ONE settlement call
ok 2734 - 6c — settleOwned still takes ONE base outcome and makes ONE settlement call
  ---
  duration_ms: 0.199125
  type: 'test'
  ...
# Subtest: 6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing
ok 2735 - 6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing
  ---
  duration_ms: 0.057167
  type: 'test'
  ...
# Subtest: 7 — the three cases of `verdictForRun`, stated directly
ok 2736 - 7 — the three cases of `verdictForRun`, stated directly
  ---
  duration_ms: 0.3815
  type: 'test'
  ...
# Subtest: 7b — requirement 10: an INHERITED key is not a verdict
ok 2737 - 7b — requirement 10: an INHERITED key is not a verdict
  ---
  duration_ms: 0.161125
  type: 'test'
  ...
# Subtest: 7c — an inherited key does not rescue a run from partial, through settlement
ok 2738 - 7c — an inherited key does not rescue a run from partial, through settlement
  ---
  duration_ms: 0.147459
  type: 'test'
  ...
# Subtest: 7d — THE PLACEMENT TEST: the rule reaches a linkable run and stops at a revision-zero one
ok 2739 - 7d — THE PLACEMENT TEST: the rule reaches a linkable run and stops at a revision-zero one
  ---
  duration_ms: 0.23325
  type: 'test'
  ...
# Subtest: 7e — requirement 3 in the only place it is observable: settlement never mutates the map
ok 2740 - 7e — requirement 3 in the only place it is observable: settlement never mutates the map
  ---
  duration_ms: 0.134416
  type: 'test'
  ...
# Subtest: 7f — the base outcome still decides: only a CLEAN run is made partial by a missing key
ok 2741 - 7f — the base outcome still decides: only a CLEAN run is made partial by a missing key
  ---
  duration_ms: 0.044625
  type: 'test'
  ...
# Subtest: 7g — no new settlement outcome value was added, and nothing writes the synthetic code
ok 2742 - 7g — no new settlement outcome value was added, and nothing writes the synthetic code
  ---
  duration_ms: 0.3325
  type: 'test'
  ...
# Subtest: matchRoomCategory prefers the longest alias and falls back
ok 2743 - matchRoomCategory prefers the longest alias and falls back
  ---
  duration_ms: 0.5505
  type: 'test'
  ...
# Subtest: excessBedDays = LOS − benchmark, floored at 0
ok 2744 - excessBedDays = LOS − benchmark, floored at 0
  ---
  duration_ms: 0.081458
  type: 'test'
  ...
# Subtest: computeBedDayCost: 8-day single room over-stay = 7 × 6500 = 45,500 (est.)
ok 2745 - computeBedDayCost: 8-day single room over-stay = 7 × 6500 = 45,500 (est.)
  ---
  duration_ms: 16.854042
  type: 'test'
  ...
# Subtest: computeBedDayCost returns 0 when not flagged, day-care, or single-day
ok 2746 - computeBedDayCost returns 0 when not flagged, day-care, or single-day
  ---
  duration_ms: 0.106708
  type: 'test'
  ...
# Subtest: tariff-status table drops the (est.) label
ok 2747 - tariff-status table drops the (est.) label
  ---
  duration_ms: 0.177333
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the routes still declare the numbers this guard reads
ok 2748 - the routes still declare the numbers this guard reads
  ---
  duration_ms: 1.286916
  type: 'test'
  ...
# Subtest: the body extractor is not vacuous — it finds real code, not an empty default param
ok 2749 - the body extractor is not vacuous — it finds real code, not an empty default param
  ---
  duration_ms: 1.3485
  type: 'test'
  ...
# Subtest: IPD_ANALYZE_LEGS equals the analyze call sites in lib/doc-audit.ts — a FOURTH leg fails here
ok 2750 - IPD_ANALYZE_LEGS equals the analyze call sites in lib/doc-audit.ts — a FOURTH leg fails here
  ---
  duration_ms: 0.538125
  type: 'test'
  ...
# Subtest: OPD_AUDIT_LEGS equals the EXECUTABLE legs in auditOpdNote — a third fails here
ok 2751 - OPD_AUDIT_LEGS equals the EXECUTABLE legs in auditOpdNote — a third fails here
  ---
  duration_ms: 0.867542
  type: 'test'
  ...
# Subtest: THE IPD WORKER FITS ITS BOX, for every provider that can serve it
ok 2752 - THE IPD WORKER FITS ITS BOX, for every provider that can serve it
  ---
  duration_ms: 0.372417
  type: 'test'
  ...
# Subtest: ipd-audit-now fits the same box on the same basis (DEC-B5)
ok 2753 - ipd-audit-now fits the same box on the same basis (DEC-B5)
  ---
  duration_ms: 0.100583
  type: 'test'
  ...
# Subtest: THE OPD WORKER FITS ITS BOX, for every provider that can serve it
ok 2754 - THE OPD WORKER FITS ITS BOX, for every provider that can serve it
  ---
  duration_ms: 0.373375
  type: 'test'
  ...
# Subtest: the OPD call site sends a per-attempt ceiling that matches its budget (DEC-B9)
ok 2755 - the OPD call site sends a per-attempt ceiling that matches its budget (DEC-B9)
  ---
  duration_ms: 0.804375
  type: 'test'
  ...
# Subtest: raising max, lowering the box, or adding a retry FAILS the guard
ok 2756 - raising max, lowering the box, or adding a retry FAILS the guard
  ---
  duration_ms: 0.478875
  type: 'test'
  ...
# Subtest: a null budget means REFUSE, never substitute a default
ok 2757 - a null budget means REFUSE, never substitute a default
  ---
  duration_ms: 1.675416
  type: 'test'
  ...
# Subtest: the IPD cron interval clears the IPD box — and this is NOT extended to OPD
ok 2758 - the IPD cron interval clears the IPD box — and this is NOT extended to OPD
  ---
  duration_ms: 0.24625
  type: 'test'
  ...
# Subtest: OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_TRIES still read 110,000 and 3
ok 2759 - OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_TRIES still read 110,000 and 3
  ---
  duration_ms: 0.053958
  type: 'test'
  ...
# Subtest: check mode → Runs + Interventions + CW_Flags + Citations, normalized by run_id
ok 2760 - check mode → Runs + Interventions + CW_Flags + Citations, normalized by run_id
  ---
  duration_ms: 1.2015
  type: 'test'
  ...
# Subtest: pathway mode → PathwayStages merges skeleton+enrichment by id, ordered
ok 2761 - pathway mode → PathwayStages merges skeleton+enrichment by id, ordered
  ---
  duration_ms: 0.168084
  type: 'test'
  ...
# Subtest: audit mode → findings/completeness/diff/suggestions/idealised/extracted/citations
ok 2762 - audit mode → findings/completeness/diff/suggestions/idealised/extracted/citations
  ---
  duration_ms: 0.228208
  type: 'test'
  ...
# Subtest: mergeRunSheets stacks rows across runs by sheet name
ok 2763 - mergeRunSheets stacks rows across runs by sheet name
  ---
  duration_ms: 0.146875
  type: 'test'
  ...
# Subtest: THE INVARIANT: all-Standard weighting reproduces legacy completeness EXACTLY
ok 2764 - THE INVARIANT: all-Standard weighting reproduces legacy completeness EXACTLY
  ---
  duration_ms: 3.232916
  type: 'test'
  ...
# Subtest: THE INVARIANT holds for the null vector too (PRD §8.1 fallback = legacy behaviour)
ok 2765 - THE INVARIANT holds for the null vector too (PRD §8.1 fallback = legacy behaviour)
  ---
  duration_ms: 1.903167
  type: 'test'
  ...
# Subtest: THE INVARIANT holds at all-Minor as well (PRD §8.4: mathematically identical to all-Standard)
ok 2766 - THE INVARIANT holds at all-Minor as well (PRD §8.4: mathematically identical to all-Standard)
  ---
  duration_ms: 0.478875
  type: 'test'
  ...
# Subtest: the fixture set actually exercises the hard cases (guards against a vacuous invariant)
ok 2767 - the fixture set actually exercises the hard cases (guards against a vacuous invariant)
  ---
  duration_ms: 0.188958
  type: 'test'
  ...
# Subtest: the na-policy divergence is REAL and this build takes the legacy branch (flagged deviation)
ok 2768 - the na-policy divergence is REAL and this build takes the legacy branch (flagged deviation)
  ---
  duration_ms: 0.150959
  type: 'test'
  ...
# Subtest: a CONDITIONAL na leaves both sides under BOTH policies (mandatoryTotal 20 vs 21, PRD §2.9)
ok 2769 - a CONDITIONAL na leaves both sides under BOTH policies (mandatoryTotal 20 vs 21, PRD §2.9)
  ---
  duration_ms: 0.095208
  type: 'test'
  ...
# Subtest: tier points are exactly Critical 8 · Important 4 · Standard 2 · Minor 1, and none is zero
ok 2770 - tier points are exactly Critical 8 · Important 4 · Standard 2 · Minor 1, and none is zero
  ---
  duration_ms: 0.112542
  type: 'test'
  ...
# Subtest: normalised weights sum to 100.0 ± 0.05 for every combination (PRD §10)
ok 2771 - normalised weights sum to 100.0 ± 0.05 for every combination (PRD §10)
  ---
  duration_ms: 0.57925
  type: 'test'
  ...
# Subtest: weighting actually MOVES the score when tiers differ (the change is not a no-op)
ok 2772 - weighting actually MOVES the score when tiers differ (the change is not a no-op)
  ---
  duration_ms: 0.235
  type: 'test'
  ...
# Subtest: partial is exactly 0.5, and na is not partial
ok 2773 - partial is exactly 0.5, and na is not partial
  ---
  duration_ms: 0.313167
  type: 'test'
  ...
# Subtest: all-na document returns 100 without dividing by zero (PRD §8.5)
ok 2774 - all-na document returns 100 without dividing by zero (PRD §8.5)
  ---
  duration_ms: 0.060292
  type: 'test'
  ...
# Subtest: unknown key defaults to Standard; empty/garbage vector falls back to equal weights (PRD §8.2)
ok 2775 - unknown key defaults to Standard; empty/garbage vector falls back to equal weights (PRD §8.2)
  ---
  duration_ms: 0.069458
  type: 'test'
  ...
# Subtest: malformed input never throws and never produces a wrong-looking score
ok 2776 - malformed input never throws and never produces a wrong-looking score
  ---
  duration_ms: 0.116209
  type: 'test'
  ...
# Subtest: rounding is half-up, applied via legacy's DOUBLE round
ok 2777 - rounding is half-up, applied via legacy's DOUBLE round
  ---
  duration_ms: 0.068292
  type: 'test'
  ...
# Subtest: missingMandatory lists applicable missing fields by label (the unweighted gap count)
ok 2778 - missingMandatory lists applicable missing fields by label (the unweighted gap count)
  ---
  duration_ms: 0.040959
  type: 'test'
  ...
# Subtest: legacyCompleteness (the independent path) agrees with the null-vector weighted path
ok 2779 - legacyCompleteness (the independent path) agrees with the null-vector weighted path
  ---
  duration_ms: 0.248833
  type: 'test'
  ...
# Subtest: the re-stated domain weights match the closed cores VERBATIM (drift guard)
ok 2780 - the re-stated domain weights match the closed cores VERBATIM (drift guard)
  ---
  duration_ms: 0.192208
  type: 'test'
  ...
# Subtest: OPD index reproduces the core formula on a worked case
ok 2781 - OPD index reproduces the core formula on a worked case
  ---
  duration_ms: 0.09475
  type: 'test'
  ...
# Subtest: PDQI-9 absent ⇒ note_quality drops and the divisor is 0.75 (PRD §2.6)
ok 2782 - PDQI-9 absent ⇒ note_quality drops and the divisor is 0.75 (PRD §2.6)
  ---
  duration_ms: 0.048125
  type: 'test'
  ...
# Subtest: Care-Value Index reproduces the six-domain formula
ok 2783 - Care-Value Index reproduces the six-domain formula
  ---
  duration_ms: 0.052083
  type: 'test'
  ...
# Subtest: substituting a new documentation score moves the index and can re-band
ok 2784 - substituting a new documentation score moves the index and can re-band
  ---
  duration_ms: 0.050292
  type: 'test'
  ...
# Subtest: band boundaries at 39/40, 54/55, 69/70, 84/85
ok 2785 - band boundaries at 39/40, 54/55, 69/70, 84/85
  ---
  duration_ms: 0.044875
  type: 'test'
  ...
# Subtest: no domain scores at all ⇒ index 0, not NaN
ok 2786 - no domain scores at all ⇒ index 0, not NaN
  ---
  duration_ms: 0.035375
  type: 'test'
  ...
# Subtest: the weights-version label is exact (PRD §2.8, §8.3)
ok 2787 - the weights-version label is exact (PRD §2.8, §8.3)
  ---
  duration_ms: 0.048583
  type: 'test'
  ...
# Subtest: preview: an unchanged candidate moves nothing
ok 2788 - preview: an unchanged candidate moves nothing
  ---
  duration_ms: 0.357833
  type: 'test'
  ...
# Subtest: preview: making a widely-missing field Critical moves the mean and reports movers
ok 2789 - preview: making a widely-missing field Critical moves the mean and reports movers
  ---
  duration_ms: 7.331916
  type: 'test'
  ...
# Subtest: preview: empty cohort yields zeroed stats, no throw (the OPD empty state)
ok 2790 - preview: empty cohort yields zeroed stats, no throw (the OPD empty state)
  ---
  duration_ms: 0.204459
  type: 'test'
  ...
# Subtest: preview: SD is population SD and a single row has SD 0
ok 2791 - preview: SD is population SD and a single row has SD 0
  ---
  duration_ms: 0.180917
  type: 'test'
  ...
# Subtest: missingPrevalence excludes `na` from the base, and reports a percentage
ok 2792 - missingPrevalence excludes `na` from the base, and reports a percentage
  ---
  duration_ms: 2.245333
  type: 'test'
  ...
# Subtest: systemic-defect warning fires only above 50% missing AND only at Critical; it never blocks
ok 2793 - systemic-defect warning fires only above 50% missing AND only at Critical; it never blocks
  ---
  duration_ms: 0.17925
  type: 'test'
  ...
# Subtest: the systemic-defect copy is verbatim per PRD §5.3
ok 2794 - the systemic-defect copy is verbatim per PRD §5.3
  ---
  duration_ms: 0.055667
  type: 'test'
  ...
# Subtest: scoreRow routes IPD and OPD to different index formulas
ok 2795 - scoreRow routes IPD and OPD to different index formulas
  ---
  duration_ms: 0.099
  type: 'test'
  ...
# Subtest: the 21 discharge_summary fields match data/nabh-rubric.json EXACTLY (key, label, section)
ok 2796 - the 21 discharge_summary fields match data/nabh-rubric.json EXACTLY (key, label, section)
  ---
  duration_ms: 0.671625
  type: 'test'
  ...
# Subtest: cause_of_death is the ONE conditional key, read from the rubric
ok 2797 - cause_of_death is the ONE conditional key, read from the rubric
  ---
  duration_ms: 0.329458
  type: 'test'
  ...
# Subtest: the OPD label→key mapping covers every live-observed label (companion spec §4.7)
ok 2798 - the OPD label→key mapping covers every live-observed label (companion spec §4.7)
  ---
  duration_ms: 0.394459
  type: 'test'
  ...
# Subtest: the OPD engine's ACTUAL emitted keys are all in the catalogue (no orphan can appear)
ok 2799 - the OPD engine's ACTUAL emitted keys are all in the catalogue (no orphan can appear)
  ---
  duration_ms: 0.687583
  type: 'test'
  ...
# Subtest: the OPD structured emission is ADDITIVE: status/section added, present/mandatory preserved
ok 2800 - the OPD structured emission is ADDITIVE: status/section added, present/mandatory preserved
  ---
  duration_ms: 64.629459
  type: 'test'
  ...
# Subtest: the OPD engine emits the structured shape from BOTH completeness paths (GP and obstetric)
ok 2801 - the OPD engine emits the structured shape from BOTH completeness paths (GP and obstetric)
  ---
  duration_ms: 0.7795
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: A.1 THE FALLBACK RULE: a NULL completeness_items row keeps its stored scores, untouched
ok 2802 - A.1 THE FALLBACK RULE: a NULL completeness_items row keeps its stored scores, untouched
  ---
  duration_ms: 733.930833
  type: 'test'
  ...
# Subtest: A.1 a missing array is never read as 100 NOR as 0 — both directions
ok 2803 - A.1 a missing array is never read as 100 NOR as 0 — both directions
  ---
  duration_ms: 47.465875
  type: 'test'
  ...
# Subtest: A.1 a row WITH items is weighted, and weights_not_applicable flips to false
ok 2804 - A.1 a row WITH items is weighted, and weights_not_applicable flips to false
  ---
  duration_ms: 4.502791
  type: 'test'
  ...
# Subtest: A.1 continuity items are EXCLUDED from the OPD denominator (reproduces the engine's coverage)
ok 2805 - A.1 continuity items are EXCLUDED from the OPD denominator (reproduces the engine's coverage)
  ---
  duration_ms: 5.772334
  type: 'test'
  ...
# Subtest: A.1 applyOpdScoringPolicy never throws and handles an empty batch
ok 2806 - A.1 applyOpdScoringPolicy never throws and handles an empty batch
  ---
  duration_ms: 8.150666
  type: 'test'
  ...
# Subtest: A.1 parseOpdCompletenessItems drops malformed entries rather than throwing
ok 2807 - A.1 parseOpdCompletenessItems drops malformed entries rather than throwing
  ---
  duration_ms: 1.666166
  type: 'test'
  ...
# Subtest: A.1 the OPD write path persists the array, guarded by a column probe
ok 2808 - A.1 the OPD write path persists the array, guarded by a column probe
  ---
  duration_ms: 0.47525
  type: 'test'
  ...
# Subtest: A.1 the migration runner exists, is admin-guarded, and every statement is idempotent
ok 2809 - A.1 the migration runner exists, is admin-guarded, and every statement is idempotent
  ---
  duration_ms: 0.417791
  type: 'test'
  ...
# Subtest: A.1 the runner's inlined DDL matches the two .sql files it stands in for
ok 2810 - A.1 the runner's inlined DDL matches the two .sql files it stands in for
  ---
  duration_ms: 0.816417
  type: 'test'
  ...
# Subtest: A.1 no backfill: nothing in the build writes completeness_items to historical rows
ok 2811 - A.1 no backfill: nothing in the build writes completeness_items to historical rows
  ---
  duration_ms: 0.199292
  type: 'test'
  ...
# Subtest: the three continuity fields are EXCLUDED from the OPD weight vector (kickoff normative list)
ok 2812 - the three continuity fields are EXCLUDED from the OPD weight vector (kickoff normative list)
  ---
  duration_ms: 0.0685
  type: 'test'
  ...
# Subtest: the near-duplicate pairs are kept SEPARATE and flagged, not merged
ok 2813 - the near-duplicate pairs are kept SEPARATE and flagged, not merged
  ---
  duration_ms: 0.070042
  type: 'test'
  ...
# Subtest: labelToOpdKey: dynamic obstetric labels match by prefix; unknown returns null (never guesses)
ok 2814 - labelToOpdKey: dynamic obstetric labels match by prefix; unknown returns null (never guesses)
  ---
  duration_ms: 0.226375
  type: 'test'
  ...
# Subtest: every catalogued OPD label round-trips through the mapping
ok 2815 - every catalogued OPD label round-trips through the mapping
  ---
  duration_ms: 0.052584
  type: 'test'
  ...
# Subtest: fieldsFor / weightedKeysFor route by note type and never return an empty key space
ok 2816 - fieldsFor / weightedKeysFor route by note type and never return an empty key space
  ---
  duration_ms: 0.036458
  type: 'test'
  ...
# Subtest: diffVectors reports only real changes, with old → new tiers
ok 2817 - diffVectors reports only real changes, with old → new tiers
  ---
  duration_ms: 0.186542
  type: 'test'
  ...
# Subtest: vectorsEqual treats absent as Standard (so a seeded v1 equals an empty draft)
ok 2818 - vectorsEqual treats absent as Standard (so a seeded v1 equals an empty draft)
  ---
  duration_ms: 0.051791
  type: 'test'
  ...
# Subtest: validateVector rejects non-objects but coerces unknown tiers rather than failing
ok 2819 - validateVector rejects non-objects but coerces unknown tiers rather than failing
  ---
  duration_ms: 0.113125
  type: 'test'
  ...
# Subtest: canonicalVectorJson is stable regardless of key insertion order
ok 2820 - canonicalVectorJson is stable regardless of key insertion order
  ---
  duration_ms: 0.055209
  type: 'test'
  ...
# Subtest: bySection groups and preserves first-seen order
ok 2821 - bySection groups and preserves first-seen order
  ---
  duration_ms: 0.086541
  type: 'test'
  ...
# Subtest: computeSignalHealth: FP rate, latest-per-doctor, top reasons, healable
ok 2822 - computeSignalHealth: FP rate, latest-per-doctor, top reasons, healable
  ---
  duration_ms: 1.191
  type: 'test'
  ...
# Subtest: computeSignalHealth: ranks noisiest (audit_bug × rate) first
ok 2823 - computeSignalHealth: ranks noisiest (audit_bug × rate) first
  ---
  duration_ms: 0.181833
  type: 'test'
  ...
# Subtest: findingMatchesSuppression: type/scope/discriminator/active gates
ok 2824 - findingMatchesSuppression: type/scope/discriminator/active gates
  ---
  duration_ms: 0.109458
  type: 'test'
  ...
# Subtest: applySuppressions: drop removes, downgrade sets informational, no active = no-op
ok 2825 - applySuppressions: drop removes, downgrade sets informational, no active = no-op
  ---
  duration_ms: 0.193208
  type: 'test'
  ...
# Subtest: previewCollateral: dual-label invariant — refuses to remove a validated signal
ok 2826 - previewCollateral: dual-label invariant — refuses to remove a validated signal
  ---
  duration_ms: 0.104167
  type: 'test'
  ...
# Subtest: every ratified tier-2 kind maps to tier 2, not unlisted
ok 2827 - every ratified tier-2 kind maps to tier 2, not unlisted
  ---
  duration_ms: 1.288167
  type: 'test'
  ...
# Subtest: every ratified tier-3 kind maps to tier 3 — log only
ok 2828 - every ratified tier-3 kind maps to tier 3 — log only
  ---
  duration_ms: 0.140916
  type: 'test'
  ...
# Subtest: banned_fdc is ratified TIER 2 (not higher) and pregnancy_risk_verify is ratified TIER 3
ok 2829 - banned_fdc is ratified TIER 2 (not higher) and pregnancy_risk_verify is ratified TIER 3
  ---
  duration_ms: 0.053458
  type: 'test'
  ...
# Subtest: O1c: a model-invented kind lands in tier 2 and is flagged unlisted
ok 2830 - O1c: a model-invented kind lands in tier 2 and is flagged unlisted
  ---
  duration_ms: 0.057125
  type: 'test'
  ...
# Subtest: praise: *_high_value kinds and any high-value verdict (antibiotic_stewardship praise) are excluded and counted
ok 2831 - praise: *_high_value kinds and any high-value verdict (antibiotic_stewardship praise) are excluded and counted
  ---
  duration_ms: 0.052583
  type: 'test'
  ...
# Subtest: antibiotic_stewardship VIOLATION (low-value — antibiotic for a viral URTI) is tier 2
ok 2832 - antibiotic_stewardship VIOLATION (low-value — antibiotic for a viral URTI) is tier 2
  ---
  duration_ms: 0.041917
  type: 'test'
  ...
# Subtest: incomplete_dosing: missing strength / duration alone → tier 3 (ratified rows: findings 20, 24, 37, 41 + chronic continuation)
ok 2833 - incomplete_dosing: missing strength / duration alone → tier 3 (ratified rows: findings 20, 24, 37, 41 + chronic continuation)
  ---
  duration_ms: 0.392875
  type: 'test'
  ...
# Subtest: incomplete_dosing: a missing frequency or route changes what the patient does → tier 2; unparseable → tier 2
ok 2834 - incomplete_dosing: a missing frequency or route changes what the patient does → tier 2; unparseable → tier 2
  ---
  duration_ms: 0.070167
  type: 'test'
  ...
# Subtest: E-1 (finding 36): a time-critical cardiac pattern in the finding text promotes to tier 1 — from any kind
ok 2835 - E-1 (finding 36): a time-critical cardiac pattern in the finding text promotes to tier 1 — from any kind
  ---
  duration_ms: 0.205459
  type: 'test'
  ...
# Subtest: E-2 (finding 49): persistent swelling ≥ 4 weeks with no follow-through promotes; with follow-through it does not
ok 2836 - E-2 (finding 49): persistent swelling ≥ 4 weeks with no follow-through promotes; with follow-through it does not
  ---
  duration_ms: 3.987667
  type: 'test'
  ...
# Subtest: praise never escalates: a high-value finding praising an appropriate ACS referral stays praise
ok 2837 - praise never escalates: a high-value finding praising an appropriate ACS referral stays praise
  ---
  duration_ms: 0.102958
  type: 'test'
  ...
# Subtest: bucketByTier: buckets are disjoint, complete, and count unlisted kinds
ok 2838 - bucketByTier: buckets are disjoint, complete, and count unlisted kinds
  ---
  duration_ms: 0.102833
  type: 'test'
  ...
# Subtest: dedupeTwins: same (finding_ref, doctor_uid, day) collapses with an occurrence count; different notes same day still collapse; different days do not
ok 2839 - dedupeTwins: same (finding_ref, doctor_uid, day) collapses with an occurrence count; different notes same day still collapse; different days do not
  ---
  duration_ms: 0.398417
  type: 'test'
  ...
# Subtest: dedupeTwins: unkeyable rows (no ref / no doctor / no date) never merge
ok 2840 - dedupeTwins: unkeyable rows (no ref / no doctor / no date) never merge
  ---
  duration_ms: 0.041125
  type: 'test'
  ...
# Subtest: allows SELECT / WITH and auto-adds LIMIT
ok 2841 - allows SELECT / WITH and auto-adds LIMIT
  ---
  duration_ms: 1.254625
  type: 'test'
  ...
# Subtest: rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns
ok 2842 - rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns
  ---
  duration_ms: 0.100542
  type: 'test'
  ...
# Subtest: blocks PHI-bearing relations anywhere in the query
ok 2843 - blocks PHI-bearing relations anywhere in the query
  ---
  duration_ms: 0.113166
  type: 'test'
  ...
# Subtest: honors a smaller caller cap
ok 2844 - honors a smaller caller cap
  ---
  duration_ms: 0.060583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: coverage floor (PRD §4): ≥5 dose-ceiling, ≥3 SOS, ≥3 banned-FDC, ≥4 interaction, ≥4 incomplete-dosing positives; exactly 6 negatives
ok 2845 - coverage floor (PRD §4): ≥5 dose-ceiling, ≥3 SOS, ≥3 banned-FDC, ≥4 interaction, ≥4 incomplete-dosing positives; exactly 6 negatives
  ---
  duration_ms: 0.683291
  type: 'test'
  ...
# Subtest: fixtures carry no PHI, no db13 uid, and banned-FDC fixtures use placeholder molecules only
ok 2846 - fixtures carry no PHI, no db13 uid, and banned-FDC fixtures use placeholder molecules only
  ---
  duration_ms: 0.215791
  type: 'test'
  ...
# Subtest: positive POS-DOSE-1 fires dose_ceiling_exceeded — paracetamol stacked across two products: 650 QID + 500 TDS = 4100 mg/day > 4000
ok 2847 - positive POS-DOSE-1 fires dose_ceiling_exceeded — paracetamol stacked across two products: 650 QID + 500 TDS = 4100 mg/day > 4000
  ---
  duration_ms: 0.047917
  type: 'test'
  ...
# Subtest: positive POS-DOSE-2 fires dose_ceiling_exceeded — ibuprofen 800 QID = 3200 mg/day > 2400 (single product)
ok 2848 - positive POS-DOSE-2 fires dose_ceiling_exceeded — ibuprofen 800 QID = 3200 mg/day > 2400 (single product)
  ---
  duration_ms: 0.032792
  type: 'test'
  ...
# Subtest: positive POS-DOSE-3 fires dose_ceiling_exceeded — diclofenac 75 TDS = 225 mg/day > 150
ok 2849 - positive POS-DOSE-3 fires dose_ceiling_exceeded — diclofenac 75 TDS = 225 mg/day > 150
  ---
  duration_ms: 0.035792
  type: 'test'
  ...
# Subtest: positive POS-DOSE-4 fires dose_ceiling_exceeded — etoricoxib 120 OD with NO documented gout > the 90 mg/day default ceiling (Decision 6)
ok 2850 - positive POS-DOSE-4 fires dose_ceiling_exceeded — etoricoxib 120 OD with NO documented gout > the 90 mg/day default ceiling (Decision 6)
  ---
  duration_ms: 0.031666
  type: 'test'
  ...
# Subtest: positive POS-DOSE-5 fires dose_ceiling_exceeded — mefenamic acid 500 QID = 2000 mg/day > 1500
ok 2851 - positive POS-DOSE-5 fires dose_ceiling_exceeded — mefenamic acid 500 QID = 2000 mg/day > 1500
  ---
  duration_ms: 0.081792
  type: 'test'
  ...
# Subtest: positive POS-SOS-1 fires dose_ceiling_sos — paracetamol 1000 TDS scheduled + 650 SOS uncapped (default cap 3) → 4950 potential > 4000
ok 2852 - positive POS-SOS-1 fires dose_ceiling_sos — paracetamol 1000 TDS scheduled + 650 SOS uncapped (default cap 3) → 4950 potential > 4000
  ---
  duration_ms: 0.033208
  type: 'test'
  ...
# Subtest: positive POS-SOS-2 fires dose_ceiling_sos — etoricoxib 90 SOS with an EXPLICIT max 2/day → 180 potential > 90
ok 2853 - positive POS-SOS-2 fires dose_ceiling_sos — etoricoxib 90 SOS with an EXPLICIT max 2/day → 180 potential > 90
  ---
  duration_ms: 0.170708
  type: 'test'
  ...
# Subtest: positive POS-SOS-3 fires dose_ceiling_sos — ibuprofen 600 grid 1-0-1 + 600 SOS uncapped → 3000 potential > 2400
ok 2854 - positive POS-SOS-3 fires dose_ceiling_sos — ibuprofen 600 grid 1-0-1 + 600 SOS uncapped → 3000 potential > 2400
  ---
  duration_ms: 0.272666
  type: 'test'
  ...
# Subtest: positive POS-FDC-1 fires banned_fdc — exact two-molecule banned set (placeholders mol-a + mol-b)
ok 2855 - positive POS-FDC-1 fires banned_fdc — exact two-molecule banned set (placeholders mol-a + mol-b)
  ---
  duration_ms: 0.035875
  type: 'test'
  ...
# Subtest: positive POS-FDC-2 fires banned_fdc — exact three-molecule banned set (placeholders mol-c/mol-d/mol-e)
ok 2856 - positive POS-FDC-2 fires banned_fdc — exact three-molecule banned set (placeholders mol-c/mol-d/mol-e)
  ---
  duration_ms: 0.033042
  type: 'test'
  ...
# Subtest: positive POS-FDC-3 fires banned_fdc — order-swapped banned pair (mol-b + mol-a) still matches the stored set
ok 2857 - positive POS-FDC-3 fires banned_fdc — order-swapped banned pair (mol-b + mol-a) still matches the stored set
  ---
  duration_ms: 0.023209
  type: 'test'
  ...
# Subtest: positive POS-DDI-1 fires drug_interaction — warfarin + ibuprofen — anticoagulant + NSAID (major)
ok 2858 - positive POS-DDI-1 fires drug_interaction — warfarin + ibuprofen — anticoagulant + NSAID (major)
  ---
  duration_ms: 0.022375
  type: 'test'
  ...
# Subtest: positive POS-DDI-2 fires drug_interaction — atorvastatin + clarithromycin — statin + macrolide (major)
ok 2859 - positive POS-DDI-2 fires drug_interaction — atorvastatin + clarithromycin — statin + macrolide (major)
  ---
  duration_ms: 0.021875
  type: 'test'
  ...
# Subtest: positive POS-DDI-3 fires drug_interaction — sertraline + tramadol — two serotonergic drugs (major)
ok 2860 - positive POS-DDI-3 fires drug_interaction — sertraline + tramadol — two serotonergic drugs (major)
  ---
  duration_ms: 0.041625
  type: 'test'
  ...
# Subtest: positive POS-DDI-4 fires drug_interaction — telmisartan + spironolactone — ACE-I/ARB + potassium-sparing diuretic (major)
ok 2861 - positive POS-DDI-4 fires drug_interaction — telmisartan + spironolactone — ACE-I/ARB + potassium-sparing diuretic (major)
  ---
  duration_ms: 0.027458
  type: 'test'
  ...
# Subtest: positive POS-DOSING-1 fires incomplete_dosing — dose/strength blanked (no dose field, no strength, none in the name)
ok 2862 - positive POS-DOSING-1 fires incomplete_dosing — dose/strength blanked (no dose field, no strength, none in the name)
  ---
  duration_ms: 0.024625
  type: 'test'
  ...
# Subtest: positive POS-DOSING-2 fires incomplete_dosing — frequency blanked
ok 2863 - positive POS-DOSING-2 fires incomplete_dosing — frequency blanked
  ---
  duration_ms: 0.023291
  type: 'test'
  ...
# Subtest: positive POS-DOSING-3 fires incomplete_dosing — duration blanked
ok 2864 - positive POS-DOSING-3 fires incomplete_dosing — duration blanked
  ---
  duration_ms: 0.024666
  type: 'test'
  ...
# Subtest: positive POS-DOSING-4 fires incomplete_dosing — route blanked and not inferable (no dosage-form word anywhere on the line)
ok 2865 - positive POS-DOSING-4 fires incomplete_dosing — route blanked and not inferable (no dosage-form word anywhere on the line)
  ---
  duration_ms: 0.020458
  type: 'test'
  ...
# Subtest: negative NEG-1 stays silent — ibuprofen 800 TDS = exactly 2400 mg/day — AT the ceiling, not over it
ok 2866 - negative NEG-1 stays silent — ibuprofen 800 TDS = exactly 2400 mg/day — AT the ceiling, not over it
  ---
  duration_ms: 0.040541
  type: 'test'
  ...
# Subtest: negative NEG-2 stays silent — etoricoxib 120 OD WITH a documented gout diagnosis — the conditional 120 ceiling applies
ok 2867 - negative NEG-2 stays silent — etoricoxib 120 OD WITH a documented gout diagnosis — the conditional 120 ceiling applies
  ---
  duration_ms: 0.022709
  type: 'test'
  ...
# Subtest: negative NEG-3 stays silent — amoxicillin + paracetamol — just OUTSIDE every interaction pair (no shared mechanism tag)
ok 2868 - negative NEG-3 stays silent — amoxicillin + paracetamol — just OUTSIDE every interaction pair (no shared mechanism tag)
  ---
  duration_ms: 0.024125
  type: 'test'
  ...
# Subtest: negative NEG-4 stays silent — a COMPLETE prescription — dose, frequency, duration and route all present
ok 2869 - negative NEG-4 stays silent — a COMPLETE prescription — dose, frequency, duration and route all present
  ---
  duration_ms: 0.025375
  type: 'test'
  ...
# Subtest: negative NEG-5 stays silent — banned core + one extra molecule (mol-a + mol-b + mol-z) — the C5 superset boundary
ok 2870 - negative NEG-5 stays silent — banned core + one extra molecule (mol-a + mol-b + mol-z) — the C5 superset boundary
  ---
  duration_ms: 0.023333
  type: 'test'
  ...
# Subtest: negative NEG-6 stays silent — paracetamol 500 SOS max 3/day = 1500 mg potential — well inside the 4000 ceiling
ok 2871 - negative NEG-6 stays silent — paracetamol 500 SOS max 3/day = 1500 mg potential — well inside the 4000 ceiling
  ---
  duration_ms: 0.021666
  type: 'test'
  ...
# Subtest: recall_det = fired / planted, over the deterministic leg only (no LLM recall claim — PRD §6)
ok 2872 - recall_det = fired / planted, over the deterministic leg only (no LLM recall claim — PRD §6)
  ---
  duration_ms: 0.033375
  type: 'test'
  ...
# Subtest: 57 case 1 — production Vercel build with no key at all: MISSING
ok 2873 - 57 case 1 — production Vercel build with no key at all: MISSING
  ---
  duration_ms: 1.154833
  type: 'test'
  ...
# Subtest: 57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING
ok 2874 - 57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING
  ---
  duration_ms: 0.161625
  type: 'test'
  ...
# Subtest: 57 case 3 — production Vercel build with a usable key: NOT missing
ok 2875 - 57 case 3 — production Vercel build with a usable key: NOT missing
  ---
  duration_ms: 0.1135
  type: 'test'
  ...
# Subtest: 57 case 4 — a Vercel build that is not production: NOT missing, at any key value
ok 2876 - 57 case 4 — a Vercel build that is not production: NOT missing, at any key value
  ---
  duration_ms: 0.273916
  type: 'test'
  ...
# Subtest: 57 case 5 — not a Vercel build, even when the environment says production: NOT missing
ok 2877 - 57 case 5 — not a Vercel build, even when the environment says production: NOT missing
  ---
  duration_ms: 0.142583
  type: 'test'
  ...
# Subtest: 57 EXECUTED — importing the config in production with no key throws, and names the variable
ok 2878 - 57 EXECUTED — importing the config in production with no key throws, and names the variable
  ---
  duration_ms: 38.73425
  type: 'test'
  ...
# Subtest: 57 EXECUTED — a production import WITH a key succeeds
ok 2879 - 57 EXECUTED — a production import WITH a key succeeds
  ---
  duration_ms: 36.553875
  type: 'test'
  ...
# Subtest: 57 EXECUTED — a non-production import with no key succeeds
ok 2880 - 57 EXECUTED — a non-production import with no key succeeds
  ---
  duration_ms: 33.301042
  type: 'test'
  ...
# Subtest: 57 whole file — it parses, and holds EXACTLY three top-level statements in order
ok 2881 - 57 whole file — it parses, and holds EXACTLY three top-level statements in order
  ---
  duration_ms: 14.009291
  type: 'test'
  ...
# Subtest: 57 whole file — the declaration and the export are exactly what they must be
ok 2882 - 57 whole file — the declaration and the export are exactly what they must be
  ---
  duration_ms: 0.491709
  type: 'test'
  ...
# Subtest: 57 whole file — nothing executable outside the guard
ok 2883 - 57 whole file — nothing executable outside the guard
  ---
  duration_ms: 0.146084
  type: 'test'
  ...
# Subtest: 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
ok 2884 - 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
  ---
  duration_ms: 0.439708
  type: 'test'
  ...
# Subtest: 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
ok 2885 - 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
  ---
  duration_ms: 0.190375
  type: 'test'
  ...
# Subtest: 57 pin — the guard THROWS one Error, and the message a reader sees names the variable
ok 2886 - 57 pin — the guard THROWS one Error, and the message a reader sees names the variable
  ---
  duration_ms: 0.130125
  type: 'test'
  ...
# Subtest: no surface outside the allow-list SELECTs from the telemetry tables
ok 2887 - no surface outside the allow-list SELECTs from the telemetry tables
  ---
  duration_ms: 137.346917
  type: 'test'
  ...
# Subtest: the scan can actually fail — it is not passing because the matcher never matches
ok 2888 - the scan can actually fail — it is not passing because the matcher never matches
  ---
  duration_ms: 0.17075
  type: 'test'
  ...
# Subtest: the allow-list is by EXACT path, and every entry is one this build owns
ok 2889 - the allow-list is by EXACT path, and every entry is one this build owns
  ---
  duration_ms: 0.193542
  type: 'test'
  ...
# Subtest: no clinician-facing or patient-facing route names a telemetry table at all
ok 2890 - no clinician-facing or patient-facing route names a telemetry table at all
  ---
  duration_ms: 31.408209
  type: 'test'
  ...
# Subtest: GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted
ok 2891 - GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted
  ---
  duration_ms: 295.758666
  type: 'test'
  ...
# Subtest: GUARD 3 — preview: VERCEL_ENV=production is refused even with everything else correct
ok 2892 - GUARD 3 — preview: VERCEL_ENV=production is refused even with everything else correct
  ---
  duration_ms: 283.485709
  type: 'test'
  ...
# Subtest: GUARD 3 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused
ok 2893 - GUARD 3 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused
  ---
  duration_ms: 272.261917
  type: 'test'
  ...
# Subtest: GUARD 4 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused
ok 2894 - GUARD 4 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused
  ---
  duration_ms: 246.95525
  type: 'test'
  ...
# Subtest: GUARD 5 — THE ONE THAT MATTERS: a production endpoint id is refused
ok 2895 - GUARD 5 — THE ONE THAT MATTERS: a production endpoint id is refused
  ---
  duration_ms: 185.601666
  type: 'test'
  ...
# Subtest: GUARD 5 — an UNSET expectation refuses, it does not pass
ok 2896 - GUARD 5 — an UNSET expectation refuses, it does not pass
  ---
  duration_ms: 150.248083
  type: 'test'
  ...
# Subtest: GUARD 5 — an unparseable DATABASE_URL refuses
ok 2897 - GUARD 5 — an unparseable DATABASE_URL refuses
  ---
  duration_ms: 148.875
  type: 'test'
  ...
# Subtest: GUARD 5 — a password containing @ cannot shift the parsed host
ok 2898 - GUARD 5 — a password containing @ cannot shift the parsed host
  ---
  duration_ms: 152.343167
  type: 'test'
  ...
# Subtest: GUARD 2 — expiry: past the hard UTC date every request is 410
ok 2899 - GUARD 2 — expiry: past the hard UTC date every request is 410
  ---
  duration_ms: 149.343292
  type: 'test'
  ...
# Subtest: GUARD 2 — before the expiry the route still runs
ok 2900 - GUARD 2 — before the expiry the route still runs
  ---
  duration_ms: 154.788792
  type: 'test'
  ...
# Subtest: ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately
ok 2901 - ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately
  ---
  duration_ms: 151.908416
  type: 'test'
  ...
# Subtest: FIX 2 + FIX 1 — a REAL 500, driven by an unparseable URL that still satisfies guard 5
ok 2902 - FIX 2 + FIX 1 — a REAL 500, driven by an unparseable URL that still satisfies guard 5
  ---
  duration_ms: 149.561125
  type: 'test'
  ...
# Subtest: v5 FIX 1 — two of the three leaking shapes are refused BEFORE the driver ever sees them
ok 2903 - v5 FIX 1 — two of the three leaking shapes are refused BEFORE the driver ever sees them
  ---
  duration_ms: 312.38325
  type: 'test'
  ...
# Subtest: FIX 3 — a query parameter cannot move the parsed host away from the one the driver uses
ok 2904 - FIX 3 — a query parameter cannot move the parsed host away from the one the driver uses
  ---
  duration_ms: 146.389209
  type: 'test'
  ...
# Subtest: FIX 4 — the denylist refuses production even when the expected value also names it
ok 2905 - FIX 4 — the denylist refuses production even when the expected value also names it
  ---
  duration_ms: 158.809709
  type: 'test'
  ...
# Subtest: FIX 4 — an ABSENT denylist refuses: a denylist that is not there is not a denylist
ok 2906 - FIX 4 — an ABSENT denylist refuses: a denylist that is not there is not a denylist
  ---
  duration_ms: 149.403416
  type: 'test'
  ...
# Subtest: FIX 5 — p95 and p99 are withheld below their floors, never a maximum in disguise
ok 2907 - FIX 5 — p95 and p99 are withheld below their floors, never a maximum in disguise
  ---
  duration_ms: 308.241125
  type: 'test'
  ...
# Subtest: FIX 5 — and p95 IS emitted once its floor is met, so the floor is not a blanket refusal
ok 2908 - FIX 5 — and p95 IS emitted once its floor is met, so the floor is not a blanket refusal
  ---
  duration_ms: 153.089875
  type: 'test'
  ...
# Subtest: FIX 6 — the invocation insert has its own cell
ok 2909 - FIX 6 — the invocation insert has its own cell
  ---
  duration_ms: 303.17625
  type: 'test'
  ...
# Subtest: FIX 7 — the shape is true per cell, and conc is gone
ok 2910 - FIX 7 — the shape is true per cell, and conc is gone
  ---
  duration_ms: 298.05175
  type: 'test'
  ...
# Subtest: FIX 8 — the real-audit arm refuses rather than silently becoming the null arm
ok 2911 - FIX 8 — the real-audit arm refuses rather than silently becoming the null arm
  ---
  duration_ms: 450.821125
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch POOLED host passes against the bare expected id
ok 2912 - v6 FIX 1 — the branch POOLED host passes against the bare expected id
  ---
  duration_ms: 150.087541
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch DIRECT host passes against the bare expected id
ok 2913 - v6 FIX 1 — the branch DIRECT host passes against the bare expected id
  ---
  duration_ms: 155.787542
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch POOLED host passes against a POOLED expected id
ok 2914 - v6 FIX 1 — the branch POOLED host passes against a POOLED expected id
  ---
  duration_ms: 148.130375
  type: 'test'
  ...
# Subtest: v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch
ok 2915 - v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch
  ---
  duration_ms: 146.082333
  type: 'test'
  ...
# Subtest: v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint
ok 2916 - v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint
  ---
  duration_ms: 149.028292
  type: 'test'
  ...
# Subtest: v6 — `pooler` in the MIDDLE of a label is part of the id and is never truncated
ok 2917 - v6 — `pooler` in the MIDDLE of a label is part of the id and is never truncated
  ---
  duration_ms: 294.370208
  type: 'test'
  ...
# Subtest: v6 — a doubled `-pooler-pooler` strips exactly ONE, and that is the stated rule
ok 2918 - v6 — a doubled `-pooler-pooler` strips exactly ONE, and that is the stated rule
  ---
  duration_ms: 456.609958
  type: 'test'
  ...
# Subtest: v6 — normalisation cannot make two DIFFERENT endpoints compare equal
ok 2919 - v6 — normalisation cannot make two DIFFERENT endpoints compare equal
  ---
  duration_ms: 584.836833
  type: 'test'
  ...
# Subtest: NO OUTPUT ANYWHERE CARRIES A DATABASE_URL SUBSTRING — every response shape, stdout and stderr
ok 2920 - NO OUTPUT ANYWHERE CARRIES A DATABASE_URL SUBSTRING — every response shape, stdout and stderr
  ---
  duration_ms: 1735.759334
  type: 'test'
  ...
# Subtest: the route is POST-only, and carries its own expiry and deletion notice in source
ok 2921 - the route is POST-only, and carries its own expiry and deletion notice in source
  ---
  duration_ms: 0.212042
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: DEFAULT-OFF: unset ⇒ no cap (the shipped path is uncapped and must stay so)
ok 2922 - DEFAULT-OFF: unset ⇒ no cap (the shipped path is uncapped and must stay so)
  ---
  duration_ms: 1.064083
  type: 'test'
  ...
# Subtest: DEFAULT-OFF: 0, negative, junk and empty all mean "no cap", never a cap of 0
ok 2923 - DEFAULT-OFF: 0, negative, junk and empty all mean "no cap", never a cap of 0
  ---
  duration_ms: 0.2815
  type: 'test'
  ...
# Subtest: a set budget is honored, floored to an integer (the arms: 1647 / 823 / 128)
ok 2924 - a set budget is honored, floored to an integer (the arms: 1647 / 823 / 128)
  ---
  duration_ms: 0.381875
  type: 'test'
  ...
# Subtest: the cap rides the SL0-verified wire format (top-level google.thinking_config)
ok 2925 - the cap rides the SL0-verified wire format (top-level google.thinking_config)
  ---
  duration_ms: 2.353166
  type: 'test'
  ...
# Subtest: the cap is Gemini-only and cannot leak onto the Ollama fallback path
ok 2926 - the cap is Gemini-only and cannot leak onto the Ollama fallback path
  ---
  duration_ms: 0.257625
  type: 'test'
  ...
# Subtest: gen_params records the budget ONLY when capped — an uncapped trace is unchanged
ok 2927 - gen_params records the budget ONLY when capped — an uncapped trace is unchanged
  ---
  duration_ms: 0.161291
  type: 'test'
  ...
# Subtest: note-audit row → ClinicalFinding: verbatim vocab in the audit ext, valid core
ok 2928 - note-audit row → ClinicalFinding: verbatim vocab in the audit ext, valid core
  ---
  duration_ms: 1.614958
  type: 'test'
  ...
# Subtest: LOSSLESS: note-audit row round-trips byte-for-byte, incl. unmapped engine fields
ok 2929 - LOSSLESS: note-audit row round-trips byte-for-byte, incl. unmapped engine fields
  ---
  duration_ms: 0.461333
  type: 'test'
  ...
# Subtest: note-audit round-trip preserves absence: a minimal row gains no keys
ok 2930 - note-audit round-trip preserves absence: a minimal row gains no keys
  ---
  duration_ms: 0.115834
  type: 'test'
  ...
# Subtest: deterministic-source row maps to extractionMethod deterministic
ok 2931 - deterministic-source row maps to extractionMethod deterministic
  ---
  duration_ms: 0.056291
  type: 'test'
  ...
# Subtest: doc-audit AuditFinding → ClinicalFinding: verdict rides in ext.netValue (verbatim, separate slot)
ok 2932 - doc-audit AuditFinding → ClinicalFinding: verdict rides in ext.netValue (verbatim, separate slot)
  ---
  duration_ms: 0.401167
  type: 'test'
  ...
# Subtest: LOSSLESS: doc-audit AuditFinding round-trips byte-for-byte
ok 2933 - LOSSLESS: doc-audit AuditFinding round-trips byte-for-byte
  ---
  duration_ms: 0.143542
  type: 'test'
  ...
# Subtest: ExtractedCase → ClinicalState: clinical content in the core, metadata in surfaceExtras
ok 2934 - ExtractedCase → ClinicalState: clinical content in the core, metadata in surfaceExtras
  ---
  duration_ms: 0.609458
  type: 'test'
  ...
# Subtest: LOSSLESS: ExtractedCase round-trips byte-for-byte (full PX discharge shape)
ok 2935 - LOSSLESS: ExtractedCase round-trips byte-for-byte (full PX discharge shape)
  ---
  duration_ms: 0.135125
  type: 'test'
  ...
# Subtest: LOSSLESS: a sparse pre-PX ExtractedCase (no riskFactors/aftercare/completeness) round-trips
ok 2936 - LOSSLESS: a sparse pre-PX ExtractedCase (no riskFactors/aftercare/completeness) round-trips
  ---
  duration_ms: 0.283667
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the traceless route stays traceless — no trace id reaches the rerank transport
ok 2937 - the traceless route stays traceless — no trace id reaches the rerank transport
  ---
  duration_ms: 0.992792
  type: 'test'
  ...
# Subtest: nothing in the change touches the outbound request object
ok 2938 - nothing in the change touches the outbound request object
  ---
  duration_ms: 0.270542
  type: 'test'
  ...
# Subtest: attachment is non-enumerable, so a serialized request or response is byte-identical
ok 2939 - attachment is non-enumerable, so a serialized request or response is byte-identical
  ---
  duration_ms: 0.407042
  type: 'test'
  ...
# Subtest: attachment returns the SAME object — it allocates nothing the caller could miss
ok 2940 - attachment returns the SAME object — it allocates nothing the caller could miss
  ---
  duration_ms: 0.052
  type: 'test'
  ...
# Subtest: the ladder, its order and its terminal dispositions are untouched
ok 2941 - the ladder, its order and its terminal dispositions are untouched
  ---
  duration_ms: 0.210916
  type: 'test'
  ...
# Subtest: retry policy is unchanged — capture rides the existing callback and adds no try budget
ok 2942 - retry policy is unchanged — capture rides the existing callback and adds no try budget
  ---
  duration_ms: 0.376417
  type: 'test'
  ...
# Subtest: every one of the four return sites carries evidence — no silent unattributed path
ok 2943 - every one of the four return sites carries evidence — no silent unattributed path
  ---
  duration_ms: 0.279
  type: 'test'
  ...
# Subtest: the local substitution reports the LOCAL model, never the requested cloud model (§6.2)
ok 2944 - the local substitution reports the LOCAL model, never the requested cloud model (§6.2)
  ---
  duration_ms: 0.214417
  type: 'test'
  ...
# Subtest: every name still resolves at its original path, so no existing importer moves
ok 2945 - every name still resolves at its original path, so no existing importer moves
  ---
  duration_ms: 0.346416
  type: 'test'
  ...
# Subtest: the attempts field is OPTIONAL, so tracedChat attributions stay valid unchanged
ok 2946 - the attempts field is OPTIONAL, so tracedChat attributions stay valid unchanged
  ---
  duration_ms: 0.466583
  type: 'test'
  ...
# Subtest: a hostile completion cannot break the transport
ok 2947 - a hostile completion cannot break the transport
  ---
  duration_ms: 0.112291
  type: 'test'
  ...
# Subtest: a 429 is distinguishable from every other failure class
ok 2948 - a 429 is distinguishable from every other failure class
  ---
  duration_ms: 0.049583
  type: 'test'
  ...
# Subtest: both tiers classify through the same function — a 429 cannot be tier-dependent
ok 2949 - both tiers classify through the same function — a 429 cannot be tier-dependent
  ---
  duration_ms: 0.182875
  type: 'test'
  ...
# Subtest: the attempt sequence is invocation-scoped, never module state (§4.1)
ok 2950 - the attempt sequence is invocation-scoped, never module state (§4.1)
  ---
  duration_ms: 0.780083
  type: 'test'
  ...
# Subtest: the evidence carries identifiers and enums only — no prompt, passage or query text
ok 2951 - the evidence carries identifiers and enums only — no prompt, passage or query text
  ---
  duration_ms: 0.923959
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a total transport failure records no served provider, and says so explicitly
ok 2952 - a total transport failure records no served provider, and says so explicitly
  ---
  duration_ms: 0.579667
  type: 'test'
  ...
# Subtest: a null attempt list means NOT COLLECTED, and is distinguishable from an empty one
ok 2953 - a null attempt list means NOT COLLECTED, and is distinguishable from an empty one
  ---
  duration_ms: 0.716125
  type: 'test'
  ...
# Subtest: every terminal phase is a stable NAME — never a message, never an interpolated value
ok 2954 - every terminal phase is a stable NAME — never a message, never an interpolated value
  ---
  duration_ms: 0.9725
  type: 'test'
  ...
# Subtest: the intended-local path records ONE attempt rather than an empty list
ok 2955 - the intended-local path records ONE attempt rather than an empty list
  ---
  duration_ms: 0.408875
  type: 'test'
  ...
# Subtest: both local arms record their attempt — the by-design one and the substitution
ok 2956 - both local arms record their attempt — the by-design one and the substitution
  ---
  duration_ms: 0.234917
  type: 'test'
  ...
# Subtest: the local success attempt is well-formed, and is at most one per invocation
ok 2957 - the local success attempt is well-formed, and is at most one per invocation
  ---
  duration_ms: 0.254959
  type: 'test'
  ...
# Subtest: classifyLocalAttempt reads what the SDK declared, and guesses nothing
ok 2958 - classifyLocalAttempt reads what the SDK declared, and guesses nothing
  ---
  duration_ms: 0.247041
  type: 'test'
  ...
# Subtest: the 429 rule has exactly one home — classifyLocalAttempt delegates, never duplicates
ok 2959 - the 429 rule has exactly one home — classifyLocalAttempt delegates, never duplicates
  ---
  duration_ms: 0.591375
  type: 'test'
  ...
# Subtest: the two terminal throws are BYTE-IDENTICAL to before this build
ok 2960 - the two terminal throws are BYTE-IDENTICAL to before this build
  ---
  duration_ms: 0.39525
  type: 'test'
  ...
# Subtest: the phase selector cannot drift from the throws it describes
ok 2961 - the phase selector cannot drift from the throws it describes
  ---
  duration_ms: 1.218542
  type: 'test'
  ...
# Subtest: the failure attach is a statement, not a control-flow change
ok 2962 - the failure attach is a statement, not a control-flow change
  ---
  duration_ms: 0.615541
  type: 'test'
  ...
# Subtest: nothing in the failure path touches the outbound request object
ok 2963 - nothing in the failure path touches the outbound request object
  ---
  duration_ms: 0.54875
  type: 'test'
  ...
# Subtest: the local calls are wrapped, and the SDK call expression itself is unchanged
ok 2964 - the local calls are wrapped, and the SDK call expression itself is unchanged
  ---
  duration_ms: 0.431791
  type: 'test'
  ...
# Subtest: failure evidence is a SEPARATE property, invisible to every success-attribution reader
ok 2965 - failure evidence is a SEPARATE property, invisible to every success-attribution reader
  ---
  duration_ms: 0.2235
  type: 'test'
  ...
# Subtest: the low-value-care judge reader is untouched — it reads two fields of the success shape
ok 2966 - the low-value-care judge reader is untouched — it reads two fields of the success shape
  ---
  duration_ms: 0.412083
  type: 'test'
  ...
# Subtest: tracedChat is not touched — D14 is scoped to the traceless arm
ok 2967 - tracedChat is not touched — D14 is scoped to the traceless arm
  ---
  duration_ms: 0.641125
  type: 'test'
  ...
# Subtest: every new name also resolves through lib/trace.ts, so no importer has to know the core path
ok 2968 - every new name also resolves through lib/trace.ts, so no importer has to know the core path
  ---
  duration_ms: 0.126125
  type: 'test'
  ...
# Subtest: failure evidence is IMMUTABLE — a later frame cannot rewrite what failed
ok 2969 - failure evidence is IMMUTABLE — a later frame cannot rewrite what failed
  ---
  duration_ms: 0.222792
  type: 'test'
  ...
# Subtest: a hostile or exotic error cannot break the transport
ok 2970 - a hostile or exotic error cannot break the transport
  ---
  duration_ms: 0.267
  type: 'test'
  ...
# Subtest: failure evidence carries enums and counts only — no message, no body, no identifier
ok 2971 - failure evidence carries enums and counts only — no message, no body, no identifier
  ---
  duration_ms: 0.224291
  type: 'test'
  ...
# Subtest: the attempt shape admits the local provider, and nothing else new
ok 2972 - the attempt shape admits the local provider, and nothing else new
  ---
  duration_ms: 0.469958
  type: 'test'
  ...
# Subtest: a finish_reason defect is NOT retryable; an empty 200 still is
ok 2973 - a finish_reason defect is NOT retryable; an empty 200 still is
  ---
  duration_ms: 0.647792
  type: 'test'
  ...
# Subtest: THE 54 SECONDS: a truncating call is attempted ONCE, not three times
ok 2974 - THE 54 SECONDS: a truncating call is attempted ONCE, not three times
  ---
  duration_ms: 0.465
  type: 'test'
  ...
# Subtest: …and the empty-200 retry budget is spent in full, exactly as before
ok 2975 - …and the empty-200 retry budget is spent in full, exactly as before
  ---
  duration_ms: 0.308375
  type: 'test'
  ...
# Subtest: the terminal error still names the truncation, so the sizing bug is readable
ok 2976 - the terminal error still names the truncation, so the sizing bug is readable
  ---
  duration_ms: 0.119416
  type: 'test'
  ...
# Subtest: transport failures are untouched by this rule — only BODY verdicts changed
ok 2977 - transport failures are untouched by this rule — only BODY verdicts changed
  ---
  duration_ms: 0.394666
  type: 'test'
  ...
# Subtest: the mini-sized cap is raised to a FLOOR on the bedrock path
ok 2978 - the mini-sized cap is raised to a FLOOR on the bedrock path
  ---
  duration_ms: 0.199333
  type: 'test'
  ...
# Subtest: ⚠️ BYTE-IDENTITY: the floor is the BEDROCK transport’s, and reaches no other provider
ok 2979 - ⚠️ BYTE-IDENTITY: the floor is the BEDROCK transport’s, and reaches no other provider
  ---
  duration_ms: 1.054791
  type: 'test'
  ...
# Subtest: a critique that never completed is recorded as UNAUDITED, not as clean
ok 2980 - a critique that never completed is recorded as UNAUDITED, not as clean
  ---
  duration_ms: 0.305375
  type: 'test'
  ...
# Subtest: the probe reducers carry critic_ran, so a lab row can tell the two apart
ok 2981 - the probe reducers carry critic_ran, so a lab row can tell the two apart
  ---
  duration_ms: 0.4905
  type: 'test'
  ...
# Subtest: unknown_finding + missing_critical + instability_input derive from a ClinicalState
ok 2982 - unknown_finding + missing_critical + instability_input derive from a ClinicalState
  ---
  duration_ms: 10.662958
  type: 'test'
  ...
# Subtest: med_contradiction derives from an open medication conflict (member stateRef)
ok 2983 - med_contradiction derives from an open medication conflict (member stateRef)
  ---
  duration_ms: 0.603959
  type: 'test'
  ...
# Subtest: med_contradiction: conflict on an episode HIGH-ALERT med is safety-critical
ok 2984 - med_contradiction: conflict on an episode HIGH-ALERT med is safety-critical
  ---
  duration_ms: 0.771791
  type: 'test'
  ...
# Subtest: med_contradiction also derives from reconciled status stopped/not_taking/unknown without a conflict row
ok 2985 - med_contradiction also derives from reconciled status stopped/not_taking/unknown without a conflict row
  ---
  duration_ms: 0.574875
  type: 'test'
  ...
# Subtest: new_medication (B5): derives ONLY for meds absent from a NON-EMPTY snapshot med list
ok 2986 - new_medication (B5): derives ONLY for meds absent from a NON-EMPTY snapshot med list
  ---
  duration_ms: 0.635125
  type: 'test'
  ...
# Subtest: new_medication (B5): a high-alert episode med is skipped (it wins rank 0 anyway)
ok 2987 - new_medication (B5): a high-alert episode med is skipped (it wins rank 0 anyway)
  ---
  duration_ms: 0.760292
  type: 'test'
  ...
# Subtest: care_gap derives from a stale mapped-range abnormal (detail verbatim, severity mapped)
ok 2988 - care_gap derives from a stale mapped-range abnormal (detail verbatim, severity mapped)
  ---
  duration_ms: 1.115458
  type: 'test'
  ...
# Subtest: followup_open derives from advice keywords; suppressed when a committed follow-up matches
ok 2989 - followup_open derives from advice keywords; suppressed when a committed follow-up matches
  ---
  duration_ms: 0.657417
  type: 'test'
  ...
# Subtest: allergy_unconfirmed only when the note allergy field is blank
ok 2990 - allergy_unconfirmed only when the note allergy field is blank
  ---
  duration_ms: 0.524542
  type: 'test'
  ...
# Subtest: snapshot absent ⇒ member-derived kinds simply absent (episode-only degradation, D14)
ok 2991 - snapshot absent ⇒ member-derived kinds simply absent (episode-only degradation, D14)
  ---
  duration_ms: 4.143792
  type: 'test'
  ...
# Subtest: determinism: identical inputs ⇒ deep-equal output (double run)
ok 2992 - determinism: identical inputs ⇒ deep-equal output (double run)
  ---
  duration_ms: 0.482083
  type: 'test'
  ...
# Subtest: every UnknownItem carries ≥1 sourceRef and a stateRef
ok 2993 - every UnknownItem carries ≥1 sourceRef and a stateRef
  ---
  duration_ms: 0.245167
  type: 'test'
  ...
# Subtest: stable ordering: safety before review before info, then kind, then subject
ok 2994 - stable ordering: safety before review before info, then kind, then subject
  ---
  duration_ms: 0.237542
  type: 'test'
  ...
# Subtest: bandFor thresholds
ok 2995 - bandFor thresholds
  ---
  duration_ms: 0.419541
  type: 'test'
  ...
# Subtest: findingPenalty scales with verdict severity and confidence
ok 2996 - findingPenalty scales with verdict severity and confidence
  ---
  duration_ms: 0.091792
  type: 'test'
  ...
# Subtest: a clean, complete episode scores high (band A)
ok 2997 - a clean, complete episode scores high (band A)
  ---
  duration_ms: 0.27825
  type: 'test'
  ...
# Subtest: domains route by tag; cost driven by low-value tariff spend; untagged → appropriateness
ok 2998 - domains route by tag; cost driven by low-value tariff spend; untagged → appropriateness
  ---
  duration_ms: 13.449166
  type: 'test'
  ...
# Subtest: estimated bed-day cost dents the cost domain even with no tariffed spend
ok 2999 - estimated bed-day cost dents the cost domain even with no tariffed spend
  ---
  duration_ms: 0.250708
  type: 'test'
  ...
# Subtest: weights are configurable and normalised
ok 3000 - weights are configurable and normalised
  ---
  duration_ms: 0.091083
  type: 'test'
  ...
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: cloudLadder: Vertex first, OpenRouter second — and GEMINI_VIA_OPENROUTER=1 inverts it
ok 3001 - cloudLadder: Vertex first, OpenRouter second — and GEMINI_VIA_OPENROUTER=1 inverts it
  ---
  duration_ms: 103.9495
  type: 'test'
  ...
# Subtest: cloudLadder: a second tier exists ONLY with a leg budget, and only when it can serve
ok 3002 - cloudLadder: a second tier exists ONLY with a leg budget, and only when it can serve
  ---
  duration_ms: 0.200208
  type: 'test'
  ...
# Subtest: the tier-2 slug derivation is the same google/ prefixing, flag or no flag
ok 3003 - the tier-2 slug derivation is the same google/ prefixing, flag or no flag
  ---
  duration_ms: 0.077458
  type: 'test'
  ...
# Subtest: the flag itself is NOT touched by this unit — one code read, no default, no write
ok 3004 - the flag itself is NOT touched by this unit — one code read, no default, no write
  ---
  duration_ms: 0.256375
  type: 'test'
  ...
# Subtest: tierCeilingMs: tier 1 gets the full budget, tier 2 the remainder, a spent leg gets 0
ok 3005 - tierCeilingMs: tier 1 gets the full budget, tier 2 the remainder, a spent leg gets 0
  ---
  duration_ms: 0.089208
  type: 'test'
  ...
# Subtest: a leg never exceeds its budget across both tiers — the naive sum would blow the box
ok 3006 - a leg never exceeds its budget across both tiers — the naive sum would blow the box
  ---
  duration_ms: 0.046916
  type: 'test'
  ...
# Subtest: ladderSkipError names the skipped tier and carries the earlier failure, capped
ok 3007 - ladderSkipError names the skipped tier and carries the earlier failure, capped
  ---
  duration_ms: 0.1455
  type: 'test'
  ...
# Subtest: both transports run the SAME ladder mechanics — no second budget idiom
ok 3008 - both transports run the SAME ladder mechanics — no second budget idiom
  ---
  duration_ms: 0.174833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [provider-fallback] gemini gemini-2.5-pro failed → ollama: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: F1: Vertex tier fails → the OpenRouter tier serves the SAME leg (the hop is real)
ok 3009 - F1: Vertex tier fails → the OpenRouter tier serves the SAME leg (the hop is real)
  ---
  duration_ms: 38.363208
  type: 'test'
  ...
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: F2: with NO leg budget there is NO second tier — the utility path is byte-identical
ok 3010 - F2: with NO leg budget there is NO second tier — the utility path is byte-identical
  ---
  duration_ms: 6.572042
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → none: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"none","intended_model":"google/gemini-2.5-pro","fallback_model":null,"region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: F3: noLocalFallback=true → both tiers failing THROWS; Ollama is not called
ok 3011 - F3: noLocalFallback=true → both tiers failing THROWS; Ollama is not called
  ---
  duration_ms: 12.917292
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → ollama: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"google/gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# Subtest: F4: noLocalFallback absent → both tiers failing still falls back to Ollama (today's behaviour)
ok 3012 - F4: noLocalFallback absent → both tiers failing still falls back to Ollama (today's behaviour)
  ---
  duration_ms: 9.503333
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/3 http 500 — retrying: 500 "boom"
# [provider-retry] openrouter google/gemini-2.5-pro attempt 2/3 http 500 — retrying: 500 "boom"
# [provider-retry] openrouter google/gemini-2.5-pro attempt 3/3 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → ollama: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"google/gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# Subtest: F5: GEMINI_VIA_OPENROUTER=1 makes OpenRouter tier 1 — the inversion is live, not just typed
ok 3013 - F5: GEMINI_VIA_OPENROUTER=1 makes OpenRouter tier 1 — the inversion is live, not just typed
  ---
  duration_ms: 1945.727167
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 timeout — giving up: Request was aborted.
# [provider-fallback] openrouter google/gemini-2.5-pro failed → gemini: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"gemini","intended_model":"google/gemini-2.5-pro","fallback_model":null,"region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":null,"error_status":null,"error_code":null,"message":"openrouter TIMEOUT after 299ms (attempt 1/1)","details":null}
# Subtest: F6: a tier that burns the whole leg budget SKIPS the next tier by name
ok 3014 - F6: a tier that burns the whole leg budget SKIPS the next tier by name
  ---
  duration_ms: 302.073083
  type: 'test'
  ...
# Subtest: the OPD audit call site sets it — and the mini path passes FALSE
ok 3015 - the OPD audit call site sets it — and the mini path passes FALSE
  ---
  duration_ms: 0.334792
  type: 'test'
  ...
# Subtest: the IPD analyze closure sets it via analyzeNoLocalFallback — one flag, all six legs
ok 3016 - the IPD analyze closure sets it via analyzeNoLocalFallback — one flag, all six legs
  ---
  duration_ms: 0.183583
  type: 'test'
  ...
# Subtest: verifyCitation — the cite gate — does NOT get the flag, and keeps its soft-fail
ok 3017 - verifyCitation — the cite gate — does NOT get the flag, and keeps its soft-fail
  ---
  duration_ms: 0.055916
  type: 'test'
  ...
# Subtest: no third call site: the flag appears in doc-audit only on the analyze closure plumbing
ok 3018 - no third call site: the flag appears in doc-audit only on the analyze closure plumbing
  ---
  duration_ms: 0.153542
  type: 'test'
  ...
# Subtest: the throw reaches auditOpdNote's outer catch, which marks the row — nothing changed there
ok 3019 - the throw reaches auditOpdNote's outer catch, which marks the row — nothing changed there
  ---
  duration_ms: 0.23475
  type: 'test'
  ...
# Subtest: the DDL is additive + idempotent and matches the kickoff exactly
ok 3020 - the DDL is additive + idempotent and matches the kickoff exactly
  ---
  duration_ms: 0.069791
  type: 'test'
  ...
# Subtest: the writer is best-effort and truncates at 2000 — a ledger failure never fails an audit
ok 3021 - the writer is best-effort and truncates at 2000 — a ledger failure never fails an audit
  ---
  duration_ms: 4.054042
  type: 'test'
  ...
# Subtest: runIpdAudit writes the ledger at every no-row outcome, and the write precedes each return
ok 3022 - runIpdAudit writes the ledger at every no-row outcome, and the write precedes each return
  ---
  duration_ms: 0.107083
  type: 'test'
  ...
# Subtest: the ledger did NOT touch the machinery the kickoff fences off
ok 3023 - the ledger did NOT touch the machinery the kickoff fences off
  ---
  duration_ms: 0.046875
  type: 'test'
  ...
# Subtest: audit_query can read the ledger WITHOUT lib/sql-guard-core.ts changing
ok 3024 - audit_query can read the ledger WITHOUT lib/sql-guard-core.ts changing
  ---
  duration_ms: 0.613458
  type: 'test'
  ...
# Subtest: provider reaches the terminal error, the marked error, and every failure report
ok 3025 - provider reaches the terminal error, the marked error, and every failure report
  ---
  duration_ms: 8.029458
  type: 'test'
  ...
# Subtest: the marked empty-200 error names the provider that produced it
ok 3026 - the marked empty-200 error names the provider that produced it
  ---
  duration_ms: 0.319708
  type: 'test'
  ...
# Subtest: DEFAULT provider is openrouter — every pre-Unit-V call site is byte-identical
ok 3027 - DEFAULT provider is openrouter — every pre-Unit-V call site is byte-identical
  ---
  duration_ms: 5.982958
  type: 'test'
  ...
# Subtest: a caller classifier REPLACES the OpenAI-shaped default
ok 3028 - a caller classifier REPLACES the OpenAI-shaped default
  ---
  duration_ms: 0.832292
  type: 'test'
  ...
# Subtest: classify: () => null opts out of body judgement entirely
ok 3029 - classify: () => null opts out of body judgement entirely
  ---
  duration_ms: 0.230542
  type: 'test'
  ...
# Subtest: the default IS classifyProviderResponse — no call site loses validation by omission
ok 3030 - the default IS classifyProviderResponse — no call site loses validation by omission
  ---
  duration_ms: 0.292042
  type: 'test'
  ...
# Subtest: defaultTimeoutMs / defaultMaxTries apply when the CALLER passes nothing
ok 3031 - defaultTimeoutMs / defaultMaxTries apply when the CALLER passes nothing
  ---
  duration_ms: 0.898333
  type: 'test'
  ...
# Subtest: the CALLER still wins over the per-call default
ok 3032 - the CALLER still wins over the per-call default
  ---
  duration_ms: 0.205917
  type: 'test'
  ...
# Subtest: a junk DEFAULT degrades to the module constant — it can never disable a bound
ok 3033 - a junk DEFAULT degrades to the module constant — it can never disable a bound
  ---
  duration_ms: 0.448666
  type: 'test'
  ...
# Subtest: all four re-exported symbols still resolve at their current values
ok 3034 - all four re-exported symbols still resolve at their current values
  ---
  duration_ms: 1.136333
  type: 'test'
  ...
# Subtest: openrouterCreateWithRetry is still exported and still a pure pass-through
ok 3035 - openrouterCreateWithRetry is still exported and still a pure pass-through
  ---
  duration_ms: 0.161083
  type: 'test'
  ...
# Subtest: there are exactly FOUR provider call sites — a fifth must be enumerated here
ok 3036 - there are exactly FOUR provider call sites — a fifth must be enumerated here
  ---
  duration_ms: 1.365875
  type: 'test'
  ...
# Subtest: EVERY provider call site forwards the caller timeout AND maxTries
ok 3037 - EVERY provider call site forwards the caller timeout AND maxTries
  ---
  duration_ms: 0.426875
  type: 'test'
  ...
# Subtest: the Vertex chat branch is wrapped in BOTH files, and identifies itself as vertex
ok 3038 - the Vertex chat branch is wrapped in BOTH files, and identifies itself as vertex
  ---
  duration_ms: 0.081625
  type: 'test'
  ...
# Subtest: THE REGION AND SERVICE IDENTITY SURVIVE — they are the Vertex path's whole advantage
ok 3039 - THE REGION AND SERVICE IDENTITY SURVIVE — they are the Vertex path's whole advantage
  ---
  duration_ms: 0.053792
  type: 'test'
  ...
# Subtest: the self-heal lives INSIDE the attempt closure — healing must not spend the budget
ok 3040 - the self-heal lives INSIDE the attempt closure — healing must not spend the budget
  ---
  duration_ms: 0.055042
  type: 'test'
  ...
# Subtest: the provider-call accounting still pairs
ok 3041 - the provider-call accounting still pairs
  ---
  duration_ms: 0.063792
  type: 'test'
  ...
# Subtest: the Vertex doc_read fetch finally has a signal — its absence is why Record audit HUNG
ok 3042 - the Vertex doc_read fetch finally has a signal — its absence is why Record audit HUNG
  ---
  duration_ms: 0.055959
  type: 'test'
  ...
# Subtest: doc_read failures are STRUCTURED and name region + identity, and still return null
ok 3043 - doc_read failures are STRUCTURED and name region + identity, and still return null
  ---
  duration_ms: 0.066791
  type: 'test'
  ...
# Subtest: ⚠️ doc_read has NO RETRY in this unit, and that is ARITHMETIC — not caution
ok 3044 - ⚠️ doc_read has NO RETRY in this unit, and that is ARITHMETIC — not caution
  ---
  duration_ms: 1.320375
  type: 'test'
  ...
# Subtest: the Ollama fallback is still PRESENT and still CALLED in both files
ok 3045 - the Ollama fallback is still PRESENT and still CALLED in both files
  ---
  duration_ms: 0.113542
  type: 'test'
  ...
# Subtest: no PROVIDER_BUDGETS value moved in this unit
ok 3046 - no PROVIDER_BUDGETS value moved in this unit
  ---
  duration_ms: 0.130375
  type: 'test'
  ...
# Subtest: the floor holds: a window reaching before the vitals source is CLAMPED, and says so
ok 3047 - the floor holds: a window reaching before the vitals source is CLAMPED, and says so
  ---
  duration_ms: 1.592375
  type: 'test'
  ...
# Subtest: an unclamped window is exactly WINDOW_DAYS long and is not flagged
ok 3048 - an unclamped window is exactly WINDOW_DAYS long and is not flagged
  ---
  duration_ms: 0.082542
  type: 'test'
  ...
# Subtest: the boundary day itself: a window starting exactly on the source is not clamped
ok 3049 - the boundary day itself: a window starting exactly on the source is not clamped
  ---
  duration_ms: 0.1135
  type: 'test'
  ...
# Subtest: a window entirely before the source returns null — nothing honest to show
ok 3050 - a window entirely before the source returns null — nothing honest to show
  ---
  duration_ms: 0.048333
  type: 'test'
  ...
# Subtest: a malformed or absurd window returns null rather than guessing
ok 3051 - a malformed or absurd window returns null rather than guessing
  ---
  duration_ms: 0.060042
  type: 'test'
  ...
# Subtest: the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only
ok 3052 - the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only
  ---
  duration_ms: 0.203458
  type: 'test'
  ...
# Subtest: the NOT IN filter is GUARDED so it is only asked about notes that HAVE an ID
ok 3053 - the NOT IN filter is GUARDED so it is only asked about notes that HAVE an ID
  ---
  duration_ms: 0.852916
  type: 'test'
  ...
# Subtest: THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated
ok 3054 - THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated
  ---
  duration_ms: 0.682917
  type: 'test'
  ...
# Subtest: isDay accepts only the exact shape — the same guard lib/metabase.ts uses
ok 3055 - isDay accepts only the exact shape — the same guard lib/metabase.ts uses
  ---
  duration_ms: 0.465834
  type: 'test'
  ...
# Subtest: addDays is UTC-stable across a month boundary and returns "" on junk
ok 3056 - addDays is UTC-stable across a month boundary and returns "" on junk
  ---
  duration_ms: 0.609833
  type: 'test'
  ...
# Subtest: istDay reads the Asia/Kolkata calendar day, not UTC
ok 3057 - istDay reads the Asia/Kolkata calendar day, not UTC
  ---
  duration_ms: 18.629667
  type: 'test'
  ...
# Subtest: a note with a NULL consult ID is no-consult-ID — neither covered nor no-vitals
ok 3058 - a note with a NULL consult ID is no-consult-ID — neither covered nor no-vitals
  ---
  duration_ms: 0.181541
  type: 'test'
  ...
# Subtest: THE HEADLINE DENOMINATOR EXCLUDES what we cannot know
ok 3059 - THE HEADLINE DENOMINATOR EXCLUDES what we cannot know
  ---
  duration_ms: 0.053583
  type: 'test'
  ...
# Subtest: empty-string and whitespace IDs are the SAME category as null (the SQL btrims them)
ok 3060 - empty-string and whitespace IDs are the SAME category as null (the SQL btrims them)
  ---
  duration_ms: 0.053834
  type: 'test'
  ...
# Subtest: a note with an ID absent from the vitals table is still no-vitals; one present is still covered
ok 3061 - a note with an ID absent from the vitals table is still no-vitals; one present is still covered
  ---
  duration_ms: 0.044041
  type: 'test'
  ...
# Subtest: the MEASURED window reproduces: 160 of 561 = 28.5%
ok 3062 - the MEASURED window reproduces: 160 of 561 = 28.5%
  ---
  duration_ms: 0.137458
  type: 'test'
  ...
# Subtest: rows outside the window are DROPPED — a boundary sliver is not a day
ok 3063 - rows outside the window are DROPPED — a boundary sliver is not a day
  ---
  duration_ms: 0.367791
  type: 'test'
  ...
# Subtest: Metabase type wobble is absorbed: string counts and ISO timestamps
ok 3064 - Metabase type wobble is absorbed: string counts and ISO timestamps
  ---
  duration_ms: 0.0485
  type: 'test'
  ...
# Subtest: junk never produces a number that looks real
ok 3065 - junk never produces a number that looks real
  ---
  duration_ms: 0.073791
  type: 'test'
  ...
# Subtest: the core is PURE and dependency-free — it must not reach the engine or any score
ok 3066 - the core is PURE and dependency-free — it must not reach the engine or any score
  ---
  duration_ms: 13.33375
  type: 'test'
  ...
# Subtest: GATE 2 — flag OFF: all three fetch SQL strings are byte-identical to today's
ok 3067 - GATE 2 — flag OFF: all three fetch SQL strings are byte-identical to today's
  ---
  duration_ms: 0.746625
  type: 'test'
  ...
# Subtest: flag ON: vitals LEFT JOIN present, DISTINCT ON newest _update_time, scan bounded, quoted table
ok 3068 - flag ON: vitals LEFT JOIN present, DISTINCT ON newest _update_time, scan bounded, quoted table
  ---
  duration_ms: 0.301292
  type: 'test'
  ...
# Subtest: SWEEP-1 (D2) — the day fetch deduplicates by uid; the single/bulk uid fetches do NOT change
ok 3069 - SWEEP-1 (D2) — the day fetch deduplicates by uid; the single/bulk uid fetches do NOT change
  ---
  duration_ms: 0.100916
  type: 'test'
  ...
# Subtest: GATE 5 — no selected column ends in _tag, flag on or off (R-11: numbers, not judgments)
ok 3070 - GATE 5 — no selected column ends in _tag, flag on or off (R-11: numbers, not judgments)
  ---
  duration_ms: 0.146459
  type: 'test'
  ...
# Subtest: GATE 3 — synthetic control: a vitals row parses to the exact case shape
ok 3071 - GATE 3 — synthetic control: a vitals row parses to the exact case shape
  ---
  duration_ms: 0.912875
  type: 'test'
  ...
# Subtest: GATE 3 — no vitals row → vitalsRecorded false + vitals null (weight/height still mapped)
ok 3072 - GATE 3 — no vitals row → vitalsRecorded false + vitals null (weight/height still mapped)
  ---
  duration_ms: 0.148834
  type: 'test'
  ...
# Subtest: a record with every measurement blank is STILL vitalsRecorded true — a different finding from "no record"
ok 3073 - a record with every measurement blank is STILL vitalsRecorded true — a different finding from "no record"
  ---
  duration_ms: 0.092708
  type: 'test'
  ...
# Subtest: bp parse: null unless the string matches ^\\d+\\/\\d+$ (the raw string is kept as recorded)
ok 3074 - bp parse: null unless the string matches ^\\d+\\/\\d+$ (the raw string is kept as recorded)
  ---
  duration_ms: 0.101083
  type: 'test'
  ...
# Subtest: recordedAt: null when the note timestamp is missing (no wall clock ever leaks)
ok 3075 - recordedAt: null when the note timestamp is missing (no wall clock ever leaks)
  ---
  duration_ms: 0.2295
  type: 'test'
  ...
# Subtest: fail-safe: an error in the vitals leg resets to the safe state and leaves the rest of the case intact
ok 3076 - fail-safe: an error in the vitals leg resets to the safe state and leaves the rest of the case intact
  ---
  duration_ms: 0.419458
  type: 'test'
  ...
# Subtest: flag OFF: the A1 fields stay absent — every existing case literal and behaviour unchanged
ok 3077 - flag OFF: the A1 fields stay absent — every existing case literal and behaviour unchanged
  ---
  duration_ms: 0.106834
  type: 'test'
  ...
# Subtest: GATE 1 — opdCaseText is byte-identical with and without the vitals block (A1 is score-invariant)
ok 3078 - GATE 1 — opdCaseText is byte-identical with and without the vitals block (A1 is score-invariant)
  ---
  duration_ms: 1.519417
  type: 'test'
  ...
# Subtest: GATE 4 — OpdKeys carries no vitals field, no weight, no height
ok 3079 - GATE 4 — OpdKeys carries no vitals field, no weight, no height
  ---
  duration_ms: 0.445917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the declaration is ONE statement over the whole note set, with ids index-aligned to it
ok 3080 - the declaration is ONE statement over the whole note set, with ids index-aligned to it
  ---
  duration_ms: 2.105791
  type: 'test'
  ...
# Subtest: a note with no uid declares a NULL uid, never the string "undefined"
ok 3081 - a note with no uid declares a NULL uid, never the string "undefined"
  ---
  duration_ms: 0.169375
  type: 'test'
  ...
# Subtest: 25 — a failed declaration throws TelemetryDeclarationError and leaves per-run evidence
ok 3082 - 25 — a failed declaration throws TelemetryDeclarationError and leaves per-run evidence
  ---
  duration_ms: 0.48375
  type: 'test'
  ...
# Subtest: 25 — all three worker modes reach the SAME fail-closed declaration, and it answers 503
ok 3083 - 25 — all three worker modes reach the SAME fail-closed declaration, and it answers 503
  ---
  duration_ms: 0.200375
  type: 'test'
  ...
# Subtest: 26 — the sweep 503 body says earlier days persisted
ok 3084 - 26 — the sweep 503 body says earlier days persisted
  ---
  duration_ms: 0.095709
  type: 'test'
  ...
# Subtest: 27 — re-audit fetches first, declares only what resolved, and preserves count and order
ok 3085 - 27 — re-audit fetches first, declares only what resolved, and preserves count and order
  ---
  duration_ms: 0.134709
  type: 'test'
  ...
# Subtest: the run ids are never reallocated — every audit call ADOPTS the declared id
ok 3086 - the run ids are never reallocated — every audit call ADOPTS the declared id
  ---
  duration_ms: 0.122667
  type: 'test'
  ...
# Subtest: the mini-backfill declares the same way and refuses the tick the same way
ok 3087 - the mini-backfill declares the same way and refuses the tick the same way
  ---
  duration_ms: 0.074416
  type: 'test'
  ...
# Subtest: safety-regex positive: Start metformin 500 mg twice daily.
ok 3088 - safety-regex positive: Start metformin 500 mg twice daily.
  ---
  duration_ms: 0.8095
  type: 'test'
  ...
# Subtest: safety-regex positive: Give 1 mg of glucagon IM.
ok 3089 - safety-regex positive: Give 1 mg of glucagon IM.
  ---
  duration_ms: 0.060084
  type: 'test'
  ...
# Subtest: safety-regex positive: Loading dose 500 mcg.
ok 3090 - safety-regex positive: Loading dose 500 mcg.
  ---
  duration_ms: 0.042875
  type: 'test'
  ...
# Subtest: safety-regex positive: Bolus 5 units of insulin.
ok 3091 - safety-regex positive: Bolus 5 units of insulin.
  ---
  duration_ms: 0.0375
  type: 'test'
  ...
# Subtest: safety-regex positive: 0.5 g IV q6h.
ok 3092 - safety-regex positive: 0.5 g IV q6h.
  ---
  duration_ms: 0.04125
  type: 'test'
  ...
# Subtest: safety-regex positive: Infuse 1000 mL bolus over 30 min.
ok 3093 - safety-regex positive: Infuse 1000 mL bolus over 30 min.
  ---
  duration_ms: 0.081792
  type: 'test'
  ...
# Subtest: safety-regex positive: 500 cc of normal saline.
ok 3094 - safety-regex positive: 500 cc of normal saline.
  ---
  duration_ms: 0.084333
  type: 'test'
  ...
# Subtest: safety-regex positive: Run at 100 mL/hr.
ok 3095 - safety-regex positive: Run at 100 mL/hr.
  ---
  duration_ms: 0.119041
  type: 'test'
  ...
# Subtest: safety-regex positive: Maintenance 50 cc/h.
ok 3096 - safety-regex positive: Maintenance 50 cc/h.
  ---
  duration_ms: 0.234791
  type: 'test'
  ...
# Subtest: safety-regex positive: 30 drops/min via gravity.
ok 3097 - safety-regex positive: 30 drops/min via gravity.
  ---
  duration_ms: 0.288791
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per L): Sodium 140 mEq/L is normal.
ok 3098 - safety-regex negative (preserve lab unit per L): Sodium 140 mEq/L is normal.
  ---
  duration_ms: 0.053583
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): Creatinine 1.4 mg/dL.
ok 3099 - safety-regex negative (preserve lab unit per dL): Creatinine 1.4 mg/dL.
  ---
  duration_ms: 0.028333
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit mmol/L): Lactate 4.2 mmol/L is the SSC threshold.
ok 3100 - safety-regex negative (preserve lab unit mmol/L): Lactate 4.2 mmol/L is the SSC threshold.
  ---
  duration_ms: 0.026875
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit g/dL): Albumin 3.5 g/dL.
ok 3101 - safety-regex negative (preserve lab unit g/dL): Albumin 3.5 g/dL.
  ---
  duration_ms: 0.026375
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve protocol cite mL/kg, not a dose): SSC recommends 30 mL/kg crystalloid in the first hour.
ok 3102 - safety-regex negative (preserve protocol cite mL/kg, not a dose): SSC recommends 30 mL/kg crystalloid in the first hour.
  ---
  duration_ms: 0.023333
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit): HCO3 9 mEq/L on this gas.
ok 3103 - safety-regex negative (preserve lab unit): HCO3 9 mEq/L on this gas.
  ---
  duration_ms: 0.024
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve eGFR unit): eGFR 42 mL/min/1.73 m² is CKD G3b.
ok 3104 - safety-regex negative (preserve eGFR unit): eGFR 42 mL/min/1.73 m² is CKD G3b.
  ---
  duration_ms: 0.024584
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve mmHg not in dose set): PaO2 80 mmHg.
ok 3105 - safety-regex negative (preserve mmHg not in dose set): PaO2 80 mmHg.
  ---
  duration_ms: 0.022417
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): BUN 28 mg/dL.
ok 3106 - safety-regex negative (preserve lab unit per dL): BUN 28 mg/dL.
  ---
  duration_ms: 0.021417
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): Glucose 580 mg/dL is severe hyperglycemia.
ok 3107 - safety-regex negative (preserve lab unit per dL): Glucose 580 mg/dL is severe hyperglycemia.
  ---
  duration_ms: 0.026667
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Hypertonic saline is the indicated agent for sympt...
ok 3108 - safety-regex preserves fluid TYPE: Hypertonic saline is the indicated agent for sympt...
  ---
  duration_ms: 0.030791
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Isotonic crystalloid is appropriate for initial re...
ok 3109 - safety-regex preserves fluid TYPE: Isotonic crystalloid is appropriate for initial re...
  ---
  duration_ms: 0.576167
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Lactated Ringer is preferred over normal saline in...
ok 3110 - safety-regex preserves fluid TYPE: Lactated Ringer is preferred over normal saline in...
  ---
  duration_ms: 0.025125
  type: 'test'
  ...
# Subtest: safety-regex mixed: redact dose, preserve lab unit
ok 3111 - safety-regex mixed: redact dose, preserve lab unit
  ---
  duration_ms: 0.06
  type: 'test'
  ...
# Subtest: ABG: classic high-AG metabolic acidosis (DKA-flavored)
ok 3112 - ABG: classic high-AG metabolic acidosis (DKA-flavored)
  ---
  duration_ms: 0.695333
  type: 'test'
  ...
# Subtest: ABG: respiratory alkalosis + concurrent high-AG metabolic acidosis (mixed via delta-delta)
ok 3113 - ABG: respiratory alkalosis + concurrent high-AG metabolic acidosis (mixed via delta-delta)
  ---
  duration_ms: 0.078042
  type: 'test'
  ...
# Subtest: ABG: acute respiratory acidosis (no chronic compensation evidence)
ok 3114 - ABG: acute respiratory acidosis (no chronic compensation evidence)
  ---
  duration_ms: 0.058292
  type: 'test'
  ...
# Subtest: ABG: metabolic alkalosis
ok 3115 - ABG: metabolic alkalosis
  ---
  duration_ms: 0.11875
  type: 'test'
  ...
# Subtest: ABG: normal — must not fabricate a disorder
ok 3116 - ABG: normal — must not fabricate a disorder
  ---
  duration_ms: 0.055083
  type: 'test'
  ...
# Subtest: ABG: albumin correction applied below 4.0
ok 3117 - ABG: albumin correction applied below 4.0
  ---
  duration_ms: 0.046292
  type: 'test'
  ...
# Subtest: ABG: P/F ratio Berlin ARDS bands
ok 3118 - ABG: P/F ratio Berlin ARDS bands
  ---
  duration_ms: 0.11475
  type: 'test'
  ...
# Subtest: ABG: A-a gradient computed when PaO2+FiO2+PaCO2 all present
ok 3119 - ABG: A-a gradient computed when PaO2+FiO2+PaCO2 all present
  ---
  duration_ms: 0.047458
  type: 'test'
  ...
# Subtest: ABG: anion gap returns unknown when Na/Cl missing
ok 3120 - ABG: anion gap returns unknown when Na/Cl missing
  ---
  duration_ms: 0.147167
  type: 'test'
  ...
# Subtest: ckdEpi2021: young healthy F, SCr 0.7
ok 3121 - ckdEpi2021: young healthy F, SCr 0.7
  ---
  duration_ms: 0.559417
  type: 'test'
  ...
# Subtest: ckdEpi2021: mid-life M, SCr 1.0
ok 3122 - ckdEpi2021: mid-life M, SCr 1.0
  ---
  duration_ms: 0.057833
  type: 'test'
  ...
# Subtest: ckdEpi2021: older M, SCr 1.8 (CKD3b)
ok 3123 - ckdEpi2021: older M, SCr 1.8 (CKD3b)
  ---
  duration_ms: 0.038208
  type: 'test'
  ...
# Subtest: ckdEpi2021: elderly F, SCr 4.2 (CKD5)
ok 3124 - ckdEpi2021: elderly F, SCr 4.2 (CKD5)
  ---
  duration_ms: 0.036083
  type: 'test'
  ...
# Subtest: ckdEpi2021: F SCr 1.2 (CKD3a)
ok 3125 - ckdEpi2021: F SCr 1.2 (CKD3a)
  ---
  duration_ms: 0.037125
  type: 'test'
  ...
# Subtest: cockcroftGault: young healthy F, SCr 0.7, 60 kg
ok 3126 - cockcroftGault: young healthy F, SCr 0.7, 60 kg
  ---
  duration_ms: 0.064583
  type: 'test'
  ...
# Subtest: cockcroftGault: older M, SCr 1.8, 78 kg
ok 3127 - cockcroftGault: older M, SCr 1.8, 78 kg
  ---
  duration_ms: 0.085125
  type: 'test'
  ...
# Subtest: cockcroftGault: elderly F low weight, SCr 4.2, 52
ok 3128 - cockcroftGault: elderly F low weight, SCr 4.2, 52
  ---
  duration_ms: 0.030167
  type: 'test'
  ...
# Subtest: cockcroftGault returns null without weight
ok 3129 - cockcroftGault returns null without weight
  ---
  duration_ms: 0.171333
  type: 'test'
  ...
# Subtest: computeEgfr returns conservative_for_nti as the lower of the two
ok 3130 - computeEgfr returns conservative_for_nti as the lower of the two
  ---
  duration_ms: 0.295209
  type: 'test'
  ...
# Subtest: stageFromEgfr boundaries
ok 3131 - stageFromEgfr boundaries
  ---
  duration_ms: 0.062208
  type: 'test'
  ...
# Subtest: umolLtoMgDl conversion
ok 3132 - umolLtoMgDl conversion
  ---
  duration_ms: 0.482708
  type: 'test'
  ...
# Subtest: Hyponatremia: classic SIADH (euvolemic, U-Na high, U-osm concentrated, on SSRI)
ok 3133 - Hyponatremia: classic SIADH (euvolemic, U-Na high, U-osm concentrated, on SSRI)
  ---
  duration_ms: 0.561583
  type: 'test'
  ...
# Subtest: Hyponatremia: pseudo from hyperglycemia (corrected Na > measured)
ok 3134 - Hyponatremia: pseudo from hyperglycemia (corrected Na > measured)
  ---
  duration_ms: 0.276959
  type: 'test'
  ...
# Subtest: Hyponatremia: hypovolemic from extrarenal loss
ok 3135 - Hyponatremia: hypovolemic from extrarenal loss
  ---
  duration_ms: 0.140333
  type: 'test'
  ...
# Subtest: Hyponatremia: ODS risk fires for Na < 105
ok 3136 - Hyponatremia: ODS risk fires for Na < 105
  ---
  duration_ms: 0.240542
  type: 'test'
  ...
# Subtest: Hyponatremia: ODS risk fires for K < 3
ok 3137 - Hyponatremia: ODS risk fires for K < 3
  ---
  duration_ms: 0.184458
  type: 'test'
  ...
# Subtest: Hyponatremia: free-water excess for 70kg male, Na 125
ok 3138 - Hyponatremia: free-water excess for 70kg male, Na 125
  ---
  duration_ms: 0.124833
  type: 'test'
  ...
# Subtest: Hyponatremia: free-water excess returns null without weight
ok 3139 - Hyponatremia: free-water excess returns null without weight
  ---
  duration_ms: 0.106166
  type: 'test'
  ...
# Subtest: Hyponatremia: estimated osm fires when serum_osm absent
ok 3140 - Hyponatremia: estimated osm fires when serum_osm absent
  ---
  duration_ms: 0.114333
  type: 'test'
  ...
# Subtest: NEWS2: all-normal vitals → 0 / low / no banner
ok 3141 - NEWS2: all-normal vitals → 0 / low / no banner
  ---
  duration_ms: 0.565958
  type: 'test'
  ...
# Subtest: NEWS2: PRD §11 vignette \#2 — RR 22, SpO2 95, T 38.2, BP 110, HR 105 → 5 medium amber
ok 3142 - NEWS2: PRD §11 vignette \#2 — RR 22, SpO2 95, T 38.2, BP 110, HR 105 → 5 medium amber
  ---
  duration_ms: 0.114166
  type: 'test'
  ...
# Subtest: NEWS2: PRD §11 vignette \#3 — RR 28, SpO2 90, T 39.5, BP 88, HR 130, new confusion → ≥10 high red
ok 3143 - NEWS2: PRD §11 vignette \#3 — RR 28, SpO2 90, T 39.5, BP 88, HR 130, new confusion → ≥10 high red
  ---
  duration_ms: 0.113
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2 / COPD: SpO2 88 on 2L O2 — air SpO2 target met but on O2
ok 3144 - NEWS2 Scale 2 / COPD: SpO2 88 on 2L O2 — air SpO2 target met but on O2
  ---
  duration_ms: 0.071541
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2: SpO2 96 on O2 (above target window) → scale 2 SpO2 → 2
ok 3145 - NEWS2 Scale 2: SpO2 96 on O2 (above target window) → scale 2 SpO2 → 2
  ---
  duration_ms: 0.054917
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2: SpO2 96 on AIR (above target window without O2) → scale 2 SpO2 → 0
ok 3146 - NEWS2 Scale 2: SpO2 96 on AIR (above target window without O2) → scale 2 SpO2 → 0
  ---
  duration_ms: 0.084792
  type: 'test'
  ...
# Subtest: NEWS2: isolated tachycardia HR 115 → 2 low-medium (not a single 3, so stays low-medium)
ok 3147 - NEWS2: isolated tachycardia HR 115 → 2 low-medium (not a single 3, so stays low-medium)
  ---
  duration_ms: 0.098166
  type: 'test'
  ...
# Subtest: NEWS2: single param scoring 3 bumps low-medium → medium
ok 3148 - NEWS2: single param scoring 3 bumps low-medium → medium
  ---
  duration_ms: 0.045875
  type: 'test'
  ...
# Subtest: NEWS2 RR boundaries
ok 3149 - NEWS2 RR boundaries
  ---
  duration_ms: 0.28325
  type: 'test'
  ...
# Subtest: NEWS2 SBP boundaries
ok 3150 - NEWS2 SBP boundaries
  ---
  duration_ms: 0.290042
  type: 'test'
  ...
# Subtest: NEWS2 Temp boundaries
ok 3151 - NEWS2 Temp boundaries
  ---
  duration_ms: 0.072792
  type: 'test'
  ...
# Subtest: NEWS2 consciousness: any non-Alert → 3
ok 3152 - NEWS2 consciousness: any non-Alert → 3
  ---
  duration_ms: 0.05325
  type: 'test'
  ...
# Subtest: SepsisBundle V1: just recognized (5 min), nothing done
ok 3153 - SepsisBundle V1: just recognized (5 min), nothing done
  ---
  duration_ms: 1.06675
  type: 'test'
  ...
# Subtest: SepsisBundle V2: at 35 min, lactate + cultures done, abx + fluids missing (hypotensive)
ok 3154 - SepsisBundle V2: at 35 min, lactate + cultures done, abx + fluids missing (hypotensive)
  ---
  duration_ms: 0.101958
  type: 'test'
  ...
# Subtest: SepsisBundle V2b: at 35 min, only lactate done (25% compliance) → amber banner
ok 3155 - SepsisBundle V2b: at 35 min, only lactate done (25% compliance) → amber banner
  ---
  duration_ms: 0.088583
  type: 'test'
  ...
# Subtest: SepsisBundle V3: 55 min, vasopressors required after fluids in hypotension
ok 3156 - SepsisBundle V3: 55 min, vasopressors required after fluids in hypotension
  ---
  duration_ms: 0.057584
  type: 'test'
  ...
# Subtest: SepsisBundle V4: 75 min, abx never given → overdue + red banner
ok 3157 - SepsisBundle V4: 75 min, abx never given → overdue + red banner
  ---
  duration_ms: 0.1255
  type: 'test'
  ...
# Subtest: SepsisBundle: not-hypotensive patient does not require fluids/vasopressors
ok 3158 - SepsisBundle: not-hypotensive patient does not require fluids/vasopressors
  ---
  duration_ms: 0.118625
  type: 'test'
  ...
# Subtest: SepsisBundle: elapsed_min defaults to 0 for future recognition_time (clamps)
ok 3159 - SepsisBundle: elapsed_min defaults to 0 for future recognition_time (clamps)
  ---
  duration_ms: 0.069834
  type: 'test'
  ...
1..3159
# tests 3159
# suites 0
# pass 3159
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 20481.186458

[exit status: 0]
```

---

## 2. npm run typecheck

```console
$ npm run typecheck

> even-cdmss@2.0.0 typecheck
> tsc --noEmit


[exit status: 0]
```

---

## 3. npm run build (keyed, so the gate's build command can run at all)

```console
$ env CDMSS_TELEMETRY_HMAC_KEY=local-gate-evidence npm run build

> even-cdmss@2.0.0 build
> next build

   [1m[38;2;173;127;168m▲ Next.js 15.5.18[39m[22m
   - Environments: .env.local

 [37m[1m [22m[39m Creating an optimized production build ...
 [32m[1m✓[22m[39m Compiled successfully in 8.8s
 [37m[1m [22m[39m Linting and checking validity of types ...
 [37m[1m [22m[39m Collecting page data ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 [33m[1m⚠[22m[39m Using edge runtime on a page currently disables static generation for that page
 [37m[1m [22m[39m Generating static pages (0/127) ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 [37m[1m [22m[39m Generating static pages (31/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
 [37m[1m [22m[39m Generating static pages (63/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
 [37m[1m [22m[39m Generating static pages (95/127) 
 [32m[1m✓[22m[39m Generating static pages (127/127)
 [37m[1m [22m[39m Finalizing page optimization ...
 [37m[1m [22m[39m Collecting build traces ...

[4mRoute (app)[24m                                             [4mSize[24m  [4mFirst Load JS[24m  [4m[24m  [4m[24m
┌ ƒ /                                                  205 B         [37m[1m107 kB[22m[39m
├ ƒ /_not-found                                      1.01 kB         [37m[1m104 kB[22m[39m
├ ƒ /admin/appropriateness-runs                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/architecture                                205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ccb-funnel                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/concordance                                 205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/episode-recon-queue                        1.5 kB         [37m[1m108 kB[22m[39m
├ ƒ /admin/eval                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/ipd-audit                                   178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ipd-audit/[id]                            6.16 kB         [37m[1m251 kB[22m[39m
├ ƒ /admin/ipd-audit/calendar                          842 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ipd-audit/search                            842 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ipd-gold-queue                             1.6 kB         [37m[1m108 kB[22m[39m
├ ƒ /admin/learning                                  1.76 kB         [37m[1m108 kB[22m[39m
├ ƒ /admin/literature                                  205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/lvc-ground                                4.23 kB         [37m[1m243 kB[22m[39m
├ ƒ /admin/mini-backfill                             6.58 kB         [37m[1m113 kB[22m[39m
├ ƒ /admin/observability                              5.3 kB         [37m[1m112 kB[22m[39m
├ ƒ /admin/observability/[traceId]                     205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/observability/adjudications                 178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/observability/engine-health                 205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/observability/reconstruction-fidelity       178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/opd-audit                                 3.48 kB         [37m[1m115 kB[22m[39m
├ ƒ /admin/opd-audit/[id]                            10.9 kB         [37m[1m117 kB[22m[39m
├ ƒ /admin/opd-audit/doctor/[uid]                      180 B         [37m[1m112 kB[22m[39m
├ ƒ /admin/opd-audit/doctors                           205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/opd-audit/how-it-works                      205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/opd-audit/vitals-coverage                   205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/proms-adhoc-review                        3.26 kB         [37m[1m106 kB[22m[39m
├ ƒ /admin/provenance                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/scoring-policy                              178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/scoring-policy/lab-packages               2.59 kB         [37m[1m115 kB[22m[39m
├ ƒ /admin/scoring-policy/nabh-completeness            168 B         [37m[1m113 kB[22m[39m
├ ƒ /admin/scoring-policy/nabh-completeness/history    180 B         [37m[1m113 kB[22m[39m
├ ƒ /admin/stewardship                                 205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/stewardship/dept/[dept]                     205 B         [37m[1m107 kB[22m[39m
├ ƒ /api/admin/appropriateness-runs                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/appropriateness-runs/[id]               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/backfill-corpus-provenance              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/backfill-stable-ref                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/bm25-diag                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ccb-calibration                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/complexity-backfill                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/concordance/migrate                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/concordance/runs                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/corpus-eval/status                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/episode-recon-rating                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-billed-backfill               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-export                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-feedback                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-mini-backfill                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-now                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-gold-adjudication                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/lab-batch                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/lvc-judge-aa                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/lvc-ref-backfill                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/mark-mini-labelled-prod                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-adhoc-sets                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-appropriateness-runs            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-audit-suppression               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-care-call                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-care-tracks                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ccb                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ccb-cache                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-choosing-wisely                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-concept-state-key               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-doctor-metrics                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-episode-recon                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-episode-states                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-even-ground                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-even-lvc                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-extracted-cases                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-inquiry                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ipd-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ipd-gold-union                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lab                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lab-views                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-learning                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lvc-concepts                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lvc-wording                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-medaudit                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-mini-ticks                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-gov-signal                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-longitudinal                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-triage                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-proms                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-provenance-tier                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-readmissions                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-reasoning                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-retrieval-telemetry             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-scoring-policy                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v2                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v6                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v7                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v8                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/mini-backfill-monitor                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/mini-backfill-settings                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ollama-ps                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-audit-mini-backfill                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-audit/longitudinal-replay           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-dosing-backfill                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-invalid-marking-backfill            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-rescore-direction                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/prognosis-outcome                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/proms-adhoc-review                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/quieting-dryrun                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/reasoning-registry                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/recompute-care-call                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/refresh-doctor-metrics                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/retrieval-telemetry-reconcile           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-choosing-wisely                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-ddi-reference                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-formulary                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-topics                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-topics-tropical                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/statpearls-pilot                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/sync-doctor-directory                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/telemetry-overhead                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/tooltip-cache/bump                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/traces                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/traces/[traceId]                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/unlock                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/appropriateness                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/appropriateness/save-run                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ask                                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ask/example-questions                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ask/stage-medians                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit                                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit/formulary                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit/interactions                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit/login                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/abcd2                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/abg                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/alvarado                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/curb65                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/egfr                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/heart                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/hyponatremia                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/news2                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/nihss                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/qtc                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/sepsis-bundle                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/sepsis-bundle/sidebar             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/sofa                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/timi                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/tooltip                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/typical-latency                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/wells_dvt                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/wells_pe                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/askset                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/outcome                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/outcomes                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/adhoc/generate                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/adhoc/update                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/response                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/schedule                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/assignment                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/concept/code                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/concept/status                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/login                                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/generate                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/ground                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/ground-status                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/list                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/ratify                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/reject                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/retire                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/member-state                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/readmissions/list                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/review-queue                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/review-stats                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/workspace                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/brief                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/brief/stream                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/dossier                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/episode-docs                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/search                                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/selftest                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/worker                                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/worklist                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/coach/end                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/coach/respond                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/coach/start                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/concordance/interview                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/concordance/single-shot                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/cron/curator                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/cron/harvest                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/cron/harvest-epmc                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ddx                                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/debug-search                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/debug-stats                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/digest/generate                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/doc-audit/analyze                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/doc-audit/extract                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/drugs/interactions                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/drugs/lookup                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/flashcards/due                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/flashcards/review                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/audit-signal/[reference]           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/doctor-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/doctor-directory                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/doctor-response                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/opd-signals                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/roster-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/signal-action                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/health                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ipd-audit/review                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ipd-audit/worker                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/lab/ml-label-trial                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/learning/mine                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/learning/review                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/log/query                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/mcp                                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/mcp/[key]                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/backfill                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/export-pdf                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/feedback                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/reset                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/run                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/worker                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/decide                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/longitudinal-lane                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/queue                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/signal-health                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/suppressions                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/pathway/enrich                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/pathway/skeleton                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/practice/next                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/readmission/worker                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/draft                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/lab-packages/export            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/lab-packages/import            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/preview                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/publish                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/search                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/topics                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/v1/patient-summary                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/v1/patient-summary/[jobId]                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /appropriateness                                 17.6 kB         [37m[1m266 kB[22m[39m
├ ƒ /ask                                             6.24 kB         [37m[1m179 kB[22m[39m
├ ƒ /ask/trace/[trace_id]                            1.63 kB         [37m[1m108 kB[22m[39m
├ ƒ /audit                                           9.26 kB         [37m[1m112 kB[22m[39m
├ ƒ /audit/login                                       985 B         [37m[1m104 kB[22m[39m
├ ƒ /audit/queries                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /browse                                            205 B         [37m[1m107 kB[22m[39m
├ ƒ /calculators                                     1.57 kB         [37m[1m108 kB[22m[39m
├ ƒ /calculators/abcd2                               2.57 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/abg                                 4.99 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/alvarado                            2.41 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/curb65                              2.05 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/egfr                                2.94 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/heart                                  3 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/hyponatremia                        5.68 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/news2                               3.85 kB         [37m[1m114 kB[22m[39m
├ ƒ /calculators/nihss                               4.27 kB         [37m[1m115 kB[22m[39m
├ ƒ /calculators/qtc                                  2.6 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/sepsis-bundle                        4.9 kB         [37m[1m111 kB[22m[39m
├ ƒ /calculators/sofa                                3.55 kB         [37m[1m114 kB[22m[39m
├ ƒ /calculators/timi                                2.19 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/wells_dvt                           2.46 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/wells_pe                            2.39 kB         [37m[1m113 kB[22m[39m
├ ƒ /care                                              178 B         [37m[1m107 kB[22m[39m
├ ƒ /care/[uid]                                      12.5 kB         [37m[1m124 kB[22m[39m
├ ƒ /care/briefs                                     2.82 kB         [37m[1m109 kB[22m[39m
├ ƒ /care/concepts                                   4.48 kB         [37m[1m239 kB[22m[39m
├ ƒ /care/login                                        982 B         [37m[1m104 kB[22m[39m
├ ƒ /care/lvc                                           6 kB         [37m[1m241 kB[22m[39m
├ ƒ /care/m/[uid]                                    25.3 kB         [37m[1m137 kB[22m[39m
├ ƒ /care/readmissions                               5.21 kB         [37m[1m112 kB[22m[39m
├ ƒ /care/review                                     9.91 kB         [37m[1m113 kB[22m[39m
├ ƒ /care/triage                                     11.2 kB         [37m[1m114 kB[22m[39m
├ ƒ /care/triage/health                              4.65 kB         [37m[1m108 kB[22m[39m
├ ƒ /coach                                           5.91 kB         [37m[1m171 kB[22m[39m
├ ƒ /concordance                                     4.43 kB         [37m[1m108 kB[22m[39m
├ ƒ /ddx                                             9.37 kB         [37m[1m182 kB[22m[39m
├ ƒ /drugs                                           8.86 kB         [37m[1m119 kB[22m[39m
├ ƒ /knowledge                                       3.29 kB         [37m[1m110 kB[22m[39m
├ ƒ /learn                                             205 B         [37m[1m107 kB[22m[39m
├ ƒ /practice                                        3.08 kB         [37m[1m106 kB[22m[39m
├ ƒ /review                                          4.75 kB         [37m[1m108 kB[22m[39m
├ ƒ /search                                            600 B         [37m[1m104 kB[22m[39m
└ ƒ /topics                                           3.4 kB         [37m[1m107 kB[22m[39m
+ First Load JS shared by all                         [37m[1m103 kB[22m[39m
  ├ chunks/3636-b8d66f842f910767.js                    46 kB
  ├ chunks/4bd1b696-100b9d70ed4e49c1.js              54.2 kB
  └ other shared chunks (total)                      2.95 kB


ƒ Middleware                                         [37m[1m34.5 kB[22m[39m

ƒ  (Dynamic)  server-rendered on demand


[exit status: 0]
```

---

## 4. npm run architecture:check

```console
$ npm run architecture:check

> even-cdmss@2.0.0 architecture:check
> node --import tsx scripts/architecture-check.mjs

rule 1 · GREEN · 26 files scanned · pure clinical cores must not reach up into the app
rule 2 · GREEN · 4 files scanned · advisory must not import score arithmetic (finding types/identity from opd-note-audit-core ARE allowed)
rule 3 · GREEN · 24 files scanned · the spine runs no audit/score logic (VALUE imports; `import type` is allowed)
rule 4 · GREEN · 24 files scanned · the spine must not couple to a prediction layer
rule 5 · GREEN · 8 files scanned · inquiry (advisory) and the scored cores never value-import each other
rule 6 · GREEN · 24 files scanned · the spine must not value-import the IPD audit module
rule 7 · GREEN · 24 files scanned · the frozen spine must not import EpisodeState
rule 8 · GREEN · 24 files scanned · the frozen spine must not import the admission adapter
coverage · GREEN · 39 subsystems · 16 registered, 23 explicitly unregistered

architecture:check — all 8 rules + coverage green.

[exit status: 0]
```

---

## 5. npm run architecture:map

```console
$ npm run architecture:map

> even-cdmss@2.0.0 architecture:map
> node --import tsx scripts/architecture-map-gen.mjs

architecture:map — wrote lib/architecture/map.generated.ts (90383 bytes).

[exit status: 0]
```

---

## 6. git diff --exit-code lib/architecture/map.generated.ts (determinism, after command 5 regenerated it)

```console
$ git diff --exit-code lib/architecture/map.generated.ts

[exit status: 0]
```

---

## 7a. npm run reasoning:registry

```console
$ npm run reasoning:registry

> even-cdmss@2.0.0 reasoning:registry
> node scripts/reasoning-registry-gen.mjs

reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).

[exit status: 0]
```

---

## 7b. git diff --exit-code data/reasoning-registry/prompts.generated.json

```console
$ git diff --exit-code data/reasoning-registry/prompts.generated.json

[exit status: 0]
```

---

## 8. npm run reasoning:governance

```console
$ npm run reasoning:governance

> even-cdmss@2.0.0 reasoning:governance
> node scripts/reasoning-governance-check.mjs

reasoning governance — HARD GATE (Stage 4): no direct model calls outside the governed layer

ungoverned model calls (bypass tracedChat/governedChat): 0

parallel run stores: 15 references (INFO — folded into traces since Stage 4)
  info lib/concordance-store.ts:8 — concordance_runs
  info lib/concordance-store.ts:28 — concordance_runs
  info lib/concordance-store.ts:46 — concordance_runs
  info lib/concordance-store.ts:47 — concordance_runs
  info lib/concordance-store.ts:48 — concordance_runs
  info lib/concordance.ts:8 — concordance_runs
  info lib/concordance.ts:9 — concordance_runs
  info app/admin/concordance/page.tsx:58 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:8 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:14 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:31 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:32 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:33 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:34 — concordance_runs
  info app/api/admin/concordance/runs/route.ts:10 — concordance_runs

reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.

[exit status: 0]
```

---

## 9. npm run changelog:coverage

```console
$ npm run changelog:coverage

> even-cdmss@2.0.0 changelog:coverage
> node scripts/changelog-coverage-check.mjs

changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).

[exit status: 0]
```

---

# The keyed and unkeyed build split

Addendum v1 lines 510-512. An unkeyed production build must FAIL and must name
`CDMSS_TELEMETRY_HMAC_KEY`. A keyed build must succeed. A PASS here is exit 1 for the first
and exit 0 for the second.

---

## A. UNKEYED production build — must FAIL

```console
$ env -u CDMSS_TELEMETRY_HMAC_KEY npm run build

> even-cdmss@2.0.0 build
> next build

 [31m[1m⨯[22m[39m Failed to load next.config.mjs, see more info here https://nextjs.org/docs/messages/next-config-error

> Build error occurred
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)

[exit status: 1]
```

---

## B. KEYED production build — must SUCCEED

```console
$ env CDMSS_TELEMETRY_HMAC_KEY=local-gate-evidence npm run build

> even-cdmss@2.0.0 build
> next build

   [1m[38;2;173;127;168m▲ Next.js 15.5.18[39m[22m
   - Environments: .env.local

 [37m[1m [22m[39m Creating an optimized production build ...
 [32m[1m✓[22m[39m Compiled successfully in 8.6s
 [37m[1m [22m[39m Linting and checking validity of types ...
 [37m[1m [22m[39m Collecting page data ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 [33m[1m⚠[22m[39m Using edge runtime on a page currently disables static generation for that page
 [37m[1m [22m[39m Generating static pages (0/127) ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 [37m[1m [22m[39m Generating static pages (31/127) 
 [37m[1m [22m[39m Generating static pages (63/127) 
 [37m[1m [22m[39m Generating static pages (95/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
 [32m[1m✓[22m[39m Generating static pages (127/127)
 [37m[1m [22m[39m Finalizing page optimization ...
 [37m[1m [22m[39m Collecting build traces ...

[4mRoute (app)[24m                                             [4mSize[24m  [4mFirst Load JS[24m  [4m[24m  [4m[24m
┌ ƒ /                                                  205 B         [37m[1m107 kB[22m[39m
├ ƒ /_not-found                                      1.01 kB         [37m[1m104 kB[22m[39m
├ ƒ /admin/appropriateness-runs                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/architecture                                205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ccb-funnel                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/concordance                                 205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/episode-recon-queue                        1.5 kB         [37m[1m108 kB[22m[39m
├ ƒ /admin/eval                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/ipd-audit                                   178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ipd-audit/[id]                            6.16 kB         [37m[1m251 kB[22m[39m
├ ƒ /admin/ipd-audit/calendar                          842 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ipd-audit/search                            842 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/ipd-gold-queue                             1.6 kB         [37m[1m108 kB[22m[39m
├ ƒ /admin/learning                                  1.76 kB         [37m[1m108 kB[22m[39m
├ ƒ /admin/literature                                  205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/lvc-ground                                4.23 kB         [37m[1m243 kB[22m[39m
├ ƒ /admin/mini-backfill                             6.58 kB         [37m[1m113 kB[22m[39m
├ ƒ /admin/observability                              5.3 kB         [37m[1m112 kB[22m[39m
├ ƒ /admin/observability/[traceId]                     205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/observability/adjudications                 178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/observability/engine-health                 205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/observability/reconstruction-fidelity       178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/opd-audit                                 3.48 kB         [37m[1m115 kB[22m[39m
├ ƒ /admin/opd-audit/[id]                            10.9 kB         [37m[1m117 kB[22m[39m
├ ƒ /admin/opd-audit/doctor/[uid]                      180 B         [37m[1m112 kB[22m[39m
├ ƒ /admin/opd-audit/doctors                           205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/opd-audit/how-it-works                      205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/opd-audit/vitals-coverage                   205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/proms-adhoc-review                        3.26 kB         [37m[1m106 kB[22m[39m
├ ƒ /admin/provenance                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /admin/scoring-policy                              178 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/scoring-policy/lab-packages               2.59 kB         [37m[1m115 kB[22m[39m
├ ƒ /admin/scoring-policy/nabh-completeness            168 B         [37m[1m113 kB[22m[39m
├ ƒ /admin/scoring-policy/nabh-completeness/history    180 B         [37m[1m113 kB[22m[39m
├ ƒ /admin/stewardship                                 205 B         [37m[1m107 kB[22m[39m
├ ƒ /admin/stewardship/dept/[dept]                     205 B         [37m[1m107 kB[22m[39m
├ ƒ /api/admin/appropriateness-runs                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/appropriateness-runs/[id]               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/backfill-corpus-provenance              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/backfill-stable-ref                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/bm25-diag                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ccb-calibration                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/complexity-backfill                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/concordance/migrate                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/concordance/runs                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/corpus-eval/status                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/episode-recon-rating                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-billed-backfill               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-export                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-feedback                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-mini-backfill                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-audit-now                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ipd-gold-adjudication                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/lab-batch                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/lvc-judge-aa                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/lvc-ref-backfill                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/mark-mini-labelled-prod                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-adhoc-sets                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-appropriateness-runs            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-audit-suppression               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-care-call                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-care-tracks                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ccb                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ccb-cache                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-choosing-wisely                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-concept-state-key               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-doctor-metrics                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-episode-recon                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-episode-states                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-even-ground                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-even-lvc                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-extracted-cases                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-inquiry                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ipd-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-ipd-gold-union                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lab                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lab-views                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-learning                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lvc-concepts                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-lvc-wording                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-medaudit                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-mini-ticks                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-gov-signal                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-longitudinal                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-opd-triage                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-proms                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-provenance-tier                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-readmissions                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-reasoning                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-retrieval-telemetry             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-scoring-policy                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v2                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v6                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v7                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/migrate-v8                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/mini-backfill-monitor                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/mini-backfill-settings                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/ollama-ps                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-audit-mini-backfill                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-audit/longitudinal-replay           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-dosing-backfill                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-invalid-marking-backfill            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/opd-rescore-direction                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/prognosis-outcome                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/proms-adhoc-review                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/quieting-dryrun                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/reasoning-registry                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/recompute-care-call                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/refresh-doctor-metrics                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/retrieval-telemetry-reconcile           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-choosing-wisely                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-ddi-reference                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-formulary                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-topics                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/seed-topics-tropical                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/statpearls-pilot                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/sync-doctor-directory                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/telemetry-overhead                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/tooltip-cache/bump                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/traces                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/traces/[traceId]                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/admin/unlock                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/appropriateness                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/appropriateness/save-run                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ask                                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ask/example-questions                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ask/stage-medians                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit                                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit/formulary                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit/interactions                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/audit/login                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/abcd2                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/abg                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/alvarado                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/curb65                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/egfr                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/heart                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/hyponatremia                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/news2                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/nihss                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/qtc                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/sepsis-bundle                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/sepsis-bundle/sidebar             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/sofa                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/timi                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/tooltip                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/typical-latency                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/wells_dvt                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/calculators/wells_pe                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/askset                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/outcome                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/outcomes                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/adhoc/generate                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/adhoc/update                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/response                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care-call/proms/schedule                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/assignment                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/concept/code                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/concept/status                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/login                                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/generate                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/ground                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/ground-status                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/list                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/ratify                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/reject                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/lvc/retire                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/member-state                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/readmissions/list                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/review-queue                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/review-stats                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/care/workspace                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/brief                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/brief/stream                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/dossier                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/episode-docs                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/search                                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/selftest                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/worker                                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ccb/worklist                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/coach/end                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/coach/respond                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/coach/start                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/concordance/interview                         600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/concordance/single-shot                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/cron/curator                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/cron/harvest                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/cron/harvest-epmc                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ddx                                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/debug-search                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/debug-stats                                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/digest/generate                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/doc-audit/analyze                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/doc-audit/extract                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/drugs/interactions                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/drugs/lookup                                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/flashcards/due                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/flashcards/review                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/audit-signal/[reference]           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/doctor-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/doctor-directory                   600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/doctor-response                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/opd-signals                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/roster-audits                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/governance/signal-action                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/health                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ipd-audit/review                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/ipd-audit/worker                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/lab/ml-label-trial                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/learning/mine                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/learning/review                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/log/query                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/mcp                                           600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/mcp/[key]                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/backfill                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/export-pdf                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/feedback                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/reset                               600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/run                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-audit/worker                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/decide                             600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/longitudinal-lane                  600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/queue                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/signal-health                      600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/opd-triage/suppressions                       600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/pathway/enrich                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/pathway/skeleton                              600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/practice/next                                 600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/readmission/worker                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy                                600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/draft                          600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/lab-packages/export            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/lab-packages/import            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/preview                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/scoring-policy/publish                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/search                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/topics                                        600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/v1/patient-summary                            600 B         [37m[1m104 kB[22m[39m
├ ƒ /api/v1/patient-summary/[jobId]                    600 B         [37m[1m104 kB[22m[39m
├ ƒ /appropriateness                                 17.6 kB         [37m[1m266 kB[22m[39m
├ ƒ /ask                                             6.24 kB         [37m[1m179 kB[22m[39m
├ ƒ /ask/trace/[trace_id]                            1.63 kB         [37m[1m108 kB[22m[39m
├ ƒ /audit                                           9.26 kB         [37m[1m112 kB[22m[39m
├ ƒ /audit/login                                       985 B         [37m[1m104 kB[22m[39m
├ ƒ /audit/queries                                     600 B         [37m[1m104 kB[22m[39m
├ ƒ /browse                                            205 B         [37m[1m107 kB[22m[39m
├ ƒ /calculators                                     1.57 kB         [37m[1m108 kB[22m[39m
├ ƒ /calculators/abcd2                               2.57 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/abg                                 4.99 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/alvarado                            2.41 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/curb65                              2.05 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/egfr                                2.94 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/heart                                  3 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/hyponatremia                        5.68 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/news2                               3.85 kB         [37m[1m114 kB[22m[39m
├ ƒ /calculators/nihss                               4.27 kB         [37m[1m115 kB[22m[39m
├ ƒ /calculators/qtc                                  2.6 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/sepsis-bundle                        4.9 kB         [37m[1m111 kB[22m[39m
├ ƒ /calculators/sofa                                3.55 kB         [37m[1m114 kB[22m[39m
├ ƒ /calculators/timi                                2.19 kB         [37m[1m112 kB[22m[39m
├ ƒ /calculators/wells_dvt                           2.46 kB         [37m[1m113 kB[22m[39m
├ ƒ /calculators/wells_pe                            2.39 kB         [37m[1m113 kB[22m[39m
├ ƒ /care                                              178 B         [37m[1m107 kB[22m[39m
├ ƒ /care/[uid]                                      12.5 kB         [37m[1m124 kB[22m[39m
├ ƒ /care/briefs                                     2.82 kB         [37m[1m109 kB[22m[39m
├ ƒ /care/concepts                                   4.48 kB         [37m[1m239 kB[22m[39m
├ ƒ /care/login                                        982 B         [37m[1m104 kB[22m[39m
├ ƒ /care/lvc                                           6 kB         [37m[1m241 kB[22m[39m
├ ƒ /care/m/[uid]                                    25.3 kB         [37m[1m137 kB[22m[39m
├ ƒ /care/readmissions                               5.21 kB         [37m[1m112 kB[22m[39m
├ ƒ /care/review                                     9.91 kB         [37m[1m113 kB[22m[39m
├ ƒ /care/triage                                     11.2 kB         [37m[1m114 kB[22m[39m
├ ƒ /care/triage/health                              4.65 kB         [37m[1m108 kB[22m[39m
├ ƒ /coach                                           5.91 kB         [37m[1m171 kB[22m[39m
├ ƒ /concordance                                     4.43 kB         [37m[1m108 kB[22m[39m
├ ƒ /ddx                                             9.37 kB         [37m[1m182 kB[22m[39m
├ ƒ /drugs                                           8.86 kB         [37m[1m119 kB[22m[39m
├ ƒ /knowledge                                       3.29 kB         [37m[1m110 kB[22m[39m
├ ƒ /learn                                             205 B         [37m[1m107 kB[22m[39m
├ ƒ /practice                                        3.08 kB         [37m[1m106 kB[22m[39m
├ ƒ /review                                          4.75 kB         [37m[1m108 kB[22m[39m
├ ƒ /search                                            600 B         [37m[1m104 kB[22m[39m
└ ƒ /topics                                           3.4 kB         [37m[1m107 kB[22m[39m
+ First Load JS shared by all                         [37m[1m103 kB[22m[39m
  ├ chunks/3636-b8d66f842f910767.js                    46 kB
  ├ chunks/4bd1b696-100b9d70ed4e49c1.js              54.2 kB
  └ other shared chunks (total)                      2.95 kB


ƒ Middleware                                         [37m[1m34.5 kB[22m[39m

ƒ  (Dynamic)  server-rendered on demand


[exit status: 0]
```

---

## Generated-file check: did any generator modify a tracked file?

```console
$ git status --porcelain lib/architecture/map.generated.ts data/reasoning-registry/prompts.generated.json

[exit status: 0]
```

---

## Tree state at the end of the gate

```console
$ git status --short

[exit status: 0]
```

---

# Result

```text
1  npm test                                        exit 0    PASS
2  npm run typecheck                               exit 0    PASS
3  npm run build                                   exit 0    PASS
4  npm run architecture:check                      exit 0    PASS
5  npm run architecture:map                        exit 0    PASS
6  git diff --exit-code map.generated.ts           exit 0    PASS   byte-identical
7  reasoning:registry + git diff --exit-code       exit 0    PASS   byte-identical
8  npm run reasoning:governance                    exit 0    PASS
9  npm run changelog:coverage                      exit 0    PASS

A  unkeyed production build                        exit 1    PASS   refused, and named the variable
B  keyed production build                          exit 0    PASS
```

**No generator modified a tracked file.** Commands 5 and 7a rewrote
`lib/architecture/map.generated.ts` and `data/reasoning-registry/prompts.generated.json` in place,
and commands 6 and 7b confirm both are byte-identical to what is committed at this HEAD. There was
nothing to restore and no `git checkout` was required.

The tree is clean apart from this evidence file and the governance documents being tracked in the
same commit as it.
