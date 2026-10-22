# HANDOFF-INDEX: eta.freescript.v1.0

Bundle: `handoff/eta-freescript-v1.0/` (248 files including this index). Schema version `eta.freescript.v1.0`, superseding `eta.freescript.v0.1` (29 Sep). Built 17 Oct 2026, fix round 1. Every artifact in the bundle is invented; no real patient, doctor, room, encounter or Pulse id appears.

## Files and sha256

This index cannot hash itself, so it is not listed. Verify with `sha256sum <file>` from the bundle folder. Every file here is for Pulse.

| File | Bytes | sha256 |
|---|---|---|
| README-FOR-PULSE.md | 22572 | `51d14af372d64fc58bc14c001bab88fd04e2ba9e6046a9adf399344350070508` |
| CHANGELOG-v0.1-to-v1.0.md | 6895 | `5fd7b9051432d250af5113bcf491363af92ea2f5fa37bf953a8c258704f107f7` |
| eta-freescript-artifact.v1.0.schema.json | 41452 | `a3dc36f3eccb550c024500bf5d1ad9fd3d7c2733c6a9b120a1a2f03d1119f6a7` |
| validate_artifact.py | 65555 | `37c903552e65dca1b66000b9d4ca7e259c32402c13d890f70f289522e10fd694` |
| run_checks.sh | 1872 | `8a8cba7ed1fd35409eead2e0637b3842eb557a9ba90b9b76df089b4435877ae0` |
| data/SCOWL-LICENSE.txt | 22422 | `01214688ec0cee287e2cfd480f0948d21600edcccc128ed4d1d0e004357ff9ad` |
| data/brand_generic_min.json | 5562 | `a28d4df0c9f669223e01a7666d0698c34d6cf8c78343e172b0ca7b254705cc78` |
| data/brand_names_curated.json | 3642 | `b98e839705b7addcf367d80bbd25edfc4b99e67dde9e068fff9649066ec47a04` |
| data/clinical_abbreviations.json | 868 | `0a253e10cd3f48d6e374d834e9e0d38e633de42a34acef4a8af1538019bf1ee6` |
| data/clinical_vocab_extra.json | 10654 | `47a97e8f0ef24eae74f9145f2f5a01ca24cc8fd6239906760a10fd8b07855505` |
| data/copy_rules.json | 762 | `62c05906874623e6f7a9c8f21676113648c637435fd8ee6c54fed4d5c83b451c` |
| data/dose_patterns.json | 4490 | `594f3dcb4f1ab518fb1181b4b695fb429de4a8602def0246c0c9066b9f8fff66` |
| data/drug_denylist.json | 6746 | `d12875aab3843dc903295b6d92c3441f4d4dcaccef6ca5cbb373a3844c0c62f5` |
| data/english_words_min.json | 113835 | `d7f62794e82a7a579e86cdbb7fa2ee01c7680f17a190d626b4ad7f5cdebad190` |
| data/frx_n1_phrases.json | 3317 | `87782d85b998bfd3142670184d7ef3cc70554c78b0219a19c81429d8d0f1347f` |
| data/lasa_pairs.json | 845 | `bc482d8242689f7d30ba64fb686f51a1f355406442ddefb3eaab9bbc81737c5a` |
| data/medicine_names_min.json | 2510 | `7ef17d5a0bf6c54e2fcfa09ec94076ad78593477284c6b448667004f6ae38089` |
| data/order_objects.json | 1759 | `999f9614c1ad55ed1746b2abf7eb4cdab239d0129b28ba6e7afa1f00acb76209` |
| data/qualifier_words.json | 1594 | `657581f30e16125af4d37944ff08880681b0cfe67c46d1c9eb185e2f04e49a7d` |
| data/salt_drugs.json | 658 | `7bd8aa76c9c6d5565fd6d7b1122d9526ba9130f4f1e82605e524a318c8cb9873` |
| data/scowl_words.json | 3382009 | `3817ff031315000e49301c0bb45eda8cde84f85fb3f3e0d588cd5b316466d7c4` |
| examples/build_examples.py | 34627 | `a8d7e99b008c5b0b17319596544e15af286223e19f4d7befe7b60fb8f6d7483f` |
| examples/ex1-fever-patient-own-drug.json | 16674 | `ba442288aa179318ee125d81f04de6612d310db47b95c5544e34858acd9f9d93` |
| examples/ex2-negation-no-antibiotic-no-xray.json | 18185 | `93c3de13991cb5bdba550e5d9935bac6dcc19b35a165e7d1b3074a026771d214` |
| examples/ex3-stopped-glimepiride.json | 25383 | `060f752034b62cee9925ad48d6dcf4b4e91513304373ef01ea676e7a14c9440f` |
| examples/ex4-fluid-room-translator-relay.json | 17652 | `0a43dec2a16263c2aa1c35aa24283b91f0ff11aae4e7587dec4b2386e625f730` |
| examples/ex5-staff-voice-voiceprint-conflict.json | 14245 | `0f38d3dce7235eb3fb1b0a3d7cbdee4eba9db3fad8b4422d074dcecf4c6042fb` |
| examples/ex6-combination-lasa-red-flag.json | 19687 | `3dc74fbfc35d1a4e261a449b9a1178cd318c4bf7ad18249fbf7368a97ab942bc` |
| examples/ex7-withheld-no-role-track.json | 2614 | `29a3233e6c3641ac0dbae2da708d92f46fc321b5bba9110acecbef897bf5dbbd` |
| tests/build_mutants.py | 43859 | `89a6123760956fa7e675a44c0a4975e8ed0f9518d1434cc8a7d5412b1b684c4a` |
| tests/expected.tsv | 8408 | `3627c541e3642d08130af3c9c19a725f89bbf3efbd464044e4ecc17047534d64` |
| tests/mutants/M1_control_condition_named.json | 25415 | `be3994d0891ba3231da6512d2e096c426eda4c4d05c52062d4db2cdf57c31c69` |
| tests/mutants/M1_heading_injection_line_break.json | 16738 | `87e8be5acc7c4d885c86cd488e13bb00af8b20ae3f0258cc3d21604acf45a808` |
| tests/mutants/M1_held_drug_in_diagnosis.json | 25421 | `2b355fa5a7749b383e025a66701310e0e7fcc6a982ab60ac3ad451b956f48eb0` |
| tests/mutants/M1_held_drug_in_raw_name_only.json | 25400 | `2d21dd0005b1ec470dd5eebe68f0b792cd14eba40c48a496e2970d7a365ccbd7` |
| tests/mutants/M1_medicine_in_comorbidity_without_condition.json | 25409 | `c3876ccbee08d7c50559f263fec66aa6bac0f485684c4a989fd5cce23cb86b74` |
| tests/mutants/M1_medicine_in_diagnosis_alias.json | 16700 | `63d8da59c41bc1dd51b8d96bc64abd08a64fd6a4497727e6e97ebfdd69b9e242` |
| tests/mutants/M1_medicine_in_examination.json | 18243 | `7cd8b2726f288ffcc846e59d2962a318256daa06d5abb78410f90ad14e75b913` |
| tests/mutants/M1_note_crlf_line_ends.json | 16696 | `29bdba7f619217974c485a21c7a6df4bbfe7f6e2b8ad152d5ff099feac841a4a` |
| tests/mutants/M1_note_line_differs_from_source.json | 16664 | `bf6f437f23192b1a4ffb94b722f5b4df2a6328507e056775af8adb845d9a2022` |
| tests/mutants/M2_accented_held.json | 25427 | `dbaa8c432037d486abbe20bee7a47d08ba73ee214d088f66bf8252c2deed793e` |
| tests/mutants/M2_cyrillic_homoglyph_held.json | 25427 | `cf7fddff53e91207652c552e564d1ea7d5620bcbc2309a955d12d1c06d8cf836` |
| tests/mutants/M2_devanagari_held.json | 25475 | `4a7095380da89581da4494b003be815e9269b8b88b2a9415f460a41a9ef5b40b` |
| tests/mutants/M2_dotted_held.json | 25445 | `7d0340857c8bf3fd6483b5bd89c56d08568764222c60db4e6352a38aa3fcb2f4` |
| tests/mutants/M2_fullwidth_held.json | 25469 | `97972fba32800629c246cec1a5913d43c712526e3ea8840936b71be41e43a569` |
| tests/mutants/M2_greek_homoglyph_held.json | 25427 | `b20896191532e215d6ec360b8ca9fbd48b4512a4fea6b58e572e7173824ffc51` |
| tests/mutants/M2_hyphenated_held.json | 25427 | `d10ed5231e18183934ad0f9cdef33a5779eb392973615b1105e9a6b3b5388f12` |
| tests/mutants/M2_non_ascii_letter_in_note.json | 16676 | `46c78f3aea949b27a9ca022adb8add226991737709321d5ade11fe1ec97bcee9` |
| tests/mutants/M2_zero_width_held.json | 25431 | `dbb7f9999c5c5b1a1f3a8bc179692287b20e40a04adf8904f6ac69e49fffdabf` |
| tests/mutants/M3_combination_part_named.json | 20334 | `0aed4965f2c3810d838d6803ab8ea9cca76cc7d2aea57aa45f19f62f6f3ac5db` |
| tests/mutants/M3_control_pand_stop_unnamed.json | 25386 | `dfed60ec50ade2c0f7c81545e977332bc5491790b88ba43ecb966c1cb566ecd6` |
| tests/mutants/M3_pand_stop_domperidone_named.json | 25428 | `d276369651246ad020f47b680acb747cc9653787b2f7ef00f8eb041078019ff7` |
| tests/mutants/M3_pand_stop_pantoprazole_named.json | 25430 | `8eeb36872493c5442923dcfc112cd672a7da43c0f62b284f610e2ac4d95d23e4` |
| tests/mutants/M4_red_flag_marked_without_entry.json | 16698 | `346bceb289e703487606bb62228735929aa72e6f7d3690773eb9764477303be2` |
| tests/mutants/M4_superseded_word_rendered.json | 19747 | `f1d0a1640455071a6e0fcb86c8338cb2786c930b9eb5f9c5df0e1dbc75ad2888` |
| tests/mutants/M4_warning_without_red_flag_entry.json | 19475 | `23c1b8aadfe819e746e34bd2f4ac97f9028bd57846f7a9f6de419edc4fd3d8e3` |
| tests/mutants/M5_affirmed_reason_supported.json | 25395 | `b75e747ff07e8581718a5010223194656f205c0875c1c21163890b5475ffd943` |
| tests/mutants/M5_control_value_in_same_doctor_turn.json | 17112 | `9a13a9af25027ba9e22f39c417ee03ee2a4a9dc63bf90fb0dd01ce8d1013aa4c` |
| tests/mutants/M5_other_clinician_supports_order.json | 16674 | `70071187f92e5c63c08f1737985879632ed3423c6800474b1807afbf12646799` |
| tests/mutants/M5_value_on_span_not_naming_drug.json | 17510 | `4b38b275ce385db14e7c3ec53470ee3c39c56a571acb7fe7edff3b13adb974ae` |
| tests/mutants/M5_who_not_order_capable_supported.json | 14248 | `434e573d8d429651c4a0b94867d0c8069a72208a98af573f8b223a62ddccf6ff` |
| tests/mutants/M6_brand_missing_value_phrase.json | 16698 | `d3803498de820d55613990c9b90121f3a81c71274eb7d69447235351b718a3f5` |
| tests/mutants/M6_medication_line_dose_unknown.json | 19730 | `0601d9c7cd0cea828aa342fcc5cd64bc5f88e060cf051bfcdc872ec38a05e10e` |
| tests/mutants/M6_medication_line_question_mark.json | 19706 | `3161b407f99b5257d9c58178aca4af581c855110c527acd8ad9d2b5a287e145b` |
| tests/mutants/M6_strength_heard_tbd.json | 16674 | `e765f1829da71d89c80c6cfc0d900e855254e6a478ef0d74b7b137bc02dd10c5` |
| tests/mutants/M7_discussed_only_drug_prompted.json | 18088 | `30d170a2bdbd0a1d3f1c4fcb393dfdf6ab551397a5cbfef28f4b619d9428f1d1` |
| tests/mutants/M8_change_dose_line_missing.json | 25329 | `51283ab413698a84d71708245e02d09b775a26f658c9a8692fdd573d4caa543f` |
| tests/mutants/M8_change_dose_unsupported_value_shown.json | 25384 | `55dfb4c28712a95b9f22dcfd42f08d30d9c7135b4f937ad82b9b7ec3ddaf4b12` |
| tests/mutants/M8_control_unsupported_value_hidden.json | 25379 | `69b235588d41585936884c38c2ba1422a6a8e7a32b5353c5d6b6ebdae0d98604` |
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
| tests/mutants/R10_attested_brand_wrong_generic.json | 16504 | `5d37cb409f5a6e56a70b6236f3c168be24711e7d1b206ddeed0caa4bb0bf0a64` |
| tests/mutants/R10_control_unmapped_brand_confirm_generic.json | 16556 | `0e6a3449ce9ead0b8050f99cb007640e90f8ad17fa72b39404a2e205758b9cd3` |
| tests/mutants/R10_unattested_brand_given_generic.json | 16504 | `13b2152e2575cecb3f8d63296d81110a2eedd16f4fc55d516e5f602c8eb2906d` |
| tests/mutants/R10_unmapped_brand_inferred_generic.json | 16504 | `40fbbfa12b6a49a0ed453feb6f237dc8968e5ce0602b782d84fb6026f893b0d2` |
| tests/mutants/R11_control_gap_over_two_seconds.json | 25375 | `aafe298a7d1015db65440ebdb6ff785bac8067e600c8675f1a7998e5b6530c53` |
| tests/mutants/R11_control_split_negator_kept.json | 25396 | `4ef41466bb0d093c82e7c11a3e9cafb323e8743b40c9ad28808632f2d8fa5d44` |
| tests/mutants/R11_red_flag_split_negator_dropped.json | 19711 | `d6c13ef7a0e7a7a78b3e625b7edcf278703b349dad0bb6b80ad4d8372ce2dede` |
| tests/mutants/R11_split_negator_dropped.json | 25375 | `eeafe80a14ae021197192345904336d73babd96f53beb25f9e8cc507bde0d741` |
| tests/mutants/R12_control_counts_without_units.json | 16676 | `e11c59d8a93f2daea46b3b26c5bd8b1370af6877749a599a3c37fe936ddc334d` |
| tests/mutants/R12_hindi_number_unit.json | 25417 | `648774bba8e64ee6e928a6797e91ddae793cd927c7e605280eaf683a3f89f723` |
| tests/mutants/R12_kannada_number_unit.json | 25427 | `6e1cf137ffc4f0b0157a2abbd46244e814d99425753c3f301407d96394dafe04` |
| tests/mutants/R12_spelled_units_in_plan.json | 25465 | `a24244c3035d5cfef1a159133a932bce94aece86f17234fa2b7b798143ae7f61` |
| tests/mutants/R12_two_fifty_mg_in_follow_up.json | 16662 | `deadb1f5c616c0191157e75c9bace31d696ee36d77189ea8f3092a36e2658271` |
| tests/mutants/R13_brand_course_in_plan.json | 18235 | `88cc0406bd9f015f34d6824f2841bb163b2a7cf72bb4517fa1e581f5cae77fd9` |
| tests/mutants/R13_brand_no_verb_thyronorm.json | 25433 | `14082ec78165333376ca6f06f659e19f863f0fa43dab756f6c194a509e815e90` |
| tests/mutants/R13_brand_with_generic_as_before.json | 25439 | `e1adbb482715318f3e06cd83ae738bda6abea41a1a1dc0783f9b221c858bcaf0` |
| tests/mutants/R13_control_ordinary_plan.json | 25461 | `127a78d88e5b1cdff95d719400ea25f152228a1c6d01aede21807f98b59c4e42` |
| tests/mutants/R13_took_brand_in_symptoms.json | 16718 | `12e242ca066d2dfe42f83ad65b84068efc0ef2d605135a806090ec8324985dd1` |
| tests/mutants/R13_unlisted_brand_of_stopped_drug.json | 25423 | `44831a5362c7e01e8baf0557b6d354c8dec1e6f4f442f576354927a654673897` |
| tests/mutants/R14_control_from_to_new_dose.json | 25395 | `f5ce5b5477e846d6d54a40fd32c380c3fdce9239c86e830d5882bd40651b82ec` |
| tests/mutants/R14_control_number_words.json | 25403 | `ca562ab156d53be811434c81f8dfca2e24b91c3d5f7704916b04a73ee2863bef` |
| tests/mutants/R14_make_it_mismatch.json | 25389 | `a196f8d86f959818ad95a8d41a6580afea836459d262538f46b82c643aeedd26` |
| tests/mutants/R14_new_dose_undecidable.json | 25369 | `f14ee1b5114d30d293228ac649a3a058e8b40af3caafb0983f50bf14cab2454d` |
| tests/mutants/R14_old_dose_shown_from_to.json | 25399 | `a091cc1ca86fd84cc51b250898f01e4f958155f1f84fe2b510a0032d647428c9` |
| tests/mutants/R15_brand_benadryl_in_plan.json | 25421 | `b169510cd9ec0a4d39a5cf8f754ab36793ae2ff97f3355a8256c3e2046e98d5e` |
| tests/mutants/R15_brand_sumo_in_symptoms.json | 16712 | `bcb27789538f659a54738c1361b23011eb82c7778cd9868a000b6b7a095d84f3` |
| tests/mutants/R15_control_ordinary_word_kept.json | 16726 | `fec6e9c243844ba5a7e11589a76c4612af4b46082322e79ef310f9115eada5ef` |
| tests/mutants/R16_continue_same_medicines.json | 25441 | `90e2d42899b54b41e0a21abe4e4591cb497f7da2a27e1e46640f0cc190aca93f` |
| tests/mutants/R16_control_closed_objects.json | 25457 | `b16019452383e0604b8978587e536cb6c1bb09962d1473745c73175be5c71357` |
| tests/mutants/R16_take_unlisted_brand.json | 26162 | `616f6539ab2f061d3584a28a73085e9087a90350dd4df36ac3626e0416b5a380` |
| tests/mutants/R16_use_general_english_object.json | 25425 | `4f12271b57c094d88ac672ab50d6c3303cdffc350ca8d543d74ab67cd07999ac` |
| tests/mutants/R17_actually_keep_it.json | 25417 | `396dc1aca94ebc931fb1cdd3ad846f4917a4b7f91563720c85e801df3bee938c` |
| tests/mutants/R17_control_number_before_change.json | 25417 | `0ce702da2c5f9122dd1cd5cd14e313f34041731dfd28f9c1fab699f237578ca2` |
| tests/mutants/R17_no_wait_after_new_dose.json | 25411 | `ec109a372872198112e56d8037d6f339fe8800915934b3fe3909fafd3f300604` |
| tests/mutants/R17_second_from_to.json | 25431 | `afa97c4f53b0d8ae035faae4f40f9569a9cb3f85b9786c92de739db8ec67992d` |
| tests/mutants/R18_control_clinical_suffix_word.json | 14257 | `ea1e746fcc5c962cba9435eacba53183f569d6017df1c41131cc640995ecfa32` |
| tests/mutants/R18_control_diagnosis_withheld.json | 25152 | `a6b1659ac9ca7df4fc901ba52e806068706f6ada34838b86d004adf031873acd` |
| tests/mutants/R18_control_examination_withheld.json | 16563 | `1291b0c9b845cf878713b54799c94d6fd77c2cf5555ac5b6db21d2f3c72f3582` |
| tests/mutants/R18_unknown_word_in_diagnosis_posted.json | 25391 | `3013db0ba9cc4f90ec079d591601cce9d37a55065607682c09407f41e8ca30a6` |
| tests/mutants/R18_unknown_word_in_plan_not_withheld.json | 25421 | `51ca8148c42f4485ac34e311a85c8c78dff08102ed5897d31cbf5e2883ab241c` |
| tests/mutants/R19_continue_salt_of_held_drug.json | 25401 | `e29315382c9d119b6a6d64ab41469bafe564041314057a2be65664929e2fca8b` |
| tests/mutants/R19_control_salt_word_nothing_held.json | 16626 | `571c20afde3735edb9c299a7ed3697da71f776eb6d8f6b6ddc9d58724360d9e7` |
| tests/mutants/R19_salt_word_of_held_salt_drug.json | 25374 | `158c06c6398a0cef9ebf5eb8275b79237b12aba256848d33af9c3816e7f6f3ed` |
| tests/mutants/R1_control_case_only.json | 16674 | `d53fe3f5836e0fe91f62a7edbeb00dc28643e56f8a70e2f504e18f2da40d3d76` |
| tests/mutants/R1_control_contiguous_part.json | 17634 | `a821878622889b01aed2da21a097cb2de2cd02974429666cd1448c067e7b5415` |
| tests/mutants/R1_negator_dropped.json | 25365 | `c38eaac7a58df8a9db557b20303cf308bd2d45fcadbf8c3348b896bad67ba9b4` |
| tests/mutants/R1_red_flag_action_truncated.json | 19527 | `faa1ab38d18c79a1714d2f351c5f46a70dc6964f502d5e8d8289325d14e1bd11` |
| tests/mutants/R1_red_flag_reworded.json | 19479 | `2872cc5d3c4cd489b50980ad7b5a1c1ef5d42866f2060221c7971f78fd3b124d` |
| tests/mutants/R1_word_reordered_doctor_words.json | 16674 | `0ac4d08a58dd3de23faf97013c14a31cae031fd075a73adfb88a98c9fa836692` |
| tests/mutants/R20_control_pan_ordinary_phrase.json | 25445 | `c597b298156ea52e2eb66295ed8c8360ba50cbe1db5932fe78626312043bd62f` |
| tests/mutants/R20_pan_after_order_verb.json | 25423 | `5632b21d188016ddcc2329f35785c0bea84fdbd6110b978aa442b76ba292c9de` |
| tests/mutants/R20_pan_d_as_drug.json | 25421 | `01dca9c3efb73d2de5559ba3c3f934e7e4ea1d4e2f28b922864a106c4226204d` |
| tests/mutants/R2_condition_word_not_adjacent.json | 25428 | `f96c827d6bf669d8b24281e870668efff489280fcce4fb772b95e7c9e6e9f963` |
| tests/mutants/R2_control_condition_adjacent.json | 25430 | `dfd1ba14d45e6c26d49afb69454ccd67015f7ee4657019730d5130bf48e2c6de` |
| tests/mutants/R2_control_iso_date.json | 16711 | `584fe64116dff914b10cdf5918f424d4641dba2aec99164852c6036ea56a8794` |
| tests/mutants/R2_control_lab_values.json | 16642 | `9f2f99639b46e2f3266bd2020918cd36f0510f80ac9cea49e5de656ca5be181b` |
| tests/mutants/R2_dotted_frequency_in_plan.json | 25431 | `c38188797fd64c80d570400e40a9124bcacfa6775a2f4f9f48922041a22c7a62` |
| tests/mutants/R2_frequency_token_in_follow_up.json | 16656 | `754130106f1cf59dfa155abebb95564a66b57ac16e50a70b6927e928a9062d00` |
| tests/mutants/R2_hourly_frequency_in_follow_up.json | 16658 | `5b0aa23e1c581f28e2de762388cb0f19fada863bc91976b7e4ace77161098ea8` |
| tests/mutants/R2_number_word_tablets_in_examination.json | 16634 | `231976468f20834e6363d3ec2341b6ac894135ed5a0a9ea7f56419aacd8816b5` |
| tests/mutants/R2_regimen_in_follow_up.json | 16648 | `054b24f3a563ddda7bd29382d13892db58e921d9797900f931b98f7d43360343` |
| tests/mutants/R2_times_days_in_plan.json | 25417 | `a26f86d5864aaf820414c77c2cc14eb185521c3a944a745863a1b147c8e2c5fb` |
| tests/mutants/R2_unknown_brand_dose_in_plan.json | 25429 | `a963ae3cd6459c52d995ae7fa2c7278e9d344ab64a215da9eab88de14ccb016d` |
| tests/mutants/R3_control_plain_object.json | 25425 | `631d8bae969f1bbf6d774e411e2d3c954eb8297c020c7731f7de902dc20f9e42` |
| tests/mutants/R3_dose_without_name_in_medication.json | 16529 | `a01abad2bab616e3d959fbd3815e8779c8c7342851f74c9ce99185901d75e8c9` |
| tests/mutants/R3_unknown_name_in_advice.json | 26137 | `74e95adc4a117ef496fbd3246709e24e508c280cb93fbd5b2ef8b5162520f99c` |
| tests/mutants/R3_unknown_name_in_plan.json | 25429 | `e3bc3c5b29b30054becc550804734787dfae3ab0508402526ebea9e571ab9851` |
| tests/mutants/R4_change_dose_falls_back_to_strength.json | 25383 | `986ced3cbd3f18d489d62b9c8142bf6c19ddc2856d83c7fdde5b9236f3a7bb5a` |
| tests/mutants/R4_change_dose_shows_heard_strength.json | 25384 | `da90c6cc05544b5a562673a1bf0469fb3b6e3dc7cdca2e05b1e1d5666ea6c913` |
| tests/mutants/R4_control_change_dose_no_number.json | 25378 | `be4602404c4a9ec4a3389f1ccecca0317effeee1f470b7f82843df93f6166e4a` |
| tests/mutants/R5_control_common_word_band.json | 25432 | `36d482a6c3d561f3e72dccf31e7658d4d0e0d7b47b229a677c2bc5cfb2e4cf9f` |
| tests/mutants/R5_control_common_word_solo.json | 25376 | `1279dee62d89e1a2106878382867a4ac4021617e508b2a5de583671b2aed85f8` |
| tests/mutants/R5_edit1_combination_brand.json | 25414 | `b103fec4f38baaf852f410d9e4f197072fbf3c2dc5c040199181d44b59b87e2e` |
| tests/mutants/R5_edit1_four_letter_brand.json | 25362 | `92b7c62a1a6fdb4045c14bd360ce6cfdb549c8034b92a605c936ba80e6cc7ab3` |
| tests/mutants/R6_control_null_generic_flagged.json | 19380 | `09feda8ed55f9a32304f6f0634fc202fbe720e848120c279a7482e55b0de1763` |
| tests/mutants/R6_null_generic_without_lasa_reason.json | 19364 | `6e812a280b44d361eca3995e0c157ee2af67288032f0a05fdb33101442f39c5a` |
| tests/mutants/R6_null_generic_without_lasa_risk.json | 19364 | `27657da0d4a8f0c57a66377cfe4d690e4253ce5047f1589e8b92920a40a5c073` |
| tests/mutants/R9_brand_first_line.json | 16674 | `6a47ab15cf668ad458bd2feabd978fb2d20e31a21c4426d0c5857246aeca19d7` |
| tests/mutants/R9_brand_in_generic_field.json | 16661 | `2ee1da7ea9d094db4feb99c51eddc8dad0e22d73d895eaeb5dba9a3f8419f3e9` |
| tests/mutants/R9_brand_shown_but_not_spoken.json | 18196 | `41c93483ae0fbdcc5ea12176e86489d4972709183aa73f8fb130bd46526f497d` |
| tests/mutants/R9_control_generic_only.json | 16682 | `6dbf88a4994ead7eef3d31f479cd880abed766bacb9f96c52f5de375b47781b1` |
| tests/mutants/R9_unmapped_brand_shown_as_drug.json | 19372 | `a93cde0a94f7291cc93a5cb09b642c7c54490962cc6171582f85049a84a92054` |
| tests/mutants/S1_brand_map_alias_held.json | 25369 | `01b909c85dae8d00a245b0964cdc5b935f848a606a3ce4489208f17034f84158` |
| tests/mutants/S1_control_lookalike_word.json | 25431 | `4c2e0740dcfb245795ced2830a9483392b21e757455dd799251e43bc678e3477` |
| tests/mutants/S1_fuzzy_misspelt_held.json | 25423 | `6ec2fb3cbb083418b856fb41d101d243328f016963f5b037168725107dfec85d` |
| tests/mutants/S1_leetspeak_held.json | 25425 | `1b58238bd8058a9e9d83a25730bfdd90ea9becd9d338daeb10cd51786a24c962` |
| tests/mutants/S1_spaced_letters_held.json | 25445 | `a5b3e0a372ec0d8a730c486995a6dc4b39b6b1eea285b226310f53444ef758bc` |
| tests/mutants/S2_posted_test_not_named_in_span.json | 16674 | `674a0541728076d591d03fb76be7ad253658a617b8fb6bd40ff4758e2478227e` |
| tests/mutants/S3_semicolon_items_over_budget.json | 19955 | `93fc235fe5da44f957a179654cec387cca634044e72ebc2f61f60e12ff5ec02e` |
| tests/mutants/S4_lasa_brand_generic_null.json | 19593 | `feb5887d0c53e1a2a5165d903173c657a27d843d2469c681a3b80f21431b407f` |
| tests/mutants/S4_lasa_combination_unflagged.json | 19653 | `f0ce34615589abc03da217fb77b50b31e4c308f96e55668d75c7397b60a8a25a` |
| tests/mutants/S5_model_id_default.json | 16642 | `6988d75ef7cd5f6dbd2257be0b2a6595b5ced97931eeda681ca7357c310b3617` |
| tests/mutants/S5_model_id_empty.json | 16628 | `d7354a0103775eec35caef0dd26a6a4efd5b2a79cd98eb4341cd661c9ff08e1e` |
| tests/mutants/S5_model_id_latest.json | 16640 | `c96b187492e4f226ec7e0eb3f4f3172f92874f1365a2a76ab09ae23161dc07d6` |
| tests/mutants/S6_control_held_salt_drug_unnamed.json | 25370 | `12ee02abc5d2e7201b21217a7eac0954bfbb11b7efceffd99e5188bd48ffd071` |
| tests/mutants/S6_control_salt_full_phrase.json | 16529 | `effb7bbcf07a9ea07e5d161ffaec117ed56c05ba629b7a29165cab181086e6be` |
| tests/mutants/S6_held_salt_drug_named.json | 25370 | `1e1de3ac942ef0acbeee7cf082af0ae5a2bba1159d5efae09b4a3e87cf14799a` |
| tests/mutants/S6_salt_word_only_match.json | 16521 | `87fa6c05e441b78ef3cd90c4c4e6e1073f23da2221e4f63736487f50d42038c0` |
| tests/mutants/V0_bad_duration_unit.json | 25385 | `568c44a9f803b0f2e3aafcf5256e1ba03bcd7671649ed21d3c4e3c87890455f0` |
| tests/mutants/V0_control_hours_unit.json | 25383 | `0982af58b73f18e8acc21bf8dd4c9e89d92f728fca0f33d5ef95f47822b4be02` |
| tests/mutants/V10_advice_over_budget.json | 22773 | `95269cec9b333f87e68eafb346578f988a12e284e392ddcc454eb6797539c2b8` |
| tests/mutants/V10_control_budget_full.json | 22049 | `1fa5c717c61b1d689bb09a1ee74bc330a9fe6cd6084b6db79e0683e425555ff0` |
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
| tests/mutants/V14_control_unattested_combination_unexpanded.json | 19380 | `09feda8ed55f9a32304f6f0634fc202fbe720e848120c279a7482e55b0de1763` |
| tests/mutants/V14_lasa_unflagged.json | 19652 | `c7f6f8bb7d188322e0076caef3b333583ce1914125ef4bd04a761b99a8f50cfd` |
| tests/mutants/V14_unattested_combination_expanded.json | 19441 | `5e0c61e87e74534b2afa6fe9395becebc3f292d4da2301542e16bc92031976da` |
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
| tests/mutants/V2_entry_without_provenance.json | 24891 | `2f215753a82d8eba14098c46c9aefff06500aac0af54dace89fc10eb6debbf2f` |
| tests/mutants/V2_prompt_without_provenance.json | 24903 | `b48b2233c12686c4638ef18c8f94035e79a156a06274b79c70f3557e291dfce6` |
| tests/mutants/V3_control_unrelated_test.json | 19287 | `280d3acd52143ec533b401469e778d533a53b4b19e67b6d240d26d40c10aeb83` |
| tests/mutants/V3_notgiven_test_in_list.json | 18895 | `7ad490ac067dc63db22e2fb79191c1db35cd1d6642c219e620e7b93c343156f6` |
| tests/mutants/V4_control_keptout_without_spans.json | 16654 | `6e03db30ae972a6f38fe1b36563bab7c36de1e1517d44312356213009b32df0a` |
| tests/mutants/V4_posted_without_spans.json | 16654 | `46b83cfa6bfd821a00eac416e54b91d3013e7074591c43aec10eb2232c61b3dd` |
| tests/mutants/V5_bad_heading.json | 16674 | `fe1bd06f530c669e8c85f0bfad9925fa8b5dd52c85da292b9a03bb2548aa2bd4` |
| tests/mutants/V5_heading_twice.json | 16685 | `96801243764d2096a80b4e5fbe6095ae87f9fc8688ecb503f491ea0cd0385853` |
| tests/mutants/V6_draft_line_missing.json | 19616 | `54cde573d067f8b080991f0d0616b01cf701bf1a566b008e159abe476d4f7272` |
| tests/mutants/V6_extra_investigation_line.json | 25398 | `b5fca4e9638bc1ecb63f5b3a97a741f333dd1be97b222207c587448728ab1733` |
| tests/mutants/V6_medication_line_as_order.json | 16699 | `05247007dafcc2e2b373164f00e9dda0105dcc49f90135e25891504dfdb9dfb9` |
| tests/mutants/V7_medicine_in_gp_extraction.json | 16920 | `a2307b139115339c37b840cb05bdac916d155fc78beb565d033c38f0c59588fb` |
| tests/mutants/V7_medicine_provenance_without_prompt.json | 25383 | `8c998d9f23e78aa48c6b6ddd1020760bd7ec8788c40781819d5c77e291589ab4` |
| tests/mutants/V8_affirmed_from_patient_supports_dose.json | 25371 | `744cf09ea4feb1178c79b8e0ec8400f193df5f7c587f55a5081b55e495628473` |
| tests/mutants/V8_control_relay_cited_with_doctor.json | 17666 | `fe5c3b9454df58c9e491aebf9bb2d5685018921842312bfb7bc8a63455931838` |
| tests/mutants/V8_patient_span_supports_frequency.json | 16674 | `8f12aa073d0a6df02c7132883109337053aa3a1477358c96185d21d1c904727f` |
| tests/mutants/V8_posted_unsupported.json | 14246 | `5fc2dc58a676b8a7547fa81cc2a9ba518d5af5cd081fd2e4efa068effcfe08e6` |
| tests/mutants/V8_translator_created_order.json | 16694 | `68f5b0405c2553f9c1d3b415816d09ac9af16d9ae20c8c9ebf018497a1e87f5e` |
| tests/mutants/V9_brand_alias_of_stopped_drug.json | 25405 | `3ffaacc7952fcb294343ca553b6a2d1469e812738b55e80adbdaf77a0cb78454` |
| tests/mutants/V9_control_lime_juice.json | 26142 | `87c83f1de700dfab4964c8789f0345c0654e8875e6856b0893dd270142cdec1b` |
| tests/mutants/V9_notgiven_test_named_in_plan.json | 18217 | `f0d5dedd5539e725d55d776d358ad39f9c13370cb0d294f01aaedc0f67adf8ea` |
| tests/mutants/V9_plan_line_missing.json | 25279 | `b91ef13a8a6009fa29088746e4b9bab16a54519d40b7cad64a5598da9f2cc4a9` |
| tests/mutants/V9_split_spelling_of_stopped_drug.json | 25433 | `a28d3fdd939406458b56441b50d1cc522a2e02f48f4d25e1564b4990a8c5a5f7` |
| tests/mutants/V9_stopped_drug_named_in_plan.json | 25419 | `5567cd5d517b7b06bda831827f131a11303b0a3fe969caec150e578adb18598a` |
| tests/run_mutants.py | 2071 | `1ad0f1dd6923c44c237993127a4332f5b80fc9b964b2354425221c38a3e3eca5` |
| tests/vocab/build_vocab.py | 2101 | `33283438ed82f368ab651db10b5459207f3a83d671b58155093f31282f730ce9` |
| tests/vocab/check_vocab.py | 4221 | `627f84775f31d55354412a7aedc8c8d567b4d88c56f594421d8541b0350634c9` |
| tests/vocab/clean_notes.json | 7811 | `f691fde32a76afcb616100931bd60f50bb4ac40efaff29bfad45d627f9076fba` |
| tests/vocab/coverage_words.json | 1748 | `b372516a93806180eb3059438c16065a731a9fe751bc18e7579a1bc60a490703` |
| tests/vocab/heldout_notes.json | 11837 | `260342c01352d45bdd9ab1f054769542f03d3b12fb16c6aa14975901cb4858a8` |

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

Twelve patterns were run over every file in this folder, including all 210 mutants. A hit passes only if it is one of the allowed placeholders below. `data/SCOWL-LICENSE.txt` is not swept: it is the third-party word list's verbatim copyright notice, with its authors' names and contacts, which the licence requires; the sweep found 0 unexplained hits.

| Sweep | What it looks for | Hits | Explanation |
|---|---|---|---|
| S1 | email addresses | 0 | none |
| S2 | Indian phone numbers | 0 | none |
| S3 | UUIDs | 217 | only the seven invented ids `00000000-0000-4000-8000-00000000000N` (N = 1 to 7), one per example and per mutant |
| S4 | runs of 10+ digits | 870 | only all-zero runs: the zero UUID tails and the all-zero 64-digit placeholder hashes |
| S5 | hex ids of 20+ characters | 651 | only the all-zero placeholder hashes (`code_sha256`, `prompt_sha256s`) |
| S6 | document-id shapes (mixed case and digits, 20 to 28 characters) | 0 | none |
| S7 | `*_uid` fields with a value | 0 | none; every uid is null |
| S8 | Aadhaar-shaped numbers | 0 | none |
| S9 | URLs | 2 | only the schema's `$schema` (json-schema.org) and `$id` (a non-resolving namespace id) |
| S10 | an honorific followed by a name | 0 | none |
| S11 | real model and vendor names | 0 | none in prose; the two dictionary word lists (`data/scowl_words.json`, `data/english_words_min.json`) are not swept for S11/S12 because they hold ordinary English words; the word list is kept by ETA |
| S12 | internal agent, person and branch names | 0 | none in prose (dictionary word lists exempt, as for S11); the word list is kept by ETA |

Speakers are `speaker_N`, rooms are `EXAMPLE-ROOM` and encounters are `EXAMPLE-ENC-N`.
