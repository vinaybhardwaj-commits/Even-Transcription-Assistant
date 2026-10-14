# LOG — BACKFILL (every recorded hour transcribed)

Build and event log, newest first. Owner panes: hist-miner, hist-bulk, lab-mover, join-shard.

28 Sep ~22:2x-23:2x -- full historical backfill built+launched (19 Aug-25 Sep)
Session: hist-bulk, eta-refuter-3.
backfill_driver.sh: per IST date 25 Sep->19 Aug (27 dates, ~4,892 windows), cuts REB windows (reb_windows.py --plan tierC|tierAB) + real STT (reb's own runner) + TONE (--day flag), resume-safe. 3 real fix rounds with eta-refuter-3: B1 wait-per-PID for both workers; B2 done-marker on empty catalog; B3 nightly tone loop pause/restart on crash + orphan-claim cleanup (2 released live in selftest); C1 restore_on_exit relaunches tone_loop; C2 orphan sweep at START for both stores. PASSed at 6899d070. Launched 23:20 IST, PASS 1 starting 25 Sep (391 windows).
Refs: #5612-5615.

## 27-28 Sep -- PARITY-389 FINAL: NO MATCH, scope not met; nightly PQM automation live
Session: fleet, herdr-kit, eta-refuter-2, linker, hist-bulk.
Retried HF-vs-Mini compare (2 real bugs fixed first: refused-key false-absence, per-window audio identity vs ship manifest) still FAILED: HF capture used SRAVAANI_MODE=local not the Mini's real instance -- not comparable. Fable ruled (17:25) SraVaani out of scope, no further spend. Underlying tailnet ACL gap (HF can't reach Yoga SraVaani) unresolved. Whisper-path content divergence (1.4-21.2%, median ~9%) documented as real, not decode noise (temp-fallback ruled out). Nightly PQM-linking crontab live (23:45 IST) after fixing a real overwrite bug (rolling 3-day window would have clobbered the frozen 26 Sep bundle) and a moving-tag bug.
Refs: #4827-4899, #4680-4839.

## 27 Sep ~05:0x-07:0x IST — PARITY-389 compare NOT COMPUTABLE; HF job launched
Session: fleet, eta-refuter-2, hist-bulk, lx.
Compare script hardened twice on real integrity bugs (audio identity not checked against the ship manifest; unpinned golden/manifest inputs), PASS 1dfe6c7f (#4101). Correctly returns NOT COMPUTABLE: HF side had no capture. Fable launched the real HF job (a10g-large, cap $6, #4234). W28.1 26 Sep backlog drained overnight (hist-bulk #4058). W28.2 full-day encounter re-score harness PASS, merged main 46eae4dd (#4070).
Refs: #4066, #4091, #4101, #4234, #4070.

## 26 Sep ~19:4x IST — c13 / gpu-5 drained; PARITY readiness
Session: lab-mover, fleet.
c13 and gpu-5 final sweeps gate-1 PASS, stopped; l4 not swept (GPU stockout) (#3838/#3859). PARITY-389 readiness re-issued, 6/6 MATCH (#3795).
Refs: #3795, #3859.

## 26 Sep ~18:0x IST — PARITY-389 READY: fleet launches 21:15-21:30
Session: fleet (launcher), herdr-kit (cap verdict).
Fleet launches from the box driver (~/eta-data/hf-parity-389/capture/capture_driver.sh, dir 0700) at 21:15-21:30 box IST. Six pre-hashes re-hashed 6/6 MATCH (run_capture.py 9d5e4210, capture_driver.sh eb511d8e, whisper_bridge.ts 9265c7a6, package.json 3b9a5cf9, manifest 3f4a9ac7 48/48 staged, node_route.py cf4bc5ca = origin/main byte-for-byte). The BINDING re-hash runs immediately before launch; ANY diff = NO LAUNCH (no fix-forward tonight). Gate (Fable 423): all rooms stopped + Mini queue empty before launch; smoke ONE window first, then the 48; hard stop 07:25-07:30 by PID (fleet kills by PID, never pattern-kill); cap $10 verdict = herdr-kit's. fleet-watch pages annotated tonight — a PARITY-load room flag is a real signal, not acted on. Shared checkout FREEZE honoured (read-only).
Refs: #3770, #3775.

## 26 Sep ~17:2x IST — mirror 4-blob confirmed; c13 deferred; PARITY standby
Session: lab-mover + vj-refuter (4th-blob ruling) + Fable (c13 defer).
The 19:30 seal mirror will carry the WHOLE sealed dir (_vj-truth-sealed/): the 3 original items + wis-labels-V-20260926.json.gpg (a48c00b2…) + INGEST-MANIFEST.txt, per vj-refuter #3757 (same rules: sealed blob only, key never travels); Mini-side sha256 verify to vj-refuter after copy-back. c13 gate-1 ruling DEFERRED by Fable on one fact — do the 9 missing files (5 router-twin job jsons + 4 staged webms) have a second copy in the vault? lab-mover to check coverage READ-ONLY and post; covered → accept the gap (like l4), uncovered → short-restart. lab-mover acked standby; one-line tape_pull confirmation at the ~21:15 PARITY gate.
Refs: #3753, #3757, #3760, #3764.

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

- 29 Sep 2026 (rev 25): 25 Sep tone 418/418 done; duplicate-record bug (225 records, 218 windows) fixed, sidecar written; STT for 25/24 Sep deferred on GPU.
- 29 Sep ~19:27 IST (rev 26): cut-only driver plus HF STT; 25 Sep 393/393 and 24 Sep 238/238 done; runner guard broken by 9bb75cf5, fixed fd460731 (978d9969e2589af8), no blind window transcribed (#6982-#7037).
- 29 Sep ~23:10 IST (rev 27): T-BACKFILL-5 un-cancelled for 27 Sep only, HF; HF spend about USD 66.84 of 300 (#7602); Koyal lane launched #7592.
