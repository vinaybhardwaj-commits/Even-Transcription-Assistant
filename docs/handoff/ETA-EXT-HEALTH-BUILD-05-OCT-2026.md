# ETA extension health — build note (5 Oct 2026)

Branch `vinay/ext-health` from `origin/main` ab68279. Not merged, not deployed, no migration, no CHECK change. Builder: Claude Fable 5.1.

## Why

The Pulse Presence extension is installed by a hand-written Chrome policy file in `/Library/Managed Preferences`, which macOS discards on every reboot. Cardiology rebooted 4 Oct 14:10 IST; its extension vanished (last ext row 08:39:27Z = 14:09:27 IST) while the tailnet poller kept saying `chrome_running=true`. Nobody noticed for 24 h. The server now says, per machine and within minutes, whether the extension is alive and current.

## What shipped

| File | Change |
|---|---|
| `lib/encounter-windows/ext-health.ts` (new) | `extHealth(db, {asOf})`, pure `computeExtHealth`, `loadExtHealthInputs`, `summarizeExtHealth`, `compareExtVersions`, the exclusion list. |
| `lib/fleet-attention.ts` | R8 `extension_missing` (red) and R9 `extension_behind` (amber) in `computeAttention`; `loadAttentionInputs` reads `extHealth` under its own degraded source name `ext_health`. `RoomAttentionInputs.ext?` is optional, so older callers compile. |
| `lib/fleet-attention-format.ts` | Two new kinds and their plain-words labels ("Presence extension missing", "Presence extension out of date"). The panel renders them with no UI change. |
| `app/api/encounter-windows/route.ts` | `?ext_health=1` returns `{ok, as_of, count, summary, machines}`; `?occupancy=1` gains `ext_health` (counts by status, or `null` if that read failed — it never fails the occupancy read). Admin bearer, `no-store`. |
| `lib/encounter-windows/index.ts` | Re-exports. |
| Tests | `ext-health.test.ts` (new, 36), `fleet-attention.test.ts` (+10 for R8/R9, kind-label list extended), `encounter-windows-routes.test.ts` (+5, one occupancy assertion extended), `fleet-attention-sql.test.ts` (+6 against postgres:16). |

## Status rules (per presence machine)

Poller row = newest `source='poller'` row; ext = newest `source='ext'` row of ANY event type (every one is sent by the extension).

| Status | Condition |
|---|---|
| `offline` | No poller row, or poller state is not `ok`, or poller row older than 5 min. Outranks everything: a silent extension on a Mac we cannot see is not `missing` (R1 owns "unreachable"). |
| `ok` / `behind` | An ext event inside 10 min. `behind` when `ext_version` < `EXT_TARGET_VERSION` (`0.1.1.39`, dotted-integer compare: `0.1.1.100` > `0.1.1.39` > `0.1.0.40` > `0.1.0.9`). Unknown or unparseable version is `ok`, not `behind`. |
| `no_tab` | Poller ok, `chrome_running=true`, no ext event in 10 min, and the newest ext event is a `logout` whose reason includes `tab_closed`, under 2 h old. |
| `missing` | Poller ok, `chrome_running=true`, no ext event in 10 min, and not `no_tab`. Includes a machine never heard from in 14 days. THE 4 OCT CARDIOLOGY CASE. |
| `ok` (gap) | Poller ok, Chrome NOT running, no recent ext event. Nothing is expected of the extension. The spec lists five statuses and Chrome-down is none of them; the row still carries `poller.chrome_running=false`. |

## Rules on the attention list

- **R8 `extension_missing`** — red; fires on status `missing` with the extension silent >= 10 min (always true for that status; kept explicit). `since` = last ext event (14 days back if none on record). Detail names room, machine, last heartbeat (IST) and version.
- **R9 `extension_behind`** — amber; status `behind` and the current behind-target run is >= 60 min old.
- Action (both): "Re-run the presence install on <room> (policy file lost, usually after a reboot)."
- Excluded machines never produce a row, a count or an item.

## Decisions

1. **Exclusion list, not allow-list, not a room flag.** The `room` table has no per-room settings column and nothing in the repo already marks "no extension" machines, so `EXT_HEALTH_EXCLUDED_MACHINES = ["Vinays-Mac-mini" (Home Office), "ORBOX3" (ORB3), "vinay-orb2" (ORB2)]` is a constant, compared case-insensitively on the normalised hostname. An exclusion list fails loud: a newly enrolled clinic Mac whose extension was never installed shows as `missing`; with an allow-list it would silently vanish. Adding a machine without an extension means adding it to this list.
2. **`behind_since` is a lower bound.** The loader looks back 24 h (`BEHIND_LOOKBACK_H`) for the first ext row after the machine's last at-or-above-target row, and it runs only for machines that are alive and behind. A machine behind for days reports "24 h ago". A 3-day look-back cost ~3x the rows on every 30 s fleet-attention poll for no change in the rule (R9 only needs ">= 60 min").
3. **Lookups are equalities on `machine`.** The first draft used `machine IN (normalised, raw)` like the older loaders; EXPLAIN at volume showed Sort over Seq Scan / Bitmap on `pulse_presence_events`. Ext rows and (since the 5 Oct 04:44Z poller cutover) poller rows both key on the normalised hostname, so each lookup is an index scan backwards on `pulse_presence_events_machine_ts_idx`. Pre-cutover short poller keys are not read: they matter only for a poller row, and a poller row older than 5 min is `offline` anyway.
4. **Own degraded name.** A failed ext-health read adds `ext_health` to `degraded` and skips only R8/R9.

## Verification

- `npm run typecheck`, `npm run typecheck:tests`, `npm run build`: clean.
- Full suite: 5,209 passed, 1 skipped, 1 failed — the known `no-identity-literals` failure (18 hits in `extensions/pulse-presence/test/*` and `tests/unit/warehouse-attribution.test.ts:264`, none in this branch's files).
- SQL tests (real postgres:16 via Docker): Cardiology case end to end (R8 on the attention list), `no_tab`, `behind` with a garbage version row and a version-less row in the history, the 24 h bound, the three excluded machines, and an EXPLAIN test at volume (no Seq Scan of `pulse_presence_events`, `pulse_presence_events_machine_ts_idx` used, nothing but SELECTs, no value text in any statement).

## Live probe (read-only, 5 Oct 2026 ~15:42 IST, `extHealth` on production data)

| Room | Status | Detail |
|---|---|---|
| Cardiology OPD | `missing` | last ext 4 Oct 14:09:27 IST, 0.1.0.36, poller ok, Chrome up |
| Dietary Room | `missing` | last ext 3 Oct 17:26 IST, 0.1.0.21, poller ok, Chrome up |
| OPD 4 | `missing` | last ext 15:20 IST today, 0.1.0.32, poller ok, Chrome up — went silent ~21 min before the probe (earlier the same afternoon its poller read unreachable: a reboot is likely) |
| OPD 1, OPD 3, OPD 5, OPD 6, OPD 7, Third Floor | `behind` | 0.1.0.14 / .31 / .33 / .34 / .35 / .38 against 0.1.1.39, all heartbeating |

Counts: `{ok:0, no_tab:0, missing:3, behind:6, offline:0, total:9}`. Once merged, R9 raises six amber items until the fleet is on 0.1.1.39; R8 raises three red.

## UNVERIFIED

- The extension's `logout` reason is assumed to be spelled `tab_closed` (taken from the spec); no `tab_closed` row exists in the data yet, so the `no_tab` path is proven with fixtures only.
- The deployed panel has not been looked at; it renders any kind through `KIND_LABEL`, which is covered by a unit assertion, not by a browser.
- Behaviour after a Mac sleeps with Chrome running (poller ok, extension quiet) is not separated from `missing`: both read as a silent extension.
