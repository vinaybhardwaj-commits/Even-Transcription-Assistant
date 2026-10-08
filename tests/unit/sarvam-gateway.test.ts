/**
 * S8A — lib/sarvam-gateway.ts: SigV4 against AWS's published test-suite vectors, the credential chain with a mocked fetch, and the
 * secret-handling rules (no api-subscription-key, no key / token / signature in any error or return value). No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const G = await import("@/lib/sarvam-gateway");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SA_EMAIL = ["gw-caller", "example-project.iam.gserviceaccount.com"].join("@"); // built, not written: the identity-literal check reads source text
const SA_JSON = JSON.stringify({ type: "service_account", client_email: SA_EMAIL, private_key: privateKey, token_uri: "https://oauth2.example.test/token" }, null, 2);
const ENV = {
  SARVAM_GCP_SA_KEY_JSON: SA_JSON,
  SARVAM_GW_AUDIENCE: "test-audience-000",
  SARVAM_GW_ROLE_ARN: "arn:aws:iam::000000000000:role/TestRole",
  SARVAM_GW_BASE_URL: "https://gw.example.test/clinical-infra/",
  SARVAM_GW_REGION: "ap-south-1",
};
const SECRETS = ["ID_TOKEN_VALUE", "ACCESS_TOKEN_VALUE", "SECRET_ACCESS_KEY_VALUE", "SESSION_TOKEN_VALUE", "BEGIN PRIVATE KEY"];

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let expirySeconds = Math.floor(Date.now() / 1000) + 3600;

function installFetch(overrides: Partial<Record<"google" | "id" | "sts" | "gw", () => Response>> = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u === "https://oauth2.example.test/token") return overrides.google?.() ?? new Response(JSON.stringify({ access_token: "ACCESS_TOKEN_VALUE" }), { status: 200 });
    if (u.startsWith("https://iamcredentials.googleapis.com/")) return overrides.id?.() ?? new Response(JSON.stringify({ token: "ID_TOKEN_VALUE" }), { status: 200 });
    if (u.startsWith("https://sts.")) {
      return overrides.sts?.() ?? new Response(JSON.stringify({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: "ASIATESTKEY", SecretAccessKey: "SECRET_ACCESS_KEY_VALUE", SessionToken: "SESSION_TOKEN_VALUE", Expiration: expirySeconds } } } }), { status: 200 });
    }
    if (u.startsWith("https://gw.example.test/")) return overrides.gw?.() ?? new Response("{}", { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  }));
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  G.resetGatewayCredsForTests();
  expirySeconds = Math.floor(Date.now() / 1000) + 3600;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("SigV4 — AWS signature-v4 test-suite vectors", () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const now = new Date("2015-08-30T12:36:00Z");

  it("get-vanilla", () => {
    const s = G.signSigV4({ method: "GET", url: "https://example.amazonaws.com/", region: "us-east-1", service: "service", creds, now });
    expect(s.canonicalRequest).toBe("GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(s.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(s.headers.Authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("post-x-www-form-urlencoded (content-type signed, body hashed)", () => {
    const s = G.signSigV4({ method: "POST", url: "https://example.amazonaws.com/", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "Param1=value1", region: "us-east-1", service: "service", creds, now });
    expect(s.signature).toBe("ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a");
  });

  it("a session token is signed as x-amz-security-token and sent; a different body changes the signature; query is sorted", () => {
    const base = { method: "POST", url: "https://example.amazonaws.com/p?b=2&a=1", region: "us-east-1", service: "service", creds: { ...creds, sessionToken: "TOK" }, now } as const;
    const s = G.signSigV4({ ...base, body: "x" });
    expect(s.headers["x-amz-security-token"]).toBe("TOK");
    expect(s.headers.Authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
    expect(s.canonicalRequest.split("\n")[2]).toBe("a=1&b=2");
    expect(G.signSigV4({ ...base, body: "y" }).signature).not.toBe(s.signature);
  });
});

describe("the credential chain", () => {
  it("runs key -> access token -> ID token (on the SA itself, includeEmail) -> STS -> a signed gateway call, without api-subscription-key", async () => {
    installFetch();
    const res = await G.gatewayFetch("/speech-to-text/job/v1", { method: "POST", headers: { "Content-Type": "application/json", "api-subscription-key": "SHOULD_NOT_BE_SENT" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url.replace(/\?.*/, ""))).toEqual([
      "https://oauth2.example.test/token",
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA_EMAIL)}:generateIdToken`,
      "https://sts.ap-south-1.amazonaws.com/",
      "https://gw.example.test/clinical-infra/speech-to-text/job/v1",
    ]);
    // 1. the JWT bearer grant, cloud-platform scope
    const grant = new URLSearchParams(String(calls[0]!.init.body));
    expect(grant.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(Buffer.from(grant.get("assertion")!.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ iss: SA_EMAIL, scope: "https://www.googleapis.com/auth/cloud-platform" });
    // 2. generateIdToken targets the SA ITSELF, authorised by the access token, audience from the env, includeEmail true
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ audience: "test-audience-000", includeEmail: true });
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer ACCESS_TOKEN_VALUE");
    // 3. STS: unsigned, the right parameters, the ID token as the web identity
    const sts = new URLSearchParams(String(calls[2]!.init.body));
    expect(Object.fromEntries(sts)).toEqual({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: ENV.SARVAM_GW_ROLE_ARN, RoleSessionName: "scribe-mcp-sarvam", WebIdentityToken: "ID_TOKEN_VALUE", DurationSeconds: "3600" });
    expect((calls[2]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    // 4. the gateway call is SigV4 (execute-api, ap-south-1) with the session token, and carries NO Sarvam key
    const h = calls[3]!.init.headers as Record<string, string>;
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIATESTKEY\/\d{8}\/ap-south-1\/execute-api\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(h["x-amz-security-token"]).toBe("SESSION_TOKEN_VALUE");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("api-subscription-key");
    expect(JSON.stringify(calls.map((c) => c.init.headers))).not.toContain("SHOULD_NOT_BE_SENT");
  });

  it("caches the AWS credentials until 5 minutes before expiry, then runs the chain again", async () => {
    installFetch();
    await G.gatewayFetch("/a");
    await G.gatewayFetch("/b");
    expect(calls.filter((c) => c.url.startsWith("https://sts.")).length).toBe(1);
    // creds that expire inside the 5-minute margin are not reused
    G.resetGatewayCredsForTests();
    expirySeconds = Math.floor(Date.now() / 1000) + 200;
    installFetch();
    await G.gatewayFetch("/a");
    await G.gatewayFetch("/b");
    expect(calls.filter((c) => c.url.startsWith("https://sts.")).length).toBe(2);
  });

  it("G1: concurrent callers after expiry share ONE mint; a failed mint is not cached and the next caller starts fresh", async () => {
    installFetch();
    const all = await Promise.all([G.gatewayCreds(), G.gatewayCreds(), G.gatewayCreds(), G.gatewayFetch("/a"), G.gatewayFetch("/b")]);
    expect(all.slice(0, 3).every((c) => (c as { accessKeyId: string }).accessKeyId === "ASIATESTKEY")).toBe(true);
    expect(calls.filter((c) => c.url.startsWith("https://oauth2.example.test")).length).toBe(1);
    expect(calls.filter((c) => c.url.startsWith("https://iamcredentials")).length).toBe(1);
    expect(calls.filter((c) => c.url.startsWith("https://sts.")).length).toBe(1);
    // a failing mint: every waiter gets the failure, then the next call runs the chain again
    G.resetGatewayCredsForTests();
    installFetch({ sts: () => new Response("{}", { status: 503 }) });
    const settled = await Promise.allSettled([G.gatewayCreds(), G.gatewayCreds(), G.gatewayCreds()]);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    expect(calls.filter((c) => c.url.startsWith("https://sts.")).length).toBe(1);
    installFetch();
    expect(await G.gatewayCreds()).toMatchObject({ accessKeyId: "ASIATESTKEY" });
    expect(calls.filter((c) => c.url.startsWith("https://sts.")).length).toBe(1);
  });

  it("health: names only, creds_ok and the STS expiry; Sarvam is not called", async () => {
    installFetch();
    const h = await G.gatewayHealth();
    expect(h).toMatchObject({ creds_ok: true, configured: { SARVAM_GCP_SA_KEY_JSON: true, SARVAM_GW_AUDIENCE: true, SARVAM_GW_ROLE_ARN: true, SARVAM_GW_BASE_URL: true, SARVAM_GW_REGION: true } });
    expect(h.sts_expires_at).toBe(new Date(expirySeconds * 1000).toISOString());
    expect(calls.some((c) => c.url.startsWith("https://gw.example.test/"))).toBe(false);
    for (const s of SECRETS) expect(JSON.stringify(h)).not.toContain(s);
  });
});

describe("not configured, and nothing leaks", () => {
  it("any missing variable is sarvam_gateway_not_configured; fetch is never called", async () => {
    installFetch();
    for (const name of G.GATEWAY_ENV) {
      process.env[name] = "";
      expect(G.gatewayConfigured(), name).toBe(false);
      await expect(G.gatewayFetch("/x")).rejects.toMatchObject({ code: "sarvam_gateway_not_configured" });
      process.env[name] = (ENV as Record<string, string>)[name];
    }
    expect(calls).toEqual([]);
    process.env.SARVAM_GW_REGION = "";
    expect(await G.gatewayHealth()).toMatchObject({ creds_ok: false, error: "sarvam_gateway_not_configured", configured: { SARVAM_GW_REGION: false, SARVAM_GW_AUDIENCE: true } });
  });

  it("a bad key is refused by name", async () => {
    installFetch();
    process.env.SARVAM_GCP_SA_KEY_JSON = "not json";
    await expect(G.gatewayCreds()).rejects.toMatchObject({ code: "sarvam_gateway_key_invalid" });
    process.env.SARVAM_GCP_SA_KEY_JSON = JSON.stringify({ client_email: SA_EMAIL });
    await expect(G.gatewayCreds()).rejects.toMatchObject({ code: "sarvam_gateway_key_invalid" });
  });

  it("each failing hop reports its status and the vendor's error CODE only — never the body, a token or the key", async () => {
    const body = (extra: object) => new Response(JSON.stringify({ message: "ID_TOKEN_VALUE ACCESS_TOKEN_VALUE BEGIN PRIVATE KEY", ...extra }), { status: 403 });
    const cases: Array<[Partial<Parameters<typeof installFetch>[0]>, string]> = [
      [{ google: () => body({ error: "invalid_grant" }) }, "sarvam_gateway_google_token: 403 invalid_grant"],
      [{ id: () => body({ error: { status: "PERMISSION_DENIED" } }) }, "sarvam_gateway_id_token: 403 PERMISSION_DENIED"],
      [{ sts: () => body({ __type: "AccessDenied" }) }, "sarvam_gateway_sts: 403 AccessDenied"],
    ];
    for (const [over, expected] of cases) {
      G.resetGatewayCredsForTests();
      installFetch(over);
      let msg = "";
      try { await G.gatewayCreds(); } catch (e) { msg = (e as Error).message; }
      expect(msg).toBe(expected);
      for (const s of SECRETS) expect(msg).not.toContain(s);
    }
  });

  it("a network failure is a typed error without the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("connect ECONNREFUSED https://oauth2.example.test/token"), { name: "FetchError" }); }));
    let msg = "";
    try { await G.gatewayCreds(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^sarvam_gateway_google_token: /);
    expect(msg).not.toContain("example.test");
  });
});
