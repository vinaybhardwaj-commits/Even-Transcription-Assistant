import { sha256 } from "./util.js";

export type FilterReason = "phi_suspect" | "secret" | "secret_path" | "transcript";

export interface FilterOk {
  ok: true;
  sha256: string;
}
export interface FilterNo {
  ok: false;
  reason: FilterReason;
  /** Stable rule id. Never the matched text. */
  rule: string;
  sha256: string;
}
export type FilterResult = FilterOk | FilterNo;

/**
 * Rule ids are what a rejection reports. The matched substring stays out of
 * the result, the audit line, and the archive.
 *
 * The kiosk-repair note (room names like "OPD 5", clock times, ETA post 11533,
 * agent names) is three long sentences. A subject of eight or more words made
 * a fourth, and the old sentence net rejected that as phi_rejected with no id.
 * Operational prose is not a transcript. Clinical prose, speaker lines, and
 * long dumps still are. Identifiers below stay blocked.
 */
const SECRET_RULES: Array<{ id: string; re: RegExp }> = [
  { id: "secret.private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: "secret.aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "secret.github_token", re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: "secret.github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "secret.slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "secret.openai", re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { id: "secret.stripe", re: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/ },
  { id: "secret.assignment", re: /\b(?:api[_-]?key|secret|token|passwd|password|pwd)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{12,}/i },
  { id: "secret.bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}/ },
  { id: "secret.connection_uri", re: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s:]+:[^\s@]+@/i },
  { id: "secret.jwt", re: /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/ },
];

const PHI_RULES: Array<{ id: string; re: RegExp }> = [
  { id: "phi.uhid_mrn", re: /\b(?:uhid|mrn|patient[\s_-]*id|pid)\b\s*[#:=-]?\s*[A-Z0-9][A-Z0-9-]{3,}/i },
  { id: "phi.phone_in", re: /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}\b/ },
  { id: "phi.phone_us", re: /\b\d{3}[-.]\d{3}[-.]\d{4}\b/ },
  { id: "phi.aadhaar", re: /\b\d{4}\s\d{4}\s\d{4}\b/ },
  { id: "phi.email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  // 8+ standalone digits. Clock times (10:30) and short ids (OPD 5, post 11533) are shorter.
  { id: "phi.long_digit_run", re: /(?<![A-Za-z0-9])\d{8,}(?![A-Za-z0-9])/ },
];

const PATH_RULES: Array<{ id: string; test: (p: string) => boolean }> = [
  { id: "path.ssh", test: (p) => /(^|\/)\.ssh(\/|$)/i.test(p) },
  { id: "path.secrets", test: (p) => /(^|\/)secrets(\/|$)/i.test(p) },
  { id: "path.dot_secrets", test: (p) => /(^|\/)\.secrets(\/|$)/i.test(p) },
  { id: "path.token", test: (p) => /token/i.test(p) },
  { id: "path.pem", test: (p) => /\.pem$/i.test(p) },
  { id: "path.creds", test: (p) => /(^|\/)creds[^/]*\.json$/i.test(p) },
  { id: "path.minidisk_token", test: (p) => /minidisk\/token$/i.test(p) },
  { id: "path.neon", test: (p) => /neon database connection string/i.test(p) },
  { id: "path.llm_gateway", test: (p) => /llm-gateway\/secrets\//i.test(p) },
  { id: "path.box_secrets", test: (p) => /box-secrets\.json$/i.test(p) },
  { id: "path.env", test: (p) => /(^|\/)\.env($|\.)/i.test(p) },
  { id: "path.identity_key", test: (p) => /id_(?:rsa|ed25519|ecdsa|dsa)$/i.test(p) },
];

const CLINICAL = /\b(?:patient|patients|clinician|doctor|diagnosis|diagnosed|admitted|admission|prescription|prescribed|symptom|symptoms|medicine|medicines|complaint|dosage|tablet|fever)\b/i;

function firstRule(rules: Array<{ id: string; re: RegExp }>, text: string): string | null {
  for (const rule of rules) {
    if (rule.re.test(text)) return rule.id;
  }
  return null;
}

/** A personal name beside a clinical word. "Grok Bot" and "OPD 5" are not this. */
function patientNameRule(text: string): string | null {
  if (/\b(?:patient|pt\.?)\s+(?:name\s*[:=]\s*)?[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2}\b/.test(text)) {
    return "phi.patient_name";
  }
  const nameRe = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2}\b/g;
  for (const match of text.matchAll(nameRe)) {
    const at = match.index ?? 0;
    const window = text.slice(Math.max(0, at - 60), Math.min(text.length, at + match[0].length + 60));
    if (CLINICAL.test(window)) return "phi.patient_name";
  }
  return null;
}

function transcriptRule(text: string): string | null {
  if (/[\u0900-\u097F]{30,}/.test(text)) return "transcript.devanagari";
  const speakers = text.match(/(?:^|\n)\s*(?:doctor|patient|speaker|pt|dr)\s*:/gi);
  if (speakers && speakers.length >= 2) return "transcript.speakers";
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length >= 8);
  if (sentences.length >= 4 && CLINICAL.test(text)) return "transcript.clinical_prose";
  if (sentences.length >= 8) return "transcript.long_prose";
  return null;
}

function ruleForText(text: string): { reason: FilterReason; rule: string } | null {
  const secret = firstRule(SECRET_RULES, text);
  if (secret) return { reason: "secret", rule: secret };
  const phi = firstRule(PHI_RULES, text) || patientNameRule(text);
  if (phi) return { reason: "phi_suspect", rule: phi };
  const transcript = transcriptRule(text);
  if (transcript) return { reason: "transcript", rule: transcript };
  return null;
}

export function filterText(text: string): FilterResult {
  const digest = sha256(text);
  const hit = ruleForText(text);
  if (!hit) return { ok: true, sha256: digest };
  return { ok: false, reason: hit.reason, rule: hit.rule, sha256: digest };
}

/** Secret rules only: used when a message cannot leave the tailnet. PHI and transcript rules are skipped. */
export function filterSecretsOnly(text: string): FilterResult {
  const digest = sha256(text);
  const secret = firstRule(SECRET_RULES, text);
  if (secret) return { ok: false, reason: "secret", rule: secret, sha256: digest };
  return { ok: true, sha256: digest };
}

export function filterFieldsSecretsOnly(parts: Array<string | undefined | null>): FilterResult {
  return filterSecretsOnly(parts.filter((p): p is string => typeof p === "string").join("\n"));
}

export function filterPath(input: string): FilterResult {
  const digest = sha256(input);
  const p = input.replace(/\\/g, "/");
  const hit = PATH_RULES.find((rule) => rule.test(p));
  if (hit) return { ok: false, reason: "secret_path", rule: hit.id, sha256: digest };
  return { ok: true, sha256: digest };
}

export function looksLikeSecret(text: string): boolean {
  return firstRule(SECRET_RULES, text) !== null;
}

export function looksLikePhi(text: string): boolean {
  return firstRule(PHI_RULES, text) !== null || patientNameRule(text) !== null;
}

export function looksLikeTranscript(text: string): boolean {
  return transcriptRule(text) !== null;
}

export function filterFields(parts: Array<string | undefined | null>): FilterResult {
  const joined = parts.filter((p): p is string => typeof p === "string").join("\n");
  return filterText(joined);
}
