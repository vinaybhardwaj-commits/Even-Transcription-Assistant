import type { StageOutcome } from '../outcome.js'

export interface EvidenceQuery {
  fact_ids: string[]
  question: string
}

export interface EvidenceHit {
  source_id: string
  quote: string
  span_start: number
  span_end: number
}

/** Stand-in for a caller that has no database. The live path is retrieveEvidence, which still returns unavailable rather than []. */
export interface EvidenceRetriever {
  retrieve(query: EvidenceQuery): Promise<StageOutcome<EvidenceHit[]>>
}

export class UnavailableEvidenceRetriever implements EvidenceRetriever {
  async retrieve(): Promise<StageOutcome<EvidenceHit[]>> {
    return {
      status: 'unavailable',
      error: { type: 'evidence_layer_not_built', message: 'The evidence retriever is not implemented.' },
    }
  }
}
