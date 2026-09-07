# ETA Install Build R1 — server routes, tables, and the Install and fleet card

**Kickoff for Claude Code. Paste this whole file.**

Working directory on the Mini: `~/dev/Even-Transcription-Assistant` (shared to V's MacBook as `/Volumes/MiniDev/Even-Transcription-Assistant`), branch `feat/room-recorder`, HEAD `d7df4b1`, clean.

Spec: `docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md`. Read PRD §1, §3, §4, §6 and §8 (Build R1) first. Five files were placed in `docs/handoff/` on 7 September and are untracked. Commit them as your first commit, unchanged, before any code:

- `ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` (the spec)
- `ETA-INSTALL-AND-FLEET-MOCKUP-7-SEP-2026.html` (the approved visual)
- `ETA-INSTALL-BUILD-R1-KICKOFF-7-SEP-2026.md` (this file)
- `ETA-INSTALL-MODULE-RULINGS-7-SEP-2026.md` (provenance)
- `ETA-INSTALL-MODULE-DECISION-BRIEF-7-SEP-2026.md` (provenance)

Run `git status` first and confirm exactly those five untracked files under `docs/handoff/` and nothing else. If anything else is untracked or modified, stop and report before committing.

Production is `d7df4b1`. Migrations run through `0074`. The next migration number is `0075`. Vercel production branch is `main`, so your push builds a preview and V promotes it.

All design decisions are settled: D1 to D13 plus A1, ratified by V on 7 September. Do not reopen any. If something is not covered, flag it in your report instead of deciding it silently. Security hardening beyond what §4 states is out of scope by V's instruction. Do not add it.

---

## 0. What kind of build this is

This build gives the admin app a way to install the native Room Recorder on a clinic Mac with one Terminal paste, and a card that shows which Mac runs which room. It ships nothing to a Mac. It has no prerequisite. Without a published release the card says "No release published yet" and every Copy install command button is disabled. Two rules govern everything here.

- **The page never asserts completion from its own actions.** The one exception is checklist step 1, labelled "Command copied". Every other step turns done only from a poll the app sent.
- **Labels derived, never typed.** `version`, `build_sha`, `sha256` and `size_bytes` come from the packaging manifest and from the server's own recomputation, never from a form field.

---

## 1. Read these first

| File | Why |
|---|---|
| `docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` | The spec. §4 is the contract. §4.4 is the script body, verbatim. |
| `docs/handoff/ETA-INSTALL-AND-FLEET-MOCKUP-7-SEP-2026.html` | The approved visual. States 1 to 5. Match it. |
| `app/api/bench/rooms/route.ts` and `lib/bench.ts` | The admin guard pattern and the rooms CRUD you extend. |
| `app/api/bench/commands/route.ts` and `lib/bench-commands.ts` | The poll you add seven optional fields to. |
| `lib/room-auth.ts` | `signRoomJwt`. Add a TTL parameter, default unchanged at 30 days. |
| `components/admin/BenchClient.tsx` and `components/admin/BenchRoomsLive.tsx` | The card and polling patterns to copy. |
| `db/migrations/0044_bench_command.sql`, `0066_mic_levels.sql`, `0068_rebind_cardiology_and_spare_device.sql` | The listener table history. |

---

## 2. What to build — five items

### 2.1 Migration `0075_room_install`

Tables `app_release`, `room_bootstrap_token`, `room_install` exactly as PRD §4.1, including the partial unique index. Additive, idempotent, self-recording. Do not touch `room` or `bench_listener`.

### 2.2 The eight Build R1 routes (PRD §4.2)

`POST /api/admin/releases`, `GET /api/admin/releases`, `POST /api/admin/releases/{id}/withdraw`, `POST /api/admin/rooms/{roomId}/bootstrap-token`, `GET /api/room-recorder/bootstrap/{token}`, `POST /api/room-recorder/enrol`, `GET /api/admin/bench/fleet`, `POST /api/admin/installs/{installId}/retire`.

Admin routes use `benchAdminGuard()` or the equivalent, and also accept `Bearer MIGRATION_SECRET`, the same as the stt admin routes, so V's operator flow can drive them without a browser.

`POST /api/admin/releases` streams the Blob object, checks `size_bytes`, recomputes `sha256`, and refuses with `SHA_MISMATCH` on any difference. Vercel Blob is already a dependency. Use the existing token.

`GET /api/room-recorder/bootstrap/{token}` returns the §4.4 script with `Content-Type: text/x-shellscript`, substitutions filled, `bootout` line included. It does not consume the token.

`POST /api/room-recorder/enrol` signs the room JWT with a 365-day TTL, marks the token used, sets `enrolled_at`, `session_expires_at`, and retires any other enrolled install for the room, in one transaction.

### 2.3 Poll additions (PRD §4.3)

Seven optional fields on `GET /api/bench/commands`. A poll with `install_id` writes `last_seen_at` and the six state columns. A poll without it behaves exactly as today. Prove the second half with the existing browser kiosk on Home Office.

### 2.4 Nightly cleanup

Delete unenrolled `room_install` rows whose token expired more than 24 hours ago. Attach to the existing nightly job in `vercel.json` rather than adding a cron entry, unless the existing job cannot host it. Say which in your report.

### 2.5 The Install and fleet card (PRD §6, mockup states 1 to 5)

A third card in `/admin/bench`. Rows per room from `GET /api/admin/bench/fleet`, polled every 20 s while the card is visible. The five-step checklist opens on Copy install command and polls every 3 s while open. Step words are `done`, `waiting`, `blocked`. Room words are `installed`, `not installed`, `needs re-enrol`, `update pending`. The command box shows the exact `command` string the mint route returned. Copy uses the clipboard API and falls back to a selectable field.

---

## 3. What not to do

- Do not build the app side, the packaging script, or the self-update. Those are Builds R2 and R3.
- Do not add a feature flag. The empty release table is the gate.
- Do not change the room PIN login or its 30-day TTL for humans.
- Do not add rate limiting beyond the two numbers in §4.2. Do not add anything from a security checklist.
- Do not run the migration. Report when it is ready. V runs it through this workflow.

---

## 4. Evidence to report

Report against PRD §8 Build R1 acceptance, items 1 to 7. For item 3, post a poll by curl with a fresh `install_id` from a minted token, `launched_by = launchd`, and show the open checklist turning step 2 done with the hostname you sent. For item 7, show the Home Office browser kiosk polling and recording unchanged after deploy. Include the preview deployment id, the commit sha, and the exact `curl` lines you used so V can repeat them. Add the changelog entry in the same commit.
