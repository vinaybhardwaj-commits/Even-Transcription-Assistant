/**
 * lib/attest/validate.ts — REFUSE, DO NOT WARN.
 *
 * A wrong attestation is worse than none. Speaker re-enrolment takes "clinician X was in room R
 * during this block" and trains X's voiceprint on whoever spoke in R's audio then; a wrong row
 * enrols one doctor's voice onto another doctor's print, and nothing downstream can tell. So every
 * check below is a REFUSAL that names the row, the load is ALL-OR-NOTHING (one refusal anywhere
 * means nothing is accepted), and there is no "warning" tier to be scrolled past.
 *
 * PURE: takes the parsed rows and a `Reference` snapshot of the database, returns a verdict.
 *
 * What is refused, per row: an unknown or ambiguous room; an unknown or ambiguous clinician; a
 * deleted or non-active clinician; a room-day that does not exist; a block with no recorded
 * window under it. Across rows: an exact duplicate; two blocks overlapping in one room; one
 * clinician in two rooms at once. Against what is already attested: a block that contradicts an
 * existing attestation (a different clinician in the same room at the same time, or the same
 * clinician in another room at the same time).
 *
 * WHAT IS DELIBERATELY NOT REFUSED: adjacent blocks (one ends when the next starts) in one room.
 *
 * THIS MODULE NEVER READS VOICEPRINT DATA. Whether an attested clinician holds a print is a question for
 * re-enrolment, which already is a classified voiceprint reader; an attestation loader needs no such
 * access, and the repo's voiceprint-reader sweep (tests/unit/c2-e2e-runner.test.ts) is left untouched.
 */
import { blockBoundsMs, type Refusal, type RefusalReason, type SheetRow } from "./sheet";

export type RoomRef = { id: string; name: string; slug: string };
export type ClinicianRef = { id: string; full_name: string; email: string; status: string; deleted: boolean };
export type WindowRef = { id: string; room_id: string; room_day_id: string | null; start_ms: number; end_ms: number; diarized: boolean };
export type RoomDayRef = { id: string; room_id: string; ist_date: string; scratch: boolean };
/** An attestation a human already made through the existing door. An instant has start_ms === end_ms. */
export type ExistingAttestation = { kind: "visit" | "operator_pin"; clinician_id: string; room_id: string; start_ms: number; end_ms: number };

export type Reference = {
  rooms: RoomRef[];
  clinicians: ClinicianRef[];
  windows: WindowRef[];
  roomDays: RoomDayRef[];
  existing: ExistingAttestation[];
  /** Non-scratch room-days with at least one diarized (state ok) window: the audio the prints are scored on. */
  diarizedRoomDayIds: Set<string>;
};

/**
 * WHAT WOULD BE HANDED TO A WRITER. `basis: "attested"` is a literal, not a variable: a record that
 * came from a human's sheet can only ever say so, and it is the value that must stay distinguishable
 * from every inferred binding (voice match, roster, login) for as long as the row lives.
 */
export type AttestationRecord = {
  basis: "attested";
  room_id: string;
  room_day_id: string;
  clinician_id: string;
  block_start_ms: number;
  block_end_ms: number;
  windows_under_block: number;
  diarized_windows_under_block: number;
  source_row: number;
};

export type ValidationCounts = {
  rows_read: number;
  rows_clean: number;
  refusals: number;
  by_reason: Record<string, number>;
  rooms: number;
  clinicians: number;
  room_days: number;
  windows_under_blocks: number;
  diarized_windows_under_blocks: number;
  diarized_room_days_covered: number;
  diarized_room_days_total: number;
};

export type ValidationResult = {
  /** True only when there is not one refusal of any kind, in the sheet or across it. */
  ok: boolean;
  refusals: Refusal[];
  /** Records for rows that are individually clean. Written ONLY if ok. */
  records: AttestationRecord[];
  counts: ValidationCounts;
};

/** Lowercase, NFC, every dash variant to "-", whitespace collapsed. Applied to BOTH sides of a match. */
export function normalizeName(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
}

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
/** A block against an existing attestation, which may be an instant (start === end). */
const touches = (blockS: number, blockE: number, a: ExistingAttestation) =>
  a.start_ms === a.end_ms ? blockS <= a.start_ms && a.start_ms < blockE : overlaps(blockS, blockE, a.start_ms, a.end_ms);

type Resolved = {
  row: number;
  key: string;
  roomId: string;
  roomDayId: string;
  clinicianId: string;
  startMs: number;
  endMs: number;
  windowIds: string[];
  diarizedWindowIds: string[];
};

export function validateAttestations(rows: SheetRow[], ref: Reference, priorRefusals: Refusal[] = []): ValidationResult {
  const refusals: Refusal[] = [...priorRefusals];
  const add = (row: number, reason: RefusalReason, detail?: string) => refusals.push({ row, reason, ...(detail ? { detail } : {}) });

  const scratchDays = new Set(ref.roomDays.filter((d) => d.scratch).map((d) => d.id));
  const roomsByName = new Map<string, RoomRef[]>();
  for (const r of ref.rooms) roomsByName.set(normalizeName(r.name), [...(roomsByName.get(normalizeName(r.name)) ?? []), r]);
  const clinByKey = new Map<string, ClinicianRef[]>();
  for (const c of ref.clinicians) {
    for (const k of new Set([normalizeName(c.full_name), normalizeName(c.email)])) clinByKey.set(k, [...(clinByKey.get(k) ?? []), c]);
  }

  // ---- 1. each row on its own, against the database -------------------------------------------------
  const resolved: Resolved[] = [];
  for (const r of rows) {
    const b = blockBoundsMs(r.date, r.start, r.end);
    if (b === null) { add(r.row, "end_not_after_start"); continue; } // unreachable after parseSheet; refuse rather than assume
    let bad = false;

    const roomHits = roomsByName.get(normalizeName(r.room)) ?? [];
    if (roomHits.length === 0) { add(r.row, "unknown_room"); bad = true; }
    else if (roomHits.length > 1) { add(r.row, "ambiguous_room", `${roomHits.length} rooms match`); bad = true; }

    const clinHits = [...new Map((clinByKey.get(normalizeName(r.clinician)) ?? []).map((c) => [c.id, c])).values()];
    if (clinHits.length === 0) { add(r.row, "unknown_clinician"); bad = true; }
    else if (clinHits.length > 1) { add(r.row, "ambiguous_clinician", `${clinHits.length} clinicians match`); bad = true; }
    else if (clinHits[0]!.deleted) { add(r.row, "clinician_deleted"); bad = true; }
    else if (clinHits[0]!.status !== "active") { add(r.row, "clinician_not_active", clinHits[0]!.status); bad = true; }
    if (bad) continue;

    const room = roomHits[0]!;
    const clin = clinHits[0]!;
    const under = ref.windows.filter(
      (w) => w.room_id === room.id && (w.room_day_id === null || !scratchDays.has(w.room_day_id)) && overlaps(b.startMs, b.endMs, w.start_ms, w.end_ms),
    );
    if (under.length === 0) { add(r.row, "no_window_under_block"); continue; }
    const day = ref.roomDays.find((d) => !d.scratch && d.room_id === room.id && d.ist_date === r.date);
    if (!day) { add(r.row, "no_room_day"); continue; }

    resolved.push({
      row: r.row, key: `${room.id}|${b.startMs}|${b.endMs}|${clin.id}`, roomId: room.id, roomDayId: day.id, clinicianId: clin.id,
      startMs: b.startMs, endMs: b.endMs, windowIds: under.map((w) => w.id), diarizedWindowIds: under.filter((w) => w.diarized).map((w) => w.id),
    });
  }

  // ---- 2. across rows -------------------------------------------------------------------------------
  // Duplicates first, and only the LATER copy is refused, so it is not also reported as an overlap.
  const seen = new Map<string, number>();
  const pool: Resolved[] = [];
  for (const x of resolved) {
    const first = seen.get(x.key);
    if (first !== undefined) add(x.row, "duplicate_row", `of row ${first}`);
    else { seen.set(x.key, x.row); pool.push(x); }
  }
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!;
      const b = pool[j]!;
      if (!overlaps(a.startMs, a.endMs, b.startMs, b.endMs)) continue;
      if (a.roomId === b.roomId) {
        add(a.row, "overlap_same_room", `with row ${b.row}`);
        add(b.row, "overlap_same_room", `with row ${a.row}`);
      } else if (a.clinicianId === b.clinicianId) {
        add(a.row, "clinician_in_two_rooms", `with row ${b.row}`);
        add(b.row, "clinician_in_two_rooms", `with row ${a.row}`);
      }
    }
  }

  // ---- 3. against what a human has already attested -------------------------------------------------
  for (const x of pool) {
    for (const e of ref.existing) {
      if (!touches(x.startMs, x.endMs, e)) continue;
      const sameRoom = e.room_id === x.roomId;
      const sameClin = e.clinician_id === x.clinicianId;
      // Agreement (same room, same clinician) is fine. Anything else at the same time is a contradiction.
      if (sameRoom && !sameClin) add(x.row, "conflicts_with_existing_attestation", `${e.kind}: a different clinician in this room`);
      else if (!sameRoom && sameClin) add(x.row, "conflicts_with_existing_attestation", `${e.kind}: this clinician in another room`);
    }
  }

  // ---- verdict -------------------------------------------------------------------------------------
  refusals.sort((a, b) => (a.row ?? -1) - (b.row ?? -1) || a.reason.localeCompare(b.reason) || (a.detail ?? "").localeCompare(b.detail ?? ""));
  const refusedRows = new Set(refusals.filter((r) => r.row !== null).map((r) => r.row as number));
  const clean = pool.filter((x) => !refusedRows.has(x.row));
  const records: AttestationRecord[] = clean.map((x) => ({
    basis: "attested", room_id: x.roomId, room_day_id: x.roomDayId, clinician_id: x.clinicianId,
    block_start_ms: x.startMs, block_end_ms: x.endMs,
    windows_under_block: x.windowIds.length, diarized_windows_under_block: x.diarizedWindowIds.length, source_row: x.row,
  }));

  const byReason: Record<string, number> = {};
  for (const r of refusals) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const attestedClinicians = new Set(clean.map((x) => x.clinicianId));
  const cleanDays = new Set(clean.map((x) => x.roomDayId));
  return {
    ok: refusals.length === 0,
    refusals,
    records,
    counts: {
      rows_read: rows.length + new Set(priorRefusals.filter((r) => r.row !== null).map((r) => r.row)).size,
      rows_clean: clean.length,
      refusals: refusals.length,
      by_reason: byReason,
      rooms: new Set(clean.map((x) => x.roomId)).size,
      clinicians: attestedClinicians.size,
      room_days: cleanDays.size,
      windows_under_blocks: new Set(clean.flatMap((x) => x.windowIds)).size,
      diarized_windows_under_blocks: new Set(clean.flatMap((x) => x.diarizedWindowIds)).size,
      diarized_room_days_covered: [...cleanDays].filter((d) => ref.diarizedRoomDayIds.has(d)).length,
      diarized_room_days_total: ref.diarizedRoomDayIds.size,
    },
  };
}
