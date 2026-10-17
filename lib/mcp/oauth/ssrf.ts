/**
 * lib/mcp/oauth/ssrf.ts — OAUTH-O2-FIX1 (SHOULD-1): resolve a client-metadata host BEFORE fetching it, refuse any address that is not a public unicast address, and fetch pinned to the checked address.
 *
 * Refused: 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local), 172.16/12, 192.0.0.0/24, 192.168/16, 198.18/15, 224/4 (multicast), 240/4 (reserved, includes broadcast);
 * IPv6 (R2 F4): denied unless inside 2000::/3, and within that 2002::/16 (6to4), 2001::/32 (Teredo), 2001:db8::/32 and 64:ff9b:1::/48 are refused. Every ::/96 (IPv4-compatible, ::, ::1)
 * and ::ffff:0:0/96 (IPv4-mapped) address is judged by the IPv4 inside it. Everything else (ULA, link-local, site-local, multicast, NAT64, SIIT, discard) falls outside 2000::/3.
 * If ANY resolved address is refused, the whole host is refused (a name that answers with one public and one private address is a rebinding probe).
 *
 * PINNING. The default transport is node:https with a `lookup` that returns only the checked address; TLS still verifies the certificate against the ORIGINAL host name (servername), so a pinned
 * connection to the wrong machine fails the handshake. The global fetch cannot be pinned without importing undici's Agent, which the bundler does not ship here, so it is not used for this call.
 */
import { BlockList, isIP } from "node:net";
import { promises as dns } from "node:dns";
import https from "node:https";
import { Readable } from "node:stream";

// Every range is one CIDR string, parsed at load.
const FORBIDDEN_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"] as const;
/** R2 F4: IPv6 is DENIED by default. Only global unicast 2000::/3 may pass, and inside it these are refused (6to4, Teredo, documentation, local-use NAT64). */
const ALLOWED_V6 = ["2000::/3"] as const;
const FORBIDDEN_V6 = ["2002::/16", "2001::/32", "2001:db8::/32", "64:ff9b:1::/48"] as const;
function blockList(cidrs: readonly string[], family: "ipv4" | "ipv6"): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [net, bits] = cidr.split("/");
    list.addSubnet(net!, Number(bits), family);
  }
  return list;
}
const bad4 = blockList(FORBIDDEN_V4, "ipv4");
const ok6 = blockList(ALLOWED_V6, "ipv6");
const bad6 = blockList(FORBIDDEN_V6, "ipv6");

/** The 8 16-bit groups of an IPv6 address, or null. The WHATWG URL parser canonicalises it first (dotted tails become hex, a zone id fails), so every spelling lands on one form. */
function groups6(a: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${a}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head, tail] = host.includes("::") ? host.split("::") as [string, string] : [host, null];
  const h = head ? head.split(":") : [];
  const t = tail === null ? [] : tail ? tail.split(":") : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  const all = [...h, ...Array<string>(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** True when the address must NOT be fetched. Anything that does not parse as an IP is refused. */
export function isForbiddenAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  const kind = isIP(a);
  if (kind === 4) return bad4.check(a, "ipv4");
  if (kind !== 6) return true;
  const g = groups6(a);
  if (!g) return true;
  // ::/96 (IPv4-compatible, and :: and ::1) and ::ffff:0:0/96 (IPv4-mapped): judged by the IPv4 in the low 32 bits
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0 || g[5] === 0xffff)) return isForbiddenAddress(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  const canon = g.map((n) => n.toString(16)).join(":");
  if (!ok6.check(canon, "ipv6")) return true;
  return bad6.check(canon, "ipv6");
}

export type Resolved = Array<{ address: string; family: 4 | 6 }>;
export type Resolver = (host: string) => Promise<Resolved>;

const defaultResolver: Resolver = async (host) => {
  const rows = await dns.lookup(host, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};
let resolver: Resolver = defaultResolver;
/** test seam: a stubbed resolver (nip.io-style names, rebinding answers) */
export function setResolverForTests(r: Resolver | null): void {
  resolver = r ?? defaultResolver;
}

/** Rejects when `signal` aborts (R2 F5: the lookup shares the fetch's 5 s budget). */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The addresses to pin to, or null when resolution failed, was empty, timed out (signal), or ANY address is forbidden. */
export async function resolvePublic(host: string, signal?: AbortSignal): Promise<Resolved | null> {
  try {
    const rows = await abortable(resolver(host), signal);
    if (rows.length === 0 || rows.length > 16) return null;
    if (rows.some((r) => isForbiddenAddress(r.address))) return null;
    return rows;
  } catch {
    return null;
  }
}

export type Transport = (url: URL, pinned: { address: string; family: 4 | 6 }, signal: AbortSignal) => Promise<Response>;

/** node:https GET pinned to `pinned.address`; certificate checked against the URL's host name; no redirects are followed (a 3xx is returned as is and the caller refuses it). */
const httpsTransport: Transport = (url, pinned, signal) =>
  new Promise<Response>((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:", hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: "GET", servername: url.hostname,
        headers: { accept: "application/json", "user-agent": "evenscribe-mcp-oauth" }, signal,
        lookup: (_h, opts, cb) => (opts && (opts as { all?: boolean }).all ? (cb as unknown as (e: null, a: Resolved) => void)(null, [pinned]) : cb(null, pinned.address, pinned.family)),
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
        const status = res.statusCode ?? 0;
        const noBody = status < 200 || status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400);
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status: status < 200 ? 502 : status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });

let transport: Transport = httpsTransport;
export function setTransportForTests(t: Transport | null): void {
  transport = t ?? httpsTransport;
}
export const fetchPinned: Transport = (url, pinned, signal) => transport(url, pinned, signal);
