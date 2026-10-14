/**
 * src/lib/findings-actions.ts — WM2 v1: the two CDMSS write calls behind the Findings card.
 *
 * ⚠️ TWO ACTIONS THAT MUST NOT BE CONFUSED WITH EACH OTHER ───────────────────────────────────────
 *
 *   · a REACTION is private. It records what the doctor thought of a finding, notifies nobody, and
 *     never enters the governance workflow. Three verbs, no free text.
 *   · a RESPONSE is the workflow answer the thread asked for. It goes to the care manager, changes
 *     the signal's status, and cannot be revised in the portal once sent.
 *
 * Keeping them in one file is not a merge of the two ideas; it is so that the ONE rule they share
 * is written once: neither call takes an identity from the client. The caller passes the session's
 * physician id and the server-side `cdmss_doctor_uid` lookup, and nothing else identifies anybody.
 *
 * ⚠️ EVERY FAILURE IS A NAMED WORD, NOT A STATUS CODE. The mapping functions are pure and total:
 * any CDMSS answer, and any transport failure, becomes one of a closed set of strings the card
 * knows how to say out loud. The routes then always answer HTTP 200 — a doctor pressing a button
 * must be told what happened in words, and a 502 in a fetch is not words.
 *
 * `doctor-response` uses the P2 doctor-verb contract: agree, disagree, or needs_clarification.
 * The upstream owns the mapping from those verbs to its legacy type/verdict storage shape.
 *
 * Fetch idioms (x-api-key, GOV_API_BASE default, cache:'no-store', the 8s abort) match
 * src/lib/doctor-audits.ts.
 */

const BASE = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";
const TIMEOUT_MS = 8000;

/** The three reaction verbs, exact. There is no "other" and no free text: a private research
 *  record with an open text box is a second inbox nobody promised to read. */
export const REACTIONS = ["already_knew", "surprised", "dismiss"] as const;
export type Reaction = (typeof REACTIONS)[number];

export const RESPONSE_VERBS = ["agree", "disagree", "needs_clarification"] as const;
export type ResponseVerb = (typeof RESPONSE_VERBS)[number];

/** CDMSS caps an explanation at 4000 characters. The portal trims and truncates to the same cap so
 *  a long paste is shortened here rather than rejected there. */
export const COMMENT_MAX = 4000;

export function isReaction(v: unknown): v is Reaction {
  return typeof v === "string" && (REACTIONS as readonly string[]).includes(v);
}

export function isResponseVerb(v: unknown): v is ResponseVerb {
  return typeof v === "string" && (RESPONSE_VERBS as readonly string[]).includes(v);
}

/**
 * What came back from CDMSS, before it means anything. `transport` covers everything that is not
 * an HTTP answer — a timeout, a DNS failure, an unconfigured key, a body that will not parse as
 * JSON. Splitting the outcome from its interpretation is what lets the mapping below be pure and
 * table-tested without a network.
 */
export type CatOutcome =
  | { kind: "http"; status: number; body: unknown }
  | { kind: "transport" };

export type ReactResult =
  | { ok: true; replay: boolean; reaction: unknown }
  | { ok: false; error: "already_recorded" | "unavailable" };

export type RespondResult =
  | { ok: true; signal: unknown }
  | { ok: false; error: "already_responded" | "closed" | "invalid" | "unavailable"; message?: string };

/** PURE. Pull CDMSS's human-readable error out of a body, whichever key it used. "" when there is
 *  none — never a guess, and never the raw body, which could be an HTML error page. */
export function catErrorText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const o = body as Record<string, unknown>;
  if (typeof o.error === "string") return o.error;
  if (typeof o.message === "string") return o.message;
  return "";
}

/**
 * PURE. CDMSS's answer to a reaction → what the card is told.
 *
 * 409 is the only failure with its own word, because it is the only one that is not a fault: the
 * reaction is already recorded, so the card refetches and shows it. Everything else — a rejected
 * body, a uid mismatch, an unknown signal, a 500, a timeout — is `unavailable`, because from the
 * doctor's side they are the same event: it did not save, try again. Naming them apart would only
 * expose governance's internals on a physician's screen.
 */
export function mapReactOutcome(o: CatOutcome): ReactResult {
  if (o.kind === "transport") return { ok: false, error: "unavailable" };
  if (o.status === 200) {
    const b = (o.body ?? {}) as Record<string, unknown>;
    // A 200 that says ok:false is not in the contract. Treat it as an outage rather than as a
    // success, so an upstream change can never render as "Recorded" when nothing was recorded.
    if (b.ok === false) return { ok: false, error: "unavailable" };
    return { ok: true, replay: b.replay === true, reaction: b.reaction ?? null };
  }
  if (o.status === 409) return { ok: false, error: "already_recorded" };
  return { ok: false, error: "unavailable" };
}

/**
 * PURE. CDMSS's answer to a response → what the card is told.
 *
 * Two 409s mean different things to a doctor and must not be collapsed: one says somebody already
 * answered this thread, the other says the thread is over. A 400 is the one case where CDMSS's own
 * words are shown, because a 400 is about what was typed and only CDMSS knows which rule it broke.
 */
export function mapRespondOutcome(o: CatOutcome): RespondResult {
  if (o.kind === "transport") return { ok: false, error: "unavailable" };
  const text = catErrorText(o.body);
  if (o.status === 200) {
    const b = (o.body ?? {}) as Record<string, unknown>;
    if (b.ok === false) return { ok: false, error: "unavailable" };
    return { ok: true, signal: b.signal ?? null };
  }
  if (o.status === 409) {
    if (text.startsWith("already responded")) return { ok: false, error: "already_responded" };
    if (text.includes("closed")) return { ok: false, error: "closed" };
    return { ok: false, error: "unavailable" };
  }
  if (o.status === 400) return { ok: false, error: "invalid", message: text };
  return { ok: false, error: "unavailable" };
}

/** One POST to CDMSS, reduced to a CatOutcome. Never throws: a thrown fetch and a 500 are both
 *  things the card has to survive, so they are returned rather than raised. */
async function postToCat(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<CatOutcome> {
  const key = process.env.GOV_API_KEY;
  if (!key) return { kind: "transport" };
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    return { kind: "http", status: res.status, body };
  } catch {
    return { kind: "transport" };
  }
}

/**
 * Record a private reaction. `physicianId` is the session's, `doctorUid` is the server-side lookup;
 * the caller has no way to pass a client-supplied identity through this signature by accident,
 * because the only other argument is the verb.
 */
export async function callReaction(input: {
  signalId: string;
  physicianId: string;
  doctorUid: string;
  reaction: Reaction;
}): Promise<CatOutcome> {
  return postToCat("/api/governance/signal-reaction", {
    signal_id: input.signalId,
    physician_id: input.physicianId,
    cdmss_doctor_uid: input.doctorUid,
    reaction: input.reaction,
  });
}

/**
 * Send the workflow response using the P2 doctor verb. CDMSS derives the legacy type/verdict from
 * the signal's response_required field. The same request id is sent in the body and header.
 */
export async function callResponse(input: {
  signalId: string;
  doctorUid: string;
  verb: ResponseVerb;
  comment: string | null;
  clientRequestId: string;
}): Promise<CatOutcome> {
  return postToCat(
    "/api/governance/doctor-response",
    {
      signal_id: input.signalId,
      doctor_uid: input.doctorUid,
      verb: input.verb,
      comment: input.comment,
      client_request_id: input.clientRequestId,
    },
    { "Idempotency-Key": input.clientRequestId },
  );
}

/** PURE. Trim, then cut to the contract's cap. Empty becomes null so an untouched optional textarea
 *  sends nothing rather than an empty string. */
export function normalizeComment(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, COMMENT_MAX);
}

/**
 * PURE. The request body of POST /findings/react, or the reason it is refused.
 *
 * ⚠️ THIS IS WHERE THE IDENTITY RULE IS ENFORCED, not in a comment. `signal_id` and `reaction` are
 * the only two keys allowed, and a body carrying any third key is REFUSED rather than ignored.
 * Ignoring extra keys is how a client-supplied `doctor_uid` survives in a payload long enough for a
 * later edit to start reading it; refusing them means such a request never validates in the first
 * place. Whose reaction this is stays a server-side question.
 */
export type ReactBody =
  | { ok: true; signalId: string; reaction: Reaction }
  | { ok: false; message: string };

export function parseReactBody(raw: unknown): ReactBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "body must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const allowed: readonly string[] = ["signal_id", "reaction"];
  if (Object.keys(o).some((k) => !allowed.includes(k))) {
    return { ok: false, message: "unexpected field in body" };
  }
  const signalId = typeof o.signal_id === "string" ? o.signal_id.trim() : "";
  if (!signalId) return { ok: false, message: "signal_id is required" };
  if (!isReaction(o.reaction)) {
    return { ok: false, message: "reaction must be already_knew, surprised or dismiss" };
  }
  return { ok: true, signalId, reaction: o.reaction };
}

/**
 * PURE. The request body of POST /findings/respond, or the reason it is refused.
 *
 * Three fields are accepted and no identity a client puts in a body can travel any further. The
 * BFF creates the idempotency key; the browser can neither choose it nor name a doctor.
 */
export type RespondBody =
  | { ok: true; signalId: string; verb: ResponseVerb; comment: string | null }
  | { ok: false; message: string };

export function parseRespondBody(raw: unknown): RespondBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "body must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const allowed: readonly string[] = ["signal_id", "verb", "comment"];
  if (Object.keys(o).some((k) => !allowed.includes(k))) {
    return { ok: false, message: "unexpected field in body" };
  }
  const signalId = typeof o.signal_id === "string" ? o.signal_id.trim() : "";
  if (!signalId) return { ok: false, message: "signal_id is required" };
  if (!isResponseVerb(o.verb)) {
    return { ok: false, message: "verb must be agree, disagree or needs_clarification" };
  }
  const comment = normalizeComment(o.comment);
  if ((o.verb === "disagree" || o.verb === "needs_clarification") && !comment) {
    return { ok: false, message: `${o.verb} requires a comment` };
  }
  return {
    ok: true,
    signalId,
    verb: o.verb,
    comment,
  };
}
