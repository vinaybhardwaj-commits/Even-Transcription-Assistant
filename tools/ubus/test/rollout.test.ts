import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jwksUrlForTeam, verifyRs256 } from "../src/access-jwt.js";
import type { Caller } from "../src/bus.js";
import { createHttpServer } from "../src/http.js";
import { caller, register, setup } from "./helpers.js";

const AUD = "aud-tag-1";
const TEAM = "team.cloudflareaccess.com";

function toolText(json: Record<string, unknown>): Record<string, unknown> {
  const result = json.result as { content?: Array<{ text: string }> };
  return JSON.parse(result.content?.[0]?.text || "{}") as Record<string, unknown>;
}

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function post(port: number, body: unknown, headers: Record<string, string> = {}, path = "/mcp") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function call(name: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

test("a stateless caller resumes by handle, from, or machine/runtime/session", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const reg = await rig.ubus.call(
      "ubus_register",
      { handle: "grok-bot", machine: "opd-bot-1", runtime: "grok", session: "grok-bot-main", owner: "v", orchestrator: "v" },
      { machine: "unknown", machineVerified: false, via: "cloudflare", platformClass: "grok-platform" },
    );
    assert.equal(reg.ok, true);
    assert.equal(reg.address, "agent://opd-bot-1/grok/grok-bot-main");
    assert.equal(reg.presence, "turn-based");

    const none: Caller = { machine: "unknown", machineVerified: false, via: "cloudflare", platformClass: "grok-platform" };
    const body = { to: ["fable"], subject: "ping", body: "count=1 path=~/dev/eta-lab/p.json" };
    const missing = await rig.ubus.call("ubus_send", body, none);
    assert.equal(missing.error, "not_registered");

    const byHandle = await rig.ubus.call("ubus_send", { ...body, handle: "grok-bot" }, none);
    assert.equal(byHandle.ok, true);
    const byFrom = await rig.ubus.call("ubus_send", { ...body, from: "grok-bot" }, none);
    assert.equal(byFrom.ok, true);
    const byFromObj = await rig.ubus.call("ubus_send", { ...body, from: { handle: "grok-bot" } }, none);
    assert.equal(byFromObj.ok, true);
    const bySession = await rig.ubus.call(
      "ubus_send",
      { ...body, machine: "opd-bot-1", runtime: "grok", session: "grok-bot-main" },
      none,
    );
    assert.equal(bySession.ok, true);

    const otherClass: Caller = { ...none, platformClass: "cursor-cloud" };
    const stolen = await rig.ubus.call("ubus_send", { ...body, handle: "grok-bot" }, otherClass);
    assert.equal(stolen.error, "not_registered");

    const unknown = await rig.ubus.call("ubus_send", { ...body, handle: "not-a-bot" }, none);
    assert.equal(unknown.error, "not_registered");

    const honor = await rig.ubus.call("ubus_send", { ...body, handle: "grok-bot" }, caller());
    assert.equal(honor.ok, true);
  } finally {
    rig.cleanup();
  }
});

test("HTTP without Mcp-Session-Id still sends when the tool args carry the registered handle", async () => {
  const rig = setup((cfg) => {
    cfg.edgeAuth.enabled = true;
    const dir = mkdtempSync(join(tmpdir(), "ubus-state-"));
    cfg.edgeAuth.tokensFile = join(dir, "tokens.json");
    writeFileSync(
      cfg.edgeAuth.tokensFile,
      JSON.stringify({
        clients: [
          { id: "grok-id", secret: "grok-secret", class: "grok-platform" },
          { id: "cursor-id", secret: "cursor-secret", class: "cursor-cloud" },
        ],
      }),
    );
  });
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  const grok = { "cf-ray": "ray", "cf-access-client-id": "grok-id", "cf-access-client-secret": "grok-secret" };
  const cursor = { "cf-ray": "ray", "cf-access-client-id": "cursor-id", "cf-access-client-secret": "cursor-secret" };
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const reg = await post(
      port,
      call("ubus_register", {
        handle: "grok-bot",
        machine: "opd-bot-1",
        runtime: "grok",
        session: "grok-bot-main",
        owner: "v",
        orchestrator: "v",
      }),
      grok,
    );
    const registered = toolText(reg.json);
    assert.equal(registered.ok, true);
    assert.equal(registered.handle, "grok-bot");
    const send = await post(
      port,
      call(
        "ubus_send",
        { handle: "grok-bot", to: ["fable"], subject: "ping", body: "count=1 path=~/dev/eta-lab/p.json" },
        2,
      ),
      grok,
    );
    assert.equal(toolText(send.json).ok, true);
    const bare = await post(
      port,
      call("ubus_send", { to: ["fable"], subject: "ping", body: "count=1 path=~/dev/eta-lab/p.json" }, 3),
      grok,
    );
    assert.equal(toolText(bare.json).error, "not_registered");
    const stolen = await post(
      port,
      call("ubus_send", { handle: "grok-bot", to: ["fable"], subject: "ping", body: "count=1 path=~/dev/eta-lab/p.json" }, 4),
      cursor,
    );
    assert.equal(toolText(stolen.json).error, "not_registered");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

function jwtFixture(): { privateKey: KeyObject; jwk: JsonWebKey; token: (claims: Record<string, unknown>, kid?: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  jwk.kid = "k1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const token = (claims: Record<string, unknown>, kid = "k1") => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey);
    return `${h}.${p}.${sig.toString("base64url")}`;
  };
  return { privateKey, jwk, token };
}

test("Cf-Access-Jwt-Assertion verifies against the team JWKS and maps common_name to the token class", async () => {
  const { jwk, token } = jwtFixture();
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: now + 600,
    iat: now,
    nbf: now,
    common_name: "grok-id",
    sub: "service-token",
  };
  let fetches = 0;
  const rig = setup((cfg) => {
    cfg.edgeAuth.enabled = true;
    cfg.edgeAuth.teamDomain = TEAM;
    cfg.edgeAuth.audience = AUD;
    const dir = mkdtempSync(join(tmpdir(), "ubus-jwt-"));
    cfg.edgeAuth.tokensFile = join(dir, "tokens.json");
    cfg.edgeAuth.secretPathsFile = join(dir, "paths.json");
    writeFileSync(cfg.edgeAuth.tokensFile, JSON.stringify({ clients: [{ id: "grok-id", secret: "grok-secret", class: "grok-platform" }] }));
    writeFileSync(cfg.edgeAuth.secretPathsFile, JSON.stringify({ paths: [{ secret: "path-secret-value", class: "grok-platform" }] }));
  });
  const server = createHttpServer(rig.ubus, rig.cfg, {
    whois: rig.whois,
    fetchJwks: async (url) => {
      fetches += 1;
      assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
      return { keys: [jwk] };
    },
  });
  const port = await listen(server);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  try {
    const ok = await post(port, init, { "cf-ray": "ray", "cf-access-jwt-assertion": token(claims) });
    assert.equal(ok.status, 200);
    const again = await post(port, init, { "cf-ray": "ray", "cf-access-jwt-assertion": token(claims) });
    assert.equal(again.status, 200);
    assert.equal(fetches, 1);

    const badSig = token(claims).slice(0, -4) + "aaaa";
    const forged = await post(port, init, { "cf-ray": "ray", "cf-access-jwt-assertion": badSig });
    assert.equal(forged.status, 401);
    const wrongAud = await post(port, init, { "cf-ray": "ray", "cf-access-jwt-assertion": token({ ...claims, aud: ["other"] }) });
    assert.equal(wrongAud.status, 401);
    const unknown = await post(port, init, { "cf-ray": "ray", "cf-access-jwt-assertion": token({ ...claims, common_name: "not-ours" }) });
    assert.equal(unknown.status, 401);
    const expired = await post(port, init, { "cf-ray": "ray", "cf-access-jwt-assertion": token({ ...claims, exp: now - 120 }) });
    assert.equal(expired.status, 401);
    const path = await post(port, init, { "cf-ray": "ray" }, "/mcp/path-secret-value");
    assert.equal(path.status, 200);

    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const headers = { "cf-ray": "ray", "cf-access-jwt-assertion": token(claims) };
    const reg = await post(
      port,
      call("ubus_register", { handle: "grok-bot", machine: "opd-bot-1", runtime: "grok", session: "grok-bot-main", owner: "v", orchestrator: "v" }, 2),
      headers,
    );
    assert.equal(toolText(reg.json).ok, true);
    const send = await post(
      port,
      call("ubus_send", { from: { handle: "grok-bot" }, to: ["fable"], subject: "ping", body: "count=1 path=~/dev/eta-lab/p.json" }, 3),
      headers,
    );
    assert.equal(toolText(send.json).ok, true);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test("RS256 verification rejects a non-RS256 header and a bad issuer is not required of the raw verifier", () => {
  assert.equal(jwksUrlForTeam("team.cloudflareaccess.com"), "https://team.cloudflareaccess.com/cdn-cgi/access/certs");
  assert.equal(jwksUrlForTeam("https://team.cloudflareaccess.com/"), "https://team.cloudflareaccess.com/cdn-cgi/access/certs");
  assert.equal(jwksUrlForTeam("REPLACE_TEAM.cloudflareaccess.com"), null);
  const { jwk, token } = jwtFixture();
  const now = Date.now();
  const good = token({ exp: Math.floor(now / 1000) + 60, common_name: "grok-id" });
  assert.equal(verifyRs256(good, [jwk], now)?.common_name, "grok-id");
  const header = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
  const payload = good.split(".")[1]!;
  assert.equal(verifyRs256(`${header}.${payload}.sig`, [jwk], now), null);
});
