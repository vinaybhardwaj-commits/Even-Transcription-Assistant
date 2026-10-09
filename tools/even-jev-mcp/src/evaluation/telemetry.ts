export type OutboundCallLog = {
  tool: string;
  inputBytes: number;
  questionCount: number;
  latencyMs: number;
  status: number;
  /** Set only when a guard refused the call: pattern names or "byte_cap". Never content. */
  refused?: string;
};

// Logs one line to stderr per outbound call (and per guard refusal) to the Jev API.
// Never logs content or the API key.
export function logOutboundCall(entry: OutboundCallLog): void {
  const refusedPart = entry.refused ? ` refused=${entry.refused}` : "";
  console.error(
    `[even-jev-mcp] tool=${entry.tool} input_bytes=${entry.inputBytes} questions=${entry.questionCount} latency_ms=${entry.latencyMs} status=${entry.status}${refusedPart}`
  );
}
