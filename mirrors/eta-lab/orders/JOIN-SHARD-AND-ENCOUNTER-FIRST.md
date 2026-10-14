# JOIN-SHARD + ENCOUNTER-FIRST (V, 24 Sep 10:20)

V asked two things:
- "Why can't we run multiple instances of the audio joining service so we don't get choked?"
- "Make the 5-minute clips be re-edited into encounter/conversation clips BEFORE we send anything for STT, based on the audio characteristics alone."

## Part A: JOIN-SHARD. Builder: join-shard (new session). Refuter: eta-refuter (Mini). Ship: scribe's train.

Known facts (lab-mover's studies/2026-09-24-redundancy/JOIN-SCOUT.md):
- The join is one global Durable Object ("joiner", services/audio-join/worker/index.js:53/:343) with an in-memory #busy lock (:95–121).
- wrangler.jsonc:19 has max_instances 1: a single standard-1 container, 0.5 vCPU.
- The choke is a design limit, not compute. More machines don't help until the lock is sharded.

Build:
1. Shard the DO by room (or session id). Joins for different rooms run in parallel; joins within one room stay serialized.
   - Find where the caller (lib/bench-join.ts) can pass the shard key.
   - A request without a key goes to the old "joiner" instance (back-compat).
2. max_instances = 6. Report the Cloudflare account limit and the cost per instance-hour before deploying.
3. Redundancy: the same container image (container/server.mjs + ffmpeg) runs as a join twin on c3, behind the eta-c3 tunnel, using an R2 S3-API token.
   - Find whether one exists in the Vercel env (names only). If not, say what's needed.
   - AUDIO_JOIN_URLS gets the twin as a second pool entry (service-pools code is already live).
4. Tests: parallel joins for two rooms both succeed; same-room joins still refuse or serialize; the keyless path is unchanged.
5. Deploy: find how the Worker is deployed today (wrangler auth: which machine, which account). Report it; don't deploy until Fable says so after the Refuter PASS.

Target: branch + tests by 14:00, deploy after 20:30 (the join is live-critical).

## Part B: ENCOUNTER-FIRST study. Owner: lx (E-7 truth owner), with diar-lab's embeddings. Compute: box + c3 only.

Question: can we cut each room's day tape into consult-shaped clips BEFORE STT, from audio plus the patient queue alone? If so, STT, diarization and analysis run per consult instead of per blind 5-minute window.

Method, on 23 Sep (the PQM truth day), for every room with truth:
1. Signals per second of tape:
   - energy/VAD (speech vs silence gaps; long gaps are candidate boundaries);
   - speaker embeddings every ~1.5 s from the BOX diarize twin (/embed_speakers). The doctor's voice is constant; a new patient/attender voice set appearing marks a new consult. This is the key signal.
   - PQM called_at / completed_at as a prior. It is not ground truth for the boundary second, and the room→doctor mapping comes via voiceprint.
2. Three segmenters, scored with the same E-7 scorer (recall, precision, start/end error in minutes):
   - (a) acoustic only (energy + speaker change);
   - (b) queue only (PQM times snapped to the nearest silence);
   - (c) fused.
3. Compare against the current E-6 fusion (recall 3/14, precision 3/7 on 23 Sep).
4. Also report how many joins a consult-first pipeline needs per clinic day (each consult clip = one join), so Part A can be sized.

Deliverable: studies/2026-09-24-encounter-first/REPORT.md, a table plus a recommendation. Target 17:00.
- Audio: single-chunk presigned reads only during clinic (never a join, never the Mini's services).
- Data stays in ~/eta-data (no audio or text in git).

## If B works: the pipeline change (design after the report, not now)
day tape → consult segments → one joined clip per consult (sharded join) → STT + diarization per consult → analysis per consult. The 5-minute windows stay as the live safety net until consult-first proves itself for a week.
