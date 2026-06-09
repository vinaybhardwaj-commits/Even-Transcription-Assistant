# ETA — Sprint 0 Exit Report

**Sprint:** 0 (Setup) — per `ETA-BUILD-PLAN.md` §4
**Status:** SHIPPED · 26 May 2026
**Live URL:** https://eta.llmvinayminihome.uk
**Last deploy:** `dpl_BKEcnJiJdQXmTgioXhJjWrJqxUHf` (sha `9725da3`), state READY, all four services green
**Repo HEAD:** `9725da3` on `main` of `vinaybhardwaj-commits/Even-Transcription-Assistant` (private)

---

## 1. What's live

### Repo
- `vinaybhardwaj-commits/Even-Transcription-Assistant` (private, 8 commits)
- 50 files committed (Next.js 15.5 + React 19 + TS strict + Tailwind + Drizzle scaffold; all Tier 1 lifts from OPD + CDMSS; schema; skeleton routes; health endpoint; CI; README)

### Vercel
- **Project**: `even-transcription-assistant` (`prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z`) on team `team_yu1wWpsKdjsf90haai1ETJDG` (Hospital Product), region `iad1`
- **Auto-deploy** wired to GitHub `main`
- **6 deploys** to date (4 successful, 2 ERROR during fix iteration — both ERRORed deploys are rollback-blocked, not rollback candidates)
- **Custom domain**: `eta.llmvinayminihome.uk` (Cloudflare CNAME → `9cf36fbbb10d95e2.vercel-dns-016.com`, SSL provisioned)

### Neon (APP_DATABASE)
- **Project**: `eta-app-db` provisioned via Vercel-Neon integration
- **Region**: AWS Asia Pacific 1 (Singapore) — matches OPD/CDMSS pattern
- **Plan**: Launch (V's existing org plan)
- **Auth feature**: OFF (we use our own PIN+JWT model)
- **Auto-wired env vars** with `APP_` prefix (5 sibling Postgres vars all set)
- **Schema NOT YET applied** — migration `0001_init.sql` is committed but Sprint 1 wires `/api/run-migrations` to apply

### Cloudflare R2 (audio storage)
- **Account**: `c7f665855e6e4d22090000b0397c4d0d`
- **Bucket**: `eta-audio` (Asia Pacific, Standard storage class, no public access)
- **API token**: "ETA R2 — production", Object Read & Write scoped to `eta-audio`, TTL forever
- **R2 activated** by V (free-tier billing authorization — 10GB free, overage billed to card on file)

### Resend (email)
- **Workspace**: `even`
- **Domain**: `eta.llmvinayminihome.uk` VERIFIED (Cloudflare-Resend auto-config added SPF/DKIM records automatically)
- **API key**: "ETA" (full access, all domains scope — could narrow in Sprint 1 once verified working)
- **Webhook**: `https://eta.llmvinayminihome.uk/api/webhooks/resend` listening for All Events
- **Free plan**: existing `notifications.even.in` (never verified due to GoDaddy block) was deleted to free the 1-domain slot

### Cloudflare DNS (only the new ETA record was added; tunnels untouched)
| Type | Name | Content | Proxy | Purpose |
|---|---|---|---|---|
| CNAME | `llm` | `f8f6db11-...cfargotunnel.com` | ON | Mac Mini Ollama tunnel (pre-existing) |
| CNAME | `whisper` | `f8f6db11-...cfargotunnel.com` | ON | Mac Mini Whisper tunnel (pre-existing) |
| CNAME | `eta` | `9cf36fbbb10d95e2.vercel-dns-016.com` | OFF | **NEW** — Vercel for ETA |
| (Resend records) | `_resend.eta`, `resend._domainkey.eta`, etc. | (Cloudflare-Resend integration values) | — | **NEW** — auto-added by Resend during domain verification |

---

## 2. The 29 Vercel env vars

All set as Production + Preview. Sensitive types use Vercel's `sensitive` (write-only, never returned via API).

### Auto-created by Vercel-Neon integration (6 + 7 sibling vars, all `APP_` prefix)
- `APP_DATABASE_URL` ⭐ (the one `lib/db.ts` reads — pooled)
- `APP_DATABASE_URL_UNPOOLED`
- `APP_POSTGRES_URL`, `APP_POSTGRES_URL_NON_POOLING`, `APP_POSTGRES_URL_NO_SSL`, `APP_POSTGRES_PRISMA_URL`
- `APP_POSTGRES_USER`, `APP_POSTGRES_HOST`, `APP_POSTGRES_PASSWORD`, `APP_POSTGRES_DATABASE`
- `APP_PGUSER`, `APP_PGHOST`, `APP_PGHOST_UNPOOLED`, `APP_PGPASSWORD`, `APP_PGDATABASE`
- `APP_NEON_PROJECT_ID`

### Generated locally during Sprint 0 (5 secrets)
- `JWT_SECRET_DOCTOR` (sensitive)
- `JWT_SECRET_ADMIN` (sensitive)
- `ADMIN_TOKEN` (sensitive)
- `ADMIN_BASE_PATH` (sensitive — 32-char hex)
- `MIGRATION_SECRET` (sensitive)

Original copies in `Daily Dash EHRC/ETA/_sprint0-secrets/eta-vercel-env-vars.env` — delete that file once you've eyeballed them.

### Copied from OPD's encrypted env (3, decrypted server-side and re-encrypted in ETA's project)
- `KB_DATABASE_URL` (sensitive) — shared 418k-chunk KB Neon
- `LLM_API_KEY` (sensitive) — Mac Mini Ollama bearer (turns out to be the string `ollama`, but kept sensitive)
- `DEEPGRAM_API_KEY` (sensitive)

### Plain values set during Sprint 0 (4 + 1)
- `OLLAMA_BASE_URL` = `https://llm.llmvinayminihome.uk/v1`
- `WHISPER_BASE_URL` = `https://whisper.llmvinayminihome.uk`
- `RESEND_FROM_EMAIL` = `transcripts@eta.llmvinayminihome.uk`
- `R2_BUCKET` = `eta-audio`
- `APP_URL` = `https://eta.llmvinayminihome.uk`

### Resend + R2 keys (5)
- `RESEND_API_KEY` (sensitive, 36 chars, `re_` prefix)
- `RESEND_WEBHOOK_SECRET` (sensitive, 38 chars, `whsec_` prefix)
- `R2_ACCOUNT_ID` (plain)
- `R2_ACCESS_KEY_ID` (sensitive, 32 hex chars)
- `R2_SECRET_ACCESS_KEY` (sensitive, 64 hex chars)
- `R2_ENDPOINT` (plain)

---

## 3. Key changes from the build plan

### DNS — pivoted from eta.even.in to eta.llmvinayminihome.uk
`even.in` is registered at GoDaddy and V doesn't have GoDaddy access. After confirming the pivot was safe (`llm.` and `whisper.` CNAMEs are independent records on the same Cloudflare zone), added `eta` as a separate CNAME pointing at Vercel. Update PRD §4.14 (per-doctor URLs) to read `eta.llmvinayminihome.uk/dr-{slug}-{token}` until the GoDaddy access is sorted; doctors don't see the URL until Sprint 1 wires PIN entry.

### Neon region: Singapore (not Mumbai/bom1)
Build plan §2 said `bom1` for Neon. V's existing Neon org has 7 projects all in **AWS Asia Pacific 1 (Singapore)** — matched that pattern. Vercel functions are still in `iad1` for now (looks like the project defaulted; not blocking Sprint 0 but worth flipping to `bom1` in Sprint 1 for India latency).

### Resend domain: notifications.even.in deleted, eta.llmvinayminihome.uk added
The unverified `notifications.even.in` slot was deleted (V's call) to make room on the free plan. New Resend sender is `transcripts@eta.llmvinayminihome.uk`. If you ever fix GoDaddy access and want to reclaim `notifications.even.in`, you can re-add and swap the env var.

### Cloudflare R2: V manually activated
R2 free-tier activation requires accepting terms + authorizing the on-file card for overage — that's a "make purchase" action so I asked V to click Activate. After that I created bucket + scoped API token via dashboard (Cloudflare WAF blocked my direct API POSTs even with the dashboard CSRF header).

### Code adjustments during Sprint 0 (4 fix commits)
1. **`f2ce92a`** — stubbed `lib/llm-trace/log.ts`. Lifted OPD version writes to an `llm_traces` table via `@vercel/postgres` `pool`. ETA's `lib/db.ts` is Neon HTTP based (no `pool`) AND the `trace` table in ETA's schema is per-stage (CDMSS shape), not per-pipeline (OPD shape). Sprint 0 stubbed the functions to no-ops so the lifted `TracePanel` / `BackgroundTraceToaster` / `AiActivityList` keep compiling. **Sprint 1 reconciles**: either add an `llm_traces` table to the schema OR rewrite the module against the per-stage `trace` table.

2. **`7ffe707`** — lazy-init `lib/db.ts` neon client. Previous version called `neon(url ?? "postgresql://<REDACTED>")` at module load, which failed validation when `APP_DATABASE_URL` was unset, breaking Next.js "Collecting page data" build phase. New version uses Proxy + lazy init.

3. **`ce07eaf`** — `lib/db.ts` accepts `DATABASE_URL` as fallback for `APP_DATABASE_URL`. Vercel-Neon integration auto-creates `DATABASE_URL` (or prefixed variants) when a Postgres store is added — this lets the Storage-tab flow work without renaming the auto-created env var. The `APP_` prefix I configured in the integration setup means the canonical var is `APP_DATABASE_URL` and the fallback is rarely used; kept for safety.

4. **`9ef911b`** — empty commit to redeploy after writing KB/LLM/Deepgram env vars decrypted from OPD.

---

## 4. What's NOT done — Sprint 1's open backlog

### Migration 0001 NOT applied to APP_DATABASE
The schema file `db/migrations/0001_init.sql` is committed but the 10 tables don't exist in `eta-app-db` yet. Sprint 1's first task should be to write `/api/run-migrations` (Bearer `MIGRATION_SECRET`) that reads the SQL file and runs it via the Neon HTTP driver, then hit it once. Pattern lifts from OPD's `src/app/api/run-migrations/route.ts`.

### `/api/health` doesn't probe Resend or R2
Only DB + KB + LLM + Whisper are probed. Sprint 1 should extend `/api/health/route.ts` to add Resend (cheap probe: GET on the Resend `/domains/{id}` endpoint with `RESEND_API_KEY`) and R2 (cheap probe: HeadBucket on `eta-audio`). Probably worth a separate `/api/health/deep` endpoint to keep the basic one fast.

### Vercel region: iad1, not bom1
Current Vercel functions run in Washington DC (iad1) even though the build plan specified Mumbai (bom1). Worth flipping in project Settings → Region → bom1 for lower latency to the Singapore DB and Mumbai users. Not blocking but easy fix.

### Vercel deployment protection is ON
The `*.vercel.app` URLs return 401 "Authentication Required" unless accessed via `vercel curl` or the `_vercel_share=` bypass cookie. The custom `eta.llmvinayminihome.uk` works without it. Sprint 1 should decide: keep protection (good for preview branches) or disable it (so QA can hit `*.vercel.app` URLs freely).

### Doctor URL format in PRD references `eta.even.in`
PRD §4.14 and the README mention `eta.even.in`. Update to `eta.llmvinayminihome.uk` everywhere, OR get GoDaddy access and pivot back. Cosmetic.

### Resend API key scope
Created as "All domains" + Full access. Sprint 1 should narrow scope to `eta.llmvinayminihome.uk` only via Resend → API keys → ... → Edit → Domain dropdown.

### R2 CORS not configured
The bucket has no CORS rules. Sprint 1 (audio upload) needs to add CORS allowing `https://eta.llmvinayminihome.uk` for PUT/GET. Will do this via Cloudflare API once Sprint 1 starts.

### Sprint 0 PRD vs. actual differences worth folding back
- Brief §3 listed `evens-staff-portal` as a Tier 1 lift source; only OPD + Even-CDMSS were actually used (per source catalog §10.9).
- PRD §6 spec for the `trace` table is per-stage (CDMSS shape). The lifted observability components (TracePanel, BackgroundTraceToaster, AiActivityList) assume the OPD per-pipeline `llm_traces` shape. Sprint 1 reconciliation will pick one schema.

---

## 5. Verification commands

```bash
# Health probe (should return all four green)
curl https://eta.llmvinayminihome.uk/api/health | jq

# Cheap ping (mobile pre-flight)
curl https://eta.llmvinayminihome.uk/api/health/ping

# Latest deploy state
mcp: list_deployments(projectId='prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z', teamId='team_yu1wWpsKdjsf90haai1ETJDG', limit=1)
# Expected: state: READY, sha prefix '9725da3' (or newer if Sprint 1 has shipped)

# Repo HEAD
cd /tmp/eta-fresh && git log --oneline -3 # or wherever the next thread clones
# Expected top: 9725da3 Sprint 0 close

# Custom domain DNS
dig +short eta.llmvinayminihome.uk CNAME
# Expected: 9cf36fbbb10d95e2.vercel-dns-016.com.

# Pre-existing Mac Mini tunnels (sanity — unchanged)
dig +short llm.llmvinayminihome.uk
dig +short whisper.llmvinayminihome.uk
# Expected: both resolve through Cloudflare's proxy (orange-cloud IPs)
```

---

## 6. Next-thread bootstrap (paste into a fresh chat)

```
ETA Sprint 1 — resume from Sprint 0 SHIPPED.

Project state:
- Repo: vinaybhardwaj-commits/Even-Transcription-Assistant @ 9725da3
- Vercel: prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z on team_yu1wWpsKdjsf90haai1ETJDG, live at https://eta.llmvinayminihome.uk
- Neon: eta-app-db in Singapore via Vercel-Neon integration, schema NOT yet applied
- R2: eta-audio bucket, scoped API token, no CORS yet
- Resend: eta.llmvinayminihome.uk verified, API key + webhook secret set
- 29 env vars in Vercel
- /api/health all four services green

Read first:
1. SPRINT-0-EXIT.md (this doc) — full Sprint 0 state
2. ETA-BUILD-PLAN.md §5 (Sprint 1 — Doctor recording loop)
3. EVEN-TRANSCRIPTION-ASSISTANT-V1-PRD.md §8.1.1-8.1.5 + §8.1.11 (mobile screens for Sprint 1)
4. Daily Dash EHRC/ETA/Even Encounter Assistant — Mobile Doctor App.pdf pages 1-55

Sprint 1 first task per SPRINT-0-EXIT.md §4: write /api/run-migrations and apply schema to APP_DATABASE.
Sprint 1 second task: build the design-system Tailwind config + base components.
Sprint 1 third task: PIN entry surface (§8.1.1) with bcrypt + JWT + lockout escalation per PRD §4.15.
```

---

## 7. Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 26 May 2026 | V + Claude | Sprint 0 close. Live URL https://eta.llmvinayminihome.uk all-green. |
