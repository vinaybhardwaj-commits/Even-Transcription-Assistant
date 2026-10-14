import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const hostileSignal = {
    // everything below is something a physician must never receive
    reference: "EHRC-AUD-2026-0042",
    doctor_uid: "cdmss-uid-secret",
    overdue: true,
    sla_due_at: "2026-10-09T00:00:00Z",
    ruling: { by: "council", outcome: "upheld" },
    triage: { rationale: "Triage engine says route to RMO", policy_version: "triage-v9" },
    confidence: 0.93,
    jev: { verdict: "fail" },
    model: "gemini-x",
    importance: "high",
    bug_type: "false_positive",
    cm_notes: "care manager thinks this is weak",
    // and the parts that are meant to ship
    signal_id: "sig-777",
    signal_type: "drug_interaction",
    label: "ddi_pair_flag",
    response_required: "acknowledgment",
    status: "routed",
    instances: 2,
    routed_at: "2026-10-01T00:00:00Z",
    response: null,
    note_class: "opd",
    representative: {
      audit_id: "22222222-2222-4222-8222-222222222222",
      finding_ref: "f-9",
      verdict: "fail",
      subject: "Warfarin with ibuprofen",
      rationale:
        "Together these raise bleeding risk. CDMSS flagged this for RMO review (EHRC-AUD-2026-0042).",
      note_date: "2026-09-30",
      routed: true,
      evidence_excerpt: "Tab Warfarin 5mg OD; Tab Ibuprofen 400mg TID x5d. Ref ot:abc12345def.",
      citations: [
        { n: 1, title: "Warfarin label", url: "https://example.test/warfarin" },
        { title: "Local guidance", url: null },
        { title: "Bad link", url: "javascript:alert(1)" },
      ],
      patient: { name: "Ramesh Kumar", age: 54, sex: "male", ip_number: "IP-4821", uhid: "EH00123", dob: "1972-01-01", phone: "9999999999" },
      internal_flag: "x",
    },
  };
  return { hostileSignal };
});

vi.mock("@/lib/physician-auth", () => ({
  getCurrentPhysician: vi.fn(async () => ({
    kind: "physician",
    physicianId: "11111111-1111-4111-8111-111111111111",
    email: "doc@example.test",
    full_name: "Dr Example",
  })),
}));
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async () => [{ cdmss_doctor_uid: "uid-1" }]),
}));
vi.mock("@/lib/doctor-audits", async () => {
  const actual = await vi.importActual<typeof import("@/lib/doctor-audits")>("@/lib/doctor-audits");
  return {
    ...actual,
    fetchDoctorAudits: vi.fn(async () => ({
      ok: true,
      doctor: { uid: "cdmss-uid-secret", name: "Dr A" },
      metrics: { audit: { score: 12 } },
      advisory: "validated by a care manager",
      signals: [h.hostileSignal],
    })),
    fetchDoctorReactions: vi.fn(async () => ({})),
  };
});
vi.mock("@/lib/findings-actions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/findings-actions")>("@/lib/findings-actions");
  return {
    ...actual,
    callReaction: vi.fn(async () => ({ kind: "http", status: 409, body: { error: "already recorded" } })),
    callResponse: vi.fn(async () => ({
      kind: "http",
      status: 200,
      body: { ok: true, signal: { ...h.hostileSignal, status: "responded", response: { verb: "agree", at: "2026-10-03T08:00:00Z" } } },
    })),
  };
});
vi.mock("@/lib/document-audits-db", () => ({
  loadPortalRoutedFindings: vi.fn(async () => []),
  recordDoctorFindingResponse: vi.fn(async () => ({ ok: true })),
}));

import { GET as findingsGET } from "@/app/api/portal/findings/route";
import { POST as respondPOST } from "@/app/api/portal/findings/respond/route";
import { POST as reactPOST } from "@/app/api/portal/findings/react/route";
import { GET as docsGET } from "@/app/api/portal/document-audits/route";
import { POST as docsRespondPOST } from "@/app/api/portal/document-audits/respond/route";
import { callReaction, callResponse } from "@/lib/findings-actions";
import { loadPortalRoutedFindings, recordDoctorFindingResponse } from "@/lib/document-audits-db";
import {
  CARD_KEYS,
  contextLine,
  sanitizeCard,
  scrubText,
  stripIds,
  toDocumentCard,
  toDocumentCards,
  toLiveCard,
  toLiveCardsPayload,
  toResponseState,
  type DocumentFindingRow,
} from "@/lib/doctor-card";
import {
  askOf,
  cardNoteClass,
  findingTitle,
  friendlyError,
  fmtLongDate,
  fmtShortDate,
  responseInWords,
  ADVISORY_FOOTER,
  UNLINKED_TEXT,
} from "@/lib/finding-labels";

const AUDIT = "22222222-2222-4222-8222-222222222222";

function live(over: Record<string, unknown> = {}) {
  return { ...h.hostileSignal, ...over };
}

const BANNED_WORDS = [
  "EHRC-AUD",
  "cdmss-uid-secret",
  "triage",
  "Triage",
  "policy",
  "council",
  "upheld",
  "confidence",
  "gemini",
  "care manager",
  "RMO",
  "CDMSS",
  "overdue",
  "sla_due_at",
  "bug_type",
  "ot:abc12345def",
  "dob",
  "9999999999",
  "internal_flag",
  "ddi_pair_flag",
  "javascript:",
  "routed_at",
];

describe("the card allowlist: hostile upstream in, exact keys out", () => {
  it("a live signal full of internals produces a card with exactly the allowlisted keys", () => {
    const card = toLiveCard(live())!;
    expect(Object.keys(card).sort()).toEqual([...CARD_KEYS].sort());
    expect(Object.keys(card.patient!).sort()).toEqual(["age", "ip_number", "name", "sex", "uhid"]);
  });

  it("none of the banned internals appear anywhere in the serialised card", () => {
    const text = JSON.stringify(toLiveCardsPayload({ signals: [live()] }));
    for (const banned of BANNED_WORDS) expect(text).not.toContain(banned);
  });

  it("keeps the clinical content, patient context and a plain title", () => {
    const card = toLiveCard(live())!;
    expect(card.title).toBe("Possible drug interaction");
    expect(card.subject).toBe("Warfarin with ibuprofen");
    expect(card.note_type).toBe("OPD note");
    expect(card.note_date).toBe("2026-09-30");
    expect(card.patient).toEqual({
      name: "Ramesh Kumar",
      age: "54",
      sex: "M",
      ip_number: "IP-4821",
      uhid: "EH00123",
    });
    expect(card.ask).toBe("acknowledge");
    expect(card.can_respond).toBe(true);
    // OPD audits have no file upstream, so an OPD card offers no "View note".
    expect(card.view_note_href).toBeNull();
    expect(card.seen_in).toBe("Seen in 2 notes");
  });

  it("View note is offered for discharge and OT cards only, never for OPD", () => {
    const href = `/api/portal/findings/pdf?ref=${AUDIT}`;
    expect(toLiveCard(live({ note_class: "opd" }))!.view_note_href).toBeNull();
    expect(toLiveCard(live({ note_class: undefined }))!.view_note_href).toBeNull();
    expect(toLiveCard(live({ note_class: "discharge" }))!.view_note_href).toBe(href);
    expect(toLiveCard(live({ note_class: "discharge_summary" }))!.view_note_href).toBe(href);
    expect(toLiveCard(live({ note_class: "ot" }))!.view_note_href).toBe(href);
    expect(toDocumentCard(docRow({ note_class: "opd", doc_type: "opd" }))!.view_note_href).toBeNull();
  });

  it("a document finding gets a note link only when CDMSS marked it routed", () => {
    expect(toDocumentCard(docRow({ cdmss_routed: true }))!.view_note_href).toBe(`/api/portal/findings/pdf?ref=${AUDIT}`);
    expect(toDocumentCard(docRow({ cdmss_routed: false }))!.view_note_href).toBeNull();
    expect(toDocumentCard(docRow({ cdmss_routed: null }))!.view_note_href).toBeNull();
    expect(toDocumentCard(docRow({ cdmss_routed: undefined }))!.view_note_href).toBeNull();
  });

  it("scrubs a reference from any hospital prefix", () => {
    expect(scrubText("Fix the dose. See EBBR-AUD-2026-0042.")).toBe("Fix the dose.");
    expect(scrubText("Ref AB-AUD-2025-7 applies to this note.")).toBe("applies to this note.");
    expect(stripIds("x XYZ-AUD-2026-12 y")).toBe("x y");
    const card = toLiveCard(live({ representative: { ...h.hostileSignal.representative, subject: "Dose issue ABCD-AUD-2026-9 here" } }))!;
    expect(JSON.stringify(card)).not.toMatch(/AUD-\d/);
  });

  it("recurrence is plain words above one and absent otherwise, never a number field", () => {
    expect(toLiveCard(live({ instances: 4 }))!.seen_in).toBe("Seen in 4 notes");
    expect(toLiveCard(live({ instances: 1 }))!.seen_in).toBeNull();
    expect(toLiveCard(live({ instances: 0 }))!.seen_in).toBeNull();
    expect(toLiveCard(live({ instances: [1, 2, 3] }))!.seen_in).toBeNull();
    const text = JSON.stringify(toLiveCard(live({ instances: 4 })));
    expect(text).not.toContain('"instances"');
    expect(sanitizeCard({ ...toLiveCard(live())!, seen_in: "Seen in 4 notes; ref EHRC-AUD-2026-1" })!.seen_in).toBeNull();
  });

  it("scrubs pipeline sentences and ids from the rationale, and ids from the evidence excerpt", () => {
    const card = toLiveCard(live())!;
    expect(card.why_it_matters).toBe("Together these raise bleeding risk.");
    expect(card.excerpt).toBe("Tab Warfarin 5mg OD; Tab Ibuprofen 400mg TID x5d. Ref");
  });

  it("keeps only http(s) citation links and shows a url-less citation as plain text", () => {
    const card = toLiveCard(live())!;
    expect(card.citations).toEqual([
      { title: "Warfarin label", url: "https://example.test/warfarin" },
      { title: "Local guidance", url: null },
      { title: "Bad link", url: null },
    ]);
  });

  it("sanitizeCard drops unknown and mistyped fields and refuses an id-less or source-less card", () => {
    const base = toLiveCard(live())!;
    const dirty = {
      ...base,
      triage: { rationale: "x" },
      reference: "EHRC-AUD-2026-0042",
      doctor_uid: "u",
      patient: { ...base.patient, phone: "123" },
      response: { verb: "agree", comment: "ok", at: "2026-10-03T00:00:00Z", reviewer: "RMO Singh" },
      view_note_href: "https://even-cdmss.vercel.app/api/governance/audits/x/pdf",
    };
    const clean = sanitizeCard(dirty)!;
    expect(Object.keys(clean).sort()).toEqual([...CARD_KEYS].sort());
    expect(clean.patient).not.toHaveProperty("phone");
    expect(clean.response).toEqual({ verb: "agree", comment: "ok", at: "2026-10-03T00:00:00Z" });
    expect(clean.view_note_href).toBeNull();
    expect(sanitizeCard({ ...base, id: "" })).toBeNull();
    expect(sanitizeCard({ ...base, source: "other" })).toBeNull();
    expect(sanitizeCard(null)).toBeNull();
    expect(sanitizeCard("nope")).toBeNull();
    // idempotent
    expect(sanitizeCard(clean)).toEqual(clean);
  });

  it("an unknown type with a code-like label falls back to a generic title, never the code", () => {
    expect(findingTitle("zz_new_type", "zz_new_type")).toBe("Documentation finding");
    expect(findingTitle("zz_new_type", "EHRC-AUD-2026-0001")).toBe("Documentation finding");
    expect(findingTitle("zz_new_type", "Engine flagged item")).toBe("Documentation finding");
    expect(findingTitle("zz_new_type", "Incomplete assessment")).toBe("Incomplete assessment");
    expect(findingTitle(undefined, undefined)).toBe("Documentation finding");
    const card = toLiveCard(live({ signal_type: "zz_new_type", label: "zz_new_type" }))!;
    expect(card.title).toBe("Documentation finding");
    expect(JSON.stringify(card)).not.toContain("zz_new_type");
  });

  it("an unknown response_required gives no ask and no controls", () => {
    expect(askOf("none")).toBeNull();
    expect(askOf("something_new")).toBeNull();
    const card = toLiveCard(live({ response_required: "something_new" }))!;
    expect(card.ask).toBeNull();
    expect(card.can_respond).toBe(false);
  });
});

describe("contract fields are optional and per-finding visibility is enforced", () => {
  it("today's payload (none of the new fields) still builds a valid card", () => {
    const old = live({
      representative: {
        audit_id: AUDIT,
        subject: "Antibiotic course",
        rationale: "Duration is longer than usual.",
        note_date: "2026-09-19",
        citations: [{ n: 1, title: "Policy", url: "https://example.test/p" }],
      },
    });
    const card = toLiveCard(old)!;
    expect(card.patient).toBeNull();
    expect(card.excerpt).toBeNull();
    expect(card.note_date).toBe("2026-09-19");
    expect(card.citations).toHaveLength(1);
    expect(contextLine(card)).toBe("OPD note · 19 Sep 2026");
    expect(card.view_note_href).toBeNull();
  });

  it("a finding whose routed flag is false is never shown, at either level", () => {
    expect(toLiveCard(live({ routed: false }))).toBeNull();
    expect(toLiveCard(live({ representative: { ...(h.hostileSignal.representative), routed: false } }))).toBeNull();
    expect(toLiveCardsPayload({ signals: [live({ routed: false }), live({ signal_id: "sig-2" })] }).cards.map((c) => c.id)).toEqual(["sig-2"]);
  });

  it("the finding is read from `representative` only; an instances array is not a source", () => {
    const card = toLiveCard(
      live({
        representative: null,
        instances: [{ routed: true, subject: "Smuggled", audit_id: AUDIT }],
      }),
    )!;
    expect(card.subject).toBe("");
    expect(JSON.stringify(card)).not.toContain("Smuggled");
  });

  it("the C1 payload shape: reference, uid and sla_due_at never pass; null patient fields collapse cleanly", () => {
    const c1 = {
      reference: "EHRC-AUD-2026-0007",
      signal_id: "sig-c1",
      doctor_uid: "uid-c1",
      signal_type: "incomplete_dosing",
      note_class: "discharge",
      label: "Incomplete dosing",
      response_required: "explanation",
      status: "routed",
      overdue: false,
      sla_due_at: "2026-10-12T00:00:00Z",
      routed_at: "2026-10-05T00:00:00Z",
      instances: 4,
      window: { from: "2026-09-01", to: "2026-10-01" },
      response: null,
      representative: {
        audit_id: AUDIT,
        routed: true,
        note_class: "discharge",
        note_date: "2026-10-02",
        subject: "Discharge medicines lack doses",
        verdict: "Needs attention",
        rationale: "Doses let the patient follow the plan.",
        evidence_excerpt: "Guideline: every discharge medicine lists dose, route and frequency.",
        citations: [{ title: "Discharge checklist", url: null }],
        patient: { name: null, age: null, sex: null, ip_number: "IP-77", uhid: null },
      },
    };
    const card = toLiveCard(c1)!;
    const text = JSON.stringify(card);
    for (const banned of ["EHRC-AUD", "uid-c1", "sla_due_at", "2026-10-12", "reference"]) {
      expect(text).not.toContain(banned);
    }
    expect(contextLine(card)).toBe("Discharge summary · 2 Oct 2026 · IP IP-77");
    expect(card.seen_in).toBe("Seen in 4 notes");
    expect(card.ask).toBe("explain");
    expect(card.view_note_href).toBe(`/api/portal/findings/pdf?ref=${AUDIT}`);
  });

  it("the context line collapses with no dangling separators or empty labels", () => {
    const base = toLiveCard(live({ note_class: "ot" }))!;
    const none = { ...base, patient: null };
    expect(contextLine(none)).toBe("OT note · 30 Sep 2026");
    const uhidOnly = { ...base, patient: { name: null, age: null, sex: null, ip_number: null, uhid: "EH77" } };
    expect(contextLine(uhidOnly)).toBe("OT note · 30 Sep 2026 · UHID EH77");
    const noDate = { ...base, note_date: null, patient: uhidOnly.patient };
    expect(contextLine(noDate)).toBe("OT note · UHID EH77");
    const nameOnly = { ...base, patient: { name: "A B", age: null, sex: null, ip_number: null, uhid: null } };
    expect(contextLine(nameOnly)).toBe("OT note · 30 Sep 2026 · A B");
    const ageOnly = { ...base, patient: { name: null, age: "54", sex: null, ip_number: null, uhid: null } };
    expect(contextLine(ageOnly)).toBe("OT note · 30 Sep 2026 · 54");
    for (const c of [none, uhidOnly, noDate, nameOnly, ageOnly]) {
      expect(contextLine(c)).not.toMatch(/·\s*·|^\s*·|·\s*$|Patient/);
    }
    expect(contextLine({ ...base, note_type: null, note_date: null, patient: null })).toBe("");
  });

  it("both spellings of the discharge class mean the same everywhere", () => {
    expect(toLiveCard(live({ note_class: "discharge" }))!.note_type).toBe("Discharge summary");
    expect(toLiveCard(live({ note_class: "discharge_summary" }))!.note_type).toBe("Discharge summary");
    expect(toLiveCard(live({ note_class: "opd", representative: { ...h.hostileSignal.representative, note_class: "discharge" } }))!.note_type).toBe("Discharge summary");
    expect(toDocumentCard(docRow({ note_class: "discharge_summary" }))!.note_type).toBe("Discharge summary");
    expect(toDocumentCard(docRow({ note_class: "discharge" }))!.note_type).toBe("Discharge summary");
  });

  it("new contract fields on the signal level are used when the representative lacks them", () => {
    const card = toLiveCard(
      live({
        note_date: "2026-09-01",
        evidence_excerpt: "From the note.",
        patient: { name: "C D", age: "30", sex: "F" },
        representative: { audit_id: AUDIT, subject: "S", rationale: "R." },
      }),
    )!;
    expect(card.note_date).toBe("2026-09-01");
    expect(card.excerpt).toBe("From the note.");
    expect(card.patient?.sex).toBe("F");
  });

  it("caps the excerpt at 600 characters", () => {
    const card = toLiveCard(
      live({ representative: { ...(h.hostileSignal.representative), evidence_excerpt: "x".repeat(2000) } }),
    )!;
    expect(card.excerpt!.length).toBe(600);
  });
});

describe("the text on the card", () => {
  it("context line: note type, date, patient with age/sex, then IP (or UHID when no IP)", () => {
    const card = toLiveCard(live())!;
    expect(contextLine(card)).toBe("OPD note · 30 Sep 2026 · Ramesh Kumar, 54/M · IP IP-4821");
    const noIp = { ...card, patient: { ...card.patient!, ip_number: null } };
    expect(contextLine(noIp)).toBe("OPD note · 30 Sep 2026 · Ramesh Kumar, 54/M · UHID EH00123");
  });

  it("recorded responses read in words", () => {
    expect(responseInWords({ verb: "agree", comment: null, at: "2026-10-03T08:00:00Z" })).toBe(
      "You acknowledged on 3 Oct",
    );
    expect(responseInWords({ verb: "agree", comment: null, at: "2026-10-03T08:00:00Z" }, "explain")).toBe(
      "You confirmed on 3 Oct",
    );
    expect(responseInWords({ verb: "disagree", comment: "Dose was split BD", at: null })).toBe(
      "You disagreed: Dose was split BD",
    );
    expect(responseInWords({ verb: "needs_clarification", comment: "Which ref?", at: "2026-10-03T08:00:00Z" })).toBe(
      "You asked for clarification: Which ref? (3 Oct)",
    );
    expect(responseInWords({ verb: "other", comment: null, at: null })).toBe("You responded");
  });

  it("an upstream response is shown in words and the comment is not scrubbed", () => {
    const card = toLiveCard(
      live({
        status: "responded",
        response: { verb: "disagree", comment: "The RMO misread the chart", at: "2026-10-03T08:00:00Z" },
      }),
    )!;
    expect(card.can_respond).toBe(false);
    expect(responseInWords(card.response!, card.ask)).toBe("You disagreed: The RMO misread the chart (3 Oct)");
  });

  it("dates format deterministically and tolerate junk", () => {
    expect(fmtShortDate("2026-10-03")).toBe("3 Oct");
    expect(fmtLongDate("2026-10-03")).toBe("3 Oct 2026");
    expect(fmtShortDate("2026-10-03T20:00:00Z")).toBe("4 Oct"); // 01:30 IST next day
    expect(fmtShortDate("not a date")).toBe("");
    expect(fmtShortDate(null)).toBe("");
  });

  it("note classes accept both spellings", () => {
    expect(cardNoteClass("discharge")).toBe("discharge");
    expect(cardNoteClass("discharge_summary")).toBe("discharge");
    expect(cardNoteClass("OT")).toBe("ot");
    expect(cardNoteClass("progress")).toBeNull();
  });

  it("scrubText strips ids and drops sentences with pipeline wording but keeps clinical prose", () => {
    expect(scrubText("Check the dose. The triage engine routed it. See EHRC-AUD-2026-0042.")).toBe("Check the dose.");
    expect(scrubText("A cat scan was ordered. Review with the RMO.")).toBe("A cat scan was ordered.");
    expect(scrubText("ot:1234abcd")).toBeNull();
    expect(scrubText(null)).toBeNull();
  });

  it("errors are plain sentences and unknown codes get the generic one", () => {
    for (const code of ["disabled", "already_recorded", "already_responded", "closed", "invalid", "unmapped", "not_found", "unavailable", "Unauthorized", "weird_code"]) {
      const s = friendlyError(code);
      expect(s).toMatch(/^[A-Z].*[.]$/);
      expect(s).not.toContain("_");
    }
    expect(friendlyError("weird_code")).toBe("Something went wrong. Please try again.");
  });

  it("the fixed copy has no pipeline wording", () => {
    for (const t of [ADVISORY_FOOTER, UNLINKED_TEXT]) {
      expect(t).not.toMatch(/CDMSS|CAT\b|RMO|triage|engine|bot\b/i);
    }
    expect(UNLINKED_TEXT).toBe("Your findings will appear here once your profile is linked by the quality team.");
    expect(ADVISORY_FOOTER).toBe(
      "These are documentation and prescribing observations reviewed by the quality team. They are not a performance score.",
    );
  });
});

function docRow(over: Partial<DocumentFindingRow> = {}): DocumentFindingRow {
  return {
    finding_id: "f1f1f1f1-1111-4111-8111-111111111111",
    finding_label: "Discharge medication list missing doses",
    finding_body: "Doses are needed so the patient and pharmacist can follow the plan.",
    status: "open",
    cdmss_routed: true,
    doc_type: "discharge",
    cdmss_pdf_url: `https://even-cdmss.vercel.app/api/governance/audits/${AUDIT}/pdf`,
    source_audit_id: AUDIT,
    doctor_response_verb: null,
    doctor_response_comment: null,
    doctor_responded_at: null,
    response_owner: "local",
    signal_reference: null,
    signal_type: "incomplete_dosing",
    note_class: "discharge",
    note_date: "2026-10-02",
    evidence_excerpt: "Discharge on Tab Metformin, Tab Amlodipine",
    citations_json: [{ title: "Discharge checklist", url: "https://example.test/c" }],
    patient_json: { name: "Sita Rao", age: 67, sex: "F", ip_number: "IP-9001", uhid: null },
    ...over,
  };
}

describe("document-pipe cards", () => {
  it("builds a discharge card on the same shape, with no author, reference or status", () => {
    const card = toDocumentCard(docRow())!;
    expect(Object.keys(card).sort()).toEqual([...CARD_KEYS].sort());
    expect(card.title).toBe("Incomplete dosing instructions");
    expect(card.note_type).toBe("Discharge summary");
    expect(contextLine(card)).toBe("Discharge summary · 2 Oct 2026 · Sita Rao, 67/F · IP IP-9001");
    expect(card.ask).toBe("acknowledge");
    expect(card.can_respond).toBe(true);
    expect(card.view_note_href).toBe(`/api/portal/findings/pdf?ref=${AUDIT}`);
    const text = JSON.stringify(card);
    for (const banned of ["even-cdmss", "/api/governance", "RMO", "CDMSS", "open", "ds:"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("a finding already on the live list is left out so the doctor is not asked twice", () => {
    expect(toDocumentCard(docRow({ response_owner: "pipe_a", signal_reference: "EHRC-AUD-2026-0001" }))).toBeNull();
    expect(toDocumentCards([docRow(), docRow({ response_owner: "pipe_a" })])).toHaveLength(1);
  });

  it("a recorded response replaces the controls", () => {
    const card = toDocumentCard(
      docRow({ doctor_response_verb: "agree", doctor_responded_at: "2026-10-03T08:00:00Z", status: "remediated" }),
    )!;
    expect(card.can_respond).toBe(false);
    expect(card.ask).toBeNull();
    expect(responseInWords(card.response!, card.ask)).toBe("You acknowledged on 3 Oct");
  });

  it("falls back to the source audit id for the note link, and to no link when neither exists", () => {
    expect(toDocumentCard(docRow({ cdmss_pdf_url: null }))!.view_note_href).toBe(`/api/portal/findings/pdf?ref=${AUDIT}`);
    expect(toDocumentCard(docRow({ cdmss_pdf_url: null, source_audit_id: null }))!.view_note_href).toBeNull();
    expect(toDocumentCard(docRow({ cdmss_pdf_url: "https://cdn.example/a.pdf", source_audit_id: null }))!.view_note_href).toBeNull();
  });

  it("derives the note type from doc_type when the class is absent, and shows nothing it does not know", () => {
    expect(toDocumentCard(docRow({ note_class: null, doc_type: "ot" }))!.note_type).toBe("OT note");
    expect(toDocumentCard(docRow({ note_class: null, doc_type: "progress" }))!.note_type).toBe("Progress note");
    expect(toDocumentCard(docRow({ note_class: null, doc_type: "mystery" }))!.note_type).toBeNull();
    const bare = toDocumentCard(docRow({ patient_json: null, evidence_excerpt: null, citations_json: null }))!;
    expect(bare.patient).toBeNull();
    expect(bare.excerpt).toBeNull();
    expect(bare.citations).toEqual([]);
  });
});

describe("the doctor-facing components print no pipeline wording", () => {
  const FILES = [
    "src/components/portal/FindingCard.tsx",
    "src/components/portal/FindingsForDoctor.tsx",
    "src/components/portal/LocalDocumentAuditsForDoctor.tsx",
  ];
  /** Source with comments removed, so only strings and markup that can reach a screen remain. */
  const code = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const file of FILES) {
    it(`${file} has none of the removed blocks or words`, () => {
      const src = code(file);
      for (const banned of [
        "Triage context",
        "Policy ",
        "private research",
        "pending RMO",
        "Routed ",
        "EHRC-AUD",
        "reference",
        "authored_by",
        "signal_reference",
        "care manager",
        "TriageBot",
        "CAT profile",
        "engine",
      ]) {
        expect(src, banned).not.toContain(banned);
      }
      expect(src).not.toMatch(/\bRMO\b|\bCDMSS\b/);
    });
  }

  it("the collapsed section is headed Basis (guideline points), not Evidence", () => {
    const src = code("src/components/portal/FindingCard.tsx");
    expect(src).toContain("Basis");
    expect(src).not.toMatch(/>\s*Evidence\s*</);
  });

  it("the filter and the server accept both discharge spellings", async () => {
    const { parseNoteClassQuery, normalizeNoteClass } = await import("@/lib/doctor-audits");
    expect(parseNoteClassQuery("discharge")).toBe("discharge_summary");
    expect(parseNoteClassQuery("discharge_summary")).toBe("discharge_summary");
    expect(normalizeNoteClass("discharge")).toBe("discharge_summary");
  });

  it("the card component never prints the opaque id", () => {
    const src = code("src/components/portal/FindingCard.tsx");
    // card.id is only ever used to build a POST body.
    const uses = src.match(/card\.id/g) ?? [];
    expect(uses.length).toBe(4);
    expect(src).not.toMatch(/\{\s*card\.id\s*\}/);
  });
});

function req(url: string, body?: unknown) {
  return new NextRequest(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
}

describe("routes answer cards only", () => {
  beforeEach(() => {
    process.env.PORTAL_FINDINGS = "1";
    process.env.PORTAL_REACTIONS = "1";
    process.env.PORTAL_FINDINGS_RESPOND = "1";
  });
  afterEach(() => {
    delete process.env.PORTAL_FINDINGS;
    delete process.env.PORTAL_REACTIONS;
    delete process.env.PORTAL_FINDINGS_RESPOND;
    vi.mocked(loadPortalRoutedFindings).mockReset().mockResolvedValue([]);
  });

  it("GET /api/portal/findings returns { ok, mapped, cards } with nothing hostile in the body", async () => {
    const res = await findingsGET(req("https://portal.test/api/portal/findings"));
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["cards", "mapped", "ok"]);
    expect(body.cards).toHaveLength(1);
    for (const banned of BANNED_WORDS) expect(text).not.toContain(banned);
  });

  it("POST respond answers response state only (never a card or a raw signal) and relays no upstream internals", async () => {
    const res = await respondPOST(req("https://portal.test/api/portal/findings/respond", { signal_id: "sig-777", verb: "agree" }));
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["ok", "state"]);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.state).sort()).toEqual(["response", "status"]);
    expect(Object.keys(body.state.response).sort()).toEqual(["at", "comment", "verb"]);
    expect(body.state.status).toBe("responded");
    expect(body.state.response.verb).toBe("agree");
    expect(body).not.toHaveProperty("card");
    for (const banned of BANNED_WORDS) expect(text).not.toContain(banned);
    for (const leak of ["importance", "ruling", "triage", "reference", "doctor_uid", "signal_id", "representative", "jev", "model"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("POST respond survives a CDMSS body with governance fields and representative:null: only response state goes out", async () => {
    vi.mocked(callResponse).mockResolvedValueOnce({
      kind: "http",
      status: 200,
      body: {
        ok: true,
        governance: { importance: "high", ruling: "upheld", triage: "route to RMO" },
        signal: {
          ...h.hostileSignal,
          importance: "critical",
          ruling: { by: "council", outcome: "upheld" },
          triage: { rationale: "Triage engine says route to RMO" },
          representative: null,
          status: "responded",
          response: {
            verb: "disagree",
            comment: "Dose was split across the day.",
            responded_at: "2026-10-03T08:00:00Z",
            ruling: "overturned",
            importance: "high",
            doctor_uid: "cdmss-uid-secret",
          },
        },
      },
    });
    const res = await respondPOST(req("https://portal.test/api/portal/findings/respond", { signal_id: "sig-777", verb: "disagree", comment: "Dose was split across the day." }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      state: {
        status: "responded",
        response: { verb: "disagree", comment: "Dose was split across the day.", at: "2026-10-03T08:00:00Z" },
      },
    });
    for (const banned of [...BANNED_WORDS, "importance", "ruling", "overturned", "governance", "representative", "doctor_uid", "reference", "signal_id"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("POST respond falls back to the doctor's own submission when CDMSS sent no readable response", async () => {
    vi.mocked(callResponse).mockResolvedValueOnce({
      kind: "http",
      status: 200,
      body: { ok: true, signal: { status: "responded", representative: null, triage: { rationale: "x" }, response: null } },
    });
    const res = await respondPOST(req("https://portal.test/api/portal/findings/respond", { signal_id: "sig-777", verb: "agree" }));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["ok", "state"]);
    expect(body.state.status).toBe("responded");
    expect(body.state.response.verb).toBe("agree");
    expect(body.state.response.comment).toBeNull();
    expect(typeof body.state.response.at).toBe("string");

    vi.mocked(callResponse).mockResolvedValueOnce({ kind: "http", status: 200, body: { ok: true } });
    const bare = await (await respondPOST(req("https://portal.test/api/portal/findings/respond", { signal_id: "sig-777", verb: "agree" }))).json();
    expect(bare.state.status).toBeNull();
    expect(bare.state.response.verb).toBe("agree");
  });

  it("toResponseState reads status and response only, and refuses a status that is not a plain word", () => {
    expect(toResponseState(null)).toEqual({ status: null, response: null });
    expect(toResponseState("junk")).toEqual({ status: null, response: null });
    expect(toResponseState({ status: "Triage: RMO!", importance: "high", response: { verb: "agree", at: "2026-10-03T08:00:00Z" } })).toEqual({
      status: null,
      response: { verb: "agree", comment: null, at: "2026-10-03T08:00:00Z" },
    });
    const s = toResponseState({
      status: "responded",
      ruling: "upheld",
      representative: null,
      response: { verb: "agree", comment: "Fine, see EHRC-AUD-2026-0042.", responded_at: "2026-10-03T08:00:00Z", triage: "x" },
    });
    expect(Object.keys(s).sort()).toEqual(["response", "status"]);
    expect(Object.keys(s.response ?? {}).sort()).toEqual(["at", "comment", "verb"]);
    expect(JSON.stringify(s)).not.toContain("EHRC-AUD");
    expect(JSON.stringify(s)).not.toContain("upheld");
  });

  it("the browser merges response state into the card it already has and never replaces the card", () => {
    const code = (p: string) =>
      readFileSync(join(process.cwd(), p), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const card = code("src/components/portal/FindingCard.tsx");
    const live = code("src/components/portal/FindingsForDoctor.tsx");
    const docs = code("src/components/portal/LocalDocumentAuditsForDoctor.tsx");
    expect(card).toContain("onResponded");
    expect(card).not.toContain("onReplace");
    for (const src of [live, docs]) {
      expect(src).toContain("markResponded");
      expect(src).not.toContain("replaceCard");
      expect(src).not.toContain("onReplace");
      expect(src).toMatch(/\.\.\.x,\s*response,\s*can_respond:\s*false/);
    }
  });

  it("POST respond with a bad body answers a plain sentence, not the parser's developer text", async () => {
    const res = await respondPOST(req("https://portal.test/api/portal/findings/respond", { signal_id: "s", verb: "disagree" }));
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "invalid", message: "Please check what you entered and try again." });
  });

  it("POST react relays a plain sentence for a failure and no upstream record on success", async () => {
    const res = await reactPOST(req("https://portal.test/api/portal/findings/react", { signal_id: "sig-777", reaction: "dismiss" }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("already_recorded");
    expect(body.message).toBe("You have already recorded a reaction for this finding.");
  });

  it("POST react forwards nothing from a governance-laden CDMSS body", async () => {
    vi.mocked(callReaction).mockResolvedValueOnce({
      kind: "http",
      status: 200,
      body: {
        ok: true,
        replay: false,
        reaction: { reaction: "dismiss", doctor_uid: "cdmss-uid-secret" },
        signal: { ...h.hostileSignal, representative: null, importance: "critical", ruling: "upheld", triage: { rationale: "route to RMO" } },
      },
    });
    const res = await reactPOST(req("https://portal.test/api/portal/findings/react", { signal_id: "sig-777", reaction: "dismiss" }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, replay: false });
    for (const leak of [...BANNED_WORDS, "importance", "ruling", "representative", "doctor_uid", "reference", "signal"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("GET /api/portal/document-audits returns cards built from rows, and hides rows owned by the live list", async () => {
    vi.mocked(loadPortalRoutedFindings).mockResolvedValue([
      {
        ...docRow(),
        audit_id: "a",
        external_ref: "ds:abc12345",
        severity: "high",
        authored_by_name: "CDMSS audit (pending RMO review)",
        authored_at: "2026-10-01T00:00:00Z",
      },
      { ...docRow({ finding_id: "f2" , response_owner: "pipe_a" }), audit_id: "a", external_ref: null, severity: "low", authored_by_name: "x", authored_at: "2026-10-01T00:00:00Z" },
    ] as unknown as Awaited<ReturnType<typeof loadPortalRoutedFindings>>);
    const res = await docsGET();
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["cards", "ok"]);
    expect(body.cards).toHaveLength(1);
    for (const banned of ["ds:abc12345", "pending RMO", "CDMSS", "authored", "severity", "external_ref"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("POST document-audits/respond requires a comment to disagree, passes it through, and speaks plainly", async () => {
    const noComment = await docsRespondPOST(req("https://portal.test/x", { finding_id: "f1", verb: "disagree" }));
    expect((await noComment.json()).message).toBe("Please check what you entered and try again.");
    expect(recordDoctorFindingResponse).not.toHaveBeenCalled();

    const ok = await docsRespondPOST(req("https://portal.test/x", { finding_id: "f1", verb: "disagree", comment: " Dose was split " }));
    expect(await ok.json()).toEqual({ ok: true });
    expect(recordDoctorFindingResponse).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: "f1", verb: "disagree", comment: "Dose was split" }),
    );

    vi.mocked(recordDoctorFindingResponse).mockResolvedValueOnce({ ok: false, error: "already_responded" });
    const twice = await docsRespondPOST(req("https://portal.test/x", { finding_id: "f1", verb: "agree" }));
    expect(twice.status).toBe(409);
    expect(await twice.json()).toEqual({
      ok: false,
      error: "already_responded",
      message: "You have already responded to this finding.",
    });

    vi.mocked(recordDoctorFindingResponse).mockResolvedValueOnce({ ok: false, error: "closed" });
    const closed = await docsRespondPOST(req("https://portal.test/x", { finding_id: "f1", verb: "agree" }));
    expect(closed.status).toBe(409);
    expect((await closed.json()).message).toBe("This finding is now closed, so no response is needed.");

    vi.mocked(recordDoctorFindingResponse).mockResolvedValueOnce({ ok: false, error: "on_live_list" });
    const live2 = await docsRespondPOST(req("https://portal.test/x", { finding_id: "f1", verb: "agree" }));
    expect(live2.status).toBe(409);
    expect((await live2.json()).message).toBe("This finding is on your main Findings list. Please respond to it there.");

    vi.mocked(recordDoctorFindingResponse).mockResolvedValueOnce({ ok: false, error: "not_found" });
    expect((await docsRespondPOST(req("https://portal.test/x", { finding_id: "f1", verb: "agree" }))).status).toBe(200);
  });
});
