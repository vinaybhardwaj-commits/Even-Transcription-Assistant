/**
 * Error text that is safe to print. t4 output is read over ssh into a non-PHI channel, so a tool must never echo a JSON.parse
 * message (it quotes a fragment of the line), a zod message or any input fragment. Only these forms are printed:
 * a CodedError message (a fixed code, optionally with a line number), a node errno code, or a message of one of our own
 * fixed shapes (snake_case codes, option errors). Anything else prints as `unknown`.
 */
export class CodedError extends Error {}

const OWN = /^(?:[a-z]+(?:_[a-z0-9]+)+(?: line \d+)?|unknown argument --[a-z-]+|--[a-z-]+(?: and --[a-z-]+)? (?:is|are) required|--[a-z-]+ needs [a-z ]+|usage: [\w .<>[\]=|:,()-]+)$/

export function safeMessage(error: unknown): string {
  if (error instanceof CodedError) return error.message
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)) return `fs_error ${code}`
  if (error instanceof Error && OWN.test(error.message)) return error.message
  return 'unknown'
}

export function reportFailure(tool: string, error: unknown): void {
  process.stderr.write(`${tool} failed: ${safeMessage(error)}\n`)
}
