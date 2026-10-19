/** Time Machine volume that may hold the cold log (D6). */
export const TIME_MACHINE_VOLUME_UUID = "06934966-C7D8-4B5B-9326-9C91C0FDADCD";

/** Fixed, content-free herdr nudge. Callers cannot substitute text. */
export const NUDGE_TEXT = "[ubus] You have unread messages. Call ubus_inbox.";

export const LIAISON_IDENTITY = "ext-evenscribe-kiosk-bot";
export const BRIDGE_IDENTITY = "ubus-bridge";

/** ETA guest allow-list (GUEST_ALLOWED_TO). Liason posts only to these names. */
export const ETA_LEADS = [
  "fable",
  "consult-lead",
  "herdr-lead",
  "orbox-lead",
  "backfill-lead",
  "palimpsest-architect",
  "scribe-mcp-lead",
  "gating-lead",
] as const;

export const LIVE_MS = 3 * 60 * 1000;
export const GONE_MS = 24 * 60 * 60 * 1000;
/** Hook/stdio agents with no heartbeat for this long are reaped to gone (MiniBot 12 Oct; grok/cowork keep GONE_MS). */
export const STALE_GONE_MS = Number(process.env.UBUS_STALE_GONE_MS) || 12 * 60 * 60 * 1000;
export const WAKE_GAP_MS = 120 * 1000;
export const NUDGE_GAP_MS = 120 * 1000;
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
export const GRANT_MAX_MS = 8 * 60 * 60 * 1000;
export const STOP_COOLDOWN_MS = 10 * 60 * 1000;
export const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const SPOOL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const BODY_MAX_BYTES = 8 * 1024;
export const ETA_BODY_MAX_BYTES = 16 * 1024;
export const SUBJECT_MAX_CHARS = 120;
export const GROUP_MAX_MEMBERS = 25;
export const GENESIS = "0".repeat(64);
export const FILTER_ID = "ubus-filter/1";
export const SCHEMA_MSG = "ubus.msg/2";

/**
 * Edge-auth classes whose clients do not keep Mcp-Session-Id.
 * A session-less call may name a handle only when that handle was registered under the same class.
 */
export const STATELESS_PLATFORM_CLASSES = ["grok-platform", "cursor-cloud", "fleet-cloud"] as const;

export const DESTRUCTIVE_TOOLS = [
  "ubus_agent_interrupt",
  "ubus_agent_spawn",
  "ubus_agent_restart",
  "ubus_agent_kill",
  "ubus_agent_clear",
] as const;

export const GRANT_VERBS = ["send", "tag", "compact", "set_model"] as const;

export const RUNTIMES = [
  "claude-code",
  "opencode",
  "cursor-cli",
  "cursor-cloud",
  "openbot",
  "grok",
  "cowork",
  "other",
] as const;

/**
 * Hospital kiosks, the ICU Mac, and the live OT recorder.
 * Denied in code for every verb, not merely omitted from an allow-list.
 */
export function isDeniedMachine(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (n.startsWith("ehrc-")) return true;
  if (n === "vinay-orb2" || n === "orb2") return true;
  return false;
}

/** Bindings of Mcp-Session-Id to a handle are pruned after this long unseen. */
export const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A gone row older than this (counted from when it became gone) moves to agents_archive. */
export const ARCHIVE_AFTER_GONE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MIN_CLIENT_VERSION = "0.2.0";
export const PANE_ID_RE = /^w\w+:p\d+(@.*)?$/;
