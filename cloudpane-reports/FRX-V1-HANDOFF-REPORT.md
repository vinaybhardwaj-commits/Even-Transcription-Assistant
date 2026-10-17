# FRX-V1-HANDOFF-REPORT (cloud-frx-v1-handoff, 17 Oct 2026)

Serving model: `claude-opus-5-5` (read back from get_session: session_context.model and last_served_model).

Branch: `cloudpane/cloud-frx-v1-handoff/v1` (no main, no PR). Bundle commit: `d33c8892` (build `6d43cf59`, docs `d33c8892`); this report is the next commit.
Path: `handoff/eta-freescript-v1.0/` (84 files). `tools/eta2freescript` untouched. Inputs read from `origin/cloudpane/cloud-frx-r2-build/r2` @ `fd65cdc6`.

## Files (sha256; all 83 per-file hashes are in HANDOFF-INDEX.md and were re-verified 83/83)
- `7e5a16d71d1b05ac2a92e51a5676ee989263248847688d333872eb5ce86f1e84` README-FOR-PULSE.md
- `e279d9bcd2d5424dcdb38b8a0da0d11063001c6b710989dd5c88b2c4ba7364b0` CHANGELOG-v0.1-to-v1.0.md
- `4cca252eedc3296cc53ea4e121c1878825c1145a55061c67038d9e1d7edfef77` DESIGN-RATIONALE.md
- `5c93b1eaf6bbb93c3969286decc331d1bf4eae309a4b408481e0ff2872ae123e` HANDOFF-INDEX.md
- `16397485900366aad7b8912c9d6e1fccff40bf48c287705b5fe0267f909f228b` eta-freescript-artifact.v1.0.schema.json
- `10b318291d2109fe2f110a33da1bcd9403421d699333272a2b3ed86f97c3835e` validate_artifact.py
- `01436e851b4224430bfc508270c2cd57bedc65168bf02ae42c46f9cf4a79afc6` run_checks.sh
- `f04137b9d9d160ed92a5c2c640ba058f7dc5358fbc870ce9d9c6b3538d0d6da6` data/brand_generic_min.json
- `d774c59287eda4d1da72c216b14c921d8a6a0f07516fb4012c359c3d71e82b75` data/frx_n1_phrases.json
- `42640c038f3e6caf5ffa32196765a65a67b920023fd7a8df472689de99a1a90c` data/lasa_pairs.json
- `657581f30e16125af4d37944ff08880681b0cfe67c46d1c9eb185e2f04e49a7d` data/qualifier_words.json
- `34d440ff937aae8b58654f53b195109dd8685ed11886d037448fcbb6afce7093` examples/build_examples.py
- `9f5699c0cb95d404217c60ba92a04fe973ade3cf9893440ad4435e7c099298c9` tests/build_mutants.py
- `5064a343b6570f3024c8110f005fdb0378115f365dc2705ceeb1da8c985aaf86` tests/run_mutants.py
- `fc7b99804fe38e28233c5df6debeef7197accb9dd2a4a4d675e7918c929f38ec` tests/expected.tsv
- `88d989334c189eb15cc112cebb60fb3e57e066af5b561379558fba7425586297` digest of `sha256sum examples/*.json` (7 files)
- `6aa675e2b8cb6a11b9233186b8c73c87db3c657536981c69f60d9d685dc5872c` digest of `sha256sum tests/mutants/*.json` (62 files)

## Checks (`./run_checks.sh` exit 0, python 3.13.16, jsonschema 4.26.0)
- Examples: 7/7 valid (ex1–ex7, including the ex7 withheld record).
- Mutants: 62/62 rows match expected.tsv (49 fail rows each naming its V-rule, 13 pass controls; at least 2 per V0–V16). All 15 required mutants present.
- build_examples.py and build_mutants.py are deterministic: rebuilt output is byte-identical (7 examples, 62 mutants plus expected.tsv).
- Schema passes Draft7 check_schema. `gp_extraction` sub-schemas equal v0.1 except LlmDuration.unit (+YEARS, HOURS) and the GPLlmExtraction description text.
- Privacy sweep (12 regexes): hits are only the all-zero ids and hashes, the schema's `$schema`/`$id` URLs, and internal names in DESIGN-RATIONALE.md (ETA-internal). An internal branch and agent name found in `data/` source strings was scrubbed before the docs commit.

## ASSUMPTIONs (full text in DESIGN-RATIONALE.md)
- A1 The v0.1 README and index are not in the repo; their style and the sweep regexes were reconstructed.
- A2 Provenance `evidence`, `speaker` and `speaker_source` are replaced by `cited_spans`; `names` and `confidence` stay optional.
- A3 Spans add `boundary_quarantined` and `relay_of` (on the translator span).
- A4 3/3 means all votes are treating_doctor; arm (c) names a label when state=pass; case7 means every armc state is off.
- A5 A doctor span is one with role treating_doctor or other_clinician.
- A6 doctor_words cite an order-capable span in every room.
- A7 A discussed-only home drug is a `continue` prompt (patient_reported) and is listed in Medication.
- A8 A not-given investigation is a prompt; V3 and V9 cover every held order kind.
- A9 change_dose is not listed; no draft line when there is no start or continue prompt.
- A10 Strength is omitted when the brand already carries it; an unexpanded combination renders the brand.
- A11 FRX-N1 d1, d2 and d4 are exempt in Medication; d4 is reduced to its regexes.
- A12 The budget counts items after the red flags.
- A13 taped_draft is in the schema, but V7 rejects posted medicines under it.
- A14 A supported value must be heard on an order-capable cited span.
- A15 The reason enums are closed.
- A16 V14 also checks base_molecule and attested combinations.
- A17 The LASA list holds 8 pairs from the named groups; the 16 L2 pairs are not in the repo.
- A18 qa floors and counts are re-checked under V2, V8, V10, V11, V12 and V16.
- A19 Model, STT and MT names are invented; ex7 records one served model.
- A20 Schema failures print as V0; V5 rejects stray heading lines.
- A21 GPLlmExtraction description text is updated.
- A22 In ex5 the staff label votes 3/3 doctor.
- A23 The brief's branch rule was used over the session default.

## Not done / limits
- No live data was used (by rule); nothing was run against Pulse. FreeScript review is for the lead.
