# Ambient Brain — deploy (Kickoff A skeleton)

Standalone Cloud Run service. **Not** part of the Next.js/Vercel app. Own
`package.json` (dep: `pg` only), own `tsconfig.json`, own Dockerfile. State
lives in ETA's Neon (migration `0042_brain_tables`), decision B8.

## 0. Prerequisites (V, one-time)

1. **Migration 0042** — the ETA app owns the runner; the brain never migrates.
   After the app deploy that carries `db/migrations/0042_brain_tables.sql`:
   ```
   curl -X POST https://www.evenscribe.app/api/run-migrations \
     -H "Authorization: Bearer $MIGRATION_SECRET"
   ```
   Confirm `GET /api/run-migrations` lists version 42.
2. **Neon role** — create a dedicated role for the brain (SELECT/INSERT/UPDATE
   on `room_day`, `visit`, `speaker_cluster`, `cue`; SELECT on `room`). Its
   connection string is `BRAIN_DATABASE_URL`. Any `sslmode=` param is honoured
   (`disable` turns TLS off; anything else = verified TLS).
3. **Service token** — a long random string. Its value is `BRAIN_SERVICE_TOKEN`.
   Every route except `/health` requires `Authorization: Bearer <token>`.

Env var **names** only here; V sets values in Cloud Run (console or
`--set-env-vars` / Secret Manager `--set-secrets`). Never commit values.

| Env var | Purpose |
|---|---|
| `BRAIN_DATABASE_URL` | Neon connection string for the brain role |
| `BRAIN_SERVICE_TOKEN` | Bearer token for `/cues` and `/rooms/:id/state` |
| `PORT` | Injected by Cloud Run (default 8080) |

## 1. Deploy (project `clinical-infra`, region `asia-south1`)

Run from the repo root, authed as V (`gcloud auth login`, `gcloud config set project clinical-infra`):

```
gcloud run deploy even-scribe-brain \
  --source brain \
  --project clinical-infra \
  --region asia-south1 \
  --platform managed \
  --min-instances 1 \
  --max-instances 3 \
  --no-cpu-throttling \
  --cpu 1 --memory 512Mi \
  --concurrency 80 \
  --timeout 60 \
  --port 8080 \
  --ingress all \
  --allow-unauthenticated \
  --set-env-vars BRAIN_DATABASE_URL="<neon-brain-role-url>",BRAIN_SERVICE_TOKEN="<token>"
```

Notes
- `--min-instances 1` + `--no-cpu-throttling` = warm + CPU always allocated
  (PRD §8.1: the watcher in step 5 needs an always-on loop).
- `--allow-unauthenticated` at the Cloud Run IAM layer because the ears/kiosk
  proxy authenticate with the bearer token, not Google IAM. Flip to IAM
  (`--no-allow-unauthenticated` + invoker binding) if the org path requires
  it (B9); the code does not care.
- Prefer Secret Manager for the two secrets once available:
  `--set-secrets BRAIN_DATABASE_URL=brain-database-url:latest,BRAIN_SERVICE_TOKEN=brain-service-token:latest`
  (then drop `--set-env-vars`).
- Redeploy: same command. State is in Neon, so deploys are stateless.

## 2. Verify

```
URL=$(gcloud run services describe even-scribe-brain --region asia-south1 --format 'value(status.url)')

curl -s $URL/health
#  {"ok":true,"now":"...","db":{"ok":true,"latency_ms":NN},...}

curl -s -X POST $URL/cues \
  -H "Authorization: Bearer $BRAIN_SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"room_id":"room_xxxxxxxx","type":"other","at":"2026-08-17T04:30:00Z","payload":{"note":"hello"}}'
#  {"ok":true,"cue_id":"cue_...","cue_at":"...","state":{"visits":[],"active_visit_id":null,"clusters":[],"confidence":null,"as_of":"...",...}}

curl -s $URL/rooms/room_xxxxxxxx/state -H "Authorization: Bearer $BRAIN_SERVICE_TOKEN"
```

`room_id` must be an existing Room Bench room (`room` table, migration 0041);
unknown rooms get `404 {"ok":false,"error":"unknown_room"}`. Missing 0042 gets
`503 {"ok":false,"error":"brain_tables_missing"}`.

## 3. Local run

```
cd brain && npm ci && npm run build
BRAIN_DATABASE_URL=postgres://... BRAIN_SERVICE_TOKEN=dev node dist/server.js
```
