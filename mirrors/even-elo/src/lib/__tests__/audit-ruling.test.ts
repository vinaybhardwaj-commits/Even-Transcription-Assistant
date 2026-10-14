import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EVENTS, HOSPITAL_A, REF, fakeSql, json, liveFromClaims, signalObject, staff } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  user: null as unknown,
  /** The role the database reports; "claims" = same as the cookie. */
  live: "claims" as unknown,
  sql: null as unknown as (...a: unknown[]) => unknown,
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));
vi.mock("@/lib/staff-live", async (orig) => {
  const real = await orig<typeof import("@/lib/staff-live")>();
  const { liveFromClaims: fromClaims } = await import("./helpers/fixtures");
  return { ...real, loadLiveStaff: vi.fn(async () => (h.live === "claims" ? fromClaims(h.user) : h.live)) };
});

import { POST } from "@/app/api/audit-findings/[reference]/ruling/route";
import { appliedRulingIndex, parseRulingBody, rulingKey, threadVersion } from "@/lib/audit-ruling";

interface Row {
  id: string;
  reference: string;
  key: string;
  action: string;
  note: string;
  ruling_note: string;
  actor: string;
  version: string;
  state: string;
  error: string | null;
}

let rows: Map<string, Row>;
let audits: Array<{ action: string; entity: string }>;
let inserts: number;
let pendingLookups: number;
let cdmssStatus: string; // the thread's CURRENT status as CDMSS holds it
let events: Array<Record<string, unknown>>; // the thread's CURRENT event log as CDMSS holds it
let linkedDoctor: boolean; // is the CDMSS doctor linked to a physician profile
let engagedAtA: boolean; // is that physician engaged at HOSPITAL_A
let signalActionCalls: Array<Record<string, unknown>>;
let signalActionMode: "ok" | "replay" | "conflict" | "down" | "bad_request" | "applied_then_timeout";
const fetchMock = vi.fn();

function installSql() {
  h.sql = fakeSql((text, v) => {
    if (text.includes("FROM physicians WHERE cdmss_doctor_uid IS NOT NULL")) {
      return linkedDoctor ? [{ id: "p-1", full_name: "Asha Rao", cdmss_doctor_uid: "D-100", cdmss_alias_uids: null }] : [];
    }
    if (text.includes("FROM physician_engagements")) {
      const hospitals = v[1] as string[];
      return engagedAtA && hospitals.includes(HOSPITAL_A) ? [{ id: "p-1" }] : [];
    }
    if (text.includes("INSERT INTO gov_interventions")) {
      inserts += 1;
      const key = String(v[6]);
      const existing = rows.get(key);
      if (existing) {
        if (!text.includes("DO UPDATE") || existing.state === "synced") return [];
        existing.note = String(v[2]);
        existing.actor = String(v[4]);
        existing.ruling_note = String(v[7]);
        existing.state = "pending";
        existing.error = null;
        return [{ id: existing.id, cdmss_sync_state: existing.state, actor_email: existing.actor, ruling_note: existing.ruling_note }];
      }
      const row: Row = {
        id: `iv-${rows.size + 1}`,
        reference: String(v[0]),
        key,
        action: String(v[5]),
        note: String(v[2]),
        ruling_note: String(v[7]),
        actor: String(v[4]),
        version: String(v[8]),
        state: "pending",
        error: null,
      };
      rows.set(key, row);
      return [{ id: row.id, cdmss_sync_state: row.state, actor_email: row.actor, ruling_note: row.ruling_note }];
    }
    if (text.includes("FROM gov_interventions") && text.includes("WHERE signal_key =") && text.includes("cdmss_sync_state = 'pending'")) {
      pendingLookups += 1;
      const hit = Array.from(rows.values())
        .filter((r) => r.reference === v[0] && r.action === v[1] && r.state === "pending")
        .pop();
      return hit ? [{ id: hit.id, idempotency_key: hit.key }] : [];
    }
    if (text.includes("FROM gov_interventions WHERE idempotency_key")) {
      const r = rows.get(String(v[0]));
      return r ? [{ id: r.id, cdmss_sync_state: r.state, actor_email: r.actor, ruling_note: r.ruling_note }] : [];
    }
    if (text.includes("SET cdmss_sync_state = 'synced'")) {
      for (const r of Array.from(rows.values())) if (r.id === v[0]) r.state = "synced";
      return [];
    }
    if (text.includes("SET cdmss_sync_error")) {
      for (const r of Array.from(rows.values())) if (r.id === v[1]) r.error = String(v[0]);
      return [];
    }
    if (text.includes("DELETE FROM gov_interventions")) {
      for (const [k, r] of Array.from(rows.entries())) if (r.id === v[0] && r.state !== "synced") rows.delete(k);
      return [];
    }
    if (text.includes("INSERT INTO audit_log_v2")) {
      audits.push({ action: String(v[1]), entity: String(v[2]) });
      return [];
    }
    return [];
  });
}

beforeEach(() => {
  process.env.GOV_API_KEY = "gov-key";
  process.env.GOV_API_BASE = "https://cdmss.test";
  rows = new Map();
  audits = [];
  inserts = 0;
  pendingLookups = 0;
  cdmssStatus = "escalated";
  events = EVENTS.map((e) => ({ ...e }));
  linkedDoctor = true;
  engagedAtA = true;
  signalActionCalls = [];
  signalActionMode = "ok";
  h.user = staff.smh;
  h.live = "claims";
  installSql();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const s = String(u);
    if (s.includes("/audit-signal/")) {
      return json(200, { ok: true, signal: signalObject({ status: cdmssStatus }), instances: [], events });
    }
    if (s.includes("/signal-action")) {
      const body = JSON.parse(String(init?.body));
      signalActionCalls.push(body);
      if (signalActionMode === "down") throw new Error("network down");
      // CDMSS's own replay guard: an earlier (action, gov_intervention_ref) pair on the thread is a 200 no-op.
      const already = events.some((e) => {
        const pl = e.payload as { action?: string; gov_intervention_ref?: string } | null;
        return (e.event === "ruled" || e.event === "closed") && pl?.action === body.action && pl?.gov_intervention_ref === body.gov_intervention_ref;
      });
      if (already) return json(200, { ok: true, replayed: true, status: cdmssStatus, signal: signalObject({ status: cdmssStatus }) });
      if (signalActionMode === "applied_then_timeout") {
        // CDMSS commits the ruling (new event, new status) and then the reply is lost.
        cdmssStatus = body.action === "closed" ? "closed" : "ruled";
        events = [
          ...events,
          { event: body.action === "closed" ? "closed" : "ruled", actor: body.actor, at: "2026-10-08T05:00:00.000Z", payload: { action: body.action, note: body.note, actor: body.actor, gov_intervention_ref: body.gov_intervention_ref } },
        ];
        throw new Error("timeout");
      }
      if (signalActionMode === "conflict") return json(409, { ok: false, error: "signal is closed; closed is not allowed" });
      if (signalActionMode === "bad_request") return json(400, { ok: false, error: "action must be one of x" });
      return json(200, {
        ok: true,
        replayed: signalActionMode === "replay",
        status: "closed",
        signal: signalObject({ status: "closed", ruling: { action: body.action, note: body.note, actor: body.actor, gov_intervention_ref: body.gov_intervention_ref } }),
      });
    }
    return json(404, { ok: false });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const rule = (body: unknown) =>
  POST(
    new NextRequest(`https://governance.test/api/audit-findings/${REF}/ruling`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { reference: REF } },
  );

/** CDMSS re-routes a settled thread: status back to routed, one more event in the log. */
function reopen() {
  cdmssStatus = "routed";
  events = [...events, { event: "routed", actor: "cm:asha", at: "2026-10-05T05:00:00.000Z", payload: { reason: "re-routed" } }];
}

describe("ruling body", () => {
  it("requires a real action and a note, and refuses unknown fields", () => {
    expect(parseRulingBody({ action: "closed", note: "ok" }).ok).toBe(false); // 2 characters
    expect(parseRulingBody({ action: "closed", note: "   " }).ok).toBe(false);
    expect(parseRulingBody({ action: "nuke", note: "long enough" }).ok).toBe(false);
    expect(parseRulingBody({ action: "closed", note: "long enough", actor: "someone-else" }).ok).toBe(false);
    expect(parseRulingBody(null).ok).toBe(false);
    expect(parseRulingBody({ action: "dismissed", note: "  Not our patient.  " })).toEqual({ ok: true, action: "dismissed", note: "Not our patient." });
  });
});

describe("idempotency key: thread + action + thread version (H1)", () => {
  it("changes with the action and with the thread's version", () => {
    expect(rulingKey(REF, "closed", "3.100")).toBe(`${REF}|closed|3.100`);
    expect(rulingKey(REF, "closed", "3.100")).not.toBe(rulingKey(REF, "dismissed", "3.100"));
    expect(rulingKey(REF, "closed", "3.100")).not.toBe(rulingKey(REF, "closed", "4.200"));
  });

  it("threadVersion moves when an event is appended, ignores event order, and falls back to routed_at", () => {
    const v3 = threadVersion(EVENTS);
    expect(v3).toMatch(/^3\.\d+$/);
    expect(threadVersion([...EVENTS].reverse())).toBe(v3);
    const v4 = threadVersion([...EVENTS, { event: "routed", at: "2026-10-05T05:00:00.000Z" }]);
    expect(v4).not.toBe(v3);
    expect(v4).toMatch(/^4\./);
    expect(threadVersion(undefined, { routed_at: "2026-10-01T05:00:00.000Z" })).toBe(`0.${Date.parse("2026-10-01T05:00:00.000Z")}`);
    expect(threadVersion([], null)).toBe("0.0");
  });
});

describe("ruling flow", () => {
  it("records one gov_interventions row first, then sends its id to signal-action with the actor and note", async () => {
    const res = await rule({ action: "acknowledged_by_governance", note: "Reviewed with the doctor." });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, replayed: false });
    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.state).toBe("synced");
    expect(row.note).toContain("Reviewed with the doctor.");
    expect(row.ruling_note).toBe("Reviewed with the doctor.");
    expect(row.version).toBe(threadVersion(EVENTS));
    expect(signalActionCalls).toHaveLength(1);
    expect(signalActionCalls[0]).toMatchObject({
      reference: REF,
      action: "acknowledged_by_governance",
      note: "Reviewed with the doctor.",
      actor: "gov:benita@even.in",
      gov_intervention_ref: row.id,
    });
    // The row was written BEFORE the CDMSS call.
    const sqlOrder = (h.sql as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder;
    const signalActionOrder = fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.findIndex((c) => String(c[0]).includes("/signal-action"))];
    expect(Math.min(...sqlOrder.slice(0, 4))).toBeLessThan(signalActionOrder);
    expect(audits.map((a) => a.action)).toEqual(["audit_ruling"]);
  });

  it("a repeat press on the same thread state reuses the same row and the same reference; CDMSS answers 200 replayed", async () => {
    const first = await rule({ action: "closed", note: "Resolved with the doctor." });
    expect(first.status).toBe(200);
    signalActionMode = "replay";
    const second = await rule({ action: "closed", note: "Resolved with the doctor." });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, replayed: true });
    expect(rows.size).toBe(1);
    expect(signalActionCalls).toHaveLength(2);
    expect(signalActionCalls[1].gov_intervention_ref).toBe(signalActionCalls[0].gov_intervention_ref);
    expect(audits.map((a) => a.action)).toEqual(["audit_ruling"]); // the replay is not audited as a second ruling
  });

  it("once CDMSS has confirmed a ruling, a later press with another note changes neither the row nor what is sent", async () => {
    await rule({ action: "closed", note: "First reason." });
    signalActionMode = "replay";
    await rule({ action: "closed", note: "Second reason, typed later." });
    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.note).toContain("First reason.");
    expect(row.state).toBe("synced");
    expect(signalActionCalls[1].note).toBe("First reason.");
  });

  it("two different actions on one thread are two decisions", async () => {
    await rule({ action: "acknowledged_by_governance", note: "Seen." });
    await rule({ action: "closed", note: "Finished." });
    expect(rows.size).toBe(2);
  });

  it("H1: a thread that CDMSS reopened can be ruled with the same action again (new row, fresh non-replayed call)", async () => {
    const first = await rule({ action: "closed", note: "Resolved." });
    expect((await first.json()).replayed).toBe(false);
    expect(rows.size).toBe(1);

    reopen(); // a care manager re-routes the settled thread: status routed, one more event

    const second = await rule({ action: "closed", note: "Resolved again after the re-route." });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, replayed: false });
    expect(rows.size).toBe(2);
    const [a, b] = Array.from(rows.values());
    expect(a.key).not.toBe(b.key);
    expect(a.version).not.toBe(b.version);
    expect(signalActionCalls).toHaveLength(2);
    expect(signalActionCalls[1].gov_intervention_ref).not.toBe(signalActionCalls[0].gov_intervention_ref);
    expect(signalActionCalls[1].note).toBe("Resolved again after the re-route.");
    expect(audits.map((x) => x.action)).toEqual(["audit_ruling", "audit_ruling"]);
  });

  it("H1: the row and the CDMSS call carry the same actor and note even when a second person retries a pending ruling", async () => {
    signalActionMode = "down";
    const failed = await rule({ action: "privilege_action", note: "A's note: refer for review." });
    expect(failed.status).toBe(502);
    expect(Array.from(rows.values())[0].actor).toBe("benita@even.in");

    h.user = staff.superAdmin; // B rules the same action on the same thread state
    signalActionMode = "ok";
    const retried = await rule({ action: "privilege_action", note: "B's note: privileges suspended." });
    expect(retried.status).toBe(200);
    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.actor).toBe("vinay@even.in");
    expect(row.ruling_note).toBe("B's note: privileges suspended.");
    expect(row.note).toContain("B's note");
    // CDMSS got B's attribution, not A's, and the same intervention id as the first attempt.
    expect(signalActionCalls[1]).toMatchObject({ actor: "gov:vinay@even.in", note: "B's note: privileges suspended.", gov_intervention_ref: row.id });
    expect(signalActionCalls[1].gov_intervention_ref).toBe(signalActionCalls[0].gov_intervention_ref);
    expect(row.state).toBe("synced");
  });

  it("when CDMSS is unreachable the decision stays saved as pending, answers 502, and the retry is the SAME row", async () => {
    signalActionMode = "down";
    const failed = await rule({ action: "privilege_action", note: "Refer for review." });
    expect(failed.status).toBe(502);
    const fb = await failed.json();
    expect(fb.error).toBe("unavailable");
    expect(fb.message).toMatch(/will not be recorded twice/);
    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.state).toBe("pending");
    expect(row.error).toBe("transport");

    signalActionMode = "ok";
    const retried = await rule({ action: "privilege_action", note: "Refer for review." });
    expect(retried.status).toBe(200);
    expect(rows.size).toBe(1);
    expect(inserts).toBe(2);
    expect(signalActionCalls[1].gov_intervention_ref).toBe(signalActionCalls[0].gov_intervention_ref);
    expect(Array.from(rows.values())[0].state).toBe("synced");
  });

  it("409 from CDMSS: answers 409 with the CURRENT status, offers only what is still allowed, and removes the attempt's row", async () => {
    signalActionMode = "conflict";
    cdmssStatus = "closed"; // someone closed it first
    const res = await rule({ action: "acknowledged_by_governance", note: "Seen." });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "conflict", current_status: "closed", actions: [] });
    expect(body.message).toMatch(/changed since you opened it/);
    expect(rows.size).toBe(0);
    expect(audits.map((a) => a.action)).toEqual(["audit_ruling_refused"]);
  });

  it("409 on a thread that moved to 'ruled' still offers the actions allowed there", async () => {
    signalActionMode = "conflict";
    cdmssStatus = "ruled";
    const body = await (await rule({ action: "acknowledged_by_governance", note: "Seen." })).json();
    expect(body.current_status).toBe("ruled");
    expect(body.actions.map((a: { action: string }) => a.action)).toEqual(["privilege_action", "closed", "dismissed"]);
  });

  it("a 409 never deletes a row CDMSS already confirmed", async () => {
    await rule({ action: "closed", note: "Resolved." });
    expect(Array.from(rows.values())[0].state).toBe("synced");
    signalActionMode = "conflict";
    await rule({ action: "closed", note: "Resolved." });
    expect(rows.size).toBe(1);
  });

  it("passes a CDMSS 400 back as a 400 with its words, and leaves no row", async () => {
    signalActionMode = "bad_request";
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/action must be one of/);
    expect(rows.size).toBe(0);
  });

  it("refuses a missing note, an unknown action and an extra field before touching anything", async () => {
    for (const bad of [{ action: "closed" }, { action: "closed", note: " " }, { action: "erase", note: "long enough" }, { action: "closed", note: "long enough", actor: "x" }]) {
      const res = await rule(bad);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toBe(0);
  });

  it("404s a thread CDMSS does not know, with nothing recorded", async () => {
    fetchMock.mockImplementation(async () => json(404, { ok: false, error: "unknown reference" }));
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(404);
    expect(inserts).toBe(0);
  });

  it("does not send anything to CDMSS when the decision cannot be recorded", async () => {
    h.sql = fakeSql((text) => {
      if (text.includes("FROM physicians")) return [];
      if (text.includes("INSERT INTO gov_interventions")) throw new Error("db down");
      return [{ id: "p-1" }];
    });
    h.user = staff.superAdmin;
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(502);
    expect(signalActionCalls).toHaveLength(0);
  });
});

describe("who may rule on which doctor (L4)", () => {
  it("a Site Medical Head cannot rule on a doctor engaged only at another hospital: 403, nothing recorded, CDMSS never called for the ruling", async () => {
    engagedAtA = false;
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("out_of_scope");
    expect(body.message).toMatch(/not engaged at a hospital you head/);
    expect(inserts).toBe(0);
    expect(rows.size).toBe(0);
    expect(signalActionCalls).toHaveLength(0);
  });

  it("a Site Medical Head cannot rule on a doctor not yet linked to a physician profile", async () => {
    linkedDoctor = false;
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/only a super admin/);
    expect(inserts).toBe(0);
    expect(signalActionCalls).toHaveLength(0);
  });

  it("a Site Medical Head can rule on a doctor engaged at their own hospital", async () => {
    expect((await rule({ action: "closed", note: "Resolved." })).status).toBe(200);
    expect(rows.size).toBe(1);
  });

  it("a Site Medical Head of another hospital cannot, even for a doctor engaged at hospital A", async () => {
    h.live = { ...liveFromClaims(staff.smh)!, smh_hospital_ids: ["bbbb0000-0000-4000-8000-00000000000b"] };
    expect((await rule({ action: "closed", note: "Resolved." })).status).toBe(403);
    expect(inserts).toBe(0);
  });

  it("a super admin can rule for any doctor, linked or not, at any hospital", async () => {
    h.user = staff.superAdmin;
    engagedAtA = false;
    linkedDoctor = false;
    expect((await rule({ action: "closed", note: "Resolved." })).status).toBe(200);
    expect(rows.size).toBe(1);
  });
});

describe("the role is the database's, not the 7-day cookie's (L3)", () => {
  it("a Site Medical Head whose role was revoked after login is refused (403), nothing recorded", async () => {
    h.live = { ...liveFromClaims(staff.smh)!, is_site_medical_head: false, smh_hospital_ids: [] };
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(403);
    expect(inserts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a super admin whose flag was revoked is refused", async () => {
    h.user = staff.superAdmin;
    h.live = { ...liveFromClaims(staff.superAdmin)!, is_super_admin: false };
    expect((await rule({ action: "closed", note: "Resolved." })).status).toBe(403);
    expect(inserts).toBe(0);
  });

  it("a deactivated account, a vanished profile and an unreadable database are refused (401)", async () => {
    h.live = { ...liveFromClaims(staff.smh)!, status: "deactivated" };
    expect((await rule({ action: "closed", note: "Resolved." })).status).toBe(401);
    h.live = null;
    expect((await rule({ action: "closed", note: "Resolved." })).status).toBe(401);
    expect(inserts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("N1: CDMSS applied the ruling but the reply timed out; pressing again must not rule twice", () => {
  for (const [action, settled] of [
    ["privilege_action", "ruled"],
    ["closed", "closed"],
  ] as const) {
    it(`${action}: the second press reuses the pending row, confirms it from CDMSS's event log, and sends nothing`, async () => {
      signalActionMode = "applied_then_timeout";
      const first = await rule({ action, note: "Decision taken." });
      expect(first.status).toBe(502);
      expect(rows.size).toBe(1);
      const r1 = Array.from(rows.values())[0];
      expect(r1.state).toBe("pending");
      expect(cdmssStatus).toBe(settled); // CDMSS really did apply it
      expect(signalActionCalls).toHaveLength(1);

      const second = await rule({ action, note: "Decision taken." });
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body).toMatchObject({ ok: true, replayed: true, intervention_id: r1.id });
      expect(body.thread.status).toBe(settled);
      // One row, now confirmed; no second row, no second CDMSS ruling, no second ruling event.
      expect(rows.size).toBe(1);
      expect(r1.state).toBe("synced");
      expect(inserts).toBe(1);
      expect(signalActionCalls).toHaveLength(1);
      expect(events.filter((e) => e.event === "ruled" || e.event === "closed")).toHaveLength(1);
      expect(audits.filter((a) => a.action === "audit_ruling")).toHaveLength(1); // audited once, on recovery
    });
  }

  it("not applied (the call never reached CDMSS) and the thread version has since changed: the same row and key are re-sent, not a new row", async () => {
    signalActionMode = "down";
    await rule({ action: "privilege_action", note: "Refer for review." });
    const r1 = Array.from(rows.values())[0];
    // Unrelated activity on the thread moves its version (a new event) between the two presses.
    events = [...events, { event: "comment", actor: "cm:asha", at: "2026-10-06T05:00:00.000Z", payload: {} }];
    signalActionMode = "ok";
    const retried = await rule({ action: "privilege_action", note: "Refer for review." });
    expect(retried.status).toBe(200);
    expect(rows.size).toBe(1);
    expect(signalActionCalls).toHaveLength(2);
    expect(signalActionCalls[1].gov_intervention_ref).toBe(r1.id);
    expect(r1.state).toBe("synced");
  });

  it("applied, then the thread was reopened before the second press: the old row is confirmed and this press is a NEW ruling", async () => {
    signalActionMode = "applied_then_timeout";
    await rule({ action: "closed", note: "Resolved." });
    const r1 = Array.from(rows.values())[0];
    reopen(); // a care manager re-routes it after the (unconfirmed) close
    signalActionMode = "ok";
    const res = await rule({ action: "closed", note: "Close it again." });
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(false);
    expect(r1.state).toBe("synced");
    expect(rows.size).toBe(2);
    expect(signalActionCalls).toHaveLength(2);
    expect(signalActionCalls[1].gov_intervention_ref).not.toBe(r1.id);
  });

  it("a pending ruling for a DIFFERENT action does not block or get reused", async () => {
    signalActionMode = "down";
    await rule({ action: "acknowledged_by_governance", note: "Seen." });
    signalActionMode = "ok";
    await rule({ action: "closed", note: "Finished." });
    expect(rows.size).toBe(2);
    expect(Array.from(rows.values()).map((r) => r.state).sort()).toEqual(["pending", "synced"]);
  });

  it("appliedRulingIndex finds the ruling by action and intervention id only", () => {
    const ev = [{ event: "routed" }, { event: "ruled", payload: { action: "privilege_action", gov_intervention_ref: "iv-9" } }];
    expect(appliedRulingIndex(ev, "privilege_action", "iv-9")).toBe(1);
    expect(appliedRulingIndex(ev, "closed", "iv-9")).toBe(-1);
    expect(appliedRulingIndex(ev, "privilege_action", "iv-1")).toBe(-1);
    expect(appliedRulingIndex(undefined, "closed", "iv-9")).toBe(-1);
  });
});
