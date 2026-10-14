# De-id successor (deid.py v2, partial dates of birth): dated addendum, 25 Sep 2026

Author: surg-deid. Ruling basis: 307 (land and freeze in daylight, with this addendum), 316 (the surgery gate's allowed hash is REPLACED at the freeze), 321 (landing GO 08:30 IST, 25 Sep).
No patient text, no roster names and no item-level class are in this file. Ids only.

## 1. What is frozen

| | value |
|---|---|
| successor `deid.py` git blob | `b8b793507a566fc116fd3058e95a7c5dbbc115a0` (ruling 332, option B; the earlier candidate blob `0e55dc0f…` is superseded and was never used on real text) |
| successor `deid.py` sha256 | `bc375f78d4f0e1bef4965fee4570e50f506003e1605a1ebbd338f8ac44678f02` (recomputed independently by refuter-2, #1796, and by fleet, #1798) |
| landed as | `707a113` on origin/main (one commit, 25 Sep 08:30 IST; its three files are byte-identical to `d1e957b` on `surg-deid/dob-partial-b`, which is `2c54ce7` + `0e9d530` on `surg-deid/dob-partial` plus the string replacement; nothing else in the push; confirmed by refuter-2, #1978) |
| `test_deid_dob_partial.py` blob | `48d2793468572ad253e99e010fcd84b4eb51312e` |
| `deid_eval.py` blob | `72deb477d9a19f6fe59a6a8a0489bbb11fd57655` |
| predecessor (frozen a53717d lineage) | `deid.py` blob `5527f92082bc4403dad20949b69e82774a8b28b2`, sha256 `f092bf43…caa492`: the cap-rule redactor used for every link-3 and every regenerated surgery de-id so far |

The successor is the predecessor plus the partial-date rules below and nothing else. The cap rule (a53717d), the roster whitelist, the fail-closed Indic-script default, the thread cap and the CLI are unchanged.
On an invented consult with no partial date its output is byte-identical to the predecessor's.

## 2. Why it exists

During the link-3 batch-3 score, a turn of `c028|l3-c028-r2|2` held a birthday day and month with no year, which the predecessor did not redact and verify's residual gate did not see.
Cause, in the predecessor: (1) `REGEX_RULES` knew a date of birth only as a numeric date or as born/dob/"date of birth" followed by a four-digit year; (2) the model-DOB filter dropped a model hit unless it held a year or a cue matching `\bbirth\b`, and "birthday" does not match that.
Ruling 306 records `c028|l3-c028-r2|2` as a probable partial-DOB disclosure to Jev (verdict unchanged, nothing re-scored).
`l3-c015-r2` turn 10 (native, pilot) and the 20 sent v5 surgery turns (plus older rounds) with a day-month shape are UNCLASSIFIED (no model reader; V or Sandhya classify in daylight). Nothing in this addendum classifies them.

## 3. What the successor adds

- A day-month date (`9th November`, `9 of November`, `November 9th`, `March the 12th`, `the twelfth of March`, `twenty-first of June`, `12-Mar`) within 30 characters, on the same line, of a birth cue, in either order, is tagged `[DOB]`.
  Cues: born, dob, d.o.b., date of birth, birthday, birthdate, birth date, bday, b'day.
- Once a cue anchors a day-month date, EVERY occurrence of the same (day, month) in the turn is tagged, in any written form and however far from the cue.
- A numeric day-month with no year (`12/3`, `12-3`) after an UNAMBIGUOUS cue (dob, d.o.b., date of birth, birthday, birthdate, birth date, bday, b'day; a bare "born" is not one).
- A month of birth only (`born in November`), full month names except "may".
- The model-DOB filter also accepts birthday, birthdate, bday, b'day as cues.
- A day-month date with NO birth cue in the turn is left alone.

## 4. Limits, disclosed (all stated in the code)

- **L1 (over-redaction).** The cue-anchored match swallows the text between the cue and the date (up to 30 characters, one line). A surgery or appointment date within 30 characters of "birthday" is tagged, and the words between go with it. Safe direction; it can cost clinical words Jev would use.
- **L2 (the gate cannot see repeats).** Repeat-chasing lives in `Deid.spans` (`partial_dob_spans`), not in `REGEX_RULES`. `finalize.residual_identifiers` therefore sees only cue-adjacent dates; a repeat that somehow survived redaction would not be caught by the gate. The redactor is the only line of defence for repeats.
- A second mention of the same day-month (an operation date, say) is tagged when a cue anchors that date.
- A cue in a DIFFERENT turn is not seen.
- A cue word outside the list above is not seen (for example a bare "birth", "birthdays", "b-day").
- A cue more than 30 characters from the date, or on another line of the turn, is not seen.
- Month names in other languages are not covered; a date shape outside the forms above is not covered; repeats of a NUMERIC day-month are not chased.
- The cap rule's allowlist of full month names (unchanged from a53717d) leaves a person named exactly May, June, April, August or March untagged; the month-only rule (`born ... <month>`) excludes "may", the verb. Abbreviated months are not on that allowlist.
- Open: whether `l3-c015-r2` turn 10 shows one of the unseen forms above is settled only by the daylight read (ruling 306). If it does, the reader tells surg-deid only the form, the class of the cue word and the character distance, and a widening is a fresh review.

## 5. Evidence (invented text only; the successor has not been run on any real text)

- 14 tests in `test_deid_dob_partial.py`; 11 mutants of the rules each killed by the intended test (drop each rule, the repeat function, "date of birth", the dotted cue, ordinal words, "the", the hyphen separator, the numeric rule, "born" as a numeric cue, ordinal parsing).
- refuter-2's review (#1661): its own probes all redacted, 5 of 5 of its own mutants killed, PASS "as the successor redactor for partial dates of birth" with L1 and L2 to disclose.
- `deid_eval.py` (model on), surg-deid's own measurement on invented text, NOT reproduced by refuter-2: date-of-birth 8/8 (was 2/2), 48 planted / 45 removed with the same 3 Indic-script misses, roster doctors 5/5 kept, clean false positives 0/17.
- 42 tests pass across the DOB, cap-rule and CLI suites in the landed checkout.
- On `d1e957b`: `deid_eval.py` (model on) gives the same numbers as above (48 planted, the same 3 Indic-script misses, DOB 8/8, roster doctors 5/5, clean false positives 0/17; surg-deid #1800); refuter-2's #1655 probes and 5 of 5 mutants hold (#1796).
- **Handling slip (ruling 332, internal; ids only).** The birthday-and-date probe string, near-verbatim from the `c028|l3-c028-r2|2` turn (linker #1788), sat in private branches, in linker's and fleet's selftests on main and in bus posts #1650/#1653; it is real de-identified text, not an invented probe, and an earlier draft of this addendum wrongly called it invented (corrected in d3805ac). Not a disclosure outside Even. Option B replaced it before landing: `d1e957b` changes comments and test/eval strings only; the `deid.py` code is AST-identical to `0e9d530` (refuter-2 #1796). The old branch `surg-deid/dob-partial` is kept, not force-deleted, and holds the superseded blob. Linker's and fleet's selftests were changed to another invented date (25882cb, 38a39c2); git history keeps the earlier commits.

## 6. What changes after the freeze

- Ruling 307: from the freeze, no real-text Jev scoring on the surgery path or link-3 uses any de-id output made without the successor.
- Ruling 316: fleet's `deid_gate` allowed hash is REPLACED by `bc375f78…` (not added to). The 84 cap-rule-only surgery files (final-v5fresh 56, final-v5delta 15, final-v5rater 13) then fail the gate until regenerated with the successor. Who regenerates, and when, is Fable's.
- Link-3: link-3 de-id outputs predate the successor; none regenerated; no link-3 Jev scoring is pending (linker, #1759).
- The counts-only sizing tool `dob_count.py` (refuter-2 PASS #1698, at `9bf900d` on `surg-deid/dob-partial`) is separate, lands separately, and its one real-text run follows the freeze, with the frozen blob beside it. A count is a sizing figure, not a classification.
- Regenerating any set with the successor is a new run: hash and counts are posted before anyone reads, as for every earlier regeneration.
