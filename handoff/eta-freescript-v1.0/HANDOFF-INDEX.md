# HANDOFF-INDEX: eta.freescript.v1.0

Bundle: `handoff/eta-freescript-v1.0/` (84 files including this index). Schema version `eta.freescript.v1.0`, superseding `eta.freescript.v0.1` (29 Sep). Built 17 Oct 2026. Every artifact in the bundle is invented; no real patient, doctor, room, encounter or Pulse id appears.

## Files and sha256

This index cannot hash itself, so it is not listed. Verify with `sha256sum <file>` from the bundle folder. "Audience" says who the file is for; only `DESIGN-RATIONALE.md` stays inside ETA.

| File | Bytes | sha256 | Audience |
|---|---|---|---|
| README-FOR-PULSE.md | 12733 | `7e5a16d71d1b05ac2a92e51a5676ee989263248847688d333872eb5ce86f1e84` | Pulse |
| CHANGELOG-v0.1-to-v1.0.md | 5770 | `e279d9bcd2d5424dcdb38b8a0da0d11063001c6b710989dd5c88b2c4ba7364b0` | Pulse |
| eta-freescript-artifact.v1.0.schema.json | 40662 | `16397485900366aad7b8912c9d6e1fccff40bf48c287705b5fe0267f909f228b` | Pulse |
| validate_artifact.py | 30558 | `10b318291d2109fe2f110a33da1bcd9403421d699333272a2b3ed86f97c3835e` | Pulse |
| run_checks.sh | 1327 | `01436e851b4224430bfc508270c2cd57bedc65168bf02ae42c46f9cf4a79afc6` | Pulse |
| DESIGN-RATIONALE.md | 20631 | `4cca252eedc3296cc53ea4e121c1878825c1145a55061c67038d9e1d7edfef77` | ETA-internal |
| data/brand_generic_min.json | 1982 | `f04137b9d9d160ed92a5c2c640ba058f7dc5358fbc870ce9d9c6b3538d0d6da6` | Pulse |
| data/frx_n1_phrases.json | 2519 | `d774c59287eda4d1da72c216b14c921d8a6a0f07516fb4012c359c3d71e82b75` | Pulse |
| data/lasa_pairs.json | 847 | `42640c038f3e6caf5ffa32196765a65a67b920023fd7a8df472689de99a1a90c` | Pulse |
| data/qualifier_words.json | 1594 | `657581f30e16125af4d37944ff08880681b0cfe67c46d1c9eb185e2f04e49a7d` | Pulse |
| examples/build_examples.py | 35343 | `34d440ff937aae8b58654f53b195109dd8685ed11886d037448fcbb6afce7093` | Pulse |
| examples/ex1-fever-patient-own-drug.json | 18208 | `448c4273ef97fecf87ea441f17ef7ce15803aac54bc70b3744e4de3d75a1fb59` | Pulse |
| examples/ex2-negation-no-antibiotic-no-xray.json | 18185 | `93c3de13991cb5bdba550e5d9935bac6dcc19b35a165e7d1b3074a026771d214` | Pulse |
| examples/ex3-stopped-glimepiride.json | 22294 | `e57264f2b98f8c3f5e93c60cf43314e8a1ddee944f2e525ae1533cc5c4751893` | Pulse |
| examples/ex4-fluid-room-translator-relay.json | 17652 | `0a43dec2a16263c2aa1c35aa24283b91f0ff11aae4e7587dec4b2386e625f730` | Pulse |
| examples/ex5-staff-voice-voiceprint-conflict.json | 14249 | `1e0c73edb06c48645e7c2088cc10b1c645114900bb67b9802597b0c3f94fd211` | Pulse |
| examples/ex6-combination-lasa-red-flag.json | 19687 | `3dc74fbfc35d1a4e261a449b9a1178cd318c4bf7ad18249fbf7368a97ab942bc` | Pulse |
| examples/ex7-withheld-no-role-track.json | 2614 | `29a3233e6c3641ac0dbae2da708d92f46fc321b5bba9110acecbef897bf5dbbd` | Pulse |
| tests/build_mutants.py | 17135 | `9f5699c0cb95d404217c60ba92a04fe973ade3cf9893440ad4435e7c099298c9` | Pulse |
| tests/expected.tsv | 2465 | `fc7b99804fe38e28233c5df6debeef7197accb9dd2a4a4d675e7918c929f38ec` | Pulse |
| tests/mutants/V0_bad_duration_unit.json | 22296 | `cc8d4a5d4c62368ad5ffa41d89422b9d3379deeb327d6e7da5948e85c9773e8d` | Pulse |
| tests/mutants/V0_control_hours_unit.json | 22294 | `1fb0bd46114357204d5b71de138b665793d701f45cebe7b97f91cd87340bc916` | Pulse |
| tests/mutants/V10_advice_over_budget.json | 19865 | `2474c1c0b84501b446cb139ad9898838af697f5c566a6b07546886459f29ed7e` | Pulse |
| tests/mutants/V10_control_budget_full.json | 19839 | `bce12eaa36c90852850fe90b2c459451603324959e16524ff43844b2f72e65ff` | Pulse |
| tests/mutants/V10_red_flag_not_first.json | 19687 | `e4ac9ffd40d926772482b6ff93541640379c3aa9a832561a29df1861e477d43b` | Pulse |
| tests/mutants/V10_red_flag_trimmed_by_budget.json | 19501 | `fe13ce93fd1602c4106333ce96cf405cd37f867e66e4b44ac0afaeada4e8167e` | Pulse |
| tests/mutants/V11_control_round_brackets.json | 18222 | `116c730bc8cc07d2dc8882cd4d73e7922fec8022f83c857acb85be12616a5a73` | Pulse |
| tests/mutants/V11_frxn1_phrase.json | 18172 | `ca0657bc9389dff21503688c7b2cd8b007affc632588a996b6bdf1e3d16ca820` | Pulse |
| tests/mutants/V11_missing_value_only.json | 18116 | `df8cb33ed0c0b3757cee73edadd0d67e74f3ca90cfcff9cc07e7bdd45b93a124` | Pulse |
| tests/mutants/V11_repr_in_symptoms.json | 18228 | `c4d6b7493df88d5f8f6d801c8fc8ccbf5da544af3d64bfc38d5179d3761c5557` | Pulse |
| tests/mutants/V11_tbd.json | 18128 | `22341ff61ecb21b4fe07bf00182c0e69a2a3bc756caf6fcfd71c7e93be6f48e5` | Pulse |
| tests/mutants/V12_cited_span_outside_window.json | 18208 | `b57e616968743fb169cc79a43bae872e68a018cbd5a526bd22c32b39a8ed5160` | Pulse |
| tests/mutants/V12_cited_span_quarantined.json | 18207 | `4e68dbe94202e148f3437cc0f1e00e906d8a76c3ad9f657a7fc62b334e474f9b` | Pulse |
| tests/mutants/V12_cited_span_unresolved.json | 18209 | `f01c6d0358603cdc7d3b1b765ca2cec84b2aae8f7a68fe4e57bcb5bf7451ec07` | Pulse |
| tests/mutants/V12_control_uncited_span_outside.json | 18629 | `a11d0a42b6f152e16f3bd8e53f93a7ee0123eeabf110333cb34a5238a8df14da` | Pulse |
| tests/mutants/V13_control_gate_off_3of3.json | 18211 | `ff3f7dc6d5ab7d93931ed13a2e619584e24de57df4edcae7066fcb5aec342a22` | Pulse |
| tests/mutants/V13_gate_off_armc_contributing.json | 18211 | `1d82302f2e340852e66697c2a20398413d618b80972e91ecba6c86b820401713` | Pulse |
| tests/mutants/V13_gate_off_armc_only_label.json | 18199 | `d602384be0ee319801611404589c4e509e3b564715a280e0b203411553d70b5d` | Pulse |
| tests/mutants/V13_translator_order_capable.json | 17648 | `8904b9c2e56763b5a46cc0e497d0349b7f3fbbda62b6b657e9c750e3742022aa` | Pulse |
| tests/mutants/V13_two_order_capable_labels.json | 17651 | `085bae337538da3ff33bb167446bff86de93939f5ae47a68b9bbdc6ca365c714` | Pulse |
| tests/mutants/V13_voiceprint_conflict_ignored.json | 14246 | `c89f1703dfddf78f485563ba494fe491865bfbf78d1a8e1e064136b7720e3d88` | Pulse |
| tests/mutants/V14_acid_reflux_matched_to_folic_acid.json | 18199 | `660d4eed78fda2786baa049ee0e3cfd8aecbaefb003e58b245944101b08c398a` | Pulse |
| tests/mutants/V14_base_molecule_wrong.json | 18181 | `0d4287a3421591c62d62d8f24637f14e93a4ede5fc34add934a3f02491dd7dfa` | Pulse |
| tests/mutants/V14_control_folic_acid_spoken.json | 18198 | `378b46fb38a0255ca250ce4636558905c44ba85a4002948e3e2df6e9215cd10c` | Pulse |
| tests/mutants/V14_control_unattested_combination_unexpanded.json | 19326 | `4fc94962721fe0cef4738cb4034068cbad07d489d298c46a59f0e3666bc615a6` | Pulse |
| tests/mutants/V14_lasa_unflagged.json | 19652 | `c7f6f8bb7d188322e0076caef3b333583ce1914125ef4bd04a761b99a8f50cfd` | Pulse |
| tests/mutants/V14_unattested_combination_expanded.json | 19427 | `d74d6102d6f7989b3da48cf158c6161195e996d8d3c0741b68a0c09559c73aac` | Pulse |
| tests/mutants/V15_full_without_note_text.json | 17651 | `2b5848dbe8c9d8bccf4649c70c75e03055c30dc3c3f405ffeaecef3bf5033a3b` | Pulse |
| tests/mutants/V15_withheld_with_gp_content.json | 2651 | `159958640585c7f680a52efb512a5f01d6e47ce182cf40c4bcc4a8598b81b6c4` | Pulse |
| tests/mutants/V15_withheld_with_note_text.json | 3171 | `e2e3b4141dff6ffc63da0dc055d186f9d99acff63a13a548933ce32b2df977b2` | Pulse |
| tests/mutants/V15_withheld_without_reason.json | 2587 | `25f7c3a85a9b403f8dfd8e569bdc3257fe02b58bd1425231a0a95b6781217fb6` | Pulse |
| tests/mutants/V16_model_id_placeholder.json | 18176 | `78555569d096c56e1e100615a2cccadf361cb009409e7fb9ffe544a192e9b827` | Pulse |
| tests/mutants/V16_models_served_empty.json | 18138 | `db609953bc639abc238a6e8bd99ac6c54818729aa74dcf446ad831ffa062513c` | Pulse |
| tests/mutants/V16_models_served_mismatch.json | 18175 | `eebc16d12564984cd10c167f6c04dd92d3bd8d898e5473bb137b0bdd500d07f7` | Pulse |
| tests/mutants/V1_control_provenance_reordered.json | 18208 | `e5ffef02be7a56b99e3f42ff876b9bba621df795cb7b219aa855f5cc3a10bead` | Pulse |
| tests/mutants/V1_pointer_claimed_twice.json | 18205 | `7d5cafe960751679d72de6dbcd6bb2e281fe744b7ccc313781329e241965abc3` | Pulse |
| tests/mutants/V1_pointer_unresolved.json | 18208 | `2a48705cbb3a1c5011be72c8abfa0f7796d1ebc5f5bddc42543fd2a9511fe887` | Pulse |
| tests/mutants/V2_counts_mismatch.json | 18208 | `7293003d7d5247a24f31a3e542a11790752342c217532fa79701c3c16e570ac0` | Pulse |
| tests/mutants/V2_entry_without_provenance.json | 21802 | `94a9e2c39ea65433496c12269da566e3326262d283003ac9810a0a335c3f5a97` | Pulse |
| tests/mutants/V2_prompt_without_provenance.json | 21830 | `992860cb56bffc5b16670b8148e1b1c9493e9663a2214820693a74074772e5fe` | Pulse |
| tests/mutants/V3_control_unrelated_test.json | 19287 | `280d3acd52143ec533b401469e778d533a53b4b19e67b6d240d26d40c10aeb83` | Pulse |
| tests/mutants/V3_notgiven_test_in_list.json | 18895 | `7ad490ac067dc63db22e2fb79191c1db35cd1d6642c219e620e7b93c343156f6` | Pulse |
| tests/mutants/V4_control_keptout_without_spans.json | 18188 | `8b9aadf326b526fb93ceb4ba9adf62619a8ea0f9406f9ec524461ebc94cac6c9` | Pulse |
| tests/mutants/V4_posted_without_spans.json | 18188 | `d1a5f108bc430ae283a2f55e9c45533dae7ef15725afc99a337df8aa31504ba9` | Pulse |
| tests/mutants/V5_bad_heading.json | 18208 | `3a940666f1b1e2d57221faf30c6fed8a14f5a56426b59c32131a3791407cb53a` | Pulse |
| tests/mutants/V5_heading_twice.json | 18219 | `78b78b88c7c0d8ad25624eeb26c19fbfd1791e8ec6db009336cac3c07bda413b` | Pulse |
| tests/mutants/V6_draft_line_missing.json | 19616 | `54cde573d067f8b080991f0d0616b01cf701bf1a566b008e159abe476d4f7272` | Pulse |
| tests/mutants/V6_extra_investigation_line.json | 22309 | `0222a770b667f91fe8f2edb81f94061d5fcb576b396de65fed814925544dcba0` | Pulse |
| tests/mutants/V6_medication_line_as_order.json | 18233 | `6961e938e5c1afbb9e4fa26618c1600f4ed7eccb16f0ebdd3d7fe5f06e51e9e2` | Pulse |
| tests/mutants/V7_medicine_in_gp_extraction.json | 18454 | `66b23a0c815bb2315f8529004b71957e5761ac1faab5d756eb69ff639a84dadf` | Pulse |
| tests/mutants/V7_medicine_provenance_without_prompt.json | 22294 | `7dbcfa0e2d93e3ac36bd3994207aa5e8613b5ca2c536533cbd1c3e5d064feea5` | Pulse |
| tests/mutants/V8_affirmed_from_patient_supports_dose.json | 18196 | `f05131d6d335fe50d0d777428b92a28e07f8879f3e9fa61eae75912c9205cde3` | Pulse |
| tests/mutants/V8_control_relay_cited_with_doctor.json | 17666 | `fe5c3b9454df58c9e491aebf9bb2d5685018921842312bfb7bc8a63455931838` | Pulse |
| tests/mutants/V8_patient_span_supports_frequency.json | 18208 | `943c1fcdbea90fece643df1698fa111b71c3408a415f00b661870d5a23c52508` | Pulse |
| tests/mutants/V8_posted_unsupported.json | 14250 | `8f51ef9847918bf55d2ea5fec1bbb6f4f4ab26bacaabb735809b7c1217fd869b` | Pulse |
| tests/mutants/V8_translator_created_order.json | 16694 | `68f5b0405c2553f9c1d3b415816d09ac9af16d9ae20c8c9ebf018497a1e87f5e` | Pulse |
| tests/mutants/V9_brand_alias_of_stopped_drug.json | 22316 | `e0394565a1dbd18f0c9f85976c5731eb64bb354562b74ff00de3f8a6288e49fd` | Pulse |
| tests/mutants/V9_control_lime_juice.json | 22334 | `16c6564d634884a83f4962e787b62ee14093fe01a1a9f0ef2f6e16bf584ea118` | Pulse |
| tests/mutants/V9_notgiven_test_named_in_plan.json | 18217 | `f0d5dedd5539e725d55d776d358ad39f9c13370cb0d294f01aaedc0f67adf8ea` | Pulse |
| tests/mutants/V9_plan_line_missing.json | 22190 | `cbef67638019c22cae261b439aca642754356fa61328cb98b67029375359abdd` | Pulse |
| tests/mutants/V9_split_spelling_of_stopped_drug.json | 22344 | `67eb10495219e50953bb7a224d166cd1d3acb4b65d63b6add78faf042d17259c` | Pulse |
| tests/mutants/V9_stopped_drug_named_in_plan.json | 22330 | `a20c8751aba42aa0369ce6632cdd8ed91666c55309f8815d10710fccedf0dca3` | Pulse |
| tests/run_mutants.py | 1399 | `5064a343b6570f3024c8110f005fdb0378115f365dc2705ceeb1da8c985aaf86` | Pulse |

## Excluded

These are deliberately not in the bundle:

| Excluded | Why |
|---|---|
| Any real artifact, transcript, audio, span quote or note | Patient and doctor data. The bundle is synthetic only. |
| Any real `pulse_link` id (individual, hospital, consult, prescription, doctor uid) | Every id in the examples is null or an all-zero placeholder. |
| Review scores, cohort metrics and PDQI-9 results from real consults | Not for the Pulse-facing bundle. The design figures stay in ETA-internal documents. |
| The generator code (`tools/eta2freescript/`), its prompts and its run outputs | Not part of the contract; Pulse needs only the artifact shape and the validator. |
| Real model, STT and MT names and provider details | Examples use invented `example-*` names; real artifacts carry the served ids read back from calls. |
| `DESIGN-RATIONALE.md` (in the folder, but not sent to Pulse) | ETA-internal: holds internal reviewer names and real-review figures. |
| `__pycache__/` and other build leftovers | `run_checks.sh` sets `PYTHONDONTWRITEBYTECODE=1`; nothing else is written to the folder. |

## Privacy sweep

The v0.1 sweep regexes were not available in the repo, so the sweep was re-defined (twelve patterns) and run over every file in the folder, including the mutants.

| Sweep | Pattern (Python regex) | Hits | Explanation |
|---|---|---|---|
| S1 email | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | 0 | none |
| S2 Indian phone | `(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)` | 0 | none |
| S3 UUID | `\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b` | 69 files | Only the seven invented ids `00000000-0000-4000-8000-00000000000N` (N = 1 to 7): one per example and one per mutant, which copies its base example. |
| S4 10+ digit run | `(?<!\d)\d{10,}(?!\d)` | 70 files | The same all-zero UUID tail (`00000000000N`) and the all-zero 64-digit placeholder hashes (`code_sha256`, `prompt_sha256s`); in `build_examples.py`, the id template `00000000-0000-4000-8000-00000000000%d`. No other digit run. |
| S5 hex id 20+ | `\b[0-9a-f]{20,}\b` | 69 files | Only the all-zero placeholder hashes, three per example or mutant. |
| S6 document-id shape | mixed-case letters and digits, 20 to 28 characters | 0 | none |
| S7 uid with a value | `"\w*_?uid"\s*:\s*"` | 0 | Every `*_uid` field is null. |
| S8 Aadhaar shape | `\b\d{4}\s\d{4}\s\d{4}\b` | 0 | none |
| S9 URL | `https?://\S+` | 1 file | The schema's `$schema` (json-schema.org) and `$id` (`https://eta.lab/schemas/...`, a non-resolving namespace id, unchanged in form from v0.1). |
| S10 honorific + name | `\b(?:Dr\|Mr\|Mrs\|Ms)\.?\s+[A-Z][a-z]+` | 0 | none |
| S11 real model or vendor name | gemini, gpt, claude, sonnet, opus, haiku, whisper, sarvam, bedrock, vertex, openai, anthropic, deepgram | 0 | Examples use `example-model-a-2026-10`, `example-stt-a`, `mt:example-mt-model`. |
| S12 internal agent name | fable, newcat, cloudpane, refuter, scout, orchestrator | 1 file | `DESIGN-RATIONALE.md` only (the verbatim design and its byline); it is ETA-internal and excluded from what Pulse receives. Pulse-facing files have none. |

The sweep also confirmed that no example or mutant quote contains a person's name: speakers are `speaker_N`, rooms are `EXAMPLE-ROOM`, encounters are `EXAMPLE-ENC-N`.
