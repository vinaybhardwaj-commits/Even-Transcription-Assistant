# ETA R4-S REFUTER VERDICT — 11 Sep 2026

**ACCEPT.** Server diff `07dabbf..39463d8`: 16 files, all on the R4-S list plus the D12 ack route, touched only by `6df15d7` and `9f11bbd`. Rerun: `Tests 1678 passed (1678)`; typecheck and build exit 0.

1. No. Absent fields give null, then `COALESCE(${f.input_volume}::real, input_volume)` (room-install.ts:1044). The install write is "FAIL OPEN" (bench-commands.ts:287).
2. Retired: `AND retired_at IS NULL` → 404, no insert. No room cannot happen: `room_id text NOT NULL`. No listener: 504 ACK_TIMEOUT; the next poll expires the row.
3. No. Each day verb has its own `case`.
4. No. The DO block is one statement, inside `sqlAny.transaction(queries)`.
5. Dropped, not clamped: `n >= 0 && n <= 1 ? n : null`.
6. `"0.1.21-bad"`: refused. `"0.1.21 "`: stored trimmed as `"0.1.21"`, a real 0.1.21, not a bypass. `"0.1.100"`: passes.
7. No. Both give `{}`; the ack still lands.
8. No. `scope: "write"` and `!principal.scopes.has(tool.scope)` → 403. It returns room, `command_id` and listener `tab_id`, like the start tool. No token, no install_id.

**Flag.** D11 checks the bound install, but the bus delivers to the `bench_listener` owner. A browser tab ignores the row. A delivered row never expires, so it keeps a place in `LIMIT 20` for good. Apply 0080 before merge.
