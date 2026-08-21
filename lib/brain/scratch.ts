/**
 * lib/brain/scratch.ts — the scratch graph's room and day (ETA Fuse slice 2, F4/F6/F7).
 *
 * A scratch room_day cannot share (room_id, ist_date) with a live one: 0042 declares that
 * pair UNIQUE and resolveRoomDay's ON CONFLICT names it verbatim. Neither is touched here.
 * Instead the scratch day hangs off its OWN scratch room (F6), one per real room, so the
 * constraint is satisfied by construction rather than by weakening it.
 *
 * Everything in this file is find-or-create and safe to run twice: both ids are DERIVED from
 * the real room's id, so a second run finds the same rows instead of making new ones. There
 * is no randomness here at all — nothing to make two runs disagree.
 *
 * TWO POOLS, on purpose:
 *   `room`     is a Room Bench table (0041) — read and written through the app handle
 *              (lib/db, APP_DATABASE_URL), exactly as POST /api/bench/rooms does.
 *   `room_day` is a brain table (0042) — read and written through the brain pool
 *              (lib/brain/db, BRAIN_DATABASE_URL), exactly as lib/brain/state does.
 * Same database, two roles. Mixing them in one module is the honest shape for a helper that
 * has to touch both; nothing here writes a cue (that goes over HTTP through the one door).
 *
 * SQL HONESTY: there is no live database in the build sandbox. Every string below is
 * INFERRED against 0041_room_bench.sql, 0042_brain_tables.sql and 0046_scratch_graph.sql,
 * and every one is a named constant so the report can list it word for word. Every function
 * fails safe to a named refusal — never a throw, never a silent wrong write.
 */

import { sql } from "@/lib/db";
import { query } from "./db";

// ---------------------------------------------------------------------------
// Derived identity — obviously scratch to a human reading a list
// ---------------------------------------------------------------------------

export const ROOM_PREFIX = "room_";
export const SCRATCH_ROOM_PREFIX = "room_scratch_";
export const SCRATCH_ROOM_DAY_PREFIX = "rd_scratch_";
export const SCRATCH_SLUG_PREFIX = "scratch-";
export const SCRATCH_NAME_PREFIX = "SCRATCH · ";

/**
 * The scratch room's PIN hash. `room.pin_hash` is NOT NULL, so the column has to hold
 * something; this is deliberately NOT a bcrypt hash, so bcrypt.compare in the room login
 * route can never return true for any PIN (it returns false, or throws and the route
 * refuses). A scratch room is not a place anyone logs in to.
 */
export const SCRATCH_PIN_HASH = "scratch-room-no-login";

const suffixOf = (roomId: string): string => (roomId.startsWith(ROOM_PREFIX) ? roomId.slice(ROOM_PREFIX.length) : roomId);

/** `room_abcd1234` → `room_scratch_abcd1234`. Deterministic: a second run finds it. */
export const scratchRoomIdFor = (roomId: string): string => `${SCRATCH_ROOM_PREFIX}${suffixOf(roomId)}`;

/**
 * The INVERSE of scratchRoomIdFor: `room_scratch_abcd1234` → `room_abcd1234`. Null when the id
 * is not a scratch room id at all, so a caller cannot accidentally "recover" a real room from
 * one that never had a scratch twin.
 *
 * Slice 5 needs this because a scratch room has NO TAPE — bench_session rows belong to the real
 * room — so the report has to walk back from the scratch day to the room that actually
 * recorded. It lives here, next to the forward function and built from the same two constants,
 * so the pair cannot drift; the alternative was string surgery on a hardcoded prefix at the
 * call site, which is exactly what the slice 5 PRD forbids.
 */
export const realRoomIdFor = (scratchRoomId: string): string | null =>
  scratchRoomId.startsWith(SCRATCH_ROOM_PREFIX) ? `${ROOM_PREFIX}${scratchRoomId.slice(SCRATCH_ROOM_PREFIX.length)}` : null;

/** `opd-7-k4hz` → `scratch-opd-7-k4hz`. `room.slug` is UNIQUE, so this must be derived too. */
export const scratchSlugFor = (slug: string): string => `${SCRATCH_SLUG_PREFIX}${slug}`;

/** `OPD 7` → `SCRATCH · OPD 7`. Reads as scratch at a glance in any list of rooms. */
export const scratchNameFor = (name: string): string => `${SCRATCH_NAME_PREFIX}${name}`;

/** `room_scratch_abcd1234` + `2026-08-19` → `rd_scratch_abcd1234_20260819`. */
export const scratchRoomDayIdFor = (scratchRoomId: string, istDate: string): string => {
  const bare = scratchRoomId.startsWith(SCRATCH_ROOM_PREFIX) ? scratchRoomId.slice(SCRATCH_ROOM_PREFIX.length) : suffixOf(scratchRoomId);
  return `${SCRATCH_ROOM_DAY_PREFIX}${bare}_${istDate.replace(/-/g, "")}`;
};

// ---------------------------------------------------------------------------
// SQL (inferred — listed verbatim in the report)
//
// The two `room` statements go through lib/db's tagged template (that handle takes no
// text+params form), so the constants below are not passed anywhere — they are the exact
// statements the templates issue, named so the report and the tests can quote them.
// The two `room_day` statements ARE the text passed to the brain pool.
// ---------------------------------------------------------------------------

export const SQL_SCRATCH_ROOM_SELECT = "SELECT id, slug, name, disabled_at FROM room WHERE id = $1 LIMIT 1";

/**
 * Create the scratch room. ON CONFLICT (id) DO NOTHING makes a second run a no-op; the
 * caller re-selects either way, so a race that loses still returns the row.
 */
export const SQL_SCRATCH_ROOM_INSERT =
  "INSERT INTO room (id, slug, name, pin_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING";

export const SQL_SCRATCH_ROOM_DAY_SELECT =
  "SELECT id, room_id, ist_date::text AS ist_date, scratch FROM room_day WHERE room_id = $1 AND ist_date = $2::date";

/**
 * Create the scratch day. The no-op DO UPDATE makes RETURNING fire on the conflict path too,
 * the same trick SQL_ROOM_DAY_UPSERT uses — but this one does NOT touch `scratch` on conflict.
 * That is the safe direction and it is deliberate: an existing day is returned exactly as it
 * is, so if one were ever somehow live, the write guard sees scratch = false and refuses.
 * Nothing here can turn a live day into a scratch one.
 */
export const SQL_SCRATCH_ROOM_DAY_UPSERT =
  "INSERT INTO room_day (id, room_id, ist_date, scratch) VALUES ($1, $2, $3::date, true) " +
  "ON CONFLICT (room_id, ist_date) DO UPDATE SET room_id = EXCLUDED.room_id " +
  "RETURNING id, room_id, ist_date::text AS ist_date, scratch";

// ---------------------------------------------------------------------------
// Find-or-create
// ---------------------------------------------------------------------------

export type ScratchRoom = { id: string; slug: string; name: string; created: boolean };
export type ScratchRoomDay = { id: string; room_id: string; ist_date: string; scratch: boolean; created: boolean };

export type ScratchResolution =
  | { ok: true; room: ScratchRoom; day: ScratchRoomDay }
  | { ok: false; error: string; detail?: string };

type RoomRow = { id: string; slug: string; name: string; disabled_at: string | Date | null };

/**
 * Find-or-create the scratch room for a real room. Safe to run twice: the id is derived, so
 * the second run selects the row the first one made.
 *
 * VISIBILITY: the row is created ENABLED (disabled_at NULL) because POST /api/brain/cues
 * checks roomExists(room_id), and that check requires disabled_at IS NULL. That makes the
 * scratch room visible wherever the `room` table is listed. No listing is changed here —
 * every place that reads `room` is reported for the orchestrator to judge.
 */
export async function resolveScratchRoom(room: { id: string; slug: string; name: string }): Promise<{ ok: true; room: ScratchRoom } | { ok: false; error: string; detail?: string }> {
  const id = scratchRoomIdFor(room.id);
  const slug = scratchSlugFor(room.slug);
  const name = scratchNameFor(room.name);
  try {
    const found = (await sql`SELECT id, slug, name, disabled_at FROM room WHERE id = ${id} LIMIT 1`) as RoomRow[];
    if (found[0]) return { ok: true, room: { id: found[0].id, slug: found[0].slug, name: found[0].name, created: false } };

    await sql`
      INSERT INTO room (id, slug, name, pin_hash)
      VALUES (${id}, ${slug}, ${name}, ${SCRATCH_PIN_HASH})
      ON CONFLICT (id) DO NOTHING
    `;

    // Re-select rather than trust the insert: a lost race, or a slug already taken by some
    // other row, both land here and both are answered from what is actually in the table.
    const after = (await sql`SELECT id, slug, name, disabled_at FROM room WHERE id = ${id} LIMIT 1`) as RoomRow[];
    if (after[0]) return { ok: true, room: { id: after[0].id, slug: after[0].slug, name: after[0].name, created: true } };
    return { ok: false, error: "scratch_room_unavailable" };
  } catch (e) {
    return { ok: false, error: "scratch_room_unavailable", detail: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

type ScratchDayRow = { id: string; room_id: string; ist_date: string; scratch: boolean };

/**
 * Find-or-create the scratch room_day for (scratch room, IST date). The date is the session's
 * own IST date, never the server clock. Safe to run twice.
 */
export async function resolveScratchRoomDay(scratchRoomId: string, istDate: string): Promise<{ ok: true; day: ScratchRoomDay } | { ok: false; error: string; detail?: string }> {
  try {
    const found = await query<ScratchDayRow>(SQL_SCRATCH_ROOM_DAY_SELECT, [scratchRoomId, istDate]);
    const existing = found.rows[0];
    if (existing) return { ok: true, day: { ...existing, scratch: existing.scratch === true, created: false } };

    const made = await query<ScratchDayRow>(SQL_SCRATCH_ROOM_DAY_UPSERT, [scratchRoomDayIdFor(scratchRoomId, istDate), scratchRoomId, istDate]);
    const row = made.rows[0];
    if (!row) return { ok: false, error: "scratch_day_unavailable" };
    return { ok: true, day: { ...row, scratch: row.scratch === true, created: true } };
  } catch (e) {
    return { ok: false, error: "scratch_day_unavailable", detail: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

/** Both halves, in order: the scratch room, then its day for that IST date. */
export async function resolveScratchGraph(room: { id: string; slug: string; name: string }, istDate: string): Promise<ScratchResolution> {
  const r = await resolveScratchRoom(room);
  if (!r.ok) return r;
  const d = await resolveScratchRoomDay(r.room.id, istDate);
  if (!d.ok) return d;
  return { ok: true, room: r.room, day: d.day };
}
