/**
 * lib/attestation.ts — a clinician said, with their PIN, that they were in this room.
 *
 * ATTESTED IS NOT INFERRED. `room_day.doctor_id` is NULL on all 102 room-days in production, so
 * every binding downstream today is a voice match with nothing to check it against. A row here is
 * the other kind of fact: a PIN was presented in a room at a time and the server verified it. The
 * `method` column exists so no future inferred binding can be written into this table and read back
 * as attested — readers filter on `method = 'pin'`, not on the table's name.
 *
 * ─── HOW A SITTING ENDS, AND WHY ────────────────────────────────────────────────────────────────
 * Chosen: THE RECORDING SESSION'S END, with a hard cap as the backstop and no explicit end call.
 *
 * The three candidates were an explicit end call, the session close, and a timeout. The explicit
 * call loses: it is the one an app can fail to make — a crash, a flat battery, a clinician who
 * walks out — and every attestation it fails to close silently claims the rest of the day, which is
 * the exact failure this slice exists to prevent. The session close is the right primary because a
 * sitting IS bounded by the recording: when the tape stops, nobody is being recorded under that
 * attestation whatever the app does next. The timeout is kept as a backstop, because a session that
 * never closes (the reaper's own 30-minute stall case) would otherwise inherit the same defect.
 *
 * SO THE END IS ALWAYS PRESENT AND ONLY EVER NARROWS. `expires_at` is NOT NULL and written at
 * insert as `started_at + ATTEST_MAX_SITTING_MS`. The EFFECTIVE end is the earliest of
 * `expires_at`, an `ended_at` if one was ever written, and the session's own `ended_at` — resolved
 * on read (`resolveAttestationEnd`), so a closing session shortens every attestation that names it
 * with no hook, no cron and no chance of drift between the two tables.
 *
 * NO PIN VALUE EVER REACHES THIS FILE. It records THAT one was presented.
 */
import { sql } from "@/lib/db";

/** The backstop. Four hours: longer than any observed clinic sitting, shorter than a working day. */
export const ATTEST_MAX_SITTING_MS = 4 * 60 * 60 * 1000;

/** Every refusal is NAMED. None of them is a silent pass, and none of them writes a row. */
export type AttestRefusal =
  | "unknown_room"
  | "room_not_recording"
  | "clinician_attested_elsewhere"
  | "overlapping_sitting";

export type AttestOutcome =
  | { ok: true; attestation_id: string; started_at: string; expires_at: string; replayed: boolean }
  | { ok: false; refusal: AttestRefusal; detail?: string };

export type RoomRow = { id: string; disabled_at: string | null };

const iso = (d: Date) => d.toISOString();

/**
 * PURE. The end a reader should honour: the earliest end anyone has claimed.
 *
 * Nulls are "no opinion", never "no end" — `expires_at` is the one that is always present, so the
 * result is always a real instant. An attestation can therefore never outlive its cap, and a
 * session that closed at noon retires the sitting at noon even though the row still says 4 p.m.
 */
export function resolveAttestationEnd(input: {
  expires_at: string;
  ended_at?: string | null;
  session_ended_at?: string | null;
}): string {
  const candidates = [input.expires_at, input.ended_at, input.session_ended_at]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => new Date(v).getTime())
    .filter((t) => Number.isFinite(t));
  return iso(new Date(Math.min(...candidates)));
}

/** PURE. Do two half-open intervals overlap? Touching ends do not: one sitting may follow another. */
export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime()
    && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

/**
 * Record one verified sitting, or refuse it by name.
 *
 * The PIN has ALREADY been verified by the caller (lib/clinician-pin.ts); this function never sees
 * one. Everything here is about whether the binding itself is admissible.
 */
export async function recordAttestation(input: {
  roomId: string;
  clinicianId: string;
  sessionId: string | null;
  startedAt: string;
}): Promise<AttestOutcome> {
  const startedAt = new Date(input.startedAt);
  if (!Number.isFinite(startedAt.getTime())) {
    return { ok: false, refusal: "overlapping_sitting", detail: "unparseable start" };
  }
  const expiresAt = new Date(startedAt.getTime() + ATTEST_MAX_SITTING_MS);

  // A REPLAYED REQUEST IS NOT A SECOND SITTING. The recorder retries; the unique index on
  // (room_id, session_id) WHERE ended_at IS NULL is the authority, and this read is what lets the
  // answer be the original row rather than a refusal the app cannot act on.
  if (input.sessionId) {
    const existing = (await sql`
      SELECT id, clinician_id, started_at, expires_at
        FROM room_clinician_attestation
       WHERE room_id = ${input.roomId} AND session_id = ${input.sessionId} AND ended_at IS NULL
       LIMIT 1
    `) as Array<{ id: string; clinician_id: string; started_at: string; expires_at: string }>;
    const prior = existing[0];
    if (prior) {
      if (prior.clinician_id !== input.clinicianId) {
        return { ok: false, refusal: "overlapping_sitting", detail: "session already attested by another clinician" };
      }
      return {
        ok: true, attestation_id: prior.id, started_at: prior.started_at,
        expires_at: prior.expires_at, replayed: true,
      };
    }
  }

  // THE SAME CLINICIAN CANNOT BE IN TWO ROOMS AT ONCE. Checked before the room's own overlap so the
  // answer names the more serious contradiction when both are true.
  const elsewhere = (await sql`
    SELECT 1
      FROM room_clinician_attestation
     WHERE clinician_id = ${input.clinicianId}
       AND room_id <> ${input.roomId}
       AND ended_at IS NULL
       AND started_at < ${iso(expiresAt)}::timestamptz
       AND expires_at > ${iso(startedAt)}::timestamptz
     LIMIT 1
  `) as Array<{ "?column?": number }>;
  if (elsewhere.length > 0) return { ok: false, refusal: "clinician_attested_elsewhere" };

  // AND ONE ROOM CANNOT HOLD TWO OVERLAPPING SITTINGS, whoever they belong to.
  const sameRoom = (await sql`
    SELECT 1
      FROM room_clinician_attestation
     WHERE room_id = ${input.roomId}
       AND ended_at IS NULL
       AND started_at < ${iso(expiresAt)}::timestamptz
       AND expires_at > ${iso(startedAt)}::timestamptz
     LIMIT 1
  `) as Array<{ "?column?": number }>;
  if (sameRoom.length > 0) return { ok: false, refusal: "overlapping_sitting" };

  const id = `att_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  const inserted = (await sql`
    INSERT INTO room_clinician_attestation
      (id, room_id, clinician_id, session_id, started_at, expires_at, method, pin_presented)
    VALUES
      (${id}, ${input.roomId}, ${input.clinicianId}, ${input.sessionId},
       ${iso(startedAt)}::timestamptz, ${iso(expiresAt)}::timestamptz, 'pin', TRUE)
    ON CONFLICT DO NOTHING
    RETURNING id, started_at, expires_at
  `) as Array<{ id: string; started_at: string; expires_at: string }>;

  // The unique index caught a race the reads above could not: another request inserted between
  // them. That is a replay, not a new sitting, and it is answered as one.
  if (inserted.length === 0) {
    const raced = (await sql`
      SELECT id, clinician_id, started_at, expires_at
        FROM room_clinician_attestation
       WHERE room_id = ${input.roomId} AND session_id = ${input.sessionId} AND ended_at IS NULL
       LIMIT 1
    `) as Array<{ id: string; clinician_id: string; started_at: string; expires_at: string }>;
    const prior = raced[0];
    if (prior && prior.clinician_id === input.clinicianId) {
      return { ok: true, attestation_id: prior.id, started_at: prior.started_at, expires_at: prior.expires_at, replayed: true };
    }
    return { ok: false, refusal: "overlapping_sitting", detail: "lost an insert race" };
  }

  const row = inserted[0]!;
  return { ok: true, attestation_id: row.id, started_at: row.started_at, expires_at: row.expires_at, replayed: false };
}

/** The room, and whether a tape is actually running in it right now. */
export async function loadRoomForAttestation(roomSlugOrId: string): Promise<
  { room: RoomRow; recordingSessionId: string | null } | null
> {
  const rooms = (await sql`
    SELECT id, disabled_at
      FROM room
     WHERE id = ${roomSlugOrId} OR slug = ${roomSlugOrId}
     LIMIT 1
  `) as RoomRow[];
  const room = rooms[0];
  if (!room) return null;
  const sessions = (await sql`
    SELECT id FROM bench_session
     WHERE room_id = ${room.id} AND status = 'recording'
     ORDER BY started_at DESC
     LIMIT 1
  `) as Array<{ id: string }>;
  return { room, recordingSessionId: sessions[0]?.id ?? null };
}
