import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { ManualClock } from "../src/util.js";
import { defaultHubConfig, type HubServerConfig } from "../src/v3/hub/config.js";
import { HubServer } from "../src/v3/hub/server.js";

process.env.UBUS_V3 = "1";
const dirs: string[] = [];
export function cleanupAfter(): void {
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
}

export const KEYS: Record<string, string> = { t4: "t4-secret-key", mini: "mini-secret-key" };
export const EPOCH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
export const EPOCH2 = "f1e2d3c4b5a69788f1e2d3c4b5a69788";

export function rig(dir = mkdtempSync(join(tmpdir(), "ubus-hub-"))) {
  dirs.push(dir);
  const cfg: HubServerConfig = { ...defaultHubConfig(dir), dbPath: join(dir, "log.db"), keyDir: join(dir, "nodes"), laneOwnersPath: join(dir, "owners.json"), allowlistPath: join(dir, "allow.json") };
  cfg.listen = { host: "127.0.0.1", port: 0 };
  mkdirSync(cfg.keyDir, { recursive: true });
  for (const [n, k] of Object.entries(KEYS)) {
    writeFileSync(join(cfg.keyDir, `${n}.key`), k);
    chmodSync(join(cfg.keyDir, `${n}.key`), 0o600);
  }
  writeFileSync(cfg.laneOwnersPath, JSON.stringify({ "bc-s6": "newcat-orch" }));
  const clock = new ManualClock(Date.parse("2026-10-18T08:00:00.000Z"));
  return { dir, cfg, clock };
}

/** Independent CONTRACT-A1 signer: deliberately does not import the hub's signRequest. */
export function signA1(key: string, method: string, pathQuery: string, ts: string, nonce: string, body: string): string {
  return createHmac("sha256", key).update([method, pathQuery, ts, nonce, createHash("sha256").update(body).digest("hex")].join("\n")).digest("hex");
}

export interface ReqOpts {
  node?: string;
  key?: string;
  skewMs?: number;
  nonce?: string;
  ts?: string;
  /** Replace the whole Authorization header. */
  auth?: string;
  /** Sign this body/path instead of the one sent. */
  signBody?: string;
  signPath?: string;
  signMethod?: string;
  noTs?: boolean;
  noNonce?: boolean;
}

export async function up(r: ReturnType<typeof rig>) {
  const srv = new HubServer(r.cfg, r.clock);
  r.clock.advance(5_001); // requests must be stamped after the hub booted (boot + forward skew)
  const addr = await srv.listen();
  const base = `http://${addr.host}:${addr.port}`;
  /** A request signed per CONTRACT-A1; every knob can be bent to build an attack. */
  async function raw(method: string, pathQuery: string, body: string, o: ReqOpts = {}) {
    const node = o.node ?? "t4";
    const ts = o.ts ?? new Date(r.clock.now() + (o.skewMs ?? 0)).toISOString();
    const nonce = o.nonce ?? randomBytes(16).toString("hex");
    const sig = signA1(o.key ?? KEYS[node] ?? "x", (o.signMethod ?? method).toUpperCase(), o.signPath ?? pathQuery, ts, nonce, o.signBody ?? body);
    const headers: Record<string, string> = { authorization: o.auth ?? `Node ${node}:${sig}` };
    if (!o.noTs) headers["x-ubus-ts"] = ts;
    if (!o.noNonce) headers["x-ubus-nonce"] = nonce;
    const res = await fetch(`${base}${pathQuery}`, { method, body: method === "GET" ? undefined : body, headers });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }
  const post = (events: unknown[], o: ReqOpts = {}) => raw("POST", "/api/v3/events", JSON.stringify({ events }), o);
  async function get(path: string, authed = false) {
    if (authed) return raw("GET", path, "");
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }
  return { srv, post, get, raw, base };
}

export function ev(seq: number, over: Record<string, unknown> = {}) {
  return {
    v: 1,
    node: "t4",
    epoch: EPOCH,
    seq,
    ts: "2026-10-18T08:00:00.000Z",
    kind: "agent.state",
    agent: { id: "lead@t4", kind: "herdr-pane", pane: "w4X:p1", lane: "bc-s6", model: "claude-sonnet-5-5", runtime: "bedrock", pid: 42 },
    state: "working",
    reason: null,
    meta: { n: 1 },
    ...over,
  };
}

export const hb = (seq: number) => ev(seq, { kind: "node.heartbeat", agent: null, state: null });
export const alerts = (h: { srv: HubServer }) => h.srv.hub.messages.snapshot().messages.filter((m) => m.kind === "alert");
