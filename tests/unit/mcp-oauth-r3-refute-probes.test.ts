/**
 * Refuter probes for the Scribe OAuth R3 fix round (cloud-scribe-oauth-r3-refute, target 9a936598 / code 41b55843). See cloudpane-reports/SCRIBE-OAUTH-R3-VERDICT.md.
 * R3-E* drive a REAL headless Chromium (CHROME_PATH) through a 127.0.0.1-only bridge to the REAL authorize, callback GET and callback POST handlers: the browser holds the real
 * Set-Cookie, renders the real consent page and submits the real form; the handler sees the browser's own Origin, Cookie and body. Google is simulated by the bridge (state + a
 * synthetic code); no network leaves the box (--host-resolver-rules). Synthetic addresses at example.test and synthetic secrets only. Skipped when CHROME_PATH is absent.
 * R3-U* are unit probes on the burn ordering. Probes that document a FINDING assert today's behaviour and say so.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest, type NextResponse } from "next/server";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type KeyLike } from "jose";

const audit: Array<{ text: string; values: unknown[] }> = [];
vi.mock("@/lib/db", () => ({ sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { audit.push({ text: strings.join("?"), values }); return []; }) }));
vi.mock("@/lib/mcp/oauth/store", async () => await import("../support/mcp-oauth-fake-store"));

import * as fake from "../support/mcp-oauth-fake-store";
import { GET as authorizeGet } from "@/app/api/oauth/authorize/route";
import { GET as callbackGet, POST as callbackPost } from "@/app/api/oauth/google/callback/route";
import { setJwksForTests } from "@/lib/mcp/oauth/google";
import { setResolverForTests, setTransportForTests } from "@/lib/mcp/oauth/ssrf";
import { resetDeniedAuditForTests } from "@/lib/mcp/audit";
import { CLAUDE_CALLBACK } from "@/lib/mcp/oauth/config";
import { s256 } from "@/lib/mcp/oauth/crypto";

const RESOURCE = "https://www.evenscribe.app/api/mcp";
const CIMD = "https://client.example.test/oauth/meta.json";
const ALICE = "alice@example.test";
const VERIFIER = "v".repeat(43);
const ENV = { ...process.env };
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";

let privateKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
});

let nonce = "";
beforeEach(() => {
  fake.resetFakeStore();
  fake.addPerson(ALICE);
  audit.length = 0;
  resetDeniedAuditForTests();
  process.env.SCRIBE_MCP_OAUTH = "on";
  process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
  process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic-google-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "q".repeat(24);
  process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = "example.test";
  setJwksForTests(jwks);
  setResolverForTests(async () => [{ address: "::ffff:5db8:d822", family: 6 }]);
  setTransportForTests(async (url, _pinned, signal) => fetch(url.toString(), { signal }));
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init); // CDP json only
    if (url === CIMD) return new Response(JSON.stringify({ client_id: CIMD, client_name: "Synthetic", redirect_uris: [CLAUDE_CALLBACK] }), { status: 200 });
    if (url === "https://oauth2.googleapis.com/token") {
      const id = await new SignJWT({ email: ALICE, email_verified: true, hd: "example.test", nonce }).setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("https://accounts.google.com").setAudience("synthetic-google-client-id").setSubject("sub-1").setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return new Response(JSON.stringify({ id_token: id }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => {
  process.env = { ...ENV };
  setJwksForTests(null);
  setResolverForTests(null);
  setTransportForTests(null);
  vi.unstubAllGlobals();
});

const refusalReasons = () => audit.filter((r) => r.text.includes("mcp.oauth_refused")).map((r) => JSON.stringify(r.values));
const grantedRows = () => audit.filter((r) => r.text.includes("mcp.oauth_granted"));

// ─── The bridge: 127.0.0.1 HTTP server whose routes ARE the real handlers ─────────────────────────────────────────────────────────────────────────────
type Seen = { method: string; path: string; origin: string; status: number; location: string | null; at: number };
async function bridge(postDelayMs: number) {
  const seen: Seen[] = [];
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const port = (srv.address() as { port: number }).port;
    const url = `http://localhost:${port}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    let out: NextResponse;
    const path = new URL(url).pathname;
    if (path === "/start") {
      const q = new URLSearchParams({ response_type: "code", client_id: CIMD, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256(VERIFIER), code_challenge_method: "S256", resource: RESOURCE, state: "st-e2e" });
      out = (await authorizeGet(new NextRequest(`http://localhost:${port}/api/oauth/authorize?${q}`, { headers }))) as NextResponse;
      // simulate Google: bounce straight back to the callback with Google's state and a synthetic code
      const g = new URL(out.headers.get("location")!);
      nonce = g.searchParams.get("nonce")!;
      out.headers.set("location", `/api/oauth/google/callback?state=${encodeURIComponent(g.searchParams.get("state")!)}&code=google-code-synthetic`);
    } else if (path === "/api/oauth/google/callback" && req.method === "GET") {
      out = (await callbackGet(new NextRequest(url, { headers }))) as NextResponse;
    } else if (path === "/api/oauth/google/callback" && req.method === "POST") {
      if (postDelayMs) await new Promise((r) => setTimeout(r, postDelayMs)); // a Neon round trip, so a human double click overlaps
      out = (await callbackPost(new NextRequest(url, { method: "POST", headers, body: Buffer.concat(chunks) }))) as NextResponse;
    } else {
      res.writeHead(404).end();
      return;
    }
    seen.push({ method: req.method!, path, origin: req.headers.origin ?? "(absent)", status: out.status, location: out.headers.get("location"), at: Date.now() });
    const h: Record<string, string | string[]> = {};
    out.headers.forEach((v, k) => { if (k !== "set-cookie") h[k] = v; });
    const sc = out.headers.getSetCookie();
    if (sc.length) h["set-cookie"] = sc;
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  return { seen, port: (srv.address() as { port: number }).port, close: () => srv.close() };
}

async function withChrome<T>(fn: (cdp: (m: string, p?: object) => Promise<any>, waitLoad: () => Promise<void>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "r3probe-"));
  const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    "--host-resolver-rules=MAP localhost 127.0.0.1, MAP evil.example.test 127.0.0.1, MAP * ~NOTFOUND", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const ws = await new Promise<string>((res, rej) => {
      let buf = "";
      chrome.stderr!.on("data", (d) => { buf += String(d); const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) res(m[1]!); });
      setTimeout(() => rej(new Error("chromium did not start")), 20_000);
    });
    const devPort = new URL(ws).port;
    // Under load the about:blank page target can be listed a moment after DevTools starts listening: poll for it (harness race, not product).
    let page: { type: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 100 && !page; i++) {
      const targets = await new Promise<Array<{ type: string; webSocketDebuggerUrl: string }>>((res, rej) =>
        httpGet(`http://127.0.0.1:${devPort}/json/list`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
      page = targets.find((t) => t.type === "page");
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    if (!page) throw new Error("chromium exposed no page target");
    const sock = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => sock.addEventListener("open", r, { once: true }));
    let id = 0;
    const cdp = (method: string, params: object = {}) => new Promise<any>((res) => {
      const my = ++id;
      const on = (ev: MessageEvent) => { const m = JSON.parse(String(ev.data)); if (m.id === my) { sock.removeEventListener("message", on); res(m.result); } };
      sock.addEventListener("message", on);
      sock.send(JSON.stringify({ id: my, method, params }));
    });
    const waitLoad = () => new Promise<void>((r) => { const on = (ev: MessageEvent) => { if (JSON.parse(String(ev.data)).method === "Page.loadEventFired") { sock.removeEventListener("message", on); r(); } }; sock.addEventListener("message", on); });
    await cdp("Page.enable");
    try { return await fn(cdp, waitLoad); } finally { sock.close(); }
  } finally {
    if (chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill("SIGKILL");
      await exited;
    }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp profile */ }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bodyText = async (cdp: (m: string, p?: object) => Promise<any>) => (await cdp("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true })).result.value as string;
const href = async (cdp: (m: string, p?: object) => Promise<any>) => (await cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true })).result.value as string;
async function toConsentPage(cdp: (m: string, p?: object) => Promise<any>, waitLoad: () => Promise<void>, port: number) {
  const l = waitLoad();
  await cdp("Page.navigate", { url: `http://localhost:${port}/start` });
  await l;
  return bodyText(cdp);
}

describe.skipIf(!existsSync(CHROME))("R3-E: real Chromium, real cookie, real page, real handlers, end to end", () => {
  it("E1 Allow: the browser's own Origin passes the strict check, one code, one grant row, the 303 goes to the client with code, state and iss", async () => {
    const b = await bridge(0);
    try {
      await withChrome(async (cdp, waitLoad) => {
        const page = await toConsentPage(cdp, waitLoad, b.port);
        expect(page).toContain("client.example.test");
        expect(page).toContain("claude.ai");
        await cdp("Runtime.evaluate", { expression: `document.querySelector('button[value="allow"]').click()` });
        for (let i = 0; i < 50 && !b.seen.some((s) => s.method === "POST"); i++) await sleep(100);
        await sleep(300);
      });
      const posts = b.seen.filter((s) => s.method === "POST");
      console.log(`[R3-E] seen=${b.seen.map((s) => `${s.method} ${s.path} ${s.status}`).join(" ; ")} refusals=${refusalReasons().map((r) => (/"(consent_[a-z]+|pending_missing|revoked|state_mismatch)"/.exec(r) ?? [])[1]).join(",")}`);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.origin).toBe(`http://localhost:${b.port}`);
      expect(posts[0]!.status).toBe(303);
      const to = new URL(posts[0]!.location!);
      expect(to.origin + to.pathname).toBe(CLAUDE_CALLBACK);
      expect([!!to.searchParams.get("code"), to.searchParams.get("state"), !!to.searchParams.get("iss")]).toEqual([true, "st-e2e", true]);
      expect(fake.state.codes.size).toBe(1);
      expect(grantedRows()).toHaveLength(1);
      expect(fake.state.burned.size).toBe(1);
    } finally { b.close(); }
  }, 90_000);

  it.each([40, 120, 300, 700])("E2 human double click on Allow (real mouse events, second click %i ms later, 400 ms server latency): exactly one code is minted; records what the browser ends on", async (gap) => {
    const b = await bridge(400);
    let landed = "";
    let text = "";
    try {
      await withChrome(async (cdp, waitLoad) => {
        await toConsentPage(cdp, waitLoad, b.port);
        const r = (await cdp("Runtime.evaluate", { expression: `JSON.stringify(document.querySelector('button[value="allow"]').getBoundingClientRect())`, returnByValue: true })).result.value as string;
        const box = JSON.parse(r) as { x: number; y: number; width: number; height: number };
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const click = async (n: number) => {
          await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: n });
          await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: n });
        };
        await click(1);
        await sleep(gap);
        await click(2);
        for (let i = 0; i < 50 && b.seen.filter((s) => s.method === "POST").length < 2; i++) await sleep(100);
        await sleep(800);
        landed = await href(cdp);
        text = await bodyText(cdp);
      });
      const posts = b.seen.filter((s) => s.method === "POST");
      console.log(`[R3-E] seen=${b.seen.map((s) => `${s.method} ${s.path} ${s.status}`).join(" ; ")} refusals=${refusalReasons().map((r) => (/"(consent_[a-z]+|pending_missing|revoked|state_mismatch)"/.exec(r) ?? [])[1]).join(",")}`);
      expect(fake.state.codes.size).toBe(1);
      expect(grantedRows()).toHaveLength(1);
      // Recorded, not asserted as pass/fail: the shape of the outcome the user sees (see verdict finding on double submit).
      console.log(`[R3-E2 gap=${gap}] posts=${posts.length} statuses=${posts.map((p) => p.status).join(",")} landed_on_client=${landed.startsWith("https://claude.ai")} error_page=${/Sign-in error/.test(text)}`);
      if (posts.length === 2) {
        expect(posts.map((p) => p.status).sort()).toEqual([303, 400]);
        expect(refusalReasons().some((r) => r.includes("consent_replay"))).toBe(true);
      }
    } finally { b.close(); }
  }, 90_000);

  it("E3 Deny then Back then Allow: Deny redirects with access_denied and mints nothing; the page cannot be answered again", async () => {
    const b = await bridge(0);
    try {
      await withChrome(async (cdp, waitLoad) => {
        await toConsentPage(cdp, waitLoad, b.port);
        await cdp("Runtime.evaluate", { expression: `document.querySelector('button[value="deny"]').click()` });
        for (let i = 0; i < 50 && !b.seen.some((s) => s.method === "POST"); i++) await sleep(100);
        await sleep(300);
        // Back: the page is no-store, so Chromium re-requests it; the consent cookie was cleared by the Deny answer
        const l = waitLoad();
        await cdp("Runtime.evaluate", { expression: "history.back()" });
        await Promise.race([l, sleep(3000)]);
        await cdp("Runtime.evaluate", { expression: `(document.querySelector('button[value="allow"]')||{click(){}}).click()` });
        await sleep(800);
      });
      const posts = b.seen.filter((s) => s.method === "POST");
      console.log(`[R3-E] seen=${b.seen.map((s) => `${s.method} ${s.path} ${s.status}`).join(" ; ")} refusals=${refusalReasons().map((r) => (/"(consent_[a-z]+|pending_missing|revoked|state_mismatch)"/.exec(r) ?? [])[1]).join(",")}`);
      expect(posts[0]!.status).toBe(303);
      expect(new URL(posts[0]!.location!).searchParams.get("error")).toBe("access_denied");
      expect(posts.slice(1).every((p) => p.status === 400 && p.location === null)).toBe(true);
      expect(fake.state.codes.size).toBe(0);
      expect(grantedRows()).toHaveLength(0);
    } finally { b.close(); }
  }, 90_000);

  it("E4 cross-site forged auto-submit from another origin: no cookie rides (SameSite=Lax), 400, nothing burned; the real Allow afterwards still mints", async () => {
    const b = await bridge(0);
    const evil = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<form id=f method=post action="http://localhost:${b.port}/api/oauth/google/callback"><input name=csrf value=x><input name=decision value=allow></form><script>f.submit()</script>`);
    }).listen(0, "127.0.0.1");
    await new Promise((r) => evil.once("listening", r));
    const evilPort = (evil.address() as { port: number }).port;
    try {
      await withChrome(async (cdp, waitLoad) => {
        await toConsentPage(cdp, waitLoad, b.port);
        // a second tab-equivalent: navigate away to the attacker page, which auto-posts; then come back to a fresh consent page
        await cdp("Page.navigate", { url: `http://evil.example.test:${evilPort}/` });
        for (let i = 0; i < 50 && !b.seen.some((s) => s.method === "POST"); i++) await sleep(100);
        await sleep(300);
      });
      const forged = b.seen.filter((s) => s.method === "POST");
      expect(forged).toHaveLength(1);
      expect(forged[0]!.status).toBe(400);
      expect(forged[0]!.location).toBeNull();
      expect(fake.state.burned.size).toBe(0);
      expect(fake.state.codes.size).toBe(0);
    } finally { b.close(); evil.close(); }
  }, 90_000);
});

// ─── R3-U: burn ordering, handler-level ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SITE = "https://www.evenscribe.app";
const CB = `${SITE}/api/oauth/google/callback`;
async function toConsent() {
  const q = new URLSearchParams({ response_type: "code", client_id: CIMD, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256(VERIFIER), code_challenge_method: "S256", resource: RESOURCE, state: "st-9" });
  const a = await authorizeGet(new NextRequest(`${SITE}/api/oauth/authorize?${q}`));
  const g = new URL(a.headers.get("location")!);
  nonce = g.searchParams.get("nonce")!;
  const u = new URL(CB);
  u.searchParams.set("state", g.searchParams.get("state")!);
  u.searchParams.set("code", "google-code-synthetic");
  const page = (await callbackGet(new NextRequest(u.toString(), { headers: { cookie: `mcp_oauth_pending=${a.cookies.get("mcp_oauth_pending")!.value}` } }))) as NextResponse;
  const html = await page.text();
  return { cookie: page.cookies.get("mcp_oauth_pending")!.value, csrf: /name="csrf" value="([^"]+)"/.exec(html)![1]! };
}
const post = (cookie: string, body: Record<string, string>, headers: Record<string, string> = { origin: SITE }) =>
  callbackPost(new NextRequest(CB, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `mcp_oauth_pending=${cookie}`, ...headers }, body: new URLSearchParams(body).toString() }));

describe("R3-U: what burns and what does not", () => {
  it("U1 Origin: the string 'null' and a foreign origin are refused and do not burn; an ABSENT Origin header is accepted (documented, the cookie+csrf pair is the binding)", async () => {
    const c = await toConsent();
    for (const o of ["null", "https://evil.example.test", "https://evenscribe.app", "http://www.evenscribe.app"]) {
      const r = await post(c.cookie, { csrf: c.csrf, decision: "allow" }, { origin: o });
      expect(r.status, o).toBe(400);
    }
    expect(fake.state.burned.size).toBe(0);
    const r = await post(c.cookie, { csrf: c.csrf, decision: "allow" }, {});
    expect(r.status).toBe(303);
    expect(fake.state.codes.size).toBe(1);
  });

  it("U2 an unknown decision value, an oversize form and a non-form content type do not burn; the real answer still works once", async () => {
    const c = await toConsent();
    expect((await post(c.cookie, { csrf: c.csrf, decision: "maybe" })).status).toBe(400);
    expect((await post(c.cookie, { csrf: c.csrf, decision: "allow", pad: "x".repeat(4000) })).status).toBe(400);
    expect((await callbackPost(new NextRequest(CB, { method: "POST", headers: { "content-type": "application/json", origin: SITE, cookie: `mcp_oauth_pending=${c.cookie}` }, body: JSON.stringify({ csrf: c.csrf, decision: "allow" }) }))).status).toBe(400);
    expect(fake.state.burned.size).toBe(0);
    expect((await post(c.cookie, { csrf: c.csrf, decision: "allow" })).status).toBe(303);
    expect((await post(c.cookie, { csrf: c.csrf, decision: "allow" })).status).toBe(400);
    expect(fake.state.codes.size).toBe(1);
  });

  it("U3 a burn error fails closed: server_error redirect, no code, no grant row", async () => {
    const c = await toConsent();
    const orig = fake.state.burned.add.bind(fake.state.burned);
    fake.state.burned.add = () => { throw new Error("db down"); };
    try {
      const r = await post(c.cookie, { csrf: c.csrf, decision: "allow" });
      expect(r.status).toBe(303);
      expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("server_error");
      expect(new URL(r.headers.get("location")!).searchParams.get("code")).toBeNull();
    } finally { fake.state.burned.add = orig; }
    expect(fake.state.codes.size).toBe(0);
    expect(grantedRows()).toHaveLength(0);
  });

  it("U4 a person revoked between the page and Allow: the burn happens, nothing is minted, refusal row 'revoked'", async () => {
    const c = await toConsent();
    fake.addPerson(ALICE, undefined, "revoked");
    const r = await post(c.cookie, { csrf: c.csrf, decision: "allow" });
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(fake.state.codes.size).toBe(0);
    expect(refusalReasons().some((x) => x.includes("revoked"))).toBe(true);
  });

  it("U5 two consent pages for the same person are independent (burning one does not burn the other)", async () => {
    const a = await toConsent();
    const b = await toConsent();
    expect((await post(a.cookie, { csrf: a.csrf, decision: "deny" })).status).toBe(303);
    expect(new URL((await post(b.cookie, { csrf: b.csrf, decision: "allow" })).headers.get("location")!).searchParams.get("code")).toBeTruthy();
    expect(fake.state.burned.size).toBe(2);
  });
});
