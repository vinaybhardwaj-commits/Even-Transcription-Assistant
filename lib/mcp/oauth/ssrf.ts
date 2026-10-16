/**
 * lib/mcp/oauth/ssrf.ts — OAUTH-O2-FIX1 (SHOULD-1): resolve a client-metadata host BEFORE fetching it, refuse any address that is not a public unicast address, and fetch pinned to the checked address.
 *
 * Refused: 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local), 172.16/12, 192.0.0.0/24, 192.168/16, 198.18/15, 224/4 (multicast), 240/4 (reserved, includes broadcast);
 * ::, ::1, fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast), 2001:db8::/32; an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96) address is judged by the IPv4 inside it.
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
const FORBIDDEN_V6 = ["::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32"] as const;
function blockList(cidrs: readonly string[], family: "ipv4" | "ipv6"): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [net, bits] = cidr.split("/");
    list.addSubnet(net!, Number(bits), family);
  }
  return list;
}
const bad4 = blockList(FORBIDDEN_V4, "ipv4");
const bad6 = blockList(FORBIDDEN_V6, "ipv6");

/** True when the address must NOT be fetched. Anything that does not parse as an IP is refused. */
export function isForbiddenAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  const kind = isIP(a);
  if (kind === 4) return bad4.check(a, "ipv4");
  if (kind !== 6) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a) ?? /^64:ff9b::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return isForbiddenAddress(mapped[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a) ?? /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isForbiddenAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return bad6.check(a, "ipv6");
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

/** The addresses to pin to, or null when resolution failed, was empty, or ANY address is forbidden. */
export async function resolvePublic(host: string): Promise<Resolved | null> {
  try {
    const rows = await resolver(host);
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
