/**
 * TUNNEL-HARDENING P2(b) — Cloudflare Access service-token headers. Pure helper: when they are sent, and above all when
 * they are NOT. A secret sent to the wrong host is the failure that matters here.
 */
import { describe, it, expect } from "vitest";
import {
  hostAllowedForAccess, serviceAccessConfigured, serviceAccessHeaders, serviceAccessProblems, withServiceAccess,
} from "@/lib/service-access";
import { poolConfigProblems } from "@/lib/service-pool";

const ON = { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "sekret" };
const HDRS = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "sekret" };

describe("serviceAccessHeaders — sent only when configured AND the host is a service host", () => {
  it("DARK: nothing configured → no headers", () => {
    expect(serviceAccessHeaders("https://whisper-box.llmvinayminihome.uk/inference", {})).toEqual({});
  });
  it("both set, service host → both headers", () => {
    expect(serviceAccessHeaders("https://whisper-box.llmvinayminihome.uk/inference", ON)).toEqual(HDRS);
  });
  it("a half-set pair sends NOTHING, either way round, and is reported by name", () => {
    const idOnly = { CF_ACCESS_CLIENT_ID: "x" };
    const secretOnly = { CF_ACCESS_CLIENT_SECRET: "y" };
    expect(serviceAccessHeaders("https://a.llmvinayminihome.uk/", idOnly)).toEqual({});
    expect(serviceAccessHeaders("https://a.llmvinayminihome.uk/", secretOnly)).toEqual({});
    expect(serviceAccessProblems(idOnly)).toEqual(["CF_ACCESS_CLIENT_SECRET"]);
    expect(serviceAccessProblems(secretOnly)).toEqual(["CF_ACCESS_CLIENT_ID"]);
    expect(serviceAccessProblems(ON)).toEqual([]);
    expect(serviceAccessProblems({})).toEqual([]);
    expect(serviceAccessConfigured(idOnly)).toBe(false);
    expect(serviceAccessConfigured(ON)).toBe(true);
  });
  it("blank or whitespace values are unset", () => {
    expect(serviceAccessHeaders("https://a.llmvinayminihome.uk/", { CF_ACCESS_CLIENT_ID: "  ", CF_ACCESS_CLIENT_SECRET: "y" })).toEqual({});
  });
  it("never to a host outside the suffix: another vendor, a lookalike, the bare apex", () => {
    for (const u of [
      "https://api.sarvam.ai/x", "https://api.resend.com/emails", "https://evil.example/whisper.llmvinayminihome.uk",
      "https://evil-llmvinayminihome.uk/", "https://llmvinayminihome.uk.evil.example/", "https://llmvinayminihome.uk/",
    ]) expect(serviceAccessHeaders(u, ON), u).toEqual({});
  });
  it("never over cleartext, and never for a URL that does not parse", () => {
    expect(serviceAccessHeaders("http://whisper-box.llmvinayminihome.uk/inference", ON)).toEqual({});
    expect(serviceAccessHeaders("not a url", ON)).toEqual({});
    expect(hostAllowedForAccess("", ON)).toBe(false);
  });
  it("the suffix list is configurable, dot boundary kept, case-insensitive", () => {
    const env = { ...ON, CF_ACCESS_HOST_SUFFIXES: "example.org, .Other.Net" };
    expect(serviceAccessHeaders("https://svc.example.org/", env)).toEqual(HDRS);
    expect(serviceAccessHeaders("https://SVC.other.net/", env)).toEqual(HDRS);
    expect(serviceAccessHeaders("https://notexample.org/", env)).toEqual({});
    expect(serviceAccessHeaders("https://whisper-box.llmvinayminihome.uk/", env), "the default is REPLACED, not added to").toEqual({});
  });
});

describe("withServiceAccess — the init, untouched when there is nothing to add", () => {
  it("NO-ENV IDENTITY: the very same object comes back", () => {
    const init = { method: "POST", cache: "no-store" as const };
    expect(withServiceAccess("https://a.llmvinayminihome.uk/x", init, {})).toBe(init);
    expect(withServiceAccess("https://api.sarvam.ai/x", init, ON)).toBe(init);
  });
  it("adds the headers and keeps the caller's own, whatever their spelling", () => {
    const out = withServiceAccess("https://a.llmvinayminihome.uk/x", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" } }, ON);
    const h = new Headers(out.headers);
    expect(h.get("cf-access-client-id")).toBe("id.access");
    expect(h.get("cf-access-client-secret")).toBe("sekret");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("authorization")).toBe("Bearer t");
    expect(out.method).toBe("POST");
  });
  it("never overrides a header the caller set", () => {
    const out = withServiceAccess("https://a.llmvinayminihome.uk/x", { headers: { "cf-access-client-id": "mine" } }, ON);
    expect(new Headers(out.headers).get("CF-Access-Client-Id")).toBe("mine");
  });
  it("with no init at all, still returns something fetch accepts", () => {
    expect(withServiceAccess("https://a.llmvinayminihome.uk/x", undefined, {})).toEqual({});
  });
});

describe("the health tool names a half-set pair, never a value", () => {
  it("poolConfigProblems lists the missing half", () => {
    expect(poolConfigProblems({ CF_ACCESS_CLIENT_ID: "x" })).toContain("CF_ACCESS_CLIENT_SECRET");
    expect(JSON.stringify(poolConfigProblems({ CF_ACCESS_CLIENT_ID: "sekret-value" }))).not.toContain("sekret-value");
    expect(poolConfigProblems(ON)).not.toContain("CF_ACCESS_CLIENT_ID");
  });
});
