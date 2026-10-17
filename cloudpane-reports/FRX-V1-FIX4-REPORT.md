# FRX-V1-FIX4-REPORT (cloud-frx-v1-handoff, fix round 4, 17 Oct 2026)

Serving model: `claude-opus-5-5`.
Branch `cloudpane/cloud-frx-v1-handoff/v5`, built from v4 `1df358b6` (v1–v4 left as they are; no main, no PR). Fix commit `a5b3f98b`; this report is the next commit.

## Checks
- `run_checks.sh` exits 0. Examples are 7/7 valid. Mutants: 210/210 rows match. Both builders are byte-identical on rebuild. The R15 build step is a no-op on the shipped dictionary, which proves it is idempotent. There is no `__pycache__`.
- `eta-internal/run_internal_checks.sh` exits 0. The sweep finds 0 unexplained hits, the doc checks 0 failures, and all planted violations are caught. `HANDOFF-INDEX.md` hashes 247 files.
- New mutants: R15 3 (1 control), R16 4 (1), R17 4 (1), R18 5 (3), R19 3 (1), R20 3 (1). Each failing row was read: it fails on its intended rule.

## R15 brand-free vocabulary
`data/brand_names_curated.json` (248 trademarks) joins brand-map keys, LASA names, the drug denylist and medicine names in the subtraction. `tests/vocab/build_vocab.py` is the build step. `check_vocab.py` proves the intersection with drug and brand names is empty for the dictionary file, the loaded vocabulary, the abbreviation list and the order-object list; probes such as benadryl, sumo, dolo and pcm are not vocabulary. "Benadryl at night" and "Took Sumo" fail; "candid" stays ordinary English.

## R16 closed order objects
After take, start, continue, give, apply, use, have or add (base and -ing forms) in Plan, Advice and Follow up, the head of the next noun phrase must be a listed prompt, its attested generic, or one of 54 closed non-drug words in `data/order_objects.json`. "Take Sumo for the pain", "Continue the same medicines" and "Use the spray daily" fail; "Take rest and have plenty of fluids" passes.

## R17 undecidable change_dose
Any further dose number, "no wait", "actually", "keep it", "make it", "instead" or a second from/to after Y makes the dose undecidable, so the line shows no number. Three attacks fail; "the 500 was low, increase … to 1000" passes.

## R18 field withholding, suffixes, abbreviations
- **Withholding:** `withhold_clinical_fields` (the generator step) removes a diagnosis or comorbidity entry, or the examination, that holds an R13 hit. Its provenance becomes `field_withheld`, with the new reason `r13_vocab`. The note still emits.
- **Plan, Advice, Follow up and symptoms** keep the artifact-level R13 test.
- **Vocabulary additions:** suffix words of 7+ letters (-itis, -osis, -oma, -aemia/-emia, -pathy, -ectomy, -otomy, -scopy, -algia, -plasty, -uria) count as vocabulary unless they are forbidden words or match a drug stem. `data/clinical_abbreviations.json` holds 68 abbreviations and no drug alias.

| Set | Artifact-level false fails | Fields withheld |
|---|---|---|
| 7 examples | 0/7 (in-sample) | — |
| 20 clean notes | 0/20 (in-sample) | 0 |
| Held-out batches 1+2 | 0/20, target met | 2 (Telogen, Tinel); batch 1 informed "toothbrush" |
| Held-out batch 3 (out-of-sample) | 2/10, both R16: "use dental floss", "use a separate towel" | 2 |

## R19 salt words
A salt word is not vocabulary after an order verb, nor anywhere when a stopped, held or not-given drug carries that salt. "Continue calcium" with CALCIUM CARBONATE stopped fails, as A50 requires. Side effect, as the ruling reads: "Acid reflux reviewed" fails while FOLIC ACID is held (the old S6 control became an R19 fail row).

## R20 "pan"
An ordinary-word drug key fails V7 only in drug context: followed by a number, unit, form word, frequency token or "D", or after an order verb. "Pan D before food" and "Continue pan daily" fail; "Steam from a pan of hot water" passes. R15 therefore subtracts brand keys, not every word inside a brand name.

## New ASSUMPTIONs (A51+, full text in handoff/eta-internal/DESIGN-RATIONALE.md)
- A51 Brand keys are subtracted, not brand-name parts; everyday-word trademarks other than "sumo" are not curated.
- A52 R16 scope (fields, verb forms, noun-phrase head); "toothbrush" was added after held-out batch 1.
- A53 "Follows Y" means anywhere later in the quote.
- A54 Withholding is a generator step shared via the validator module; the validator still fails any R13 hit that reaches gp_extraction; suffix words are 7+ letters.
- A55 The held-salt scope and its "acid reflux" side effect.
- A56 Definition of drug context.
- A57 Weak versus strong dosage-form words ("lemon drops" and "ice cream" pass).

## Residual limits
- R16's closed list rejects ordinary objects after an order verb: about 20% of out-of-sample notes ("use dental floss").
- Specialist words still fail Plan, Advice, Follow up and symptoms.
- Everyday-word trademarks (other than "sumo") and generics absent from the lists but present in the dictionary pass R13 when no order verb precedes them.
- The bundle is 8.1 MB.
- The refuter's hold-out set was not available here.
