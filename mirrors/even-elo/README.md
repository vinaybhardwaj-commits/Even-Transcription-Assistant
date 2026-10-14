# Even-ELO

EHRC Surgical Governance Committee — Visiting Consultant scoring tool. Tracks
Caseload / Outcomes / Adherence per VC and recomputes the **ELO score** on every
observation write.

## Status: v1 SHIPPED 🎉

- **Live:** <https://even-elo.vercel.app/>
- **Ship tag:** `v1-shipped` on origin (head `92cc27a`)
- **Tests:** 70/70 unit · 51/51 smoke endpoints
- **Stakeholder:** EHRC Surgical Governance Committee (peer-led, 5 seats)
- **Confidentiality:** committee use only — URL is the gate (no auth in v1)

## Documentation (in the workspace folder)

- **PRD (locked v1.1):** `EVEN-EPI-PRD.md` — full data model, stream catalogue, scoring engine
- **Visual spec (BINDING):** `EVEN-ELO-MOCKUPS.html` — 6 mockup screens; no UI improvisation allowed during build
- **Build journal:** `EVEN-ELO-BUILD-JOURNAL.md` — per-sprint scope + close for ELO.0 → ELO.7
- **UAT checklist:** `EVEN-ELO-UAT-CHECKLIST.md` — Chrome MCP UAT script with sign-off
- **Carryover prompt:** `EVEN-ELO-CARRYOVER-2026-04-30.md` — paste this to spin up new threads

## Tech

- Next.js 14.2.0 App Router · TypeScript 5 · Tailwind · vitest
- `@neondatabase/serverless` HTTP driver (NOT a pool — `neon()` lazy via Proxy)
- Vercel Pro (Hospital Product team, auto-deploy on push to `main`)
- Neon Postgres project `even-elo` (Singapore sin1)
- No auth — URL is the gate. Every form stamps the entrant's **position** (e.g. "Customer Care Lead") from localStorage for audit defensibility

## Local development

```bash
npm install
cp .env.local.example .env.local
# Fill in DATABASE_URL from your Neon project
npm run dev
```

Open <http://localhost:3000>.

## OT sheet capture (Stage 1)

Phone capture has no login. Staff review uses the existing Governance session (super admin), same as the rest of Surgical Governance.

- Path, works before DNS: `/capture` on `governance.evenos.app` (and on Preview).
- Host, when DNS points at this Vercel project: `upload.governance.evenos.app` rewrites `/` to the same capture page. Optional extra hostnames: `OT_CAPTURE_UPLOAD_HOSTS` (comma-separated).

`FEATURE_OT_CAPTURE` defaults **off**. It is on only when the value is exactly `true`. Do not set that on Production until a separate go-ahead.

Preview smoke:

1. On the Preview environment set `FEATURE_OT_CAPTURE=true` and `BLOB_READ_WRITE_TOKEN` (private blob store). Optional `CAPTURE_IP_HASH_SALT`; otherwise the IP hash uses `JWT_SECRET`.
2. Redeploy Preview. Apply the additive migration: `POST /api/admin/migrate` with the ops bearer.
3. Open `/capture`, submit one image. Expect a `gov_document_captures` row with status `queued` and a private blob. The response does not include a public blob URL. Staff open the queue from inside Surgical Governance (`/surgical-governance`, then Capture queue). It is not a link on the main Governance home or sidebar. Image bytes come from the authenticated proxy.
4. With the flag unset or any value other than `true`, `POST /api/capture/upload` is rejected and the staff queue shows a flag-off state.

With `FEATURE_OT_CAPTURE_OCR` unset, Stage 1 behavior holds: upload does not call Vertex and does not write `surgical_cases`.

## OT sheet OCR (Stage 2)

`FEATURE_OT_CAPTURE_OCR` defaults **off**. It is on only when the value is exactly `true`. Do not set it on Production in this stage. `FEATURE_OT_CAPTURE` is unchanged.

Preview smoke:

1. On Preview set `FEATURE_OT_CAPTURE=true`, `FEATURE_OT_CAPTURE_OCR=true`, `BLOB_READ_WRITE_TOKEN`, and the existing Vertex secrets (`GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, `GOOGLE_VERTEX_MODEL`, `VERTEX_CLIENT_EMAIL`, `VERTEX_PRIVATE_KEY`). Leave `FEATURE_VERTEX_SUMMARIES` as it is — OCR does not use that flag.
2. Redeploy Preview. Apply the additive migration: `POST /api/admin/migrate` (adds `gov_ot_tracking_sheets`).
3. Open `/capture` and submit one JPEG of an OT tracking sheet. The response stays `queued`. Within about five minutes Vercel Cron calls `/api/cron/ot-capture-ocr`, or a super admin opens Surgical Governance → Capture queue and clicks **Process queued**.
4. A classified OT sheet appears at `/surgical-governance/ot-sheets` with `review_status` `pending_human`. Open it, edit a field, Save, then Approve or Reject. The image is the authenticated capture proxy. The case link stays “not linked (Stage 3)”.
5. With `FEATURE_OT_CAPTURE_OCR` unset, `POST /api/capture/process` and the cron both no-op (`skipped: flag_off`) and queued rows stay queued.

OCR does not mint `surgical_cases` and does not fill OT stream cells.

## Database migrations

```bash
# After deploying with a configured DATABASE_URL (and ADMIN_OPS_TOKEN set on that environment):
curl -X POST -H "Authorization: Bearer $ADMIN_OPS_TOKEN" https://even-elo.vercel.app/api/admin/migrate
```

Every operator route under `/api/admin/**` that used to be open by URL (migrate, db-fresh, db-snapshot, wipe-smoke-residue, seed-epi-base, seed-profile, oppe-scheduler, oppe-kickstart, bulk-import-physicians, dedupe-physicians, map-cdmss-doctors) now answers 401 unless the request carries a signed-in super admin session or `Authorization: Bearer $ADMIN_OPS_TOKEN`. An unset or short (under 16 characters) `ADMIN_OPS_TOKEN` disables the bearer path; it never opens it. The renamed variable replaces `ADMIN_MIGRATE_TOKEN` (set `ADMIN_OPS_TOKEN` on Preview and Production before the next deploy script run). `scripts/elo-smoke.sh` reads the same variable.

Idempotent — uses a `_migrations` marker table. 6 migrations applied at v1.

## Tests

```bash
npm test            # vitest, 70 unit tests on src/lib/scoring/
npm run test:watch
```

All tests are on the pure-functional scoring engine — no DB dependency, no flake risk.

## Sprint status

`EVEN-ELO-BUILD-JOURNAL.md` §3 has the full close history.

- ELO.0 → ELO.7 all shipped 2026-04-30 in a single session
- 12 sub-sprints, 14 commits, 0 deploy regressions
- All sprint rollback anchor tags (`pre-elo-*`) on origin
- `v1-shipped` is the launch tag

## Deploy

Auto-deploy on push to `main` via Vercel. Always poll `list_deployments` until `state === "READY"` before declaring a sprint shipped — webhook job ID is not a deploy success.

## Smoke matrix

```bash
bash scripts/elo-smoke.sh
```

Exercises 51 endpoints. Re-run on every push.

## Rollback playbook

1. `git revert <bad-commit>..HEAD && git push --force-with-lease origin main`
2. If a schema migration is involved: restore the Neon `pre-elo-schema-snapshot` branch
3. Vercel auto-redeploys the revert

## v1.1 backlog (parked)

Per PRD §14: VC self-service dashboards, statistical CIs, per-stream weighting, OPD→IPD conversion, multi-surgeon attribution, mobile responsive, SSO with Even OS, email/SMS digests, anomaly detection, hand hygiene unit dashboard.
