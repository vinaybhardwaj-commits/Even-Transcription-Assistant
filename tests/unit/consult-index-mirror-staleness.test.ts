/**
 * The lab consult-index mirror staleness guard.
 * Rules: more than 30 minutes behind the newest REB stt/role track goes red only during 09:00-20:00 IST;
 * exactly 30 does not; a non-zero index-mirror exit goes red at any hour.
 * The health route and scribe_health both carry lag_minutes, exit_code and reason, and both go red with the guard.
 * Ids below are clocks and exit codes. No names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { sha256Hex } from "@/lib/consult-index/parse";

const H = vi.hoisted(() => ({
  sql: vi.fn(async (_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => [{ ok: 1 }]),
  lab: null as null | { get: (k: string) => Promise<{ body: string; etag: string } | null> },
  clocks: null as null | { mirror_t1_ms: number | null; reb_t1_ms: number | null },
  exit: "empty" as "empty" | { exit_code: number; reason: string | null },
}));

vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/sarvam-lab", () => ({
  CONSULT_INDEX_KEYS: ["consult/index/latest.jsonl", "consult/index/manifest.json"],
  labStore: () => H.lab,
}));
vi.mock("@/lib/health/whisper-probe", () => ({
  probeWhisperTranscription: async () => ({ ok: true, elapsed_ms: 1, checked_at: "2026-10-12T06:30:00.000Z", age_s: 0, cached: false }),
}));
vi.mock("@/lib/health/ollama-probe", () => ({ fetchOllamaModels: async () => ({ ok: true, status: 200 }) }));
vi.mock("@neondatabase/serverless", () => ({ neon: () => async () => [{ ok: 1 }] }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send() { return Promise.resolve({}); } },
  HeadBucketCommand: class {},
}));
vi.mock("@/app/api/brain/health/route", () => ({
  GET: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
}));
vi.mock("@/lib/mcp/tools/stt", () => ({ probeSttEngines: async () => [] }));

import { parseIndex } from "@/lib/consult-index/parse";
import { syncConsultIndex } from "@/lib/consult-index/sync";
import {
  inMirrorClinicHours,
  judgeConsultIndexMirror,
  parseMirrorRunBody,
  readManifestExit,
} from "@/lib/consult-index/mirror-staleness";

const ist = (day: string, hm: string) => Date.parse(`${day}T${hm}:00+05:30`);
const MIRROR = Date.parse("2026-10-12T06:00:00.000Z");
const MIN = 60_000;

function judgeAt(nowMs: number, lagMs: number, exitCode: number | null, exitReason: string | null = null) {
  return judgeConsultIndexMirror({ nowMs, mirrorT1Ms: MIRROR, rebT1Ms: MIRROR + lagMs, exitCode, exitReason });
}

describe("clinic hours are 09:00 inclusive to 20:00 exclusive IST, every day", () => {
  it("weekday edges", () => {
    expect(inMirrorClinicHours(ist("2026-10-12", "08:59"))).toBe(false);
    expect(inMirrorClinicHours(ist("2026-10-12", "09:00"))).toBe(true);
    expect(inMirrorClinicHours(ist("2026-10-12", "19:59"))).toBe(true);
    expect(inMirrorClinicHours(ist("2026-10-12", "20:00"))).toBe(false);
  });
  it("Sunday noon is inside the window", () => {
    expect(inMirrorClinicHours(ist("2026-10-11", "12:00"))).toBe(true);
  });
});

describe("lag threshold", () => {
  const noon = ist("2026-10-12", "12:00");
  const night = ist("2026-10-12", "21:00");

  it("in clinic hours, exactly 30 minutes is not red and the lag is 30", () => {
    const v = judgeAt(noon, 30 * MIN, 0);
    expect(v.clinic_hours).toBe(true);
    expect(v.lag_minutes).toBe(30);
    expect(v.ok).toBe(true);
    expect(v.exit_code).toBe(0);
  });

  it("in clinic hours, one millisecond over 30 minutes is red", () => {
    const v = judgeAt(noon, 30 * MIN + 1, 0);
    expect(v.lag_minutes).toBeGreaterThan(30);
    expect(v.ok).toBe(false);
  });

  it("in clinic hours at the open edge, a 31 minute lag is red; at the close edge the same lag is not", () => {
    expect(judgeAt(ist("2026-10-12", "09:00"), 31 * MIN, 0)).toMatchObject({ ok: false, lag_minutes: 31, clinic_hours: true });
    expect(judgeAt(ist("2026-10-12", "20:00"), 31 * MIN, 0)).toMatchObject({ ok: true, lag_minutes: 31, clinic_hours: false });
  });

  it("after hours a lag over the threshold is reported and is not red", () => {
    expect(judgeAt(night, 90 * MIN, 0)).toMatchObject({ ok: true, lag_minutes: 90, clinic_hours: false, threshold_minutes: 30 });
  });

  it("a missing clock is not a measured lag", () => {
    expect(judgeConsultIndexMirror({ nowMs: noon, mirrorT1Ms: null, rebT1Ms: MIRROR, exitCode: 0, exitReason: null })).toMatchObject({ ok: true, lag_minutes: null });
  });
});

describe("non-zero index-mirror exit", () => {
  const noon = ist("2026-10-12", "12:00");
  const night = ist("2026-10-12", "21:00");

  it("a non-zero exit is red in clinic hours even when the lag is under the threshold, and the code and reason are kept", () => {
    expect(judgeAt(noon, 5 * MIN, 1, "mirror_failed")).toMatchObject({ ok: false, lag_minutes: 5, exit_code: 1, reason: "mirror_failed" });
  });

  it("a non-zero exit is red after hours, and exit 0 is not", () => {
    expect(judgeAt(night, 0, 2, "mirror_failed")).toMatchObject({ ok: false, exit_code: 2, reason: "mirror_failed", clinic_hours: false });
    expect(judgeAt(night, 90 * MIN, 0, null)).toMatchObject({ ok: true, exit_code: 0, reason: null });
  });

  it("an exit that was never reported is not a non-zero exit", () => {
    expect(judgeAt(noon, 0, null, null)).toMatchObject({ ok: true, exit_code: null, reason: null });
  });
});

describe("manifest exit and the ingest body", () => {
  it("parseIndex keeps an exit code and a machine reason, and drops a reason that is not a token", () => {
    const latest = "";
    const manifest = (extra: Record<string, unknown>) => JSON.stringify({ sha256: sha256Hex(latest), rows: 0, generated_at: "2026-10-12T06:30:00Z", ...extra });
    const ok = parseIndex(latest, manifest({ exit_code: 1, exit_reason: "mirror_failed" }));
    expect(ok.ok && ok.manifest).toMatchObject({ exit_code: 1, exit_reason: "mirror_failed" });
    const dropped = parseIndex(latest, manifest({ exit_code: "2", exit_reason: "not a token" }));
    expect(dropped.ok && dropped.manifest).toMatchObject({ exit_code: 2, exit_reason: null });
    const absent = parseIndex(latest, manifest({}));
    expect(absent.ok && absent.manifest).toMatchObject({ exit_code: null, exit_reason: null });
  });

  it("a refused exit_reason does not fall through to reason", () => {
    expect(readManifestExit({ exit_code: 1, exit_reason: "has space", reason: "mirror_failed" })).toEqual({ exit_code: 1, reason: null });
  });

  it("the ingest body is an integer exit and an optional token; extra keys are not returned", () => {
    expect(parseMirrorRunBody({ exit_code: 0 })).toEqual({ ok: true, run: { exit_code: 0, reason: null } });
    expect(parseMirrorRunBody({ exit_code: 3, reason: "mirror_failed", note: "SHOULD_NOT_ECHO" })).toEqual({ ok: true, run: { exit_code: 3, reason: "mirror_failed" } });
    expect(parseMirrorRunBody({ exit_code: 1.5 })).toEqual({ ok: false, error: "bad_exit_code" });
    expect(parseMirrorRunBody({ exit_code: 1, reason: "not a token" })).toEqual({ ok: false, error: "bad_reason" });
    expect(parseMirrorRunBody({ exit_code: 1, reason: "a", exit_reason: "b" })).toEqual({ ok: false, error: "bad_reason" });
    expect(parseMirrorRunBody([])).toEqual({ ok: false, error: "bad_body" });
  });
});

function armSql() {
  H.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    if (text.includes("INSERT INTO consult_index_sync")) return [{ id: 7 }];
    if (text.includes("INSERT INTO index_mirror_run")) return [];
    if (text.includes("FROM index_mirror_run")) return H.exit === "empty" ? [] : [H.exit];
    if (text.includes("reb_track_index")) return [H.clocks ?? { mirror_t1_ms: null, reb_t1_ms: null }];
    return [{ ok: 1 }];
  });
}

describe("GET /api/health and scribe_health carry the guard", () => {
  beforeEach(() => {
    armSql();
    H.clocks = { mirror_t1_ms: MIRROR, reb_t1_ms: MIRROR };
    H.exit = { exit_code: 0, reason: null };
    for (const [k, v] of Object.entries({
      KB_DATABASE_URL: "postgres://example",
      OLLAMA_BASE_URL: "http://ollama.example",
      RESEND_API_KEY: "test-token",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      DIARIZE_BASE_URL: "https://diarize.example",
    })) vi.stubEnv(k, v);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, device: "cpu" }), { status: 200 }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(ist("2026-10-12", "12:00")));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function health() {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    return { status: res.status, body: (await res.json()) as { ok: boolean; consult_index_mirror: { ok: boolean; lag_minutes: number | null; exit_code: number | null; reason: string | null; clinic_hours: boolean } } };
  }

  it("in clinic hours, exactly 30 minutes and exit 0 stays 200", async () => {
    H.clocks = { mirror_t1_ms: MIRROR, reb_t1_ms: MIRROR + 30 * MIN };
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.consult_index_mirror).toMatchObject({ ok: true, lag_minutes: 30, exit_code: 0, clinic_hours: true });
  });

  it("in clinic hours, over 30 minutes is 503 and the lag is on the body", async () => {
    H.clocks = { mirror_t1_ms: MIRROR, reb_t1_ms: MIRROR + 31 * MIN };
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.consult_index_mirror).toMatchObject({ ok: false, lag_minutes: 31, exit_code: 0, clinic_hours: true });
  });

  it("after hours the same lag is 200", async () => {
    vi.setSystemTime(new Date(ist("2026-10-12", "21:00")));
    H.clocks = { mirror_t1_ms: MIRROR, reb_t1_ms: MIRROR + 31 * MIN };
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.consult_index_mirror).toMatchObject({ ok: true, lag_minutes: 31, clinic_hours: false });
  });

  it("a non-zero exit is 503 after hours, with the code and reason", async () => {
    vi.setSystemTime(new Date(ist("2026-10-12", "21:00")));
    H.exit = { exit_code: 2, reason: "mirror_failed" };
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.consult_index_mirror).toMatchObject({ ok: false, exit_code: 2, reason: "mirror_failed", clinic_hours: false });
  });

  it("scribe_health returns the same block and the same red", async () => {
    H.clocks = { mirror_t1_ms: MIRROR, reb_t1_ms: MIRROR + 31 * MIN };
    H.exit = { exit_code: 2, reason: "mirror_failed" };
    const { HEALTH_TOOLS } = await import("@/lib/mcp/tools/health");
    const tool = HEALTH_TOOLS.find((t) => t.name === "scribe_health")!;
    const out = (await tool.handler({} as never, {} as never)) as { ok: boolean; consult_index_mirror: { ok: boolean; lag_minutes: number | null; exit_code: number | null; reason: string | null } };
    expect(out.ok).toBe(false);
    expect(out.consult_index_mirror).toMatchObject({ ok: false, lag_minutes: 31, exit_code: 2, reason: "mirror_failed" });
  });
});

describe("POST /api/consult-index/mirror-run", () => {
  beforeEach(() => {
    armSql();
    vi.stubEnv("INDEX_MIRROR_INGEST_TOKEN", "mirror-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function post(body: unknown, auth = "Bearer mirror-token") {
    return import("@/app/api/consult-index/mirror-run/route").then(({ POST }) => POST(new NextRequest("http://localhost/api/consult-index/mirror-run", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })));
  }

  it("refuses a missing token with 503 and a wrong token with 401, and writes nothing", async () => {
    vi.stubEnv("INDEX_MIRROR_INGEST_TOKEN", "");
    expect((await post({ exit_code: 1 })).status).toBe(503);
    vi.stubEnv("INDEX_MIRROR_INGEST_TOKEN", "mirror-token");
    H.sql.mockClear();
    expect((await post({ exit_code: 1 }, "Bearer no")).status).toBe(401);
    expect(H.sql).not.toHaveBeenCalled();
  });

  it("stores a non-zero exit and does not log the reason", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ exit_code: 4, reason: "mirror_failed", note: "SHOULD_NOT_ECHO" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, exit_code: 4 });
    const insert = H.sql.mock.calls.find((c) => String(c[0]).includes("INSERT INTO index_mirror_run"));
    expect(insert).toBeTruthy();
    expect(insert!.slice(1)).toEqual([4, "mirror_failed"]);
    expect(err).not.toHaveBeenCalled();
    expect(JSON.stringify(insert)).not.toContain("SHOULD_NOT_ECHO");
    err.mockRestore();
  });

  it("a bad reason is 400 and a database fault is 503 with the exit code only in the log", async () => {
    expect((await post({ exit_code: 1, reason: "not a token" })).status).toBe(400);
    H.sql.mockImplementation(async () => {
      const e = new Error("db down");
      (e as { code?: string }).code = "57014";
      throw e;
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ exit_code: 4, reason: "mirror_failed" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db" });
    expect(JSON.parse(String(err.mock.calls[0]?.[1]))).toEqual({ sqlstate: "57014", exit_code: 4 });
    err.mockRestore();
  });
});

describe("sync copies a manifest exit and does not fail the index when the table is absent", () => {
  beforeEach(() => {
    armSql();
    H.sql.mockClear();
  });

  function publish(extra: Record<string, unknown>) {
    const latest = "";
    const manifest = JSON.stringify({ sha256: sha256Hex(latest), rows: 0, generated_at: "2026-10-12T06:30:00Z", ...extra });
    const objects = new Map<string, { body: string; etag: string }>([
      ["consult/index/latest.jsonl", { body: latest, etag: "e1" }],
      ["consult/index/manifest.json", { body: manifest, etag: "e2" }],
    ]);
    H.lab = { get: async (k) => objects.get(k) ?? null };
  }

  it("a manifest exit is inserted; a manifest with no exit is not", async () => {
    publish({ exit_code: 1, exit_reason: "mirror_failed" });
    const r = await syncConsultIndex();
    expect(r.ok).toBe(true);
    const insert = H.sql.mock.calls.find((c) => String(c[0]).includes("INSERT INTO index_mirror_run"));
    expect(insert!.slice(1)).toContain(1);
    expect(insert!.slice(1)).toContain("mirror_failed");
    expect(insert!.slice(1)).toContain("2026-10-12T06:30:00.000Z");

    H.sql.mockClear();
    publish({});
    expect((await syncConsultIndex()).ok).toBe(true);
    expect(H.sql.mock.calls.some((c) => String(c[0]).includes("INSERT INTO index_mirror_run"))).toBe(false);
  });

  it("a missing table is not a failed sync; any other write fault is", async () => {
    publish({ exit_code: 1, reason: "mirror_failed" });
    H.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (text.includes("INSERT INTO consult_index_sync")) return [{ id: 7 }];
      if (text.includes("INSERT INTO index_mirror_run")) {
        const e = new Error("undefined_table");
        (e as { code?: string }).code = "42P01";
        throw e;
      }
      return [];
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await syncConsultIndex()).ok).toBe(true);
    expect(String(err.mock.calls[0]?.[1])).toContain("42P01");
    expect(String(err.mock.calls[0]?.[1])).not.toContain("mirror_failed");
    err.mockRestore();

    H.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (text.includes("INSERT INTO consult_index_sync")) return [{ id: 7 }];
      if (text.includes("INSERT INTO index_mirror_run")) {
        const e = new Error("query_canceled");
        (e as { code?: string }).code = "57014";
        throw e;
      }
      return [];
    });
    const again = await syncConsultIndex();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("sync_failed");
  });
});
