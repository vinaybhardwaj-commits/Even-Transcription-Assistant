# Surgery-30: the three extracts the builder needs (24 Sep, fleet)

**Why this exists:** the fleet pane on the E2E box has the Neon key (transcripts, read-only) but NO Metabase
access (`METABASE_URL` / `METABASE_API_KEY` absent), and `surgery_cases`, `prescription_surgery_recommendation`,
`queue_tokens`, `queue_token_steps` live in Metabase db 13. Drop three CSVs into
`/home/eta/eta-data/surgery-30/inputs/` (outside git, patient-linked) and run:

    python3 studies/2026-09-24-surgery-30/build_surgery30.py \
        --inputs ~/eta-data/surgery-30/inputs --out ~/eta-data/surgery-30 --repo ~/dev/Even-Transcription-Assistant

`python3 build_surgery30.py --selftest` proves the pipeline on synthetic data (mutation-checked, 5 mutants killed).

All SQL below is **INFERRED** from H-3's findings (orders/SURGERY-DETECT.md), not run against db 13 from this box.

## 1. consults.csv — one row per CONSULTATION step, 1-23 Sep IST
Columns: `token_uid, individual_uid, room_day_id, called_at, completed_at`
```sql
SELECT qts.token_uid,
       qt.metadata->>'INDIVIDUAL_UID' AS individual_uid,
       nullif(qts.called_at,'')::timestamptz    AS called_at,
       nullif(qts.completed_at,'')::timestamptz AS completed_at
FROM queue_token_steps qts
JOIN queue_tokens qt ON qt.uid = qts.token_uid
WHERE qts.station = 'CONSULTATION' AND qts.status = 'COMPLETE'
  AND nullif(qts.called_at,'')::timestamptz >= '2026-08-31T18:30:00Z'
  AND nullif(qts.called_at,'')::timestamptz <  '2026-09-23T18:30:00Z'
```
`room_day_id` is NOT in the warehouse (the display-board room map is NULL there). It comes from the E-7 room->doctor
voiceprint attribution (studies/2026-09-23-e7-pqm-truth/, `build_truth*.py` / `voiceprint-*.json`): map each
consult's doctor + time to the confirmed room-day, drop consults whose room-day has no confident doctor voice.
Rows without a `room_day_id`, `individual_uid`, `called_at` or `completed_at` are skipped by the builder.

**Coverage reality (measured 24 Sep, counts only):** transcript turns (`cue.type='stt_turn'`) exist on IST 9 Sep
(6 room-days), then 18-23 Sep (4-10 room-days/day); almost nothing on 1-8, 10-16 Sep. So "1-23 Sep" is effectively
those ~7 days, and the voiceprint-confirmed set is smaller still (23 Sep: 3 rooms). The stratum sizes below will tell
how many usable consults there really are; a short stratum is reported in `key.json`, not back-filled.

## 2. leads.csv — surgery_cases rows
Columns: `individual_uid, created_at, status`
```sql
SELECT individual_uid, created_at, status FROM surgery_cases
WHERE created_at >= '2026-08-31T18:30:00Z'
```
Stratum A = a NON-CANCELLED row with `created_at` in [called_at, called_at + 7 days] (H-3: median lag ~34 min,
created the same visit). CANCELLED rows are excluded from "lead". This reading of "lead" is mine; the order did not say.

## 3. rxflags.csv — prescription_surgery_recommendation
Columns: `individual_uid, prescribed_at, surgery_recommended`   (`surgery_recommended` true/t/1/yes counts)
**Column names and the link key to the patient are UNVERIFIED**: H-3 named `surgery_recommended / surgery_type /
confidence` but not the patient key or timestamp. Whoever runs this should map to `individual_uid` (via the token or
the prescription's patient id) and say how. Stratum B = a true flag within [called_at, called_at + 1 day] and NOT in A.

## Strata (Fable's order, 24 Sep 02:00)
A ~12 lead within 7 days | B ~12 flag but no lead | C ~6 neither. Seeded shuffle (24), transcript must be >= 300
characters. The page is blind to stratum; `key.json` holds the stratum per consult, kept out of the page.

## VERIFIED 24 Sep (Metabase key fixed; assemble_inputs.py ran; counts only)
- Auth: `x-api-key` header works; a valid `mb_` key was needed (the first key returned 401 on every endpoint).
- `surgery_recommended` values (30 days): no 1894, NULL 1449, yes 326, '' 250, 'Not provided' 1. Flag = 'yes'. `prescription_date` is TEXT and DATE-ONLY (YYYY-MM-DD): flags are matched to a consult by IST date (same day or next), never by timestamp. (My first builder compared timestamps and would have missed every same-day flag; caught before the real run, test + 2 mutants added.)
- uhid -> individual: `individuals.kx_uhid` -> `individuals.uid`. All 65 'yes' flags since 19 Sep resolved to exactly one individual; 0 ambiguous. The 74 consult individual_uids all exist in `individuals.uid` (id space matches). NOT validated against surgery_cases: 0 rows have both a surgery_cases.prescription_uid and a matching flag row, and none of the 230 surgery_cases since 1 Sep carries a prescription_uid at all.
- Consults: 927 CONSULTATION/COMPLETE on the 4 dates with a confirmed room-day (19, 21, 22, 23 Sep); 849 have no voiceprint-confirmed doctor; 0 doctors confirmed in two rooms the same day; 78 kept. Strata pools A 14 / B 2 / C 62; page holds A 10 / B 2 / C 6 (A lost 4 to transcripts under 300 characters).
