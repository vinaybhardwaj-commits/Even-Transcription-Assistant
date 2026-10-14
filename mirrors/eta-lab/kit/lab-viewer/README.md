# eta-lab-viewer ("ETA Lab Transcripts"), ruling 184 part B

Read-only viewer over the `eta-lab-results` vault. Phone-first SPA (Days grid + filters + search, Window
turns with original/English and ▶ per line + full-window player, Runs). No third-party scripts, no analytics,
strict CSP, `private, no-store` on everything.

## Safety properties (each has a test in `test/viewer.test.js`)
* Every request (all methods, all paths) verifies the `Cf-Access-Jwt-Assertion` first: RS256 only, JWKS from the team domain
  (fails closed if unreachable), `iss` exact, `aud` contains our tag, `exp`/`nbf`/`iat`, exact email allowlist.
  A failure is a bare `403`; no R2 call happens before it. Non-GET/HEAD is `405` after auth. There is no health route.
* Bindings `RESULTS` and `AUDIO` are only read (`get`/`head`/`list`); a test greps the source for any write/remove call.
* Audio is addressed as `/audio/<run_id>/<room_id>/<ist_date>/<window_id>/<n>` = chunk `n` of that window's
  `provenance.source_chunks`, resolved server-side from the vault file. A raw R2 key, a window not in the vault or a chunk
  number the window lacks is refused. Range (`bytes=a-b`, `a-`, `-n`) is served as 206; bad ranges are 416.
* Time mapping (client): abs = window `start` + line `start_s`; the chunk is the one whose `[started_at, ended_at)` holds abs;
  offset = abs - chunk `started_at`. The cut keeps recording gaps as silence on the wall clock (`cut_window.py`), so this holds.
  `tools/align_window.py` / `tools/align_check.py` check it against local audio copies.

## Deploy order (do NOT skip: the Worker must never be reachable without Access)
1. tunnel-ops creates the Access app on the approved hostname and posts the AUD tag. Confirm the app exists.
2. `npm i` here; then, with `CLOUDFLARE_API_TOKEN` (from `~/.claude/secrets/cloudflare_api_token`, never on argv) and `CLOUDFLARE_ACCOUNT_ID` exported:
   `npx wrangler deploy` (no route yet, `workers_dev` and `preview_urls` are off, so the Worker is unreachable).
3. Set the three secrets from stdin, never argv:
   `printf %s "$AUD" | npx wrangler secret put ACCESS_AUD` (same for `ACCESS_TEAM_DOMAIN`, `ALLOWED_EMAILS`).
4. Attach the custom domain (`npx wrangler deploy` with `"routes": [{"pattern": "<host>", "custom_domain": true}]` added), then verify: unauthenticated GET
   on `/`, `/api/index`, `/audio/...` each 302 to the Access login (never 200); the `*.workers.dev` name does not serve.
5. Hand eta-refuter-2 the hostname and commit.

## Data it reads
`index/windows-<date>.jsonl` (newest), `index/search-<date>.jsonl` (newest, searched in the browser), `manifests/`, `runs/.../<window>.json`,
and eta-audio chunks. Built by `kit/lab-vault/build-index.py`.

## Real-browser check (tools/browser_smoke.mjs)
Runs the real Worker code in headless Chromium (phone viewport) against real vault-shaped files and real local audio, with a local
stand-in for Access (a proxy signs a valid Access JWT). It walks Days, Runs, a Window, plays a line through the Range route and
compares the audio offset with an independently computed one, then searches. It reports console errors, CSP violations and any
non-local request. Setup (no root): `npm i playwright-core && npx playwright-core install chromium`; if system libs are missing,
`apt-get download libnss3 libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxdamage1 libatspi2.0-0 libnspr4`, `dpkg -x` them into a
directory and put its usr/lib/x86_64-linux-gnu on LD_LIBRARY_PATH. Build a temp index first
(`LAB_VAULT_STAGED=<dir> build-index.py --date 20260101`), then
`PW_DIR=<dir with node_modules> SMOKE_INDEX_DIR=<dir> node tools/browser_smoke.mjs`.
This found real bugs the unit tests could not (arrays passed to replaceChildren, an inline-style CSP violation).

## Doctor-voice-check page check (tools/voice_check_smoke.mjs)
Same idea for tools/doctor-voice-check/page.html on a real batch (counts and states only, no card text printed; harness page, copied
audio and screenshots stay in a 0700 dir): every card renders, no "[object"/undefined strings, no hidden-field words, clips play from
Blob URLs, 390 px layout and tap targets, the answer flows (agree / disagree + who / not sure / note / keyboard / pair), the Results
tab, and the blind-first evidence mode (`config/settings = {evidence:"after"}`). Build the harness with the page's own make-harness.py
(MOCK_DIR=<batch>/links, EVIDENCE=after for the blind mode), then `node tools/voice_check_smoke.mjs <out_dir> x before|after`.
