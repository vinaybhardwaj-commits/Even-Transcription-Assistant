/**
 * E31 BATCH 2, ROUND 1 — B1 and B2, the two sites in diarizeStore. Against a real postgres:16 holding EVERY
 * migration in db/migrations, through the real POST /{slug}/api/encounters/{id}/process, the real rediarize door
 * (GET /api/admin/resume-processing?rediarize=1) and the real EER matcher (GET /api/admin/diarization-eer).
 *
 * B1 — THREE AUTOCOMMITTED WRITES WHERE THE FIRST ANNOUNCES COMPLETION.
 *   W1 (the diarize result, diarize_status='complete') stays SEPARATE from the tag block (D-7): its two readers,
 *   the step gate and the EER matcher, need it whether or not Deepgram answered. W2 (the turns) and W3 (the refined
 *   roster) are ONE statement. A tag block that does not complete names itself in diarize_error with a closed code
 *   (D-6), the doctor's page says the conversation is unavailable, and the rediarize door clears the previous run's
 *   turns and roster so a re-run cannot mix them.
 *
 * B2 — A FAILURE WRITE WHOSE OWN FAILURE WAS SWALLOWED, FOLLOWED BY "PROGRESSED".
 *   The step machine reset the attempts on that `true` and self-chained, so the 15-attempt cap was never reached
 *   (A1's shape). diarizeStore now reports three outcomes (D-8); only a recorded conclusion is progress.
 *
 * Failure is injected BY THE DATABASE: BEFORE UPDATE triggers on encounter that RAISE, or RETURN NULL (a write that
 * "succeeds" and lands nothing). Only the outside world is faked — R2, the Mac Mini's /diarize, Deepgram, the
 * voiceprint loader, next/server's after(), and the admin session — and self-chain / resume HTTP calls are routed
 * back into the real handlers in-process.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

type Json = Record<string, unknown>;
const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  /** after() callbacks the route scheduled, in order. The test runs them. */
  afters: [] as Array<() => Promise<unknown> | unknown>,
  /** self-chain / resume POSTs to /process: "dispatch" runs them in-process, "record" only notes them. */
  chainMode: "dispatch" as "dispatch" | "record",
  chained: [] as string[],
  r2Throw: null as null | string,
  diarize: null as null | (() => unknown),
  diarizeCalls: 0,
  deepgram: null as null | (() => unknown),
  deepgramCalls: 0,
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { H.afters.push(fn as () => Promise<unknown>); },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }), notFound: () => { throw new Error("notFound"); }, redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/r2", async (orig) => ({
  ...(await orig<Json>()),
  headObject: async () => { if (H.r2Throw) throw new Error(H.r2Throw); return { content_type: "audio/webm", size: 4 }; },
  getObjectBytes: async () => { if (H.r2Throw) throw new Error(H.r2Throw); return new Uint8Array([1, 2, 3, 4]); },
  signGetUrl: async () => "https://r2.example/x",
}));
vi.mock("@/lib/diarize", async (orig) => ({
  ...(await orig<Json>()),
  runDiarize: async () => { H.diarizeCalls += 1; return H.diarize!(); },
}));
vi.mock("@/lib/transcribe", async (orig) => ({
  ...(await orig<Json>()),
  transcribeDiarized: async () => { H.deepgramCalls += 1; return H.deepgram!(); },
}));
vi.mock("@/lib/stt/diarize-window", async (orig) => ({ ...(await orig<Json>()), loadActiveClinicianCentroid: async () => null }));
vi.mock("@/lib/voice-samples", async (orig) => ({ ...(await orig<Json>()), capturePassiveSample: async () => {} }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Json>()), readAdminCookie: async () => "admin-session", readDoctorCookie: async () => null }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<Json>()), verifyAdminJwt: async () => ({ admin_id: "adm_session" }) }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e31b2-encounter");
const SECRET = "e31b2-migration-secret";
const ORIGIN = "https://eta.test";
const DOC = makeFakeClinician(1);

describe("REQUIRED PROOF — E31 batch 2 round 1 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e31b2-encounter.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

let realFetch: typeof fetch;
beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  // THE REAL SCHEMA: every migration, in order — the encounter_status enum, the diarize_status CHECK, the FKs.
  for (const f of readdirSync("db/migrations").filter((n) => n.endsWith(".sql")).sort()) {
    pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }
  pg.exec(`INSERT INTO clinician (id, email, full_name, url_slug, url_token) VALUES ('${DOC.id}', '${DOC.email}', '${DOC.full_name}', '${DOC.url_slug}', '${DOC.url_token}')`);
  H.sql = pg.sql;
  process.env.MIGRATION_SECRET = SECRET;
  process.env.DEEPGRAM_API_KEY = "fixture";
  realFetch = globalThis.fetch;
  // Self-chain and resume calls to /process are routed back into the real handler.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /\/([^/]+)\/api\/encounters\/(enc_[^/]+)\/process$/.exec(url);
    if (!m) return realFetch(input, init);
    H.chained.push(String(init?.body ?? ""));
    if (H.chainMode === "record") return Response.json({ ok: true });
    const { POST } = await import("@/app/[slug]/api/encounters/[id]/process/route");
    return POST(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), { params: Promise.resolve({ slug: m[1]!, id: m[2]! }) });
  }) as typeof fetch;
}, 240_000);
afterAll(() => {
  if (!HAVE_DOCKER) return;
  globalThis.fetch = realFetch;
  pg.stop();
});

// ── injection: triggers on encounter ─────────────────────────────────────────────────────────────────────────
const arm = (name: string, when: string, action: "raise" | "silent") => pg.exec(`
  CREATE OR REPLACE FUNCTION e31b2_${name}() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN ${action === "raise" ? `RAISE EXCEPTION 'E31b2 injected failure: ${name}';` : "RETURN NULL;"} END $$;
  DROP TRIGGER IF EXISTS e31b2_${name} ON encounter;
  CREATE TRIGGER e31b2_${name} BEFORE UPDATE ON encounter FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION e31b2_${name}();
`);
const disarmAll = () => pg.exec(`
  DO $$ DECLARE t text; BEGIN
    FOR t IN SELECT tgname FROM pg_trigger WHERE tgrelid = 'encounter'::regclass AND tgname LIKE 'e31b2_%' LOOP
      EXECUTE format('DROP TRIGGER %I ON encounter', t);
    END LOOP;
  END $$;`);
/** The tag write: turns change to a non-null value. W1 and the door's clearing never match. */
const TAG_WRITE = `NEW.tagged_transcript IS NOT NULL AND NEW.tagged_transcript IS DISTINCT FROM OLD.tagged_transcript`;
/** Only the ROSTER half of the tag block: speakers change on a row already 'complete' (W1 changes them from 'running'). */
const ROSTER_HALF = `NEW.speakers IS NOT NULL AND NEW.speakers IS DISTINCT FROM OLD.speakers AND OLD.diarize_status = 'complete'`;
/** Every diarize failure write: F1, F2, F3. */
const FAILURE_WRITE = `NEW.diarize_status = 'failed'`;

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────
const timing = () => ({ queue_wait_ms: 0, wall_ms: 10, service_ms: 8, transfer_ms: 2, audio_bytes: 4, timeout_ms: 1000, timed_out: false, ungated: false, queued_at: new Date().toISOString(), dispatched_at: new Date().toISOString(), completed_at: new Date().toISOString() });
const SEGS = [{ start_ms: 0, end_ms: 5000, speaker_idx: 0 }, { start_ms: 5000, end_ms: 10000, speaker_idx: 1 }];
/** Run one's roster and run two's roster: the non-auto speaker is labelled differently, so a mixture is visible. */
const roster = (other: string) => [
  { idx: 0, label: DOC.label, type: "clinician", source: "auto", clinician_id: DOC.id, confidence: 0.91 },
  { idx: 1, label: other, type: "attender" },
];
const diarizeOk = (other: string) => () => ({ ok: true, result: { speakers: roster(other), transcript_segments: SEGS, overlap_windows: [], aggregates: {} }, latencyMs: 10, timing: timing() });
/** Speaker B speaks in the first person three times, so applyRoleOverrides refines idx 1 to Patient (changed=true). */
const FIRST_PERSON_ENTRIES = [
  { transcript: "How are you feeling today", start: 0.2, end: 4.5, speakerId: "A" },
  { transcript: "I have a fever and my head aches since yesterday", start: 5.2, end: 9.5, speakerId: "B" },
];
/** No first person: no refinement (changed=false). */
const PLAIN_ENTRIES = [
  { transcript: "Please sit down", start: 0.2, end: 4.5, speakerId: "A" },
  { transcript: "Thank you doctor", start: 5.2, end: 9.5, speakerId: "B" },
];
const deepgramOk = (entries: unknown[]) => () => ({ ok: true, entries });

let seq = 0;
/** A clinically complete encounter waiting on diarization, as the step machine meets it. */
const seedEncounter = (over: Partial<Record<"status" | "diarize_status", string>> = {}) => {
  const id = `enc_b2_${process.pid}_${(seq += 1)}`;
  pg.exec(`INSERT INTO encounter (id, doctor_id, status, transcript_raw, audio_object_key, note_json, translated, diarize_status, process_attempts)
           VALUES ('${id}', '${DOC.id}', '${over.status ?? "complete"}', 'fixture transcript text', 'audio/${id}.webm', '{"fixture":true}'::jsonb, true,
                   ${over.diarize_status ? `'${over.diarize_status}'` : "NULL"}, 0)`);
  return id;
};
const rowOf = async (id: string) =>
  ((await pg.sql`SELECT status::text AS status, diarize_status, diarize_error, speakers, tagged_transcript, process_attempts,
                        processing_step_at IS NOT NULL AS locked
                   FROM encounter WHERE id = ${id}`) as Array<{
    status: string; diarize_status: string | null; diarize_error: string | null; speakers: Array<{ idx: number; label: string; type: string }> | null;
    tagged_transcript: Array<{ name: string; speaker_idx: number | null; text: string }> | null; process_attempts: number; locked: boolean;
  }>)[0]!;
const ageLock = (id: string) => pg.exec(`UPDATE encounter SET processing_step_at = now() - interval '6 minutes' WHERE id = '${id}' AND processing_step_at IS NOT NULL`);

const captured = async <T,>(fn: () => Promise<T>) => {
  const lines: string[] = [];
  const push = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const spies = [vi.spyOn(console, "error").mockImplementation(push), vi.spyOn(console, "warn").mockImplementation(push), vi.spyOn(console, "log").mockImplementation(push)];
  try {
    return { out: await fn(), lines };
  } finally {
    for (const s of spies) s.mockRestore();
  }
};
const reset = (over: Partial<typeof H> = {}) => {
  H.afters = []; H.chained = []; H.chainMode = "dispatch"; H.r2Throw = null; H.diarizeCalls = 0; H.deepgramCalls = 0;
  H.diarize = diarizeOk("Attender"); H.deepgram = deepgramOk(FIRST_PERSON_ENTRIES);
  Object.assign(H, over);
};

/** One SYNC step, as the resume loop drives it. Returns the parsed envelope. */
const syncStep = async (id: string, only = "diarize") => {
  const { POST } = await import("@/app/[slug]/api/encounters/[id]/process/route");
  const res = await POST(new NextRequest(`${ORIGIN}/${DOC.url_slug}/api/encounters/${id}/process`, {
    method: "POST", headers: { "content-type": "application/json", "x-eta-internal": SECRET }, body: JSON.stringify({ step: true, sync: true, only }),
  }), { params: Promise.resolve({ slug: DOC.url_slug, id }) });
  const j = (await res.json()) as Json & { error?: { code: string; message: string } };
  return { status: res.status, body: { data: j.error ? undefined : j, error: j.error } };
};
/** One ASYNC step, as the self-chain drives it: ACK, then the scheduled after() work runs. */
const asyncStep = async (id: string) => {
  const { POST } = await import("@/app/[slug]/api/encounters/[id]/process/route");
  H.afters = [];
  const res = await POST(new NextRequest(`${ORIGIN}/${DOC.url_slug}/api/encounters/${id}/process`, {
    method: "POST", headers: { "content-type": "application/json", "x-eta-internal": SECRET }, body: JSON.stringify({ step: true }),
  }), { params: Promise.resolve({ slug: DOC.url_slug, id }) });
  const j = (await res.json()) as Json & { error?: { code: string; message: string } };
  const body = { data: j.error ? undefined : j, error: j.error };
  for (let i = 0; i < H.afters.length; i += 1) await H.afters[i]!();
  return body;
};
const rediarize = async (id: string) => {
  const { GET } = await import("@/app/api/admin/resume-processing/route");
  const res = await GET(new NextRequest(`${ORIGIN}/api/admin/resume-processing?id=${id}&rediarize=1`, {
    headers: { authorization: `Bearer ${SECRET}` },
  }));
  return { data: (await res.json()) as Json };
};
const eerSelects = async (id: string) => {
  const { GET } = await import("@/app/api/admin/diarization-eer/route");
  const body = (await (await GET()).json()) as { items?: Array<{ encounter_id: string }> };
  return (body.items ?? []).some((i) => i.encounter_id === id);
};
/** The doctor's page, as the page component builds it from the row. */
const renderDoctorPanel = async (row: Awaited<ReturnType<typeof rowOf>>) => {
  const { EncounterDetailClient } = await import("@/components/encounter/EncounterDetailClient");
  const { conversationUnavailable } = await import("@/lib/diarize-conversation");
  return renderToStaticMarkup(React.createElement(EncounterDetailClient, {
    slug: DOC.url_slug, doctorEmail: DOC.email, doctorName: DOC.full_name,
    initial: {
      id: "enc_render", status: "complete", note: null, cdmss: null, transcript: null, transcriptOriginal: null, detectedLanguage: null,
      nativeAnalysis: null, nativeAnalysisLang: null, processingPct: 100, processingStages: null,
      speakers: row.speakers, taggedTranscript: row.tagged_transcript, diarizeStatus: row.diarize_status,
      conversationUnavailable: conversationUnavailable(row.diarize_status, row.diarize_error),
      sendStatus: "pending", sentAt: null, sendEvents: [],
    },
  }));
};
const UNAVAILABLE = "The conversation by speaker is unavailable for this recording.";
const NOT_RECORDED_CODE = "tagged_transcript_not_recorded";

describe.runIf(HAVE_DOCKER)("E31 batch 2 — B1: the diarize result, the tagged turns and the refined roster", () => {
  it("B1 HAPPY PATH: one run lands the result, the turns and the refined roster; no degraded code; the page shows the conversation", async () => {
    reset();
    const id = seedEncounter();
    const r = await captured(() => syncStep(id));
    expect(r.out.body.data?.progressed).toBe(true);
    const row = await rowOf(id);
    expect(row.diarize_status).toBe("complete");
    expect(row.diarize_error, "nothing was lost").toBeNull();
    expect(row.speakers?.[1]).toMatchObject({ label: "Patient", type: "patient" });
    expect(row.tagged_transcript?.map((t) => t.name)).toEqual([DOC.label, "Patient"]);
    const html = await renderDoctorPanel(row);
    expect(html).toContain("Conversation by speaker (2 turns)");
    expect(html).not.toContain(UNAVAILABLE);
  }, 120_000);

  it("B1 TAG BLOCK FAILS WHILE W1 LANDS: complete, the closed code is written, and the doctor's page says the conversation is unavailable", async () => {
    reset();
    const id = seedEncounter();
    arm("tag_write", TAG_WRITE, "raise");
    let r;
    try { r = await captured(() => syncStep(id)); } finally { disarmAll(); }
    const row = await rowOf(id);
    expect(row.diarize_status, "W1 landed and stays 'complete' (D-7)").toBe("complete");
    expect(row.speakers?.map((s) => s.label), "W1's roster, unrefined").toEqual([DOC.label, "Attender"]);
    expect(row.tagged_transcript, "no turns landed").toBeNull();
    expect(row.diarize_error, "D-6: the loss is named, with the closed code").toBe(NOT_RECORDED_CODE);
    expect(r.lines.some((l) => l.includes("SPEAKER-TAGGED CONVERSATION NOT RECORDED")), "and logged").toBe(true);
    expect(r.out.body.data?.progressed, "W1 is a recorded conclusion: progress").toBe(true);
    const html = await renderDoctorPanel(row);
    expect(html, "the doctor is told, not shown an empty panel").toContain(UNAVAILABLE);
    expect(html).not.toContain("Conversation by speaker (");
  }, 120_000);

  it("B1 TAG WRITE LANDS ZERO ROWS (no throw): still named — a write has landed only if its row comes back", async () => {
    reset();
    const id = seedEncounter();
    arm("tag_silent", TAG_WRITE, "silent");
    try { await captured(() => syncStep(id)); } finally { disarmAll(); }
    const row = await rowOf(id);
    expect(row.tagged_transcript).toBeNull();
    expect(row.diarize_error).toBe(NOT_RECORDED_CODE);
  }, 120_000);

  it("B1 A LEGITIMATE EMPTY RUN IS NOT SPELLED AS A LOSS: Deepgram answers not-ok → complete, no turns, NO code, no 'unavailable'", async () => {
    reset({ deepgram: () => ({ ok: false, error: "deepgram_http_503" }) });
    const id = seedEncounter();
    await captured(() => syncStep(id));
    const row = await rowOf(id);
    expect(row.diarize_status).toBe("complete");
    expect(row.tagged_transcript).toBeNull();
    expect(row.diarize_error, "nothing to tag is not a loss").toBeNull();
    expect(await renderDoctorPanel(row)).not.toContain(UNAVAILABLE);
  }, 120_000);

  it("B1 W3'S HALF FAILS: the turns do NOT land without the roster they were named from — no 'turns refined, roster not' state", async () => {
    reset();
    const id = seedEncounter();
    arm("roster_half", ROSTER_HALF, "raise");
    try { await captured(() => syncStep(id)); } finally { disarmAll(); }
    const row = await rowOf(id);
    expect(row.speakers?.[1]?.label, "the roster was not refined").toBe("Attender");
    expect(row.tagged_transcript, "so the turns named from the REFINED roster did not land either").toBeNull();
    expect(row.diarize_error).toBe(NOT_RECORDED_CODE);
  }, 120_000);

  it("B1 W1's TWO READERS UNDISTURBED on a Deepgram OUTAGE (throws): needDiarize goes false (pyannote is not re-run) and the EER matcher still selects the row", async () => {
    reset({ deepgram: () => { throw new Error("deepgram unreachable"); } });
    const id = seedEncounter();
    await captured(() => syncStep(id));
    const row = await rowOf(id);
    expect(row.diarize_status).toBe("complete");
    expect(row.diarize_error).toBe(NOT_RECORDED_CODE);
    expect(H.diarizeCalls).toBe(1);
    const again = await captured(() => syncStep(id));
    expect(again.out.body.data?.step, "needDiarize is false: the step machine reports done").toBe("done");
    expect(H.diarizeCalls, "and the Mac Mini is not called again").toBe(1);
    expect(await eerSelects(id), "the EER matcher selects it (diarize_status complete, an auto speaker)").toBe(true);
  }, 120_000);

  it("B1 THE STALE CASE, THROUGH THE REDIARIZE DOOR: run one lands, run two's tag block fails — the row never holds run two's roster with run one's turns", async () => {
    reset({ diarize: diarizeOk("Attender"), deepgram: deepgramOk(PLAIN_ENTRIES) });
    const id = seedEncounter();
    await captured(() => syncStep(id));
    const one = await rowOf(id);
    expect(one.tagged_transcript?.map((t) => t.name), "run one: turns named from roster one").toEqual([DOC.label, "Attender"]);

    reset({ diarize: diarizeOk("Nurse"), deepgram: deepgramOk(PLAIN_ENTRIES) });
    arm("tag_write", TAG_WRITE, "raise");
    let door;
    try { door = await captured(() => rediarize(id)); } finally { disarmAll(); }
    expect(H.diarizeCalls, "the door really re-ran diarization").toBe(1);
    expect(door.out.data?.diarize_status).toBe("complete");
    const two = await rowOf(id);
    expect(two.speakers?.map((s) => s.label), "run two's roster").toEqual([DOC.label, "Nurse"]);
    expect(two.tagged_transcript, "run one's turns are gone, not left under run two's roster").toBeNull();
    const labels = new Set((two.speakers ?? []).map((s) => s.label));
    for (const t of two.tagged_transcript ?? []) expect(labels.has(t.name), `turn named "${t.name}" is not in the roster`).toBe(true);
    expect(two.diarize_error).toBe(NOT_RECORDED_CODE);
    expect(await renderDoctorPanel(two)).toContain(UNAVAILABLE);

    // And a third run through the door that lands clears the code: a loss is not sticky.
    reset({ diarize: diarizeOk("Nurse"), deepgram: deepgramOk(PLAIN_ENTRIES) });
    await captured(() => rediarize(id));
    const three = await rowOf(id);
    expect(three.diarize_error).toBeNull();
    expect(three.tagged_transcript?.map((t) => t.name)).toEqual([DOC.label, "Nurse"]);
    expect(await renderDoctorPanel(three)).not.toContain(UNAVAILABLE);
  }, 180_000);
});

describe.runIf(HAVE_DOCKER)("E31 batch 2 — B2: the failure write, and the progress that follows it", () => {
  it("B2 F3 HEALTHY, original error (R2 unreachable): the failure is recorded and IS progress — attempts reset, as before", async () => {
    reset({ r2Throw: "r2 unreachable" });
    const id = seedEncounter({ status: "processing" });
    const r = await captured(() => syncStep(id));
    const row = await rowOf(id);
    expect(row.diarize_status).toBe("failed");
    expect(row.diarize_error).toBe("r2 unreachable");
    expect(r.out.body.data?.progressed).toBe(true);
    expect(row.process_attempts).toBe(0);
    expect(row.status, "the terminal flip ran").toBe("complete");
  }, 120_000);

  it("B2 F3 FAILS WHILE THE ORIGINAL ERROR STANDS: not progress, attempts NOT reset, the lock is held, loud on its own line — and the terminal flip still runs", async () => {
    reset({ r2Throw: "r2 unreachable" });
    const id = seedEncounter({ status: "processing" });
    arm("f3", FAILURE_WRITE, "raise");
    let r;
    try { r = await captured(() => syncStep(id)); } finally { disarmAll(); }
    const row = await rowOf(id);
    expect(row.diarize_status, "the row still reads running: the failure did not land").toBe("running");
    expect(r.out.body.data?.progressed, "so no progress is claimed").toBe(false);
    expect(row.process_attempts, "the attempt stays counted").toBe(1);
    expect(row.locked, "the step lock is held to its TTL").toBe(true);
    expect(r.lines.some((l) => l.includes("DIARIZE FAILURE NOT RECORDED") && l.includes("the failure write failed")), "its own log line").toBe(true);
    expect(row.status, ":872's terminal flip runs whatever diarize did (unchanged)").toBe("complete");
  }, 120_000);

  it("B2 F3 AND THE ORIGINAL ERROR TOGETHER (one fault fails W1 and F3): not progress, not reset", async () => {
    reset();
    const id = seedEncounter();
    arm("w1_and_f3", `NEW.diarize_status IN ('complete', 'failed')`, "raise");
    let r;
    try { r = await captured(() => syncStep(id)); } finally { disarmAll(); }
    const row = await rowOf(id);
    expect(row.diarize_status).toBe("running");
    expect(r.out.body.data?.progressed).toBe(false);
    expect(row.process_attempts).toBe(1);
  }, 120_000);

  it("B2 F3 LANDS ZERO ROWS (no throw): not recorded either", async () => {
    reset({ r2Throw: "r2 unreachable" });
    const id = seedEncounter();
    arm("f3_silent", FAILURE_WRITE, "silent");
    let r;
    try { r = await captured(() => syncStep(id)); } finally { disarmAll(); }
    expect(r.out.body.data?.progressed).toBe(false);
    expect((await rowOf(id)).process_attempts).toBe(1);
    expect(r.lines.some((l) => l.includes("DIARIZE FAILURE NOT RECORDED") && l.includes("matched no row"))).toBe(true);
  }, 120_000);

  it("B2 THE LOOP IS BOUNDED (the test that would have caught A1): with F3 failing persistently, the self-chain stops, the attempts advance 1..15, and the cap is REACHED", async () => {
    reset({ r2Throw: "r2 unreachable" });
    const id = seedEncounter();
    arm("f3", FAILURE_WRITE, "raise");
    const attemptsSeen: number[] = [];
    let chainedCalls = 0;
    let gaveUp: { code: string; message: string } | undefined;
    try {
      await captured(async () => {
        // THE SELF-CHAIN, as production drives it. Before the fix every pass said "progressed", reset the attempts and
        // chained again — for ever. Bounded here at 40 so a regression fails instead of hanging.
        H.chainMode = "record";
        for (let i = 0; i < 40; i += 1) {
          const before = H.chained.length;
          await asyncStep(id);
          attemptsSeen.push((await rowOf(id)).process_attempts);
          if (H.chained.length === before) break;
          chainedCalls += 1;
          await ageLock(id);
        }
        // Whatever drives it next (the operator's rediarize, a manual resume), each pass is COUNTED. Drive it on, as
        // after the lock's TTL, until the step machine gives up.
        for (let i = 0; i < 40 && !gaveUp; i += 1) {
          await ageLock(id);
          const r = await syncStep(id);
          if (r.body.error) gaveUp = r.body.error;
          else attemptsSeen.push((await rowOf(id)).process_attempts);
        }
      });
    } finally {
      disarmAll();
    }
    expect(chainedCalls, "no self-chain over a failure that was not recorded").toBe(0);
    expect(attemptsSeen, "the counter advances on every pass and is never reset").toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(gaveUp?.code, "the 15-attempt cap is REACHED").toBe("PIPELINE_FAILED");
    expect(gaveUp?.message).toBe("gave_up_after_15_attempts_at_diarize");
    const row = await rowOf(id);
    console.log(`[e31b2] cap reached: attempts=${row.process_attempts} status=${row.status} diarize_status=${row.diarize_status}`);
  }, 300_000);

  it("B2 THROUGH THE REDIARIZE DOOR with F3 failing: the resume loop stops after ONE pass instead of re-running diarization", async () => {
    reset({ r2Throw: "r2 unreachable" });
    const id = seedEncounter();
    arm("f3", FAILURE_WRITE, "raise");
    let door;
    try { door = await captured(() => rediarize(id)); } finally { disarmAll(); }
    expect(H.chained.length, "one /process call, not a loop to the guard").toBe(1);
    expect(door.out.data?.diarize_status, "the door reports what the row says").toBe("running");
    expect((await rowOf(id)).process_attempts).toBe(1);
  }, 120_000);
});
