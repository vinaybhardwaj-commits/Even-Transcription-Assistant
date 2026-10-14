/**
 * CAT's production corpus is already an approved database.
 * Rows imported from it are live on arrival: signed_by is cat-corpus-import
 * and signed_at is the import time. There is no human gate on that import.
 * Rows added later from a new source stay unused until a person sets signed_by
 * and signed_at. Licensed sources stay internal-only.
 */

export const CAT_CORPUS_IMPORT_SIGNER = 'cat-corpus-import'

export type LicenceClass = 'open' | 'licensed_internal' | 'india_regulatory' | 'commercial_db'

const INTERNAL_ONLY = new Set<LicenceClass>(['licensed_internal', 'commercial_db'])

export interface ContentSignature {
  signed_by: string
  signed_at: string
}

export function catCorpusImportSignature(importedAt: Date): ContentSignature {
  return {
    signed_by: CAT_CORPUS_IMPORT_SIGNER,
    signed_at: importedAt.toISOString(),
  }
}

/** Open and India-regulatory text may be shown to a doctor. Licensed text may not. */
export function isDoctorVisibleLicence(licence: LicenceClass): boolean {
  return !INTERNAL_ONLY.has(licence)
}

const LICENSED_SOURCE = /uptodate|mksap|textbook|statpearls|tintinalli|goodman/i

export function sourceIdFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'source'
}

/**
 * Known licensed corpora stay internal even when a line says open.
 * UpToDate, MKSAP, textbooks, and StatPearls are in that set.
 */
export function resolveImportLicence(
  sourceName: string,
  requested: LicenceClass | undefined,
): { licence_class: LicenceClass; doctor_visible: boolean } {
  const licence_class: LicenceClass = LICENSED_SOURCE.test(sourceName) ? 'licensed_internal' : (requested ?? 'open')
  return { licence_class, doctor_visible: isDoctorVisibleLicence(licence_class) }
}
