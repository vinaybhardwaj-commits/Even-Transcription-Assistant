# Ruling-42 log, surgery path (fleet) — ids only, no text

Recorded under Fable ruling 274 (25 Sep 2026, 01:00 review). One line each. Neither item is in a rater set or on any page.

- 2026-09-24 21:10 IST | N027#156 | v5fresh scoring run, frozen v5 (wording hash 4830ae152bf4), stage a via u9.ask to TypeSafe | PROBABLE name fragment (capitalised token right after a [PATIENT_NAME] redaction; eta-refuter-2 #1399, probable not certain) | item held not_a_consult, in no set, no page.
- 2026-09-24 22:29 IST | D20#143 | delta scoring run, frozen v5 (4830ae152bf4), stage a via u9.ask to TypeSafe | PROBABLE person name after "go to" (eta-refuter-2 #1399, probable not certain) | item held not_a_consult, in no set, no page.

NOT disclosures (ruling 274): N045#513 (greyed 'before' turn, never sent), N099#68 (judged a garbled verb, not a name), N057#116 (drug names).
Times are the last-write times of the scoring outputs (single passes, no re-score). Cause: capitalised tokens the model gave no signal on; the surgery path's pre-Jev screen was shape-based. Fix: deid.py --cap-rule (v7.15b, a53717d, on main as c7d4d01) recorded per file by deid_gpu.py and enforced before every Jev call by deid_gate.py (ab24121).
