import { isDeniedMachine, RUNTIMES } from "./constants.js";

export interface AgentAddress {
  machine: string;
  runtime: string;
  session: string;
  raw: string;
}

const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,80}$/;
const MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

export function validMachine(machine: string): boolean {
  return MACHINE_RE.test(machine) || isDeniedMachine(machine);
}

export function validRuntime(runtime: string): boolean {
  return (RUNTIMES as readonly string[]).includes(runtime);
}

/** agent://<machine>/<runtime>/<session> — session may contain slashes. */
export function parseAddress(input: string): AgentAddress | null {
  if (!input.startsWith("agent://")) return null;
  const rest = input.slice("agent://".length);
  const first = rest.indexOf("/");
  if (first <= 0) return null;
  const second = rest.indexOf("/", first + 1);
  if (second <= first + 1) return null;
  const machine = rest.slice(0, first);
  const runtime = rest.slice(first + 1, second);
  const session = rest.slice(second + 1);
  if (!machine || !runtime || !session) return null;
  return { machine, runtime, session, raw: input };
}

export function formatAddress(machine: string, runtime: string, session: string): string {
  return `agent://${machine}/${runtime}/${session}`;
}

export function addressDenied(input: string): boolean {
  const parsed = parseAddress(input);
  if (parsed && (isDeniedMachine(parsed.machine) || isDeniedMachine(parsed.session))) return true;
  if (isDeniedMachine(input)) return true;
  return false;
}

/** Origin tag used in [ubus:<label>] (D1, D11). Grok labels drop the grok: prefix. */
export function originTag(handle: string): string {
  if (handle.startsWith("grok:")) return handle.slice("grok:".length) || handle;
  return handle;
}

export function isGrokHandle(handle: string): boolean {
  return handle.startsWith("grok:") || handle === "grok";
}

export function displayLabel(machine: string, handle: string): string {
  const tag = originTag(handle);
  return `[${machine}:${tag}]`;
}

const HOST_MAP: Record<string, string> = {
  "opd-bot-1": "opd-bot",
  "opd-bot": "opd-bot",
};

/** Extra hostname -> machine mappings from UBUS_HOST_MAP (JSON object); unset or invalid = none. */
function envHostMap(): Record<string, string> {
  const raw = process.env.UBUS_HOST_MAP;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && v) out[k.trim().toLowerCase()] = v;
    return out;
  } catch {
    return {};
  }
}

const TAILNET_SUFFIX_RE = /\.tail[0-9a-f]+\.ts\.net$/;

let miniHostWarned = false;

/** Mini hostname comes from UBUS_MINI_HOST (no literal default); absent = mini mapping off, logged once. */
function miniHost(): string | null {
  const raw = (process.env.UBUS_MINI_HOST ?? "").trim().toLowerCase().replace(/\.$/, "").replace(TAILNET_SUFFIX_RE, "");
  if (raw) return raw;
  if (!miniHostWarned) {
    miniHostWarned = true;
    process.stderr.write("ubus: UBUS_MINI_HOST not set; Mini hostname mapping is off\n");
  }
  return null;
}

export function shortMachine(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(TAILNET_SUFFIX_RE, "");
  const mini = miniHost();
  if (mini && host === mini) return "mini";
  return envHostMap()[host] ?? HOST_MAP[host] ?? host.split(".")[0] ?? host;
}

export function extractToTag(subject: string, firstLine: string): string | null {
  const blob = `${subject}\n${firstLine}`;
  const bracket = blob.match(/\[to:([^\]]+)\]/i);
  if (bracket?.[1]) return bracket[1].trim();
  const at = `${subject}\n${firstLine}`.match(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,80})\b/);
  if (at?.[1] && at[1].includes(":")) return at[1];
  return null;
}

export function forPaneTag(pane: string): string {
  return `[for:${pane}]`;
}
