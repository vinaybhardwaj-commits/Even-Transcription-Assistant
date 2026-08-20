/**
 * lib/bench-bus-constants.ts — the command bus's normative timing constants, alone in a
 * PURE module (remount-resume addendum 3, S3-2). No imports: this file must be safe to pull
 * into the kiosk bundle — lib/bench-commands.ts carries the database module graph, and a
 * database driver has no business in a browser. bench-commands re-exports these, so every
 * server-side caller keeps its import path unchanged.
 */

export const COMMAND_EXPIRY_SECONDS = 15; // pending > 15 s without a poll → expired (PRD §8.2)
export const LISTENER_FRESH_MS = 10_000; // last_poll_at within 10 s = listening (kickoff)
export const ACK_WAIT_MS = 8_000; // MCP tools wait this long for the kiosk ack (PRD §8.2)
export const ACK_POLL_MS = 400;
