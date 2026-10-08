// Shared paths and constants for eta-bus-mcp.
// All paths are absolute Mac Mini paths (this server only ever runs on the Mini).

export const FABLE_DIR = '/Users/vinaybhardwaj/dev/_fable';
export const HERDR_CTL_PATH = `${FABLE_DIR}/herdr-ctl.sh`;
export const SCRATCH_DIR = `${FABLE_DIR}/scratch`;
export const AUDIT_LOG_PATH = `${SCRATCH_DIR}/eta-bus.log`;
// NOTE: herdr-ctl.sh v2 (fix round, ruling 6) no longer writes status to a
// fixed shared path — it prints "STATUS_JSON <private-per-run-path>" as
// the first line of `status`'s stdout instead. See herdrctl.mjs/tools.mjs.

export const DB_DIR = `${FABLE_DIR}/bus`;
export const DB_PATH = `${DB_DIR}/bus.db`;

// PATH given to every child process we spawn (herdr-ctl.sh, herdr binary).
export const CHILD_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin';

// Fix round ruling 8: 10s TTL (was 60s), keyed by pane id — see identity.mjs.
export const IDENTITY_CACHE_TTL_MS = 10_000;
export const NUDGE_RATE_LIMIT_MS = 120_000;

export const MAX_SUBJECT_LEN = 120;
export const MAX_BODY_BYTES = 16 * 1024;

// Fix round ruling 9: bus_inbox's whole JSON reply is capped at 24KB.
export const INBOX_REPLY_CAP_BYTES = 24 * 1024;

// Fix round ruling 7: the nudge sent to a recipient's pane is this fixed
// string, verbatim, with no sender-controlled content (no subject, no
// sender name, no count) — closes the prompt-injection hole where a
// message subject/body was copied into a herdr `agent prompt` call and
// read by the receiving Claude Code agent as if it were user input.
export const NUDGE_TEXT = '[bus] You have unread messages. Call bus_inbox.';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export const SERVER_NAME = 'eta-bus';
export const SERVER_VERSION = '0.2.0';

// eta-lab move (2026-09-23): daily bus export files, one per UTC day of the
// message's own timestamp, message metadata + body, secret-scrubbed. This
// is a human/lab-readable side artifact of the bus, not the source of
// truth — bus.db stays the source of truth and lives at DB_PATH above.
export const BUS_EXPORT_DIR = '/Users/vinaybhardwaj/dev/eta-lab/bus';
