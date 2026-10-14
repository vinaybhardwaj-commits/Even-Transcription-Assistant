import { describe, expect, it } from "vitest";
import {
  actionLabel,
  actorText,
  allowedActions,
  annotatePendingRulings,
  annotateSync,
  applyFilters,
  countBuckets,
  countNotSynced,
  describeEvents,
  parseFilters,
  parseRuling,
  parseResponse,
  pendingRulingText,
  rowsFromRoster,
  sortRows,
  statusText,
  syncFlagText,
  toFindingRow,
  type DoctorLookup,
} from "@/lib/audit-findings";
import { EVENTS, signalObject } from "./helpers/fixtures";

const lookup: DoctorLookup = { byUid: new Map([["D-100", { physician_id: "p-1", full_name: "Asha Rao" }]]) };

function roster(signals: Array<Record<string, unknown>>) {
  const byDoc = new Map<string, Array<Record<string, unknown>>>();
  for (const s of signals) {
    const uid = String(s.doctor_uid);
    byDoc.set(uid, [...(byDoc.get(uid) ?? []), s]);
  }
  return {
    ok: true,
    doctors: Array.from(byDoc.entries()).map(([uid, sigs]) => ({ doctor_uid: uid, name: `CDMSS ${uid}`, signals: sigs })),
  };
}

describe("thread rows", () => {
  it("shapes a CDMSS signal into the worklist columns in plain words", () => {
    const r = toFindingRow(signalObject(), lookup)!;
    expect(r.doctor_name).toBe("Asha Rao");
    expect(r.physician_id).toBe("p-1");
    expect(r.finding_type).toBe("Drug interaction");
    expect(r.note_type).toBe("OPD note");
    expect(r.status_text).toBe("Doctor disagreed, awaiting ruling");
    expect(r.response?.verb_text).toBe("Disagreed");
    expect(r.response?.comment_short).toContain("INR");
    expect(r.awaiting_ruling).toBe(true);
    expect(r.disagreed).toBe(true);
    expect(r.needs_attention).toBe(true);
    expect(r.attention_reasons).toEqual(["Doctor disagreed", "Awaiting ruling"]);
  });

  it("falls back to the CDMSS name when the doctor is not linked, and to words for unknown codes", () => {
    const r = rowsFromRoster(roster([signalObject({ doctor_uid: "D-200", reference: "EHRC-AUD-2026-0001", label: undefined, signal_type: "dose_ceiling_sos", status: "weird" })]), lookup)[0];
    expect(r.doctor_name).toBe("CDMSS D-200");
    expect(r.physician_id).toBeNull();
    expect(r.finding_type).toBe("Dose ceiling sos");
    expect(r.status_text).toBe("Status: weird");
  });

  it("maps note classes, including the 'discharge' alias", () => {
    expect(toFindingRow(signalObject({ note_class: "discharge_summary" }))!.note_type).toBe("Discharge summary");
    expect(toFindingRow(signalObject({ note_class: "ot" }))!.note_type).toBe("OT note");
    expect(toFindingRow(signalObject({ note_class: undefined }))!.note_type).toBe("OPD note");
  });

  it("drops entries that are not threads and de-duplicates a thread listed twice", () => {
    const body = roster([signalObject(), signalObject(), { reference: null }, "junk" as unknown as Record<string, unknown>]);
    expect(rowsFromRoster(body, lookup)).toHaveLength(1);
    expect(rowsFromRoster({ ok: true }, lookup)).toEqual([]);
    expect(rowsFromRoster(null)).toEqual([]);
  });

  it("states each status in words", () => {
    const base = { response_required: "explanation", response: null, ruling: null };
    expect(statusText({ ...base, status: "routed" })).toBe("Awaiting the doctor's response");
    expect(statusText({ ...base, response_required: "none", status: "routed" })).toBe("Shared with doctor, no response needed");
    expect(statusText({ ...base, status: "responded" })).toBe("Doctor responded");
    expect(statusText({ ...base, response_required: "recommend_privilege_review", status: "escalated" })).toBe(
      "Privilege review recommended, awaiting ruling",
    );
    expect(statusText({ ...base, status: "escalated", response: parseResponse({ verb: "needs_clarification", comment: "x" }) })).toBe(
      "Doctor asked for clarification, awaiting ruling",
    );
    expect(statusText({ ...base, status: "ruled", ruling: parseRuling({ action: "acknowledged_by_governance" }) })).toBe(
      "Ruled: Acknowledged by governance",
    );
    expect(statusText({ ...base, status: "closed", ruling: parseRuling({ action: "dismissed" }) })).toBe("Dismissed");
    expect(statusText({ ...base, status: "closed" })).toBe("Closed (withdrawn by the care manager)");
  });

  it("reads the doctor's verb from the P2 verb or the legacy pair", () => {
    expect(parseResponse({ verb: "agree" }, "acknowledgment")?.verb_text).toBe("Acknowledged");
    expect(parseResponse({ verb: "agree" }, "explanation")?.verb_text).toBe("Agreed");
    expect(parseResponse({ type: "explanation", verdict: "disagree", comment: "no" })?.verb).toBe("disagree");
    expect(parseResponse({ type: "acknowledgment" })?.verb).toBe("agree");
    expect(parseResponse(null)).toBeNull();
  });
});

describe("buckets, filters, sort", () => {
  const rows = rowsFromRoster(
    roster([
      signalObject({ reference: "EHRC-AUD-2026-0001", doctor_uid: "D-1", status: "routed", response: null, overdue: true, routed_at: "2026-09-10T00:00:00Z" }),
      signalObject({ reference: "EHRC-AUD-2026-0002", doctor_uid: "D-2", status: "escalated", response: { verb: "disagree", comment: "no" }, routed_at: "2026-09-12T00:00:00Z" }),
      signalObject({ reference: "EHRC-AUD-2026-0003", doctor_uid: "D-3", status: "escalated", response_required: "recommend_privilege_review", response: null, note_class: "ot", routed_at: "2026-09-05T00:00:00Z" }),
      signalObject({ reference: "EHRC-AUD-2026-0004", doctor_uid: "D-4", status: "responded", response: { verb: "agree" }, overdue: false, routed_at: "2026-09-20T00:00:00Z" }),
      signalObject({ reference: "EHRC-AUD-2026-0005", doctor_uid: "D-5", status: "routed", response: null, routed_at: "2026-09-25T00:00:00Z" }),
      signalObject({ reference: "EHRC-AUD-2026-0006", doctor_uid: "D-6", status: "closed", response: { verb: "disagree" }, ruling: { action: "closed" }, routed_at: "2026-09-01T00:00:00Z" }),
    ]),
  );

  it("counts every bucket over the whole set", () => {
    expect(countBuckets(rows)).toEqual({ attention: 3, overdue: 1, disagreed: 1, awaiting_ruling: 2, awaiting_doctor: 2, all: 6 });
  });

  it("does not call a closed thread 'disagreed' or 'needs attention'", () => {
    const closed = rows.find((r) => r.reference.endsWith("0006"))!;
    expect(closed.disagreed).toBe(false);
    expect(closed.needs_attention).toBe(false);
  });

  it("defaults to the needs-attention view, ordered awaiting ruling, disagreed, overdue, then oldest first", () => {
    const f = parseFilters(new URLSearchParams());
    expect(f.view).toBe("attention");
    const out = sortRows(applyFilters(rows, f)).map((r) => r.reference.slice(-4));
    // 0003 (awaiting ruling, oldest) and 0002 (awaiting ruling + disagreed) both rank 0, oldest first, then overdue 0001.
    expect(out).toEqual(["0003", "0002", "0001"]);
  });

  it("filters by status, note type, doctor, importance, response ask and routed date", () => {
    const all = (q: string) => applyFilters(rows, parseFilters(new URLSearchParams(`view=all&${q}`))).map((r) => r.reference.slice(-4)).sort();
    expect(all("status=routed")).toEqual(["0001", "0005"]);
    expect(all("note_class=ot")).toEqual(["0003"]);
    expect(all("doctor_uid=D-4")).toEqual(["0004"]);
    expect(all("importance=HIGH")).toHaveLength(6);
    expect(all("response_required=recommend_privilege_review")).toEqual(["0003"]);
    expect(all("from=2026-09-10&to=2026-09-20")).toEqual(["0001", "0002", "0004"]);
  });

  it("drops filter values it does not know instead of passing them through", () => {
    const f = parseFilters(new URLSearchParams("view=bogus&status=hacked&from=yesterday&importance=a;b&doctor_uid="));
    expect(f).toEqual({ view: "attention" });
  });
});

describe("rulings and timeline", () => {
  it("offers only the rulings the status allows (mirrors CDMSS)", () => {
    expect(allowedActions("escalated")).toEqual(["acknowledged_by_governance", "privilege_action", "dismissed", "closed"]);
    expect(allowedActions("responded")).toHaveLength(4);
    expect(allowedActions("ruled")).toEqual(["privilege_action", "closed", "dismissed"]);
    expect(allowedActions("closed")).toEqual([]);
  });

  it("names actions in words", () => {
    expect(actionLabel("privilege_action")).toBe("Privilege review recorded");
    expect(actionLabel("brand_new")).toBe("Action recorded (brand_new)");
  });

  it("writes the event log as sentences with actor and time, oldest first", () => {
    const t = describeEvents([...EVENTS].reverse(), "Asha Rao");
    expect(t.map((e) => e.text)).toEqual([
      "Routed to the doctor (importance high, explanation needed)",
      "The doctor disagreed",
      "Escalated for a ruling because the doctor disagreed",
    ]);
    expect(t[0].actor).toBe("Care manager asha");
    expect(t[1].actor).toBe("Dr Asha Rao");
    expect(t[1].note).toBe("Dose adjusted and INR monitored weekly.");
    expect(t[1].at).toBe("2026-10-03T06:00:00.000Z");
  });

  it("describes rulings, closures and unknown events", () => {
    const t = describeEvents([
      { event: "ruled", actor: "gov:benita@even.in", at: "2026-10-05T00:00:00Z", payload: { action: "acknowledged_by_governance", note: "Reviewed with the doctor." } },
      { event: "closed", actor: "gov:benita@even.in", at: "2026-10-06T00:00:00Z", payload: { action: "closed", note: "Done." } },
      { event: "closed", actor: "cm:asha", at: "2026-10-07T00:00:00Z", payload: { reason: "un-routed by care manager" } },
      { event: "mystery", actor: null, at: "2026-10-08T00:00:00Z", payload: null },
    ]);
    expect(t.map((e) => e.text)).toEqual([
      "Ruled: Acknowledged by governance",
      "Closed by governance: Closed",
      "Closed (un-routed by care manager)",
      "Event: mystery",
    ]);
    expect(t[0].actor).toBe("benita@even.in");
    expect(t[0].note).toBe("Reviewed with the doctor.");
    expect(t[3].actor).toBe("System");
    expect(describeEvents("nope")).toEqual([]);
  });

  it("reads actors", () => {
    expect(actorText("doctor:D-1")).toBe("The doctor");
    expect(actorText("cm:x")).toBe("Care manager x");
    expect(actorText(undefined)).toBe("System");
  });
});

describe("sync flags", () => {
  const rows = () => rowsFromRoster(roster([signalObject(), signalObject({ reference: "EHRC-AUD-2026-0043", signal_id: "s-2" })]), lookup);

  it("annotateSync attaches a flag by reference and leaves other rows untouched", () => {
    const flagged = annotateSync(rows(), new Map([["EHRC-AUD-2026-0043", { state: "failed" as const, permanent: false, attempts: 1 }]]));
    expect(flagged.find((r) => r.reference === "EHRC-AUD-2026-0043")?.sync).toEqual({ state: "failed", permanent: false, attempts: 1 });
    expect(flagged.find((r) => r.reference !== "EHRC-AUD-2026-0043")?.sync).toBeUndefined();
  });

  it("countNotSynced counts flagged rows and the failed subset", () => {
    const flagged = annotateSync(
      rows(),
      new Map([
        ["EHRC-AUD-2026-0042", { state: "pending" as const, permanent: false, attempts: 0 }],
        ["EHRC-AUD-2026-0043", { state: "failed" as const, permanent: true, attempts: 8 }],
      ]),
    );
    expect(countNotSynced(flagged)).toEqual({ not_synced: 2, failed: 1, rulings_pending: 0 });
    expect(countNotSynced(rows())).toEqual({ not_synced: 0, failed: 0, rulings_pending: 0 });
  });

  it("syncFlagText says what happened in plain words", () => {
    expect(syncFlagText({ state: "failed", permanent: false, attempts: 1 })).toMatch(/1 attempt so far.*every night/);
    expect(syncFlagText({ state: "failed", permanent: false, attempts: 3 })).toMatch(/3 attempts/);
    expect(syncFlagText({ state: "failed", permanent: true, attempts: 1 })).toMatch(/refused/);
    expect(syncFlagText({ state: "pending", permanent: false, attempts: 0 })).toMatch(/waiting/);
  });
});

describe("pending rulings", () => {
  const rows = () => rowsFromRoster(roster([signalObject(), signalObject({ reference: "EHRC-AUD-2026-0043", signal_id: "s-2" })]), lookup);

  it("annotatePendingRulings attaches by reference and counts them, without touching the thread's status", () => {
    const before = rows();
    const flagged = annotatePendingRulings(before, new Map([["EHRC-AUD-2026-0043", { action: "closed", attempts: 1, since: null }]]));
    const one = flagged.find((r) => r.reference === "EHRC-AUD-2026-0043")!;
    expect(one.pending_ruling).toEqual({ action: "closed", attempts: 1, since: null });
    expect(one.status).toBe(before.find((r) => r.reference === "EHRC-AUD-2026-0043")!.status);
    expect(flagged.find((r) => r.reference !== "EHRC-AUD-2026-0043")!.pending_ruling).toBeUndefined();
    expect(countNotSynced(flagged).rulings_pending).toBe(1);
  });

  it("pendingRulingText says the ruling is saved but not confirmed", () => {
    expect(pendingRulingText({ action: "closed", attempts: 0, since: null })).toMatch(/not confirmed it yet/);
    expect(pendingRulingText({ action: "weird", attempts: 0, since: null })).toMatch(/A ruling is saved here/);
  });
});
