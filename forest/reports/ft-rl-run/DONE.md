# ft-rl-run DONE (RUNO-AUDIO step 1), 19 Oct 2026 20:08 IST. Served by Opus 5.5 (global.anthropic.claude-opus-5-5) on Bedrock.

## Headline (D split only; H sealed and never read past the split filter)
- **G5 transcription set:** N_calls 945, N_episodes 370, total 2,328.3 min.
  - Window: days 0..13 after the Rx, day 0 only after the consult, before the surgery date, ffprobe >= 20 s.
  - T7 subset: 763 calls / 327 episodes / 1,945.9 min.
- **Shards** (the lab box ~/eta-data/forest/rl/shard_{a,b,c}.tsv, 0600):

  | shard | calls | hours |
  |---|---|---|
  | a | 315 | 12.94 |
  | b | 315 | 12.93 |
  | c | 315 | 12.93 |

  Columns: key_id, episode_id, patient_key, duration, path, call_key_l, day_from_rx, in_t7, call_date, call_ts (IST, recording time from the key), ext, answered, after_consult.
  Day-0 rows per shard: a 67, b 75, c 74 (216 in total).
  Flag: 18 shard rows have a call_ts date 1-154 days after call_date (the recording timestamp is not the call time). 9 of them are day 0, so their after-consult status is unverified. Waiting on newcat-deputy: drop them or re-time them from the call log.
- **Manifest:** ~/eta-data/forest/rl/manifest.tsv, 1,407 rows (every fetched file).
- **Audio:** ~/eta-data/forest/rl/audio/, 0700 dir, 1,407 files at 0600, 529,100,283 bytes. Files are named by key_id (obj_id).

## FINAL transcription set (20:25 IST, after forest-lead rulings on the 9 day-0 rows and the 3 G2 rows)
- **G5:** N_calls 933, N_episodes 369, total 2,298.3 min. T7 subset: 752 / 326 / 1,918.5 min.

  | shard | calls | minutes | day-0 |
  |---|---|---|---|
  | a | 311 | 766.3 | 77 |
  | b | 311 | 766.0 | 73 |
  | c | 311 | 766.0 | 57 |

- **Dropped versus the first 945:**
  - 9 day-0 rows whose call_ts (the key's recording time) was not on the call-log date, so the after-consult time was unverified.
  - 3 rows from ft-rl-stt-c G2-VIOLATIONS.tsv. These were flagged rows where call_ts is the upload time. They are kept out with sel/exclude-G2-19oct.tsv.
- **Remaining flagged rows:** 6, marked ts_is_call_day=0. They fall on days 1..13 by both call_date and call_ts.
- **manifest.tsv:** all 1,407 fetched files, with an in_shard column ("" = never send to STT).
- **Writes:** shards are written atomically (tmp + rename), 0600.
- **Rebuild:** ftrl_manifest.py SELECTION AUDIO_DIR OUT_DIR [EXCLUDE].

## Pipeline counts
- **RL-1** (8c6a38ab rerun): 800,244 objects, 237.5 GB, ok_rate 0.9978, distinct uuid 232 (per agent). The id24 segment is the Runo call_id.
- **W1 pulls** (gating-lead, Z1 confirmed):
  - W1a: 2,473 phone->patient rows.
  - W1b: 15,240 cohort-phone calls, 0 phone conflicts.
  - W1c: 1,233 Rx -> uhid_h.
  - Both md5 files were re-keyed and moved to _to_delete; receipts in ~/eta-data/forest/rl/linkage/.
- **RL-2 cohort:** 1,233 D episodes / 1,231 patients.
  - matched 3,285 files = 3,244 calls / 563 patients
  - ambiguous 4,479; outside_window 352
  - pre_decision 2,687 / post_decision 598
  - audio by call-log duration 117.4 h
- **Fetch set:** 1,407 calls / 414 episodes / 0.53 GB.
  - Window: days 0..14, pre_decision, outcome-revealing dropped (193).
  - Excluded: before Rx 456, after day 14 608, post_decision 598.
- **Shard drops:** under 20 s or unprobeable 223; day 14 12; day 0 before consult 227.
- **Checks:**
  - key_ts IST date equals the call-log date for 1,388 / 1,407.
  - Fetch guard dry run: "ok keys=1407"; a key outside the matched set was REFUSED.

## Code
- forest/rl-calllog-md5 @ 8c6a38ab (R6/R6b/R6c). Built by this lane because 23d209f9 could not do RL-2 on the ruled W1 inputs.
- Refuted by a fresh-context Opus 5.5 subagent: PASS-WITH-NITS; report ~/wt/forest-rl-r6-oref/.bc/forest-rl-r6-oref-REPORT.md.
- Re-gated by fable in FABLE-RL3-AND-R6-GO-19OCT-1942.md. G-RL lock: ~/eta-data/forest/rl/locks/G-RL-LOCK.json.
- Lane scripts (not in the gated repo): code/ftrl_cohort.py, ftrl_select.py, ftrl_manifest.py.

## Caveats
- Matching is phone-level. 4,479 ambiguous files are excluded, never guessed.
- whatsapp_number is not in W1a, so ambiguity is understated.
- n_uhid counts records, not people. The count of AMBIGUOUS phones that collapse to one kx_uhid is pending: it needs a kx_uhid pull.
- Day-0 after-consult uses the key's recording timestamp against consult_ist (minute resolution).
- 3 files were unprobeable and are counted as not answered.
- call_key_l is the Runo call_id, letters-encoded (decode with `tr a-p 0-9a-f`). ft-calltext tags use the raw call_id.
- Post-ship: R7 (after Wed) encodes the index id fields.
- Sarvam: none called by this lane. STT waits for newcat-orch "GO <N_calls> <minutes>" and the rl_stt.py refute.
