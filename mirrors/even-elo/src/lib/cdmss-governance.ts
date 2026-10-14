/**
 * src/lib/cdmss-governance.ts — server-side calls to the CDMSS governance endpoints (Round 2 / F3).
 *
 *   GET  /api/governance/roster-audits        the worklist and a physician's profile section
 *   GET  /api/governance/audit-signal/{ref}   one thread: signal, instances, immutable event log
 *   POST /api/governance/signal-action        a governance ruling (guarded, idempotent upstream)
 *   POST /api/governance/doctor-response      a doctor's answer, forwarded from a document audit
 *
 * Every call carries GOV_API_KEY (x-api-key), stays on the server, and returns a `CatOutcome` (an HTTP
 * answer or `transport`) instead of throwing, so callers map outcomes to words in one place. Env is
 * read per call, not at import, so tests and rotated keys behave.
 */

import type { CatOutcome } from "@/lib/findings-actions";

export type { CatOutcome };

function base(): string {
  return (process.env.GOV_API_BASE || "https://even-cdmss.vercel.app").replace(/\/+$/, "");
}

async function request(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CatOutcome> {
  const key = process.env.GOV_API_KEY;
  if (!key) return { kind: "transport" };
  try {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        "x-api-key": key,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    const body = await res.json().catch(() => null);
    return { kind: "http", status: res.status, body };
  } catch {
    return { kind: "transport" };
  }
}

/** The CDMSS audit reference format (EHRC-AUD-2026-0042). Hospital prefixes other than EHRC are accepted. */
export const AUDIT_REF_RE = /^[A-Z]{2,6}-AUD-\d{4}-\d{3,}$/;

export function isAuditReference(v: unknown): v is string {
  return typeof v === "string" && AUDIT_REF_RE.test(v);
}

/** Governance-wide thread list, or one doctor's with `doctorUid`. Filters are applied locally. */
export function fetchRosterAudits(opts: { doctorUid?: string; window?: number } = {}): Promise<CatOutcome> {
  const qs = new URLSearchParams();
  if (opts.doctorUid) qs.set("doctor_uid", opts.doctorUid);
  qs.set("window", String(opts.window ?? 30));
  return request("GET", `/api/governance/roster-audits?${qs.toString()}`);
}

export function fetchAuditSignal(reference: string): Promise<CatOutcome> {
  return request("GET", `/api/governance/audit-signal/${encodeURIComponent(reference)}`);
}

export function postSignalAction(input: {
  reference: string;
  action: string;
  note: string;
  actor: string;
  govInterventionRef: string;
  timeoutMs?: number;
}): Promise<CatOutcome> {
  return request("POST", "/api/governance/signal-action", {
    timeoutMs: input.timeoutMs,
    body: {
      reference: input.reference,
      action: input.action,
      note: input.note,
      actor: input.actor,
      gov_intervention_ref: input.govInterventionRef,
    },
  });
}

/** A doctor's response, forwarded. `clientRequestId` is stable per finding so a retry is a replay upstream. */
export function postDoctorResponse(input: {
  reference: string;
  doctorUid: string | null;
  verb: string;
  comment: string | null;
  clientRequestId: string;
  timeoutMs?: number;
}): Promise<CatOutcome> {
  return request("POST", "/api/governance/doctor-response", {
    body: {
      reference: input.reference,
      ...(input.doctorUid ? { doctor_uid: input.doctorUid } : {}),
      verb: input.verb,
      comment: input.comment,
      client_request_id: input.clientRequestId,
    },
    headers: { "Idempotency-Key": input.clientRequestId },
    timeoutMs: input.timeoutMs,
  });
}

/** Pull CDMSS's own error text out of a body ("" when none). Governance staff may see it. */
export function upstreamError(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const o = body as Record<string, unknown>;
  if (typeof o.error === "string") return o.error;
  if (typeof o.message === "string") return o.message;
  return "";
}
