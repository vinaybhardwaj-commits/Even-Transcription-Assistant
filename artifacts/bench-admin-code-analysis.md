# Admin Bench dashboard — code analysis

**Target:** `/admin/bench` on evenscribe.app  
**Scope:** read-only investigation. No product-code changes.  
**Date of this note:** 22 Sep 2026  
**Hypothesis:** Bench admin is a **room-day / session supervisory board**. **Confirmed.**

The page is not a generic clinic dashboard. It is an operator walk-around monitor for **room tape today** (kiosk presence, start/pause/stop, STT/visits processing) plus a **selected-room session history** (chunks, gaps, consult marks). It does not manage clinicians, encounters, or native-recorder fleet hardware.

---

## 1. Routes

Next.js App Router. There is **no** `app/admin/layout.tsx`; each admin page wraps itself in `AdminShell`. Both bench pages are `dynamic = "force-dynamic"` and gate on an **admin JWT cookie** (`readAdminCookie` + `verifyAdminJwt`); missing/invalid cookie redirects to `/admin` (the login/dashboard entry).

| URL | File | Role |
|-----|------|------|
| `/admin/bench` | `app/admin/bench/page.tsx` | Live monitor + session list + room CRUD |
| `/admin/bench/[id]` | `app/admin/bench/[id]/page.tsx` | One `bench_session` (id prefix `bs_`) |

**Nested routes:** only `[id]`. No `admin/bench/rooms`, no layout segments, no parallel routes.

**Nav:** `components/admin/AdminShell.tsx` — Observe section, href `/admin/bench`, key `"bench"`.

**Related room kiosk (not admin):** `/room/[slug]` — the listening page that polls the command bus. Admin copy tells operators to open that URL on the clinic Mac.

---

## 2. Component tree

```
AdminBenchPage                         app/admin/bench/page.tsx  (RSC)
└── AdminShell                         components/admin/AdminShell.tsx  (client)
    ├── headerRight: WakeLockBadge     components/admin/WakeLockBadge.tsx
    ├── BenchRoomsLive                 components/admin/BenchRoomsLive.tsx  (~1589 lines)
    │     module store: selectedRoom / useSelectedRoom
    └── BenchClient                    components/admin/BenchClient.tsx  (~604 lines)
          uses useSelectedRoom()

AdminBenchSessionPage                  app/admin/bench/[id]/page.tsx  (RSC)
└── AdminShell
    ├── BenchSessionDetailClient       components/admin/BenchSessionDetailClient.tsx  (client)
    └── BenchConsultMarks              components/admin/BenchConsultMarks.tsx  (RSC, SQL at render)
```

### Stores / hooks

**No Redux, Zustand, or React Context.** The only shared client store is a **module-level singleton** in `BenchRoomsLive.tsx`:

- `selectedRoom.get / subscribe / choose / suggest / reset`
- `useSelectedRoom()` via `useSyncExternalStore`
- `source: "user" | "default"` — a person click never loses to a poll-derived default
- Defaults: recording room (from live rollup) outranks most-recent session (from `BenchClient`)

There is no global “fleet” store. Each poll result lives in local `useState`.

`WakeLockBadge` is display-only (`navigator.wakeLock`). It does not affect data or controls.

### Decision modules (shared by UI + MCP)

These are the real “brain” of the screen; the UI mostly renders their outputs.

| Module | Lines | What it owns |
|--------|------:|--------------|
| `lib/bench-bus-constants.ts` | 355 | Command-bus timings; `roomState()` seven-state chain; `ended_disagrees` copy |
| `lib/room-facts.ts` | 360 | Mic/doctor-clock thresholds; tape/transcript/visits lanes; stranded-audio reasons |
| `lib/admin/rooms-live.ts` | 766 | Server aggregation for the 20 s poll (two DB handles: app + brain) |
| `lib/admin/room-reads.ts` | — | Shared SQL reads (chunks after end, mic sizes, switches, transcript/stranded) |
| `lib/bench-reaper-core.ts` | — | Stall badge (10 min) vs reap (30 min); IST day-rollover |
| `lib/bench-commands.ts` | — | Bus SQL; `COMMAND_KINDS`; `decideStart`; listener freshness |
| `lib/bench-orphan.ts` | — | `close_orphan` repair (not a kiosk command) |
| `lib/mic-health.ts` | — | Size vital; `DEVICE_GONE_REASONS`; `proven_dead_by_size` |
| `lib/bench.ts` | — | `benchAdminGuard`; session/chunk/mark list helpers |

Browser-safe split is load-bearing: `rooms-live.ts` imports Postgres. The client imports `roomState` from `bench-bus-constants` and lane copy from `room-facts`, **not** from `rooms-live`.

---

## 3. APIs the pages call

**No WebSocket, SSE, or EventSource on this surface.** Refresh is HTTP polling + a 1 s local tick that recomputes ages from stored instants.

### 3.1 Polled from `/admin/bench`

| Interval | Method | Path | Who | Skip when hidden |
|---------:|--------|------|-----|------------------|
| 3 s | GET | `/api/admin/bench/listeners` | `BenchRoomsLive` | yes |
| 20 s | GET | `/api/admin/bench/rooms-live` | `BenchRoomsLive` | yes |
| 1 s | — | (no fetch; `setTick`) | `BenchRoomsLive` | no (cheap re-render) |
| 60 s | GET | `/api/bench/sessions` + `/api/bench/rooms` | `BenchClient` | yes |

### 3.2 Writes from `/admin/bench`

| Method | Path | UI gesture |
|--------|------|------------|
| POST | `/api/admin/bench/command` | start / pause / resume / stop (`start_day`…`end_day`); `close_orphan` |
| PATCH | `/api/admin/bench/processing` | per-room Transcript / Visits switches |
| POST | `/api/admin/bench/processing` `{ action: "stop_all" }` | Stop all processing |
| POST | `/api/admin/bench/run-waiting` `{ room_id, limit: 4 }` | Run this room’s waiting audio |
| POST | `/api/bench/rooms` | Create room |
| PATCH | `/api/bench/rooms` | rename / reset_pin / enable / disable |

### 3.3 Session detail `/admin/bench/[id]`

| Interval | Method | Path |
|---------:|--------|------|
| 60 s | GET | `/api/bench/sessions/:id` |
| on click | GET | `/api/bench/sessions/:id/manifest` (presigned chunk URLs) |
| links | GET | `…/timeline`, `…/download` (zip) |

Consult marks: **no API**. `BenchConsultMarks` calls `listBenchConsultMarks` in the RSC. Snapshot at navigation; **does not poll**.

### 3.4 Admin bench routes **not** called by the UI

| Path | Purpose |
|------|---------|
| GET/POST `/api/admin/bench/drain` | Inspect/run STT drain for a session/window. Manual, paid. |
| GET/POST `/api/admin/bench/windows` | Inspect/re-evaluate `bench_window` rows for a historical session |

These exist for operators/MCP/scripts. The monitor never fetches them; waiting audio uses `run-waiting` instead (vocabulary: “pieces of audio”, not “drain”).

### 3.5 Kiosk bus (not admin, but the write path’s other end)

| Path | Auth | Role |
|------|------|------|
| GET `/api/bench/commands` | **room cookie** | Kiosk poll: upsert `bench_listener`, return pending commands |
| POST `/api/bench/commands/[id]/ack` | room cookie | Ack/fail a command |

Kiosk cadence (`lib/bench-bus-constants.ts`): visible 1.5 s, hidden 5 s, **idle (page open, not recording) 3 s** so Stop from admin does not make the room indistinguishable from a dead tab.

### 3.6 Auth on admin APIs

- `/api/admin/bench/*` and GET `/api/bench/sessions` / rooms: `benchAdminGuard` or equivalent admin JWT.
- POST `/api/bench/sessions` (create tape): **room cookie**, used by the kiosk, not the admin page.
- Processing and run-waiting use cookie verify directly (same gate, slightly different error shape than `benchAdminGuard`).
- **No role split** (any signed-in admin can start/stop/close-orphan/stop-all-processing).

MCP is a separate door: `Authorization: Bearer` / path key at `/api/mcp` (`lib/mcp/handler.ts`). JSON-RPC over HTTP, **no SSE**.

---

## 4. Data model — how the UI gets each noun

### Persistence (migrations)

| Table | Migration | Admin meaning |
|-------|-----------|---------------|
| `room` | `0041_room_bench.sql` | Physical OPD room: slug, PIN, `disabled_at`. Later: `transcript_enabled`, `visits_enabled` |
| `bench_session` | 0041 | One recording day (`bs_…`). `status`: `recording` \| `paused` \| `ended` |
| `bench_chunk` | 0041 | ~5 min WebM “pieces”. `source` primary/backup. `upload_state`: pending / verified / gap |
| `bench_event` | `0043_bench_event.sql` | Consult marks, mic lost/restored, remounts; `brain_status` sent/failed |
| `bench_command` | `0044_bench_command.sql` | Bus queue: start_day / pause_day / resume_day / end_day |
| `bench_listener` | 0044 | One row per room: last kiosk poll, paused, claimed session, RMS levels |
| `bench_window` | `0057_bench_window.sql` | 15-min STT slots over the tape |
| Brain `cue` / `room_day` / `visit` | brain pool | Marks, warehouse clock, visits — **not** in the app `room` table |

Scratch rooms (`room_scratch_…`) are filtered from the admin list and from MCP all-room sweeps.

### Noun → fetch path

| Noun | Live monitor | Session table / detail |
|------|----------------|------------------------|
| **Rooms** | `readRoomsLive` (enabled rooms, today’s aggregates) | GET `/api/bench/rooms` (all non-scratch, last session) |
| **Sessions** | Today’s sessions rolled into per-room `recording` / `paused_session` / stall | GET `/api/bench/sessions` last **200** globally, then filtered client-side by selected room slug. **Not IST-day scoped.** |
| **Pieces / chunks** | Newest primary/backup `created_at` (upload clock); counts; size health | Detail: full chunk list + timeline; list: counts/gaps/bytes |
| **Listeners** | Fast poll `bench_listener` | Not shown below the fold |
| **Flags** | Derived in `readRoomsLive` + client `attentionItems` / `roomState` | List: live &lt;7 min vs stalled 10 min vs `status` string |
| **Commands** | Fire-and-forget POST; UI shows “queued for the kiosk”. **No command list.** | — |
| **Windows / jobs** | Transcript lane counts + stranded minutes | Drain/windows APIs unused by UI |
| **Consult marks** | Today’s cue count + `marks_not_sent` from events | RSC SQL on session page |

Two clocks, two databases: `lib/admin/rooms-live.ts` reads `bench_*` / `room` via `lib/db` and `cue` / `room_day` via `lib/brain/db`.

---

## 5. Write actions and gating

### 5.1 Command bus (tape)

`POST /api/admin/bench/command` is documented as the monitor’s **only tape write**. It does not talk to the kiosk; it inserts `bench_command` (`source: "admin"`) or runs orphan close server-side.

| Button | Kind | Client gate | Server gate |
|--------|------|-------------|-------------|
| **start** | `start_day` | `roomState().start_available` (ready, or finished **and** listening) | `decideStart`: must be listening (`LISTENER_FRESH_MS` = 10 s); reject `kiosk_not_listening` / `room_paused`; idempotent `already_recording` |
| **pause** | `pause_day` | `r.recording` | **No pre-check.** Queue even if kiosk is dark (expires 15 s) |
| **resume** | `resume_day` | `st.state === "paused"` | No pre-check |
| **stop** | `end_day` | recording or paused; **two taps**; confirm expires in **10 s** | No pre-check |
| **Close abandoned session** | `close_orphan` | Open session and kiosk does **not** claim it (fresh poll + matching `recording_session_id`) | `closeOrphanedSession`: refuse `kiosk_attached` / `no_open_session`; never touches chunks |

**UI never sends `override_pause: true`.** `send()` supports it but every button passes `false`. Consent-paused rooms cannot be started from the card (correct); MCP can with `override_pause`.

**Ack wait:** MCP `scribe_start_recording` (etc.) wait up to **8 s** for kiosk ack. Admin command route returns `{ queued: true }` immediately. Operator sees “queued”, not delivered.

Audited: `audit_log` action `bench.command`.

### 5.2 Processing (not tape)

| Control | Gate | Effect |
|---------|------|--------|
| Transcript switch | any admin | `room.transcript_enabled`; optimistic UI, corrected from RETURNING |
| Visits switch | **ON** is a modal confirm (permanent visit record); OFF is one tap | `room.visits_enabled` |
| Stop all processing | two-step confirm | Both lanes off **every** room; **recording untouched** |
| Run waiting audio | Transcript on + stranded waiting &gt; 0; two taps; batch of 4 paid calls | `drainRoomWaitingWindows`; switch still enforced inside drain |

Cache: `ROOM_SWITCH_CACHE_MS` — other processes may lag; the tapping process invalidates immediately.

### 5.3 Room CRUD (`BenchClient`)

Create (PIN shown once), rename (name only; slug/PIN unchanged), reset PIN, disable/enable. Not on the Clinicians page (D5).

### 5.4 Not on the UI

- Mark consult (kiosk or `scribe_mark_consult`)
- Extract/transcribe range
- Replay / replay-write
- Native recorder: `set_audio_input`, `check_update_now`, `report_diag`, `restart_engine` (MCP `scribe_room_command` grouping; **not** in `COMMAND_KINDS` in this repo)
- Session reaper (hourly via `/api/admin/reap-stuck`, not a button)

---

## 6. Status / flag dictionary

### 6.1 Room operator states — `roomState()` (`lib/bench-bus-constants.ts`)

Precedence, first match wins. Shared with MCP `scribe_diff_room`.

| `state` | Level | Meaning | `start_available` |
|---------|-------|---------|-------------------|
| `cant_tell` | unknown | Listener **read failed**. Not offline. | false |
| `paused` | amber | Consent pause (listener **or** session). **Outranks recording.** | false |
| `recording` | ok | Live tape | false |
| `finished` | ok (pill is **grey**, not green) | Most recent session today is `ended`; nothing recording (D30) | true **iff** kiosk still listening |
| `ready` | ok | Listening, not recording, not paused. **Claims nothing about mics.** | true |
| `dropped` | amber | Last poll age &lt; 10 min (`LISTENER_OFFLINE_MS`) | false |
| `offline` | red | Gone ≥ 10 min, or never opened | false |

### 6.2 Listener states — `listenerState()`

| Value | Meaning |
|-------|---------|
| `never` | No `bench_listener` row |
| `stale` | Row older than 10 s |
| `listening` | `last_poll_at` within 10 s |
| `unknown` | **Read failed** — must not be shown as “never” |

Live API also sends boolean `listening` + `age_ms`. Degraded listener poll → empty list + `degraded[]`; client treats that as unknown for **every** room.

### 6.3 Session / tape flags

| Flag | Rule | UI |
|------|------|-----|
| **live** (list only) | `status === "recording"` and **primary** `last_chunk_at` &lt; **7 min** | Pink “recording” pill |
| **stalled** | `status === "recording"` and newest chunk **either mic** (else `started_at`) &gt; **10 min** (`STALLED_BADGE_MINUTES`) | Red attention: “no audio arriving — audio is being lost”; tape lane red |
| **reap stall** | Same clock, **30 min** (`STALL_MINUTES`) | Hourly reaper ends session; not a chip |
| **ended** | Stored status | Green “ended” on list |
| **orphaned / stuck** | Open recording/paused session, listeners known, kiosk does not claim this session | Repair card + `close_orphan` |
| **ended_disagrees** | Session `ended`, but a chunk’s **capture** `started_at` is after `ended_at` + 60 s skew | Red attention + card banner. Audio is safe. Orthogonal to `roomState`. |
| **ended_at_lies** | Stored `ended_at` later than last piece by **more than stall window** | Amber. Mirror image of ended_disagrees. |
| **paused_disagrees** | Listener paused XOR session paused | MCP `scribe_diff_room` only; **not rendered** on the card |

### 6.4 Mic / device

| Flag | Rule | UI |
|------|------|-----|
| `mic_level` ok/amber/red/unknown | Age of newest piece on **either** mic, **upload** clock: amber 7 min, red 10 min (`MIC_*_MS`) | Pill; attention “audio slowing down” / “no audio uploading” |
| Piece size `newest` ok/tiny/unknown | vs room’s own baseline (`lib/mic-health.ts`, 1/10, 12-piece window) | Tiny → amber; unknown renders **nothing** |
| `proven_dead_by_size` | Two consecutive **full-length** tiny pieces **while meter heard sound** (D36/D37) | Red attention: “pieces that are not audio” |
| `DEVICE_MISSING` / `silence_device_missing` / `device_missing` / `track_ended` | `DEVICE_GONE_REASONS` in `lib/mic-health.ts`; kiosk watchdog + remount (`lib/bench-resume-core.ts` payload `device_missing_on_resume`) | **Not a Bench-admin badge.** Used for source selection / remount, not `attentionItems`. |
| Spare lane | `spare_device === true` (explicit second device) **or** backup chunks exist (`spare_exists`) | Most rooms: **no spare UI** (D32) |
| List `mic_status` (`on_backup` / `lost_no_backup` / …) | Still on `/api/bench/sessions` wire | **Intentionally not rendered** (false “on backup” badge) |

### 6.5 Processing / brain

| Flag | Rule | UI |
|------|------|-----|
| Transcript / Visits lanes | `transcriptLane` / `visitsLane`: green = working; on+idle = **grey** “On, nothing to do” | Switches + LED |
| `no_day` | Closed windows with no `room_day`; alarm only if `has_room_day_today === false` | Amber + “Press Mark consult once…” |
| Waiting | Closed+bound windows with no job; **nobody is running them** | Attention + “Run this room’s waiting audio” |
| Stranded minutes | 15-min slots: waiting / no day / never closed | Per-card + day total. **Different measure** from piece-summed `audio_recorded_ms` |
| `marks_not_sent` | `bench_event` consult_mark not `sent` | Amber |
| `last_window_complete === false` | Newest `stt_window` cue rolled back | Amber “window did not finish” |
| Doctor clock | Warehouse-typed cue while recording, not paused; amber 15 min / red 30 min | Row **hidden** unless `has_doctor_clock`. Copy forbids “warehouse silent”. |
| `tape_without_cues` | MCP: any tape today and no cue | **Not named on the screen** (related: no-day / marks) |
| `kiosk_not_listening` | MCP flag = `!page_open` | Screen uses room_state dropped/offline instead |

### 6.6 Card edge (“worst”)

Red if: `ended_disagrees` OR `stalled` OR room_state red OR mic red OR doctor-clock red OR (recording AND `proven_dead_by_size`).  
Amber if: room_state/mic/clock amber OR `ended_at_lies` OR `marks_not_sent`.  
Unknown if listener read failed.

### 6.7 Timing constants (one place each)

| Constant | Value | File |
|----------|------:|------|
| `LISTENER_FRESH_MS` | 10 s | `bench-bus-constants.ts` |
| `LISTENER_OFFLINE_MS` | 10 min | same (presence, not stall) |
| `COMMAND_EXPIRY_SECONDS` | 15 s | same |
| `ACK_WAIT_MS` | 8 s | MCP wait only |
| `MIC_AMBER_MS` / `MIC_RED_MS` | 7 / 10 min | `room-facts.ts` |
| `DOCTOR_CLOCK_*` | 15 / 30 min | `room-facts.ts` |
| `STALLED_BADGE_MINUTES` | 10 | `bench-reaper-core.ts` |
| `STALL_MINUTES` (reap) | 30 | same |
| List “live” | 7 min, **primary only** | `BenchClient.isLive` — **not** the shared stall helper |
| Confirm stop / orphan | 10 s | `CONFIRM_STOP_MS` in `BenchRoomsLive` |

---

## 7. MCP / operator door vs Bench UI

Operator MCP lives in-repo as **ungrouped tools**. Cursor’s Even-Scribe MCP **groups** them:

| Grouped tool | `view` / `kind` | In-repo handler |
|--------------|-----------------|-----------------|
| `scribe_rooms` | `list` | `scribe_list_rooms` (`lib/mcp/tools/brain.ts`) |
| | **`now`** | **`scribe_diff_room`** (`lib/mcp/tools/bench.ts`) — this is the now-picture |
| | **`fleet`** | advertised as `scribe_fleet` — **no `scribe_fleet` (or fleet view) in this repository** |
| | `day_report` | `scribe_day_report` |
| | `clusters` | `scribe_get_clusters` |
| `scribe_room_command` | `start_day` / `pause_day` / `resume_day` / `end_day` | start/pause/resume/stop_recording |
| | `close_orphaned_session` | `scribe_close_orphaned_session` |
| | `set_audio_input`, `check_update_now`, `report_diag`, `restart_engine` | **not implemented in this Next app’s `COMMAND_KINDS`** |
| `scribe_sessions` | `list` / `replay` | `scribe_list_sessions` / `scribe_replay_session` |

`scribe_diff_room` was deliberately aligned with the screen (`lib/room-facts.ts`, `roomState()`). Remaining gaps:

### MCP has, UI does not surface

- Command queue (`scribe_list_commands`): pending/acked/failed/expired, source mcp vs admin
- Ack / `ack_timeout` / `bus_not_migrated` / `bus_down` as first-class (UI: one `note` string)
- `paused_disagrees`
- Flag name `tape_without_cues` / `kiosk_not_listening`
- `override_pause` start
- Wait-for-ack (8 s)
- Day report, extract/transcribe, consult mark write, replay
- Per-room pause/resume/stop **refused** when kiosk is dark (admin still queues)
- Native-app command kinds and a **fleet** view of recorders (devices, engine version, CoreAudio inputs) — grouping advertises `view=fleet`; this codebase has no handler

### UI has, MCP grouping does not replace

- Room PIN create/reset, rename, disable
- Processing switches + stop-all + run-waiting (paid batch)
- Attention list ranked for walking an OPD
- Wake lock, tablet hit targets, IST day summary minutes
- Session zip / manifest / chunk timeline
- Optimistic switches with loud correction

### Shared on purpose

Room state, stall windows, ended_disagrees / ended_at_lies, lanes, stranded audio, doctor-clock **no fallback to session start**, processing switches — one module so “the door and the screen cannot disagree.”

---

## 8. Tech debt / UX-limiting patterns

1. **Giant client file.** `BenchRoomsLive.tsx` (~1589 lines) owns polls, attention, cards, lanes, confirms, day summary, and the selection store. Hard to redesign a “fleet board” without splitting.
2. **Two lists, two clocks.** Live monitor = **today IST**, enabled rooms. Session table = last **200 sessions any day**, filtered by selected room. An idle room with old history looks “busy” in the table while the card says finished/offline.
3. **Live vs stalled disagree on the list.** `isLive` uses primary `last_chunk_at` &lt; 7 min; `isStalled` uses both mics &gt; 10 min. Backup-only audio can look not-live and not-stalled.
4. **Command bus is write-only from the UI.** No pending/expired/superseded visibility. After start, operator waits for the 3 s listener poll to infer success.
5. **Pause/resume/stop not listener-gated** on the admin route (MCP pause/stop are). Dark-room stop queues then expires — looks like it worked.
6. **Stop can strand Start.** Ending the day used to stop idle polls; idle heartbeat (`POLL_IDLE_MS` = 3 s) is the fix, but confirm copy still warns Start may require a walk to the Mac.
7. **Consult marks on detail do not poll**; chunk strip does (60 s).
8. **`/drain` and `/windows` are dark.** Historical window backfill and per-window drain are API-only.
9. **`mic_status` dead on the wire.** Correctly not shown; still computed.
10. **Doctor clock almost never draws** (nothing in production writes warehouse cues) — dead vitals still in types/thresholds.
11. **1 s tick re-renders the whole monitor** (all cards) to refresh ages.
12. **Session list 60 s** vs live 3/20 s — status chips below can lag the cards.
13. **No pagination / date picker** on recordings; 200-cap is silent.
14. **Module singleton selection** resets on full reload; survives polls; no URL `?room=`.
15. **Error states:** live monitor keeps last good picture (good); session load failure sets `[]` and a generic string (easy to miss). Processing failures are loud (good).
16. **MCP `scribe_fleet` / native kinds** are a product gap if the fleet board is meant to include Mac apps, not only browser kiosks.

---

## 9. What would need to change for a redesigned operator fleet board

This is a change list, not an implementation.

1. **Treat the live monitor as the product, not the session table.** Cards + attention + command outcomes are the fleet board. Fold recordings behind a room/day drill-down (already started with E4 + Disclosure).
2. **One IST-day query** for sessions under a card (same range as `readRoomsLive`), not a global 200 then filter.
3. **Unify freshness rules** (live 7 min primary vs stall 10 min either mic vs mic amber/red). One clock, labelled upload vs capture.
4. **Surface the bus:** last command id, status, expiry, ack payload, `kiosk_not_listening` — reuse `scribe_list_commands` / `listCommands`.
5. **Align write semantics with MCP:** pause/stop refuse when not listening *or* show “queued, nobody will hear this”; optional wait-for-ack; still no `override_pause` on the tablet unless explicitly designed.
6. **Deep-link** `/admin/bench?room=slug` (and session id) so MCP and humans share a URL.
7. **Split `BenchRoomsLive`:** poll hooks, `attentionItems`, `RoomCard`, day summary — so a fleet grid can vary layout without copying rules.
8. **Decide fleet scope:** kiosk rooms (this page) vs native recorder estate (`view=fleet`, device_uid, engine). If native: new listener fields + command kinds; current `COMMAND_KINDS` CHECK constraint must change.
9. **Keep `lib/room-facts.ts` as the contract** between UI, HTTP, and MCP so a redesign does not fork flags again.
10. **Do not put drain/window jargon on the board.** Keep “run waiting audio”; maybe a session-detail “technical” panel for `/windows` + `/drain`.
11. **Command outcome as a room-card line**, not a page-level `note` that applies to whichever room was clicked last.
12. **Optional: drop or hide doctor-clock** until a producer exists — it is correct code for a missing feed.

---

## 10. Hypothesis verdict

**Bench admin is a room-day / session supervisory board.**

- **Room-day:** live cards are “this IST date, this room”: tape, transcript, visits, stranded minutes, marks, kiosk presence.
- **Session supervisory:** selected room’s `bench_session` rows, chunk archive, consult marks; start/pause/stop/orphan over the command bus.
- **Not:** clinician roster, encounter send pipeline, STT lab, native hardware fleet (except as future MCP grouping).

Primary files to read first for a redesign: `app/admin/bench/page.tsx`, `components/admin/BenchRoomsLive.tsx`, `lib/admin/rooms-live.ts`, `lib/room-facts.ts`, `lib/bench-bus-constants.ts`, `app/api/admin/bench/command/route.ts`, `lib/mcp/tools/bench.ts` (`scribe_diff_room`).
