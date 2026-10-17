# ENCOUNTER-BRIEF v3 notes: delta-refute fixes, closed

Companion to `docs/freescript/ENCOUNTER-BRIEF-SPEC-v3.md` (17 Oct 2026). v1 and v2 stay unchanged. Per the refute, M1, M2, M5, M6 and S1-S5 were already closed in the text; this round closes N1, N2, N3 and S6.

## Closure table

| item | closed in v3 by | spec section |
|---|---|---|
| N1 unreachable M3/M4 rows | Clef names at most one label, so rule A and arm (c) each name at most one. A new standalone voiceprint field `v` (cosine plus both margins, no Clef or Jev rank) is tested against the order-capable label: any other label matching means nothing orders (case 5). The table is rewritten to the 7 reachable cases, and the unreachable rows are removed | §5.6, §6.3, §6.6 |
| N1 staff-voice fixture | Fixture 19 `synth-brief-staff-voiceprint` (case 5) | §10.2 |
| N1 no voiceprint match | Rule A alone, as today, logged `rule_a_only` (case 6); fixture 20 | §6.3, §10.2 |
| N2 Rx leak through Stage B | The demotion moves inside `apply_r1_ex` (`demote_all_medicines`), so R2's moved list is complete. R2's final-note check then covers Stage B, repair and fallback output. FRX-B1 independently scans the final `note_text` and every `gp_extraction` string | §8.2, §8.5 |
| N2 test | A Stage B note naming a demoted generic, its brand, a combination brand or an alias (unit test plus fixture 21); a moved-list completeness test | §10.1, §10.2 |
| N3 phase 0a buildable | Voiceprint source, storage, port source, consult set, the 6 exit checks and P-SYN strata are specified | §5.6, §12, PHASE 0a BUILD SPEC below |
| S6 eval exemption | The live lock is keyed on `posting_possible(entry, env)` (does the entry point hold a posting path), not on `--out` | §9.1, §10.1 |

## Found while fixing (state plainly)

- **D1 - v2's §8.5 order leaked medicines.** v2 ran the brief demotion before `apply_r1_ex`. But `apply_r1_ex` starts with `out[_MOVED] = []` (R2 branch `r1_floors.py:696`), so every brief-demoted drug was missing from the list that R2 uses for posted-string withholding and for the Stage B note check. v3 moves the demotion inside `apply_r1_ex`. This was the concrete path behind N2.
- **D2 - v2 contradicted the settled arm (c) rule.** v2 blocked a label whenever voter 1 or 2 called it non-doctor while arm (c) named it. That conflicted with "doctor = 3/3 OR arm (c)" and with v2's own fixture 2. v3 lets arm (c) stand alone (case 3) and logs `doctor_conflict` without blocking. **The lead should confirm** that OQ-5 ("unknown, no order") was meant only for 3/3-non-doctor against arm (c), which can no longer occur.

## Decisions for the lead

- **L1 - P-SYN split (default: dev split only).** PDQI-9 v6 keeps its P-SYN test split untouched until its S4. On that default, the 0a gate runs on the S-V and S-M dev scripts only (18 plus 6). Using the test scripts too (36 plus 12) needs the PDQI-9 owner's agreement.
- **L2 - Jev in 0a (default: no new Jev calls).** The default is that the lead-supplied code carries stored Jev answers for the real60. If it needs fresh Jev calls on real text, ruling D1b requires de-identifying non-doctors first, and production has no cleared de-id step. In that case 0a stops and reports.
- **L3 - Confirm the D2 reading of OQ-5.**

## PHASE 0a BUILD SPEC (for the Builder)

**Goal.** Produce `role_votes.v1` for the 16 Oct real60 and for P-SYN, and report the exit checks. No FreeScript change, no post.

**Inputs (all already on the box; no new secret, no service change):**
- The lead-supplied pdqi9 arm (c) and role-vote code, handed over by the lead. Port it; don't redesign it.
- The real60 uid list, supplied by the lead at build time as a box-local file. Never commit it.
- The palimpsest consult bundle per uid (`kit/reb/consult_bundle.py`), giving `diar_nemotron`, the role slots and `cutter_row.doctor_uid`.
- Timbre's per-clip Nemotron probabilities, ECAPA embeddings (`--nemotron-dir`, `--embeddings-dir` or `--slot-embeddings-dir`) and `voiceprints.json` (`tools/timbre/nightly_prepare.py:52`).
- Clef roles: `clef-roles.json` (`tools/timbre/role_clef.py:240`).
- Stored Jev answers (see L2).
- P-SYN strata S-V and S-M from the PDQI-9 P-SYN generator (`docs/pdqi9/PDQI9-E-SPEC-v6.md`, branch `cloudpane/cloud-pdqi9-v5/v6`), dev split by default (L1).

**Stop and report, building nothing further, if:**
- the centroids are not on the box;
- the lead-supplied code is missing;
- fresh Jev calls on real text would be needed (L2);
- the P-SYN generator does not exist as code.

**Method:**
1. Map bundle `speaker_N` to app `spkN` to Nemotron column, one-to-one in both directions; record `mapping.status`.
2. Recompute each label's cosine to the logged-in doctor's centroid with `tools/timbre/slots.py` (`cosine`, `align_labels`). Compute the next-label margin and the runner-up-centroid margin (cosine against every other centroid). Set the standalone `voiceprint.status`.
3. Clef's vote is doctor on the doctor_slot label and null on every other label. It is absent if the consult's clips disagree.
4. Jev's vote comes from the lead-supplied code. Its question set, question id and model go into `metadata`.
5. Compute arm (c), and the one-margin variant for exit check 1.

**Outputs:**
- `role_votes.v1.json` next to each bundle, mode 0600, never posted, never committed. Schema per spec §5.6.
- One counts-only report at the path the kickoff names, with no uids, no names and no text.

**Exit checks (all six are needed to pass):**
1. The one-margin counts reproduce 37/60 (3/3 alone, no confident doctor speech) and 15/60 (with arm (c)) exactly. Any difference is explained before 0a passes.
2. The both-margins counts are reported.
3. **Gate:** 0 labels wrongly made order-capable on P-SYN S-V and S-M. The 20 hand-checked real consults are reported only, not gated.
4. Mapping clean, ambiguous and failed counts are reported.
5. The all-prompt share is reported for each spec §9.2 row, plus the §6.3 case counts 1 to 7.
6. Zero posts. The CLI imports no HTTP client and no `tools.eta2freescript.nightly`, which a test asserts. A socket guard installed at CLI start refuses any outbound connection, and the report states `posts: 0`.

**Files to touch:**
- a new package `tools/role_votes/` (`__init__.py`, `build.py`, `mapping.py`, `cli.py`, `schema/role-votes.v1.schema.json`);
- `tools/role_votes/tests/` with synthetic fixtures only, covering mapping clean, ambiguous and failed, cos 0.649, both margins at 0.049, a one-centroid set, the Clef cross-clip disagreement, the case-5 staff voice, and the socket guard;
- a CI job beside `eta2freescript-tests.yml`.

**Do not touch:**
- anything under `tools/eta2freescript/`, because it would change the runner's `code_sha256` (OQ-12);
- `tools/timbre/slots.py` (import it, don't edit it), the frozen runner, nightly timers and posting routes, the DB and catalog ingest;
- the Mini or box services (Whisper, diarization, embedding);
- `.env*` files;
- any real uid, name or text in the repo.
