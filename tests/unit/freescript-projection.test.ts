/**
 * H2 (FRX-V10 refute of 6efbc5fc): a sentinel planted in EVERY string field of a full v10 artifact (the contract's synthetic example) must not leave
 * through any read route, except the fields the projection explicitly serves (ALLOWED below). SQL is faked; every value is synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ respond: (_t: string): Row[] => [] }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray | string) => Promise.resolve(H.respond(typeof s === "string" ? s : s.join("$?"))) }));

import { freescriptCall, freescriptDayRead, rowView } from "@/lib/mcp/tools/freescript";
import { publicArtifact } from "@/lib/freescript/internal";
import type { ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const READ: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
const EXAMPLE = "tools/eta2freescript/contract_v1/examples/ex1-fever-patient-own-drug.json";

// The fields a read serves. Anything else under the artifact is dropped. Kept small on purpose.
const SPAN_KEEP = "span_id|segment_refs|t0|t1|label|lang|span_source|order_capable|boundary_quarantined|relay_of";
const PROV_KEEP = "item_id|kind|status|negated|support|cited_spans|alignment|span_source|json_pointer|prompt_id|withheld_reason|flags";
const ALLOWED: RegExp[] = [
  /^(schema_version|artifact_id|supersedes|created_at|note_text)$/,
  /^(emission|policy|generator|encounter|pulse_link|qa)\./,
  /^roster\[\d+\]\./,
  /^(gp_extraction|confirm_prompts|doctor_words|red_flags|withheld|kept_out|completion_required)\b/,
  new RegExp(`^spans\\[\\d+\\]\\.(${SPAN_KEEP})\\b`),
  new RegExp(`^provenance\\[\\d+\\]\\.(${PROV_KEEP})\\b`),
];

type Planted = Map<string, string>; // sentinel -> path
function plant(node: unknown, path: string, out: Planted): unknown {
  if (typeof node === "string") {
    const s = `SNTL${out.size.toString(36).toUpperCase()}ZZ`;
    out.set(s, path);
    return s;
  }
  if (Array.isArray(node)) return node.map((v, i) => plant(v, `${path}[${i}]`, out));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node as Row).map(([k, v]) => [k, plant(v, path ? `${path}.${k}` : k, out)]));
  }
  return node;
}

function fullArtifact(): { artifact: Row; planted: Planted } {
  const base = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Row;
  // fields the v10 mapper writes that the example may not carry
  base.confirm_internal = { p1: { strength: { value: "x", cited_spans: ["s1"], support: "supported" }, strength_heard_at: { clip_mmss: "01:02", ist: "10:00" } } };
  base.room_facts = { allergies: [{ name: "x" }], vitals: [{ name: "x", value: "x" }] };
  base.slots = [{ slot_id: "x", parts: { strength: "x" } }];
  base.withheld = [{ item_id: "x", field_pointer: "/x", reason_code: "frame", span_ids: ["s1"], prompt_id: "x", stage: "floor" }];
  base.kept_out = [{ item_id: "x", kind: "advice", stage: "mapper", span_ids: ["s1"] }];
  const planted: Planted = new Map();
  return { artifact: plant(base, "", planted) as Row, planted };
}

const stored = (artifact: Row, completion: unknown): Row => ({
  run_id: 4, consult_uid: "synth-fs-1", prescription_uid: null, schema_version: "eta.freescript.v0.3", room_slug: "synth-room", room_id: "room_synth",
  ist_date: "2026-10-05", doctor_uid8: "cellfake", validator_ok: true, validator_errors: [], generator_code_sha: "a".repeat(64), generator_prompt_sha: "b".repeat(64),
  model_id: "anthropic.claude", cost_usd: 0.02, created_at: "2026-10-05T05:00:00.000Z", artifact, completion_required: completion,
});

function leakedPaths(out: unknown, planted: Planted): string[] {
  const t = JSON.stringify(out);
  return [...planted].filter(([s]) => t.includes(s)).map(([, p]) => p);
}
const notAllowed = (paths: string[]) => [...new Set(paths.filter((p) => !ALLOWED.some((re) => re.test(p))))].sort();

beforeEach(() => {
  process.env.ETA_FREESCRIPT = "1";
  delete process.env.FREESCRIPT_INTERNAL_READ;
});

describe("H2: the read projection serves only what it lists", () => {
  it("the fixture is a full v10 artifact", () => {
    const { artifact, planted } = fullArtifact();
    for (const k of ["spans", "provenance", "confirm_prompts", "room_facts", "confirm_internal", "roster", "doctor_words"]) expect(artifact).toHaveProperty(k);
    expect(planted.size).toBeGreaterThan(150);
  });
  it("publicArtifact drops quotes, provenance text and evidence, room facts, slots and confirm_internal", () => {
    const { artifact, planted } = fullArtifact();
    expect(notAllowed(leakedPaths(publicArtifact(artifact), planted))).toEqual([]);
    const o = publicArtifact(artifact) as Row;
    for (const k of ["room_facts", "confirm_internal", "slots"]) expect(o).not.toHaveProperty(k);
  });
  it("rowView, /day and scribe_freescript serve the same projection", async () => {
    const { artifact, planted } = fullArtifact();
    const comp = [{ kind: "x", item_id: "i1", prompt: "p" }];
    H.respond = () => [stored(artifact, comp)];
    expect(notAllowed(leakedPaths(rowView(stored(artifact, comp)), planted))).toEqual([]);
    expect(notAllowed(leakedPaths(await freescriptDayRead("2026-10-05"), planted))).toEqual([]);
    for (const args of [{ encounter_id: "synth-fs-1" }, { consult_uid: "synth-fs-1" }, { ist_date: "2026-10-05" }, { room: "synth-room", date: "2026-10-05" },
      { doctor_uid8: "cellfake", date_from: "2026-10-01", date_to: "2026-10-05" }]) {
      expect(notAllowed(leakedPaths(await freescriptCall(args, READ), planted))).toEqual([]);
    }
  });
  it("the quotes, the provenance text and the evidence specifically stay home", () => {
    const { artifact, planted } = fullArtifact();
    const leaked = leakedPaths(publicArtifact(artifact), planted);
    expect(leaked.filter((p) => /quote_(en|native)$|^provenance\[\d+\]\.(text|evidence|decision|names)|^room_facts|^confirm_internal|^slots/.test(p))).toEqual([]);
  });
  it("the allowlist is small and every entry is used by the fixture", () => {
    expect(ALLOWED.length).toBeLessThanOrEqual(7);
    const { artifact, planted } = fullArtifact();
    const served = leakedPaths(publicArtifact(artifact), planted);
    for (const re of ALLOWED) expect(served.some((p) => re.test(p)) || re.source.includes("completion_required")).toBe(true);
  });
});
