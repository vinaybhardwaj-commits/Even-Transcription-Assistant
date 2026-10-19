import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { NOT_REGISTERED_HINT, type Ubus, type Caller } from "./bus.js";
import type { UbusConfig } from "./config.js";
import type { Whois } from "./adapters.js";
import { JwksCache, verifyAccessJwt, type AccessClient, type Jwks } from "./access-jwt.js";
import { safeEqual } from "./util.js";
import { TOOLS } from "./tools.js";
import { VERSION } from "./version.js";

interface Session {
  id: string;
  handle?: string;
  machine: string;
  machineVerified: boolean;
  via: Caller["via"];
  platformClass?: string;
  client?: string;
  userAgent?: string;
  remote?: string;
  /** x-ubus-instance: one stdio shim process, stable across its reconnects. */
  instance?: string;
  lastTouch?: number;
}

interface TokenFile {
  clients?: Array<{ id: string; secret: string; class: string }>;
}
interface PathFile {
  paths?: Array<{ secret: string; class: string }>;
}

export interface HttpOptions {
  whois: Whois;
  /** Test hook. Production fetches https://<team>.cloudflareaccess.com/cdn-cgi/access/certs. */
  fetchJwks?: (url: string) => Promise<Jwks>;
  now?: () => number;
}

export function createHttpServer(ubus: Ubus, config: UbusConfig, opts: HttpOptions): Server {
  const sessions = new Map<string, Session>();
  const tokens = new FileCache<TokenFile>();
  const paths = new FileCache<PathFile>();
  const jwks = new JwksCache(opts.fetchJwks, undefined, opts.now);
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch {
      sendJson(res, 500, { ok: false, error: "internal" });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ubus/health")) {
      const archive = ubus.archive.status();
      sendJson(res, 200, {
        ok: true,
        service: "ubus",
        version: VERSION,
        min_client_version: config.minClientVersion,
        paused: existsSync(config.stopFile),
        archive: archive.degraded ? "degraded" : "ok",
        archive_pending: archive.pending,
        escalation: ubus.escalationStatus(),
        orphan_deliveries_marked: ubus.orphanCount(),
      });
      return;
    }
    const hookClass = matchHookSecret(url.pathname, config, paths);
    const isHook = url.pathname === "/v1/hook" || url.pathname === "/ubus/v1/hook" || hookClass !== null;
    if (req.method === "POST" && isHook) {
      const auth = await authorize(req, url, hookClass);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: "unauthorized" });
      const body = asRecord(await readBody(req));
      const result = await hookOp(body, auth.session);
      sendJson(res, 200, result);
      return;
    }
    const secretClass = matchSecretPath(url.pathname, config, paths);
    const isMcp = url.pathname === "/mcp" || url.pathname === "/ubus/mcp" || secretClass !== null;
    if (req.method === "POST" && isMcp) {
      const auth = await authorize(req, url, secretClass);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: "unauthorized" });
      const body = asRecord(await readBody(req));
      const session = loadSession(req, auth.session, sessions, ubus);
      const response = await handleRpc(body, session, sessions);
      if (session) res.setHeader("Mcp-Session-Id", session.id);
      if (response === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendJson(res, 200, response);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  }

  async function authorize(req: IncomingMessage, url: URL, secretClass?: string | null): Promise<{ ok: true; session: Omit<Session, "id" | "handle"> } | { ok: false }> {
    const loopback = isLoopback(req);
    const headerClass = matchServiceToken(req, config, tokens);
    const jwtClass = await matchAccessJwt(req, config, tokens, jwks, opts.now);
    const pathClass = secretClass === undefined ? matchSecretPath(url.pathname, config, paths) : secretClass;
    const viaCloudflare = Boolean(headerOne(req, "cf-ray") || headerOne(req, "cf-connecting-ip"));
    if (!config.edgeAuth.enabled) {
      return { ok: true, session: baseSession(req, loopback ? loopbackClient(req) : "tailnet") };
    }
    // Cloudflare (cloudflared on loopback still sets CF-* headers) needs a service token, an Access JWT, or the secret path.
    // Access strips CF-Access-Client-Id/Secret before origin, so the JWT is what arrives at bus.llmvinayminihome.uk.
    if (viaCloudflare || headerClass || jwtClass || pathClass) {
      if (headerClass) return { ok: true, session: { ...baseSession(req, "cloudflare"), platformClass: headerClass, via: "cloudflare" } };
      if (jwtClass) return { ok: true, session: { ...baseSession(req, "cloudflare"), platformClass: jwtClass, via: "cloudflare" } };
      if (pathClass) return { ok: true, session: { ...baseSession(req, "cloudflare"), platformClass: pathClass, via: "cloudflare" } };
      return { ok: false };
    }
    // Tailscale serve and local hooks arrive without CF headers. Tailnet ACL is the gate (D1).
    if (config.edgeAuth.allowLoopback && loopback) {
      return { ok: true, session: baseSession(req, loopbackClient(req)) };
    }
    const ip = peerIp(req, config.trustForwardedFor);
    if (ip && opts.whois.lookup(ip)) return { ok: true, session: baseSession(req, "tailnet") };
    return { ok: false };
  }

  function baseSession(req: IncomingMessage, via: Caller["via"]): Omit<Session, "id" | "handle"> {
    const machine = machineFor(req);
    return {
      machine: machine.machine,
      machineVerified: machine.verified,
      via,
      client: headerOne(req, "x-ubus-client"),
      userAgent: headerOne(req, "user-agent"),
      remote: peerIp(req, config.trustForwardedFor) || undefined,
      instance: instanceOf(req),
    };
  }

  function machineFor(req: IncomingMessage): { machine: string; verified: boolean } {
    const ip = peerIp(req, config.trustForwardedFor);
    if (ip) {
      const found = opts.whois.lookup(ip);
      if (found) return { machine: found.machine, verified: true };
    }
    return { machine: "unknown", verified: false };
  }

  async function hookOp(body: Record<string, unknown>, session: Omit<Session, "id" | "handle">): Promise<Record<string, unknown>> {
    const op = String(body.op || "");
    const handle = typeof body.handle === "string" ? body.handle : "";
    const caller: Caller = {
      handle: handle || undefined,
      machine: typeof body.machine === "string" ? body.machine : session.machine,
      machineVerified: session.machineVerified,
      via: session.via,
      platformClass: session.platformClass,
      client: session.client,
      userAgent: session.userAgent,
      remote: session.remote,
    };
    if (op === "session-start") {
      const registered = await ubus.call(
        "ubus_register",
        {
          handle: body.handle,
          machine: body.machine || caller.machine,
          runtime: body.runtime,
          session: body.session,
          owner: body.owner,
          orchestrator: body.orchestrator,
          capabilities: body.capabilities,
        },
        { ...caller, handle: undefined },
      );
      if (!registered.ok) return { ok: false, error: registered.error };
      const h = String(registered.handle);
      const unread = ubus.unreadSummary(h);
      return { ok: true, handle: h, address: registered.address, presence: registered.presence, unread };
    }
    if (op === "unread") {
      if (!handle) return { ok: false, error: "not_registered", message: NOT_REGISTERED_HINT };
      return { ok: true, handle, unread: ubus.unreadSummary(handle) };
    }
    if (op === "wait") {
      if (!handle) return { ok: false, error: "not_registered", message: NOT_REGISTERED_HINT };
      const timeout = typeof body.timeout_s === "number" ? body.timeout_s : 25;
      const result = await ubus.call("ubus_wait", { timeout_s: timeout }, { ...caller, handle });
      const unread = ubus.unreadSummary(handle);
      return { ok: result.ok, error: result.error, handle, unread };
    }
    return { ok: false, error: "unknown_op" };
  }

  async function handleRpc(body: Record<string, unknown>, session: Session, allSessions: Map<string, Session>): Promise<Record<string, unknown> | undefined> {
    const method = String(body.method || "");
    const id = body.id;
    const params = (body.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>;
    if (method.startsWith("notifications/")) return undefined;
    if (method === "initialize") {
      return rpc(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ubus", version: VERSION },
      });
    }
    if (method === "ping") return rpc(id, {});
    if (method === "tools/list") {
      return rpc(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (method === "tools/call") {
      const name = String(params.name || "");
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      const caller: Caller = {
        handle: session.handle,
        machine: session.machine,
        machineVerified: session.machineVerified,
        via: session.via,
        platformClass: session.platformClass,
        client: session.client,
        userAgent: session.userAgent,
        remote: session.remote,
        sessionId: session.instance ? `i:${session.instance}` : session.id,
      };
      const bound = ubus.bindCaller(name, args, caller);
      if (bound.handle && !session.handle) {
        session.handle = bound.handle;
        if (bound.machine) session.machine = bound.machine;
        allSessions.set(session.id, session);
        persist(session, ubus);
      }
      const result = await ubus.call(name, args, bound);
      // Only the first registration names the connection. Later ones (Cowork sessions sharing a shim) are claimed, not adopted.
      if (name === "ubus_register" && result.ok && typeof result.handle === "string" && !session.handle) {
        session.handle = result.handle;
        if (typeof result.machine === "string" && result.machine) session.machine = result.machine;
        allSessions.set(session.id, session);
        persist(session, ubus);
      }
      const text = JSON.stringify(result);
      return rpc(id, { content: [{ type: "text", text }], isError: result.ok === false });
    }
    return rpcError(id, -32601, "method not found");
  }

  return server;
}

const TOUCH_EVERY_MS = 10 * 60 * 1000;

function loadSession(req: IncomingMessage, base: Omit<Session, "id" | "handle">, sessions: Map<string, Session>, ubus: Ubus): Session {
  const header = req.headers["mcp-session-id"];
  const existingId = Array.isArray(header) ? header[0] : header;
  if (existingId && sessions.has(existingId)) {
    const known = sessions.get(existingId)!;
    touch(known, ubus);
    return known;
  }
  const session: Session = { id: existingId || randomUUID(), ...base };
  if (existingId) {
    // Unknown id: the server restarted. Rebind from the stored binding while its agent row is open.
    // The door must match the one the binding was made on, so a cloud caller cannot take a tailnet handle.
    const bound = ubus.lookupBinding(existingId);
    if (bound && (bound.platformClass || "") === (base.platformClass ?? "")) {
      session.handle = bound.handle;
      if (!base.machineVerified && bound.machine) session.machine = bound.machine;
      session.lastTouch = Date.now();
      ubus.touchBinding(existingId);
    }
  }
  sessions.set(session.id, session);
  return session;
}

function touch(session: Session, ubus: Ubus): void {
  if (!session.handle) return;
  const now = Date.now();
  if (session.lastTouch && now - session.lastTouch < TOUCH_EVERY_MS) return;
  session.lastTouch = now;
  ubus.touchBinding(session.id);
}

function persist(session: Session, ubus: Ubus): void {
  if (!session.handle) return;
  session.lastTouch = Date.now();
  ubus.bindSession(session.id, { handle: session.handle, machine: session.machine, via: session.via, platformClass: session.platformClass });
}

function instanceOf(req: IncomingMessage): string | undefined {
  const v = headerOne(req, "x-ubus-instance");
  return v && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : undefined;
}

function loopbackClient(req: IncomingMessage): Caller["via"] {
  const client = headerOne(req, "x-ubus-client");
  if (client === "ubus-mcp") return "stdio";
  return "local";
}

function matchServiceToken(req: IncomingMessage, config: UbusConfig, cache: FileCache<TokenFile>): string | null {
  const file = cache.read(config.edgeAuth.tokensFile);
  if (!file?.clients?.length) return null;
  const id = headerOne(req, "cf-access-client-id");
  const secret = headerOne(req, "cf-access-client-secret");
  if (!id || !secret) return null;
  for (const client of file.clients) {
    if (!client.id || !client.secret || client.id.startsWith("REPLACE_")) continue;
    if (safeEqual(client.id, id) && safeEqual(client.secret, secret)) return client.class || "cloudflare";
  }
  return null;
}

async function matchAccessJwt(
  req: IncomingMessage,
  config: UbusConfig,
  cache: FileCache<TokenFile>,
  jwks: JwksCache,
  now?: () => number,
): Promise<string | null> {
  if (!config.edgeAuth.enabled) return null;
  const token = headerOne(req, "cf-access-jwt-assertion");
  if (!token) return null;
  const file = cache.read(config.edgeAuth.tokensFile);
  const clients: AccessClient[] = file?.clients ?? [];
  const verified = await verifyAccessJwt({
    token,
    teamDomain: config.edgeAuth.teamDomain,
    audience: config.edgeAuth.audience,
    clients,
    cache: jwks,
    now: now?.(),
  });
  return verified?.className ?? null;
}

/** Same path secret as /mcp/<secret>, on the hook door: /v1/hook/<secret> and /ubus/v1/hook/<secret>. */
function matchHookSecret(pathname: string, config: UbusConfig, cache: FileCache<PathFile>): string | null {
  const file = cache.read(config.edgeAuth.secretPathsFile);
  if (!file?.paths?.length) return null;
  for (const entry of file.paths) {
    if (!entry.secret || entry.secret.startsWith("REPLACE_")) continue;
    const suffixes = [`/v1/hook/${entry.secret}`, `/ubus/v1/hook/${entry.secret}`];
    if (suffixes.some((s) => pathname === s)) return entry.class || "secret-path";
  }
  return null;
}

function matchSecretPath(pathname: string, config: UbusConfig, cache: FileCache<PathFile>): string | null {
  const file = cache.read(config.edgeAuth.secretPathsFile);
  if (!file?.paths?.length) return null;
  for (const entry of file.paths) {
    if (!entry.secret || entry.secret.startsWith("REPLACE_")) continue;
    const suffixes = [`/mcp/${entry.secret}`, `/ubus/mcp/${entry.secret}`];
    if (suffixes.some((s) => pathname === s)) return entry.class || "secret-path";
  }
  return null;
}

class FileCache<T> {
  private path = "";
  private mtime = 0;
  private data: T | null = null;
  read(file: string | undefined): T | null {
    if (!file || !existsSync(file)) return null;
    const mtime = statSync(file).mtimeMs;
    if (this.path === file && this.mtime === mtime && this.data) return this.data;
    try {
      this.data = JSON.parse(readFileSync(file, "utf8")) as T;
      this.path = file;
      this.mtime = mtime;
      return this.data;
    } catch {
      return null;
    }
  }
}

function peerIp(req: IncomingMessage, trustForwarded: boolean): string | null {
  if (trustForwarded) {
    const fwd = headerOne(req, "x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
  }
  const addr = req.socket.remoteAddress || "";
  if (!addr) return null;
  return addr.replace(/^::ffff:/, "");
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "";
}

function headerOne(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function rpc(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
