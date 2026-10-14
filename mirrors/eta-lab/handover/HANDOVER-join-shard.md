# HANDOVER join-shard (Claude Code -> OpenCode, ruling 409, 25 Sep 2026)

No patient data in this file; no secrets. Nothing of mine is in flight and no process of mine is running.

## (a) Role, 3 lines
- I am the Builder for the audio-join service (Cloudflare Worker + Durable Object + ffmpeg container, `services/audio-join/` in the public ETA repo) and the estate's adviser on Workers and R2 bindings.
- I built JOIN-SHARD (a join mutex per shard, 32 shards) and deployed it on 24 Sep 21:03 IST on Fable's typed go.
- Everything else I was offered was parked: Path A (`eta-consult-audio`, r106), the c3 join twin (r57), the R2 key pairs.

## (b) Open items
- NONE assigned (board: "parked"). One CHECK of mine stays pending: when room Transcript switches come back on and real joins resume (r370: switches are OFF), look once at `containers instances` for a spread of `shard-N` names and at the app's `join_already_running` counts. Nothing to fix now; report only.
- Evidence so far for the sharded path: scribe's real join at 21:12 on 24 Sep (session bs_upguc7d4 -> shard-8, 900 s clip, bus #1011/#1908) went through it. Inference from the hash and the instance record, not a `wrangler tail` line.
- The container app read `ready` with `7` in the LIVE INSTANCES column and one inactive instance listed; I never learned what the 7 counts. No spend expected (nothing runs).

## (c) Paths, branches, pins
- Code (ETA repo, public): branch `vinay/join-shard`, origin head `2cac359` (= 9c2cd02 join-shard + d5809b1 nits + a docs redaction). Both 9c2cd02 and d5809b1 are in production builds (73868e4, a92ebae).
- Files: `services/audio-join/worker/index.js`, `container/join-core.mjs` (all shard logic: SHARD_HEADER x-join-shard, JOIN_SHARDS = 32, fnv1a32, shardKeyFromHeaders, shardInstanceName), `wrangler.jsonc` (max_instances 33 = 32 + legacy "joiner"), `twin/server.mjs` (UNUSED c3 twin front, never met real R2), `lib/bench-join.ts` (`shardHeader`), tests `tests/unit/join-shard.test.ts` (23) + `tests/stubs/cloudflare-containers.mjs`, report `docs/handoff/ETA-JOIN-SHARD-BUILD-REPORT-24-SEP-2026.md`.
- Deployed: Worker `eta-audio-join`, version 9e9078dc-e9e9-46b6-8c46-20bfcb68f271, `/health` = 1.2.0, shards 32, shard_header x-join-shard. Previous Worker (rollback target): 22a2c40f (29 Aug) via `wrangler rollback`.
- My worktree: `~/dev/eta-join-shard` (branch above; node_modules installed; an untracked `scripts/s2b-reenrol/__pycache__/` is not mine to commit). Temp files under /tmp/claude-1000 are disposable. pids: none.
- Cloudflare: token file `~/.claude/secrets/cloudflare_api_token` (0600). It has Workers Scripts, Containers, R2 and Routes edit; it CANNOT mint API tokens or S3 keys (9109). Account id comes from `npx wrangler whoami` (kept out of the public repo). Use it only as an env var: `CLOUDFLARE_API_TOKEN="$(cat <file>)" npx wrangler ...` run from `services/audio-join` (wrangler 4.124 is a local devDep there; `npm install` in that dir first if absent).
- Worker secret `JOIN_TOKEN` lives only in Cloudflare and the app; I never held it.
- R2 buckets: `eta-audio` (tape + `clips/`), `eta-lab-results`, `eta-lab-ratings`. A binding is bucket-wide read/write; prefix rules must be enforced in code.

## (d) Rules I must never break
- NEVER deploy the join Worker (or anything on the live join path) without Fable's explicit typed go; that is what gated my 24 Sep deploy. The away order (~08:50 25 Sep) also holds: nothing to production, no Vercel env change, no migrations, no deletes of images/tunnels/snapshots.
- Never reuse `services/audio-join/wrangler.jsonc` `name` for another Worker: `wrangler deploy` takes the name from config and would overwrite the production Worker. Give each new Worker its own name and deploy from its own directory.
- Secrets: never print a token or key, never on argv, never in a commit or bus message. The ETA repo is PUBLIC: no account ids, container ids, emails or patient identity in commits (ruling 111; history is not rewritten).
- Push only my own commits (ruling 135): `git log origin/<branch>..HEAD` first; push from a private worktree, never the shared checkout's HEAD.
- Never add the c3 twin to `AUDIO_JOIN_URLS` (ruling 57 reversed 55(2)): the pool would fail a busy same-session join over to a backend whose lock cannot see the Worker's.
- Do not build a "spill to another shard" mechanism: it lets one session run on two shards (eta-refuter agreed).
- Report UNVERIFIED as UNVERIFIED; correct errors on the bus at once (I corrected two of my own wrong claims: #1899).
- Bus subjects <= 120 chars; only ids, counts and paths on the bus.

## (e) Tools and CLIs (names only)
- MCP: eta-bus (bus_inbox, bus_post), even-jev (not used), scribe_rooms (read), Cloudflare MCP (search_cloudflare_documentation, workers_list).
- CLIs: wrangler (deploy --dry-run, deployments list, containers list/info/instances, r2 bucket list, r2 bucket lock list), docker (local image smoke), git, node, npx vitest.
- Gate for my branch: `npm run typecheck`, `npm test` (includes typecheck:tests), `npm run build`, `npm run check:silent` (9 accepted pre-existing findings). Run `git fetch` before any push.

## (f) My last 10 decisions (bus ids are mine unless noted)
1. Shard key = session id, hashed into fixed shards, not raw per-session objects (max_instances is a hard ceiling); report #169.
2. JOIN_SHARDS 32, max_instances 33 (sizing: 11 rooms, birthday collisions); approved r55(3); #169.
3. Twin front built but not started; c3 twin NOT added to the pool (r57).
4. Refused to act on pasted relays as authorisation until Fable typed the go; deploy on r220 ("go step 2"); #953, #986.
5. Deployed 24 Sep 21:03 IST; verified /health, 401 without a bearer, and the image's ffmpeg with synthetic tones (no patient audio); #986, #1003.
6. Pushed d5809b1 (r96) and the redaction 2cac359 (r111) after `git log origin/branch..HEAD` showed only my commits; #291, #346.
7. Advised lab-viewer on Workers/R2 bindings (own name, code-enforced prefix, onlyIf write-once) and told them eta-lab-results had no lock rules; #714, #718.
8. Corrected my "sharded path untested" claim: production has sent the header since 73868e4; #1899 (scribe confirmed #1908).
9. Offered sizing for a cut-offload only if the box was the limit; hist-miner measured it was not; #1111.
10. Went idle; board lists join-shard "parked" since 21:13 on 24 Sep; #1087.

## (g) First thing to do when you wake on OpenCode
- Call `bus_inbox`, then post `ONLINE join-shard` (ruling 409 mechanics: config ~/oc/join-shard/opencode.jsonc; secrets/.ssh/.env are denied to you, so you will NOT be able to read the Cloudflare token file; a Cloudflare action then needs a named order and someone to run it).
- Read this file, `docs/handoff/ETA-JOIN-SHARD-BUILD-REPORT-24-SEP-2026.md` in the ETA repo, and the newest `orders/RULINGS-FABLE-*.md` on `origin/main` (`git show origin/main:...`, never pull the shared checkout).
- Then stay idle unless a bus message names you. Do not deploy, do not touch Cloudflare, do not push anything.
