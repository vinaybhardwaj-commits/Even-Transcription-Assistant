import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FORBIDDEN_DOCTOR_KEYS, findForbidden, portalJson, stripForbidden } from "@/lib/portal/forbidden-keys";

describe("forbidden doctor keys", () => {
  it("lists the agreed keys and not the doctor-visible ones", () => {
    for (const k of ["jev_score", "cdmss_doctor_uid", "triage_rationale", "stamp_reason", "engineVersion"]) {
      expect(FORBIDDEN_DOCTOR_KEYS).toContain(k);
    }
    for (const k of ["rationale", "evidence", "citations", "subject", "verdict", "status"]) {
      expect(FORBIDDEN_DOCTOR_KEYS).not.toContain(k);
    }
  });

  it("strips nested objects and arrays, case-insensitively", () => {
    const input = {
      ok: true,
      cards: [{ subject: "s", Jev_Score: 3, evidence: ["e"], inner: { MODEL: "m", verdict: "v", deep: [{ Provenance: 1, status: "open" }] } }],
      Engine: "x",
    };
    expect(stripForbidden(input)).toEqual({
      ok: true,
      cards: [{ subject: "s", evidence: ["e"], inner: { verdict: "v", deep: [{ status: "open" }] } }],
    });
  });

  it("never mutates its input", () => {
    const input = { a: [{ confidence: 0.9, keep: 1 }], model: "m" };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = stripForbidden(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.a).not.toBe(input.a);
  });

  it("leaves clean bodies byte-identical, including key order, nulls and dates", () => {
    const clean = { ok: true, z: 1, a: [1, "x", null, { b: new Date(0) }], rationale: "r", status: "s" };
    expect(JSON.stringify(stripForbidden(clean))).toBe(JSON.stringify(clean));
  });

  it("findForbidden returns key paths only, never values", () => {
    const found = findForbidden({ cards: [{ ok: 1, jev_score: "SECRET-VALUE" }], nested: { Model: "m2" }, status: "x" });
    expect(found).toEqual(["cards[0].jev_score", "nested.Model"]);
    expect(JSON.stringify(found)).not.toContain("SECRET-VALUE");
    expect(findForbidden({ ok: true, rows: [] })).toEqual([]);
    expect(findForbidden(null)).toEqual([]);
    expect(findForbidden("model")).toEqual([]);
  });
});

describe("portalJson", () => {
  it("returns a clean body unchanged with init preserved", async () => {
    const body = { ok: true, rows: [{ id: 1 }] };
    const res = portalJson(body, { status: 201, headers: { "Cache-Control": "no-store" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(JSON.stringify(body));
  });

  it("strips forbidden keys and logs key paths only in production", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = portalJson({ ok: true, card: { jev_score: "SECRET-VALUE", subject: "s" } });
      expect(JSON.parse(await res.text())).toEqual({ ok: true, card: { subject: "s" } });
      expect(err).toHaveBeenCalledTimes(1);
      const logged = err.mock.calls[0].join(" ");
      expect(logged).toContain("portal_forbidden_keys");
      expect(logged).toContain("card.jev_score");
      expect(logged).not.toContain("SECRET-VALUE");
    } finally {
      err.mockRestore();
      env.NODE_ENV = prev;
    }
  });
});

/** True if the source builds a JSON response without going through portalJson (whitespace/alias tolerant). */
function findRawJson(text: string): boolean {
  const names = new Set(["NextResponse", "Response"]);
  Array.from(text.matchAll(/\b(?:Next)?Response\s+as\s+(\w+)/g)).forEach((m) => names.add(m[1]));
  Array.from(text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:Next)?Response\b(?!\s*[.(])/g)).forEach((m) => names.add(m[1]));
  const n = Array.from(names).join("|");
  if (new RegExp(`\\b(?:${n})\\s*(?:\\.\\s*json\\b|\\[\\s*["'\`]json["'\`]\\s*\\])`).test(text)) return true;
  if (/\b(?:const|let|var)\s*\{[^}]*\bjson\b[^}]*\}\s*=\s*(?:Next)?Response\b/.test(text)) return true;
  return /new\s+(?:Next)?Response\s*\(\s*JSON\s*\.\s*stringify/.test(text);
}

describe("source guard: portal API routes", () => {
  const root = path.resolve(__dirname, "../../app/api/portal");
  const routes: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^route\.tsx?$/.test(e.name)) routes.push(p);
    }
  })(root);

  // Routes that never return a JSON body (HTML / PDF only).
  const NON_JSON = new Set(["findings/pdf/route.ts"]);
  const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");

  it("finds the portal routes", () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it("no route builds a JSON response outside portalJson", () => {
    const bad = routes.filter((p) => findRawJson(fs.readFileSync(p, "utf8")));
    expect(bad.map(rel)).toEqual([]);
  });

  it("findRawJson tolerates whitespace, aliasing, brackets and destructuring", () => {
    expect(findRawJson("return NextResponse.json({});")).toBe(true);
    expect(findRawJson("return NextResponse . json ({});")).toBe(true);
    expect(findRawJson("return NextResponse\n  .json({});")).toBe(true);
    expect(findRawJson('return NextResponse["json"]({});')).toBe(true);
    expect(findRawJson("return Response.json({});")).toBe(true);
    expect(findRawJson('import { NextResponse as NR } from "next/server";\nreturn NR.json({});')).toBe(true);
    expect(findRawJson("const R = NextResponse;\nreturn R.json({});")).toBe(true);
    expect(findRawJson("const { json } = NextResponse;\nreturn json({});")).toBe(true);
    expect(findRawJson("const j = NextResponse.json.bind(NextResponse);")).toBe(true);
    expect(findRawJson("return new Response(JSON.stringify(x));")).toBe(true);
    expect(findRawJson("return portalJson({ ok: true });")).toBe(false);
    expect(findRawJson("const j = await res.json();")).toBe(false);
  });

  it("every JSON-returning route goes through portalJson", () => {
    const missing = routes.filter((p) => !NON_JSON.has(rel(p)) && !/\bportalJson\(/.test(fs.readFileSync(p, "utf8")));
    expect(missing.map(rel)).toEqual([]);
  });
});
