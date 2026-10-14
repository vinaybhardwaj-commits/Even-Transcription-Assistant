/**
 * lib/triage/note-class.ts — Action-queue note class (pure).
 *
 * One board. OPD, discharge summary, and (later) OT share the same queue, stamp,
 * and Findings pipe. The class is part of the card identity so those pipes do not
 * collide. `ot` is a type-complete value only — this slice does not land OT notes.
 */

export const NOTE_CLASSES = ['opd', 'discharge_summary', 'ot'] as const;
export type NoteClass = (typeof NOTE_CLASSES)[number];

export const DEFAULT_NOTE_CLASS: NoteClass = 'opd';

/** Queue-local marker for a discharge stay whose treating doctor did not resolve.
 *  Not a physician uid. Never written to a doctor directory. */
export const UNMAPPED_DOCTOR_PREFIX = 'unmapped:';

/** The only stamp reason an unresolved discharge card accepts. */
export const UNMAPPED_DOCTOR_REASON = 'unmapped_doctor';

export function isNoteClass(value: unknown): value is NoteClass {
  return typeof value === 'string' && (NOTE_CLASSES as readonly string[]).includes(value);
}

/** Missing or unknown → opd, so every pre-class row and card stays an OPD card. */
export function noteClassOf(value: unknown): NoteClass {
  return isNoteClass(value) ? value : DEFAULT_NOTE_CLASS;
}

export function isUnmappedQueueDoctor(doctorUid: string): boolean {
  return doctorUid.startsWith(UNMAPPED_DOCTOR_PREFIX);
}

export function unmappedQueueDoctor(auditId: string): string {
  return `${UNMAPPED_DOCTOR_PREFIX}${auditId}`;
}
