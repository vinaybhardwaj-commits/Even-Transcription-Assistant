/**
 * lib/room-auth.ts — Room Bench session auth (Room-Bench PRD D5 / §9.3).
 *
 * Rooms are a separate class of object from clinicians: their JWT reuses the
 * doctor signing secret (JWT_SECRET_DOCTOR, HS256) but carries a distinct
 * audience claim `aud:"room"`, so room and doctor sessions are mutually
 * invalid — verifyDoctorJwt rejects room tokens (audience mismatch) and
 * verifyRoomJwt rejects doctor tokens. Cookie: eta_room_session, HttpOnly,
 * Path=/ (must reach both /room/{slug} and /api/bench/*).
 *
 * Lockout mirrors the clinician policy in lib/lockout.ts (same thresholds:
 * 5→15m, 10→1h, 20→24h, 30→disabled until admin re-enable) but operates on
 * the `room` table's failed_attempts / locked_until / disabled_at columns.
 * lib/lockout.ts itself is clinician-bound (writes clinician + pin_attempt
 * rows), so its functions are not reusable here; the thresholds are not
 * forked, only re-applied.
 */

import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { sql } from "@/lib/db";

export const ROOM_COOKIE = "eta_room_session";
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches doctor/admin

export type RoomClaims = JWTPayload & {
  room_id: string;
  slug: string;
  aud: "room";
};

function roomSecret(): Uint8Array {
  const env = process.env.JWT_SECRET_DOCTOR;
  if (!env) throw new Error("JWT_SECRET_DOCTOR not configured");
  return new TextEncoder().encode(env);
}

/**
 * Sign a room session.
 *
 * THE TTL IS A PARAMETER, AND ITS DEFAULT IS UNCHANGED (Install and Fleet PRD D10). A human
 * signing in with the room PIN still gets 30 days — every existing caller passes no options and
 * is therefore untouched. Only the app install path asks for 365 days, and it asks explicitly.
 *
 * WHY THE TWO DIFFER AT ALL. A 30-day session on a native install kills all four rooms silently
 * one month after install, with no browser open to notice the 401 and no person in the room to
 * sign in again. A 365-day session on a human PIN login would be a credential left in a shared
 * clinic browser for a year. Same secret, same audience, two lifetimes, because the two things
 * holding them fail in opposite directions.
 */
export async function signRoomJwt(
  claims: {
    room_id: string;
    slug: string;
  },
  opts?: { ttlSeconds?: number },
): Promise<string> {
  const ttl =
    opts?.ttlSeconds && Number.isFinite(opts.ttlSeconds) && opts.ttlSeconds > 0
      ? Math.floor(opts.ttlSeconds)
      : TTL_SECONDS;
  return new SignJWT({ room_id: claims.room_id, slug: claims.slug })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience("room")
    .setExpirationTime(`${ttl}s`)
    .sign(roomSecret());
}

export async function verifyRoomJwt(token: string): Promise<RoomClaims> {
  const { payload } = await jwtVerify(token, roomSecret(), {
    audience: "room",
  });
  return payload as RoomClaims;
}

export async function setRoomCookie(jwt: string): Promise<void> {
  const c = await cookies();
  c.set(ROOM_COOKIE, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function clearRoomCookie(): Promise<void> {
  const c = await cookies();
  c.set(ROOM_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

export async function readRoomCookie(): Promise<string | null> {
  const c = await cookies();
  return c.get(ROOM_COOKIE)?.value ?? null;
}

/**
 * Convenience guard for room-cookie-gated bench routes.
 * Returns claims or null — callers respond AUTH_REQUIRED/AUTH_EXPIRED.
 */
export async function readRoomClaims(): Promise<RoomClaims | null> {
  const token = await readRoomCookie();
  if (!token) return null;
  try {
    return await verifyRoomJwt(token);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lockout (mirrors lib/lockout.ts thresholds, applied to the room table)
// ---------------------------------------------------------------------------

export type RoomLockState = {
  id: string;
  slug: string;
  failed_attempts: number;
  locked_until: Date | string | null;
  disabled_at: Date | string | null;
};

export type RoomLockoutDecision =
  | { kind: "ok" }
  | { kind: "locked"; retry_after_seconds: number; reason: string }
  | { kind: "disabled" };

export function roomPreAttemptCheck(room: RoomLockState): RoomLockoutDecision {
  if (room.disabled_at) return { kind: "disabled" };
  const lockedUntil = room.locked_until ? new Date(room.locked_until) : null;
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    const sec = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
    return {
      kind: "locked",
      retry_after_seconds: sec,
      reason: `Room locked. Try again in ${Math.ceil(sec / 60)} min.`,
    };
  }
  return { kind: "ok" };
}

/**
 * Record a failed room PIN attempt. Same escalation as clinician PINs:
 * 5 → 15 min, 10 → 1 h, 20 → 24 h, 30 → disabled until admin re-enable
 * (rooms have no status column; disabled_at is the analog).
 * Soft-fail: a DB error here never throws — the attempt simply falls
 * through to PIN_INVALID.
 */
export async function roomRecordFailedAttempt(
  room: RoomLockState,
): Promise<RoomLockoutDecision> {
  const newCount = room.failed_attempts + 1;
  let lockedUntilSec: number | null = null;
  let disable = false;

  if (newCount >= 30) {
    disable = true;
  } else if (newCount >= 20) {
    lockedUntilSec = 60 * 60 * 24;
  } else if (newCount >= 10) {
    lockedUntilSec = 60 * 60;
  } else if (newCount >= 5) {
    lockedUntilSec = 60 * 15;
  }

  try {
    if (disable) {
      await sql`
        UPDATE room
           SET failed_attempts = ${newCount},
               locked_until = NULL,
               disabled_at = NOW()
         WHERE id = ${room.id}
      `;
    } else if (lockedUntilSec) {
      await sql`
        UPDATE room
           SET failed_attempts = ${newCount},
               locked_until = NOW() + (${lockedUntilSec}::int * INTERVAL '1 second')
         WHERE id = ${room.id}
      `;
    } else {
      await sql`
        UPDATE room
           SET failed_attempts = ${newCount},
               locked_until = NULL
         WHERE id = ${room.id}
      `;
    }
  } catch (e) {
    console.warn("[room-auth] failed-attempt UPDATE failed:", e);
  }

  if (disable) return { kind: "disabled" };
  if (lockedUntilSec)
    return {
      kind: "locked",
      retry_after_seconds: lockedUntilSec,
      reason: `Too many incorrect attempts. Try again in ${Math.ceil(lockedUntilSec / 60)} min.`,
    };
  return { kind: "ok" };
}

export async function roomRecordSuccessfulAttempt(roomId: string): Promise<void> {
  try {
    await sql`
      UPDATE room
         SET failed_attempts = 0,
             locked_until = NULL
       WHERE id = ${roomId}
    `;
  } catch (e) {
    console.warn("[room-auth] attempt reset failed (ignoring):", e);
  }
}
