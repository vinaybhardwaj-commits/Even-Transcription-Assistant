// Shared paths and constants for eta-bus-mcp.
// All paths are absolute Mac Mini paths (this server only ever runs on the Mini).

export const FABLE_DIR = '/Users/vinaybhardwaj/dev/_fable';
export const HERDR_CTL_PATH = '/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live/ctl.sh';
export const SCRATCH_DIR = `${FABLE_DIR}/scratch`;
export const AUDIT_LOG_PATH = '/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/copy/audit.log';
export const HERDR_STATUS_JSON = '/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/copy/herdr-status.json';

export const DB_DIR = '/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/copy/bus';
export const DB_PATH = `${DB_DIR}/bus.db`;

// PATH given to every child process we spawn (herdr-ctl.sh, herdr binary).
export const CHILD_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin';

export const IDENTITY_CACHE_TTL_MS = 60_000;
export const NUDGE_RATE_LIMIT_MS = 120_000;

export const MAX_SUBJECT_LEN = 120;
export const MAX_BODY_BYTES = 16 * 1024;

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export const SERVER_NAME = 'eta-bus';
export const SERVER_VERSION = '0.1.0';
