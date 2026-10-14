import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  catErrorText,
  mapReactOutcome,
  mapRespondOutcome,
  normalizeComment,
  parseReactBody,
  parseRespondBody,
  COMMENT_MAX,
  type CatOutcome,
} from "../findings-actions";
import {
  normalizeNoteClass,
  normalizeReactions,
  parseNoteClassQuery,
  type DoctorAuditSignal,
  type DoctorAuditsUpstream,
} from "../doctor-audits";
import { toLiveCard, toLiveCardsPayload } from "../doctor-card";

/**
 * WM2 v1 — reactions and responses on Findings.
 *
 * Two kinds of test here, and the split is deliberate. The mapping and the body rules are PURE, so
 * they are tested by calling them. The route and component guarantees — "the client's identity
 * fields are never read", "the flag hides both rows" — have no harness in this repo (no vitest
 * config, so no `@/` alias for a route import; no jsdom, so no render), and they are checked by
 * reading the source instead. A source check is weaker than a render, and it is written to fail
 * loudly if the shape it depends on is refactored away, rather than to pass quietly.
 */

const SRC = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const REACT_ROUTE = "src/app/api/portal/findings/react/route.ts";
const RESPOND_ROUTE = "src/app/api/portal/findings/respond/route.ts";
const FINDINGS_ROUTE = "src/app/api/portal/findings/route.ts";
const CARD = "src/components/portal/FindingsForDoctor.tsx";
const CARD_COMPONENT = "src/components/portal/FindingCard.tsx";

const http = (status: number, body: unknown): CatOutcome => ({ kind: "http", status, body });
const transport: CatOutcome = { kind: "transport" };

function signal(over: Partial<DoctorAuditSignal> = {}): DoctorAuditSignal {
  return {
    reference: "EHRC-AUD-2026-0001",
    signal_id: "sig-1",
    doctor_uid: "cdmss-uid-must-never-ship",
    signal_type: "documentation",
    label: "Incomplete assessment",
    importance: "high",
    response_required: "explanation",
    status: "routed",
    overdue: true,
    instances: 3,
    window: { from: "2026-08-01", to: "2026-08-31" },
    representative: null,
    routed_at: "2026-09-01T00:00:00Z",
    sla_due_at: "2026-09-08T00:00:00Z",
    response: null,
    ruling: { by: "council" },
    ...over,
  };
}

function upstream(signals: DoctorAuditSignal[]): DoctorAuditsUpstream {
  return {
    ok: true,
    doctor: { uid: "cdmss-uid-must-never-ship", name: "Dr A", speciality: "Cardiology" },
    window: { days: 90 },
    metrics: { audit: { score: 71 }, operational: { late: 4 } },
    signals,
    advisory: "",
  };
}

describe("toLiveCardsPayload: the allowlist strip", () => {
  it("never carries overdue, sla_due_at, doctor_uid, reference, triage or ruling", () => {
    const out = toLiveCardsPayload(
      upstream([
        signal({ triage: { rationale: "Route for review", policy_version: "triage-v2" } }),
        signal({ signal_id: "sig-2" }),
      ]),
    );
    const text = JSON.stringify(out);
    for (const banned of [
      "overdue",
      "sla_due_at",
      "doctor_uid",
      "EHRC-AUD",
      "triage",
      "policy_version",
      "ruling",
      "council",
      "cdmss-uid-must-never-ship",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("answers { ok, mapped, cards } and nothing else: no doctor envelope, metrics or advisory", () => {
    const out = toLiveCardsPayload(upstream([signal()]));
    expect(Object.keys(out).sort()).toEqual(["cards", "mapped", "ok"]);
    expect(JSON.stringify(out)).not.toContain("Cardiology");
  });

  it("carries the doctor's reaction from the reactions map, keyed by signal_id", () => {
    const out = toLiveCardsPayload(upstream([signal(), signal({ signal_id: "sig-2" })]), {
      "sig-2": { reaction: "surprised" },
    });
    expect(out.cards[0].reaction).toBeNull();
    expect(out.cards[1].reaction).toBe("surprised");
  });

  it("sets reaction null on every card when the reactions map is null — the failed-call case", () => {
    const out = toLiveCardsPayload(upstream([signal(), signal({ signal_id: "sig-2" })]), null);
    expect(out.ok).toBe(true);
    expect(out.cards.map((c) => c.reaction)).toEqual([null, null]);
  });

  it("survives a malformed payload", () => {
    expect(toLiveCardsPayload({ signals: "not-an-array" }).cards).toEqual([]);
    expect(toLiveCardsPayload(null).cards).toEqual([]);
  });

  it("defaults a missing note class to an OPD note and names the others in words", () => {
    expect(toLiveCard(signal())!.note_type).toBe("OPD note");
    expect(toLiveCard(signal({ note_class: "bogus" }))!.note_type).toBe("OPD note");
    expect(toLiveCard(signal({ note_class: "discharge_summary" }))!.note_type).toBe("Discharge summary");
    expect(toLiveCard(signal({ note_class: "discharge" }))!.note_type).toBe("Discharge summary");
    expect(toLiveCard(signal({ note_class: "ot" }))!.note_type).toBe("OT note");
  });
});

describe("note_class helpers", () => {
  it("normalizeNoteClass treats missing and unknown as opd", () => {
    expect(normalizeNoteClass(undefined)).toBe("opd");
    expect(normalizeNoteClass(null)).toBe("opd");
    expect(normalizeNoteClass("")).toBe("opd");
    expect(normalizeNoteClass("OPD")).toBe("opd");
    expect(normalizeNoteClass("opd")).toBe("opd");
    expect(normalizeNoteClass("discharge_summary")).toBe("discharge_summary");
    expect(normalizeNoteClass("ot")).toBe("ot");
  });

  it("parseNoteClassQuery only passes the three canonical values", () => {
    expect(parseNoteClassQuery(null)).toBeNull();
    expect(parseNoteClassQuery("")).toBeNull();
    expect(parseNoteClassQuery("all")).toBeNull();
    expect(parseNoteClassQuery("bogus")).toBeNull();
    expect(parseNoteClassQuery("opd")).toBe("opd");
    expect(parseNoteClassQuery("discharge_summary")).toBe("discharge_summary");
    expect(parseNoteClassQuery("ot")).toBe("ot");
  });

});

describe("normalizeReactions: a malformed entry is dropped, not rendered", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(
      normalizeReactions({
        a: { reaction: "already_knew", at: "2026-09-07T10:00:00Z" },
        b: { reaction: "" },
        c: null,
        d: { at: "2026-09-07T10:00:00Z" },
        e: { reaction: "dismiss" },
      }),
    ).toEqual({
      a: { reaction: "already_knew", at: "2026-09-07T10:00:00Z" },
      e: { reaction: "dismiss", at: "" },
    });
  });

  it("returns an empty map for anything that is not an object", () => {
    expect(normalizeReactions(null)).toEqual({});
    expect(normalizeReactions([1, 2])).toEqual({});
    expect(normalizeReactions("x")).toEqual({});
  });
});

describe("react route error mapping", () => {
  const cases: Array<[string, CatOutcome, unknown]> = [
    ["CAT 200 first time", http(200, { ok: true, replay: false, reaction: { reaction: "dismiss" } }), { ok: true, replay: false, reaction: { reaction: "dismiss" } }],
    ["CAT 200 replay", http(200, { ok: true, replay: true, reaction: { reaction: "dismiss" } }), { ok: true, replay: true, reaction: { reaction: "dismiss" } }],
    ["CAT 409", http(409, { ok: false, error: "reaction already recorded" }), { ok: false, error: "already_recorded" }],
    ["CAT 400", http(400, { error: "missing field" }), { ok: false, error: "unavailable" }],
    ["CAT 403", http(403, { error: "doctor_uid does not match the signal" }), { ok: false, error: "unavailable" }],
    ["CAT 404", http(404, { error: "unknown signal" }), { ok: false, error: "unavailable" }],
    ["CAT 500", http(500, null), { ok: false, error: "unavailable" }],
    ["CAT 502", http(502, null), { ok: false, error: "unavailable" }],
    ["timeout or network", transport, { ok: false, error: "unavailable" }],
    ["200 that says ok:false", http(200, { ok: false }), { ok: false, error: "unavailable" }],
  ];
  for (const [name, outcome, expected] of cases) {
    it(name, () => expect(mapReactOutcome(outcome)).toEqual(expected));
  }

  it("defaults replay to false when CAT omits it, so a missing flag never suppresses the audit row", () => {
    expect(mapReactOutcome(http(200, { ok: true }))).toEqual({ ok: true, replay: false, reaction: null });
  });
});

describe("respond route error mapping", () => {
  const cases: Array<[string, CatOutcome, unknown]> = [
    ["CAT 200", http(200, { ok: true, status: "responded", signal: { signal_id: "sig-1" } }), { ok: true, signal: { signal_id: "sig-1" } }],
    ["CAT 409 already responded", http(409, { error: "already responded — revisions go through your care manager" }), { ok: false, error: "already_responded" }],
    ["CAT 409 signal already closed", http(409, { error: "signal already closed" }), { ok: false, error: "closed" }],
    ["CAT 409 with an unrecognised error", http(409, { error: "something else" }), { ok: false, error: "unavailable" }],
    ["CAT 400", http(400, { error: "comment is required for an explanation" }), { ok: false, error: "invalid", message: "comment is required for an explanation" }],
    ["CAT 400 with no error text", http(400, null), { ok: false, error: "invalid", message: "" }],
    ["CAT 403", http(403, { error: "doctor_uid does not match the signal" }), { ok: false, error: "unavailable" }],
    ["CAT 404", http(404, { error: "unknown reference" }), { ok: false, error: "unavailable" }],
    ["CAT 500", http(500, null), { ok: false, error: "unavailable" }],
    ["timeout or network", transport, { ok: false, error: "unavailable" }],
    ["200 that says ok:false", http(200, { ok: false }), { ok: false, error: "unavailable" }],
  ];
  for (const [name, outcome, expected] of cases) {
    it(name, () => expect(mapRespondOutcome(outcome)).toEqual(expected));
  }

  it("reads CAT's message key when it does not use error", () => {
    expect(catErrorText({ message: "bad verdict" })).toBe("bad verdict");
    expect(catErrorText(null)).toBe("");
    expect(catErrorText("plain text")).toBe("");
  });
});

describe("parseReactBody: the body is exactly two keys", () => {
  it("accepts the contract body", () => {
    expect(parseReactBody({ signal_id: " sig-1 ", reaction: "surprised" })).toEqual({
      ok: true,
      signalId: "sig-1",
      reaction: "surprised",
    });
  });

  it("rejects a body with an extra key", () => {
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", note: "x" })).toEqual({
      ok: false,
      message: "unexpected field in body",
    });
  });

  it("rejects a body that smuggles doctor_uid or physician_id", () => {
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", doctor_uid: "other" }).ok).toBe(false);
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", physician_id: "other" }).ok).toBe(false);
  });

  it("rejects a missing signal_id and an unknown verb", () => {
    expect(parseReactBody({ reaction: "dismiss" })).toEqual({ ok: false, message: "signal_id is required" });
    expect(parseReactBody({ signal_id: "sig-1", reaction: "agree" })).toEqual({
      ok: false,
      message: "reaction must be already_knew, surprised or dismiss",
    });
  });

  it("rejects a non-object body", () => {
    expect(parseReactBody(null).ok).toBe(false);
    expect(parseReactBody([{ signal_id: "sig-1", reaction: "dismiss" }]).ok).toBe(false);
  });

  it("accepts all three verbs and nothing else", () => {
    for (const v of ["already_knew", "surprised", "dismiss"]) {
      expect(parseReactBody({ signal_id: "sig-1", reaction: v }).ok).toBe(true);
    }
  });
});

describe("parseRespondBody: the P2 doctor verbs", () => {
  it("accepts disagree with a comment", () => {
    expect(parseRespondBody({ signal_id: "sig-1", verb: "disagree", comment: "  because  " })).toEqual({
      ok: true,
      signalId: "sig-1",
      verb: "disagree",
      comment: "because",
    });
  });

  it("accepts agree without a comment", () => {
    expect(parseRespondBody({ signal_id: "sig-1", verb: "agree" })).toEqual({
      ok: true,
      signalId: "sig-1",
      verb: "agree",
      comment: null,
    });
  });

  it("rejects an unknown or missing verb", () => {
    expect(parseRespondBody({ signal_id: "sig-1", verb: "ruling" })).toEqual({
      ok: false,
      message: "verb must be agree, disagree or needs_clarification",
    });
    expect(parseRespondBody({ signal_id: "sig-1" })).toEqual({
      ok: false,
      message: "verb must be agree, disagree or needs_clarification",
    });
  });

  it("rejects identity and any other extra key", () => {
    expect(parseRespondBody({ signal_id: "sig-1", verb: "agree", doctor_uid: "other" })).toEqual({
      ok: false,
      message: "unexpected field in body",
    });
    expect(parseRespondBody({ signal_id: "sig-1", verb: "agree", physician_id: "other" }).ok).toBe(false);
  });

  it("caps the comment at the contract length", () => {
    const long = "x".repeat(COMMENT_MAX + 500);
    const out = parseRespondBody({ signal_id: "sig-1", verb: "agree", comment: long });
    expect(out.ok && out.comment?.length).toBe(COMMENT_MAX);
  });

  it("requires context for disagree and needs_clarification", () => {
    expect(parseRespondBody({ signal_id: "sig-1", verb: "disagree" })).toEqual({
      ok: false,
      message: "disagree requires a comment",
    });
    expect(parseRespondBody({ signal_id: "sig-1", verb: "needs_clarification", comment: " " })).toEqual({
      ok: false,
      message: "needs_clarification requires a comment",
    });
  });

  it("accepts all three doctor verbs", () => {
    expect(parseRespondBody({ signal_id: "sig-1", verb: "agree" }).ok).toBe(true);
    expect(parseRespondBody({ signal_id: "sig-1", verb: "disagree", comment: "No" }).ok).toBe(true);
    expect(
      parseRespondBody({
        signal_id: "sig-1",
        verb: "needs_clarification",
        comment: "Which policy?",
      }).ok,
    ).toBe(true);
  });

  it("normalizeComment turns whitespace-only into null", () => {
    expect(normalizeComment("   ")).toBeNull();
    expect(normalizeComment(undefined)).toBeNull();
    expect(normalizeComment(" hi ")).toBe("hi");
  });
});

describe("neither POST route reads an identity from the request body", () => {
  const BODY_VAR = /\b(?:raw|body|json|payload|parsed)\s*(?:\.\s*|\[\s*["'])(?:doctor_uid|physician_id)\b/;
  const DESTRUCTURE = /const\s*\{[^}]*\b(?:doctor_uid|physician_id)\b[^}]*\}\s*=/;

  for (const path of [REACT_ROUTE, RESPOND_ROUTE]) {
    it(`${path} never dereferences doctor_uid or physician_id off a parsed body`, () => {
      const src = SRC(path);
      expect(src).not.toMatch(BODY_VAR);
      expect(src).not.toMatch(DESTRUCTURE);
    });

    it(`${path} takes the physician from the session and the uid from the physicians table`, () => {
      const src = SRC(path);
      expect(src).toContain("getCurrentPhysician()");
      expect(src).toContain("SELECT cdmss_doctor_uid FROM physicians WHERE id=");
      expect(src).toContain("p.physicianId");
    });

    it(`${path} answers 401 only for a missing session`, () => {
      const src = SRC(path);
      expect(src.match(/status:\s*401/g) ?? []).toHaveLength(1);
      expect(src).not.toMatch(/status:\s*(?:400|403|404|409|500)/);
    });
  }

  it("the react route refuses an unexpected body key rather than ignoring it", () => {
    expect(SRC(REACT_ROUTE)).toContain("parseReactBody");
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", extra: 1 }).ok).toBe(false);
  });

  it("neither route puts a comment in its audit row", () => {
    expect(SRC(REACT_ROUTE)).toContain("'portal_reaction', 'physician'");
    const respond = SRC(RESPOND_ROUTE);
    expect(respond).toContain("'portal_response', 'physician'");
    const insert = respond.slice(respond.indexOf("INSERT INTO audit_log_v2"));
    expect(insert.slice(0, insert.indexOf("::jsonb"))).not.toContain("comment");
  });
});

describe("the findings GET survives a failed reactions call", () => {
  it("catches the reactions call separately from the audits call", () => {
    const src = SRC(FINDINGS_ROUTE);
    const inner = src.slice(src.indexOf("fetchDoctorReactions"));
    // The reactions failure sets the map to null and falls through to the ok:true payload; only the
    // audits failure is allowed to reach upstream_unavailable.
    expect(inner).toMatch(/catch\s*\{\s*\n?\s*reactions = null/);
    expect(inner.slice(0, inner.indexOf("toLiveCardsPayload"))).not.toContain("upstream_unavailable");
  });

  it("still answers ok:true with reaction null when the map is null", () => {
    const out = toLiveCardsPayload(upstream([signal()]), null);
    expect(out.ok).toBe(true);
    expect(out.mapped).toBe(true);
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0].reaction).toBeNull();
  });
});

describe("with the respond flag off the card shows no workflow controls", () => {
  const CONTROLS = ["Acknowledge", "I disagree", "I need clarification"];

  it("every response control lives in the separately gated ResponseControls block", () => {
    const src = SRC(CARD_COMPONENT);
    const controls = src.slice(src.indexOf("function ResponseControls"), src.indexOf("export function FindingCard"));
    for (const label of CONTROLS) expect(controls).toContain(label);
    expect(src).toContain("respond && card.can_respond ? (");
  });

  it("the flag-off branch says plainly that responding here is not available", () => {
    const src = SRC(CARD_COMPONENT);
    const off = src.slice(src.indexOf("!respond && ("));
    expect(off).toContain("Responding here is not available yet. Please reply to the quality team directly.");
    for (const label of CONTROLS) {
      expect(off.slice(0, off.indexOf("</p>"))).not.toContain(label);
    }
  });

  it("the independent flag reaches the card and defaults false", () => {
    expect(SRC(CARD)).toContain("respond = false");
    expect(SRC(CARD_COMPONENT)).toContain("respond = false");
    expect(SRC("src/app/portal/page.tsx")).toContain("respond={features.findingsRespond}");
    expect(SRC("src/app/api/portal/announcements/route.ts")).toContain("features: portalFlags()");
    expect(SRC("src/lib/portal-flags.ts")).toContain('on("PORTAL_FINDINGS_RESPOND")');
    expect(SRC(RESPOND_ROUTE)).toContain("respondEnabled()");
  });

  it("the BFF generates and forwards one idempotency key per submit", () => {
    const actions = SRC("src/lib/findings-actions.ts");
    const route = SRC(RESPOND_ROUTE);
    expect(route).toContain("const clientRequestId = randomUUID()");
    expect(actions).toContain("client_request_id: input.clientRequestId");
    expect(actions).toContain('"Idempotency-Key": input.clientRequestId');
  });
});

describe("note type filter chip and BFF pass-through", () => {
  it("the findings GET parses note_class and forwards it to fetchDoctorAudits", () => {
    const src = SRC(FINDINGS_ROUTE);
    expect(src).toContain("parseNoteClassQuery");
    expect(src).toContain('request.nextUrl.searchParams.get("note_class")');
    expect(src).toContain("note_class: noteClass");
    expect(src).toContain("fetchDoctorAudits");
  });

  it("fetchDoctorAudits only appends note_class when a class is selected", () => {
    const src = SRC("src/lib/doctor-audits.ts");
    expect(src).toContain("if (params.note_class) qs.set(\"note_class\", params.note_class)");
  });

  it("the Findings panel has All / OPD / Discharge summary / OT chips and refetches with note_class", () => {
    const src = SRC(CARD);
    expect(src).toContain('["all", "All"]');
    expect(src).toContain('["opd", "OPD"]');
    expect(src).toContain('["discharge_summary", "Discharge summary"]');
    expect(src).toContain('["ot", "OT"]');
    expect(src).toContain("noteClassFilter");
    expect(src).toContain("`?note_class=${encodeURIComponent(noteClassFilter)}`");
    expect(src).toContain("fetch(`/api/portal/findings${qs}`)");
  });

  it("respond verbs are unchanged by the card rewrite", () => {
    const src = SRC(CARD_COMPONENT);
    expect(src).toContain('send("agree")');
    expect(src).toContain('send("disagree")');
    expect(src).toContain('send("needs_clarification")');
  });
});
