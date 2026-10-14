/**
 * Shared test fixtures for the Round 2 governance tests: a fake tagged-template `sql`, staff users,
 * and CDMSS-shaped thread objects. Test-only; nothing in src/ imports this.
 */

import { vi } from "vitest";

export type SqlHandler = (text: string, values: unknown[]) => unknown;

/** A stand-in for the lazy Neon client: a tagged template that hands the joined text and values to `handler`. */
export function fakeSql(handler: SqlHandler) {
  return vi.fn(async (...args: unknown[]) => {
    const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
    return handler(strings.join("?"), values);
  });
}

export const PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const staff = {
  superAdmin: { profileId: PROFILE_ID, email: "vinay@even.in", status: "active", is_super_admin: true, is_sgc_member: false, is_site_medical_head: false, is_hr: false },
  smh: { profileId: PROFILE_ID, email: "benita@even.in", status: "active", is_super_admin: false, is_sgc_member: false, is_site_medical_head: true, is_hr: false },
  sgo: { profileId: PROFILE_ID, email: "sgo@even.in", status: "active", is_super_admin: false, is_sgc_member: true, is_site_medical_head: false, is_hr: false },
  hr: { profileId: PROFILE_ID, email: "hr@even.in", status: "active", is_super_admin: false, is_sgc_member: false, is_site_medical_head: false, is_hr: true },
  pending: { profileId: PROFILE_ID, email: "new@even.in", status: "pending", is_super_admin: true, is_sgc_member: true, is_site_medical_head: true, is_hr: false },
  /** A doctor's portal token presented as a staff cookie: it can carry no staff status or flags. */
  physicianToken: { kind: "physician", physicianId: "11111111-1111-4111-8111-111111111111", status: "active", is_super_admin: true },
};

export const HOSPITAL_A = "aaaa0000-0000-4000-8000-00000000000a";
export const HOSPITAL_B = "bbbb0000-0000-4000-8000-00000000000b";

/**
 * What the database would say about a session's role right now, taken from the session's own claims
 * (so a test that sets `h.user` gets the matching live row). A Site Medical Head heads HOSPITAL_A.
 * Used to mock `loadLiveStaff` in tests that are not about revocation.
 */
export function liveFromClaims(user: unknown) {
  const u = user as { status?: string; is_super_admin?: boolean; is_site_medical_head?: boolean; is_sgc_member?: boolean } | null;
  if (!u) return null;
  return {
    status: String(u.status ?? "active"),
    is_super_admin: u.is_super_admin === true,
    is_site_medical_head: u.is_site_medical_head === true,
    is_sgc_member: u.is_sgc_member === true,
    smh_hospital_ids: u.is_site_medical_head === true ? [HOSPITAL_A] : [],
  };
}

export const REF = "EHRC-AUD-2026-0042";

export function signalObject(over: Record<string, unknown> = {}) {
  return {
    reference: REF,
    signal_id: "33333333-3333-4333-8333-333333333333",
    doctor_uid: "D-100",
    signal_type: "drug_interaction",
    note_class: "opd",
    label: "Drug interaction",
    importance: "high",
    response_required: "explanation",
    status: "escalated",
    overdue: false,
    instances: 3,
    window: { from: "2026-09-01", to: "2026-09-30" },
    representative: {
      audit_id: "44444444-4444-4444-8444-444444444444",
      finding_ref: "F-1",
      subject: "Warfarin with ibuprofen",
      verdict: "unsafe",
      rationale: "Raises bleeding risk.",
      note_date: "2026-09-20",
      citations: [{ n: 1, title: "Warfarin label", url: "https://example.org/w" }],
    },
    routed_at: "2026-10-01T05:00:00.000Z",
    sla_due_at: "2026-10-08T05:00:00.000Z",
    response: { verb: "disagree", comment: "Dose adjusted and INR monitored weekly.", responded_at: "2026-10-03T06:00:00.000Z" },
    ruling: null,
    ...over,
  };
}

export const EVENTS = [
  { event: "routed", actor: "cm:asha", at: "2026-10-01T05:00:00.000Z", payload: { importance: "high", response_required: "explanation" } },
  { event: "responded", actor: "doctor:D-100", at: "2026-10-03T06:00:00.000Z", payload: { verb: "disagree", comment: "Dose adjusted and INR monitored weekly." } },
  { event: "escalated", actor: "doctor:D-100", at: "2026-10-03T06:00:01.000Z", payload: { reason: "doctor disagreed" } },
];

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
