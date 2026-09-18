/**
 * ETA-OVERLAPPING-WRITERS phase 1 (C1, C2, C3) — the two doors closed, proven against a real
 * postgres:16 holding every migration, through the real POST /{slug}/api/encounters/{id}/process,
 * both the step-mode (background) and the streaming (foreground/Retry) branches.
 *
 * Only the outside world is faked: R2, the note generator, the CDMSS pipeline, the diarize
 * service, Deepgram, the voiceprint loader, the eta-router chunked-job transport, next/server's
 * after(), and doctor/admin auth. The database is real, and `@/lib/db`'s `sql` is a thin wrapper
 * around it that can PAUSE one matching statement once — the mechanism every "lost the claim"
 * test below uses to make a real race land deterministically, rather than hoping two Promises
 * interleave the right way.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

type Json = Record<string, unknown>;

const H = vi.hoisted(() => ({
  realSql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  /** Once-only pause: the next statement whose text includes this substring awaits `gate` first. */
  pauseMatch: null as null | string,
  gate: null as null | Promise<void>,
  afters: [] as Array<() => Promise<unknown> | unknown>,
  noteCalls: 0,
  cdmsCalls: 0,
  submitCalls: 0,
  pollCalls: 0,
  jobState: "running" as "running" | "done",
}));

/** The wrapper every test in this file goes through: real Postgres, one interceptable pause. */
const sql = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
  if (H.pauseMatch) {
    const text = strings.join("?");
    if (text.includes(H.pauseMatch)) {
      H.pauseMatch = null;
      await H.gate;
    }
  }
  return H.realSql!(strings, ...values);
};
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => sql(s, ...v) }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { H.afters.push(fn as () => Promise<unknown>); },
}));
vi.mock("@/lib/r2", async (orig) => ({
  ...(await orig<Json>()),
  headObject: async () => ({ content_type: "audio/webm", size: 4 }),
  getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]),
  signGetUrl: async () => "https://r2.example/x",
}));
vi.mock("@/lib/diarize", async (orig) => ({
  ...(await orig<Json>()),
  runDiarize: async () => ({
    ok: true,
    result: { speakers: [], transcript_segments: [], overlap_windows: [], aggregates: {} },
    latencyMs: 1,
    timing: { queue_wait_ms: 0, wall_ms: 1, service_ms: 1, transfer_ms: 0, audio_bytes: 4, timeout_ms: 1000, timed_out: false, ungated: false, queued_at: new Date().toISOString(), dispatched_at: new Date().toISOString(), completed_at: new Date().toISOString() },
  }),
}));
vi.mock("@/lib/transcribe", async (orig) => ({ ...(await orig<Json>()), transcribeDiarized: async () => ({ ok: true, entries: [] }) }));
vi.mock("@/lib/stt/diarize-window", async (orig) => ({ ...(await orig<Json>()), loadActiveClinicianCentroid: async () => null }));
vi.mock("@/lib/whisper", async (orig) => ({ ...(await orig<Json>()), transcribeWithWhisper: async () => ({ ok: false, error: "fixture: whisper not called" }) }));
vi.mock("@/lib/voice-samples", async (orig) => ({ ...(await orig<Json>()), capturePassiveSample: async () => {} }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Json>()), readAdminCookie: async () => null, readDoctorCookie: async () => null }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<Json>()), verifyAdminJwt: async () => ({ admin_id: "adm_session" }) }));
// generateNote/runCdmssPipeline: distinct, test-tagged output so "whose note/CDS landed" is checkable.
vi.mock("@/lib/note-generation", async (orig) => ({
  ...(await orig<Json>()),
  generateNote: async () => {
    H.noteCalls += 1;
    return { ok: true, note: { fixture: "note-A" }, latency_ms: 1, model: "fixture", provider: "fixture", raw_response: "{}" };
  },
}));
vi.mock("@/lib/cdmss-pipeline", async (orig) => ({
  ...(await orig<Json>()),
  runCdmssPipeline: async () => {
    H.cdmsCalls += 1;
    return { ok: true, cdmss: { differentials_to_consider: [], red_flags: [], evidence_based_suggestions: [], follow_up_considerations: [] }, latency_ms: 1, llm_calls: [] };
  },
}));
// C3's fixture: a chunked job that never finishes inside translateIfNeeded's 240s poll deadline.
vi.mock("@/lib/stt/eta-router", async (orig) => ({
  ...(await orig<Json>()),
  submitRouteJob: async () => { H.submitCalls += 1; return { ok: true, job_id: "rj_fixture" }; },
  pollRouteJob: async () => {
    H.pollCalls += 1;
    return H.jobState === "done"
      ? { ok: true, state: "done", transcript_english: "chunked done", transcript_native: null, dominant_language: "en" }
      : { ok: true, state: "running", progress: { done: 1, total: 4 } };
  },
}));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-ow-p1-claim");
const SECRET = "ow-p1-migration-secret";
const ORIGIN = "https://eta.test";
const DOC = makeFakeClinician(21);

describe("REQUIRED PROOF — ETA-OVERLAPPING-WRITERS phase 1 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/overlapping-writers-claim.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((n) => n.endsWith(".sql")).sort()) {
    pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }
  pg.exec(`INSERT INTO clinician (id, email, full_name, url_slug, url_token) VALUES ('${DOC.id}', '${DOC.email}', '${DOC.full_name}', '${DOC.url_slug}', '${DOC.url_token}')`);
  H.realSql = pg.sql;
  process.env.MIGRATION_SECRET = SECRET;
}, 240_000);
afterAll(() => {
  if (!HAVE_DOCKER) return;
  pg.stop();
});

let seq = 0;
/** A clinically-simple encounter: translated (so translateIfNeeded is a no-op), needing the note step. */
const seedEncounter = (over: Partial<Record<string, string | boolean | number | null>> = {}) => {
  const id = `enc_owp1_${process.pid}_${(seq += 1)}`;
  const f: Record<string, string | boolean | number | null> = {
    status: "processing", transcript_raw: "fixture transcript text", audio_object_key: `audio/${id}.webm`,
    note_json: null, translated: true, diarize_status: "skipped", process_attempts: 0, duration_seconds: 60, router_job_id: null,
    ...over,
  };
  const cols = Object.keys(f);
  const vals = cols.map((c) => {
    const v = f[c];
    if (v === null) return "NULL";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  pg.exec(`INSERT INTO encounter (id, doctor_id, ${cols.join(", ")}) VALUES ('${id}', '${DOC.id}', ${vals.join(", ")})`);
  return id;
};
const rowOf = async (id: string) =>
  ((await pg.sql`SELECT status::text AS status, note_json, cdmss_json, transcript_clean, process_attempts, router_job_id,
                        processing_step_at IS NOT NULL AS locked
                   FROM encounter WHERE id = ${id}`) as Array<{
    status: string; note_json: { fixture?: string } | null; cdmss_json: unknown | null; transcript_clean: string | null;
    process_attempts: number; router_job_id: string | null; locked: boolean;
  }>)[0]!;
const waitLocked = async (id: string, want: boolean, tries = 50): Promise<void> => {
  for (let i = 0; i < tries; i += 1) {
    if ((await rowOf(id)).locked === want) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitLocked(${id}, ${want}) timed out`);
};
const captured = async <T,>(fn: () => Promise<T>) => {
  const lines: string[] = [];
  const push = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const spies = [vi.spyOn(console, "error").mockImplementation(push), vi.spyOn(console, "warn").mockImplementation(push)];
  try { return { out: await fn(), lines }; } finally { for (const s of spies) s.mockRestore(); }
};
const reset = () => { H.pauseMatch = null; H.gate = null; H.afters = []; H.noteCalls = 0; H.cdmsCalls = 0; H.submitCalls = 0; H.pollCalls = 0; H.jobState = "running"; };

/** One SYNC step — the resume loop's own shape (tests/unit/e31b2-encounter.test.ts's convention). */
const syncStep = async (id: string, only?: string) => {
  const { POST } = await import("@/app/[slug]/api/encounters/[id]/process/route");
  const body: Json = { step: true, sync: true };
  if (only) body.only = only;
  const res = await POST(new NextRequest(`${ORIGIN}/${DOC.url_slug}/api/encounters/${id}/process`, {
    method: "POST", headers: { "content-type": "application/json", "x-eta-internal": SECRET }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ slug: DOC.url_slug, id }) });
  const j = (await res.json()) as Json;
  return { status: res.status, body: j };
};
/** One ASYNC step: ACK, then the scheduled after() work runs, in-process. */
const asyncStep = async (id: string, only?: string) => {
  const { POST } = await import("@/app/[slug]/api/encounters/[id]/process/route");
  H.afters = [];
  const body: Json = { step: true };
  if (only) body.only = only;
  const res = await POST(new NextRequest(`${ORIGIN}/${DOC.url_slug}/api/encounters/${id}/process`, {
    method: "POST", headers: { "content-type": "application/json", "x-eta-internal": SECRET }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ slug: DOC.url_slug, id }) });
  const j = (await res.json()) as Json;
  for (let i = 0; i < H.afters.length; i += 1) await H.afters[i]!();
  return { status: res.status, body: j };
};
/** The doctor's "Retry"/"Regenerate" call: the NDJSON streaming branch. Returns the parsed events. */
const streamStep = async (id: string, force = true) => {
  const { POST } = await import("@/app/[slug]/api/encounters/[id]/process/route");
  const res = await POST(new NextRequest(`${ORIGIN}/${DOC.url_slug}/api/encounters/${id}/process`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson", "x-eta-internal": SECRET }, body: JSON.stringify({ force }),
  }), { params: Promise.resolve({ slug: DOC.url_slug, id }) });
  if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
    // The pre-stream refusal path (C2's claim failure): a plain JSON response, no stream.
    // (NextResponse.json() still has a non-null `.body` — a JSON response is bytes too — so the
    // content-type, not body-nullness, is what actually distinguishes the two shapes.)
    const j = (await res.json()) as Json;
    return { status: res.status, events: [] as Json[], refusal: j };
  }
  const text = await new Response(res.body).text();
  const events = text.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Json);
  return { status: res.status, events, refusal: null as Json | null };
};

describe.runIf(HAVE_DOCKER)("C1 — the claim gains a holder", () => {
  it("VERIFICATION 1: two concurrent claimants — exactly one passes, the other reads locked", async () => {
    reset();
    const id = seedEncounter();
    const [a, b] = await Promise.all([syncStep(id, "note"), syncStep(id, "note")]);
    const results = [a, b];
    const locked = results.filter((r) => r.body.skipped === "locked");
    const ran = results.filter((r) => r.body.skipped !== "locked");
    expect(locked, "exactly one of the two concurrent claimants is refused").toHaveLength(1);
    expect(ran, "and exactly one actually runs the step").toHaveLength(1);
    expect(locked[0]!.body.lock, "the refusal names who holds it and since when").toBeTruthy();
    expect(H.noteCalls, "the note generator ran exactly once, not twice").toBe(1);
  }, 30_000);

  it("VERIFICATION 2: a holder that has lost its claim writes 0 rows and logs the marker; the newer holder's data survives", async () => {
    reset();
    const id = seedEncounter();
    H.pauseMatch = "note_json = ";
    let releaseGate!: () => void;
    H.gate = new Promise((r) => { releaseGate = r; });
    const p = captured(() => syncStep(id, "note"));
    await waitLocked(id, true); // A has claimed
    // Simulate the claim being superseded while A is paused mid-write: A's claim expires, then a
    // newer holder (B) claims fresh AND lands its own note — exactly the shape the survey's
    // residual race describes (§4a/§4c): B's generation must not be clobbered by A's stale write.
    await pg.sql`UPDATE encounter SET processing_step_at = now() - interval '10 minutes' WHERE id = ${id}`;
    await pg.sql`UPDATE encounter SET processing_step_at = now(), note_json = ${JSON.stringify({ fixture: "note-B" })}::jsonb WHERE id = ${id}`;
    releaseGate();
    const r = await p;
    expect(r.out.body.progressed, "A's own write lost the fence, so A did not progress").toBe(false);
    expect(r.lines.some((l) => l.includes("[process:fence] LOST CLAIM") && l.includes("step=note")), "the distinct marker, not disguised as a normal failure").toBe(true);
    const row = await rowOf(id);
    expect(row.note_json, "B's note survives — A's stale write matched 0 rows and never landed").toEqual({ fixture: "note-B" });
  }, 30_000);

  it("VERIFICATION 3: a stale holder's release does not clear a newer claim", async () => {
    reset();
    const id = seedEncounter({ note_json: JSON.stringify({ fixture: "already-noted" }) });
    // needFinalize: note_json set, status != complete -> the "finalize" step, a single clean write,
    // followed immediately by releaseAndReset — the release is what this test pauses.
    H.pauseMatch = "process_attempts = 0, processing_step_at = NULL";
    let releaseGate!: () => void;
    H.gate = new Promise((r) => { releaseGate = r; });
    const p = captured(() => syncStep(id, "finalize"));
    await waitLocked(id, true); // A has claimed and (per the pause) is about to release
    // A's own step write already landed (status='complete'); now simulate B claiming BEFORE A's
    // release runs — the unfenced-release hazard the survey walks through at §4c.
    await pg.sql`UPDATE encounter SET processing_step_at = now() - interval '10 minutes' WHERE id = ${id}`;
    await pg.sql`UPDATE encounter SET processing_step_at = now() WHERE id = ${id}`; // B's live claim
    releaseGate();
    await p;
    const row = await rowOf(id);
    expect(row.locked, "B's claim is still held — A's stale release did not clear it").toBe(true);
  }, 30_000);
});

describe.runIf(HAVE_DOCKER)("C2 — the streaming branch takes the same claim", () => {
  it("VERIFICATION 5: the streaming branch refuses while a step claim is held, with the holder's age in the response", async () => {
    reset();
    const id = seedEncounter({ note_json: JSON.stringify({ fixture: "already-noted" }) });
    await pg.sql`UPDATE encounter SET processing_step_at = now() - interval '30 seconds' WHERE id = ${id}`; // a live step claim
    const r = await streamStep(id);
    expect(r.events, "does NOT run: no stream at all").toHaveLength(0);
    expect(r.refusal?.skipped).toBe("locked");
    const lock = r.refusal?.lock as { held_s?: number } | null;
    expect(lock?.held_s, "the current holder's age, in seconds").toBeGreaterThanOrEqual(25);
    expect(H.noteCalls, "no note generation was attempted").toBe(0);
  }, 30_000);

  it("does claim, and releases fenced, on an uncontended run", async () => {
    reset();
    const id = seedEncounter();
    const r = await streamStep(id);
    expect(r.refusal).toBeNull();
    const final = r.events.find((e) => e.stage === "final");
    expect(final, "reaches the normal completion event").toBeTruthy();
    await waitLocked(id, false); // released
    expect((await rowOf(id)).status).toBe("complete");
  }, 30_000);
});

describe.runIf(HAVE_DOCKER)("C3 — the streaming branch respects jobPending", () => {
  it("VERIFICATION 4: with jobPending true, the streaming branch generates no note and writes no note_json", async () => {
    reset();
    H.jobState = "running"; // never finishes inside the poll deadline
    // Empty transcript_raw -> "rescue" mode, which is what actually routes into the chunked-job
    // path regardless of language (the English whisper-refine branch returns early otherwise —
    // it is gated on non-English/Indic OR rescue, not on duration alone).
    const id = seedEncounter({ translated: false, transcript_raw: "", duration_seconds: 600, router_job_id: null }); // tooLongForRouter
    // REAL TIMERS: the poll loop's 240s deadline (6s sleeps) is a route.ts constant, not injected,
    // and fake-timers did not reliably drive this specific while-loop. Slow but matches this
    // suite's own convention for a genuinely multi-minute flow (other files here already run to
    // 300_000ms). The job never reaches "done" (H.jobState stays "running"), so this really
    // exhausts the deadline rather than racing it.
    const r = await streamStep(id);
    const jobPendingEvent = r.events.find((e) => e.where === "job_pending");
    expect(jobPendingEvent, "refused in the same (skipped) shape C2 uses").toBeTruthy();
    expect(jobPendingEvent?.skipped).toBe("job_pending");
    expect(r.events.some((e) => e.stage === "final"), "never reaches completion").toBe(false);
    expect(H.noteCalls, "no note was generated from the finalize placeholder").toBe(0);
    const row = await rowOf(id);
    expect(row.note_json, "and none was written").toBeNull();
    await waitLocked(id, false); // released fenced even on the C3 refusal path
  }, 260_000);
});

describe.runIf(HAVE_DOCKER)("VERIFICATION 6 — regression: a single uncontended run is unchanged", () => {
  it("step mode: translate(skip) -> note -> finalize -> cdms -> diarize, self-chained, completes exactly as before", async () => {
    reset();
    const id = seedEncounter();
    let guard = 0;
    while (guard < 8) {
      guard += 1;
      const r = await captured(() => asyncStep(id));
      expect(r.lines.some((l) => l.includes("LOST CLAIM")), "no contention in this run: never fires").toBe(false);
      const row = await rowOf(id);
      if (row.status === "complete" && row.note_json && row.cdmss_json) break;
    }
    const row = await rowOf(id);
    expect(row.status).toBe("complete");
    expect(row.note_json).toEqual({ fixture: "note-A" });
    expect(row.cdmss_json).toBeTruthy();
    expect(row.locked, "released").toBe(false);
    expect(H.noteCalls).toBe(1);
    expect(H.cdmsCalls).toBe(1);
  }, 60_000);

  it("streaming: note -> cdms -> diarize, one invocation, completes exactly as before", async () => {
    reset();
    const id = seedEncounter();
    const r = await streamStep(id);
    expect(r.refusal).toBeNull();
    const stages = r.events.map((e) => e.stage);
    expect(stages).toContain("final");
    expect(stages, "no fence-loss ever surfaces on an uncontended run").not.toContain("error");
    const final = r.events.find((e) => e.stage === "final")!;
    expect((final.note as Json).fixture).toBe("note-A");
    expect(final.cdmss).toBeTruthy();
    const row = await rowOf(id);
    expect(row.status).toBe("complete");
    expect(row.locked).toBe(false);
    expect(H.noteCalls).toBe(1);
    expect(H.cdmsCalls).toBe(1);
  }, 30_000);
});
