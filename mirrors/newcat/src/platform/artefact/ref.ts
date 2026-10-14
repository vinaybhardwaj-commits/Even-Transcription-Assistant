import { z } from 'zod'

export const ARTEFACT_STORES = ['reb', 'eta-freescript', 'pulse', 'cdmss'] as const

/** A pointer to an artefact in another system. newcat persists these and never the artefact body (D1). A new cfg8 is a new artefact. */
export const ArtefactRefSchema = z
  .object({
    store: z.enum(ARTEFACT_STORES),
    path: z.string().min(1),
    layer: z.string().min(1),
    engine: z.string().min(1),
    version: z.string().nullable(),
    cfg8: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    schema: z.string().min(1),
  })
  .strict()

export type ArtefactRef = z.infer<typeof ArtefactRefSchema>

/** Same rule as consult_bundle.counts(): basename, drop the 5-character ".json" tail, take the last "__" part. */
export function cfg8FromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const stem = base.slice(0, -5)
  const i = stem.lastIndexOf('__')
  return i < 0 ? stem : stem.slice(i + 2)
}

/** Identity of one artefact: store, path and cfg8 (the path already carries the cfg8; it is kept explicit). */
export function refKey(ref: Pick<ArtefactRef, 'store' | 'path' | 'cfg8'>): string {
  return `${ref.store}:${ref.path}:${ref.cfg8}`
}
