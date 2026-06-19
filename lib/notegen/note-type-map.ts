/**
 * Map an EvenScribe note_type onto the MedNoteGen NABH-seed taxonomy used by
 * nabh_requirements (`ot_note` / `discharge_summary` / `opd_rx`). Types with no
 * NABH floor (clinic/general/dietetic/physio) return null -> coverage is empty
 * (the editor still works; just no coverage pills for those types).
 */
export type SeedNoteType = "ot_note" | "discharge_summary" | "opd_rx";

export function seedNoteType(etaNoteType?: string | null): SeedNoteType | null {
  switch (etaNoteType) {
    case "operative_procedure": return "ot_note";
    case "discharge_summary":   return "discharge_summary";
    case "opd_prescription":    return "opd_rx";
    default:                    return null;
  }
}
