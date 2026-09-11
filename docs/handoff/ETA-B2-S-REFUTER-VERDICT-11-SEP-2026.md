# ETA B2-S REFUTER VERDICT — ACCEPT `0b9757a` — 11 Sep 2026

**Files.** `4fbf6d0..HEAD`, 14 files: `db/migrations/0079…`, `room-install.ts`, `room-install-view.ts`, both routes, `BenchInstallFleet.tsx`, four `tests/unit/room-install*`, `bench-commands.ts` (ruled), kickoff, report, addendum (ruling 8, `0b9757a` body). Nothing else.

**Gate (mine).** `Tests 1621 passed (1621)`; typecheck, build exit 0.

1. No. `peak = COALESCE(${f.peak}::real, peak)`, likewise `zero_ratio`, `input_devices`; `input_device_name = COALESCE(…)` (`:984`) unchanged.
2. No. `installAdminGuard` runs first, as retire; `if (channel !== "stable")` → 400. Tests: 401, 400, 404.
3. No. `if (i.enrolled_at) park(i, "second_bound")` → Unassigned, "second live install in one room"; tested.
4. No. `CommandPollResponse` decodes via `container(keyedBy: CodingKeys.self)`; no `allKeys` check in `Sources/`. Unknown keys ignored.
5. No. One additive ALTER, no DEFAULT; the CHECK scans a few dozen rows in one `sql.transaction`: milliseconds against the 1.5 s poll (`RoomEngine.swift:1176`). Flag: no `lock_timeout`.
6. Yes, same UPDATE: `CASE WHEN ${f.update_channel}::text = 'stable' THEN NULL ELSE assigned_channel END`; RETURNING gives the post-update value. Omitted → NULL → ELSE, kept. Correction: 0.1.19 does send `update_channel` (`RoomEngine.swift:1091`); it clears only when that Mac reports `stable` itself.

Flag: SQL semantics checked by reading and a test fake, not live Postgres.
