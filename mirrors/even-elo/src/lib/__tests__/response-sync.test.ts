import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeSql, json } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  sql: null as unknown as (...a: unknown[]) => unknown,
  ingest: null as unknown as () => Promise<unknown>,
}));

vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));
vi.mock("@/lib/physician-auth", () => ({
  getCurrentPhysician: vi.fn(async () => ({
    kind: "physician",
    physicianId: "11111111-1111-4111-8111-111111111111",
    email: "doc@example.test",
    full_name: "Dr Example",
  })),
}));
const recordMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/document-audits-db", () => ({ recordDoctorFindingResponse: recordMock }));
vi.mock("@/lib/document-audit-ingest-db", () => ({
  runDocumentAuditIngest: () => h.ingest(),
  recordIngestMeta: vi.fn(async () => undefined),
}));

import { MIGRATIONS } from "@/lib/migrations";
import { classifySync, forwardResponseNow, markResponseForSync, MAX_ATTEMPTS, retryResponseSyncs, syncRequestId } from "@/lib/response-sync";
import { POST as respondPOST } from "@/app/api/portal/document-audits/respond/route";
import { GET as cronGET } from "@/app/api/cron/document-audit-ingest/route";

const F1 = "55555555-5555-4555-8555-555555555555";
const REFERENCE = "EHRC-AUD-2026-0042";

interface Finding {
  id: string;
  ref: string | null;
  owner: string | null;
  verb: string | null;
  comment: string | null;
  responded: boolean;
  state: string | null;
  error: string | null;
  attempts: number;
  permanent: boolean;
  /** The physician's canonical CDMSS uid (physicians.cdmss_doctor_uid). */
  canonical: string | null;
}

let db: Map<string, Finding>;
const fetchMock = vi.fn();
let postedBodies: Array<{ body: Record<string, unknown>; headers: Headers }>;
let loadRowQueries: string[];

function finding(over: Partial<Finding> = {}): Finding {
  return { id: F1, ref: REFERENCE, owner: "local", verb: "disagree", comment: "Dose is correct.", responded: true, state: null, error: null, attempts: 0, permanent: false, canonical: "D-100", ...over };
}

/** An in-memory stand-in for document_audit_findings that understands the statements response-sync issues. */
function installDb() {
  h.sql = fakeSql((text, v) => {
    if (text.includes("UPDATE document_audit_findings") && text.includes("cdmss_sync_state = 'pending'")) {
      const f = db.get(String(v[0]));
      if (f && f.responded && (f.ref ?? "").trim() !== "" && f.owner !== "pipe_a") {
        Object.assign(f, { state: "pending", error: null, attempts: 0, permanent: false });
        return [{ id: f.id }];
      }
      return [];
    }
    if (text.includes("FROM document_audit_findings f") && text.includes("LEFT JOIN physicians")) {
      loadRowQueries.push(text);
      const f = db.get(String(v[0]));
      return f && f.responded
        ? [{ id: f.id, signal_reference: f.ref, doctor_response_verb: f.verb, doctor_response_comment: f.comment, cdmss_doctor_uid: f.canonical, cdmss_sync_attempts: f.attempts }]
        : [];
    }
    if (text.includes("SET cdmss_sync_state = ?,")) {
      const f = db.get(String(v[3]))!;
      f.state = String(v[0]);
      f.error = (v[1] as string | null) ?? null;
      f.permanent = v[2] === true;
      f.attempts += 1;
      return [];
    }
    if (text.includes("SELECT f.id::text AS id") && text.includes("ORDER BY f.doctor_responded_at")) {
      const limit = Number(v[1]);
      return Array.from(db.values())
        .filter(
          (f) =>
            f.responded &&
            (f.ref ?? "").trim() !== "" &&
            f.owner !== "pipe_a" &&
            !f.permanent &&
            f.attempts < Number(v[0]) &&
            (f.state === "pending" || f.state === "failed"),
        )
        .slice(0, limit)
        .map((f) => ({ id: f.id }));
    }
    return [];
  });
}

function cdmss(mode: "ok" | "down" | "500" | "409" | "400") {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    if (!String(u).includes("/doctor-response")) return json(404, {});
    postedBodies.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    if (mode === "down") throw new Error("network down");
    if (mode === "500") return json(500, { ok: false, error: "boom" });
    if (mode === "409") return json(409, { ok: false, error: "already responded — revisions go through your care manager" });
    if (mode === "400") return json(400, { ok: false, error: "disagree requires a comment" });
    return json(200, { ok: true, replayed: false, status: "escalated", signal: {} });
  });
}

beforeEach(() => {
  process.env.GOV_API_KEY = "gov-key";
  process.env.GOV_API_BASE = "https://cdmss.test";
  process.env.PORTAL_FINDINGS = "1";
  process.env.PORTAL_FINDINGS_RESPOND = "1";
  process.env.CRON_SECRET = "cron-secret";
  db = new Map([[F1, finding()]]);
  postedBodies = [];
  loadRowQueries = [];
  installDb();
  fetchMock.mockReset();
  cdmss("ok");
  recordMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("classifySync", () => {
  it("synced on 200, including a replay of the same answer", () => {
    expect(classifySync({ kind: "http", status: 200, body: { ok: true, replayed: true } })).toEqual({ state: "synced", permanent: false, error: null });
  });
  it("retryable on transport, 401, 429 and 5xx; 200 with ok:false is not a success", () => {
    for (const o of [
      { kind: "transport" as const },
      { kind: "http" as const, status: 401, body: { error: "unauthorized" } },
      { kind: "http" as const, status: 429, body: null },
      { kind: "http" as const, status: 503, body: "<html>" },
      { kind: "http" as const, status: 200, body: { ok: false } },
    ]) {
      const v = classifySync(o);
      expect(v.state).toBe("failed");
      expect(v.permanent).toBe(false);
      expect(v.error).toBeTruthy();
    }
  });
  it("permanent on 400, 403, 404 and 409 (a retry cannot change CDMSS's answer), with CDMSS's words kept", () => {
    for (const s of [400, 403, 404, 409]) {
      const v = classifySync({ kind: "http", status: s, body: { error: "already responded" } });
      expect(v).toMatchObject({ state: "failed", permanent: true });
      expect(v.error).toContain(`CDMSS ${s}`);
      expect(v.error).toContain("already responded");
    }
  });
  it("uses a stable request id per finding", () => {
    expect(syncRequestId(F1)).toBe(`elo-daf-${F1}`);
  });
});

describe("forwarding", () => {
  it("sends the doctor's answer to CDMSS doctor-response by reference, with a stable idempotency key", async () => {
    await forwardResponseNow(F1);
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0].body).toEqual({
      reference: REFERENCE,
      doctor_uid: "D-100",
      verb: "disagree",
      comment: "Dose is correct.",
      client_request_id: `elo-daf-${F1}`,
    });
    expect(postedBodies[0].headers.get("idempotency-key")).toBe(`elo-daf-${F1}`);
    expect(postedBodies[0].headers.get("x-api-key")).toBe("gov-key");
    expect(db.get(F1)).toMatchObject({ state: "synced", error: null, attempts: 1, permanent: false });
  });

  it("L2: sends the physician's canonical uid, never the audit's (possibly retired alias) uid, and omits it when unlinked", async () => {
    // The audit may carry a retired alias uid; the query no longer reads it at all.
    await forwardResponseNow(F1);
    expect(loadRowQueries.join(" ")).not.toContain("document_audits");
    expect(loadRowQueries.join(" ")).not.toContain("da.doctor_uid");
    expect(postedBodies[0].body.doctor_uid).toBe("D-100");

    postedBodies = [];
    db.set(F1, finding({ canonical: "D-CANON" }));
    await forwardResponseNow(F1);
    expect(postedBodies[0].body.doctor_uid).toBe("D-CANON");

    postedBodies = [];
    db.set(F1, finding({ canonical: null }));
    await forwardResponseNow(F1);
    expect(postedBodies[0].body).not.toHaveProperty("doctor_uid");
    expect(postedBodies[0].body.reference).toBe(REFERENCE);
  });

  it("does nothing for a finding CDMSS did not route (no signal reference) or one the live list owns", async () => {
    db.set(F1, finding({ ref: null }));
    await forwardResponseNow(F1);
    db.set(F1, finding({ ref: REFERENCE, owner: "pipe_a" }));
    await forwardResponseNow(F1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.get(F1)!.state).toBeNull();
  });

  it("CDMSS down: stored as failed with the error, never thrown", async () => {
    cdmss("down");
    await expect(forwardResponseNow(F1)).resolves.toBeUndefined();
    expect(db.get(F1)).toMatchObject({ state: "failed", attempts: 1, permanent: false });
    expect(db.get(F1)!.error).toMatch(/unreachable/);
  });

  it("is a no-op (not an error) when migration 038 is not applied yet", async () => {
    h.sql = fakeSql(() => {
      throw new Error('column "cdmss_sync_state" does not exist');
    });
    await expect(forwardResponseNow(F1)).resolves.toBeUndefined();
    expect(await markResponseForSync(F1)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the doctor's submit", () => {
  const submit = () =>
    respondPOST(
      new NextRequest("https://governance.test/api/portal/document-audits/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finding_id: F1, verb: "disagree", comment: "Dose is correct." }),
      }),
    );

  it("succeeds and forwards when CDMSS is healthy", async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.get(F1)!.state).toBe("synced");
  });

  for (const mode of ["down", "500", "409", "400"] as const) {
    it(`still succeeds when CDMSS fails (${mode}); the failure is stored for staff and the cron`, async () => {
      cdmss(mode);
      const res = await submit();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(recordMock).toHaveBeenCalledTimes(1);
      expect(db.get(F1)!.state).toBe("failed");
      expect(db.get(F1)!.permanent).toBe(mode === "409" || mode === "400");
    });
  }

  it("still succeeds when the sync bookkeeping itself throws", async () => {
    h.sql = fakeSql(() => {
      throw new Error("db unavailable");
    });
    const res = await submit();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not forward a response the portal refused", async () => {
    recordMock.mockResolvedValueOnce({ ok: false, error: "already_responded" } as never);
    const res = await submit();
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("nightly retry", () => {
  it("retries pending and failed responses", async () => {
    const A = "aaaaaaaa-0000-4000-8000-000000000001";
    const B = "aaaaaaaa-0000-4000-8000-000000000002";
    db = new Map([
      [A, finding({ id: A, state: "failed", attempts: 2, error: "CDMSS 503" })],
      [B, finding({ id: B, state: "pending" })],
    ]);
    const summary = await retryResponseSyncs();
    expect(summary).toMatchObject({ attempted: 2, synced: 2, failed: 0 });
    expect(Array.from(db.values()).every((f) => f.state === "synced")).toBe(true);
    expect(postedBodies.map((p) => p.body.client_request_id).sort()).toEqual([A, B].map(syncRequestId).sort());
  });

  it("M1: never back-forwards history: legacy and never-marked responses are left alone", async () => {
    const L = "cccccccc-0000-4000-8000-000000000001";
    const N = "cccccccc-0000-4000-8000-000000000002";
    db = new Map([
      [L, finding({ id: L, state: "legacy" })],
      [N, finding({ id: N, state: null })],
    ]);
    const summary = await retryResponseSyncs();
    expect(summary.attempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.get(L)!.state).toBe("legacy");
  });

  it("M1: the retry query only selects pending or failed rows (no NULL branch)", async () => {
    const seen: string[] = [];
    h.sql = fakeSql((text) => {
      seen.push(text);
      return [];
    });
    await retryResponseSyncs();
    const q = seen.find((t) => t.includes("ORDER BY f.doctor_responded_at"))!;
    expect(q).toContain("cdmss_sync_state IN ('pending', 'failed')");
    expect(q).not.toMatch(/cdmss_sync_state IS NULL/);
    expect(q).not.toContain("legacy");
  });

  it("M1: migration 040 marks every existing answered response legacy and allows the state", () => {
    const m = MIGRATIONS.find((x) => x.id === "040_ruling_retry_and_legacy_responses")!;
    expect(m).toBeTruthy();
    expect(m.sql).toMatch(/UPDATE document_audit_findings\s+SET cdmss_sync_state = 'legacy'\s+WHERE cdmss_sync_state IS NULL AND doctor_responded_at IS NOT NULL/);
    expect(m.sql).toMatch(/IN \('pending', 'synced', 'failed', 'legacy'\)/);
    // Idempotent: constraint dropped before it is re-added, columns added IF NOT EXISTS.
    expect(m.sql).toMatch(/DROP CONSTRAINT IF EXISTS document_audit_findings_cdmss_sync_state_check/);
    expect(m.sql).toMatch(/ADD COLUMN IF NOT EXISTS ruling_note/);
    // It runs after the migration that creates the sync columns.
    const ids = MIGRATIONS.map((x) => x.id);
    expect(ids.indexOf("040_ruling_retry_and_legacy_responses")).toBeGreaterThan(ids.indexOf("038_document_audit_response_sync"));
    expect(ids.indexOf("040_ruling_retry_and_legacy_responses")).toBeGreaterThan(ids.indexOf("037_gov_interventions_ruling_keys"));
  });

  it("M2: stops when the time budget is spent; the rest waits for the next night", async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => `dddddddd-0000-4000-8000-00000000000${n}`);
    db = new Map(ids.map((id) => [id, finding({ id, state: "pending" })]));
    let t = 1_000_000;
    // Each CDMSS call "takes" 100 s on the injected clock.
    fetchMock.mockImplementation(async () => {
      t += 100_000;
      return json(200, { ok: true });
    });
    const summary = await retryResponseSyncs({ now: () => t });
    // 240 s budget: calls start at +0 s, +100 s, +200 s; the fourth would start at +300 s, past the budget.
    expect(summary).toMatchObject({ attempted: 3, synced: 3, stopped_reason: "time_budget" });
    expect(Array.from(db.values()).filter((f) => f.state === "pending")).toHaveLength(2);
  });

  it("M2: each call is cut to what is left of the budget, never above the 15 s per-call timeout", async () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    try {
      db = new Map([[F1, finding({ state: "pending" })]]);
      await retryResponseSyncs();
      expect(timeouts.at(-1)).toBe(15_000);
      timeouts.length = 0;
      db = new Map([[F1, finding({ state: "pending" })]]);
      const now = Date.now();
      await retryResponseSyncs({ deadline: now + 4_000, now: () => now });
      expect(timeouts.at(-1)).toBe(4_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("M2: a CDMSS that hangs cannot push a run past its budget", async () => {
    const ids = Array.from({ length: 40 }, (_, n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`);
    db = new Map(ids.map((id) => [id, finding({ id, state: "pending" })]));
    let t = 0;
    fetchMock.mockImplementation(async () => {
      t += 15_000; // every call burns its full timeout
      throw new Error("timeout");
    });
    const summary = await retryResponseSyncs({ now: () => t });
    expect(summary.stopped_reason).toBe("time_budget");
    expect(summary.attempted).toBe(16); // 16 x 15 s = 240 s, not 40 x 15 s = 600 s
    expect(t).toBeLessThanOrEqual(240_000);
  });

  it("skips synced, permanent, exhausted and live-list findings", async () => {
    const mk = (n: number, over: Partial<Finding>) => finding({ id: `bbbbbbbb-0000-4000-8000-00000000000${n}`, ...over });
    const rows = [
      mk(1, { state: "synced" }),
      mk(2, { state: "failed", permanent: true }),
      mk(3, { state: "failed", attempts: MAX_ATTEMPTS }),
      mk(4, { state: "pending", owner: "pipe_a" }),
      mk(5, { state: "pending", responded: false }),
      mk(6, { state: "failed", attempts: MAX_ATTEMPTS - 1 }),
    ];
    db = new Map(rows.map((r) => [r.id, r]));
    const summary = await retryResponseSyncs();
    expect(summary.attempted).toBe(1);
    expect(postedBodies.map((p) => p.body.client_request_id)).toEqual([syncRequestId(rows[5].id)]);
  });

  it("a still-failing response stays failed, counts the attempt, and a permanent refusal stops being retried", async () => {
    db.get(F1)!.state = "pending";
    cdmss("500");
    await retryResponseSyncs();
    expect(db.get(F1)).toMatchObject({ state: "failed", attempts: 1, permanent: false });
    cdmss("409");
    await retryResponseSyncs();
    expect(db.get(F1)).toMatchObject({ state: "failed", attempts: 2, permanent: true });
    postedBodies = [];
    const again = await retryResponseSyncs();
    expect(again.attempted).toBe(0);
    expect(postedBodies).toHaveLength(0);
  });

  it("reports (does not throw) when the query itself fails", async () => {
    h.sql = fakeSql(() => {
      throw new Error("relation missing");
    });
    const s = await retryResponseSyncs();
    expect(s.attempted).toBe(0);
    expect(s.skipped_reason).toMatch(/relation missing/);
  });

  it("the query excludes permanent, exhausted and live-list rows in SQL, not only in the fake", async () => {
    const seen: string[] = [];
    h.sql = fakeSql((text) => {
      seen.push(text);
      return [];
    });
    await retryResponseSyncs();
    const q = seen.find((t) => t.includes("ORDER BY f.doctor_responded_at"))!;
    expect(q).toContain("cdmss_sync_permanent");
    expect(q).toContain("cdmss_sync_attempts");
    expect(q).toContain("<> 'pipe_a'");
    expect(q).toContain("doctor_responded_at IS NOT NULL");
  });
});

describe("the existing nightly cron runs the retry", () => {
  const cron = () =>
    cronGET(new NextRequest("https://governance.test/api/cron/document-audit-ingest", { headers: { authorization: "Bearer cron-secret" } }));

  it("after a successful ingest", async () => {
    h.ingest = async () => ({ ok: true, audits: 0 });
    db = new Map([[F1, finding({ state: "failed", attempts: 1 })]]);
    const body = await (await cron()).json();
    expect(body.ok).toBe(true);
    expect(body.response_sync).toMatchObject({ attempted: 1, synced: 1 });
    expect(body.ruling_sync).toMatchObject({ attempted: 0 });
    expect(db.get(F1)!.state).toBe("synced");
  });

  it("and after a FAILED ingest, which keeps its error status", async () => {
    h.ingest = async () => {
      throw new Error("document-audits-export 503");
    };
    db = new Map([[F1, finding({ state: "pending" })]]);
    const res = await cron();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.response_sync).toMatchObject({ attempted: 1, synced: 1 });
  });

  it("a retry crash never fails the ingest response", async () => {
    h.ingest = async () => ({ ok: true, audits: 1 });
    h.sql = fakeSql(() => {
      throw new Error("db gone");
    });
    const res = await cron();
    expect(res.status).toBe(200);
    expect((await res.json()).response_sync.skipped_reason).toMatch(/db gone/);
  });

  it("is still bearer-only", async () => {
    h.ingest = async () => ({ ok: true });
    const res = await cronGET(new NextRequest("https://governance.test/api/cron/document-audit-ingest"));
    expect(res.status).toBe(401);
  });
});
