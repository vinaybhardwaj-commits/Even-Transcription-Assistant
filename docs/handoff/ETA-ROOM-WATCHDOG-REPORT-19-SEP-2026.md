# ETA — Room Watchdog — REPORT — 19 Sep 2026

## 1. Commits

- Merge: `52698d9` — `origin/vinay/s1-auto-drain` (1f03aa2) into `bench/device-missing-row-state`, one manual conflict resolved (§2).
- Feature: `3d3e225` — the Room Watchdog.

Branch `bench/device-missing-row-state`. Not pushed. `main` untouched.

## 2. Pre-flight and the merge

`pwd`/`git remote -v`/`git fetch`/`git rev-parse` all matched the order. `bench/device-missing-row-state` existed locally at exactly `efed7ae` as stated. Untracked `docs/handoff/*` (including a new `.writetest`) matched this kickoff's wording; `tmp-e31c-mutation.json` is the same 0-byte stray from 16 Sep that V told me on 17 Sep to leave alone — not re-flagged.

**The order's premise "zero conflicts" did not hold.** The merge produced one conflict, in `lib/room-install-view.ts`, on the exact `state:` line 8968b71 touches. `origin/vinay/s1-auto-drain` carries an independent, unrelated fix for the same line — an "ETA-DELIVERY-EVIDENCE" mechanism (`notDelivering`, derived from `isBenchStalled` over `bench_chunk` delivery, D-6) — whose own comment states its author did not know 8968b71 existed ("that commit is not an ancestor of this branch's base... see the Builder's report for the flag"). The two signals are not in conflict, they are additive: `state_flags` degradation is what the Mac's own poll says about its capture; `notDelivering` is whether bytes are actually landing in `bench_chunk`, computed independently so an absent Mac's absence can be noticed by something other than the absent Mac. I resolved the conflict by OR-ing both conditions together (a room needs attention if either fires) rather than choosing one over the other. **Flagged for the Orchestrator's ruling**: this OR-combination is the Builder's merge resolution, not something either commit specified.

## 3. Gate, after the merge and after the feature

- `npm run typecheck` — clean both times.
- `npm test` — after merge: 129 files / 2977 tests. After the feature: **130 files / 2994 tests**, all green.
- `npm run check:silent` — **9 findings**, unchanged, all pre-existing at `1193083`, none in touched files.
- `npm run build` — clean; both new routes (`/api/admin/room-watchdog`, `/api/admin/room-watchdog/mute`) present in the manifest.
- `cd apps/room-recorder && swift build && swift test` — clean, 600/600 (the `TestingMacros` plugin failure from the 17 Sep report did not recur — looks like it was a transient toolchain/cache state, not a real regression; not investigated further since no Swift file changed).

## 4. Migration DDL (`db/migrations/0103_room_alert_state.sql`, not run)

```sql
CREATE TABLE IF NOT EXISTS room_alert_state (
  room_id      text        PRIMARY KEY REFERENCES room(id),
  status       text        NOT NULL DEFAULT 'ok',
  since        timestamptz NOT NULL DEFAULT now(),
  muted_until  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_alert_state_status_chk CHECK (status IN ('ok', 'offline', 'degraded'))
);
```

## 5. Every SQL string — INFERRED, verify before merging

Read from `db/migrations/0041_room_bench.sql` (`room.id`, `room.name`, `room.disabled_at`) and `0075`/`0081_room_states_and_verbs.sql` (`room_install` columns, `state_flags` jsonb shape). I could not run any of these against a real database.

Fleet read (`runWatchdog`):
```sql
SELECT
  r.id AS room_id, r.name AS room_name,
  ri.last_seen_at, ri.tape_advancing, ri.session_open, ri.disk_free_bytes,
  COALESCE(ri.state_flags -> 'flags', '[]'::jsonb) AS state_flags,
  ras.status AS prior_status, ras.since AS prior_since, ras.muted_until AS muted_until
FROM room_install ri
JOIN room r ON r.id = ri.room_id
LEFT JOIN room_alert_state ras ON ras.room_id = r.id
WHERE ri.retired_at IS NULL AND ri.enrolled_at IS NOT NULL AND r.disabled_at IS NULL
```
State write, per room: `INSERT INTO room_alert_state (room_id, status, since, updated_at) VALUES (...) ON CONFLICT (room_id) DO UPDATE SET status = EXCLUDED.status, since = EXCLUDED.since, updated_at = now()`.
Mute write: `INSERT INTO room_alert_state (room_id, status, since, muted_until, updated_at) VALUES (${roomId}, 'ok', now(), ${mutedUntil}, now()) ON CONFLICT (room_id) DO UPDATE SET muted_until = EXCLUDED.muted_until, updated_at = now()` — never touches `status`/`since` on an existing row.

## 6. The four message shapes (exact text; `%s`/`{n}` are the only variables)

- **Offline** — subject `EvenScribe watchdog: {room} is offline`; text `{room} has not polled in over 5 minutes, as of {iso}. Nothing is being recorded until it reconnects.`
- **Degraded** — subject `EvenScribe watchdog: {room} capture is degraded`; text `{room} is polling but its capture looks degraded — a missing device, silence, clipping, a stalled encoder, a stalled tape, or critically low disk — as of {iso}. Go and look.`
- **Recovery** — subject `EvenScribe watchdog: {room} is back`; text `{room} recovered after being {offline|degraded} for {duration}. It is recording normally again as of {iso}.`
- **Fleet-wide** — subject `EvenScribe watchdog: {n} rooms went offline at once`; text `{n} of {total} enabled rooms went offline in the same run, as of {iso}. This looks like a network or platform outage, not {n} separate room failures. Individual offline alerts are suppressed for this event.`

## 7. Deviations and flags

- **§2's merge resolution** is the biggest one — see above.
- **A bug my own tests caught**: "more than half" as a bare fraction fires on a single room (1 offline of 1 enabled is >50%), and would have fired for a lone *muted* room's transition too. Fixed with an `offlineTransitions >= 2` guard alongside the fraction check — not specified by D3, added because the fraction check alone is wrong at small fleet sizes.
- **`DEGRADED_STATE_FLAGS` (8968b71) is duplicated, not imported.** It isn't exported, and this build's file contract forbids editing `lib/room-install-view.ts` to export it. The duplicate is named and comment-linked to its source; nothing enforces that they stay in sync if 8968b71's set changes.
- **Two destination env vars the order didn't name**: `WATCHDOG_ALERT_EMAIL_TO` (email) and `WASENDER_ALERT_TO` (WhatsApp number) — D8 named the *credentials* but not where alerts go. Both follow the same "missing → log by name, send nothing" rule as the credentials.
- **WaSender's request shape is UNVERIFIED** — no existing code or docs to read. I built the conventional gateway shape (`POST {WASENDER_BASE_URL}/api/send-message`, bearer auth, JSON `{to, text}`); confirm against WaSender's actual API before this fires for real.
- **"Enabled rooms" (D3's denominator) = rooms with an active, non-retired, enrolled install and `room.disabled_at IS NULL`** — a room with no Mac at all isn't part of the fleet the watchdog can say anything about.
- **Muted rooms count toward the D3 fleet-wide numerator and denominator** but never get an individual message — a real mass outage shouldn't be undercounted just because one of the affected rooms happened to be muted for an unrelated reason.

## 8. Migration or manual step

`db/migrations/0103_room_alert_state.sql` has not been run. V runs it by hand; no other step needed to merge. Deploying activates the cron only once `CRON_SECRET` is set (already true, per the jobs/run pattern) and does nothing until then — `GET` returns 503 with an unset secret.

## 9. Subagents

None. Single-session read-then-write work throughout; no parallelizable research or disjoint-file edits that would have justified one.

---

## 10. ADDENDUM (19 Sep, same day) — V's ruling on the merge, the signal-naming follow-up, the merge to `vinay/s1-auto-drain`, and the promotion blocker

**The OR stands, ruled.** V confirmed the merge resolution in §2 and required two things before shipping: the alert text must name which signal fired, and the fleet-wide minimum-count guard must be proven under the OR, not just against one signal.

**Commit `75cb0f9`** (on `bench/device-missing-row-state`, "Watchdog: name which degradation signal fired") does both:
- `computeRoomStatus` now returns `{ status, reasons: DegradationReason[] }` instead of a bare status. Reasons: `device_missing`, `silent_while_recording`, `clipping`, `encoder_stalled`, `tape_stalled`, `disk_critical` (the classifier side), and `not_delivering` (the merge's other signal — reusing `isBenchStalled` and `lib/room-install.ts`'s own `listBenchSessions({status:"recording"})` join, not a new INFERRED SQL string).
- The degraded message text changed from a fixed list of possibilities to naming exactly what fired: `"{room} is polling but its capture looks degraded — {reason phrases, joined} — as of {iso}. Go and look."` E.g. only the classifier: `"...— a missing input device —..."`; only delivery: `"...— no audio reaching storage, independent of what the Mac itself reports —..."`; both: `"...— a missing input device and no audio reaching storage, independent of what the Mac itself reports —..."`. §6's degraded-message row above is superseded by this.
- New tests prove the minimum-count guard under the combination: a single **muted** room carrying **both** the classifier's reason and `not_delivering` at once still sends zero messages — there is no fleet-wide mechanism for `degraded` at all (D3 names `offline` only), so the guard question reduces to "does combining signals ever let a lone room look like more than one room," and it does not, on either path.
- Gate re-run clean: typecheck, **130 files / 3002 tests**, check:silent at the same 9-finding baseline, build clean.

**Merge to `vinay/s1-auto-drain`.** `origin/vinay/s1-auto-drain` was still at `1f03aa2` when I re-fetched — no new commits had landed beyond what `bench/device-missing-row-state` already contained (the "four docs commits after `ba2368a`" V described are the two, `0034dd1` and `1f03aa2`, already inside my branch's history). The merge was therefore a **clean fast-forward to `75cb0f9`** — no new merge commit, no conflict, no stash of any kind (verified `CLAUDE.md`'s tracked content was byte-identical between both branch tips before switching, so the uncommitted local modification was never at risk). Full gate re-run on `vinay/s1-auto-drain` itself: typecheck clean, 130/3002 green, check:silent at baseline, build clean, `swift build && swift test` 600/600. **Pushed**: `1f03aa2..75cb0f9 vinay/s1-auto-drain -> vinay/s1-auto-drain`.

**PROMOTE — NOT DONE. Flagging this plainly rather than guessing or forcing it.** The push created a **preview** deployment only, exactly as V said it would: `dpl_AVDuSjbbhY5mUfgXUHKPzY6DF9i1` (`even-transcription-assistant-62u25qdtk.vercel.app`, commit `75cb0f9`, `target: null`). Looking at every prior merge to this branch, production only ever moved through a **separate, later action** — each one shows a preview deployment first, then one or two additional deployments for the *same commit* minutes later carrying `target: "production"`. That second step is not exposed by any tool in my Vercel MCP surface: `deploy_to_vercel` only takes inline file contents (explicitly the wrong tool for a full Next.js repo — "do not reconstruct medium or large projects... in tool arguments"), and there is no `promote`/`redeploy`-an-existing-deployment tool available to me. There is also no local Vercel CLI on this machine (`vercel: command not found`). I did not attempt a workaround, since the only ones available (rebuilding the app as inline files, or guessing at an undocumented API call) risk producing a deployment that does not match this exact commit, or worse.

**What I need from you**: promote `dpl_AVDuSjbbhY5mUfgXUHKPzY6DF9i1` yourself (Vercel dashboard → this deployment → Promote to Production, or `vercel promote` from a machine with the CLI), then tell me the resulting production deployment id if you want it in this record — I have no way to generate it myself with what I have. This is the one instruction in your ruling I could not carry out.

**Two undeclared env vars, restated with unset behavior**: `WATCHDOG_ALERT_EMAIL_TO` (email destination) and `WASENDER_ALERT_TO` (WhatsApp destination) — neither is named in D8, both are required for their channel to send. Vercel env is baked at build time: adding either now requires a **redeploy**, not just a dashboard settings change, or the corresponding channel ships dark. Unset behavior is not a crash and not a guess: `sendEmailAlert`/`sendWhatsAppAlert` check all three required vars for their channel (credentials + destination) up front, and if any is missing they log `"[room-watchdog] {channel} not configured — missing {NAME[, NAME...]}"` by exact env var name and return `ok:false` without calling `fetch` at all — the run continues, the other channel is unaffected, and nothing is retried or defaulted.

**WaSender's request shape remains UNVERIFIED** — left exactly that way, not guessed into looking settled. `POST {WASENDER_BASE_URL}/api/send-message`, bearer auth, JSON `{to, text}`, is this build's inference from conventional gateway shape, with no WaSender documentation or existing code read to confirm it. Confirmation would require either reading WaSender's actual API reference or watching one real send arrive at the destination number — until one of those happens, treat every WhatsApp alert this sends as unconfirmed to have arrived, even when the HTTP call itself returns 200.
