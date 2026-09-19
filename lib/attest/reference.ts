/**
 * lib/attest/reference.ts — the read side: a snapshot of what the loader validates against.
 *
 * READS ONLY. Every statement below is a SELECT, and the loader's dry-run test asserts that no other
 * kind of statement is ever issued. Written for the Neon HTTP driver: plain tagged templates, no
 * sql.unsafe(), no interactive transaction; bigints arrive as STRINGS (Number() them), timestamps as
 * ISO strings, and clinician.status is an enum (cast to text). Each column was checked against the
 * LIVE database's information_schema on 19 Sep 2026, not against a migration file:
 *   room(id,name,slug)  clinician(id,full_name,email citext,status doctor_status,deleted_at)
 *   bench_window(id,session_id,room_day_id NULLABLE,start_ms int8,end_ms int8)  bench_session(id,room_id)
 *   room_day(id,room_id,ist_date date,scratch)  room_diarize_window(window_id,room_day_id,state)
 *   visit(clinician_id,clinician_source,session_id,tape_start_ms,tape_end_ms)
 *   cue(type,room_day_id,at timestamptz,payload jsonb)
 * The injected `sql` makes this testable against a real Postgres without mocking a module.
 */
import type { ClinicianRef, ExistingAttestation, Reference, RoomDayRef, RoomRef, WindowRef } from "./validate";

export type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

const num = (v: unknown): number => Number(v);

/** `fromMs`/`toMs` bound the WINDOWS read (epoch ms); everything else is small and read whole. */
export async function loadReference(sql: SqlFn, range: { fromMs: number; toMs: number }): Promise<Reference> {
  const rooms = (await sql`SELECT id, name, slug FROM room`) as RoomRef[];

  const clinicians = ((await sql`
    SELECT id, full_name, email::text AS email, status::text AS status, (deleted_at IS NOT NULL) AS deleted FROM clinician
  `) as Array<{ id: string; full_name: string; email: string; status: string; deleted: boolean }>).map<ClinicianRef>((c) => ({
    id: c.id, full_name: c.full_name, email: c.email, status: c.status, deleted: c.deleted === true,
  }));

  const windows = ((await sql`
    SELECT w.id, b.room_id, w.room_day_id, w.start_ms, w.end_ms, (d.window_id IS NOT NULL) AS diarized
      FROM bench_window w
      JOIN bench_session b ON b.id = w.session_id
      LEFT JOIN room_diarize_window d ON d.window_id = w.id AND d.state = 'ok'
     WHERE w.end_ms > ${range.fromMs}::bigint AND w.start_ms < ${range.toMs}::bigint
  `) as Array<{ id: string; room_id: string; room_day_id: string | null; start_ms: string | number; end_ms: string | number; diarized: boolean }>).map<WindowRef>((w) => ({
    id: w.id, room_id: w.room_id, room_day_id: w.room_day_id, start_ms: num(w.start_ms), end_ms: num(w.end_ms), diarized: w.diarized === true,
  }));

  const roomDays = (await sql`
    SELECT id, room_id, ist_date::text AS ist_date, scratch FROM room_day
  `) as RoomDayRef[];

  const diarized = (await sql`
    SELECT DISTINCT d.room_day_id AS id
      FROM room_diarize_window d JOIN room_day rd ON rd.id = d.room_day_id
     WHERE d.state = 'ok' AND NOT rd.scratch
  `) as Array<{ id: string }>;

  // What a human has already attested through the existing door. A visit is only placeable in time if it
  // has a tape span and a session (and therefore a room); one without cannot conflict with anything.
  const visits = (await sql`
    SELECT v.clinician_id, b.room_id, v.tape_start_ms, v.tape_end_ms
      FROM visit v JOIN bench_session b ON b.id = v.session_id
     WHERE v.clinician_id IS NOT NULL AND v.clinician_source = 'operator'
       AND v.tape_start_ms IS NOT NULL AND v.tape_end_ms IS NOT NULL
  `) as Array<{ clinician_id: string; room_id: string; tape_start_ms: string | number; tape_end_ms: string | number }>;
  const pins = (await sql`
    SELECT c.payload->>'clinician_id' AS clinician_id, rd.room_id, floor(extract(epoch FROM c.at) * 1000)::bigint AS at_ms
      FROM cue c JOIN room_day rd ON rd.id = c.room_day_id
     WHERE c.type = 'operator_pin' AND c.payload->>'clinician_id' IS NOT NULL
  `) as Array<{ clinician_id: string; room_id: string; at_ms: string | number }>;

  const existing: ExistingAttestation[] = [
    ...visits.map<ExistingAttestation>((v) => ({ kind: "visit", clinician_id: v.clinician_id, room_id: v.room_id, start_ms: num(v.tape_start_ms), end_ms: num(v.tape_end_ms) })),
    ...pins.map<ExistingAttestation>((p) => ({ kind: "operator_pin", clinician_id: p.clinician_id, room_id: p.room_id, start_ms: num(p.at_ms), end_ms: num(p.at_ms) })),
  ];

  return {
    rooms, clinicians, windows, roomDays, existing,
    diarizedRoomDayIds: new Set(diarized.map((d) => d.id)),
  };
}

/**
 * The size of the human task, from the data alone. PURE over a Reference loaded with a range wide enough
 * to hold every window. It states what the data can say and refuses to guess who was where: nothing we
 * hold links ANY clinician to a room-day, so the work cannot be narrowed below "every diarized room-day".
 */
export function workloadFrom(ref: Reference) {
  const days = ref.roomDays.filter((d) => ref.diarizedRoomDayIds.has(d.id));
  const dw = (id: string) => ref.windows.filter((w) => w.room_day_id === id && w.diarized);
  const covered = (id: string) => {
    const wins = dw(id);
    const day = days.find((d) => d.id === id)!;
    return ref.existing.some((e) => e.room_id === day.room_id && wins.some((w) => (e.start_ms === e.end_ms ? w.start_ms <= e.start_ms && e.start_ms < w.end_ms : e.start_ms < w.end_ms && w.start_ms < e.end_ms)));
  };
  return {
    diarized_room_days: days.length,
    distinct_rooms: new Set(days.map((d) => d.room_id)).size,
    distinct_dates: new Set(days.map((d) => d.ist_date)).size,
    diarized_windows: days.reduce((n, d) => n + dw(d.id).length, 0),
    already_attested_over_diarized_audio: days.filter((d) => covered(d.id)).length,
  };
}
