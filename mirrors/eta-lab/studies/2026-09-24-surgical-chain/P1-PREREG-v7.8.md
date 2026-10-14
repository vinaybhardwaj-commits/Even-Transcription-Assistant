# SURGICAL-CHAIN-LINKER P1: pre-registration v7.8 (linker, 24 Sep 2026): transcript provenance (rulings 192, 196) and the refuter's diagnostic columns (#779)

Addendum to v7.7; nothing earlier is edited. **No HIST text has been read and no real pair has been scored.** Code: `p1/link3_run.py` (the main-run scorer, built around the pilot's mechanics), committed with this file.

## L1. Provenance recorded per audio item (extends v7.2 D3; an item without it is excluded and counted)
- **`source`:** `hist` (research pipeline, the primary class comparison, v7.5) or `production` (the secondary check on the 4 fully covered items).
- **For `hist` windows:** the link-3 `window_id`, hist-bulk's run id and its start manifest, the `stack_id`, and the **sha256 of the stack-versions file, accepted only if it equals the sha256 of the published immutable copy in git** (`studies/2026-09-24-stt-parity/stack_versions.<stack_id>.json` on origin/main), never on `stack_id` alone (refuter #762, #775). A file whose sha256 does not match a published copy makes the item `provenance_unverified` and it is excluded from the primary comparison and counted.
- **`temperature_fallback: on`** (ruling 196): the research pipeline's whisper temperature fallback is active, so the text is **non-deterministic** and is accepted for mining only (rulings 131, 146). One transcription per window is used: the first successful output; a later re-transcription of the same window is a reproducibility note and never replaces it.
- **Whether the audio's date is before or after the 24 Sep 04:39 change** (kept from D3).

## L2. Diagnostic columns, report-only, no rule change (refuter #779)
1. **Full versus localized own score:** for every item the own-prescription score of the best room on the full plus or minus 10 minute text AND on the plus or minus 2 minute localized text; report how often the localized score falls by more than 0.15 from the full one, **split by route** (queue `KEY` against prescription-window `RXWIN`), because a software window may not span the real talk and truncating it could turn a true link into a below-floor "not linked".
2. **Neighbour in the padding:** a per-item flag and count of the same doctor's other same-day visits that start inside [consult start minus 10, consult end plus 10 minutes], so the leakage mechanism found in the pilot is measured on the 33 items, not assumed.
3. **Redaction counts beside every below-floor item** (names, addresses, phones, dates of birth, ids, ages, on the transcript side and the prescription side): a below-floor result may be de-identification or code-switching, not an absent visit.

## L3. Nothing else changes
The room floor and margin, the localized prescription-side margin (v7.7), SINGLE, INCOMPLETE (including an item whose HIST text is not English, since the gate refuses untranslated turns), the same-week positives-versus-N2 comparison, the procedure-mix table and the exclusion of the 4 pilot items from accuracy claims all stand. The 10 windows for the 4 fully covered items are a second priority list behind the running 89 (ruling 192; no restart); the primary comparison waits for them.
