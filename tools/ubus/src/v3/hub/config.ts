import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const NODES = ["mini", "air", "t4", "c3", "c4", "asus", "yoga"] as const;

export interface HubListen {
  host: string;
  port: number;
}

export interface HubServerConfig {
  /** Event-log sqlite path. */
  dbPath: string;
  /** Default 127.0.0.1; the tailnet address only by explicit config. Never a wildcard. */
  listen: HubListen;
  /** Per-node secrets: <keyDir>/<node>.key, mode 0600. */
  keyDir: string;
  /** JSON object {lane: owner-handle}. */
  laneOwnersPath: string;
  allowlistPath?: string;
}

/** Expand an IPv6 literal to 8 16-bit groups (embedded IPv4 tail supported); null if malformed. */
function v6Groups(addr: string): number[] | null {
  let text = addr.split("%")[0].toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const o = tail.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    text = text.slice(0, tail.index) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for 0.0.0.0, ::, ::ffff:0.0.0.0, ::0.0.0.0, ::ffff:0:0 and every other spelling of "any address". */
export function isUnspecified(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (isIP(h) === 4) return h.split(".").every((o) => Number(o) === 0);
  const g = isIP(h) === 6 ? v6Groups(h) : null;
  if (!g) return false;
  return g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff) && g[6] === 0 && g[7] === 0;
}

export function isLoopback(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (isIP(h) === 4) return Number(h.split(".")[0]) === 127;
  const g = isIP(h) === 6 ? v6Groups(h) : null;
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6] >> 8 === 127;
}

/** Throws unless host is a specific IP literal (not any spelling of the wildcard). */
export function assertBindable(host: string): void {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (isIP(h) === 0) throw new Error(h === "" || h === "*" || h === "0" ? "refusing to bind a wildcard address" : "listen host must be an IP literal");
  if (isUnspecified(h)) throw new Error("refusing to bind a wildcard address");
}

export function defaultHubConfig(home = homedir()): HubServerConfig {
  const base = join(home, ".ubus", "hub");
  return {
    dbPath: join(base, "eventlog.db"),
    listen: { host: "127.0.0.1", port: 7377 },
    keyDir: join(base, "nodes"),
    laneOwnersPath: join(base, "lane_owners.json"),
  };
}

export function loadHubConfig(path: string, home = homedir()): HubServerConfig {
  const cfg = defaultHubConfig(home);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (typeof raw.dbPath === "string") cfg.dbPath = raw.dbPath;
  if (typeof raw.keyDir === "string") cfg.keyDir = raw.keyDir;
  if (typeof raw.laneOwnersPath === "string") cfg.laneOwnersPath = raw.laneOwnersPath;
  if (typeof raw.allowlistPath === "string") cfg.allowlistPath = raw.allowlistPath;
  if (typeof raw.listen === "string") {
    const m = /^(.*):(\d+)$/.exec(raw.listen);
    if (!m) throw new Error("listen must be host:port");
    cfg.listen = { host: m[1], port: Number(m[2]) };
  } else if (raw.listen && typeof raw.listen === "object") {
    const l = raw.listen as Record<string, unknown>;
    cfg.listen = { host: String(l.host ?? cfg.listen.host), port: Number(l.port ?? cfg.listen.port) };
  }
  assertBindable(cfg.listen.host);
  return cfg;
}
