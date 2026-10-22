/**
 * Fix2 H2: an artifact built THROUGH THE REAL PIPELINE (tools/eta2freescript/tests/gen_c4_fixture.py -> tests/c4_fixtures/fixtures/synthetic/pipeline_artifact.json; synthetic, sentinels
 * planted in the turns that hold heard strength, frequency, duration, timing, a slot, an off-catalogue brand, a vital and a previous patient) is fed through
 * publicArtifact, rowView, freescriptDayRead and every freescriptCall selector. No sentinel and no heard value may leave except in a field listed in ALLOWED.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ respond: (_t: string): Row[] => [] }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray | string) => Promise.resolve(H.respond(typeof s === "string" ? s : s.join("$?"))) }));

import { freescriptCall, freescriptDayRead, rowView } from "@/lib/mcp/tools/freescript";
import { publicArtifact, publicCompletion } from "@/lib/freescript/internal";
import type { ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const READ: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
const FIX = JSON.parse(readFileSync("tools/eta2freescript/tests/c4_fixtures/fixtures/synthetic/pipeline_artifact.json", "utf8")) as { artifact: Row; completion_required: Row[]; sentinels: Record<string, string>; heard: string[] };

// Product content, gated by the number gate and the word gate: it may carry the drug's own words and posted text. Nothing else may carry a heard value.
const ALLOWED: RegExp[] = [/^(artifact\.)?note_text$/, /^(artifact\.)?gp_extraction\b/, /^(artifact\.)?confirm_prompts\[\d+\]\.drug\.(spoken|generic|brand_recognised|base_molecule)$/];
const HEARD_ONLY_IN_INTERNAL = ["twice daily", "5 days", "after food", "three days", "a month", "at night"];

function leaves(n: unknown, p = ""): [string, string][] {
  if (typeof n === "string") return [[p, n]];
  if (Array.isArray(n)) return n.flatMap((v, i) => leaves(v, `${p}[${i}]`));
  if (n && typeof n === "object") return Object.entries(n as Row).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k));
  return [];
}
function leaks(out: unknown): string[] {
  const needles = [...Object.values(FIX.sentinels), ...HEARD_ONLY_IN_INTERNAL, "Zorbexin Plus Forte"];
  const bad: string[] = [];
  for (const [p, s] of leaves(out)) {
    const hit = needles.filter((x) => s.toLowerCase().includes(x.toLowerCase())).concat(/(^|[^\w.])500([^\w.]|$)/.test(s) ? ["500"] : []);
    if (hit.length && !ALLOWED.some((re) => re.test(p))) bad.push(`${p.replace(/\d+/g, "#")}: ${hit.join(",")}`);
  }
  return [...new Set(bad)].sort();
}
const stored = (): Row => ({
  run_id: 9, consult_uid: "synth-c4", prescription_uid: null, schema_version: "eta.freescript.v0.3", room_slug: "synth-room", room_id: "room_synth", ist_date: "2026-10-05",
  doctor_uid8: "cellfake", validator_ok: true, validator_errors: [], generator_code_sha: "a".repeat(64), generator_prompt_sha: "b".repeat(64), model_id: "anthropic.claude",
  cost_usd: 0.02, created_at: "2026-10-05T05:00:00.000Z", artifact: FIX.artifact, completion_required: FIX.completion_required,
});

beforeEach(() => {
  process.env.ETA_FREESCRIPT = "1";
  delete process.env.FREESCRIPT_INTERNAL_READ;
});

describe("Fix2 H2: a pipeline-built artifact leaks no heard value through any read", () => {
  it("the fixture really holds the heard values and the sentinels, in the places the mapper puts them", () => {
    const all = JSON.stringify(FIX.artifact);
    for (const k of ["strength", "freq", "dur", "timing", "slot", "brand", "vital"]) expect(all).toContain(FIX.sentinels[k]);
    expect(all).not.toContain(FIX.sentinels.prev); // the previous patient's turn is never stored
    expect(JSON.stringify((FIX.artifact.confirm_internal as Row).completion)).toContain("a month"); // the slot detail lives in confirm_internal
    expect(FIX.completion_required.length).toBeGreaterThan(0);
    for (const c of FIX.completion_required) expect(Object.keys(c).sort()).toEqual(["item_id", "kind", "prompt", "prompt_id"]);
  });
  it("publicArtifact and publicCompletion", () => {
    expect(leaks(publicArtifact(FIX.artifact))).toEqual([]);
    expect(leaks(publicCompletion(FIX.completion_required))).toEqual([]);
  });
  it("completion_required serves only {kind, item_id, prompt_id, prompt}, even when a stored row carries more", () => {
    const rows = [{ kind: "pick_drug", item_id: "slot4", prompt_id: "slot4", prompt: "Name this drug", detail: "tablet twice daily x 5 days after food", spoken: "Nebistar pachaas" }];
    for (const out of [publicCompletion(rows), (publicArtifact({ completion_required: rows }) as Row).completion_required, rowView({ ...stored(), completion_required: rows }).completion_required]) {
      expect(out).toEqual([{ kind: "pick_drug", item_id: "slot4", prompt_id: "slot4", prompt: "Name this drug" }]);
    }
  });
  it("provenance is an allow-list: a key nobody listed is dropped, nested quotes included", () => {
    const art = { provenance: [{ item_id: "x", kind: "advice", status: "prescribed", text: "t", follow_up: { said_text: "ZQ1" }, medicine: { strength: { text: "ZQ2" } }, new_future_key: "ZQ3",
      evidence: [{ quote: "ZQ4" }] }] };
    const p = (publicArtifact(art) as Row).provenance as Row[];
    expect(JSON.stringify(p)).not.toMatch(/ZQ\d/);
    expect(Object.keys(p[0]).sort()).toEqual(["item_id", "kind", "status"]);
  });
  it("rowView, /day and every scribe_freescript selector", async () => {
    H.respond = () => [stored()];
    expect(leaks(rowView(stored()))).toEqual([]);
    expect(leaks(await freescriptDayRead("2026-10-05"))).toEqual([]);
    for (const args of [{ encounter_id: "synth-c4" }, { consult_uid: "synth-c4" }, { ist_date: "2026-10-05" }, { room: "synth-room", date: "2026-10-05" },
      { doctor_uid8: "cellfake", date_from: "2026-10-01", date_to: "2026-10-05" }]) {
      const out = await freescriptCall(args, READ);
      expect(out.ok).toBe(true);
      expect(leaks(out)).toEqual([]);
    }
  });
  it("the debug flag is server-side only: a caller-supplied internal:true does nothing while the env flag is off", () => {
    expect(publicArtifact(FIX.artifact, { internal: true })).not.toHaveProperty("confirm_internal");
  });
});
