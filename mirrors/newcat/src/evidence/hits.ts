import type { LicenceClass } from './approval.js'

export interface EvidenceRef {
  chunk_id: string
  source_id: string
  source_name: string
  section_path: string
  licence_class: LicenceClass
  doctor_visible: boolean
  quote: string
  url: string | null
}

export const EMBEDDING_DIM = 1024
export const RRF_K = 60
