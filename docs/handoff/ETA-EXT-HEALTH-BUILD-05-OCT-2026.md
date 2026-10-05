# ETA extension health — build note (5 Oct 2026)

Branch `vinay/ext-health` from `origin/main` ab68279. Commit 1: the feature (R8/R9). Commit 2: `no_chrome` / R10 and the `rebooted_recently` flag. Commit 3 (this note's current state): the Refuter's six fixes. Not merged, not deployed, no migration, no CHECK change. Builder: Claude Fable 5.1.

## Why

The Pulse Presence extension is installed by a hand-written Chrome policy file in `/Library/Managed Preferences`, which macOS discards on every reboot. Cardiology rebooted 4 Oct 14:10 IST; its extension vanished (last ext row 08:39:27Z = 14:09:27 IST) while the tailnet poller kept saying `chrome_running=true`. Nobody noticed for 24 h. The server now says, per machine and within minutes, whether the extension is alive and current.

## What shipped

| File | Change |
|---|---|
| `lib/encounter-windows/ext-health.ts` (new) | `extHealth(db, {asOf})`, pure `computeExtHealth`, `detectReboot`, `loadExtHealthInputs`, `summarizeExtHealth`, `compareExtVersions`, the exclusion list. |
| `lib/encounter-windows/machine-keys.ts` (new) | One place for a Mac's spellings: canonical normalised hostname, raw hostname, pre-5-Oct poller short key (`consul4`...). Shared by ext-health and fleet-attention (which re-exports `POLLER_LEGACY_KEYS` / `legacyPollerKey`). |
| `lib/fleet-attention.ts` | R8 `extension_missing` (red), R9 `extension_behind` (amber, ONE fleet-level row), R10 `chrome_not_running` (amber, clinic hours only) in `computeAttention`; `loadAttentionInputs` reads `extHealth` under its own degraded source name `ext_health`. `RoomAttentionInputs.ext?` is optional. |
| `lib/fleet-attention-format.ts` | Kinds and plain-words labels ("Presence extension missing", "Presence extension out of date", "Chrome not running"). No UI change. |
| `app/api/encounter-windows/route.ts` | `?ext_health=1` returns `{ok, as_of, count, summary, machines}`; `?occupancy=1` gains `ext_health` (counts by status, or `null` if that read failed). Admin bearer, `no-store`. Doc comment lists every status. |
| Tests | `ext-health.test.ts` (73), `fleet-attention.test.ts` (98), `encounter-windows-routes.test.ts` (21), `fleet-attention-sql.test.ts` (39, real postgres:16). |

## Status rules (per presence machine)

Order: offline, no_chrome, then alive (ok/behind) or silent-with-Chrome-up (no_tab / quiet / missing). A poller that does not report `chrome_running` leaves a silent extension `ok` (no evidence either way).

| Status | Condition |
|---|---|
| `offline` | No poller row, poller state not `ok`, or poller row older than 5 min. |
| `ok` / `behind` | An ext event (any type) inside 10 min. `behind` when `ext_version` < `0.1.1.39` (dotted-integer compare). Unknown or unparseable version is `ok`. |
| `no_chrome` | Poller ok and `chrome_running=false`, any extension age. `chrome_down_since` = start of the current false run (24 h look-back, lower bound). |
| `no_tab` | Silent, Chrome up, newest ext event is a `logout` with reason `tab_closed`, under 2 h old. |
| `quiet` (new) | Silent, Chrome up, not `no_tab`, and nobody has used the console since the extension went quiet: `idle_s + poll age >= ext_age_s - 60`. An idle Mac with no Pulse page. Shown in the table, raises no item. |
| `missing` | Silent, Chrome up, not `no_tab`, and the console WAS used after the extension went quiet (`idle_s + poll age < ext_age_s - 60`). A missing `idle_s` is `missing` (nothing proves the Mac was idle). THE 4 OCT CARDIOLOGY CASE. |

Why `quiet` exists: the first replay over 4-5 Oct showed OPD 6 (5 Oct 13:18-14:34 IST) and OPD 7 (06:37-09:25 IST) as `missing` although nothing was wrong: Chrome was up, the Mac sat idle, the extension (before 0.1.1) stops heartbeating with no Pulse page. In both, `idle_s` trails `ext_age_s` by only ~5-55 s the whole time. In the real losses (Cardiology, Dietary, OPD 4) someone had used the Mac after the extension died (Cardiology: idle trails age by 318 s because of the post-reboot login), so `idle_s` is far below `ext_age_s`.

The poll's age is added to `idle_s` (a deviation from the literal "idle_s < ext_age_s - 60"): the poll can be up to a minute old, and the idle counter on a truly idle Mac was measured trailing the extension's age by ~51-54 s, so without the top-up a stale poll would tip an idle Mac into red.

## Rules on the attention list

- **R8 `extension_missing`** — red, status `missing`. `since` = last ext event. Action: "Re-run the presence install on <room> (policy file lost, usually after a reboot)." With the reboot flag: "Re-run the presence install on <room> (machine rebooted at HH:MM, policy file lost)." (said once).
- **R9 `extension_behind`** — ONE amber row for the fleet (`room_id` "fleet", `room_name` "Fleet", `machine` null): "N rooms on old extension builds: OPD 6 (0.1.0.34), OPD 5 (0.1.0.33), ...; update to 0.1.1.39." Includes rooms in status `behind` for >= 60 min, ordered oldest first; `since` = the earliest. Appends " Behind for at least 2 h." when any room's `behind_since` sits at the look-back floor. Action is about updating the extension, not re-installing the policy file.
- **R10 `chrome_not_running`** — amber, status `no_chrome`, only between 08:00 and 21:30 IST (every day). "Chrome is not running on <room>; presence cannot report." R8 and R10 never fire together.
- `quiet` raises nothing. Excluded machines never produce a row, count or item.
- **Reboot flag** (`rebooted_recently` / `rebooted_at`, a flag on any row, 15-minute window):
  - (a) an `ok` poll with `idle_s <= 120` right after an `unreachable` poll;
  - (b) the poller stayed `ok` but `idle_s` fell from >= 600 to <= 120 between two consecutive polls AND the extension went quiet at that moment (newest ext event within 2 min EITHER side of the drop, silent for >= 2 min by now). The lower bound keeps a long-silent machine touched after 10 min away from reading as a reboot: on Cardiology 4-5 Oct only the 14:09:58 drop is flagged, none of the eight others (09:06, 11:58, 12:39, 13:23, 5 Oct 08:03, 10:00, 13:13, 14:24). This is the Cardiology 14:09 pattern: idle 1028 -> 0, ext last row 14:09:27, poller never saw `unreachable`.

## Decisions

1. **Exclusion list, not allow-list, not a room flag.** `EXT_HEALTH_EXCLUDED_MACHINES = ["Vinays-Mac-mini" (Home Office), "ORBOX3", "vinay-orb2"]`, compared on the normalised hostname. Fails loud: a newly enrolled clinic Mac without the extension shows `missing`.
2. **Behind look-back is 2 h (was 24 h), a lower bound.** R9 only needs >= 60 min; at ~240 ext rows per machine the read is cheap on every 30 s fleet-attention poll. A machine behind for the whole window is dated by the window start and flagged `behind_at_floor` (first row within 2 min of the floor), which R9 words as "at least 2 h". (The coordinator's text said "at least 24 h", written for the old floor; the wording now follows the actual floor, `BEHIND_LOOKBACK_H`.)
3. **Poller lookups match every spelling; extension lookups match the full hostname only** (`machine-keys.ts`). The old short poller keys exist only on poller rows, so an `as_of` replay over the 5 Oct 04:44Z cutover reads poller rows under canonical, raw and short key (nested LATERAL, `machine = k.key`; `= ANY(m.keys)` under aggregates), while the three ext reads are a single `machine = m.n` range per machine. The EXPLAIN-at-volume test asserts every ext index scan uses that one key and runs at most one loop per fleet machine.
4. **Planner lessons, enforced by the EXPLAIN-at-volume test** (no Seq Scan of `pulse_presence_events`, `pulse_presence_events_machine_ts_idx` used; all four statements covered, including the Chrome-down read): equality on `machine` under `ORDER BY ts DESC LIMIT`; LATERAL + LIMIT for the poller history; no plain JOIN to `jsonb_to_recordset`.
5. **Own degraded name.** A failed ext-health read adds `ext_health` to `degraded` and skips only R8/R9/R10.

## Verification

- `npm run typecheck`, `npm run typecheck:tests`, `npm run build`: clean.
- Full suite: see the commit report (known unrelated `no-identity-literals` failure only).
- Real-postgres tests (postgres:16 via Docker): Cardiology end to end, `no_tab`, `behind` with garbage and version-less rows, the 2 h floor and the one-row-for-two-rooms case, exclusions, `quiet` vs `missing`, the idle-drop reboot, an as_of replay that needs the short poller key and the raw hostname, and the EXPLAIN test.
- **Replay** (`extHealth` at 5-minute `asOf` steps, 4 Oct 08:30 IST to 5 Oct 16:10 IST, 381 evaluations on production data): `missing` runs are only Cardiology (4 Oct 09:10-13:50, extension 0.1.0.20 not yet re-installed; and 14:20 onward), Dietary (5 Oct 10:05 onward) and OPD 4 (5 Oct 15:35 onward). OPD 6 13:30-14:30 and OPD 7 06:50-09:25 are `quiet`. The measured numbers are fixtures in `ext-health.test.ts`.

## Live probe (read-only, 5 Oct 2026 ~16:13 IST)

`{ok:0, no_tab:0, missing:2, quiet:0, behind:6, offline:1, no_chrome:0, total:9}`. Cardiology and OPD 4 `missing`; Dietary `offline` at that instant (poller blip, rebooted 16:04 IST; it was `missing` from 10:05 to 16:05); OPD 1, 3, 5, 6, 7 and Third Floor `behind` (0.1.0.14 / .31 / .33 / .34 / .35 / .38). Once merged: two or three red R8 items and one amber R9 row listing the six rooms.

## UNVERIFIED

- The extension's `logout` reason is assumed spelled `tab_closed`; no such row exists in the data, so `no_tab` is proven with fixtures only.
- The deployed panel has not been looked at; the fleet row uses `room_id` "fleet", which the panel treats like any room id.
- `idle_s <= 120`, `>= 600` and the 60 s margin are judgement calls from a handful of observed reboots and idle episodes.
- A rebooted Mac that nobody touches afterwards reads `quiet` (not `missing`) once its extension is 10 min silent, because the idle counter then matches the extension's age; the reboot flag covers only the first 15 minutes. Cardiology and OPD 4 were touched after their reboots.
