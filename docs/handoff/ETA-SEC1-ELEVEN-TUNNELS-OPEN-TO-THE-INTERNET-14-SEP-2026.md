# ETA-SEC1 — eleven tunnel hostnames are open to the internet · 14 Sep 2026 · Orchestrator

**URGENT. This outranks every build item in the queue.** Found while checking whether a commit was
safe to push to the public repo. Nothing was changed. No service was exploited. Every probe below is
either a health check or an empty request that did no work.

## 1. What I found

`/etc/cloudflared/config.yml` publishes **twelve** hostnames on `llmvinayminihome.uk`. I probed each
once from a cloud container with **no credentials and no Tailscale access** — i.e. as any stranger:

| host | backend | result |
|---|---|---|
| `llm` | `localhost:11434` — **Ollama** | **200, open** |
| `disk` | `127.0.0.1:8765` | **200, open** |
| `status` | `localhost:8084` | **200, open** |
| `whisper` | `localhost:8081` | open (404 at `/`, but see §2) |
| `diarize` | `localhost:8001` | open |
| `stt` | (relay) | open (426 — websocket upgrade expected) |
| `indic` · `route` · `emotion` · `sravaani` · `surgvlp` | 8082 / 8083 / 8086 / 8085 / 8087 | open |
| `ssh` | — | **published. Not probed.** |
| `inbox` | `localhost:8000` | **302 → Cloudflare Access login — PROTECTED** |

**Eleven of twelve have no authentication. One does.** So the mechanism exists and is configured
correctly for exactly one host.

## 2. The 404s are not protection

`POST https://whisper.llmvinayminihome.uk/inference` with an empty body, no credentials, from the open
internet, returns **415 Unsupported Media Type**.

415 means the service accepted the request and rejected only the *content type*. It did not say 401 or
403. **There is no authentication on the transcription endpoint.** The `/` 404s on the other hosts mean
"no route at /", not "you may not be here".

I did not probe further. Reachability and the absence of auth are established; going further would be
using the services, not testing them.

## 3. Why this is discoverable

The hostnames appear in **27 tracked files on `main`** of
`github.com/vinaybhardwaj-commits/Even-Transcription-Assistant`, which is **PUBLIC**
(`gh repo view` → `"visibility":"PUBLIC"`, `"isPrivate":false`). Tonight's push of
`vinay/s1-auto-drain` (sha `6e68462`) added a branch carrying 187 handoff documents, including
**Tailscale IPs in 11 files** — those were not previously on `main`.

**But making the repo private would not fix this.** Every hostname with a TLS certificate is published
in Certificate Transparency logs, which are public and searchable by design. The repo made these easy
to find; CT logs make them findable regardless. **The fix is authentication, not obscurity.**

## 4. What is actually at risk

- **`llm` (Ollama, 200 open).** Ollama's HTTP API is unauthenticated by design and exposes model
  execution and model management. Open to the world, this is free compute for anyone who finds it, and
  an API that can pull and delete models.
- **`disk` (200 open).** I did not explore it. The name alone justifies treating it as the highest
  priority until someone says what it serves.
- **`ssh` published.** Not probed, and I will not. Its presence in the same tunnel with no visible
  Access rule should be checked by V directly.
- **The clinical services** (`whisper`, `diarize`, `emotion`, `route`, `indic`, `sravaani`) accept work
  from anyone. That is unauthenticated compute on the machine that also holds the database connection
  string and runs the room pipeline.

**No evidence of any misuse was looked for or found.** This is an exposure, not an incident.

## 5. The fix is not one checkbox

The Vercel app reaches `whisper`, `route`, `diarize`, `indic`, `emotion` and `sravaani` through these
same tunnels. **Putting Cloudflare Access in front of them breaks the pipeline** unless the app presents
a service token. So:

- **Safe tonight, almost certainly unused by the app:** `llm`, `disk`, `ssh`, `surgvlp`, `status`.
  Access policies on these break nothing the app does.
- **Needs a service token first:** `whisper`, `route`, `diarize`, `indic`, `emotion`, `sravaani`, `stt`.
  Cloudflare Access service tokens, with the token in Vercel env, is the standard shape. That is a
  proper piece of work and it should not be done at 21:00 with clinic in the morning.
- `inbox` is already correct and is the model to copy.

## 6. Ruling

**R-SEC1a.** This outranks E14, E15 and the E11 merge. Those continue tonight because they are already
in flight and cost nothing extra; **nothing new is queued ahead of this.**

**R-SEC1b.** Locking `llm`, `disk` and `ssh` is the highest value per unit of risk and is V's decision
to make tonight or in the morning. I have not touched them.

**R-SEC1c.** The service-token work for the six clinical hosts is its own round, planned properly,
with the app's env change and a verification that the pipeline still runs. **Not tonight.**

**R-SEC1d.** Repo visibility is a separate decision from this one, and making it private is not a fix.
It is still worth deciding deliberately rather than by default, given 187 handoff documents describing
a live clinical system are on a public branch.

## 7. What I did and did not do

Did: read the tunnel config (hostnames and backends only — no credentials, no tokens printed); one
unauthenticated GET per hostname; one empty POST to `whisper/inference`; read `gh repo view`; counted
pattern matches in tracked files.

Did not: probe `ssh`; explore `disk` or `llm` beyond the root; send audio to any service; change any
config, policy, DNS or service; look for evidence of misuse.

Orchestrator.
