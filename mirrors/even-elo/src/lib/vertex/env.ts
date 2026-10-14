// Sprint 3.1 — Vertex env contract. Pure parsing only.
// Credential material stays in the returned credentials object for the
// server-only client. Public status never includes the service-account
// email or private key. Do not log either value.

export const VERTEX_ENV = {
  project: "GOOGLE_VERTEX_PROJECT",
  location: "GOOGLE_VERTEX_LOCATION",
  model: "GOOGLE_VERTEX_MODEL",
  clientEmail: "VERTEX_CLIENT_EMAIL",
  privateKey: "VERTEX_PRIVATE_KEY",
  featureFlag: "FEATURE_VERTEX_SUMMARIES",
} as const;

export const VERTEX_REQUIRED_ENV = [
  VERTEX_ENV.project,
  VERTEX_ENV.location,
  VERTEX_ENV.model,
  VERTEX_ENV.clientEmail,
  VERTEX_ENV.privateKey,
] as const;

export type EnvSource = Record<string, string | undefined>;

export interface VertexCredentials {
  project: string;
  location: string;
  model: string;
  clientEmail: string;
  privateKey: string;
}

export interface VertexPublicConfig {
  configured: boolean;
  featureEnabled: boolean;
  project: string | null;
  location: string | null;
  model: string | null;
  missing: string[];
}

export interface VertexConfigResult {
  publicConfig: VertexPublicConfig;
  credentials: VertexCredentials | null;
}

function readRaw(env: EnvSource, name: string): string {
  const raw = env[name];
  return typeof raw === "string" ? raw : "";
}

/**
 * Staff summaries stay off unless FEATURE_VERTEX_SUMMARIES is exactly "true"
 * (surrounding whitespace ignored). "false", "1", "TRUE", and unset are off.
 */
export function isVertexSummariesEnabled(env: EnvSource): boolean {
  return readRaw(env, VERTEX_ENV.featureFlag).trim() === "true";
}

/**
 * Vercel may store a PEM with real newlines, with escaped `\n`, or wrapped
 * in quotes. Google Auth needs a real PEM.
 */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim().replace(/^\uFEFF/, "");
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

export function parseVertexConfig(env: EnvSource): VertexConfigResult {
  const featureEnabled = isVertexSummariesEnabled(env);
  const project = readRaw(env, VERTEX_ENV.project).trim();
  const location = readRaw(env, VERTEX_ENV.location).trim();
  const model = readRaw(env, VERTEX_ENV.model).trim();
  const clientEmail = readRaw(env, VERTEX_ENV.clientEmail).trim();
  const privateKey = normalizePrivateKey(readRaw(env, VERTEX_ENV.privateKey));

  const missing: string[] = [];
  if (!project) missing.push(VERTEX_ENV.project);
  if (!location) missing.push(VERTEX_ENV.location);
  if (!model) missing.push(VERTEX_ENV.model);
  if (!clientEmail) missing.push(VERTEX_ENV.clientEmail);
  if (!privateKey) missing.push(VERTEX_ENV.privateKey);

  const configured = missing.length === 0;
  return {
    publicConfig: {
      configured,
      featureEnabled,
      project: project || null,
      location: location || null,
      model: model || null,
      missing,
    },
    credentials: configured
      ? { project, location, model, clientEmail, privateKey }
      : null,
  };
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /Bearer\s+\S+/gi;
const PRIVATE_KEY_ASSIGN = /private[_-]?key\s*[:=]\s*\S+/gi;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

/** Error text safe to return to a super-admin. Drops key material, emails, and bearer tokens. */
export function safeVertexErrorMessage(err: unknown): string {
  let raw = "";
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    raw = err.message;
  }
  const cleaned = raw
    .replace(PEM_BLOCK, "[redacted]")
    .replace(PRIVATE_KEY_ASSIGN, "private_key=[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(EMAIL, "[redacted-email]")
    .replace(LONG_TOKEN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  return cleaned || "Vertex request failed";
}
