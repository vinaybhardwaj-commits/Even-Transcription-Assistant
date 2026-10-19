import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  APPROVAL_TTL_MS,
  DEFAULT_MIN_CLIENT_VERSION,
  GRANT_MAX_MS,
  TIME_MACHINE_VOLUME_UUID,
} from "./constants.js";

export interface EdgeAuthConfig {
  enabled: boolean;
  tokensFile?: string;
  secretPathsFile?: string;
  allowLoopback: boolean;
  /** Cloudflare Access team host, e.g. team.cloudflareaccess.com. JWKS is fetched from https://<team>/cdn-cgi/access/certs. */
  teamDomain?: string;
  /** Access application AUD tag. Required before a Cf-Access-Jwt-Assertion is accepted. */
  audience?: string;
}

export interface EtaConfig {
  /** fake sqlite file, readonly sqlite tail, or external command. */
  mode: "sqlite" | "command";
  dbPath?: string;
  readOnly?: boolean;
  table?: string;
  postCommand?: string[];
  /** When mode is command, optional readonly db for the inbound tailer. */
  tailDbPath?: string;
}

export interface UbusConfig {
  host: string;
  port: number;
  dataDir: string;
  spoolDir: string;
  auditPath: string;
  stopFile: string;
  groupsFile: string;
  dbPath: string;
  coldRoot: string;
  volumeMount: string;
  expectedVolumeUuid: string;
  trustForwardedFor: boolean;
  edgeAuth: EdgeAuthConfig;
  limits: {
    sendsPerHour: number;
    machineSendsPerHour: number;
    handleSendsPerHour: Record<string, number>;
    broadcastsPerHour: number;
    controlPerHour: number;
    bridgePerHour: number;
    bodyMaxBytes: number;
    subjectMaxChars: number;
    approvalTtlMs: number;
    grantMaxMs: number;
    maxSpoolBytes: number;
    minFreeRatio: number;
  };
  eta: EtaConfig;
  herdr: { mode: "fake" | "command"; command?: string[] };
  openbot: { mode: "fake" | "http"; baseUrl?: string };
  handoff: { mode: "fake" | "http"; url?: string };
  whois: { mode: "none" | "command"; command?: string[] };
  approvers: { engineering: string[]; elevated: string[] };
  /** "external_only": PHI/transcript rules apply only to messages that can leave the tailnet. "all" (default): always. */
  filter: { phiScope: "external_only" | "all" };
  tickMs: number;
  minClientVersion: string;
  escalation: EscalationConfig;
}

export interface EscalationConfig {
  enabled: boolean;
  wakeAfterS: number;
  escalateAfterS: number;
  /** Local time, "HH:MM". */
  digestAt: string;
  digestTo: string[];
  digestDir: string;
  exemptHandles: string[];
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

export function defaultConfig(root: string): UbusConfig {
  const dataDir = resolve(root, "data");
  return {
    host: "127.0.0.1",
    port: 8790,
    dataDir,
    spoolDir: resolve(dataDir, "spool"),
    auditPath: resolve(dataDir, "audit", "audit.jsonl"),
    stopFile: resolve(dataDir, "STOP"),
    groupsFile: resolve(root, "registry", "groups.json"),
    dbPath: resolve(dataDir, "ubus.db"),
    coldRoot: resolve(dataDir, "cold"),
    volumeMount: resolve(dataDir, "volume"),
    expectedVolumeUuid: TIME_MACHINE_VOLUME_UUID,
    trustForwardedFor: false,
    edgeAuth: { enabled: false, allowLoopback: true },
    limits: {
      sendsPerHour: 60,
      machineSendsPerHour: 600,
      handleSendsPerHour: {},
      broadcastsPerHour: 3,
      controlPerHour: 5,
      bridgePerHour: 20,
      bodyMaxBytes: 8 * 1024,
      subjectMaxChars: 120,
      approvalTtlMs: APPROVAL_TTL_MS,
      grantMaxMs: GRANT_MAX_MS,
      maxSpoolBytes: 2 * 1024 * 1024 * 1024,
      minFreeRatio: 0.15,
    },
    eta: { mode: "sqlite", dbPath: resolve(dataDir, "eta-fake.db"), readOnly: false, table: "posts" },
    herdr: { mode: "fake" },
    openbot: { mode: "fake" },
    handoff: { mode: "fake" },
    whois: { mode: "none" },
    approvers: { engineering: ["fable"], elevated: ["v", "vinay"] },
    filter: { phiScope: "all" },
    tickMs: 30_000,
    minClientVersion: DEFAULT_MIN_CLIENT_VERSION,
    escalation: {
      enabled: true,
      wakeAfterS: 300,
      escalateAfterS: 1200,
      digestAt: "21:00",
      digestTo: ["gating-lead"],
      digestDir: resolve(dataDir, "digest"),
      exemptHandles: [],
    },
  };
}

export function loadConfig(file: string | undefined, root = process.cwd()): UbusConfig {
  const base = defaultConfig(root);
  if (!file) return base;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return mergeConfig(base, raw, root);
}

export function mergeConfig(base: UbusConfig, raw: Record<string, unknown>, root: string): UbusConfig {
  const cfg: UbusConfig = structuredClone(base);
  const abs = (p: unknown, fallback: string) => {
    if (typeof p !== "string" || !p) return fallback;
    const expanded = expandHome(p);
    return isAbsolute(expanded) ? expanded : resolve(root, expanded);
  };
  if (typeof raw.host === "string") cfg.host = raw.host;
  if (typeof raw.port === "number") cfg.port = raw.port;
  if (typeof raw.data_dir === "string") cfg.dataDir = abs(raw.data_dir, cfg.dataDir);
  cfg.spoolDir = abs(raw.spool_dir, resolve(cfg.dataDir, "spool"));
  cfg.auditPath = abs(raw.audit_path, resolve(cfg.dataDir, "audit", "audit.jsonl"));
  cfg.stopFile = abs(raw.stop_file, resolve(cfg.dataDir, "STOP"));
  cfg.groupsFile = abs(raw.groups_file, cfg.groupsFile);
  cfg.dbPath = abs(raw.db_path, resolve(cfg.dataDir, "ubus.db"));
  if (typeof raw.cold_root === "string") cfg.coldRoot = abs(raw.cold_root, cfg.coldRoot);
  if (typeof raw.volume_mount === "string") cfg.volumeMount = abs(raw.volume_mount, cfg.volumeMount);
  if (typeof raw.expected_volume_uuid === "string") cfg.expectedVolumeUuid = raw.expected_volume_uuid;
  if (typeof raw.trust_forwarded_for === "boolean") cfg.trustForwardedFor = raw.trust_forwarded_for;
  if (typeof raw.tick_ms === "number") cfg.tickMs = raw.tick_ms;
  if (typeof raw.min_client_version === "string" && raw.min_client_version) cfg.minClientVersion = raw.min_client_version;

  const esc = raw.escalation;
  if (esc && typeof esc === "object") {
    const e = esc as Record<string, unknown>;
    if (typeof e.enabled === "boolean") cfg.escalation.enabled = e.enabled;
    if (typeof e.wake_after_s === "number" && e.wake_after_s > 0) cfg.escalation.wakeAfterS = e.wake_after_s;
    if (typeof e.escalate_after_s === "number" && e.escalate_after_s > 0) cfg.escalation.escalateAfterS = e.escalate_after_s;
    if (typeof e.digest_at === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(e.digest_at)) cfg.escalation.digestAt = e.digest_at;
    if (Array.isArray(e.digest_to)) cfg.escalation.digestTo = e.digest_to.map(String);
    if (Array.isArray(e.exempt_handles)) cfg.escalation.exemptHandles = e.exempt_handles.map(String);
    cfg.escalation.digestDir = abs(e.digest_dir, resolve(cfg.dataDir, "digest"));
  } else {
    cfg.escalation.digestDir = resolve(cfg.dataDir, "digest");
  }

  const edge = raw.edge_auth;
  if (edge && typeof edge === "object") {
    const e = edge as Record<string, unknown>;
    if (typeof e.enabled === "boolean") cfg.edgeAuth.enabled = e.enabled;
    if (typeof e.allow_loopback === "boolean") cfg.edgeAuth.allowLoopback = e.allow_loopback;
    if (typeof e.tokens_file === "string") cfg.edgeAuth.tokensFile = abs(e.tokens_file, "");
    if (typeof e.secret_paths_file === "string") cfg.edgeAuth.secretPathsFile = abs(e.secret_paths_file, "");
    if (typeof e.team_domain === "string") cfg.edgeAuth.teamDomain = e.team_domain.trim();
    if (typeof e.audience === "string") cfg.edgeAuth.audience = e.audience.trim();
  }

  const limits = raw.limits;
  if (limits && typeof limits === "object") {
    const l = limits as Record<string, unknown>;
    const num = (k: "broadcastsPerHour" | "controlPerHour" | "bridgePerHour" | "bodyMaxBytes" | "subjectMaxChars" | "approvalTtlMs" | "grantMaxMs" | "maxSpoolBytes" | "minFreeRatio", alt: string) => {
      const v = l[alt];
      if (typeof v === "number") cfg.limits[k] = v;
    };
    const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
    if (posInt(l.sends_per_hour)) cfg.limits.sendsPerHour = l.sends_per_hour;
    if (posInt(l.machine_sends_per_hour)) cfg.limits.machineSendsPerHour = l.machine_sends_per_hour;
    const ov = l.handle_sends_per_hour;
    if (ov && typeof ov === "object" && !Array.isArray(ov)) {
      for (const [h, n] of Object.entries(ov as Record<string, unknown>)) {
        if (posInt(n)) cfg.limits.handleSendsPerHour[h] = n;
      }
    }
    num("broadcastsPerHour", "broadcasts_per_hour");
    num("controlPerHour", "control_per_hour");
    num("bridgePerHour", "bridge_per_hour");
    num("bodyMaxBytes", "body_max_bytes");
    num("subjectMaxChars", "subject_max_chars");
    num("approvalTtlMs", "approval_ttl_ms");
    num("grantMaxMs", "grant_max_ms");
    num("maxSpoolBytes", "max_spool_bytes");
    num("minFreeRatio", "min_free_ratio");
  }

  const eta = raw.eta;
  if (eta && typeof eta === "object") {
    const e = eta as Record<string, unknown>;
    if (e.mode === "sqlite" || e.mode === "command") cfg.eta.mode = e.mode;
    if (typeof e.db_path === "string") cfg.eta.dbPath = abs(e.db_path, cfg.eta.dbPath ?? "");
    if (typeof e.tail_db_path === "string") cfg.eta.tailDbPath = abs(e.tail_db_path, "");
    if (typeof e.read_only === "boolean") cfg.eta.readOnly = e.read_only;
    if (typeof e.table === "string") cfg.eta.table = e.table;
    if (Array.isArray(e.post_command)) cfg.eta.postCommand = e.post_command.map(String);
  }

  const herdr = raw.herdr;
  if (herdr && typeof herdr === "object") {
    const h = herdr as Record<string, unknown>;
    if (h.mode === "fake" || h.mode === "command") cfg.herdr.mode = h.mode;
    if (Array.isArray(h.command)) cfg.herdr.command = h.command.map(String);
  }
  const openbot = raw.openbot;
  if (openbot && typeof openbot === "object") {
    const o = openbot as Record<string, unknown>;
    if (o.mode === "fake" || o.mode === "http") cfg.openbot.mode = o.mode;
    if (typeof o.base_url === "string") cfg.openbot.baseUrl = o.base_url;
  }
  const handoff = raw.handoff;
  if (handoff && typeof handoff === "object") {
    const h = handoff as Record<string, unknown>;
    if (h.mode === "fake" || h.mode === "http") cfg.handoff.mode = h.mode;
    if (typeof h.url === "string") cfg.handoff.url = h.url;
  }
  const whois = raw.whois;
  if (whois && typeof whois === "object") {
    const w = whois as Record<string, unknown>;
    if (w.mode === "none" || w.mode === "command") cfg.whois.mode = w.mode;
    if (Array.isArray(w.command)) cfg.whois.command = w.command.map(String);
  }
  const filterRaw = raw.filter;
  if (filterRaw && typeof filterRaw === "object") {
    const scope = (filterRaw as Record<string, unknown>).phi_scope;
    if (scope === "external_only" || scope === "all") cfg.filter.phiScope = scope;
  }

  const approvers = raw.approvers;
  if (approvers && typeof approvers === "object") {
    const a = approvers as Record<string, unknown>;
    if (Array.isArray(a.engineering)) cfg.approvers.engineering = a.engineering.map(String);
    if (Array.isArray(a.elevated)) cfg.approvers.elevated = a.elevated.map(String);
  }
  return cfg;
}
