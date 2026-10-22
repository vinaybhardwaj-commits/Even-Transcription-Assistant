/**
 * C4 / rule 25 (FRX-V10): the heard strength, frequency, duration and strength_heard_at of a confirm prompt live in `confirm_internal` and no
 * serializer returns them. This test enumerates the FreeScript routes and the MCP tool, feeds each a stored artifact that carries sentinel
 * values, and fails if the field or any sentinel appears in a response. A new route under app/api/freescript must be added here.
 * SQL is faked; every value is synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const SENT = { strength: "SENTINEL-STRENGTH-7731", freq: "SENTINEL-FREQ-4410", dur: "SENTINEL-DUR-5502", at: "SENTINEL-AT-88:88" };
const H = vi.hoisted(() => ({ respond: (_t: string): Row[] => [] }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray | string) => Promise.resolve(H.respond(typeof s === "string" ? s : s.join("$?"))) }));

import { freescriptCall, freescriptDayRead, rowView } from "@/lib/mcp/tools/freescript";
import { publicArtifact } from "@/lib/freescript/internal";
import type { ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const READ: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
const artifact = () => ({
  schema_version: "eta.freescript.v0.3",
  gp_extraction: { medicines: [] },
  confirm_prompts: [{ prompt_id: "p1", kind: "medicine", action: "start", drug: { generic: "PARACETAMOL" }, doctor_confirm_reason: ["notes_only"] }],
  confirm_internal: {
    p1: {
      strength: { value: SENT.strength, cited_spans: ["s1"], support: "supported" },
      frequency: { value: SENT.freq, cited_spans: ["s1"], support: "supported" },
      duration: { value: SENT.dur, cited_spans: ["s1"], support: "supported" },
      strength_heard_at: { clip_mmss: SENT.at, ist: SENT.at },
    },
  },
});
const stored = (): Row => ({
  run_id: 4, consult_uid: "synth-fs-1", prescription_uid: null, schema_version: "eta.freescript.v0.3", room_slug: "synth-room", room_id: "room_synth",
  ist_date: "2026-10-05", doctor_uid8: "cellfake", validator_ok: true, validator_errors: [], generator_code_sha: "a".repeat(64), generator_prompt_sha: "b".repeat(64),
  model_id: "anthropic.claude", cost_usd: 0.02, created_at: "2026-10-05T05:00:00.000Z", artifact: artifact(), completion_required: [],
});
const leaks = (v: unknown) => {
  const t = JSON.stringify(v);
  return [...Object.values(SENT), "confirm_internal"].filter((x) => t.includes(x));
};

beforeEach(() => {
  H.respond = () => [stored()];
  process.env.ETA_FREESCRIPT = "1";
});

const routesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routesUnder(p) : n === "route.ts" ? [p] : [];
  });

describe("C4: confirm_internal never leaves through a read", () => {
  it("the route list is the one this test covers", () => {
    expect(routesUnder("app/api/freescript").sort()).toEqual([
      "app/api/freescript/day/route.ts",
      "app/api/freescript/ingest/route.ts",
      "app/api/freescript/pending/route.ts",
    ]);
    // the P5 note endpoint and an artifact route do not exist yet; when one appears this test must cover it
    expect(existsSync("app/api/freescript/artifact")).toBe(false);
    expect(existsSync("app/api/freescript/note")).toBe(false);
  });
  it("/day reads through freescriptDayRead and rowView", async () => {
    const out = await freescriptDayRead("2026-10-05");
    expect(out).toMatchObject({ ok: true, n: 1 });
    expect(leaks(out)).toEqual([]);
    expect(leaks(rowView(stored()))).toEqual([]);
  });
  it("scribe_freescript returns no internal field for any selector", async () => {
    for (const args of [{ encounter_id: "synth-fs-1" }, { consult_uid: "synth-fs-1" }, { ist_date: "2026-10-05" }, { room: "synth-room", date: "2026-10-05" },
      { doctor_uid8: "cellfake", date_from: "2026-10-01", date_to: "2026-10-05" }]) {
      expect(leaks(await freescriptCall(args, READ))).toEqual([]);
    }
  });
  it("/pending returns job fields only and /ingest returns counts only", () => {
    const pending = readFileSync("app/api/freescript/pending/route.ts", "utf8");
    expect(pending).not.toMatch(/freescript_artifact|confirm_internal|\.artifact\b/);
    const ingest = readFileSync("app/api/freescript/ingest/route.ts", "utf8");
    expect(ingest).not.toMatch(/confirm_internal/);
    expect(ingest).toMatch(/run_id|inserted/);
  });
  it("only an explicit internal read, with the server-side flag on, returns the field", () => {
    expect(leaks(publicArtifact(artifact()))).toEqual([]);
    expect(leaks(publicArtifact(artifact(), { internal: true }))).toEqual([]); // the caller's request alone is not enough
    process.env.FREESCRIPT_INTERNAL_READ = "1";
    try {
      expect(leaks(publicArtifact(artifact(), { internal: true })).length).toBeGreaterThan(0);
      expect(leaks(publicArtifact(artifact()))).toEqual([]); // the flag alone is not enough either
    } finally {
      delete process.env.FREESCRIPT_INTERNAL_READ;
    }
    expect(publicArtifact(null)).toBeNull();
  });
  it("the debug flag is read from the server environment only", () => {
    for (const f of ["app/api/freescript/day/route.ts", "app/api/freescript/pending/route.ts", "app/api/freescript/ingest/route.ts", "lib/mcp/tools/freescript.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/FREESCRIPT_INTERNAL_READ|internal:\s*true/);
    }
  });
  it("no page or admin surface reads the stored artifact", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p); }
        else if (/\.(tsx?|mjs)$/.test(n) && /freescript_artifact|confirm_internal/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk("app");
    expect(hits).toEqual([]);
  });
});
