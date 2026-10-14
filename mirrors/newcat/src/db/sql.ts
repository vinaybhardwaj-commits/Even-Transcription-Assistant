export interface SqlRows<T> {
  rows: T[]
}

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlRows<T>>
  exec(text: string): Promise<void>
  withTx<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).toISOString()
  throw new Error('expected timestamp')
}

export function asDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value.slice(0, 10)
  throw new Error('expected date')
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  throw new Error('expected number')
}

export function asJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
