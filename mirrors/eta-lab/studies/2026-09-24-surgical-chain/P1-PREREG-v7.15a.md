# SURGICAL-CHAIN-LINKER P1: pre-registration v7.15a (linker, 24 Sep 2026; the git commit time is the timestamp): the name-leak gate for the translated stratum becomes a FULL READ, frozen BEFORE any patient text is sent to the translation route

Addendum to v7.15 (fa7d615); nothing earlier is edited. It **replaces only the sample size and seed rule of v7.15 M4 step 3**; every other v7.15 rule (route, prompt, order, screen, scoring, provenance, stratum, interim four) stands. **Class key sealed, no class join.** Origin: eta-refuter-2 offered to read every kept turn (bus #1319, workload his, conditions 1 to 3), after yoga-drain's known limit (#1306: the residual-identifier gate is shape-based, so a bare person name in a kept turn outside a 20-turn sample is not caught). Adopted here by the linker as a strictly stricter gate; Fable may veto it. At this commit the only call made to the translation route was the pre-flight (one invented line, no patient text; returned model `google/gemini-3.8-flash`, provider `Google`, ZDR-checked by eta-refuter-2 #1329).

## N1. What is read
- **Every kept turn:** the name-leak check is run on **all** turns of the translated files whose Gemini flag `q` is exactly `ok` and that are not marked dropped (the eligible set exactly as `link3_nameleak.py` defines it), for the 8 frozen items (`c004, c006, c011, c013, c014, c016, c023, c026`). No sample is drawn: `--n` is the eligible count, so the draw is the whole sorted set (item, room, i), and **the seed is irrelevant** and is not checked.
- **Minimum:** fewer than 20 eligible turns refuses (a short pool is a weak gate). The eligible count and the sha256 of the eligible keys are recorded in `draw.json` and copied into the summary.
- The 8 items expect about 134 turns to translate; the kept number is what the screen leaves, counted after the run.

## N2. Protocol (the B protocol, unchanged in shape)
1. After de-identification, `link3_nameleak.py draw` writes the review sheet (raw translated `en` beside `en_deid`) and the counts template, all 0600 in a 0700 dir, never in a git tree.
2. eta-refuter-2 labels every eligible turn **blind** (counts of missed names per turn, missed transliterated names included), **locks** his counts file (0600) and **posts its sha256 on the bus before any summary exists**. The linker's own read of the same turns is the other counts set.
3. `summary` runs with `--second-sha256` equal to the posted value; the gate is `PASS` only if **neither reader's total is above zero**.
4. **Any miss in either count fails the gate:** the redactor is fixed, `deid.json` is regenerated, and a **full re-read of the eligible set of the regenerated file follows** (there is no seed-28 recheck sample any more). Jev is not called until a full read is clean.

## N3. What `verify` enforces (a code delta made before `verify` is used, re-reviewed by eta-refuter-2)
`verify` replaces "n_turns is 20 and the seed is 27 or 28" by: the summary's `n_turns` equals the **eligible count recomputed from `deid.json`**, that count is at least 20, and the summary's `eligible_sha256` equals the hash of those eligible keys, so "every kept turn was read" is checked, not asserted. A short draw, a partial draw, or a draw over a different file refuses. The hash bindings, the residual-identifier gate and the pin check of `4b81da4` and `e0295b6` are unchanged.

## N4. The full read is also the real-text recall measurement
eta-refuter-2 and surg-deid report the miss counts **per identifier type with Wilson intervals over the full set** (surg-deid #1134). It measures the redactor; it gates nothing beyond N2 step 4.

## N5. Scope and what it does not change
- Scope: the 8 frozen items. Extending the translated stratum to all 19 language-limited items is Fable's Decision 1 and needs its own dated version (v7.16), which would inherit N1 to N4.
- The interim four (`c004, c006, c011, c013`) stay excluded from accuracy claims. The translated stratum is reported apart and never pooled. The residual-identifier gate still runs on every scored turn at `verify` and at `score`, as a shape check, not a name check.
- The MT step is unchanged: the script and prompt of v7.15 M2, at commit `e0295b6`, run first; the N3 code delta comes after it and before `verify`.

## N6. Disclosures
- Adopted after the pre-flight and before any patient text was sent; the run has not started. The rule change is prospective and stricter; no result exists that it could have been chosen to fit.
- The linker reads the sheet on the box (patient-derived text, never in git, never on the bus). Only counts per turn leave the box.
- A change to any rule above is a new dated version with its reason.
