import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeSql, json, staff } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  user: null as unknown,
  sql: null as unknown as (...a: unknown[]) => unknown,
  ingest: null as unknown as () => Promise<unknown>,
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));
vi.mock("@/lib/document-audit-ingest-db", () => ({
  runDocumentAuditIngest: () => h.ingest(),
  recordIngestMeta: vi.fn(async () => undefined),
}));

import { classifyRulingRetry, loadPendingRulings, MAX_RULING_ATTEMPTS, retryPendingRulings } from "@/lib/audit-ruling";
import { GET as cronGET } from "@/app/api/cron/document-audit-ingest/route";
import { GET as interventionsGET } from "@/app/api/opd-governance/interventions/route";

const REF_A = "EHRC-AUD-2026-0042";
const REF_B = "EHRC-AUD-2026-0043";

interface Iv {
  id: string;
  reference: string;
  action: string | null;
  actor_email: string | null;
  ruling_note: string | null;
  attempts: number;
  state: "pending" | "synced" | "refused" | null;
  error: string | null;
  created_at: string;
}

let ivs: Iv[];
let posted: Array<Record<string, unknown>>;
const fetchMock = vi.fn();

function iv(over: Partial<Iv> = {}): Iv {
  return {
    id: "iv-1",
    reference: REF_A,
    action: "closed",
    actor_email: "benita@even.in",
    ruling_note: "Resolved with the doctor.",
    attempts: 0,
    state: "pending",
    error: null,
    created_at: "2026-10-07T05:00:00.000Z",
    ...over,
  };
}

function installSql() {
  h.sql = fakeSql((text, v) => {
    if (text.includes("FROM gov_interventions") && text.includes("cdmss_sync_state = 'pending'") && text.includes("ORDER BY created_at")) {
      return ivs
        .filter((r) => r.action !== null && r.state === "pending")
        .slice(0, Number(v[0]))
        .map((r) => ({
          id: r.id,
          reference: r.reference,
          action: r.action,
          actor_email: r.actor_email,
          ruling_note: r.ruling_note,
          attempts: r.attempts,
          created_at: r.created_at,
          error: r.error,
        }));
    }
    if (text.includes("UPDATE gov_interventions") && text.includes("SET cdmss_sync_state = 'synced'")) {
      const r = ivs.find((x) => x.id === v[0])!;
      r.state = "synced";
      r.error = null;
      r.attempts += 1;
      return [];
    }
    if (text.includes("UPDATE gov_interventions") && text.includes("cdmss_sync_state = ?")) {
      const r = ivs.find((x) => x.id === v[2])!;
      r.state = v[0] as Iv["state"];
      r.error = String(v[1]);
      r.attempts += 1;
      return [];
    }
    // The OPD interventions list: apply the same filter the SQL asks for.
    if (text.includes("FROM gov_interventions i")) {
      const filtered = text.includes("cdmss_sync_state IS NULL OR i.cdmss_sync_state = 'synced'");
      return ivs.filter((r) => !filtered || r.state === null || r.state === "synced").map((r) => ({ id: r.id, signal_key: r.reference, state: r.state }));
    }
    return [];
  });
}

type Mode = "ok" | "replay" | "conflict" | "bad_request" | "not_found" | "down" | "500";
function cdmss(mode: Mode, onCall?: () => void) {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    if (!String(u).includes("/signal-action")) return json(404, {});
    posted.push(JSON.parse(String(init?.body)));
    onCall?.();
    if (mode === "down") throw new Error("network down");
    if (mode === "500") return json(500, { ok: false, error: "boom" });
    if (mode === "conflict") return json(409, { ok: false, error: "signal is closed; closed is not allowed" });
    if (mode === "bad_request") return json(400, { ok: false, error: "bad" });
    if (mode === "not_found") return json(404, { ok: false, error: "unknown reference" });
    return json(200, { ok: true, replayed: mode === "replay", status: "closed" });
  });
}

beforeEach(() => {
  process.env.GOV_API_KEY = "gov-key";
  process.env.GOV_API_BASE = "https://cdmss.test";
  process.env.CRON_SECRET = "cron-secret";
  ivs = [iv()];
  posted = [];
  h.user = staff.superAdmin;
  installSql();
  fetchMock.mockReset();
  cdmss("ok");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("classifyRulingRetry", () => {
  it("200 is synced (a replay too); 400/404/409 are refused; transport, 5xx, 401 and ok:false retry", () => {
    expect(classifyRulingRetry({ kind: "http", status: 200, body: { ok: true, replayed: true } })).toBe("synced");
    for (const s of [400, 404, 409]) expect(classifyRulingRetry({ kind: "http", status: s, body: {} })).toBe("refused");
    for (const o of [
      { kind: "transport" as const },
      { kind: "http" as const, status: 500, body: null },
      { kind: "http" as const, status: 401, body: null },
      { kind: "http" as const, status: 429, body: null },
      { kind: "http" as const, status: 200, body: { ok: false } },
    ]) {
      expect(classifyRulingRetry(o)).toBe("retry");
    }
  });
});

describe("loadPendingRulings", () => {
  it("lists only rulings (an action) still pending, oldest first; empty when the columns are missing", async () => {
    ivs = [iv({ id: "a" }), iv({ id: "b", state: "synced" }), iv({ id: "c", action: null }), iv({ id: "d", state: "refused" })];
    expect((await loadPendingRulings()).map((r) => r.id)).toEqual(["a"]);
    h.sql = fakeSql(() => {
      throw new Error('column "ruling_note" does not exist');
    });
    expect(await loadPendingRulings()).toEqual([]);
  });
});

describe("nightly retry of unconfirmed rulings (M3)", () => {
  it("re-sends the ruling with the SAME intervention id, actor and note; marks it synced on 200", async () => {
    const s = await retryPendingRulings();
    expect(s).toMatchObject({ attempted: 1, synced: 1, refused: 0, failed: 0 });
    expect(posted).toEqual([
      { reference: REF_A, action: "closed", note: "Resolved with the doctor.", actor: "gov:benita@even.in", gov_intervention_ref: "iv-1" },
    ]);
    expect(ivs[0]).toMatchObject({ state: "synced", attempts: 1, error: null });
  });

  it("a replay (CDMSS had applied it, the answer was lost) is also synced, never a second ruling", async () => {
    cdmss("replay");
    await retryPendingRulings();
    expect(ivs[0].state).toBe("synced");
    expect(posted).toHaveLength(1);
  });

  it("CDMSS still down: stays pending (so still shown as Pending sync), counts the attempt, keeps the reason", async () => {
    cdmss("down");
    const s = await retryPendingRulings();
    expect(s).toMatchObject({ attempted: 1, synced: 0, failed: 1 });
    expect(ivs[0]).toMatchObject({ state: "pending", attempts: 1, error: "transport" });
    cdmss("500");
    await retryPendingRulings();
    expect(ivs[0]).toMatchObject({ state: "pending", attempts: 2 });
    expect(ivs[0].error).toMatch(/status 500/);
  });

  it("a ruling CDMSS now refuses (the thread moved on) is marked refused, not left pending forever, and not retried again", async () => {
    cdmss("conflict");
    const s = await retryPendingRulings();
    expect(s).toMatchObject({ attempted: 1, refused: 1 });
    expect(ivs[0].state).toBe("refused");
    expect(ivs[0].error).toMatch(/409/);
    posted = [];
    expect((await retryPendingRulings()).attempted).toBe(0);
    expect(posted).toHaveLength(0);
  });

  it("gives up after the attempt cap and counts it as exhausted (it keeps showing as Pending sync)", async () => {
    ivs = [iv({ attempts: MAX_RULING_ATTEMPTS })];
    const s = await retryPendingRulings();
    expect(s).toMatchObject({ attempted: 0, exhausted: 1 });
    expect(posted).toHaveLength(0);
    expect(ivs[0].state).toBe("pending");
  });

  it("skips a row with no stored note (nothing honest to send)", async () => {
    ivs = [iv({ ruling_note: null })];
    expect((await retryPendingRulings()).exhausted).toBe(1);
    expect(posted).toHaveLength(0);
  });

  it("M2: stops when the 240 s budget is spent", async () => {
    ivs = Array.from({ length: 6 }, (_, n) => iv({ id: `iv-${n + 1}`, reference: `EHRC-AUD-2026-00${n + 40}` }));
    let t = 5_000_000;
    cdmss("ok", () => {
      t += 100_000;
    });
    const s = await retryPendingRulings({ now: () => t });
    expect(s).toMatchObject({ attempted: 3, synced: 3, stopped_reason: "time_budget" });
    expect(ivs.filter((r) => r.state === "pending")).toHaveLength(3);
  });

  it("M2: each call is cut to what is left of the budget, never above the 15 s per-call timeout", async () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    try {
      await retryPendingRulings();
      expect(timeouts.at(-1)).toBe(15_000);
      ivs = [iv()];
      const now = Date.now();
      await retryPendingRulings({ deadline: now + 3_000, now: () => now });
      expect(timeouts.at(-1)).toBe(3_000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the nightly cron retries unconfirmed rulings too (M3) within one budget (M2)", () => {
  const cron = () =>
    cronGET(new NextRequest("https://governance.test/api/cron/document-audit-ingest", { headers: { authorization: "Bearer cron-secret" } }));

  it("reports ruling_sync next to response_sync, after a successful ingest and after a failed one", async () => {
    h.ingest = async () => ({ ok: true });
    let body = await (await cron()).json();
    expect(body.ruling_sync).toMatchObject({ attempted: 1, synced: 1 });
    expect(ivs[0].state).toBe("synced");

    ivs = [iv()];
    h.ingest = async () => {
      throw new Error("document-audits-export 503");
    };
    const res = await cron();
    expect(res.status).toBe(502);
    body = await res.json();
    expect(body.ruling_sync).toMatchObject({ attempted: 1, synced: 1 });
    expect(body.response_sync).toBeDefined();
  });

  it("a crash in the ruling retry never fails the ingest", async () => {
    h.ingest = async () => ({ ok: true });
    h.sql = fakeSql(() => {
      throw new Error("db gone");
    });
    const res = await cron();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruling_sync).toBeDefined();
  });
});

describe("OPD Governance never lists an unconfirmed ruling as done (M3)", () => {
  it("the interventions list leaves out pending and refused rulings but keeps confirmed ones and ordinary interventions", async () => {
    ivs = [
      iv({ id: "ordinary", action: null, state: null, reference: "opd-signal-1" }),
      iv({ id: "confirmed", state: "synced" }),
      iv({ id: "pending", state: "pending" }),
      iv({ id: "refused", state: "refused" }),
    ];
    const res = await interventionsGET(new NextRequest("https://governance.test/api/opd-governance/interventions"));
    const body = await res.json();
    expect(body.interventions.map((r: { id: string }) => r.id).sort()).toEqual(["confirmed", "ordinary"]);
  });

  it("falls back to the plain list before migration 037 (no sync column)", async () => {
    let first = true;
    h.sql = fakeSql((text) => {
      if (first && text.includes("cdmss_sync_state")) {
        first = false;
        throw new Error('column "cdmss_sync_state" does not exist');
      }
      return [{ id: "x", signal_key: "opd-signal-1" }];
    });
    const body = await (await interventionsGET(new NextRequest("https://governance.test/api/opd-governance/interventions"))).json();
    expect(body.interventions).toHaveLength(1);
  });

  it("the OPD Governance page filters the same way and shows a Pending sync box", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/opd-governance/page.tsx"), "utf8");
    expect(src).toContain("i.cdmss_sync_state IS NULL OR i.cdmss_sync_state = 'synced'");
    expect(src).toContain("loadPendingRulings");
    expect(src).toContain("Pending sync");
    expect(src).toContain("not confirmed by CDMSS");
  });
});
