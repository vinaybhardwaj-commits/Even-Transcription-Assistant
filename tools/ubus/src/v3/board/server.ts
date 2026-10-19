/**
 * Read-only board HTTP server. GET only; listens on 127.0.0.1 unless a listen
 * host is configured explicitly (never defaults to 0.0.0.0).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  page,
  renderFleet,
  renderHistory,
  renderIndex,
  renderLanes,
  renderMessages,
  type MessageFilters,
} from "./render.js";
import type { AgentView, BoardSource, BoardViews, LaneView, MessageView } from "./types.js";

const ROUTES = new Set(["/", "/fleet", "/lanes", "/messages", "/history"]);

/** inet_aton-style IPv4 (1-4 parts, dec/0x/octal); returns the 32-bit value or null. */
function parseInetAton(host: string): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) n = part === "0" ? 0 : parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) n = parseInt(part, 10);
    else return null;
    nums.push(n);
  }
  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return null;
    value = value * 256 + nums[i];
  }
  const last = nums[nums.length - 1];
  const lastBytes = 4 - (nums.length - 1);
  if (last >= 256 ** lastBytes) return null;
  return value * 256 ** lastBytes + last;
}

/** True for empty hosts and every spelling of the any-address (IPv4 or IPv6, incl. mapped). */
export function isAnyAddress(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!h) return true;
  if (isIP(h) === 6) {
    // Expand via the URL parser, then test for all-zero or ::ffff:<zero v4>.
    let norm: string;
    try {
      norm = new URL(`http://[${h}]`).hostname.slice(1, -1);
    } catch {
      return true; // unparsable v6: refuse
    }
    return norm === "::" || norm === "::ffff:0:0";
  }
  return parseInetAton(h) === 0;
}

export interface BoardServerOptions {
  source: BoardSource;
  host?: string;
  port?: number;
  now?: () => number;
}

/** Render one page for a path+query; returns null for an unknown path. */
export async function renderRoute(
  source: BoardSource,
  pathname: string,
  query: URLSearchParams,
  nowMs: number,
): Promise<string | null> {
  const route = pathname.replace(/\/+$/, "") || "/";
  const keys = ["agent", "lane", "state"] as const;
  if (!ROUTES.has(route)) return null;
  if (route === "/history") {
    return page({ title: "History", active: "history", body: renderHistory(), refreshUrl: "/history" });
  }
  let views: BoardViews;
  const fixedRoute = route; // whitelisted above: the only value a refresh may target
  try {
    views = await source.views();
  } catch {
    const body = `<div class="card"><h2>Hub</h2><p class="empty">hub views unavailable</p></div>`;
    return page({ title: "Unavailable", active: "", body, refreshUrl: fixedRoute });
  }
  switch (route) {
    case "/":
      return page({ title: "Overview", active: "", body: renderIndex(views), refreshUrl: "/" });
    case "/fleet":
      return page({ title: "Fleet", active: "fleet", body: renderFleet(views, nowMs), refreshUrl: "/fleet" });
    case "/lanes":
      return page({ title: "Lanes", active: "lanes", body: renderLanes(views), refreshUrl: "/lanes" });
    case "/messages": {
      const filters: MessageFilters = {};
      const qs = new URLSearchParams();
      for (const k of keys) {
        const v = query.get(k);
        if (v) {
          filters[k] = v;
          qs.set(k, v);
        }
      }
      const q = qs.toString();
      return page({
        title: "Messages",
        active: "messages",
        body: renderMessages(views, filters),
        refreshUrl: q ? `/messages?${q}` : "/messages",
      });
    }
    default:
      return null;
  }
}

function plain(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }).end(text);
  } catch {
    /* socket already gone: nothing to answer */
  }
}

export function createBoardServer(opts: BoardServerOptions): Server {
  const now = opts.now ?? Date.now;
  const server = createServer((req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        plain(res, 405, "read-only board", { allow: "GET, HEAD" });
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://board.local");
      } catch {
        plain(res, 400, "bad request");
        return;
      }
      renderRoute(opts.source, url.pathname, url.searchParams, now())
        .then((html) => {
          if (html === null) {
            plain(res, 404, "not found");
            return;
          }
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          });
          res.end(req.method === "HEAD" ? undefined : html);
        })
        .catch(() => plain(res, 500, "board error"));
    } catch {
      plain(res, 500, "board error");
    }
  });
  // Malformed HTTP framing must never reach an uncaught exception.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

export function listenBoard(opts: BoardServerOptions): Promise<Server> {
  const host = opts.host ?? "127.0.0.1";
  if (isAnyAddress(host)) return Promise.reject(new Error("board refuses to listen on a wildcard or empty host"));
  const server = createBoardServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const a = server.address();
      if (a && typeof a === "object" && isAnyAddress(a.address)) {
        server.close();
        reject(new Error("board refuses to listen on a wildcard or empty host"));
        return;
      }
      resolve(server);
    });
  });
}

/** Optional auth hook: the caller computes CONTRACT-A1 node auth headers. The board never logs them. */
export type HeadersHook = (method: string, path: string, body: string) => Record<string, string>;

type Raw = Record<string, unknown>;

/** Map a P0 message view (camelCase, maybe without to/lane) to the board's MessageView. */
export function adaptMessage(raw: Raw): MessageView {
  const pick = <T>(snake: string, camel: string, dflt: T): T => (raw[snake] ?? raw[camel] ?? dflt) as T;
  const rawStates = raw.states;
  const states = (Array.isArray(rawStates) ? Object.fromEntries(rawStates as [string, MessageView["states"][string]][]) : rawStates ?? {}) as MessageView["states"];
  const to = Array.isArray(raw.to) ? (raw.to as string[]) : Object.keys(states);
  const sla = Number(pick<number>("sla_s", "slaS", 0));
  return {
    id: String(raw.id ?? ""),
    ts: String(raw.ts ?? ""),
    from: String(raw.from ?? ""),
    to,
    kind: String(raw.kind ?? ""),
    priority: String(raw.priority ?? ""),
    subject: String(raw.subject ?? ""),
    body: String(raw.body ?? ""),
    body_ref: String(pick<string>("body_ref", "bodyRef", "")),
    lane: (raw.lane as string | null) ?? null,
    sla_s: Number.isFinite(sla) ? sla : 0,
    states,
  };
}

/** Reads the hub's JSON views over HTTP (CONTRACT: /api/v3/agents, lanes, messages). */
export class HttpBoardSource implements BoardSource {
  constructor(
    private readonly base: string,
    private readonly opts: { headers?: HeadersHook } = {},
  ) {}

  private async get<T>(path: string): Promise<T> {
    const headers = this.opts.headers ? this.opts.headers("GET", path, "") : {};
    const r = await fetch(new URL(path, this.base), { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`hub ${path} -> ${r.status}`);
    return (await r.json()) as T;
  }

  async views(): Promise<BoardViews> {
    const arr = <T>(v: unknown, key: string): T[] => {
      const x = Array.isArray(v) ? v : (v as Record<string, unknown> | null)?.[key];
      return Array.isArray(x) ? (x as T[]) : [];
    };
    const [a, l, m] = await Promise.all([
      this.get<unknown>("/api/v3/agents"),
      this.get<unknown>("/api/v3/lanes"),
      this.get<unknown>("/api/v3/messages"),
    ]);
    return {
      agents: arr<AgentView>(a, "agents"),
      lanes: arr<LaneView>(l, "lanes"),
      messages: arr<Raw>(m, "messages").map(adaptMessage),
    };
  }
}
