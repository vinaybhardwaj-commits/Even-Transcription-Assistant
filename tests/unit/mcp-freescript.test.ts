/**
 * mcp-freescript.test.ts — scribe_freescript. SQL is faked. Ids are synthetic. Unset is on; tests set 0 to close the door.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({
  calls: [] as string[],
  respond: (_t: string): Row[] => [],
  submit: [] as Row[],
}));
vi.mock("@/lib/db", () => {
  const fn = (strings: TemplateStringsArray | string, ...rest: unknown[]) => {
    const text = typeof strings === "string" ? strings : strings.join("$?");
    H.calls.push(text);
    return Promise.resolve(H.respond(text));
  };
  return { sql: fn };
});
vi.mock("@/lib/jobs/submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jobs/submit")>();
  return {
    ...actual,
    submitJob: vi.fn(async (input: Row) => {
      H.submit.push(input);
      return { id: "job_synth1", kind: input.kind, status: "queued" };
    }),
  };
});

import { freescriptCall, freescriptTool, parseSelector, rowView } from "@/lib/mcp/tools/freescript";
import { listedTool, toolsForProfile } from "@/lib/mcp/profile";
import { CALLABLE_TOOLS, LAB_TOOLS, PUBLISHED_TOOLS } from "@/lib/mcp/surface";
import { freescriptKind, parseFreescriptArgs } from "@/lib/jobs/kinds/freescript";
import { ToolScopeError, type ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const CTX: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read", "invoke"]) };
const READ: ToolContext = { ...CTX, scopes: new Set<McpScope>(["read"]) };

const stored = (over: Row = {}): Row => ({
  run_id: 4, consult_uid: "synth-fs-1", prescription_uid: null, schema_version: "eta.freescript.v0.2",
  room_slug: "synth-room", room_id: "room_synth", ist_date: "2026-10-05", doctor_uid8: "cellfake",
  validator_ok: true, validator_errors: [], generator_code_sha: "a".repeat(64), generator_prompt_sha: "b".repeat(64),
  model_id: "anthropic.claude", cost_usd: 0.02, created_at: "2026-10-05T05:00:00.000Z",
  artifact: { schema_version: "eta.freescript.v0.2", gp_extraction: { medicines: [] } },
  completion_required: [{ kind: "exam_missing", prompt: "Enter finding" }],
  ...over,
});

beforeEach(() => {
  H.calls = [];
  H.submit = [];
  H.respond = () => [stored()];
  process.env.ETA_FREESCRIPT = "1";
});

describe("registration", () => {
  it("is appended after scribe_timbre, listed for every profile, read scope", () => {
    const names = PUBLISHED_TOOLS.map((t) => t.name);
    expect(names.filter((n) => n === "scribe_freescript")).toHaveLength(1);
    expect(names.at(-1)).toBe("scribe_freescript");
    expect(names.at(-2)).toBe("scribe_encounter_timeline");
    expect(names.indexOf("scribe_timbre")).toBe(names.length - 3);
    expect(CALLABLE_TOOLS.get("scribe_freescript")!.scope).toBe("read");
    expect(LAB_TOOLS.some((t) => t.name === "scribe_freescript")).toBe(true);
    for (const p of ["operator", "lab"] as const) expect(toolsForProfile(p).map((t) => t.name)).toContain("scribe_freescript");
    const listed = listedTool("scribe_freescript")!;
    expect(listed.description.length).toBeLessThanOrEqual(200);
    expect(listed.description).toMatch(/ETA_FREESCRIPT=0/);
    expect(listed.description).toMatch(/needs invoke/);
    expect(listed.description).toMatch(/No transcript text/);
  });
  it("reads through the app connection", () => {
    const src = readFileSync("lib/mcp/tools/freescript.ts", "utf8");
    expect(src).toMatch(/from "@\/lib\/db"/);
    expect(src).not.toMatch(/@\/lib\/brain\/db/);
  });
});

describe("the kill switch", () => {
  it("read and run do nothing when ETA_FREESCRIPT is 0, and an unset flag still reads", async () => {
    process.env.ETA_FREESCRIPT = "0";
    expect(await freescriptCall({ encounter_id: "synth-fs-1" }, CTX)).toEqual({ ok: false, error: "disabled" });
    expect(await freescriptCall({ action: "run", consult_uid: "synth-fs-1" }, CTX)).toEqual({ ok: false, error: "disabled" });
    expect(H.calls).toHaveLength(0);
    expect(H.submit).toHaveLength(0);
    delete process.env.ETA_FREESCRIPT;
    expect(await freescriptCall({ encounter_id: "synth-fs-1" }, READ)).toMatchObject({ ok: true, selector: "encounter" });
  });
});

describe("read selectors", () => {
  it("refuses zero or several selectors", async () => {
    expect(await freescriptCall({}, CTX)).toMatchObject({ ok: false, error: "bad_args" });
    expect(await freescriptCall({ encounter_id: "synth-fs-1", room: "synth-room", date: "2026-10-05" }, CTX)).toMatchObject({ ok: false, error: "bad_args" });
    expect(parseSelector({ doctor_uid8: "cellfake", date_from: "2026-01-01", date_to: "2026-06-01" })).toMatchObject({ ok: false });
    expect(H.calls).toHaveLength(0);
  });
  it("encounter returns the artifact, completion_required and the validator", async () => {
    const out = await freescriptCall({ encounter_id: "synth-fs-1" }, READ);
    expect(out).toMatchObject({ ok: true, selector: "encounter", n: 1 });
    expect(H.calls[0]).toMatch(/FROM freescript_latest/);
    const row = (out.rows as Row[])[0]!;
    expect(row.validator).toEqual({ ok: true, errors: [] });
    expect(row.completion_required).toEqual([{ kind: "exam_missing", prompt: "Enter finding" }]);
    expect(row.artifact).toMatchObject({ schema_version: "eta.freescript.v0.2" });
    expect(JSON.stringify(row)).not.toMatch(/segments/);
  });
  it("room+date and doctor range are separate selectors", async () => {
    expect(await freescriptCall({ room: "synth-room", date: "2026-10-05" }, READ)).toMatchObject({ ok: true, selector: "room_day" });
    expect(H.calls.at(-1)).toMatch(/room_slug = \$\? OR room_id/);
    const doc = await freescriptCall({ doctor_uid8: "cellfake", date_from: "2026-10-01", date_to: "2026-10-11" }, READ);
    expect(doc).toMatchObject({ ok: true, selector: "doctor" });
  });
});

describe("run queues a box job and does not call a model", () => {
  it("queues kind freescript for a consult and refuses a doctor range", async () => {
    const out = await freescriptCall({ action: "run", consult_uid: "synth-fs-1" }, CTX);
    expect(out).toMatchObject({ ok: true, job_id: "job_synth1", kind: "freescript", runs_on: "box" });
    expect(H.submit[0]).toMatchObject({ kind: "freescript", args: { consult_uid: "synth-fs-1" } });
    expect(await freescriptCall({ action: "run", doctor_uid8: "cellfake", date_from: "2026-10-01", date_to: "2026-10-02" }, CTX)).toMatchObject({ ok: false, error: "bad_args" });
  });
  it("a read token cannot queue", async () => {
    const { submitJob } = await import("@/lib/jobs/submit");
    vi.mocked(submitJob).mockRejectedValueOnce(new ToolScopeError("invoke", { kind: "freescript" }));
    await expect(freescriptCall({ action: "run", consult_uid: "synth-fs-1" }, READ)).rejects.toBeInstanceOf(ToolScopeError);
  });
});

describe("the job kind never runs the pipeline", () => {
  it("parseArgs takes one selector", () => {
    expect(parseFreescriptArgs({ consult_uid: "synth-fs-1" })).toEqual({ consult_uid: "synth-fs-1" });
    expect(parseFreescriptArgs({ room: "synth-room", date: "2026-10-05" })).toEqual({ room: "synth-room", ist_date: "2026-10-05" });
    expect(() => parseFreescriptArgs({ consult_uid: "synth-fs-1", room: "synth-room", ist_date: "2026-10-05" })).toThrow(/one_selector/);
  });
  it("precheck allows an unset flag and refuses the kill switch", async () => {
    delete process.env.ETA_FREESCRIPT;
    await freescriptKind.precheck?.({});
    process.env.ETA_FREESCRIPT = "0";
    await expect(freescriptKind.precheck?.({})).rejects.toThrow(/freescript_disabled/);
  });
  it("accept only records a wait; await_box finishes from a stored row and carries no transcript", async () => {
    const job = { id: "job_synth1", created_at: "2026-10-05T00:00:00.000Z" } as never;
    const accepted = await freescriptKind.run({ job, step: "accept", args: { consult_uid: "synth-fs-1" }, progress: {} });
    expect(accepted).toMatchObject({ kind: "next", step: "await_box" });
    expect(H.calls).toHaveLength(0);
    H.respond = (t) => (/freescript_run/.test(t) ? [{ id: 9, validator_ok: true }] : []);
    const done = await freescriptKind.run({
      job, step: "await_box", args: { consult_uid: "synth-fs-1" },
      progress: { accepted_at: new Date().toISOString() },
    });
    expect(done).toEqual({ kind: "done", result: { run_id: 9, validator_ok: true, runs_on: "box" } });
    expect(JSON.stringify(done)).not.toMatch(/segments|transcript/);
    const stale = await freescriptKind.run({
      job, step: "await_box", args: { consult_uid: "synth-fs-1" },
      progress: { accepted_at: "2020-01-01T00:00:00.000Z" },
    });
    expect(stale.kind).toBe("fail");
  });
});

describe("rowView", () => {
  it("maps the validator next to the artifact", () => {
    const v = rowView(stored({ validator_ok: false, validator_errors: ["C1"] }));
    expect(v.validator).toEqual({ ok: false, errors: ["C1"] });
    expect(freescriptTool.inputSchema.additionalProperties).toBe(false);
  });
});
