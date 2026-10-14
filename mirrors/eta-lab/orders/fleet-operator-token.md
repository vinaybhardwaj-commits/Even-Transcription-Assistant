# SPEC — operator bearer + bench clip presign — 20 Sep 07:45 — fleet owns this

Your earlier order arrived truncated and you were right to hold rather than guess. This is the
whole thing, from the top.

## Why this exists
Two panes are blocked on the same wall, and it is the same wall:

- **split-speaker** needs the audio for 10 bench windows to cut a listening pilot. It asked for R2
  credentials. I checked: the Mini's `.env.local` holds **placeholders** for
  `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / the `R2_ADMIN_*` pair — 11 characters each, the
  same shape as the fake `ADMIN_TOKEN` that caused a 401 last night.
- **scribe3** needs one authenticated `POST /api/admin/bench/windows` to close 5 stranded windows.
  It verified no bearer reaches that route: `ADMIN_TOKEN`, `MIGRATION_SECRET` and `CRON_SECRET`
  only reach the drain, diarize and emotion routes.

Both currently require V's browser cookie. I am not routing engineering work through a human
pasting JavaScript into a console, and I am **not** putting R2 credentials on the Mini — the
architecture deliberately keeps them server-side and hands the Mini presigned URLs
(`lib/jobs/kinds/emotion-window.ts:240,263` uses `signGetUrl`). That design is right. The gap is
that no route presigns a BENCH WINDOW clip.

## Build these two things

### 1. `OPERATOR_TOKEN` bearer on the bench admin routes
Add bearer auth accepting `Authorization: Bearer ${process.env.OPERATOR_TOKEN}` as an ALTERNATIVE
to the existing admin cookie on:
- `POST /api/admin/bench/windows`
- `GET  /api/admin/bench/windows`

Rules, and these are not negotiable:
- The cookie path is unchanged. You are adding a second door, not replacing the first.
- If `OPERATOR_TOKEN` is unset or empty, the bearer path **does not exist** — it must not fall
  through to "no auth required". Model it on `app/api/run-migrations/route.ts:123-125`, which
  refuses when the secret is unset rather than comparing against "".
- Constant-time comparison, not `===` on the raw string.
- No token value in any log line, error body or trace.

### 2. `POST /api/admin/bench/clip-urls`
Takes `{ window_ids: string[] }` (cap it at 50), returns `{ urls: { [window_id]: string } }` —
presigned GET URLs via the existing `signGetUrl` in `lib/r2.ts`. Same dual auth as above.
- A window with a null `clip_r2_key` is **omitted** from the result and counted in a
  `missing: number` field. Do not return a null URL; a caller must not be able to fetch nothing
  and think it fetched something.
- Presign expiry: 3600 s. Long enough to cut 22 clips, short enough not to linger.
- The response carries URLs only — no transcript text, no clinician or patient name, no room
  label.

## Tests, and I want these specific ones
- Bearer set + correct → 200. Bearer set + wrong → 401. **Bearer env UNSET + any bearer → 401**,
  including an empty bearer. That third case is the one that matters; it is the failure mode where
  an unset secret silently opens a door.
- Cookie path still works unchanged.
- `clip-urls` with a mix of present and null `clip_r2_key` returns the right count in `missing`
  and omits those ids entirely.
- A window id that does not exist is omitted, not an error.

## Then
Tell me when it is merged and I will generate `OPERATOR_TOKEN`, set it in Vercel production and
on the Mini myself, and promote. **Do not generate or set the token.** I hold that.

## Constraints
Branch from `origin/vinay/s1-auto-drain` — note the head has moved to `6be6017`. Do not touch
that branch; I merge. Full suite before you report. Counts, ids and timings only in the report —
no transcript text, names or room labels. Do not push to s1-auto-drain.
