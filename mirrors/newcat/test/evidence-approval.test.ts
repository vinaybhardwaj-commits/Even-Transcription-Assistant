import { describe, expect, it } from 'vitest'
import { CAT_CORPUS_IMPORT_SIGNER, catCorpusImportSignature, isDoctorVisibleLicence } from '../src/evidence/approval.js'

describe('corpus approval', () => {
  it('marks a CAT corpus import live at import time and keeps licensed text internal', () => {
    const importedAt = new Date('2026-10-12T07:19:00.000Z')
    expect(catCorpusImportSignature(importedAt)).toEqual({
      signed_by: CAT_CORPUS_IMPORT_SIGNER,
      signed_at: '2026-10-12T07:19:00.000Z',
    })
    expect(CAT_CORPUS_IMPORT_SIGNER).toBe('cat-corpus-import')
    expect(isDoctorVisibleLicence('open')).toBe(true)
    expect(isDoctorVisibleLicence('india_regulatory')).toBe(true)
    expect(isDoctorVisibleLicence('licensed_internal')).toBe(false)
    expect(isDoctorVisibleLicence('commercial_db')).toBe(false)
  })
})
