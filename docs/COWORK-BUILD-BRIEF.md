# Even Encounter Assistant (ETA) — Build Brief

**For:** Cowork (or any capable build agent)
**From:** Vinay Bhardwaj, GM at Even Hospital, Bengaluru
**Date:** 26 May 2026
**Status:** Spec complete · ready to build

---

## 0. Read this section first, then everything else

You are being handed a complete product spec and a complete visual design for a new internal tool called the **Even Encounter Assistant** (ETA). My job in this thread is to give you everything you need to build it without me re-explaining context. Your job is to read the spec, study the design, ask the few questions that genuinely need answering, then build it sprint by sprint.

**The two authoritative documents:**

1. **`EVEN-TRANSCRIPTION-ASSISTANT-V1-PRD.md`** — the 2,238-line PRD v1.0 FINAL. I am uploading this with this message. **Read it top to bottom before doing anything else.** Don't skim §4 (the 20 locked product decisions), §6 (data model — full Postgres schema), §7 (API surfaces — every endpoint), §9 (sprint plan with exit criteria), or §10 (success criteria).

2. **Figma file:** https://www.figma.com/design/1MwbnF1HubCOyTEIn7EM5U — Even Encounter Assistant — v1. Six pages: Cover, Design System, Mobile · Doctor app, Admin · Desktop, Email template, Flows. **Open it after the PRD and walk every page.**

The PRD and the Figma file are the contract. Where the PRD specifies behavior, follow it. Where the Figma file specifies visual treatment, follow it. Where they genuinely conflict, the PRD wins on behavior and Figma wins on look. Where the answer isn't in either, ask me directly.

---

## 1. What ETA is, in one paragraph

A mobile-first PWA for doctors at Even Hospital. The doctor opens a personal URL on their phone, enters a 4-digit PIN, taps Record, and speaks the encounter. Live dual-engine transcription (Deepgram streaming + Whisper polish) produces a transcript the doctor can edit anytime. On submit, a 7-stage LLM pipeline (clean → critique → revise + parallel CDMSS retrieval) produces a structured Medical Encounter Note plus a clinically-grounded analysis with citations from our existing 304K-chunk knowledge base. The note + analysis is emailed via Resend to the doctor, their default CCs, and global admin CCs. There is a desktop admin panel for me (and eventually one ops person) to onboard doctors, investigate failures, retry sends, and audit the LLM pipeline. v1 is single-hospital, no patient-facing surfaces, no formal compliance certification yet. The whole product is built around a 30-second recording loop.

---

## 2. Where we are, exactly

| Phase | Status |
|---|---|
| **Source catalog** (two predecessor repos audited, infrastructure mapped) | ✅ Done |
| **PRD v1.0 FINAL** (16 product decisions locked, schema specified, API specified, sprint plan defined, success criteria set) | ✅ Done — attached to this thread |
| **Figma v1** (Cover · Design System · 11 mobile screens × 5 variants · 9 admin desktop surfaces · email template · 5 user flows) | ✅ Done — linked above |
| **Sprint 0 (Setup)** | ⬜ This is your first job |
| **Sprints 1–5 (Build)** | ⬜ Following sprint 0 per PRD §9 |

There are no open product questions left for v1. Every "Q" in the PRD §4 list is **closed**. Don't relitigate decisions in §4 unless something you discover during the build genuinely breaks one of them — in which case raise it explicitly and we'll talk before changing course.

---

## 3. What you do first (orientation, day 1)

Before you write any code, in order:

### 3.1 Read the PRD top to bottom
All 2,238 lines. Pay particular attention to:
- **§3** — what's in scope vs out of scope for v1
- **§4** — the 20 locked decisions; these are the answers to questions you might otherwise think to ask
- **§4.10** — Medical Encounter Note schema (the structured + prose mix that LLM-generated notes must conform to)
- **§4.11** — CDMSS analysis pipeline (parallel retrieval + grounded analysis, the violet AI block)
- **§4.15** — PIN security model (bcrypt + JWT + lockout escalation with specific thresholds)
- **§6** — every table, every column, every index — this is the schema you implement in migration 0001
- **§7** — every endpoint, request/response shape, error envelope
- **§9** — the sprint plan with explicit exit criteria per sprint
- **§10** — success criteria; these are how we'll know we're done

### 3.2 Walk the Figma file
All six pages. Pay attention to:
- **Design System** page — locked tokens (even.blue scale 50–950 with brand 600 `#0055FF`; even.navy 50–950 with brand 800 `#002054`; even.pink 50–900 with brand 500 `#F96EB1`; even.ink 50–800 grayscale; Tailwind violet 50–700 for AI surfaces; emerald/amber/red for semantic). Inter for UI, Roboto Mono for medical values and IDs. Radii: sm 2 / md 6 (inputs) / lg 8 (cards) / xl 12 (modals + mobile buttons) / full (chips).
- **Mobile · Doctor app** page — every screen has 5 variants showing real states. Don't invent states the design didn't cover; if you find one missing, ask.
- **Admin · Desktop** page — 9 surfaces. The encounter detail surface (Surface 5) is the operational heart of the admin: the 7-stage pipeline trace at the top is **the** investigation tool. Match its visual treatment carefully.
- **Email template** page — the violet AI block has a precise treatment (violet 50 background, violet 300 border, violet 100 pill with violet 700 "AI-GENERATED · FOR YOUR CONSIDERATION" text). This treatment is also used in mobile library detail and in encounter detail. Build it once as a component, reuse everywhere.
- **Flows** page — five user journeys end-to-end. These show how surfaces compose into real tasks.

### 3.3 Clone the two predecessor repos and study them
These are NOT what we're shipping. They're references with patterns we keep and patterns we don't.

- **`github.com/vinaybhardwaj-commits/OPD-Encounter-App`** — Next.js 15.5.18, React 19. This was the prior experiment that taught me what worked. Patterns to **carry forward**: the Ollama call wrapper with full prompt/response logging; the `/llm/dashboard` and `/llm/trace/[id]` admin pages (these directly inspired ETA admin Surfaces 6 and 7); the streaming response handling. Patterns to **abandon**: the auth flow (we're doing slug + token + PIN now); any client-side state libraries it uses (we're going hooks-only).

- **`github.com/vinaybhardwaj-commits/Even-CDMSS`** — the existing knowledge base + retrieval service. We integrate with this; we don't rebuild it. The Neon `KB_DATABASE` has 304,399 chunks and ETA reads from it via the existing retrieval endpoints. Treat CDMSS as an upstream service.

### 3.4 Verify infrastructure
See §4 below. If anything in §4 isn't actually reachable from your environment, raise it before Sprint 0 day 2.

### 3.5 Post back a Sprint 0 plan
Once you've done 3.1–3.4, post back to me a Sprint 0 plan as a numbered checklist — what you intend to do, in what order, with rough hours. Wait for my approval before writing code. **This is the only place I want you to pause before producing work. After Sprint 0 is approved, run.**

---

## 4. Infrastructure on hand (DO NOT recreate)

| Service | Location | Notes |
|---|---|---|
| **Ollama tunnel** | `llm.llmvinayminihome.uk/v1` (Cloudflare tunnel to my Mac Mini) | Models loaded: `qwen2.5:14b`, `llama3.1:8b`, `nomic-embed-text`, `mxbai-embed`. p50 latencies in PRD dashboard mock. |
| **Whisper tunnel** | `whisper.llmvinayminihome.uk` | Self-hosted Whisper-large-v3 for the polish stage of the hybrid transcription. |
| **Deepgram** | API direct | API key in env. Used for streaming interim transcripts (primary path). |
| **Neon Postgres `KB_DATABASE`** | bom1 / Mumbai | 304,399 chunks. **Read-only from ETA.** Owned by Even-CDMSS service. |
| **Neon Postgres `APP_DATABASE`** | bom1 / Mumbai | **NEW. You provision this** in Sprint 0 with §6 schema. |
| **Vercel team** | `team_yu1wWpsKdjsf90haai1ETJDG`, deploy region `bom1` | Same team that hosts OPD-Encounter-App. |
| **Resend** | API | Domain `even.in` is already verified. Webhook URL to be configured at `https://eta.even.in/api/webhooks/resend`. |
| **Domain** | `eta.even.in` | DNS needs to point to Vercel in Sprint 0. |
| **Cloudflare R2** | needs provisioning | Audio blob storage. Key pattern: `audio/{yyyy}/{mm}/{dd}/{encounter_id}.opus`. Signed URLs only; never public. |

Environment variables you will need (assume they're in Vercel env unless I say otherwise):
- `OLLAMA_BASE_URL`, `WHISPER_BASE_URL`, `DEEPGRAM_API_KEY`
- `APP_DATABASE_URL`, `KB_DATABASE_URL`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `JWT_SECRET_DOCTOR`, `JWT_SECRET_ADMIN` (separate audiences per §7.1)
- `ADMIN_BASE_PATH` (per §4.16 — the obscured admin URL prefix)

If any of these aren't set, ask before guessing.

---

## 5. Tech stack (locked)

These choices are not up for renegotiation. Don't propose alternatives unless one breaks during the build.

- **Frontend:** Next.js 15.x (App Router), React 19, TypeScript with `strict: true`, Tailwind CSS, shadcn/ui where it actually saves time (don't reach for it for everything)
- **Backend:** Next.js API routes + server actions where idiomatic. No separate backend service.
- **DB:** Neon Postgres via Drizzle ORM. Migrations in `db/migrations/`, numbered. Seed scripts in `db/seed/`.
- **Auth:** bcrypt (cost 12) for password/PIN hashing, JWT for sessions, **two separate token classes** (doctor JWT audience = `doctor`, admin JWT audience = `admin`; cross-class tokens are rejected). Per §4.15.
- **Audio storage:** Cloudflare R2 (S3-compatible) via signed upload/download URLs from the server. Never serve audio publicly.
- **Email:** Resend, with the webhook receiver verifying signatures. See §7.3.
- **LLMs (all via the Ollama tunnel):**
  - `llama3.1:8b` for the cleanup stage
  - `qwen2.5:14b` for critique, revise, and CDMSS grounded analysis
  - `nomic-embed-text` or `mxbai-embed` for KB retrieval embeddings (the existing CDMSS service handles this)
- **Transcription:** Deepgram streaming WebSocket (primary) + Whisper polish endpoint (secondary). Hybrid per §4.2.
- **Hosting:** Vercel only. Mumbai region. No edge functions — full Node runtime for everything.
- **Observability:** Every LLM call writes a `trace` row to `APP_DATABASE.trace` (see §6 schema). Every admin action writes an `audit_log` row. Both tables are append-only and queryable from the admin surfaces.

### What NOT to add
- No external state library (no zustand, redux, jotai). React 19 hooks + URL state suffice.
- No CSS-in-JS (no styled-components, emotion). Tailwind only.
- No Clerk, Auth0, Supabase auth, NextAuth, etc. We're using our own bcrypt + JWT setup per §4.15.
- No alternative LLM providers (no OpenAI, Anthropic, Google APIs). Everything goes through our Ollama tunnel.
- No alternative transcription. Deepgram + Whisper, as specified.
- No analytics SDK. The `audit_log` and `trace` tables ARE our analytics.

---

## 6. The build, sprint by sprint

PRD §9 has the canonical sprint plan with exit criteria. Summarized here so you have it inline:

### Sprint 0 — Setup (~2 days)
Project scaffolding, Vercel deploy, DNS, Neon `APP_DATABASE` provisioned with §6 migrations, R2 bucket created, Resend webhook configured, Cloudflare tunnels verified reachable, `/api/health` returns service status. Skeleton routes exist for PIN entry and admin login. CI green. **Exit:** one deploy lives at `eta.even.in` with health endpoint returning all-green.

### Sprint 1 — Doctor recording loop (~5 days)
The mobile PWA shell, PIN entry with lockout escalation, Home/Record start with pre-flight checks, Recording active with live transcript (Deepgram primary + Whisper polish), Recording paused with edit-anytime transcript, Finalize/Review with CC picker, offline modal + dropout tolerance, modals & toasts. **Exit:** I record a complete encounter end-to-end on my phone with live transcript visible.

### Sprint 2 — Pipeline + library (~5 days)
Submit processing screen with live pipeline UI, the 4-stage server pipeline (clean → critique → revise → cdmss), enforced JSON schemas for note and CDMSS, library list with date grouping, library detail with citation chips, doctor settings (change PIN, see recipients). **Exit:** I record 5 encounters, each produces a structured note + grounded CDMSS analysis with ≥1 citation. p50 pipeline latency < 60s.

### Sprint 3 — Email + admin foundation (~4 days)
Email template renderer (HTML + plaintext), Resend integration with webhook signature verification, retry policy (3 retries exponential), admin auth (separate from doctor), admin sidebar shell + topbar, admin Surface 1 Dashboard, Surface 2 Doctors list, Surface 3 Doctor detail + onboard flow (create doctor → generate URL → email URL). **Exit:** I onboard a second doctor end-to-end. They record an encounter. Email arrives with the violet AI block rendered correctly. Open events show up in admin.

### Sprint 4 — Admin observability + remaining surfaces (~4 days)
Surface 4 Encounters list, Surface 5 Encounter detail with the 7-stage pipeline trace, Surfaces 6+7 LLM Traces list + detail with full prompt/response display, Surface 8 Sends with delivery funnel, Surface 9 Settings with vertical sub-nav. **Exit:** I can investigate any encounter from any angle and retry/delete from the UI. The system explains itself.

### Sprint 5 — Hardening + launch (~3 days)
Performance pass, PIN lockout production-hardened, R2 deletion job, `pin_attempt` 90-day TTL cron, documentation (README + ops runbook + doctor onboarding script for me), soft launch to my hospital with 3–5 doctors. **Exit:** §10 launch metrics tracked. I sign off for broader rollout.

**Total: ~25 working days / ~5 weeks for one capable engineer with V as PM.**

Don't start Sprint N+1 until Sprint N exit criteria are met and demonstrated to me.

---

## 7. Conventions

### 7.1 Repo + project structure
- Single Next.js monorepo (no microservices)
- `app/` for routes (doctor at root, admin at `/${ADMIN_BASE_PATH}/`)
- `lib/` for shared logic (auth, llm, email, db, schemas)
- `db/migrations/` numbered drizzle migrations
- `db/schema.ts` drizzle schema file matching §6 exactly
- `components/` for UI; one file per component; co-locate sub-components if not reused
- Server actions in `actions/` namespaced by feature

### 7.2 Code style
- TypeScript `strict: true`, no `any`, no `as` casts unless necessary and commented
- Server boundaries: all API responses go through a `respond()` helper that enforces the §7.5 error envelope
- All LLM calls go through a single `callOllama()` wrapper that writes a `trace` row before returning
- All admin mutations go through a `withAudit(action, target, fn)` wrapper that writes the `audit_log` row

### 7.3 Identifier conventions (per §6.3)
- Postgres uuid v4 for `admin_user`, `audit_log`, `recipient_*`
- nanoid with prefix for surfaces shown in UI:
  - `doc_` (8 chars) for doctors
  - `enc_` (10 chars) for encounters
  - `trace_` (6 chars) for trace rows
  - `em_` (9 chars) for send_event
- All UI displays of IDs use Roboto Mono per the design system

### 7.4 Git
- One branch per sprint, merged to main on sprint exit
- Conventional commits
- PR descriptions reference the PRD section being implemented (e.g. `feat(auth): PIN lockout escalation per §4.15`)
- I review every PR. No self-merging.

---

## 8. How to engage with me

### 8.1 When to ask vs when to proceed
**Proceed without asking** when:
- The answer is in the PRD or visible in the Figma file
- It's an internal implementation choice (library version, file structure, naming inside a file)
- It's a small bug fix or refactor inside your own code

**Ask first** when:
- A product question genuinely isn't answered by the PRD §4 locked decisions
- The Figma design has a gap and you'd need to invent a state
- You think a §4 locked decision is wrong and should be reversed
- You're about to spend more than 4 hours on a single problem and the path isn't obvious
- You hit infrastructure I claimed exists but doesn't

### 8.2 Message style I prefer
- Lead with the answer or the question; context after
- Short paragraphs, not walls of text
- Code blocks for code, mono for IDs and commands
- No emojis. No "great question". No filler.
- If you're uncertain, say so plainly: "I'm not sure whether X or Y; I'll go with X unless you stop me."

### 8.3 Cadence
- Daily standup style update at end of your working session: what you did, what's next, what's blocked
- At sprint exit: demo, then we decide together if exit criteria are met
- Anything blocking, ping me immediately — don't sit on it

### 8.4 What I am NOT looking for
- Re-litigation of any §4 locked decision unless you've discovered something genuinely broken
- "Should we also build…" expansion of scope. v1 is v1. v2 items are explicitly parked.
- Architecture diagrams. The PRD + Figma are the architecture. If you need to think out loud, write a short rationale paragraph in the PR description.
- TODOs in code without an associated issue or PRD section reference

---

## 9. Anti-patterns to refuse

If you find yourself about to do any of these, stop and tell me instead:

1. **Adding a hosted auth provider** — we are not using Clerk/Auth0/Supabase auth. The PIN + JWT + lockout flow is the auth. Per §4.15.
2. **Using a paid LLM API** — everything runs through our Ollama tunnel. If the tunnel is down, that's an infra problem to fix, not a reason to switch to a vendor.
3. **Storing audio in the database** — audio goes to R2. The DB stores the R2 object key only.
4. **Skipping the trace write on an LLM call** — every LLM call writes a trace row. This is non-negotiable per §4.16 and is what makes the admin observability work.
5. **Skipping the audit log on an admin action** — every admin mutation writes an audit row. Non-negotiable.
6. **Hard-deleting any record without `?hard=true` and explicit re-confirm** — soft delete is the default per §6 + Figma's "Delete (permanent)" danger zone treatment.
7. **Sending emails for encounters with `status='failed'`** — the `block_on_critique_fail` setting in `settings` table defaults to true. Honor it.
8. **Cross-doctor data leakage** — every doctor-scoped endpoint must filter by `doctor_id` from the JWT, not from a query param. A doctor should never be able to see another doctor's library by guessing.
9. **Loading the entire transcript or note into a client component eagerly** — the mobile bundle stays small. Stream content where it makes sense.
10. **Custom UI components when the design system has the answer** — the Figma file specifies tokens for spacing, radii, type, colors. Use them as Tailwind config values. Don't invent.

---

## 10. Hard rules from the PRD that are easy to miss

- **PIN lockout escalation** — not just N failed → lock. The thresholds are graded (see §4.15): 5 failed → 5-min cooldown, 10 → 15-min, 20 → admin-only unlock. Implement the full curve.
- **Slug + token URLs** — the doctor's personal URL is `/dr/{slug}?t={token}`. Both pieces are required. The token is rotatable by admin; rotation invalidates the URL immediately. Per §4.14.
- **The note schema is mixed prose + structured** — per §4.4 + §4.10, the note has both prose sections (HPI, PE, Assessment, Plan as paragraphs) and structured fields (vitals as key/value, Rx as line items, referrals as line items). The LLM must produce both. Schema enforcement at the API boundary is required.
- **CDMSS is parallel-eligible** — after the `clean` stage, `critique` + `revise` run sequentially but `cdmss` can run in parallel. The processing screen shows them as twin tracks. Don't sequentialize the pipeline more than needed.
- **Pipeline state ≠ send state** — these are two independent state machines and the UI is built to show them separately (see Surface 5 of the admin). A successful pipeline can have a failed send. A pipeline can be still running when the user is already viewing the encounter. Build both as first-class.
- **Pre-flight before recording** — before allowing record, check mic permission, network, Whisper reachable, Deepgram reachable. Show the result in §8.1.2 pre-flight card. If any fail, surface clearly. Per §4.2.
- **Edit-anytime transcript** — per §4.3 Q3, the doctor can edit the transcript at any point (during recording, paused, after finalize, even after send). Edits after send do NOT auto-resend; only an explicit admin "Resend" triggers re-delivery with the updated note. The audit log captures these edits.
- **Empty CC picker is valid** — if the doctor unchecks all CCs, the send goes only to global admin CCs. The minimum recipient list is the global CCs.
- **Subject line uses tokens** — `[Even] {patient_name}, {patient_demo} · {chief_complaint} · {date}` is the default template. Tokens are rendered server-side at send time, not client-side at finalize. This means subject can reflect note edits made after finalize.

---

## 11. Definition of "shipped" for v1

From PRD §10. Quoting the launch-day correctness criteria you should be tracking from Sprint 1 onward:

| Criterion | Target |
|---|---|
| Pipeline end-to-end completes | ≥99% of encounters |
| Email send success (incl. retries) | ≥98% |
| Pipeline p50 latency | <60s end-to-end |
| Pipeline p95 latency | <90s |
| Audio data loss in tested offline scenarios | 0 |
| PIN auth median latency | <1s |
| Admin actions audit-logged | 100% |
| Cost per encounter | <$0.20 |

And the 30-day adoption targets (we measure these post-launch):
- 5+ doctors onboarded · 50+ encounters · 3+ active doctors (≥3 enc/wk)
- Median manual transcript edits per encounter ≤1
- ≥70% of encounters where the doctor reports "didn't need to redo the note"
- ≥50% email open rate
- <30s from dashboard to root cause on any failure I investigate

---

## 12. Your first message back to me

After you've done §3.1 through §3.4, post a message that contains, in order:

1. **A 5-sentence summary of ETA in your own words** — so I know you've actually read the PRD
2. **One paragraph on what struck you as the most interesting or hardest part** — gives me signal on what you're paying attention to
3. **Your Sprint 0 plan** — numbered checklist, each item with rough hours
4. **A list of any infrastructure I claimed in §4 of this brief that you couldn't actually verify** — so we resolve those before you start
5. **The 3 questions, max, that you genuinely need answered before starting** — if you have more than 3, you haven't read carefully enough

That message is the trigger for me to give Sprint 0 the go-ahead.

---

## 13. One last thing

This product matters to me. It's not a side project. It's the system my doctors will use every day to do the most important work they do. The design and the PRD reflect real attention to what makes a tool feel right in a clinician's hand — the latency budgets, the offline tolerance, the violet AI treatment that signals "consider this, don't trust it blindly", the separate pipeline-vs-send states because a doctor needs to know what failed and why.

Build it the way the spec says. Where the spec gives you room, use judgment. Where you don't know, ask. Don't ship anything you wouldn't be proud to demo to a doctor.

Let's go.

— Vinay
