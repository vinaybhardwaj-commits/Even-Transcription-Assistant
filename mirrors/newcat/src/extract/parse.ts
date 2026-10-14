export function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const raw = fenced?.[1] ?? trimmed
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('no json object')
  return JSON.parse(raw.slice(start, end + 1)) as unknown
}
