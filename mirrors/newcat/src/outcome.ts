/** Typed stage results. A bare empty list is not a valid outcome. */

export type StageError = {
  type: string
  message: string
}

export type StageOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'empty'; reason: string }
  | { status: 'abstained'; reason: string; data: T }
  | { status: 'unavailable'; error: StageError }
  | { status: 'truncated'; error: StageError }
  | { status: 'refused'; error: StageError }
  | { status: 'extraction_failed'; error: StageError; errors: ValidationIssue[] }
  | { status: 'failed'; error: StageError }

export interface ValidationIssue {
  code: 'schema' | 'span' | 'unit' | 'range' | 'negation'
  path: string
  message: string
}
