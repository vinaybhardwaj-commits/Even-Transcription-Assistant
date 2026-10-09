export class JevGuardError extends Error {
  /** Refusal reason codes: "byte_cap", or the matched secret-pattern names. Content-free. */
  readonly code: string[];

  constructor(message: string, code: string[] = []) {
    super(message);
    this.name = "JevGuardError";
    this.code = code;
  }
}

export function assertWithinByteCap(payload: unknown, cap: number): void {
  const measured = Buffer.byteLength(JSON.stringify(payload) ?? "");
  if (measured > cap) {
    throw new JevGuardError(
      `Input exceeds the allowed size: cap is ${cap} bytes, measured ${measured} bytes.`,
      ["byte_cap"]
    );
  }
}

type SecretPattern = {
  name: string;
  pattern: RegExp;
};

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "openai_style_key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: "aws_access_key_id", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "github_personal_token", pattern: /ghp_[A-Za-z0-9]{30,}/ },
  { name: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "postgres_connection_string", pattern: /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/ },
  { name: "env_style_secret_assignment", pattern: /^\s*[A-Z_]{3,}(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*\S{8,}$/m },
  { name: "bearer_token", pattern: /Bearer [A-Za-z0-9._-]{20,}/ }
];

export function screenForSecrets(text: string): string[] {
  const matches: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      matches.push(name);
    }
  }
  return matches;
}

export function assertNoSecrets(texts: Array<string | undefined>, allowSecrets: boolean): void {
  if (allowSecrets) return;
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const name of screenForSecrets(text)) {
      found.add(name);
    }
  }
  if (found.size > 0) {
    const patterns = Array.from(found).sort();
    throw new JevGuardError(
      `Input appears to contain secret-like content (${patterns.join(", ")}). Remove it before calling Jev, or set JEV_ALLOW_SECRETS to override.`,
      patterns
    );
  }
}

function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStringLeaves(item, out);
  }
  return out;
}

/**
 * Runs both guards over the exact outbound request body once, so nothing in
 * state, model, or questions (instructions, criteria, files[].path/content,
 * etc.) can bypass the checks. Fails closed: throws JevGuardError, never
 * truncates the body.
 *
 * Secrets are screened two ways: over the serialized body (catches patterns
 * that span multiple adjacent fields) and over every individual string leaf
 * (catches multiline patterns such as env-style assignments, whose real
 * newlines are escaped to literal "\n" once JSON-serialized and so would
 * never match a `^...$`/m pattern in the serialized form).
 */
export function assertRequestIsSafe(body: unknown, cap: number, allowSecrets: boolean): void {
  assertWithinByteCap(body, cap);
  assertNoSecrets([JSON.stringify(body), ...collectStringLeaves(body)], allowSecrets);
}
