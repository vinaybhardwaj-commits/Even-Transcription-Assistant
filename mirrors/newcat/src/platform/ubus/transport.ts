import { readFileSync } from 'node:fs'

/** One ubus tool call. The bridge only ever uses register, heartbeat, inbox, send, reply, ack. */
export interface UbusTransport {
  call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
}

export class UbusTransportError extends Error {}

const SESSION_HEADER = 'mcp-session-id'

export interface HttpTransportOptions {
  url: string
  handle: string
  /** Optional. Read from the file at construction; never logged, never put in an error. */
  tokenFile?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * INFERRED live transport: MCP streamable HTTP, one JSON-RPC `tools/call` POST per call to UBUS_URL
 * (the full endpoint, e.g. the Mini's /mcp), `handle` passed in the arguments, result in `content[0].text` as JSON.
 * The `Mcp-Session-Id` the server returns is kept and resent, so one process holds one server session; if the server
 * rejects a held id (400/404) it is dropped and the call retried once without it.
 * Matches ~/.local/ubus-mcp/dist/src/http.js; not exercised against the live Mini.
 */
export class HttpUbusTransport implements UbusTransport {
  private readonly token: string | undefined
  private id = 0
  private sessionId: string | undefined

  constructor(private readonly options: HttpTransportOptions) {
    this.token = options.tokenFile ? readToken(options.tokenFile) : undefined
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const heldSession = this.sessionId
    const response = await this.post(tool, args)
    if (heldSession && (response.status === 400 || response.status === 404)) {
      if (this.sessionId === heldSession) this.sessionId = undefined
      return this.read(await this.post(tool, args))
    }
    return this.read(response)
  }

  private async post(tool: string, args: Record<string, unknown>): Promise<Response> {
    const doFetch = this.options.fetchImpl ?? fetch
    this.id += 1
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    if (this.sessionId) headers[SESSION_HEADER] = this.sessionId
    try {
      return await doFetch(this.options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: this.id, method: 'tools/call', params: { name: tool, arguments: { handle: this.options.handle, ...args } } }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      })
    } catch {
      throw new UbusTransportError('ubus request failed')
    }
  }

  private async read(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw new UbusTransportError(`ubus http ${response.status}`)
    const returned = response.headers.get(SESSION_HEADER)
    if (returned) this.sessionId = returned
    try {
      const parsed = (await response.json()) as { result?: { content?: Array<{ text?: string }> } }
      const text = parsed.result?.content?.[0]?.text
      if (typeof text !== 'string') throw new Error('no content')
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new UbusTransportError('ubus response unreadable')
    }
  }
}

function readToken(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch (error) {
    // Code only: the message of a node fs error carries the path.
    throw new UbusTransportError(`ubus token file unreadable (${(error as NodeJS.ErrnoException).code ?? 'ERR'})`)
  }
}

export interface RecordedCall {
  tool: string
  args: Record<string, unknown>
}

/** In-memory transport for tests: records calls, serves a scripted inbox, can be made to fail or reject. */
export class FakeUbusTransport implements UbusTransport {
  readonly calls: RecordedCall[] = []
  inboxQueue: Array<Record<string, unknown>> = []
  failNext = 0
  rejectSends: string | null = null

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ tool, args })
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new UbusTransportError('fake failure')
    }
    if (tool === 'ubus_inbox') {
      const messages = this.inboxQueue
      this.inboxQueue = []
      return { ok: true, messages }
    }
    if ((tool === 'ubus_send' || tool === 'ubus_reply') && this.rejectSends) return { ok: false, error: this.rejectSends }
    return { ok: true }
  }

  sent(tool = 'ubus_send'): RecordedCall[] {
    return this.calls.filter((c) => c.tool === tool)
  }
}
