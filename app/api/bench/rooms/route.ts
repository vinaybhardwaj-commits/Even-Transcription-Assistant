/**
 * /api/bench/rooms — Room management (Room-Bench PRD §3.4/§3.5; D5 revised:
 * rooms live on the admin Bench page, never on Clinicians).
 *
 * GET   — list rooms + last-session info (admin)
 * POST  — create room: { name, pin? } → slug + PIN shown once (admin)
 * PATCH — { room_id, action: "reset_pin" | "disable" | "enable" | "rename" } (admin)
 *
 * All queries INFERRED (no live DB in the build sandbox — see report);
 * fail-safe: list errors degrade to an empty list.
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { randomInt } from "crypto";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { SCRATCH_ROOM_PREFIX } from "@/lib/brain/scratch";
import { benchAdminGuard, buildRoomSlug, newRoomId } from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

type RoomListRow = {
  id: string;
  slug: string;
  name: string;
  created_at: string | Date;
  disabled_at: string | Date | null;
  last_session_at: string | Date | null;
  last_session_status: string | null;
};

export async function GET() {
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);

  try {
    // Scratch rooms (fuse slice 2) never appear on the admin Bench page — they are the
    // replay's write target, not a room anyone books or logs in to. `_` is a single-character
    // wildcard in LIKE, so the prefix is matched with left()/length() instead of a pattern.
    // Only this listing is filtered; the POST/PATCH paths below are untouched.
    const rows = (await sql`
      SELECT r.id, r.slug, r.name, r.created_at, r.disabled_at,
             ls.started_at AS last_session_at, ls.status AS last_session_status
        FROM room r
        LEFT JOIN LATERAL (
          SELECT started_at, status
            FROM bench_session
           WHERE room_id = r.id
           ORDER BY started_at DESC
           LIMIT 1
        ) ls ON true
       WHERE left(r.id, length(${SCRATCH_ROOM_PREFIX}::text)) <> ${SCRATCH_ROOM_PREFIX}::text
       ORDER BY r.created_at
    `) as RoomListRow[];
    return respondOk({
      rooms: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        created_at: new Date(r.created_at).toISOString(),
        disabled: r.disabled_at !== null,
        last_session_at: r.last_session_at ? new Date(r.last_session_at).toISOString() : null,
        last_session_status: r.last_session_status,
      })),
    });
  } catch {
    // Fail-safe: table may not exist before migration 0041 runs.
    return respondOk({ rooms: [] });
  }
}

export async function POST(req: NextRequest) {
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { name?: string; pin?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const name = (body.name ?? "").trim();
  if (name.length < 2) return respondError("VALIDATION_FAILED", "room_name_required");
  const pin = body.pin && /^[0-9]{4}$/.test(body.pin) ? body.pin : generatePin();

  const built = buildRoomSlug(name);
  const pinHash = await bcrypt.hash(pin, 12); // same cost as doctor PINs
  const id = newRoomId();

  try {
    await sql`
      INSERT INTO room (id, slug, name, pin_hash)
      VALUES (${id}, ${built.full}, ${name}, ${pinHash})
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) {
      return respondError("VALIDATION_FAILED", "room_slug_already_exists");
    }
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  return respondOk({
    room: { id, name, slug: built.full },
    pin_plaintext: pin, // shown once, never persisted in plaintext
    login_url: `/room/${built.full}`,
  });
}

export async function PATCH(req: NextRequest) {
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { room_id?: string; action?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const roomId = String(body.room_id ?? "");
  const action = String(body.action ?? "");
  if (!roomId.startsWith("room_")) {
    return respondError("VALIDATION_FAILED", "bad_room_id");
  }

  if (action === "reset_pin") {
    const pin = generatePin();
    const pinHash = await bcrypt.hash(pin, 12);
    try {
      await sql`
        UPDATE room
           SET pin_hash = ${pinHash},
               failed_attempts = 0,
               locked_until = NULL
         WHERE id = ${roomId}
      `;
    } catch (e) {
      return respondError("PIPELINE_FAILED", String(e).slice(0, 150));
    }
    return respondOk({ ok: true, pin_plaintext: pin });
  }

  if (action === "disable") {
    try {
      await sql`UPDATE room SET disabled_at = NOW() WHERE id = ${roomId}`;
    } catch (e) {
      return respondError("PIPELINE_FAILED", String(e).slice(0, 150));
    }
    return respondOk({ ok: true });
  }

  if (action === "enable") {
    try {
      await sql`
        UPDATE room
           SET disabled_at = NULL,
               failed_attempts = 0,
               locked_until = NULL
         WHERE id = ${roomId}
      `;
    } catch (e) {
      return respondError("PIPELINE_FAILED", String(e).slice(0, 150));
    }
    return respondOk({ ok: true });
  }

  if (action === "rename") {
    // WHY THIS IS SAFE, so no guard is added that it does not need: the login URL is built from
    // `slug` (/room/opd-7-y74w), never from `name`, so no PIN changes and nobody re-logs-in. The
    // scratch graph derives from room.id. Historical sessions reference room_id. The only
    // consequence of a rename is that resolveRoom BY EXACT NAME now needs the new name.
    const name = String((body as { name?: string }).name ?? "").trim();
    if (name.length < 2) return respondError("VALIDATION_FAILED", "room_name_required");
    if (name.length > 64) return respondError("VALIDATION_FAILED", "room_name_too_long");

    try {
      // room.name has NO unique constraint, and two rooms sharing one makes resolveRoom
      // ambiguous. That degrades safely through AmbiguousRoomError, but there is no reason to
      // create the ambiguity deliberately — so it is refused BY NAME, case-insensitively, and
      // only against rooms that are still in play. A disabled room may keep its old name.
      const clash = (await sql`
        SELECT id FROM room
         WHERE lower(name) = lower(${name})
           AND id <> ${roomId}
           AND disabled_at IS NULL
         LIMIT 1
      `) as Array<{ id: string }>;
      if (clash.length > 0) return respondError("VALIDATION_FAILED", "room_name_already_exists");

      // The whole write. NOTHING else: not slug, not pin_hash, not disabled_at, not
      // failed_attempts, not locked_until. A rename is a label change and must stay one.
      const updated = (await sql`
        UPDATE room SET name = ${name} WHERE id = ${roomId}
        RETURNING id, slug, name
      `) as Array<{ id: string; slug: string; name: string }>;
      const row = updated[0];
      if (!row) return respondError("VALIDATION_FAILED", "unknown_room");
      return respondOk({ ok: true, room: { id: row.id, slug: row.slug, name: row.name } });
    } catch (e) {
      return respondError("PIPELINE_FAILED", String(e).slice(0, 150));
    }
  }

  return respondError("VALIDATION_FAILED", "unknown_action");
}
