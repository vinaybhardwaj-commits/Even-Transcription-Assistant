# ETA-Refuter — health flaps, root cause (Fable ruling 25)

**Role:** Debugger, root cause only. **No changes made.**
**Asked:** 06:37 / 07:50 / 08:05 IST, self-healing, whisper probe only. Read the probe code
(timeout; whether it caches a negative — conductor saw failures in 1–2 ms), read Vercel and
cloudflared logs for those minutes, find what drives Mini load ~5 while whisper is idle, and say
whether any real room_window/STT call failed. Report ≤12 lines.

Delivered on the bus as #107. This is the filed copy.

---

## Cause — not a whisper outage. Two defects in `lib/health/whisper-probe.ts`.

**1. The probe's fuse is 7.5× tighter than a real call.**
`WHISPER_PROBE_BUDGET_MS = 12_000` (`:31`) against the real STT budget of `90_000`
(`lib/whisper.ts:336`). whisper.cpp serialises, so a probe that lands while a `room_window` is
transcribing queues behind it and aborts at 12 s. The probe also posts a `.webm` fixture
deliberately, so that ffmpeg runs before whisper.cpp (`:35` — a `.wav` "skips that leg
entirely"). It is therefore the heaviest possible shape on the shortest fuse.

**2. The busy rule cannot fire on a cold instance.**
The rule that exists to absorb exactly this (`:210`) is guarded on `LAST_OK_AT !== null`, and
`LAST` / `LAST_OK_AT` are **per-lambda module state** — the file's own comment says "one lambda
instance answers from its own last measurement". On a cold Fluid instance `LAST_OK_AT` is `null`,
so a timeout is never downgraded to `busy_recent_ok`; `app/api/health/route.ts:69` throws
`whisper_probe_whisper_timeout`. Instance reuse means this stays quiet until a cold instance draws
the short straw, which is why it flaps instead of failing consistently.

**3. The 1–2 ms failures are the negative cache.**
`LAST` is assigned after **every** fresh run, ok or not, and the read path re-serves it verbatim
with `cached: true`. One 12 s timeout is then re-served for up to `WHISPER_PROBE_CACHE_MS = 60_000`
in about a millisecond. Three "flaps" are therefore not three measurements.

## Evidence

- Flaps in UTC (the Mini is IST, +0530): **01:07, 02:20, 02:35**.
- `room_window` ran **02:20:18 → 02:23:10** and **02:35:18 → 02:38:11**, both `status=done`,
  ~2m52s each, on a `:20:18 / :35:18 / :50:18` cadence. They span flaps 2 and 3 exactly.
- Flap 1: `emotion_window` **01:05:04 → 01:06:10** (66 s) ended 50 s before 01:07 — inside the
  60 s cache window.
- Live production at the time of writing: sha `a30186c`, whisper `cached:false`,
  `probe_ms = 1229`. A 1.2 s idle baseline against a 12 s fuse, overrun ~14× by a 172 s window.
- The Mini's load is **not** whisper. 12 cores, load 3.56 (~30%, not saturated); `whisper-server`
  pid 90169 at **0.0% CPU**, started 04:39 IST, no restart across any flap. The drivers are
  `eta-indic/indic_ser` (pid 1839, ~98–141% CPU, 2.7 GB RSS, up 13 days), `eta-router` uvicorn
  (pid 57831, ~71%), Docker Desktop (~42% across three processes) and WindowServer (~41%).

## Production impact: NO

Zero `room_window` or STT failures on 24 Sep; the newest `room_window` failure is
**2026-09-23 22:20 UTC**. Both `room_window` jobs spanning the flaps completed `done`, and they ran
through the same tunnel — which also excludes a tunnel cause.

## What I could not get, stated plainly

- **Vercel retains no error/warning line for any flap.** The health failure is not logged
  server-side, so conductor's external poll is the only record.
- **cloudflared keeps no log.** `/opt/homebrew/var/log/cloudflared.log` was last written
  **22 May 2026** — 23 MB, 4 distinct lines, a dead crash loop. I excluded the tunnel by the
  successful `room_window` jobs, not by its logs.

## Fix proposed (not made)

1. **Cache only `ok` results**, so a negative is always re-measured rather than re-served for 60 s.
2. **Stop requiring the instance's own prior success** — take `last_ok_at` from shared state, or
   treat a timeout as busy when an STT job is in flight.
3. Cheapest interim: raise the probe budget toward the 90 s real budget.

**Design fork I am NOT ruling on:** whether a busy Mini should read `ok`, `degraded` or `not-ok`.
Fable's or V's call.

## Surfaced incidentally, unclaimed by anyone

- `/api/admin/room-watchdog` logs **every minute** that its email and WhatsApp channels are
  unconfigured (`WATCHDOG_ALERT_EMAIL_TO`, `WASENDER_API_KEY` / `WASENDER_BASE_URL` /
  `WASENDER_ALERT_TO`). **The room watchdog currently cannot alert anyone.**
- `[emotion] enqueued 1; 30 failed window(s) at the 3-attempt bound`.

Neither is in my lane to fix. Both are in #107.
