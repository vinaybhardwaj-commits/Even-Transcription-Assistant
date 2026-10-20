# ft-refute-labels REPORT: FT2 labels.parquet sha256 28cecac9ef55 (Opus 5.5, Bedrock)
Independent recompute: own code in ~/wt/ft-refute-labels/work/recompute.py and compare.py. I read none of the lane code, f1_recompute.py or ft1_timing.py.
Inputs: 10.tsv (1,909 flagged Rx). S5 s5-clean via ftio.read_export: 1,938 records, 0 bad, 29 Rx exactly duplicated (identical rows), deduped to 1,909, all joined.
Clusters come from clusters-2026-10-18.tsv. split_guard ran with the list pin 52959278edd8; seed sha matched 3b10cbf1f278. 0 clusters straddle sets, and patient-key vs cluster-key set agree in 0 disagreements.
Rules: R1/R2/R4 regexes copied verbatim from p3a_counts.py (sha 490f5dc17bd3, asserted in code) with precedence R1>R4>R2. READ = 2026-10-19.

| Claim | Claimed | Mine | Result |
|---|---|---|---|
| Flagged Rx (all >= 2025-12-01) | 1,909 | 1,909 | PASS |
| Episodes total / D / H | 1,622 / 1,233 / 389 | 1,622 / 1,233 / 389 | PASS |
| Attributable surgeries | 383 | 383 | PASS |
| Matured Rx (>=94 d) | 978 | 978 | PASS |
| Matured episodes / h90 positives | 883 / 214 | 883 / 214 | PASS |
| h14 positives / later than d14 among h90+ | 163 / 51 (23.8%) | 163 / 51 (23.8%) | PASS |
| D h14 n/pos | 1,129 / 198 | 1,129 / 198 | PASS |
| H h14 n/pos (counts only) | 366 / 83 | 366 / 83 | PASS |
| D h90 n/pos | 659 / 150 | 659 / 150 | PASS |
| H h90 n/pos (counts only) | 224 / 64 | 224 / 64 | PASS |
| Max lag (min lag) | 82 d | 82 d (min 0; 0 events before Rx) | PASS |
| NaN rules h14 <14 d, h90 <94 d | as stated | reproduced; lag==14 (5 eps) is h14=1 | PASS (but see issue 1) |
| Anchoring: earliest flagged non-excluded Rx with that (cluster, event date) | as stated | identical anchors on all 1,622 rows | PASS |
| One surgery credited once per cluster | yes | 0 duplicate (cluster, event) keys; 6 clusters have 2 distinct-date episodes | PASS |
| anchor_excl | R1/R2/R4 on anchor's own event, kept negative | R1 19 / R4 18 / R2 7 = 44 negatives; 0 mismatches | PASS |

## Row-level join on prescription_uid (1,622 vs 1,622: 1,622 both, 0 left-only, 0 right-only; episode_id unique)
Mismatch counts, all rows (ids and labels only): cluster_key 0, split 0, h14 0, h90 0, days_to_surgery 0, event_date 0, anchor_excl 0.
D rows only (1,233): consult_ist 0, rx_date 0, age_days 0, n_rx_cluster 0, doctor_id vs S5 doctor_uid 0.
For H rows I read only prescription_uid, episode_id, cluster_key, split, h14, h90, days_to_surgery, event_date, anchor_excl and consult_uid (an id). I read no H feature, text or model input. The D-only read was filtered to split=='D'.
TOTAL label mismatches: 0.

## Issues
1. (FIX, rule) h14 maturity cutoff. The lane NaNs h14 at <14 d. SWARM.md (forest-lead data notes, binding) says "H14 final = Rx >= 18 days old (14 + 4 billing lag)", and h90 uses the +4 lag (94 d).
   This makes h14 inconsistent with h90. 33 episodes are aged 14-17 d (D 28, H 5): 23 are labelled h14=0 (D 19) and could be pending bills, not true negatives.
   Under >=18 d: D h14 n/pos 1,101 / 189; H 361 / 82 (counts only). Either add the 4-day lag or state the 14-day choice (Ale's wording) in DONE.md and in FT3/FT5.
2. (NOTE) consult_uid comes from S5, not 10.tsv. They differ on 108 Rx; 77 of these are episode anchors (D 56). The parquet matches S5 on 1,622/1,622 rows.
   Downstream joins on consult_uid (FT4 recorded consults, 10b) should know which source was used.
3. (NOTE) For 14 positive episodes the anchor is not the cluster's first Rx. In 7 of them an earlier Rx in the same cluster has no event (a different patient_key in the merged cluster, so S5 is per patient).
   Per the stated rule those earlier Rx are dropped, not negatives. This is consistent with the claim. 287 Rx anchor no episode (1 excluded Rx sits in a positive cluster).
4. (NOTE) The 29 duplicate S5 records are exact copies. Dedup does not change anything.

## Verdict: PASS-WITH-FIXES
Every claimed number reproduces exactly and there are 0 row-level label mismatches. The only fix is to decide on the h14 billing lag (issue 1) and document it; it does not change any claimed number under the rule the lane stated.
