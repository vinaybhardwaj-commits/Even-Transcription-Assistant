/**
 * REFUTER (e) — drive a REAL transcribe_range job to `done` over a Whisper that returns a
 * recognisable sentence, then try to get that sentence back out through every jobs tool a
 * read-scope token can reach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const SECRET = "the patient reports crushing chest pain radiating to the left arm";

type Row = Record<string, unknown>;
/**
 * Fix-up 5 — model `AND lease_owner = ?`: PLAIN EQUALITY, so a NULL owner matches nothing. The
 * previous `IS NOT DISTINCT FROM` matched NULL against NULL, which is how a caller with no runner
 * could write to a row it never claimed.
 */
const owns = (text: string, r: Row, runner: string | null | undefined): boolean => {
  if (!/lease_owner = \?/.test(text)) return true;
  const owner = (r.lease_owner ?? null) as string | null;
  return owner !== null && runner != null && owner === runner;
};
let TABLE: Row[] = [];
let NOW = Date.parse("2026-09-12T07:00:00.000Z");
const nowIso = () => new Date(NOW).toISOString();

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const find = (id: unknown) => TABLE.find((r) => r.id === id);
    if (/^INSERT INTO scribe_job/.test(text)) {
      const [id, kind, args, actor] = values as [string, string, string, string | null];
      const row: Row = { id, kind, args, status: "queued", step: null, progress: "{}", result: null,
        error: null, actor, created_at: nowIso(), started_at: null, updated_at: nowIso(),
        finished_at: null, lease_until: null, lease_owner: null, attempts: 0, failures: 0 };
      TABLE.push(row); return Promise.resolve([row]);
    }
    if (/WITH claimable AS/.test(text)) {
      const runner = (values[2] ?? null) as string | null;
      const picked = TABLE.filter((r) => r.status === "queued" ||
        (r.status === "running" && (r.lease_until === null || Date.parse(String(r.lease_until)) < NOW)))
        .slice(0, Number(values[0] ?? 3));
      for (const r of picked) { r.status = "running"; r.attempts = Number(r.attempts) + 1;
        r.lease_until = new Date(NOW + 240_000).toISOString(); r.lease_owner = runner; }
      return Promise.resolve(picked.map((r) => ({ ...r })));
    }
    if (/^UPDATE scribe_job SET step =/.test(text)) {
      const [step, progress, id, runner] = values as [string, string, string, string | null];
      const r = find(id);
      if (r && r.status === "running" && owns(text, r, runner)) {
        r.step = step; r.progress = progress; r.lease_until = null;
        return Promise.resolve([{ id: r.id }]);
      }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'done'/.test(text)) {
      const [result, id, runner] = values as [string, string, string | null];
      const r = find(id);
      if (r && r.status === "running" && owns(text, r, runner)) {
        r.status = "done"; r.result = result; r.lease_until = null; r.lease_owner = null; r.finished_at = nowIso();
        return Promise.resolve([{ id: r.id }]);
      }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'failed'/.test(text)) {
      const [err, id, runner] = values as [string, string, string | null];
      const r = find(id);
      if (r && r.status === "running" && owns(text, r, runner)) {
        r.status = "failed"; r.error = err; r.lease_until = null; r.lease_owner = null; r.finished_at = nowIso();
        return Promise.resolve([{ id: r.id }]);
      }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET failures = failures \+ 1/.test(text)) {
      const [step, progress, cap, , err] = values as [string, string, number, number, string];
      const id = values[values.length - 1];
      const r = find(id); if (!r || r.status !== "running") return Promise.resolve([]);
      r.failures = Number(r.failures) + 1; r.step = step; r.progress = progress; r.lease_until = null; r.lease_owner = null;
      if (Number(r.failures) >= Number(cap)) { r.status = "failed"; r.error = err; }
      return Promise.resolve([{ failures: r.failures, status: r.status }]);
    }
    if (/FROM scribe_job WHERE id = \?/.test(text)) {
      const r = find(values[0]); return Promise.resolve(r ? [{ ...r }] : []);
    }
    if (/FROM scribe_job WHERE \(/.test(text)) return Promise.resolve(TABLE.map((r) => ({ ...r })));
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

vi.mock("@/lib/bench", () => ({
  listBenchChunks: async () => [{ idx: 0, r2_key: "clips/x.webm", started_at: "2026-09-12T06:00:00.000Z", ended_at: "2026-09-12T06:10:00.000Z" }],
  listBenchSessions: async () => [],
}));
vi.mock("@/lib/bench-range", () => ({
  resolveRange: () => ({ kind: "single", covering: { chunk: { idx: 0, r2_key: "clips/x.webm", started_at: "2026-09-12T06:00:00.000Z", ended_at: "2026-09-12T06:10:00.000Z" } } }),
}));
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => new Uint8Array([1, 2, 3]),
  signGetUrl: async ({ key }: { key: string }) => `https://r2.example/${key}?sig=1`,
}));
const WHISPER: { value: unknown } = { value: { ok: true, transcript: SECRET, language: "en", segments: [{ start: 0, end: 3, text: SECRET }] } };
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => WHISPER.value }));
vi.mock("next/server", async (o) => ({ ...(await o() as object), after: (fn: () => unknown) => { void fn; } }));

import { insertJob, newJobId, readJob } from "@/lib/jobs/store";
import { claimJobs } from "@/lib/jobs/store";
import { runOneStep } from "@/lib/jobs/runner";
import { JOB_TOOLS } from "@/lib/mcp/tools/jobs";
import { ToolScopeError } from "@/lib/mcp/registry";

const tool = (n: string) => JOB_TOOLS.find((t) => t.name === n)!;
const readCtx = { origin: "https://x", actor: "mcp:watcher", scopes: new Set(["read"]) as ReadonlySet<"read" | "invoke" | "write"> };

/**
 * Fix-up 6 item 1 — THE PRODUCTION CALL SHAPE. `runner` is required on every claim and every
 * write since Fix-up 5, and this file was still calling `runOneStep(job)` with none: every write
 * then matched zero rows, the runner reported `lease_lost` throughout, and the four assertions
 * about a completed transcription were being satisfied by the fake's own mutations rather than by
 * the flow they describe. A fresh runner id per claim, as `runClaimedBatch` mints one.
 */
let RUNNER_N = 0;
async function runToDone() {
  const j = await insertJob({ id: newJobId(), kind: "transcribe_range", args: {
    session_id: "sess_1", start: Date.parse("2026-09-12T06:01:00.000Z"),
    end: Date.parse("2026-09-12T06:04:00.000Z"), source: "primary", dry_run: false,
  }, actor: "mcp:operator-v" });
  for (let i = 0; i < 5; i++) {
    const runner = `runner-${++RUNNER_N}`;
    const c = await claimJobs(3, 240_000, runner);
    if (!c.length) break;
    const rep = await runOneStep(c[0]!, runner);
    // A lease_lost here would mean the harness, not the code, is wrong — say so loudly rather
    // than looping until the assertions below quietly pass on a half-run job.
    expect(rep.outcome, `unexpected lease_lost at step ${c[0]!.step ?? "start"}`).not.toBe("lease_lost");
    if (rep.outcome === "done" || rep.outcome === "failed") break;
  }
  return (await readJob(j.id))!;
}

beforeEach(() => { TABLE = []; WHISPER.value = { ok: true, transcript: SECRET, language: "en", segments: [{ start: 0, end: 3, text: SECRET }] }; });

describe("(e) a read token gets pointers, never the words", () => {
  it("the job reaches done and the stored row itself holds no transcript", async () => {
    const row = await runToDone();
    expect(row.status).toBe("done");
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row.result).toMatchObject({ transcription_run_id: null, chars: SECRET.length, language: "en" });
  });

  it("scribe_job_status with include_result returns counts and a run pointer, no text", async () => {
    const row = await runToDone();
    const out = await tool("scribe_job_status").handler({ job_id: row.id, include_result: true }, readCtx as never);
    const s = JSON.stringify(out);
    expect(s).not.toContain(SECRET);
    expect(s).not.toMatch(/chest pain|crushing|patient reports/i);
    expect(out).toMatchObject({ ok: true, status: "done" });
    expect(s).toContain("transcription_run_id");
  });

  it("scribe_job_list leaks nothing either", async () => {
    await runToDone();
    const out = await tool("scribe_job_list").handler({ limit: 50 }, readCtx as never);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("a read token cannot mint an audio link: the refusal is thrown, not flattened to degraded", async () => {
    const row = await runToDone();
    await expect(
      tool("scribe_job_status").handler({ job_id: row.id, include_urls: true }, readCtx as never),
    ).rejects.toBeInstanceOf(ToolScopeError);
  });

  it("with invoke, include_urls does mint a link", async () => {
    const row = await runToDone();
    const ctx = { ...readCtx, scopes: new Set(["read", "invoke"]) as ReadonlySet<"read" | "invoke" | "write"> };
    const out = await tool("scribe_job_status").handler({ job_id: row.id, include_urls: true, include_result: true }, ctx as never);
    expect(JSON.stringify(out)).toContain("https://r2.example/clips/x.webm");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("BREAK: a downstream error that echoes the audio reaches a read token through `error`", async () => {
    WHISPER.value = { ok: false, error: `bad_input near: ${SECRET}` };
    const row = await runToDone();
    expect(row.status).toBe("failed");
    const out = await tool("scribe_job_status").handler({ job_id: row.id }, readCtx as never);
    expect(JSON.stringify(out)).not.toContain("crushing chest pain");
  });
});

// ---------------------------------------------------------------------------
// Fix-up 5 item 2 — the error gate, tested against ARBITRARY PROSE in the column
// ---------------------------------------------------------------------------

describe("(e2) the error channel is gated on scope, not on the write side behaving", () => {
  const PROSE = "crushing chest pain radiating to the jaw since Tuesday";
  const invokeCtx = { ...readCtx, scopes: new Set(["read", "invoke"]) as ReadonlySet<"read" | "invoke" | "write"> };

  /** Put a row in the table by hand, with whatever `error` we like. */
  const seed = (error: string) => {
    const row = {
      id: "job_seeded", kind: "transcribe_range", args: "{}", status: "failed", step: "transcribe",
      progress: "{}", result: null, error, actor: "mcp:operator-v",
      created_at: "t", started_at: "t", updated_at: "t", finished_at: "t",
      lease_until: null, lease_owner: null, attempts: 1, failures: 1,
    };
    TABLE.length = 0;
    TABLE.push(row);
    return row;
  };

  it("a read token never sees the prose, for EVERY published code", async () => {
    const { JOB_ERROR_CODES } = await import("@/lib/jobs/errors");
    for (const code of JOB_ERROR_CODES) {
      seed(`${code}: ${PROSE}`);
      const out = await tool("scribe_job_status").handler({ job_id: "job_seeded" }, readCtx as never);
      const s = JSON.stringify(out);
      expect(s, `${code} leaked the prose`).not.toContain(PROSE);
      expect(s, `${code} was not reported`).toContain(code);
      expect((out as Record<string, unknown>).error, `${code} returned the raw column`).toBeUndefined();
    }
  });

  it("an UNMAPPED error is reported as unknown_error, never passed through", async () => {
    // The gate must not trust the write side. A row written by an older build, a future kind, or
    // a hand carries prose with no code at all — and must still be redacted.
    seed(`something nobody enumerated: ${PROSE}`);
    const out = await tool("scribe_job_status").handler({ job_id: "job_seeded" }, readCtx as never);
    const s = JSON.stringify(out);
    expect(s).not.toContain(PROSE);
    expect(s).not.toContain("something nobody enumerated");
    expect(out).toMatchObject({ error_code: "unknown_error" });
  });

  it("an invoke token DOES get the prose — the gate is scope, not redaction-at-rest", async () => {
    seed(`whisper_failed: ${PROSE}`);
    const out = await tool("scribe_job_status").handler({ job_id: "job_seeded" }, invokeCtx as never);
    expect(JSON.stringify(out)).toContain(PROSE);
    expect(out).toMatchObject({ error_code: "whisper_failed" });
  });

  it("scribe_job_list is gated the same way — a listing must not be a side door", async () => {
    seed(`whisper_failed: ${PROSE}`);
    const asRead = await tool("scribe_job_list").handler({ limit: 50 }, readCtx as never);
    expect(JSON.stringify(asRead)).not.toContain(PROSE);
    expect(JSON.stringify(asRead)).toContain("whisper_failed");
    const asInvoke = await tool("scribe_job_list").handler({ limit: 50 }, invokeCtx as never);
    expect(JSON.stringify(asInvoke)).toContain(PROSE);
  });

  it("a read and an invoke token do NOT get byte-identical answers any more", async () => {
    seed(`join_failed: ${PROSE}`);
    const a = JSON.stringify(await tool("scribe_job_status").handler({ job_id: "job_seeded" }, readCtx as never));
    const b = JSON.stringify(await tool("scribe_job_status").handler({ job_id: "job_seeded" }, invokeCtx as never));
    expect(a).not.toBe(b);
  });

  it("a row with no error at all reports error_code null, not a spurious code", async () => {
    const row = seed("x");
    row.error = null as unknown as string;
    const out = await tool("scribe_job_status").handler({ job_id: "job_seeded" }, readCtx as never);
    expect((out as Record<string, unknown>).error_code).toBeNull();
  });
});

describe("(e3) both tools' descriptions match the code that enforces the gate", () => {
  it("scribe_job_list names error_code and the invoke gate, as scribe_job_status does", () => {
    const list = tool("scribe_job_list").description;
    const status = tool("scribe_job_status").description;
    for (const d of [list, status]) {
      expect(d).toMatch(/error_code/);
      expect(d).toMatch(/unknown_error/);
      expect(d).toMatch(/invoke/);
    }
    // The one claim a description must not make is one the code does not honour.
    expect(list).not.toMatch(/never returned to any caller/i);
  });
});
