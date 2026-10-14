/**
 * src/lib/doctor-card.ts — the ONE shape a physician's browser ever receives for a finding.
 *
 * ⚠️ ALLOWLIST, FAIL CLOSED. Both finding pipes (the live CDMSS doctor-audits proxy and the
 * nightly document-audit rows) are turned into a {@link DoctorCard} by builders that read named
 * fields only, and every card then passes through {@link sanitizeCard}, which REBUILDS it from the
 * known keys with type checks. A field upstream adds tomorrow (triage, ruling, a score, a model id,
 * a uid) has no path to the browser because nothing copies it: there is no delete-list to forget to
 * extend. The tests feed hostile payloads through and assert the exact key set that comes out.
 *
 * What a card holds is clinical context plus evidence and nothing else: no reference numbers, no
 * note or signal identifiers (the opaque `id` exists only so the browser can POST a response and is
 * never rendered), no triage text, no author, no engine vocabulary. Free text from upstream is
 * scrubbed of identifiers and of sentences that use pipeline wording before it is allowed through.
 *
 * Contract fields from CDMSS (`routed`, `note_class`, `note_date`, `evidence_excerpt`, `citations`,
 * `patient`) are all OPTIONAL here: absent means nothing is rendered, and today's payload (without
 * them) still produces a valid card. `routed === false` on a finding drops the card entirely.
 */

import {
  askOf,
  cardNoteClass,
  cardVerb,
  docTypeNoteLabel,
  fmtLongDate,
  findingTitle,
  GENERIC_FINDING_TITLE,
  hasInternalWording,
  noteTypeLabel,
  type CardAsk,
  type CardVerb,
} from "@/lib/finding-labels";
import {
  findingsCardPdfHref,
  hasAttachedInstances,
  isAuditUuid,
  localCardPdfHref,
  portalFindingsPdfHref,
} from "@/lib/findings-pdf";
import { portalPdfStatus, portalResponseOwner } from "@/lib/document-audits";

export type CardSource = "live" | "document";

export interface CardCitation {
  title: string;
  url: string | null;
}

export interface CardPatient {
  name: string | null;
  age: string | null;
  sex: string | null;
  ip_number: string | null;
  uhid: string | null;
}

export interface CardResponse {
  verb: CardVerb;
  comment: string | null;
  at: string | null;
}

export interface DoctorCard {
  /** Opaque handle used only to POST a response or reaction. Never rendered. */
  id: string;
  source: CardSource;
  title: string;
  note_type: string | null;
  note_date: string | null;
  patient: CardPatient | null;
  subject: string;
  why_it_matters: string | null;
  excerpt: string | null;
  citations: CardCitation[];
  ask: CardAsk | null;
  can_respond: boolean;
  response: CardResponse | null;
  view_note_href: string | null;
  /** "Seen in 4 notes" when the finding recurs; plain words, never a raw count. */
  seen_in: string | null;
  /** The doctor's own private reaction value, if any (live cards only). */
  reaction: string | null;
  can_react: boolean;
}

/** The exact key set of a card. The tests pin this list. */
export const CARD_KEYS = [
  "id",
  "source",
  "title",
  "note_type",
  "note_date",
  "patient",
  "subject",
  "why_it_matters",
  "excerpt",
  "citations",
  "ask",
  "can_respond",
  "response",
  "view_note_href",
  "seen_in",
  "reaction",
  "can_react",
] as const;

export const EXCERPT_MAX = 600;
const TEXT_MAX = 1200;
const CITATIONS_MAX = 12;

// ────────────────────────────── small readers ──────────────────────────────

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, max = TEXT_MAX): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// ────────────────────────────── scrubbing ──────────────────────────────

const ID_PATTERNS: readonly RegExp[] = [
  // Any hospital prefix: EHRC-AUD-2026-0042, EHBR-AUD-..., and so on.
  /(?:\b(?:see|ref\.?|reference)\s*:?\s*)?\b[A-Z]{2,6}-AUD-\d{4}-\d+\b/gi,
  /\b(?:ot|ds|progress|synth|opd):[\w:.-]{3,}/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

/** Remove reference numbers and internal ids. Leaves everything else untouched (used for evidence). */
export function stripIds(text: string): string {
  let t = text;
  for (const re of ID_PATTERNS) t = t.replace(re, "");
  return t
    .replace(/\(\s*(?:see|ref\.?|reference)?\s*\)/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([.!?])(?:\s*\.)+/g, "$1") // a removed id at the end of a sentence leaves ". ."
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

/**
 * PURE. Free text from upstream → text safe to show: ids stripped, and any sentence that uses
 * pipeline wording dropped whole (a half-sentence is worse than none). Null when nothing is left.
 */
export function scrubText(text: unknown, max = TEXT_MAX): string | null {
  const raw = str(text, max * 2);
  if (!raw) return null;
  const sentences = stripIds(raw)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z0-9]/.test(s) && !hasInternalWording(s));
  const out = sentences.join(" ").trim();
  return out ? out.slice(0, max) : null;
}

// ────────────────────────────── field parsers ──────────────────────────────

function httpUrl(v: unknown): string | null {
  const u = str(v, 2000);
  return u && /^https?:\/\//i.test(u) ? u : null;
}

/** Citations from either contract: `{n,title,url}` today, `{title,url|null}` next. */
export function readCitations(raw: unknown): CardCitation[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CardCitation[] = [];
  for (const c of raw) {
    const o = rec(c);
    if (!o) continue;
    const title = scrubText(o.title, 300);
    if (!title) continue;
    const url = httpUrl(o.url);
    const key = `${title}|${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url });
    if (out.length >= CITATIONS_MAX) break;
  }
  return out;
}

function sexLabel(v: unknown): string | null {
  const s = str(v, 12);
  if (!s) return null;
  const l = s.toLowerCase();
  if (l === "m" || l === "male") return "M";
  if (l === "f" || l === "female") return "F";
  return s;
}

export function readPatient(raw: unknown): CardPatient | null {
  const o = rec(raw);
  if (!o) return null;
  const p: CardPatient = {
    name: str(o.name, 120),
    age: str(o.age, 12),
    sex: sexLabel(o.sex),
    ip_number: str(o.ip_number, 40),
    uhid: str(o.uhid, 40),
  };
  return Object.values(p).some((v) => v !== null) ? p : null;
}

function readResponse(raw: unknown, fallbackAt: string | null = null): CardResponse | null {
  const o = rec(raw);
  if (!o) return null;
  const verbRaw = str(o.verb) ?? str(o.verdict);
  // The doctor's own words are theirs: ids stripped, but no sentence is dropped from them.
  const c = str(o.comment, 1000);
  const comment = c ? stripIds(c) || null : null;
  if (!verbRaw && !comment) return null;
  const at = str(o.at) ?? str(o.responded_at) ?? str(o.created_at) ?? fallbackAt;
  return { verb: cardVerb(verbRaw), comment, at };
}

/** First non-empty value of `key` on the first record that has it. */
function pick(key: string, ...sources: Array<Record<string, unknown> | null>): unknown {
  for (const s of sources) {
    if (s && s[key] !== undefined && s[key] !== null) return s[key];
  }
  return undefined;
}

// ────────────────────────────── sanitize (the allowlist) ──────────────────────────────

/**
 * Rebuild a card from known keys only. Anything that is not on the allowlist, or has the wrong type,
 * is dropped; a card with no usable `id` or `source` is refused (null). Idempotent.
 */
export function sanitizeCard(raw: unknown): DoctorCard | null {
  const o = rec(raw);
  if (!o) return null;
  const id = str(o.id, 200);
  if (!id) return null;
  if (o.source !== "live" && o.source !== "document") return null;

  const titleScrubbed = scrubText(o.title, 120);
  const title = titleScrubbed && !hasInternalWording(titleScrubbed) ? titleScrubbed : GENERIC_FINDING_TITLE;

  const p = readPatient(o.patient);
  const resp = rec(o.response);
  const response: CardResponse | null = resp
    ? {
        verb: cardVerb(resp.verb),
        comment: str(resp.comment, 1000),
        at: str(resp.at, 40),
      }
    : null;
  const noteDate = str(o.note_date, 10);
  const excerpt = str(o.excerpt, EXCERPT_MAX * 2);
  const href = str(o.view_note_href, 300);
  const seenIn = str(o.seen_in, 40);

  return {
    id,
    source: o.source,
    title,
    note_type: str(o.note_type, 40),
    note_date: noteDate && /^\d{4}-\d{2}-\d{2}$/.test(noteDate) ? noteDate : null,
    patient: p,
    subject: scrubText(o.subject, 600) ?? "",
    why_it_matters: scrubText(o.why_it_matters, 1500),
    excerpt: excerpt ? stripIds(excerpt).slice(0, EXCERPT_MAX) || null : null,
    citations: readCitations(o.citations),
    ask: o.ask === "acknowledge" || o.ask === "explain" ? o.ask : null,
    can_respond: o.can_respond === true,
    response,
    // Only same-origin portal proxy hrefs are ever allowed through; never a CDMSS host.
    view_note_href: href && href.startsWith("/api/portal/findings/pdf?ref=") ? href : null,
    seen_in: seenIn && /^Seen in \d{1,4} notes$/.test(seenIn) ? seenIn : null,
    reaction: str(o.reaction, 40),
    can_react: o.can_react === true,
  };
}

// ────────────────────────────── live pipe (CDMSS doctor-audits) ──────────────────────────────

export interface LiveReaction {
  reaction: string;
}

/** The finding this card describes: the signal's `representative`. `instances` is only a count. */
function representativeOf(s: Record<string, unknown>): Record<string, unknown> | null {
  return rec(s.representative);
}

/** PURE. "Seen in 4 notes" only when the finding recurs (more than one); otherwise null. */
export function seenInText(count: unknown): string | null {
  const n = typeof count === "number" ? Math.floor(count) : NaN;
  return Number.isFinite(n) && n > 1 ? `Seen in ${n} notes` : null;
}

/**
 * One upstream signal → a card, or null when it must not be shown (not routed, malformed).
 * Reads named fields only. `triage`, `ruling`, `reference`, `doctor_uid`, `overdue`, `sla_due_at`,
 * metrics and confidence never enter: they are not read.
 */
export function toLiveCard(raw: unknown, reaction: LiveReaction | null = null): DoctorCard | null {
  const s = rec(raw);
  if (!s) return null;
  const id = str(s.signal_id, 200);
  if (!id) return null;
  const rep = representativeOf(s);
  // Per-finding visibility: a finding marked not routed is never shown, on either level.
  if (s.routed === false || rep?.routed === false) return null;

  const count = typeof s.instances === "number" ? s.instances : 0;
  const attached = hasAttachedInstances(count);
  const ask = askOf(s.response_required);
  const response = readResponse(s.response);
  const status = str(s.status);

  const noteClass = cardNoteClass(pick("note_class", rep, s)) ?? "opd";
  const subject = rep ? scrubText(rep.subject, 600) : null;
  // The CDMSS file endpoint has no OPD audits, so an OPD card offers no "View note".
  const view =
    noteClass === "opd"
      ? null
      : findingsCardPdfHref({
          instances: count,
          representative: { audit_id: rep ? str(rep.audit_id, 80) : null },
          pdf_url: str(s.pdf_url, 600) ?? (rep ? str(rep.pdf_url, 600) : null),
        });

  return sanitizeCard({
    id,
    source: "live",
    title: findingTitle(s.signal_type, s.label),
    note_type: noteTypeLabel(noteClass),
    note_date: str(pick("note_date", rep, s), 10),
    patient: readPatient(pick("patient", rep, s)),
    subject: subject ?? "",
    why_it_matters: rep ? scrubText(rep.rationale, 1500) : null,
    excerpt: str(pick("evidence_excerpt", rep, s), EXCERPT_MAX * 2),
    citations: readCitations(pick("citations", rep, s)),
    ask,
    can_respond: ask !== null && status === "routed" && attached && response === null,
    response,
    view_note_href: view,
    seen_in: seenInText(count),
    reaction: reaction?.reaction ?? null,
    can_react: true,
  });
}

/** What a response write may hand back to the browser: the new state of one finding, nothing else. */
export interface ResponseState {
  status: string | null;
  response: CardResponse | null;
}

/**
 * PURE. CDMSS's answer to a doctor-response/signal-reaction write → the only fields the browser may
 * receive: `status` (a short lowercase word) and the recorded response (verb, comment, time). The
 * body can carry governance fields, a null representative or anything else; none of it is read, so
 * none of it can be forwarded. The browser merges this into the card it already has.
 */
export function toResponseState(signal: unknown): ResponseState {
  const s = rec(signal);
  const status = str(s?.status, 24);
  return {
    status: status && /^[a-z_]{1,24}$/.test(status) ? status : null,
    response: readResponse(s?.response),
  };
}

/** The portal's reaction map shape, structurally (kept here so this module has no dependency cycle). */
export type CardReactionMap = Record<string, { reaction: string } | undefined>;

export interface CardsPayload {
  ok: true;
  mapped: true;
  cards: DoctorCard[];
}

/** PURE. Upstream doctor-audits payload → the cards a doctor may see. Tolerates a malformed body. */
export function toLiveCardsPayload(upstream: unknown, reactions?: CardReactionMap | null): CardsPayload {
  const root = rec(upstream);
  const signals = Array.isArray(root?.signals) ? (root!.signals as unknown[]) : [];
  const cards: DoctorCard[] = [];
  for (const s of signals) {
    const sid = str(rec(s)?.signal_id, 200);
    const card = toLiveCard(s, sid ? (reactions?.[sid] ?? null) : null);
    if (card) cards.push(card);
  }
  return { ok: true, mapped: true, cards };
}

// ────────────────────────────── document pipe (nightly ingest rows) ──────────────────────────────

/** The row shape loadPortalRoutedFindings returns (structural, so this module stays DB-free). */
export interface DocumentFindingRow {
  finding_id: string;
  finding_label: string;
  finding_body: string | null;
  status: string;
  doc_type: string;
  cdmss_pdf_url: string | null;
  source_audit_id: string | null;
  doctor_response_verb: string | null;
  doctor_response_comment: string | null;
  doctor_responded_at: string | null;
  response_owner: string | null;
  signal_reference: string | null;
  signal_type: string | null;
  /** CDMSS marked this finding routed. Absent/null on rows from before the field existed. */
  cdmss_routed?: boolean | null;
  note_class: string | null;
  note_date: string | null;
  evidence_excerpt: string | null;
  citations_json: unknown;
  patient_json: unknown;
}

/**
 * One stored finding → a card, or null when it is already on the live list (answering it there
 * avoids asking the doctor twice) or is malformed. Authors, references and statuses are not read.
 */
export function toDocumentCard(row: DocumentFindingRow): DoctorCard | null {
  if (!row || typeof row.finding_id !== "string") return null;
  if (portalResponseOwner(row.response_owner, row.signal_reference) === "pipe_a") return null;

  const response = readResponse(
    row.doctor_response_verb || row.doctor_response_comment
      ? {
          verb: row.doctor_response_verb,
          comment: row.doctor_response_comment,
          at: row.doctor_responded_at,
        }
      : null,
  );
  const closed = row.status === "remediated" || row.status === "escalated";
  const noteLabel = noteTypeLabel(cardNoteClass(row.note_class)) ?? docTypeNoteLabel(row.doc_type);

  const stored = portalPdfStatus(row.cdmss_pdf_url).pdf_url;
  let view = localCardPdfHref(stored, stored ? "available" : "unavailable");
  if (!view && isAuditUuid(row.source_audit_id)) view = portalFindingsPdfHref(row.source_audit_id);
  // Local rows only ever offer the portal proxy; a blob/CDN URL is not a doctor-session route.
  if (view && !view.startsWith("/api/portal/findings/pdf?ref=")) view = null;
  // The file holds only findings CDMSS routed. A finding made visible some other way (an RMO
  // release) would open an empty file, so no link is offered unless CDMSS marked it routed.
  if (row.cdmss_routed !== true) view = null;
  // No file exists for OPD audits upstream, so none is offered.
  if (cardNoteClass(row.note_class) === "opd" || cardNoteClass(row.doc_type) === "opd") view = null;

  const canRespond = response === null && !closed;
  return sanitizeCard({
    id: row.finding_id,
    source: "document",
    title: findingTitle(row.signal_type, null),
    note_type: noteLabel,
    note_date: str(row.note_date, 10),
    patient: readPatient(row.patient_json),
    subject: row.finding_label,
    why_it_matters: row.finding_body,
    excerpt: row.evidence_excerpt,
    citations: readCitations(row.citations_json),
    ask: canRespond ? "acknowledge" : null,
    can_respond: canRespond,
    response,
    view_note_href: view,
    seen_in: null,
    reaction: null,
    can_react: false,
  });
}

export function toDocumentCards(rows: readonly DocumentFindingRow[]): DoctorCard[] {
  const out: DoctorCard[] = [];
  for (const r of rows) {
    const c = toDocumentCard(r);
    if (c) out.push(c);
  }
  return out;
}

// ────────────────────────────── text rendering ──────────────────────────────

/** PURE. "Ramesh Kumar, 54/M" — name plus age/sex, whichever parts exist. */
export function patientLine(p: CardPatient | null): string {
  if (!p) return "";
  const ageSex = [p.age, p.sex].filter(Boolean).join("/");
  return [p.name, ageSex].filter(Boolean).join(", ");
}

/** PURE. "IP 4821" when an IP number exists, else "UHID X", else "". */
export function identifierLine(p: CardPatient | null): string {
  if (!p) return "";
  if (p.ip_number) return `IP ${p.ip_number}`;
  if (p.uhid) return `UHID ${p.uhid}`;
  return "";
}

/** PURE. The context line: note type · note date · patient · IP or UHID, skipping what is absent. */
export function contextLine(c: DoctorCard): string {
  return [c.note_type, fmtLongDate(c.note_date), patientLine(c.patient), identifierLine(c.patient)]
    .filter((x) => x)
    .join(" · ");
}
