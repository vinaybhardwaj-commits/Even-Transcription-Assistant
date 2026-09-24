# `eta-audio-join` — the joining service (U2)

Joins the covering pieces of a Bench recording into **one consultation clip** and writes it back
to the tape bucket. Built for `ETA-MCP-UPGRADE-PRD-20-AUG-2026-v1.0`, §5 and addendum 1.

Deployed **separately from the Next.js app**. Nothing in this directory is imported by the app,
and the app's `package.json`, `vercel.json` and `tsconfig.json` are untouched by it.

> **Requires the Cloudflare Workers paid plan ($5/month).** Containers are not on the free plan.

---

## Why it exists

A real consultation always crosses a five-minute piece boundary. Before this, the door refused
every such window with `multi_chunk_not_supported_v1`, so it could not play back a single complete
patient encounter.

**D14 — joining runs on Cloudflare Containers**, not the Mac Mini (which has ffmpeg but no join
route) and not a managed transcoder (most cannot join files; Cloudflare's own caps output at 60
seconds). The recordings already live in Cloudflare storage, so this adds no supplier and moves no
patient audio to a third party.

---

## Shape

```
POST /join ──► Worker ──► Joiner (Durable Object) ──► container (ffmpeg)
                 │            │  ▲                        │
              bearer          │  └── piece bytes ─────────┘
                            env.AUDIO (R2 binding)
```

- **`worker/index.js`** — the door. Bearer auth, then `getContainer(env.JOINER, <shard>)` (see
  "Sharding" below).
- **`Joiner`** (same file) — a `Container` subclass, hence a Durable Object. It holds its shard's
  single-job mutex, reads the pieces through `env.AUDIO`, streams them to the container, and
  streams the finished clip back into `env.AUDIO` with its provenance.
- **`container/server.mjs`** — Node's own `http` + one `ffmpeg` call. No dependencies.
- **`container/join-core.mjs`** — every decision, pure. Shared by the Worker, the container and
  the tests.

### Sharding (JOIN-SHARD, 24 Sep)

The mutex used to be one flag on one global Durable Object, so any join anywhere refused every
other. It is now one flag **per shard**.

- The caller sets `x-join-shard: <session id>` (`lib/bench-join.ts`, from `meta.session_id`).
- The Worker maps the key to `shard-<fnv1a32(key) % JOIN_SHARDS>` (`container/join-core.mjs`).
  Same key, same shard, always: joins within a session stay serialised (`join_already_running`,
  never queued). Different sessions on different shards run in parallel.
- **No header → the legacy `joiner` instance**, unchanged. A malformed key is refused
  (`bad_shard_key`) rather than quietly served by the legacy instance.
- The key is **hashed into a fixed number of shards** rather than used as a raw object name,
  because each shard is a container and `max_instances` is a hard ceiling. `JOIN_SHARDS` is 32 and
  `max_instances` is 33 (32 + legacy); a test fails if they drift. Two sessions that hash to one
  shard serialise; that is a collision cost, not a correctness one. With 11 rooms, expected
  collisions at N=32 are ~1.6 refused joins per full-clinic burst (N=5 would be ~4.4).
- `/health` reports `shards` and `shard_header`; a pre-shard Worker answers without them.

### How the container reaches the recordings

**It does not.** The Worker holds the R2 binding and does all the reading and writing; the
container only ever sees bytes on a socket. It runs with `enableInternet = false` and holds no
key, no token and no bucket name.

That means **no long-lived credential exists anywhere in this service** — not in the image, not as
a Worker secret. The alternative (minting presigned S3 URLs for the container to fetch) would have
needed an R2 access key pair as a secret *and* outbound internet in the container. The binding also
has to be used for the write regardless, because R2 custom metadata — the clip's provenance (D4) —
is written through it.

Nothing is buffered whole: R2 `head()` gives each piece's length, so the Worker can write the
frame's length prefix and pipe the body straight through. A 30-minute job costs about 5 MB of
Worker memory instead of 30.

Those `head()` sizes do a second job. The container hop refuses a request body of unknown length
("Provided readable stream must have a known length …"), so the body is a **`FixedLengthStream`**
whose total — header block, 8-byte prefixes and audio — is declared before a byte is read, by
`frameWireLength()`. It is an identity transform that only caps the byte count, so backpressure is
unchanged: one piece is in flight at a time. The count must be exact in both directions, which is
why a piece that is no longer the size `head()` reported fails by name (`piece_size_changed`)
rather than as an opaque stream error. The return hop needs none of this — `server.mjs` sets an
explicit `content-length` on every response, so the clip arrives length-aware for `put()`.

---

## Contract

```jsonc
POST /join
Authorization: Bearer <JOIN_TOKEN>
{
  "pieces": [ { "key": "bench/…/chunk_00011.webm", "idx": 11 }, … ],  // ORDER IS THE CALLER'S
  "trim":   { "start_ms": 164497, "end_ms": 884496 },                 // against the JOINED stream
  "out_key":"clips/<session_id>/<start>-<end>-<source>.webm",
  "meta":   { "session_id": "bs_…", "requested_start": "…", "requested_end": "…",
              "source": "primary", "created_at": "…" }
}
```

```jsonc
{ "ok": true,  "key": "clips/…", "bytes": 3025918, "duration_ms": 720007, "pieces": 3 }
{ "ok": false, "error": "input_too_long", "limit_minutes": 30 }
```

Pieces arrive already ordered and are **never reordered** — `idx` is carried for provenance only.
The service writes the clip and returns; it never returns audio bytes.
Every failure is a named reason at HTTP 200. There is no bare 500.

### Named reasons

| reason | meaning |
|---|---|
| `input_too_long` | the window is longer than 30 minutes (D2) |
| `join_already_running` | a job is in flight on this key's shard; **not** queued |
| `bad_shard_key` | `x-join-shard` is present but not `[A-Za-z0-9._:-]{1,128}` |
| `bad_out_key` | the key does not sit under `clips/` |
| `too_many_pieces` / `input_too_large` | 64 pieces / 128 MB ceilings |
| `piece_missing` | a key is not in the bucket |
| `bad_request_body` / `bad_piece` / `bad_trim` / `trim_end_before_start` | malformed job |
| `bad_frame` / `ffmpeg_failed` / `ffmpeg_timeout` / `output_empty` | the container's own |
| `unauthorized` / `join_token_not_configured` | the door |

### What ffmpeg actually does

Every input is pinned to its **first audio stream** and normalised to 48 kHz mono before `concat`:
these recordings are audio-only inside a container format that usually carries video, and a plain
stream label lets ffmpeg pick a stream that is not there. The window is cut with `atrim` **inside**
the join (D9), not from pieces trimmed beforehand. Output is Opus 32 kbps in WebM.

---

## Output container (`format`, added 3.1)

`POST /join` takes an optional `"format": "webm" | "ogg"`. **Absent means `webm`**, so every
request written before this parameter existed behaves exactly as it did.

Only the mux changes — the codec is `libopus` at 32 kbit/s mono either way, so an ogg clip and a
webm clip of the same window carry the same audio and are directly comparable.

**The service owns the key's extension.** `clipKey()` is deterministic by design (the same window
on the same session and mic is the same key, so re-joining overwrites rather than growing the
archive). Two *containers* of one window would therefore collide and the second would silently
replace the first, so `out_key` is rewritten to `.ogg` or `.webm` to match the format asked for.
A caller cannot get this wrong.

An unrecognised format is refused (`bad_format`), never quietly served as webm: handing a caller a
container it cannot read while reporting success is the failure this refusal exists to prevent.

Why it exists: Gemini accepts wav/mp3/aiff/aac/ogg/flac and **not** webm, so the room drain could
not feed it at all while this service could only emit webm.

## Deploy

```sh
cd services/audio-join
npm install
npx wrangler secret put JOIN_TOKEN     # FIRST DEPLOY ONLY — the secret persists across deploys
npx wrangler deploy                    # builds ./container for linux/amd64 and pushes it
```

### Verifying the deploy from outside

`/health` carries the version and the containers this box can emit, so "did my deploy land" is one
curl rather than a log-read. It needs no auth.

```sh
curl -s https://eta-audio-join.<subdomain>.workers.dev/health
# 3.1 and later: {"ok":true,"service":"eta-audio-join","clips_prefix":"clips/",
#                 "version":"1.1.0","formats":["webm","ogg"]}
# pre-3.1 box:   {"ok":true,"service":"eta-audio-join","clips_prefix":"clips/"}
```

A box still answering **without** `formats` is the pre-3.1 image: it will ignore `format` and
return webm bytes under a `.ogg` key. The room drain refuses that case before spending
(`ogg_join_unavailable`), but the health check is how you tell without waiting for a window.

Then set on the app (Vercel):

```
AUDIO_JOIN_URL=https://eta-audio-join.<subdomain>.workers.dev
AUDIO_JOIN_TOKEN=<the same secret>
```

With `AUDIO_JOIN_URL` unset the app degrades to exactly today's multi-piece answer (D10), so the
app can ship before the service does.

### Configuration worth knowing

| setting | value | why |
|---|---|---|
| `sleepAfter` | `60s` | at the 10-minute default this workload lands just outside the included monthly allowance; at 60 s it sits well inside |
| `instance_type` | `standard-1` | ½ vCPU, 4 GiB, 8 GB disk — a 30-minute re-encode is seconds of CPU |
| `max_instances` | `33` | `JOIN_SHARDS` (32) keyed shards + the legacy instance; each is its own container, so this is the platform's agreement with the per-shard mutex |
| `constraints.regions` | `["APAC"]` | D16 — pins to Asia Pacific. Cloudflare offers **no India region**; V has accepted that. Keeps the join next to the tape rather than moving it |
| `enableInternet` | `false` | the container has nothing to reach |

---

## Proving it on real tape

The unit tests (`tests/unit/audio-join-service.test.ts`) prove the decisions. They do not prove the
audio, and this is exactly the workload where a tool fails quietly — a "successful" join that is
really one piece long.

```sh
node services/audio-join/scripts/join-real-file.mjs job.json
```

It runs `container/server.mjs` as a local process and speaks the same framed protocol the Worker
speaks, so the code under test is the code in the image; only the R2 binding is substituted (the
pieces arrive by presigned GET, because a laptop has no binding). It fails if the joined clip's
probed duration drifts more than a second from the window asked for.

Downloaded tape lands in `scripts/.scratch/`, which is git-ignored. **Delete it after a run** — it
is a real consultation.

---

## The twin (`twin/`)

`container/server.mjs` only ever sees bytes, so it runs unchanged anywhere Docker does. What a box
lacks is the Worker's R2 binding. `twin/server.mjs` plays the Worker's part over R2's S3 API, and
speaks the same `POST /join` contract, so the app lists it as a second entry in `AUDIO_JOIN_URLS`
(`lib/service-pool.ts` does the failover on `join_already_running`, unreachable, timeout, 5xx).

Unlike the Cloudflare deployment, **the twin holds an R2 S3 key pair.** Scope it to Object Read on
the tape prefix and Object Write on `clips/`.

```sh
# 1. the unchanged container image, loopback only
docker build -t eta-audio-join ./container
docker run -d --restart unless-stopped --name eta-audio-join -p 127.0.0.1:8080:8080 eta-audio-join

# 2. the front (Node 22)
cd twin && npm install
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com R2_BUCKET=eta-audio \
R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… JOIN_TOKEN=<the SAME secret as the Worker> \
PORT=8090 TWIN_MAX_CONCURRENT=2 node server.mjs
```

It binds `127.0.0.1` only; the host's Cloudflare tunnel connector is the way in. `JOIN_TOKEN` must
equal the Worker's because the app sends one token to every instance. `TWIN_MAX_CONCURRENT`
(default 2) caps joins across shards, because a twin box is shared. Env names only are listed here;
values never go in a file.
