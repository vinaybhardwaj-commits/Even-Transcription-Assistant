# Loop-guard before/after watch, 25 Sep 08:05 -> 12:00 IST (split-speaker, Fable ruling 210)

Ticks at 08:05, 09:05, 10:05, 11:05 and a final tick at 12:00: one COUNTS-ONLY line each to eta-lab bus/FILLER-WATCH-25SEP.md.
No alarms: this is a measurement, not a monitor. Text is read in memory from production transcripts and never printed or stored.

MEASURE. Canonical repeat ratio v2, measure A (repeat_ratio_v2.py), on transcription_run.transcript_original of each window's latest run
(the run row is what remains after the whisper-shim, the router's collapse and the app's collapseAssembled). "Loop window" = at least one
measure-A loop. A window belongs to the period of its TRANSCRIPTION time (the guard runs when the row is written).
SPLIT. BEFORE = transcribed from 24 Sep 04:40 IST (whisper VAD off) until the deploy; TRANSITION = the 10 minutes after it; AFTER = from
deploy + 10 min. The deploy time is read from deploy_at.txt (ISO, IST) at every tick: scribe posts Vercel's own `ready` timestamp for the
a92ebae production deployment (loop guard 035c5b7), and I write it. If the deploy is rolled back and redone, the file is overwritten with the new
`ready` time and the split restarts. No file = no AFTER period. TRANSITION exists because a serverless deployment can keep serving from instances
that still hold the previous code for a short while after `ready` (scribe, bus #852); those windows count in neither BEFORE-vs-AFTER test and are
reported as a count. (Amended 24 Sep ~20:05 IST after scribe's note, still before any 25 Sep data; tonight's 73868e4 has NO loop-guard change, so
BEFORE simply continues through tonight's push.)

PRE-REGISTERED (written before any 25 Sep data existed; 24 Sep 19:50 IST):
 baseline  17 of 302 windows (5.6 %) carried a loop, 24 Sep 04:40 -> 19:46. Single hours ranged 0 % to 11.5 % at 20-31 windows an hour,
           so NO SINGLE HOUR IS EVIDENCE; only the pooled AFTER period is compared.
 P1  share:      loop windows / windows in AFTER  <=  2 %.  (Expected residue about 0.8 %: 2 of the 15 loops analysed on 24 Sep were number-protected.)
                 Reported with a Wilson 95 % interval and the exact one-sided Poisson probability of seeing that few loop windows at the
                 baseline rate. With fewer than 50 AFTER windows the share is reported as INSUFFICIENT and only counts are given.
 P2  mechanism:  every loop that remains in AFTER is PROTECTED by the number rule (a digit, or number words >= a third of the unit). This test
                 does not depend on sample size. On 24 Sep, 12 of 15 loop windows had UNPROTECTED loops (the guard should now collapse those).
                 Any UNPROTECTED residual loop in AFTER is the guard failing to act and is reported by count.
 Outcome is reported as PASS / FAIL per test at 12:00. A failure is reported as a failure.
 RULING 216 (Fable, 24 Sep 20:05): a92ebae is ordered live at 25 Sep 07:50 IST; the 08:05-12:00 watch is AFTER, 24 Sep's watch is BEFORE. This
 comparison is pre-registered here, before any 25 Sep data. The BEFORE figures agree with the older FILLER-WATCH.md 19:05 tick (16 of 283
 windows, 5.7 %, max hour 7.7 %): same measure, an earlier cut than the 17 of 302 above. The 07:50 time is the ORDER, not a measurement: the split
 uses Vercel's `ready` timestamp from deploy_at.txt, and if the deploy slips past 08:05 there is no AFTER period and the report says so.

- 08:05 IST 25 Sep | BEFORE (24 Sep 04:40 -> deploy 25 Sep 07:51): 321 windows, 18 loop (5.6%), 15 with an unprotected loop | TRANSITION (07:51-08:01, in neither pool): 0 windows | AFTER (from 08:01): 0 windows, 0 loop (n/a, Wilson95 [0.0-100.0%]), 0 unprotected, 0 protected-only | expected at baseline 0.0, P(<= observed | no effect) = 1.000
- 09:05 IST 25 Sep | BEFORE (24 Sep 04:40 -> deploy 25 Sep 07:51): 321 windows, 18 loop (5.6%), 15 with an unprotected loop | TRANSITION (07:51-08:01, in neither pool): 0 windows | AFTER (from 08:01): 0 windows, 0 loop (n/a, Wilson95 [0.0-100.0%]), 0 unprotected, 0 protected-only | expected at baseline 0.0, P(<= observed | no effect) = 1.000
