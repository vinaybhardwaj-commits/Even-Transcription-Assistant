# LOG — BACKFILL (every recorded hour transcribed)

Build and event log, newest first. Owner panes: hist-miner, hist-bulk, lab-mover, join-shard.

## 26 Sep ~16:2x IST — lab-mover relaunched clean; c13 gate-1 gap for Fable
Session: lab-mover (fresh Go session; prior stalled at 63% context).
Six PARITY-389 hashes re-verified vs refuter-2 PASSed bytes; tape_pull/tape_vault_push cron healthy (10 rooms 0 missing/bad, 0 pending/rejected/mismatch, box free 204G); HF credit OK (cpu-basic COMPLETED, 402 gone). c13 gate-1 NOT closed: drained 25 Sep 15:41, final rsync rc=0, but verify showed 9 missing (5 router-twin jsons + 4 staged webms) — accept the gap (like l4) or short-restart c13, Fable's call. Tonight's 19:30 Air Drive mirror excludes c13 pending that word.
Refs: #3729, #3730, #3731.

## 26 Sep — incoming tape on c3; PARITY-389 tonight
Session: hist-bulk (loop on eta-ci-c3); fleet (gatekeeper tonight).
c3 high-throughput loop live: 14.2 audio-hours/hour, 0 failures; tier-C backlog caught up. PARITY-389 GO ~21:15-21:30 (six hashes, hard stop 07:25-07:30, cap $10): prove the HF A10G STT stack matches Mini production.
Refs: #3299, #3314, #3330; r389, r423.

## 26 Sep 03:00 IST — GCP fully off
Session: lab-mover.
All 5 GCP nodes powered off; compute billing stopped. S7 (disk/snapshot delete) pending 24 h + V's gcloud auth.
Refs: r386, r419.

## 25 Sep 05:00 IST — archive complete
Session: hist-bulk + hist-miner.
4,507 of 4,507 windows transcribed across Tier A/B on 62 cloud routers, 0 problems. Stage 1 + 2 formally complete.
Refs: #1629, #1639; r309.

## 24 Sep 21:03 IST — join sharding
Session: join-shard.
Cloudflare Worker `eta-audio-join` with 32 shards deployed (r220); first real consult through shard-8.
Refs: #986, r220.
