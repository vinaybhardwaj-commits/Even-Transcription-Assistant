# audio-join scout (Fable ruling 14) — locations only, lab-mover, 24 Sep

Source: `Even-Transcription-Assistant/services/audio-join/` (deployed separately from the Next app). Files: `worker/index.js` (365 lines), `wrangler.jsonc`, `container/{server.mjs,join-core.mjs,Dockerfile}`, `scripts/join-real-file.mjs`.

## Where the single-flight lock lives
- **One global Durable Object, not one per room.** `worker/index.js:53` `const INSTANCE = "joiner"`; every request goes through `worker/index.js:343` `getContainer(env.JOINER, INSTANCE).fetch(request)` (after the bearer check at ~:331–334).
- The lock itself is an in-memory flag on the DO class: `class Joiner extends Container` at `worker/index.js:82`; `#busy` declared `:95`, checked `:108` (refuses with `join_already_running`, "Do not queue"), set `:112`, cleared in the `finally` at `:121`. Design comment: `worker/index.js:19–23` (a Durable Object is single-threaded, so the flag is a real cross-colo mutex).
- The platform agrees with it: `wrangler.jsonc:19` `"max_instances": 1` (one container, `standard-1` = 1/2 vCPU, 4 GiB, `:23`), migration `new_sqlite_classes: ["Joiner"]` at `:42–45`.
- Caller side: `lib/bench-join.ts:252/261` reads `AUDIO_JOIN_URL`; `lib/bench-join.ts:272` notes the service's own mutex answers `join_already_running`; the retry/attempt accounting that T2 fixes is `lib/stt/room-drain.ts:801–811` / `recordFailure :482`.

## What per-room sharding would change (locations)
1. `worker/index.js:53` and `:343`: replace the constant with a name derived from a shard key (room or session id) so each key gets its own Durable Object and its own `#busy`. The door only sees the request, so the key must be readable there: either from the JSON body (`meta.session_id`, contract in the README) or a new header the caller sets in `lib/bench-join.ts` (~:261+).
2. `wrangler.jsonc:19`: `max_instances` must rise above 1, otherwise a second shard just fails to start a container. Each running instance is a separate `standard-1` container, so this is a cost/account-limit decision, not just a code one.
3. The `#busy` mutex (`:95–121`) becomes per shard: joins for different rooms run in parallel, joins within a room stay serialized.
4. The comments at `worker/index.js:19–23` and `:52` ("One box, one name") state the single-object assumption and would need rewriting.
5. Unchanged as far as I read: the R2 binding use and the container side (the README describes `container/server.mjs` as plain Node `http` plus one `ffmpeg` call per request; I did not audit it for hidden shared state).
Not verified: Cloudflare account limits on concurrent container instances, and whether the caller can always supply the shard key at the point it calls the join.
