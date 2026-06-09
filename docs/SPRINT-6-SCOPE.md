# ETA — Sprint 6 Scope (proposed, awaiting V lock)

**Date:** 27 May 2026 (~02:30 IST)
**Author:** Claude
**Status:** DRAFT — awaiting V approval before any code lands
**Predecessor capstone:** `sprint-5-shipped` at `31c05c4`
**Prod state at start:** all 6 services green, sha `31c05c4`, region bom1 (verified §11 of carryover at start of this session)

---

## 0. Summary

Sprint 6 ships **three** items from the carryover §10 backlog. Inbound Resend replies is **deferred indefinitely** (V call). No new schema migrations (re-uses `llm_traces` table from migration `0002`). No new npm deps. Estimated **~9-12 focused hours** across 3 sub-sprints + 1 capstone.

| # | Item | Refs | Est | Risk |
|---|---|---|---|---|
| S6.1 | `/admin` obscure-path middleware + probe-404 noise | PRD §4.16 (amended) | ~2h | Low |
| S6.2 | Admin trace dashboard (`/admin/traces` + `/admin/traces/[id]`) | PRD §4.16 + §8.3.6, Figma Admin Desktop p6-7 | ~5-6h | Med (data shape from `llm_traces` is right but never queried at scale) |
| S6.3 | Per-encounter cancel button (mid-process) | PRD §8.1.6, no Figma frame | ~2-3h | Low |

V chose: keep current email/password admin auth (Sprint 4.C win) but obscure the URL; minimum-scope trace dashboard (2 pages, no sidebar refactor); defer inbound replies.

---

## 1. Locked decisions (from V via AskUserQuestion, 27 May 2026)

| Q | Lock | Implication |
|---|---|---|
| Admin auth model | Keep email/password, obscure URL | PRD §4.16's `ADMIN_TOKEN` Bearer pattern is NOT adopted. Multi-admin email/password from Sprint 4.C stays. URL moves to `/{ADMIN_BASE_PATH}/`. |
| Trace dashboard scope | Just `/admin/traces` + `/admin/traces/[id]` | No multi-page admin sidebar refactor. Trace pages get a minimal nav stub ("← Back to admin"); shared sidebar shell deferred to a hypothetical v7 admin polish sprint. |
| Inbound replies | Defer indefinitely | Out of this sprint. No schema add. No new webhook handler. Carryover §10 entry to be marked "deferred" not "pending". |
| Figma read depth | Admin Desktop + Flows full, Mobile §8.1.6 spot-check | Done; see §0. Mobile didn't mock the §8.1.6 cancel modal — using PRD prose copy verbatim. |

---

## 2. Sub-sprint S6.1 — `/admin` obscure-path middleware

### Goal
Make `/admin` unreachable from a guessed URL. Probes to `/admin`, `/dashboard`, `/cms`, `/wp-admin`, `/.env`, `/phpmyadmin`, `/login` etc. return real HTTP 404. The real admin lives at `/{ADMIN_BASE_PATH}/*` where `ADMIN_BASE_PATH` is a Vercel env var holding a 32-char URL-safe random string.

### Approach
Add `middleware.ts` at repo root that:
1. On any request to `/{ADMIN_BASE_PATH}/...`, internally **rewrites** to `/admin/...` (so the existing routing tree keeps working).
2. On any request to a path in the probe-block list (`/admin`, `/dashboard`, `/cms`, `/wp-admin`, `/.env`, `/login`, `/phpmyadmin`, `/administrator`, `/wp-login.php`, `/cpanel`), return a real 404 (Next.js notFound response).
3. On any request to `/api/admin/*`, leave untouched (admin cookie at `Path=/` covers them regardless of URL).
4. On any request that doesn't start with `/{ADMIN_BASE_PATH}` and isn't on the block list, pass through.

### Vercel env var
- New: `ADMIN_BASE_PATH` — set to a 32-char URL-safe random string (e.g. `7K3pM9nQ2vR8jL5xF4hT6sW1yC0bD3aN`). Set on prod + preview + dev.
- Update secrets file `_sprint0-secrets/eta-vercel-env-vars.env` with the new value.

### Files touched
- **NEW** `middleware.ts` — root level. Edge runtime (default).
- **NEW** `lib/admin-path.ts` — exports `getAdminBasePath()` + `buildAdminUrl(suffix)`. Used anywhere we need to construct an admin URL (e.g. login redirects).
- **EDIT** `app/admin/page.tsx` — already path-agnostic but verify it doesn't hardcode `/admin` anywhere in redirects.
- **EDIT** `components/admin/AdminLoginClient.tsx` — if it does any client-side redirect to `/admin`, swap to use `getAdminBasePath()`.
- **EDIT** `_sprint0-secrets/eta-vercel-env-vars.env` — add `ADMIN_BASE_PATH`.

### Schema delta
**None.**

### Risk
- **Low.** Rewrite happens at edge; if env var is missing in dev, falls back to `/admin` so dev workflow keeps working.
- The probe-404 list could accidentally 404 legit traffic if it grows too eager — limit to well-known scanner paths.
- Vercel deploy webhook lag (per carryover trap) — push empty commit if needed.

### Smoke test
```bash
BASE=https://eta.llmvinayminihome.uk
ADMIN=$ADMIN_BASE_PATH  # the new value

# Probes return 404
for p in /admin /dashboard /wp-admin /.env /phpmyadmin /login; do
  echo -n "$p: "
  curl -sS -m 5 -o /dev/null -w "%{http_code}\n" "$BASE$p"
done
# Expect: 404 for all six

# Real admin URL renders
curl -sS -m 5 -o /dev/null -w "%{http_code}\n" "$BASE/$ADMIN/"
# Expect: 200

# API admin endpoints still work at /api/admin/* (NOT rewritten)
curl -sS -m 10 -X POST "$BASE/api/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"vinay.bhardwaj@even.in","password":"<REDACTED>"}' \
  | python3 -m json.tool
# Expect: { "admin": { ... } }
```

### Rollback
- `git reset --hard sprint-5-shipped` reverts the code.
- Delete the `ADMIN_BASE_PATH` Vercel env var (the fallback in `middleware.ts` permits `/admin` again).
- Capstone tag: `sprint-6-1-shipped`.

### V dependencies
- V picks the 32-char random string (or I generate one and V approves).
- V sets it on Vercel project env (prod + preview + dev).

---

## 3. Sub-sprint S6.2 — Admin trace dashboard

### Goal
Two new admin pages: `/admin/traces` (list) + `/admin/traces/[id]` (forensic detail). Direct port of pattern from `OPD-Encounter-App/src/app/llm/dashboard/page.tsx` + `OPD-Encounter-App/src/app/llm/trace/[id]/page.tsx`, adapted to read from ETA's `llm_traces` table (migration `0002`, currently unused by any UI).

After S6.1 ships, these live at `/{ADMIN_BASE_PATH}/traces` and `/{ADMIN_BASE_PATH}/traces/{id}` thanks to the middleware rewrite — no extra wiring.

### Figma reference
Admin Desktop PDF page 6 (LLM Traces list) and page 7 (LLM Traces detail).

**Page 6 — list:**
- 4 KPI cards top: Traces today | Avg latency p50 | Tokens today | Cost today
- Filter chip row: `All stages 247` | `clean 35` | `critique 35` | `revise 35` | `cdmss 70` | `embed 72` | `✓ ok 240` | `⚠ flag 6` | `✕ error 1` | `All models ▾`
- Table columns: `TRACE ID | TIME | MODEL | STAGE | LATENCY | TOKENS in→out | COST | STATUS | ENCOUNTER`
- Header right: `LIVE TAIL` toggle + `↓ Export JSON`
- Footer: `Showing 14 of 247 traces · last 90 min · live tail streaming` + pagination

**Page 7 — detail:**
- `← Back to traces`
- Hero: `trc_<id>` + `⎘ Copy ID` + status badge (`✓ OK` / `⚠ Flag` / `✕ Error`)
- KPI cards: `LATENCY` | `PROMPT TOK` | `COMPLETION TOK` | `COST` | `RETRIES`
- (Below the fold in PDF — assume full prompt/response stream like OPD's pattern)

### Data shape (already exists in `llm_traces` from migration `0002`)
```sql
id              UUID
surface         TEXT (e.g. 'note-pipeline', 'cdmss-analysis', 'transcribe-compare', 'cleanup-live', 'cleanup-rolling')
encounter_id    TEXT (FK to encounter, nullable)
patient_id      TEXT
doctor_email    TEXT
request_input   JSONB
events          JSONB (array of timestamped events)
result_summary  JSONB
model_calls     JSONB (per-stage prompt/response/tokens/latency)
total_ms        INT
status          TEXT ('in_progress' | 'completed' | 'errored')
error_message   TEXT
started_at      TIMESTAMPTZ
completed_at    TIMESTAMPTZ
```

Indexes by `(surface, started_at DESC)`, `(encounter_id, started_at DESC) WHERE encounter_id IS NOT NULL`, `(status, started_at DESC) WHERE status != 'completed'`. Sufficient for the list query.

### Files created
- **NEW** `app/admin/traces/page.tsx` — server component, reads admin cookie, fetches paginated list from new API.
- **NEW** `app/admin/traces/[id]/page.tsx` — server component, reads admin cookie, fetches single trace.
- **NEW** `app/api/admin/traces/route.ts` — `GET ?surface=&status=&model=&limit=50&offset=0` returns rows + aggregates.
- **NEW** `app/api/admin/traces/[id]/route.ts` — `GET` returns single row with full `model_calls` payload expanded.
- **NEW** `components/admin/TracesList.tsx` — client component, filter chips + table + pagination + (deferred) LIVE TAIL polling.
- **NEW** `components/admin/TraceDetail.tsx` — client component, KPI cards + per-stage prompt/response sections.

### Files touched (minimal)
- **EDIT** `components/admin/AdminDashboard.tsx` — add an `← LLM traces` link in the dashboard so V can find the new pages.

### Schema delta
**None.** Table already exists.

### Risk
- **Medium.** `llm_traces` was added in Sprint 1 but **never written to by any ETA code** as far as the carryover indicates. The trace dashboard will render empty until pipelines start writing to it. Worth a side-task: confirm whether `/process`, `/transcribe/cleanup`, etc. write to `llm_traces` today, or whether the OPD-style `withTrace` helper still needs to be ported.
- **Mitigation:** before S6.2 ends, grep the ETA code for any `llm_traces` insert. If zero, add a follow-up: "S6.2b — wire `/process` to emit per-pipeline `llm_traces` rows."
- Performance: percentile aggregates (`percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)`) over the table need to be index-friendly. Run `EXPLAIN ANALYZE` on the aggregate query before shipping.

### Smoke test
```bash
ADMIN_JWT=$(curl -sS -X POST https://eta.llmvinayminihome.uk/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"vinay.bhardwaj@even.in","password":"<REDACTED>"}' \
  -D - | grep -i '^set-cookie:' | sed -E 's/.*eta_admin_session=([^;]+).*/\1/')

# List endpoint
curl -sS https://eta.llmvinayminihome.uk/api/admin/traces?limit=10 \
  -H "Cookie: eta_admin_session=$ADMIN_JWT" | python3 -m json.tool
# Expect: { "traces": [...], "aggregates": { "p50_ms": ..., "p90_ms": ..., "count": ..., "errored": ... } }

# Detail endpoint (substitute a real trace id from list output)
curl -sS https://eta.llmvinayminihome.uk/api/admin/traces/<some-uuid> \
  -H "Cookie: eta_admin_session=$ADMIN_JWT" | python3 -m json.tool
# Expect: { "trace": { ..., "events": [...], "model_calls": [...] } }

# Pages render
curl -sS -m 10 -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: eta_admin_session=$ADMIN_JWT" \
  "https://eta.llmvinayminihome.uk/${ADMIN_BASE_PATH}/traces"
# Expect: 200
```

### Rollback
- `git reset --hard sprint-6-1-shipped` reverts.
- No env vars to roll back.
- Capstone tag: `sprint-6-2-shipped`.

### V dependencies
- None during build.
- Post-deploy: V to eyeball the live UI, confirm column ordering + chip filtering + click-through to detail.

---

## 4. Sub-sprint S6.3 — Per-encounter cancel button

### Goal
A visible cancel affordance on the encounter detail page while the `/process` pipeline is streaming. Tap → confirm modal → abort the in-flight fetch → encounter status reverts to `draft` (or stays `processing` with a flag — TBD below) → doctor navigates back to the finalize/review screen to edit and retry.

### PRD reference
§8.1.6 — exact copy locked. Modal text: *"Cancel processing? Your transcript will return to the review screen for editing. The pipelines will not run."* Buttons: `[Keep processing]` `[Yes, cancel]`. On confirm → return to §8.1.5 (finalize/review).

### Behavior
- Cancel button only visible during streaming (status === 'processing' AND NDJSON stream is open).
- Confirm modal uses existing modal/dialog component from the codebase (need to grep — likely `@radix-ui/react-dialog` if Sprint 1-5 introduced one, or hand-rolled).
- On confirm → `AbortController.abort()` on the in-flight `/process` fetch.
- Server-side: `req.signal` already propagates to upstream Ollama calls (per carryover lock). When client aborts, server's awaited LLM calls reject with `AbortError` → existing `/process` route should already 499-handle (verify).
- Encounter status: PRD §8.1.6 says "your transcript will return to the review screen for editing." Implies status reverts to draft. But the encounter row may still have partial `note_json` from the cancelled run. Decision: set `status='draft'`, clear `note_json` and `cdmss_json` to NULL, append audit_log entry `cancelled_by_doctor`. **Lock with V before coding.**

### Files touched
- **EDIT** `components/encounter/EncounterDetailClient.tsx` — add Cancel button while streaming, render confirm modal, wire AbortController.
- **EDIT** `app/[slug]/api/encounters/[id]/process/route.ts` — on `AbortError` server-side, write status back to `draft`, null the partial outputs, audit log.
- **NEW (maybe)** `components/ui/ConfirmModal.tsx` — if no existing reusable confirm modal pattern. Worth checking the codebase first.

### Schema delta
**None.** `encounter.status` enum already includes `'draft'`. Audit_log writes already exist.

### Risk
- **Low.** AbortController is well-understood; `req.signal` is already wired per carryover.
- Edge case: if cancel arrives AFTER server has written `note_json` but BEFORE `cdmss_json`, do we keep the note or clear it? PRD says return to review screen — implies fresh start — so clear both. But if V wants "salvage the note if it's done," need to wire that decision in.
- Race: doctor taps cancel + server completes within the same 100ms window. Server-side guard: if status is already `complete` when cancel write arrives, no-op the revert.

### Smoke test
- Manual: start a recording in dev, submit, watch processing, tap Cancel during note/cdmss generation, confirm modal, accept, verify return to review screen with transcript preserved and status = draft.
- Re-submit the same encounter, verify the full pipeline runs cleanly.
- Cancel during the cdmss phase specifically (longer-running) to verify abort propagates.

### Rollback
- `git reset --hard sprint-6-2-shipped`.
- Capstone tag: `sprint-6-3-shipped`.

### V dependencies
- Lock on the partial-output handling: clear both / salvage note only / salvage both.
- Eyeball the modal copy + button order in dev before merge (Yes,cancel as destructive-styled).

---

## 5. Capstone

After S6.1 + S6.2 + S6.3 ship cleanly:
- Capstone tag: `sprint-6-shipped`.
- Update `ETA-CARRYOVER.md` §10 backlog: strike obscure-path, trace dashboard, cancel button. Move inbound replies to "deferred indefinitely" (not pending).
- Update `MEMORY.md` index with a Sprint 6 ledger entry pointing at a new topic file.
- Push empty commit if Vercel webhook lags > 60s.

---

## 6. Open questions for V before code lands

1. **`ADMIN_BASE_PATH` value:** want me to generate the 32-char random string, or do you want to set it yourself? (Either way, gets written to `_sprint0-secrets/eta-vercel-env-vars.env`.)
2. **S6.3 partial-output handling:** on cancel mid-process, clear both `note_json` and `cdmss_json`, OR salvage `note_json` if it completed before cancel? (PRD implies clear both; "salvage" is a kindness if note is done.)
3. **Build order:** S6.1 → S6.2 → S6.3 (in carryover/PRD order)? Or interleave? Recommend S6.1 first because it isolates the admin attack surface BEFORE the trace dashboard exposes more data.
4. **Live tail in S6.2:** Figma shows a LIVE TAIL toggle on the trace list. Build now (adds polling/SSE), or stub the toggle as disabled and defer to v7? Recommend defer — polling adds complexity and you can refresh manually.
5. **Trace pages sidebar:** Figma shows the navy sidebar on every admin page; current `/admin` is a single page with no sidebar. New trace pages have three options: (a) minimal nav stub (← Back to admin); (b) build the sidebar shell now and refactor `/admin` to use it; (c) inline trace pages into the current single-page admin as tabs. Recommend (a) — smallest scope; sidebar refactor lives in a real v7 admin polish.
6. **Deferred to next sprint or longer-tail:** the `llm_traces` table may have zero writers today. If so, the trace dashboard ships empty. Want me to add `S6.2b — wire pipelines to emit llm_traces` to this sprint, or carry it forward?

---

## 7. Estimated effort + delivery shape

- Total: ~9-12 focused hours.
- Suggested rhythm: lock open questions (§6) → S6.1 (≤2h, deploy + smoke) → S6.2 (5-6h split across at least 2 deploys) → S6.3 (2-3h, deploy + smoke) → capstone tag + memory update.
- Expect 1-3 hotfixes per the recurring traps (TS narrowing, cookie path scope, SWC JSX escape — see carryover §6).

---

---

## 8. FINAL LOCKS (V, 27 May 2026)

All 6 open questions resolved. Sprint 6 amended scope:

| Q | Lock | Impact |
|---|---|---|
| **Q1** Obscure URL | **DROPPED.** Internal demo, security not needed. | S6.1 removed entirely from sprint. |
| **Q2** Cancel cleanup | **Salvage everything; new `draft_partial` status + banner.** | Adds migration 0004 (enum extend) + new banner UI + Re-process/Use-as-is actions. |
| **Q3** Build order | **S6.3 first, then S6.2.** | Cancel ships user-visible value early; trace dashboard observability lands second. |
| **Q4** Live tail | **Polling, 10s, visibility-aware.** | Standard `setInterval` + `document.visibilitychange`. No SSE infra. |
| **Q5** Trace pages shell | **Full sidebar shell, only Dashboard+Traces active.** | Adds `<AdminShell>` extraction + refactor current `AdminDashboard` to use it. ~1.5h extra. |
| **Q6** Trace writers | **S6.2b — wire pipelines, ships with S6.2.** | Instrument /process, /transcribe/cleanup, /transcribe/whisper-chunk with openTrace/appendEvent/finishTrace. ~2-3h. |

### Amended Sprint 6 contents

| Sub | Title | Est | New since draft |
|---|---|---|---|
| ~~S6.1~~ | ~~Obscure-path middleware~~ | ~~2h~~ | **Removed (Q1)** |
| **S6.3** | Cancel button + `draft_partial` status + banner | 3-4h | +1h for enum migration + banner UI (Q2) |
| **S6.2** | Trace dashboard list + detail + sidebar shell + live tail polling | 6-8h | +1.5h sidebar (Q5), +0h live tail (Q4 baseline), +2-3h S6.2b writers (Q6) |

**Total:** ~9-12h focused (similar to original estimate; lost S6.1 hours absorbed by sidebar + writers).

### Build sequence

1. **S6.3** — cancel button
   1. Migration `0004_encounter_status_draft_partial.sql`: `ALTER TYPE encounter_status ADD VALUE 'draft_partial'`
   2. Update `db/schema.ts` enum
   3. Run migration on prod via `/api/run-migrations`
   4. Server: `/[slug]/api/encounters/[id]/process/route.ts` — on `AbortError`, set status to `draft_partial`, preserve `note_json` + `cdmss_json`, audit log
   5. Client: `EncounterDetailClient` — cancel button while streaming, confirm modal (PRD §8.1.6 copy), AbortController wiring
   6. Client: banner component for `draft_partial` status with "Re-process" / "Use as-is and send" actions
   7. Tag: `sprint-6-3-shipped`

2. **S6.2** — trace dashboard + sidebar + writers
   1. Extract `<AdminShell>` component (navy sidebar + content area, items: Dashboard/Doctors/Encounters/LLM traces/Sends/Settings — only Dashboard + LLM traces active, rest greyed "Coming soon")
   2. Refactor current `AdminDashboard` to render inside `<AdminShell>`
   3. New `app/admin/traces/page.tsx` (server) + `components/admin/TracesList.tsx` (client) — KPI cards, filter chips, table, pagination, LIVE TAIL polling toggle
   4. New `app/admin/traces/[id]/page.tsx` (server) + `components/admin/TraceDetail.tsx` (client) — KPI cards + per-stage prompt/response sections
   5. New `app/api/admin/traces/route.ts` — list + aggregates
   6. New `app/api/admin/traces/[id]/route.ts` — single trace
   7. **S6.2b writers** — instrument `/[slug]/api/encounters/[id]/process/route.ts` with surface=`note-pipeline` + `cdmss-analysis`; `/[slug]/api/transcribe/cleanup/route.ts` with surface=`cleanup-live`; `/[slug]/api/transcribe/whisper-chunk/route.ts` with surface=`cleanup-rolling`
   8. Tag: `sprint-6-2-shipped`

3. **Capstone**: `sprint-6-shipped` after both.

### Schema deltas

- **NEW migration 0004**: `encounter_status` enum gets `'draft_partial'` value.
- No other schema changes. `llm_traces` table already exists from migration 0002.

### Open questions remaining

One small UX copy lock before S6.3 banner ships:
- For the `draft_partial` banner — proposed copy: *"This note was not fully reviewed against your final transcript. You can re-process to generate a fresh note, or send as-is."* with `[Re-process]` `[Use as-is and send]` buttons. Worth a 30-second eyeball before merge.

---

**Status:** all locks in. Starting S6.3 next message.
