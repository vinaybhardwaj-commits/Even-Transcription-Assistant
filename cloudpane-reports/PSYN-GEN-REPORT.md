# PSYN-GEN-REPORT: P-SYN script generator, text side (cloud-psyn-gen, 17 Oct 2026)
Model serving this session: claude-opus-5-5 (get_session: session_context.model and last_served_model).
Branch `cloudpane/cloud-psyn-gen/v1`. Code commit `eb08e73`; this report is the commit after it. No PR, main untouched.

## What was built
`eval/pdqi9/psyn/`: `schema.py` with 5 JSON Schemas (script, truth, twin, enrolment, manifest; checked in under `schemas/`), one generator module per stratum under `strata/`, `truth.py` (A4.4 truth sheet with per-attribute expected labels, variants and claims), `twin.py` (code-built note, plus S-N defect twin), `split.py`, `config.json`, CLI `python -m eval.pdqi9.psyn build --out DIR --seed N` and `validate DIR`.
One build is 812 files (25 MB): 252 x (script, truth, twin), 54 S-N `twin_defect.json`, `enrolment/pseudo_doctors.json`, `test/README.md`. The manifest holds a sha256 for every file. At the default seed 20261017 the manifest sha256 is `cbf130d3...ec59f50`.

## Totals (default seed; split_seed 7090252)
| Stratum | n | dev | test |
|---|---|---|---|
| S-E | 54 | 18 | 36 |
| S-N | 54 | 18 | 36 |
| S-C | 12 | 4 | 8 |
| S-R | 30 | 10 | 20 |
| S-D | 20 | 6 | 14 |
| S-A | 10 | 4 | 6 |
| S-V | 54 | 18 | 36 |
| S-M | 18 | 6 | 12 |
| Total | 252 | 84 | 168 |
S-V mix: 12 covering, 12 translator (4 faithful, 4 changed dose, 4 added item), 8 staff, 8 attenders (3-4, overlapping, 2 with a distressed attender), 14 voice-alike pairs. S-M mix: 6 patient, 4 attender, 4 junior, 4 translator. The [v7] route, frequency and duration rule is planted in all 6 patient scripts and 2 attender scripts. Claims: 1,512 present and 504 decoy, exactly 25% in every script. Each S-V script has 28 treating-doctor segments, so S-V test holds 1,008 (the sizing note asks for at least 900).

## Tests
`python -m unittest discover -s eval/pdqi9/psyn/tests -t .` ran 23 tests, all passing (18 s). `validate DIR` reports 0 errors. Coverage: same seed gives byte-identical output; another seed changes the content but not the split; stratum and split counts; S-E/S-N grid; pairs stay together and match; S-D strength coverage; the S-V trap mix; S-M merged items and their labels; S-R traps; all 7 medicine attributes; variants v1-v5 with only v1 primary; 25% decoys; enrolment never overlaps a consult (5-gram check); denylist (107 names) with negative controls; JSON Schema validation of every file plus a schema-rejects test; checked-in schemas match; tamper detection; the test-split guard.
Repo gate: not run. This sandbox has no node_modules and no Swift toolchain, and the change is Python only, outside the TS and Swift apps.

## Ambiguities and choices
- ASSUMPTION: the brief's branch rule (`cloudpane/cloud-psyn-gen/*`) overrode the harness default branch, so I pushed to `cloudpane/cloud-psyn-gen/v1`.
- ASSUMPTION: the spec fixes dev counts only for S-V and S-M, so the other strata get one third each. S-D is split 6/14 and S-A 4/6, so matched pairs stay together. Within each stratum, dev places are spread by largest remainder over cells (trap type, item x language).
- ASSUMPTION: `--seed` changes content only. The split comes from `split_seed` in config.json, so test membership is fixed.
- ASSUMPTION: S-R has 5 scripts per trap. Non-doctor drugs alternate between patient and attender. Clip bleed is 3 pre-clip and 2 post-clip.
- ASSUMPTION: in S-V covering scripts, the treating pseudo-doctor is present and logged in, and the junior is not enrolled. In voice-alike scripts, the partner is absent; under v2 the partner is the one logged in.
- ASSUMPTION: S-M uses the attender route/frequency/duration rule in exactly the minimum of 2 of the 4 attender scripts. The other voice says route, frequency and duration on a separate segment from drug, strength and dose. Other-voice order attributes allow {h_unattrib, unaligned} depending on the cited source (armc gives h_unattrib, none gives unaligned) and never supported. The ideal label is unaligned, because ideal role voters would contradict.
- ASSUMPTION: S-M keeps the other voice under 20% of the merged label's estimated seconds. Above that, A4.1a.5 turns arm (c) off for the whole unit.
- ASSUMPTION: a "short segment" is an estimate of 0.8 s or less, because the prereg minimum duration is not set. Estimated seconds are words / 2.6. All values are text estimates, not audio.
- ASSUMPTION: v2 logs in a random other pseudo-doctor. v5 login covers the first 60% of the window. v1 alone counts toward T1-T22; v2-v5 count toward T24/T28a/T28d only.
- ASSUMPTION: claims are 3 present to 1 decoy per script, with at most 6 present claims. Decoys are checked to be absent from the script text.
- ASSUMPTION: strata without a language grid alternate en / cs (hi, kn). In cs, doctor lines are English clinical phrases inside a Hindi or Kannada frame, and medicine attributes use native Latin-script forms. In translator scripts the doctor speaks English.
- ASSUMPTION: the FreeScript layout is not in this repo, so the twin uses neutral sections and cites turns. For S-N, `twin.json` stays ideal and `twin_defect.json` is the scored artefact.
- ASSUMPTION: the two S-A "2-2 split types" are taken to be state vs neutral and state vs another state.
- ASSUMPTION: S-D firm/hedged pairs are pairs of scripts that differ only in two flipped instructions. The reversal chain sits on a days-off-work advice item, and the final firm stance wins.
- ASSUMPTION: 32 pseudo-doctors (14 voice-alike pairs plus 4 singles), with 10 enrolment sentences each. The real count and duration are fixed in the prereg.
- UNVERIFIED: whether the S-E/S-N defect templates get rated at the planted level (1/3/5). T1/T2 on dev will show.

## Not done (out of brief)
No audio, TTS, vendor call, model call or database access. No real names or consult content.
