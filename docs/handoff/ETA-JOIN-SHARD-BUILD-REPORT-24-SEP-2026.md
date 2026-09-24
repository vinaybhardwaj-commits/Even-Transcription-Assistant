# ETA-JOIN-SHARD build report — 24 Sep 2026 (Builder: join-shard)

Order: `eta-lab/orders/JOIN-SHARD-AND-ENCOUNTER-FIRST.md` Part A. Branch `vinay/join-shard`, off
`origin/vinay/s1-auto-drain` @ `a30186c`. **Nothing is deployed.** No migration.

## What changed
| file | change |
|---|---|
| `services/audio-join/container/join-core.mjs` | pure shard logic: `SHARD_HEADER`, `LEGACY_INSTANCE`, `JOIN_SHARDS = 32`, `fnv1a32`, `shardKeyFromHeaders`, `shardInstanceName`; `JOIN_SERVICE_VERSION` 1.1.0 -> 1.2.0 |
| `services/audio-join/worker/index.js` | door reads `x-join-shard`, routes to `shard-<n>` or the legacy `joiner`; bad key -> `bad_shard_key`; `/health` adds `shards`, `shard_header`; comments rewritten |
| `services/audio-join/wrangler.jsonc` | `max_instances` 1 -> 33 (32 shards + legacy) |
| `lib/bench-join.ts` | `shardHeader(req)`; `callJoinAt` sends `x-join-shard: <meta.session_id>` |
| `services/audio-join/twin/` | the c3 twin's front (`server.mjs`, `package.json`): the Worker's job over R2's S3 API in front of the UNCHANGED container |
| `tests/unit/join-shard.test.ts`, `tests/stubs/cloudflare-containers.mjs`, `vitest.config.ts` | 22 tests; the stub is aliased because `@cloudflare/containers` imports `cloudflare:workers` and lives in a node_modules CI does not install |
| `tests/unit/join-format.test.ts` | version pin 1.1.0 -> 1.2.0 |
| `services/audio-join/README.md` | Sharding and Twin sections |

## Design, and the two decisions that were mine
1. **Shard key = session id, hashed into 32 fixed shards** (not one raw Durable Object per session).
   Every shard is a container and `max_instances` is a hard ceiling; a raw name per session would
   ask for one more container than allowed the moment one more session joined. Same session ->
   same shard -> still serialised. Two sessions that collide on a shard serialise (the old
   behaviour), and the second is refused with `join_already_running`, which the app's pool already
   treats as failover.
2. **Sizing.** 11 rooms are enabled (6 with status `recording` in `scribe_rooms` at about 09:20 IST today). Expected refused joins for k
   concurrent keys over N shards: k=11 -> N=5: 6.4, N=16: 2.9, N=32: 1.6. Idle shards cost nothing.
   The test pins `max_instances == JOIN_SHARDS + 1` so the two cannot drift.
3. **A request with no header goes to the old `joiner`** (back-compat, tested). A malformed header is
   refused by name instead of quietly served by it.

## Cloudflare facts (checked 24 Sep; docs.cloudflare.com/containers)
- The Even Cloudflare account (verified with `wrangler whoami`; the id is in the lab's orders, not in this public repo). Account limits:
  6 TiB concurrent memory, 1,500 vCPU, 30 TB disk. 33 x `standard-1` = 16.5 vCPU / 132 GiB / 264 GB.
- Price (Workers Paid): memory $0.0000025 / GiB-s, CPU $0.000020 / vCPU-s (ACTIVE use only), disk
  $0.00000007 / GB-s; billed per 10 ms while running. **A standard-1 running flat-out costs at most
  $0.074 per instance-hour** (memory $0.036 + CPU $0.036 + disk $0.002); CPU is less at partial use.
  Monthly inclusions: 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk. `sleepAfter` 60 s unchanged.
  All 32 shards busy for an hour = about $2.4. Spend follows joins, not `max_instances`.
- Deployed state now: container `eta-audio-join-joiner` (id withheld), `max_instances: 1`,
  1 live instance, image built 29 Aug, `standard-1`, APAC.
- **UNVERIFIED:** what the platform does when a start would exceed `max_instances`. The design
  makes it unreachable (shards + legacy <= max) rather than relying on the answer.

## How the Worker is deployed today
- From `services/audio-join`: `npx wrangler deploy` (README). Worker `eta-audio-join`, last
  deployments 20 Aug and 29 Aug, both authored by the account owner, source "Upload" — i.e.
  from a person's machine with `wrangler login`, not CI. This box (e2e-80-13) had no wrangler auth;
  it now reads the Cloudflare API token from a 0600 file into `CLOUDFLARE_API_TOKEN` (never argv).
- `wrangler deploy --dry-run` here: builds the image (ffmpeg 8.1.2 layer), reports bindings
  `JOINER` (Durable Object) and `AUDIO` (R2 `eta-audio`), exits 0. It deploys nothing.
- `JOIN_TOKEN` is a Worker secret and persists across deploys; no re-put is needed.
- **The Durable Object migration is unchanged** (`Joiner` already exists as a SQLite class), so
  new named instances need no new migration.

## Suggested deploy order (Fable's go, after the Refuter PASS, after 20:30)
1. `npx wrangler deploy` from `services/audio-join`. The Worker accepts requests with and without
   the header, and the app does not send it yet, so nothing changes until step 3.
2. `curl <worker>/health` must show `version 1.2.0`, `shards 32`, `shard_header x-join-shard`.
   A pre-shard Worker answers without the last two.
3. Promote the app build that carries `lib/bench-join.ts` (`npx -y vercel promote <dpl_...>` from the
   `-ow` worktree). It then sends the header.
4. Watch `wrangler tail` for `instance=shard-<n>` lines and `containers list` for LIVE INSTANCES.
- **Rollback:** promote the previous app build (no header -> every join goes to `joiner`, as
  today), or `wrangler rollback` the Worker. `max_instances` 33 is harmless at rest.

## The twin (c3, tunnel `eta-c3`)
- Built, not started. `container/server.mjs` has no storage access (it only sees bytes), so a twin
  needs a front that does the Worker's job over the S3 API; that is `twin/server.mjs`. The container
  runs as the unchanged image under Docker on c3. Both bind loopback; the tunnel is the way in.
- AUDIO_JOIN_URLS then lists the Cloudflare Worker first and the c3 tunnel hostname second. Per the
  latest train commit (`a30186c`), service-pools ships DARK: enabling any `*_URLS` awaits a ruling and
  a measurement, so this is a decision for Fable, not part of this build.
- **Needs from V/Fable (not created by me):** an R2 S3 key pair for the twin. The APP's env already
  reads `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ENDPOINT`
  (and `R2_ADMIN_*`) — names from the code. **UNVERIFIED that they are set in Vercel or what they are
  scoped to**: the Vercel CLI token on this box is invalid, and I did not use the Vercel MCP env read
  because it can return values. Recommend a NEW key scoped Object Read on the tape prefix and Object
  Write on `clips/` only, rather than reusing the app's. Plus the same `JOIN_TOKEN` value as the
  Worker (the app sends one token to every instance).
- Shared-box caution: c3 is the e2e-ci host (16 vCPU, other jobs). `TWIN_MAX_CONCURRENT` defaults to
  2. The twin does not stop CI from competing for CPU.
- Not proven: the S3 store class (`s3Store`) has never met R2 — the tests use a fake store, and the
  `@aws-sdk/client-s3` install in `twin/` was not run. First real join on c3 is the proof.

## Known limits and follow-ups (for the Refuter to weigh)
- **Collisions still refuse**, they do not spill. A "try the next shard when the home shard is busy
  with a different key" mechanism would remove them, but it opens a window where one key runs on two
  shards at once, so I did not build it under a spec that says same-room joins stay serialised.
- **Pool failover on `join_already_running` (pre-existing)** sends a busy same-session join to the
  twin, where the same key can then run concurrently with the Cloudflare one. Clip keys are
  deterministic, so the outcome is the same bytes overwritten; it is wasted work, not corruption.
  The twin has its own per-shard flag but cannot see the Worker's.
- Per-instance cold start (1-3 s per the comment in `lib/bench-join.ts`; not re-measured by me) now applies per shard after a quiet spell.

## Gate (this box: e2e-80-13, Linux)
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `npm run check:silent`: 9 findings, the accepted pre-existing count; none in files I touched.
- `npm test`: first run 4557 passed / 1 failed. The failure was `s1-auto-drain.test.ts` R11 (a
  Postgres planner assertion; the planner chose a nested loop under load). It passes in isolation
  (59/59). It touches nothing I changed. Second full run: **205 files / 4558 passed / 1 skipped, exit 0.**
- Mutation check: routing every request to `"joiner"` fails 6 of the 22 new tests.
- Not run: `scripts/check-number-words.sh` (no lexicon change), `swift build/test` (no Swift change;
  Linux box).
- `wrangler deploy --dry-run`: exit 0 (see above).
- `package-lock.json` was generated by `npm install` on this box and is NOT committed (the repo has none).
