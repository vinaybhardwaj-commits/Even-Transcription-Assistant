const TARGET_CHARS = 320 * 4
const MAX_CHARS = 450 * 4

export interface TextChunk {
  text: string
  start: number
  end: number
  tokenCount: number
}

export function tokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** Section-aware windows of about 200–450 tokens. Offsets refer to the original text. */
export function chunkText(text: string): TextChunk[] {
  if (text.trim() === '') return []
  if (text.length <= MAX_CHARS) {
    return [chunkAt(text, 0, text.length)]
  }
  const parts: TextChunk[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + TARGET_CHARS)
    if (end < text.length) {
      const windowEnd = Math.min(text.length, cursor + MAX_CHARS)
      const window = text.slice(cursor, windowEnd)
      const paragraph = window.lastIndexOf('\n\n')
      const sentence = window.lastIndexOf('. ')
      const line = window.lastIndexOf('\n')
      const breakAt = Math.max(paragraph, sentence, line)
      if (breakAt >= Math.floor(TARGET_CHARS / 2)) end = cursor + breakAt + (paragraph === breakAt ? 2 : 1)
    }
    if (end <= cursor) end = Math.min(text.length, cursor + TARGET_CHARS)
    const piece = chunkAt(text, cursor, end)
    if (piece.text.length > 0) parts.push(piece)
    cursor = end
  }
  return parts
}

function chunkAt(text: string, start: number, end: number): TextChunk {
  const raw = text.slice(start, end)
  const leading = raw.length - raw.trimStart().length
  const trimmed = raw.trim()
  const spanStart = start + leading
  return {
    text: trimmed,
    start: spanStart,
    end: spanStart + trimmed.length,
    tokenCount: tokenCount(trimmed),
  }
}
