# FUSER v1 — ADDENDUM 8: V7, clinical content inside English clauses must be supported (dated 2026-09-29, lid-debug, designer)
DRAFT until eta-refuter-2 witnesses. DEV phase (TEST unseen). Design gap found by the designer while reading dd22636 after the smoke (#5819).

## Gap (design §4, mine)
V5 validates the ENTITY list; V6 only checks that a clause cites >= 1 kept native item (validator.py validate_clauses). The clause TEXT
is free text and is never checked. A clause citing one valid item can say "ferrous sulfate 800 mg" and that invented dose reaches
text_en, which is (i) what S1 scores on the text_en row, (ii) what the G3 item builder extracts v1's "<drug> <dose> <unit>" from, and
(iii) what a reader sees. Same harm class as an invented native dose, which V3 already bars.

## V7 (runs after V5/V6, per kept clause)
Extract from the clause text:
  numbers: ASCII/Indic digits (incl. 1,500 and 0.5) and English number words incl. compounds ("twenty one", "five hundred",
           "fifteen hundred"), with an adjacent unit if present;
  drugs:   Latin words/bigrams matching the frozen lexicon (lexicon rx_history sha cd012faed4bc597a) at full-word skeleton >= 0.9,
           unique by >= 0.1 margin (the #4501 D2 thresholds).
Each extracted token must be SUPPORTED by the clause's own cited kept native items:
  number: equals a value parsed (fuserv1 number_parse + digits) from the text of a cited item, OR equals the value of a kept dose/
          duration entity whose native_items are among the clause's citations;
  drug:   the same lexicon entry as a kept drug entity whose native_items are among the clause's citations, OR as a cited item that is a
          lexicon_generic norm, OR as a cited Latin copy token matching that entry at >= 0.9.
Any unsupported number or drug -> the WHOLE clause is dropped (reason clause_unsupported_number / clause_unsupported_drug) and counts
as a CLINICAL drop (REPAIR/FALLBACK thresholds as for items). No redaction or rewriting of clause text.
Frequencies ("twice a day") and words like "once" are not numbers for V7 (same frequency-continuation rule as number_parse N1).

## Consequences (declared)
- Recall: English doses translated from native number words in kn/ta/te/ml cannot be supported until the parser reads native numbers
  (v2); those clauses drop. Safe direction; reported per language.
- The smoke's copies-only replies (#5819: 0 norms in 4 calls) make V7 more important: with no norms, drug entities rarely pass V5 (exact
  text match) while the clause text may still name the drug.

## Rollout without blocking the paid RUN 3
V7 is deterministic over the stored reply (en_clauses + kept items + entities are in each eval-out record). So: RUN 3 may run on
dd22636 as PASSed; the RUN 3 report computes EVERY text_en number (v1-vs-v0 table, G1-style wrong-dose count) with V7 applied by an
offline replay, and reports V7 drops per language. V7 is then built into validator.py with fixtures before the re-freeze.
Fixtures: clause citing a valid item but stating an unsupported dose -> dropped; supported dose (digit copied, or Devanagari English-by-ear
parse) -> kept; drug named in clause with matching kept entity -> kept; drug named with no support -> dropped; "twice a day" not treated
as a number; compound "twenty one" parsed as 21.
