# ft-runolink DONE

Model: Sarvam saaras-v4 (diarization, auto language) via Even gateway; driver lane model per orchestrator.
Shard: shard_rl3a.tsv

- calls in shard: 148
- skipped under 20 s (ffprobe): 0
- unprobeable (not sent): 0
- transcribed this run: 148
- already present (skipped): 0
- Sarvam minutes billed, lane cumulative: 392.5 (cap 412.7, prior runs 0.0)
- audio minutes transcribed this run: 392.5
- not sent, budget stop / ledger halt: 0
- given up (2 billed attempts already): 0
- retried once: 0
- failures after retry: 0
- ledger write errors (run halted): 0
- transcripts: ~/eta-data/forest/rl/stt/<key_id>.json (0600)

## ft-runolink summary (20 Oct 2026)
- rl3 linkage: 941/1,233 D episodes (tier A 563, tier B 385). Agent ids in rl/linkage/rl3-20261020-agents.jsonl.gz.
- Tier A new calls transcribed: 148 calls / 392.4 min (saaras:v4, rl/stt, tier col).
- Tier B precision ~78% overall, ~91% for 2-UHID phones (name-hit method). GO requested for the 2-UHID slice only (312 calls / 793.5 min). Details: RUNOLINK.md.
