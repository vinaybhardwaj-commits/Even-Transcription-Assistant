# HANDOFF-INDEX: eta.freescript.v1.0

Bundle: `handoff/eta-freescript-v1.0/` (151 files including this index). Schema version `eta.freescript.v1.0`, superseding `eta.freescript.v0.1` (29 Sep). Built 17 Oct 2026, fix round 1. Every artifact in the bundle is invented; no real patient, doctor, room, encounter or Pulse id appears.

## Files and sha256

This index cannot hash itself, so it is not listed. Verify with `sha256sum <file>` from the bundle folder. Every file here is for Pulse.

| File | Bytes | sha256 |
|---|---|---|
| README-FOR-PULSE.md | 15977 | `d6b9fc1d088bc4dfec04adc4809c07a9bf98c9e79584545a1f295fb8fe2cbb40` |
| CHANGELOG-v0.1-to-v1.0.md | 6301 | `ebf05272ba453388800e32b01c004a6612f9c889b1ea1a6ac7e17ca4dbb9f8aa` |
| eta-freescript-artifact.v1.0.schema.json | 40882 | `19393362a365fb600563ff81edce52a3b7ce057876cb233a95fde0b45a06ed92` |
| validate_artifact.py | 43157 | `08d463919c85ed097e8f5e87b48dd79758871e8c29fb545a866057a573198ca8` |
| run_checks.sh | 1327 | `01436e851b4224430bfc508270c2cd57bedc65168bf02ae42c46f9cf4a79afc6` |
| data/brand_generic_min.json | 5562 | `a28d4df0c9f669223e01a7666d0698c34d6cf8c78343e172b0ca7b254705cc78` |
| data/frx_n1_phrases.json | 3317 | `87782d85b998bfd3142670184d7ef3cc70554c78b0219a19c81429d8d0f1347f` |
| data/lasa_pairs.json | 845 | `bc482d8242689f7d30ba64fb686f51a1f355406442ddefb3eaab9bbc81737c5a` |
| data/medicine_names_min.json | 2510 | `7ef17d5a0bf6c54e2fcfa09ec94076ad78593477284c6b448667004f6ae38089` |
| data/qualifier_words.json | 1594 | `657581f30e16125af4d37944ff08880681b0cfe67c46d1c9eb185e2f04e49a7d` |
| data/salt_drugs.json | 658 | `7bd8aa76c9c6d5565fd6d7b1122d9526ba9130f4f1e82605e524a318c8cb9873` |
| examples/build_examples.py | 34075 | `1c31a6c6ec545a3835425e9b13c2d1a0671c4e86d6a5638adde8117224f06bc3` |
| examples/ex1-fever-patient-own-drug.json | 16674 | `ba442288aa179318ee125d81f04de6612d310db47b95c5544e34858acd9f9d93` |
| examples/ex2-negation-no-antibiotic-no-xray.json | 18185 | `93c3de13991cb5bdba550e5d9935bac6dcc19b35a165e7d1b3074a026771d214` |
| examples/ex3-stopped-glimepiride.json | 25385 | `289ec60eb15693734da474afa82142c90279eda6af61feda838f65a8ee67a75f` |
| examples/ex4-fluid-room-translator-relay.json | 17652 | `0a43dec2a16263c2aa1c35aa24283b91f0ff11aae4e7587dec4b2386e625f730` |
| examples/ex5-staff-voice-voiceprint-conflict.json | 14245 | `0f38d3dce7235eb3fb1b0a3d7cbdee4eba9db3fad8b4422d074dcecf4c6042fb` |
| examples/ex6-combination-lasa-red-flag.json | 19687 | `3dc74fbfc35d1a4e261a449b9a1178cd318c4bf7ad18249fbf7368a97ab942bc` |
| examples/ex7-withheld-no-role-track.json | 2614 | `29a3233e6c3641ac0dbae2da708d92f46fc321b5bba9110acecbef897bf5dbbd` |
| tests/build_mutants.py | 29328 | `d51ec5315e315002a52369e24dbf95182894fbe0b69849d481cb75f04a575961` |
| tests/expected.tsv | 5036 | `63e68e28d24de14e0773d8c8b896e2a3c86fe6d510fe3f953e0b18acaa11e5c9` |
| tests/mutants/M1_control_condition_named.json | 25417 | `a8b77b02a779b03ba315b4957b9c3e9d03b4fef63f7cc9cac4151d27dbd6c639` |
| tests/mutants/M1_heading_injection_line_break.json | 16738 | `87e8be5acc7c4d885c86cd488e13bb00af8b20ae3f0258cc3d21604acf45a808` |
| tests/mutants/M1_held_drug_in_diagnosis.json | 25423 | `b600c4dbc2db41f3494594cd436b9ca077516958b04b6a9431c047031b4ab824` |
| tests/mutants/M1_held_drug_in_raw_name_only.json | 25402 | `4d5a305df5612fdaad04899357d0578f9233b0308d13e85bb1574b90be7eb798` |
| tests/mutants/M1_medicine_in_comorbidity_without_condition.json | 25411 | `5a5bbaba1fccfe1c855662bae697dec9e2846e377403e48e5533dd43794cf179` |
| tests/mutants/M1_medicine_in_diagnosis_alias.json | 16700 | `63d8da59c41bc1dd51b8d96bc64abd08a64fd6a4497727e6e97ebfdd69b9e242` |
| tests/mutants/M1_medicine_in_examination.json | 18243 | `7cd8b2726f288ffcc846e59d2962a318256daa06d5abb78410f90ad14e75b913` |
| tests/mutants/M1_note_crlf_line_ends.json | 16696 | `29bdba7f619217974c485a21c7a6df4bbfe7f6e2b8ad152d5ff099feac841a4a` |
| tests/mutants/M1_note_line_differs_from_source.json | 16664 | `bf6f437f23192b1a4ffb94b722f5b4df2a6328507e056775af8adb845d9a2022` |
| tests/mutants/M2_accented_held.json | 25429 | `8d7fa903f598dd129a3bb5683c6bd0925895041b0906694b59ed21f4a428ecb4` |
| tests/mutants/M2_cyrillic_homoglyph_held.json | 25429 | `fe463069231b2f309e39acb2a59c81df076bc4a4d7aa2a01aed052b6b6ca3e65` |
| tests/mutants/M2_devanagari_held.json | 25477 | `eb4815b4273b00849f0f3f646ada0f051f707aad1781f67e7a41b862ca67a402` |
| tests/mutants/M2_dotted_held.json | 25447 | `5708ca09eefc5b20205c7e58767adcb8220fbe03bdb04e18a54e5fb586e8f7ba` |
| tests/mutants/M2_fullwidth_held.json | 25471 | `6d142265db67ff3e97c476543231bc3cc8d1e07a1e55d5452d7b34154c4c419a` |
| tests/mutants/M2_greek_homoglyph_held.json | 25429 | `437a4fcd43ca18911b0e2ac5eee2312ef66d5e621e0b34ffa66fe08ee22ec925` |
| tests/mutants/M2_hyphenated_held.json | 25429 | `0a2f4462649615123bfe3631f40a69d7387190ee597291648bea384c9596117d` |
| tests/mutants/M2_non_ascii_letter_in_note.json | 16676 | `46c78f3aea949b27a9ca022adb8add226991737709321d5ade11fe1ec97bcee9` |
| tests/mutants/M2_zero_width_held.json | 25433 | `a4726d4cc6676210e53a05a39cf3a20d8f1c7371a103f6db1314a538a14bd497` |
| tests/mutants/M3_combination_part_named.json | 20334 | `0aed4965f2c3810d838d6803ab8ea9cca76cc7d2aea57aa45f19f62f6f3ac5db` |
| tests/mutants/M3_control_pand_stop_unnamed.json | 25342 | `ceef78e1d147dd369830d1473a44d5ddcebc3734f943b5449a76308e06ee222e` |
| tests/mutants/M3_pand_stop_domperidone_named.json | 25384 | `5b35e2f3e9990efb469e68db2ac50818227d009fe5d01e98a6db63cd5b2577ad` |
| tests/mutants/M3_pand_stop_pantoprazole_named.json | 25386 | `097ce4f42ecda859f9029d5b5ef51f3103cc7d6585e305e86bb0b7701cfbe6a4` |
| tests/mutants/M4_red_flag_marked_without_entry.json | 16698 | `346bceb289e703487606bb62228735929aa72e6f7d3690773eb9764477303be2` |
| tests/mutants/M4_superseded_word_rendered.json | 19747 | `f1d0a1640455071a6e0fcb86c8338cb2786c930b9eb5f9c5df0e1dbc75ad2888` |
| tests/mutants/M4_warning_without_red_flag_entry.json | 19475 | `23c1b8aadfe819e746e34bd2f4ac97f9028bd57846f7a9f6de419edc4fd3d8e3` |
| tests/mutants/M5_affirmed_reason_supported.json | 25397 | `e4d27d302dbff00a05693eb789645e299e82d13e2de2b135314c6f37608ef7a4` |
| tests/mutants/M5_control_value_in_same_doctor_turn.json | 17112 | `9a13a9af25027ba9e22f39c417ee03ee2a4a9dc63bf90fb0dd01ce8d1013aa4c` |
| tests/mutants/M5_other_clinician_supports_order.json | 16674 | `70071187f92e5c63c08f1737985879632ed3423c6800474b1807afbf12646799` |
| tests/mutants/M5_value_on_span_not_naming_drug.json | 17510 | `4b38b275ce385db14e7c3ec53470ee3c39c56a571acb7fe7edff3b13adb974ae` |
| tests/mutants/M5_who_not_order_capable_supported.json | 14248 | `434e573d8d429651c4a0b94867d0c8069a72208a98af573f8b223a62ddccf6ff` |
| tests/mutants/M6_brand_missing_value_phrase.json | 16698 | `d3803498de820d55613990c9b90121f3a81c71274eb7d69447235351b718a3f5` |
| tests/mutants/M6_medication_line_dose_unknown.json | 19730 | `0601d9c7cd0cea828aa342fcc5cd64bc5f88e060cf051bfcdc872ec38a05e10e` |
| tests/mutants/M6_medication_line_question_mark.json | 19706 | `3161b407f99b5257d9c58178aca4af581c855110c527acd8ad9d2b5a287e145b` |
| tests/mutants/M6_strength_heard_tbd.json | 16674 | `e765f1829da71d89c80c6cfc0d900e855254e6a478ef0d74b7b137bc02dd10c5` |
| tests/mutants/M7_discussed_only_drug_prompted.json | 18088 | `30d170a2bdbd0a1d3f1c4fcb393dfdf6ab551397a5cbfef28f4b619d9428f1d1` |
| tests/mutants/M8_change_dose_line_missing.json | 25331 | `abfd34e2d239f94ed466eb27ab3cf87e32722d7297bb66c09ced46ef860d0a4e` |
| tests/mutants/M8_change_dose_unsupported_value_shown.json | 25386 | `b3d08461fbd291a9cd3a0c5f2fe402e64d6c3db1d5925c3c4e39570bd1242dd0` |
| tests/mutants/M8_control_unsupported_value_hidden.json | 25381 | `150c690702d1afd1be1038f4a8d96272e1bbda3194e8cb591af4e0de2e1f55c1` |
| tests/mutants/M9_angle_quotes.json | 16610 | `a046e11309a4f3c3f739de04120310f7edd92e09bd1b08f6d71be077b52db8ef` |
| tests/mutants/M9_cjk_angle_brackets.json | 16610 | `aa00262abe1f19329c3bd06f17fe60cbb7c520bfc6fbd54d32f040b8d7e7d3fd` |
| tests/mutants/M9_fullwidth_brackets.json | 16614 | `59fc20feb91a4235580c66dfde5437100d8e2f5d68d07dfe308888832f2602d9` |
| tests/mutants/M9_guillemets.json | 16606 | `5e3a710eb8e0b647831c7204d7da443d850e4049752d5924ebb9abae11e760ad` |
| tests/mutants/M9_tab_control_character.json | 16582 | `ca93f4f30b8992bc5b4cf89e0cd59f261e115cab8227c033fa144653a51ec18f` |
| tests/mutants/M9_whole_value_NA_dots.json | 16596 | `877c2ee4ca42e180583caa03c584cd4a9f4ae880f6e0adad79ee7a18a49ed4cf` |
| tests/mutants/M9_whole_value_nil.json | 16594 | `715268c2d673db51dff36f269639dc4bb45badd38ee961dabd6ff45c8985b7ec` |
| tests/mutants/M9_whole_value_not_applicable.json | 16616 | `35b3ef8c78c32ceab16f339e7774b56c7d9ac8c10c2552178714ab16cd8b1e2f` |
| tests/mutants/M9_whole_value_not_known.json | 16606 | `0a283c0855a2522e370148044727b526085a88b12090d53698d54ad69d818b08` |
| tests/mutants/M9_whole_value_pending.json | 16602 | `c75cc95649f4533cb4b2abbdc781df07190172c6a5b4fd576cfbe53223cf88ae` |
| tests/mutants/M9_whole_value_unknown.json | 16602 | `fe323e950a68c6d1cd2a9e83917a9608c84a9c51a906e53a336b71f03082f9df` |
| tests/mutants/S1_brand_map_alias_held.json | 25371 | `cd2c1ba104e6ed92b800cf606ae1e14d895554c64753996ec0913d3d2e00dfdc` |
| tests/mutants/S1_control_lookalike_word.json | 25433 | `488908aa3fd58a457d38f25a7912ff9343cf1616c45435e56e9d150483fdf6cd` |
| tests/mutants/S1_fuzzy_misspelt_held.json | 25425 | `3889d0c7c624578e391ffa59df7ba5b23d77b80afb7aa333b8c55015130ed184` |
| tests/mutants/S1_leetspeak_held.json | 25427 | `9ce7fd7ad7d0eab516ce57abee2db430a63da8d752646855a479fa5f050b9b9c` |
| tests/mutants/S1_spaced_letters_held.json | 25447 | `2e5c4b043ddbec358c90a8aad67b574a58c4da4b5438e6119ecde87810780943` |
| tests/mutants/S2_posted_test_not_named_in_span.json | 16674 | `674a0541728076d591d03fb76be7ad253658a617b8fb6bd40ff4758e2478227e` |
| tests/mutants/S3_semicolon_items_over_budget.json | 19955 | `93fc235fe5da44f957a179654cec387cca634044e72ebc2f61f60e12ff5ec02e` |
| tests/mutants/S4_lasa_brand_generic_null.json | 19585 | `0ede273718521972a12f1a732897def5e5ab118c76bea6e8d4dc5780b0014f70` |
| tests/mutants/S4_lasa_combination_unflagged.json | 19653 | `f0ce34615589abc03da217fb77b50b31e4c308f96e55668d75c7397b60a8a25a` |
| tests/mutants/S5_model_id_default.json | 16642 | `6988d75ef7cd5f6dbd2257be0b2a6595b5ced97931eeda681ca7357c310b3617` |
| tests/mutants/S5_model_id_empty.json | 16628 | `d7354a0103775eec35caef0dd26a6a4efd5b2a79cd98eb4341cd661c9ff08e1e` |
| tests/mutants/S5_model_id_latest.json | 16640 | `c96b187492e4f226ec7e0eb3f4f3172f92874f1365a2a76ab09ae23161dc07d6` |
| tests/mutants/S6_control_salt_full_phrase.json | 16529 | `effb7bbcf07a9ea07e5d161ffaec117ed56c05ba629b7a29165cab181086e6be` |
| tests/mutants/S6_control_salt_word_alone.json | 25376 | `fca9dfe344c7181794606970ff5ab4841e23dd19b3b0592d861b3752ad97ea39` |
| tests/mutants/S6_held_salt_drug_named.json | 25372 | `ad4d791e6f2a55287d64ac374447f723cf7dd1d93c6738ad800dfdf88105ab81` |
| tests/mutants/S6_salt_word_only_match.json | 16521 | `87fa6c05e441b78ef3cd90c4c4e6e1073f23da2221e4f63736487f50d42038c0` |
| tests/mutants/V0_bad_duration_unit.json | 25387 | `f026c5040a0fadced834c28b27c79d5ed12bc7d8a05ca0f85d5a95de3828a1e7` |
| tests/mutants/V0_control_hours_unit.json | 25385 | `c990b79cb34a25fbff54b65d65aba17d0a2ab36a7d4c11f6704b7bde4c1b97df` |
| tests/mutants/V10_advice_over_budget.json | 22768 | `fbe7d809d2d2dec47ee85e8df3352aecd331de342351db35ba392116b4940721` |
| tests/mutants/V10_control_budget_full.json | 22044 | `50e7cf8f54f3044de7ee03fed8cc8c728e3eeae38bc4dd6a8d4ff880625ed2d5` |
| tests/mutants/V10_red_flag_not_first.json | 19687 | `e4ac9ffd40d926772482b6ff93541640379c3aa9a832561a29df1861e477d43b` |
| tests/mutants/V10_red_flag_trimmed_by_budget.json | 19501 | `fe13ce93fd1602c4106333ce96cf405cd37f867e66e4b44ac0afaeada4e8167e` |
| tests/mutants/V11_control_round_brackets.json | 16688 | `91bd8379adb63c8ab1107d4ffdc3548ea0793300f050c7bc6c93fc90219e6eaf` |
| tests/mutants/V11_frxn1_phrase.json | 16638 | `a11cb074236224d449bf15dd76dbb20e39258f968312d05459f4ca6349965480` |
| tests/mutants/V11_missing_value_only.json | 16582 | `70fa5c792470cabf307e7a9ef64e32e022a74ae2537ea0eb70d0823a469fb9e9` |
| tests/mutants/V11_repr_in_symptoms.json | 16694 | `9320a897b1b67bd042f095e7cca7e827017b72753e64508a932a7a7d16c48ceb` |
| tests/mutants/V11_tbd.json | 16594 | `afbeacd3fb5472e83c4d5c6630d6f1a998e5741473b9c41e1699fb62e036ff87` |
| tests/mutants/V12_cited_span_outside_window.json | 16674 | `5318473c76bd163f3b3325e20c41d37b9b542aa62f32499b57cc311c01b1d31f` |
| tests/mutants/V12_cited_span_quarantined.json | 16673 | `f9104a9d44dfd444a2990c5948e32009431dca852c67658f43c19907b953397e` |
| tests/mutants/V12_cited_span_unresolved.json | 16675 | `537ff03bbc24013e204886af80a93af0a2776189e7e5d14a299036620931605f` |
| tests/mutants/V12_control_uncited_span_outside.json | 17095 | `6e381645a396be411cd0387af6ee079397bc2a9b6e14e925ca0a669649c3019c` |
| tests/mutants/V12_who_said_not_in_roster.json | 16674 | `b61a1ea91bfa6f0c7a7ff53573d6e5b701ebcab6717f45d9182bf6823ea24696` |
| tests/mutants/V13_control_gate_off_3of3.json | 16677 | `835bf23b12f853ba35221b606c85416c7ed322c393839385cf83295f5af2bc79` |
| tests/mutants/V13_gate_off_armc_contributing.json | 16677 | `ce7a096df5caf4011e2ef10833c48fe4d50126fdc304b94eb3550a18b2ceb59a` |
| tests/mutants/V13_gate_off_armc_only_label.json | 16665 | `dec617da3329c31a7e85f770040017f4fd0f637f655c20716da9f134a3ccf3ce` |
| tests/mutants/V13_translator_order_capable.json | 17648 | `8904b9c2e56763b5a46cc0e497d0349b7f3fbbda62b6b657e9c750e3742022aa` |
| tests/mutants/V13_two_order_capable_labels.json | 17651 | `085bae337538da3ff33bb167446bff86de93939f5ae47a68b9bbdc6ca365c714` |
| tests/mutants/V13_voiceprint_conflict_ignored.json | 14242 | `c192d72bc7cda8894c5736a32245959914666852089a358ba89e6389ccebaf7f` |
| tests/mutants/V14_acid_reflux_matched_to_folic_acid.json | 16499 | `2d78b467e3206e8869c7345f5f52d49c90144a6f5e789ec980472a6a97640be8` |
| tests/mutants/V14_base_molecule_wrong.json | 18181 | `0d4287a3421591c62d62d8f24637f14e93a4ede5fc34add934a3f02491dd7dfa` |
| tests/mutants/V14_control_folic_acid_spoken.json | 16498 | `f57fca1848fcb0762c24236a02163f67f8658c07521da73acea31c4fee40faf4` |
| tests/mutants/V14_control_unattested_combination_unexpanded.json | 19326 | `4fc94962721fe0cef4738cb4034068cbad07d489d298c46a59f0e3666bc615a6` |
| tests/mutants/V14_lasa_unflagged.json | 19652 | `c7f6f8bb7d188322e0076caef3b333583ce1914125ef4bd04a761b99a8f50cfd` |
| tests/mutants/V14_unattested_combination_expanded.json | 19427 | `d74d6102d6f7989b3da48cf158c6161195e996d8d3c0741b68a0c09559c73aac` |
| tests/mutants/V15_full_without_note_text.json | 16151 | `ee5e7e0ed56cacc7444f9b4591e019844bc359708c98269d6489606b9942cf9b` |
| tests/mutants/V15_withheld_with_gp_content.json | 2651 | `159958640585c7f680a52efb512a5f01d6e47ce182cf40c4bcc4a8598b81b6c4` |
| tests/mutants/V15_withheld_with_note_text.json | 3137 | `dbb61e45186b7f6cbda01bdf9428c10873367bf96e4c0c26610bf4bbf0366492` |
| tests/mutants/V15_withheld_without_reason.json | 2587 | `25f7c3a85a9b403f8dfd8e569bdc3257fe02b58bd1425231a0a95b6781217fb6` |
| tests/mutants/V16_model_id_placeholder.json | 16642 | `286fe8c9efa2d274e00ba3660e751461f6fb34ae86f3adcfbf24db0adf788087` |
| tests/mutants/V16_models_served_empty.json | 16604 | `2e44c36528e6d8c32fa1b5b4755d3ae9a6f261257a33523e91a7e10906e1aede` |
| tests/mutants/V16_models_served_mismatch.json | 16641 | `a2cc60850a506eebc8491d2e052497e9a38e4993f7d89d6bf050dc14db4faf05` |
| tests/mutants/V1_control_provenance_reordered.json | 16674 | `77e4a830595f694768cb1c336bc7c29ef31f593a4205c06df0f37bcebe76614f` |
| tests/mutants/V1_pointer_claimed_twice.json | 16671 | `2aa1cde048ec0a8ccd01fcf57e99c895be46312e05c31072e5a65c229b51e6a9` |
| tests/mutants/V1_pointer_unresolved.json | 16674 | `a158b9312a30269b7014ab985d8cdb84ca332a85122c18475980a66a97121634` |
| tests/mutants/V2_counts_mismatch.json | 16674 | `ee4d9154063cbc0747e109bf57a4ebf3382cc19b5f531afabbefd1e10837728e` |
| tests/mutants/V2_entry_without_provenance.json | 24893 | `a7a58f96e2e13fa3b91fdc552c8cac61bf8b05f64ae17a8a8c99e5a6186c61f6` |
| tests/mutants/V2_prompt_without_provenance.json | 24905 | `d25ed1552125e93a24c552e342ee19dfce7297d128ec4bf853a1e47082d968a3` |
| tests/mutants/V3_control_unrelated_test.json | 19287 | `280d3acd52143ec533b401469e778d533a53b4b19e67b6d240d26d40c10aeb83` |
| tests/mutants/V3_notgiven_test_in_list.json | 18895 | `7ad490ac067dc63db22e2fb79191c1db35cd1d6642c219e620e7b93c343156f6` |
| tests/mutants/V4_control_keptout_without_spans.json | 16654 | `6e03db30ae972a6f38fe1b36563bab7c36de1e1517d44312356213009b32df0a` |
| tests/mutants/V4_posted_without_spans.json | 16654 | `46b83cfa6bfd821a00eac416e54b91d3013e7074591c43aec10eb2232c61b3dd` |
| tests/mutants/V5_bad_heading.json | 16674 | `fe1bd06f530c669e8c85f0bfad9925fa8b5dd52c85da292b9a03bb2548aa2bd4` |
| tests/mutants/V5_heading_twice.json | 16685 | `96801243764d2096a80b4e5fbe6095ae87f9fc8688ecb503f491ea0cd0385853` |
| tests/mutants/V6_draft_line_missing.json | 19616 | `54cde573d067f8b080991f0d0616b01cf701bf1a566b008e159abe476d4f7272` |
| tests/mutants/V6_extra_investigation_line.json | 25400 | `bd9b81d2c41d2157e20a9bc5e25fec1860ff586baf4d7d07d09e00582bf1aacb` |
| tests/mutants/V6_medication_line_as_order.json | 16699 | `05247007dafcc2e2b373164f00e9dda0105dcc49f90135e25891504dfdb9dfb9` |
| tests/mutants/V7_medicine_in_gp_extraction.json | 16920 | `a2307b139115339c37b840cb05bdac916d155fc78beb565d033c38f0c59588fb` |
| tests/mutants/V7_medicine_provenance_without_prompt.json | 25385 | `c40e7edfe57f43c87a9ca630d2a3aa2995c635f349d2f608429eacbe7c6d1b16` |
| tests/mutants/V8_affirmed_from_patient_supports_dose.json | 25373 | `efed3f5b0a03075e43b7f0d081240c886a9978d3cbf5b4c6c3ac2776c8eecbb2` |
| tests/mutants/V8_control_relay_cited_with_doctor.json | 17666 | `fe5c3b9454df58c9e491aebf9bb2d5685018921842312bfb7bc8a63455931838` |
| tests/mutants/V8_patient_span_supports_frequency.json | 16674 | `8f12aa073d0a6df02c7132883109337053aa3a1477358c96185d21d1c904727f` |
| tests/mutants/V8_posted_unsupported.json | 14246 | `5fc2dc58a676b8a7547fa81cc2a9ba518d5af5cd081fd2e4efa068effcfe08e6` |
| tests/mutants/V8_translator_created_order.json | 16694 | `68f5b0405c2553f9c1d3b415816d09ac9af16d9ae20c8c9ebf018497a1e87f5e` |
| tests/mutants/V9_brand_alias_of_stopped_drug.json | 25407 | `9935797424b88fb381c67896e10ac4aae07149f25d829756f3706aad3c519120` |
| tests/mutants/V9_control_lime_juice.json | 26144 | `8965be5d01fe3e14716fead45da5b226042f75ad215339ad23384c0e99126a07` |
| tests/mutants/V9_notgiven_test_named_in_plan.json | 18217 | `f0d5dedd5539e725d55d776d358ad39f9c13370cb0d294f01aaedc0f67adf8ea` |
| tests/mutants/V9_plan_line_missing.json | 25281 | `1f7701a26bc4873eb42326ccb272d205bf586dcb51ced72df089b867000a08d7` |
| tests/mutants/V9_split_spelling_of_stopped_drug.json | 25435 | `cc87bedcdc09effe90794313580bf54c92960032458bddf3185b7e26ae1c3178` |
| tests/mutants/V9_stopped_drug_named_in_plan.json | 25421 | `9cc4b45271f72704bb4df7b4fe1a82fdfe21dcbcd4f5cffff866a188044f6be3` |
| tests/run_mutants.py | 1399 | `5064a343b6570f3024c8110f005fdb0378115f365dc2705ceeb1da8c985aaf86` |

## Excluded

| Excluded | Why |
|---|---|
| Any real artifact, transcript, audio, span quote or note | Patient and doctor data. The bundle is synthetic only. |
| Any real `pulse_link` id (individual, hospital, consult, prescription, doctor uid) | Every id in the examples is null or an all-zero placeholder. |
| Review scores, cohort metrics and PDQI-9 results from real consults | Not for the Pulse-facing bundle. |
| The generator code, its prompts and its run outputs | Not part of the contract; Pulse needs only the artifact shape and the validator. |
| Real model, STT and MT names and provider details | Examples use invented `example-*` names. |
| ETA's design rationale and its sweep word list | ETA-internal; kept outside this folder. |
| `__pycache__/` and other build leftovers | `run_checks.sh` sets `PYTHONDONTWRITEBYTECODE=1`. |

## Privacy sweep

Twelve patterns were run over every file in this folder, including all 128 mutants. A hit passes only if it is one of the allowed placeholders below; the sweep found 0 unexplained hits.

| Sweep | What it looks for | Hits | Explanation |
|---|---|---|---|
| S1 | email addresses | 0 | none |
| S2 | Indian phone numbers | 0 | none |
| S3 | UUIDs | 135 | only the seven invented ids `00000000-0000-4000-8000-00000000000N` (N = 1 to 7), one per example and per mutant |
| S4 | runs of 10+ digits | 542 | only all-zero runs: the zero UUID tails and the all-zero 64-digit placeholder hashes |
| S5 | hex ids of 20+ characters | 405 | only the all-zero placeholder hashes (`code_sha256`, `prompt_sha256s`) |
| S6 | document-id shapes (mixed case and digits, 20 to 28 characters) | 0 | none |
| S7 | `*_uid` fields with a value | 0 | none; every uid is null |
| S8 | Aadhaar-shaped numbers | 0 | none |
| S9 | URLs | 2 | only the schema's `$schema` (json-schema.org) and `$id` (a non-resolving namespace id) |
| S10 | an honorific followed by a name | 0 | none |
| S11 | real model and vendor names | 0 | none; the word list is kept by ETA |
| S12 | internal agent, person and branch names | 0 | none; the word list is kept by ETA |

Speakers are `speaker_N`, rooms are `EXAMPLE-ROOM` and encounters are `EXAMPLE-ENC-N`.
