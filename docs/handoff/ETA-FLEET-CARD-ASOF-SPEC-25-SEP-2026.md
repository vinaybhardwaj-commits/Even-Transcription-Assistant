# Fleet card: `peak` / `zero_ratio` "as of" — SPEC ONLY (Fable rulings 263, 278; 25 Sep 2026)

Status: spec. Nothing built, nothing deployed. Build is daylight work on its own small train, after the a92ebae and watchdog trains settle.

## 1. The defect (verified in code)
`lib/room-install.ts` writes `peak = COALESCE(${f.peak}::real, peak)` and `zero_ratio = COALESCE(${f.zero_ratio}::real, zero_ratio)` (lines ~1448-1449). A poll that omits them keeps the LAST value the row ever held, and no timestamp says when that was. `lib/room-install-view.ts:985-986` hands both to `components/admin/BenchInstallFleet.tsx:726`, which prints `peak x.xx · zero y.yy` with no age. So a card can show a reading from hours or days ago as if it were live. "We never measured" (or "not measuring now") reads as "we measured and it was that".

This is the rule the repo already states: a signal about absence must be derived at read time against a fresh clock. The stored value is not wrong; the card's silence about its age is.

## 2. What the card must do (Fable 263)
Show an "as of" time beside the reading, or blank a reading older than 1 hour. Recommendation: BOTH. Under 1 h the value is shown with its age ("peak 0.31 · zero 0.00, 4 min ago"); at 1 h or more it is replaced by "no reading for 1 h" (last known time still shown). Mark, never delete: the column keeps its value; only the card's presentation changes, and `scribe_rooms` / the MCP view keep the raw value plus its time.

## 3. Where the timestamp comes from
Option 1 (recommended): new column `levels_at timestamptz` on `room_install`, set in the same UPDATE:
`levels_at = CASE WHEN ${f.peak}::real IS NOT NULL OR ${f.zero_ratio}::real IS NOT NULL THEN now() ELSE levels_at END`
Same statement as the values, so value and time cannot disagree. NULL for existing rows until their next reading = "unknown age" = blanked, which is the honest state. One additive migration; no backfill. Migration number: 0119 is the watchdog outbox and 0120 is the level-log device context (`vinay/level-log-device-context`, ruling 346), so this one is 0121; no 0121 or above existed on any remote branch as of 25 Sep 09:10 IST; re-check before adding.
Option 2 (no migration): derive it from `poll_ring` (each entry has `at`, `peak`, `zero_ratio`). Rejected as the primary: the ring holds only `POLL_RING_SIZE = 10` polls, so it can say "a reading in the last 10 polls" but cannot say "1 h ago"; anything older than the ring would blank at minutes, not at the hour Fable asked for, and it needs the ring in the view's select (`room-install.ts:1655-1665` does not read it today).
Option 3: also stamp `clip_count` / `silence_ms` the same way (they are COALESCEd too, added by 0081). Not asked for; noted so a later change does not repeat the defect. Out of scope here.

## 4. Changes (small)
- `db/migrations/0121_room_install_levels_at.sql`: `ALTER TABLE room_install ADD COLUMN IF NOT EXISTS levels_at timestamptz;` (0120 is taken by ruling 346; re-check at build).
- `lib/room-install.ts`: the CASE above in the poll UPDATE; select `levels_at` in the list read (~1660) and map it.
- `lib/room-install-view.ts`: expose `levels_at` and a derived `levels_age_ms` computed from a `now` argument (never Date.now() inside the pure view).
- `components/admin/BenchInstallFleet.tsx` (~726): age suffix under 1 h, "no reading for 1 h" at or over, nothing when `levels_at` is NULL and the values are NULL.
- Constant `LEVELS_STALE_MS = 3_600_000` beside `POLL_RING_SIZE`.

## 5. Tests (mutation-checked, real Postgres via `pgContainer` for the SQL)
1. A poll with peak/zero_ratio sets `levels_at`; a later poll omitting both keeps the value AND leaves `levels_at` unchanged (the exact defect).
2. A poll with only one of the two still sets `levels_at`.
3. View: 59 min 59 s shows the age; exactly 1 h blanks; NULL `levels_at` with non-null values blanks (a row from before the migration).
4. The view takes `now` as an argument: two calls with different `now` give different ages.
Mutations: CASE always `now()`; CASE never updates; threshold `>` vs `>=` at the boundary; view reading `Date.now()`.

## 6. Interaction with 1e75667 and the alarm
1e75667 makes the LEVEL LOG carry the Mac's `zero_ratio`; this spec is about the FLEET CARD's sticky install column, a different path. The alarm reads the level log and is unaffected. The "as of" time makes the card's number comparable with what the alarm sees.

## 7. Risks
- The card gets one more field; older clients of `scribe_rooms` see an added key only.
- A room whose Mac never sends peak (below 0.1.20) shows nothing, as today.
- `levels_at` uses the server clock (`now()`), not the Mac's, so a Mac with a wrong clock cannot make a stale reading look fresh.
