import type { EmrAdapter, EmrAdapterId } from './types.js'

/** V's per-integration GO to write into a record or show output to clinicians (spec 8, V4). */
export interface EmrGo {
  integration: EmrAdapterId
  goRef: string
}

/** Empty until V gives a per-integration GO after real testing. */
export const EMR_GO: readonly EmrGo[] = []

/** Ids of adapters that are `live` without a GO entry naming them and a GO reference. */
export function liveWithoutGo(adapters: readonly EmrAdapter[], go: readonly EmrGo[] = EMR_GO): EmrAdapterId[] {
  return adapters
    .filter((adapter) => adapter.outbound.mode === 'live')
    .filter((adapter) => !go.some((entry) => entry.integration === adapter.id && entry.goRef.trim() !== ''))
    .map((adapter) => adapter.id)
}
