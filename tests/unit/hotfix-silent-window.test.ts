/**
 * Hotfix defect 1 — a silent window is a SUCCESS on the job path, as it already was on the
 * synchronous one.
 *
 * `lib/whisper.ts` maps a 200 with no speech to `{ok:false, error:'empty_transcript'}` — an
 * `ok:false` that means "the read finished and there was nothing to hear". The job path failed
 * every `!w.ok` as `whisper_failed`, so a quiet room looked exactly like an unreachable Whisper.
 * That is the one distinction K5 exists to keep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let TABLE: Row[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const find = (id: unknown) => TABLE.find((r) => r.id === id);
    if (/^INSERT INTO scribe_job/.test(text)) {
      const [id, kind, args, actor] = values as [string, string, string, string | null];
      const row: Row = { id, kind, args, status: "queued", step: null, progress: "{}", result: null,
        error: null, actor, created_at: "t", started_at: null, updated_at: "t", finished_at: null,
        lease_until: null, lease_owner: null, attempts: 0, failures: 0 };
      TABLE.push(row); return Promise.resolve([row]);
    }
    if (/WITH claimable AS/.test(text)) {
      const runner = (values[2] ?? null) as string | null;
      const picked = TABLE.filter((r) => r.status === "queued" || (r.status === "running" && r.lease_until === null)).slice(0, 1);
      for (const r of picked) { r.status = "running"; r.attempts = Number(r.attempts) + 1; r.lease_until = "later"; r.lease_owner = runner; }
      return Promise.resolve(picked.map((r) => ({ ...r })));
    }
    const owned = (r: Row | undefined, runner: unknown) => !!r && (r.lease_owner ?? null) === (runner ?? null);
    if (/^UPDATE scribe_job SET step =/.test(text)) {
      const [step, progress, id, runner] = values as [string, string, string, string];
      const r = find(id);
      if (owned(r, runner) && r!.status === "running") { r!.step = step; r!.progress = progress; r!.lease_until = null; return Promise.resolve([{ id }]); }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'done'/.test(text)) {
      const [result, id, runner] = values as [string, string, string];
      const r = find(id);
      if (owned(r, runner) && r!.status === "running") { r!.status = "done"; r!.result = result; r!.lease_owner = null; return Promise.resolve([{ id }]); }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'failed'/.test(text)) {
      const [err, id, runner] = values as [string, string, string];
      const r = find(id);
      if (owned(r, runner) && r!.status === "running") { r!.status = "failed"; r!.error = err; r!.lease_owner = null; return Promise.resolve([{ id }]); }
      return Promise.resolve([]);
    }
    if (/FROM scribe_job WHERE id = \?/.test(text)) { const r = find(values[0]); return Promise.resolve(r ? [{ ...r }] : []); }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const CHUNK = { idx: 0, r2_key: "clips/x.webm", started_at: "2026-09-12T06:00:00.000Z", ended_at: "2026-09-12T06:10:00.000Z" };
vi.mock("@/lib/bench", () => ({ listBenchChunks: async () => [CHUNK], listBenchSessions: async () => [] }));
vi.mock("@/lib/bench-range", () => ({ resolveRange: () => ({ kind: "single", covering: { chunk: CHUNK } }) }));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => new Uint8Array([1, 2, 3]), signGetUrl: async () => "u" }));

/** What lib/whisper.ts hands back. Its `empty_transcript` mapping is NOT changed by this hotfix. */
const WHISPER: { value: unknown } = { value: null };
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => WHISPER.value }));

const { insertJob, newJobId, claimJobs, readJob } = await import("@/lib/jobs/store");
const { runOneStep } = await import("@/lib/jobs/runner");
const { JOB_ERROR_CODES } = await import("@/lib/jobs/errors");
const { EMPTY_TRANSCRIPT } = await import("@/lib/mcp/tools/bench");

beforeEach(() => { TABLE = []; WHISPER.value = null; });

async function driveToEnd() {
  const j = await insertJob({ id: newJobId(), kind: "transcribe_range", args: {
    session_id: "sess_1", start: Date.parse("2026-09-12T06:01:00.000Z"),
    end: Date.parse("2026-09-12T06:02:00.000Z"), source: "primary", dry_run: true,
  }, actor: "mcp:t" });
  for (let i = 0; i < 6; i++) {
    const runner = `r${i}`;
    const c = await claimJobs(1, 240_000, runner);
    if (!c.length) break;
    const rep = await runOneStep(c[0]!, runner);
    if (rep.outcome === "done" || rep.outcome === "failed") break;
  }
  return (await readJob(j.id))!;
}

describe("defect 1 — a 200 with no speech is a silent window, not a failure", () => {
  it("empty_transcript reaches status DONE with the silent marker", async () => {
    WHISPER.value = { ok: false, error: EMPTY_TRANSCRIPT, latency_ms: 120 };
    const row = await driveToEnd();
    expect(row.status, `a quiet room must not be a failed job (error=${row.error})`).toBe("done");
    expect(row.error).toBeNull();
    expect(row.result).toMatchObject({ silent_window: true, chars: 0, segments: 0, language: null });
    expect(String((row.result as Row).note)).toMatch(/SILENT WINDOW/);
  });

  it("a real transport failure still fails, with whisper_failed", async () => {
    WHISPER.value = { ok: false, error: "http_502: upstream said no", latency_ms: 40 };
    const row = await driveToEnd();
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain("whisper_failed");
    // …and the downstream prose never lands on the row (Slice B's error gate).
    expect(String(row.error)).not.toContain("upstream said no");
  });

  it("a timeout is a failure too — only empty_transcript is special", async () => {
    WHISPER.value = { ok: false, error: "timeout", latency_ms: 40_000 };
    expect((await driveToEnd()).status).toBe("failed");
  });

  it("a spoken window still completes and carries its counts", async () => {
    WHISPER.value = { ok: true, transcript: "hello there", language: "en", segments: [{ start: 0, end: 1, text: "hello there" }], latency_ms: 90 };
    const row = await driveToEnd();
    expect(row.status).toBe("done");
    expect(row.result).toMatchObject({ silent_window: false, chars: 11, segments: 1, language: "en" });
  });

  // ---- the test that would have caught the original -------------------------------------
  it("the two paths agree on what empty_transcript MEANS — they cannot silently diverge again", async () => {
    const { readFileSync } = await import("node:fs");
    const sync = readFileSync("lib/mcp/tools/bench.ts", "utf8");
    const job = readFileSync("lib/jobs/kinds/transcribe-range.ts", "utf8");

    // The synchronous path treats EMPTY_TRANSCRIPT as ok:true with silent_window.
    const syncBlock = sync.slice(sync.indexOf("if (w.error === EMPTY_TRANSCRIPT)"), sync.indexOf("// ---- a failed ask"));
    expect(syncBlock).toMatch(/ok:\s*true/);
    expect(syncBlock).toMatch(/silent_window:\s*true/);

    // The job path must branch on the SAME constant, before any failWith, and succeed.
    const jobBlock = job.slice(job.indexOf("if (w.error === EMPTY_TRANSCRIPT)"), job.indexOf('jobError("whisper_failed")'));
    expect(jobBlock, "the job path must branch on EMPTY_TRANSCRIPT before it fails").toBeTruthy();
    expect(jobBlock).toMatch(/doneWith/);
    expect(jobBlock).toMatch(/silent_window:\s*true/);

    // And both import the one constant rather than re-typing the string.
    expect(job).toMatch(/import \{ EMPTY_TRANSCRIPT \}/);
  });

  it("empty_transcript is NOT a job error code — it must not become an error by another name", () => {
    expect(JOB_ERROR_CODES as readonly string[]).not.toContain(EMPTY_TRANSCRIPT);
    expect(JOB_ERROR_CODES as readonly string[]).not.toContain("empty_transcript");
  });
});
