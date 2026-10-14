import { NextResponse } from "next/server";

/**
 * Keys that must never reach a doctor-facing response (engine internals, scoring,
 * triage, care-manager notes, internal ids). Case-insensitive exact key match.
 * Doctors MAY see rationale, evidence, citations, subject, verdict, status.
 */
export const FORBIDDEN_DOCTOR_KEYS: readonly string[] = [
  "engine",
  "engine_version",
  "engineVersion",
  "jev",
  "jev_score",
  "confidence",
  "probability",
  "model",
  "served_model",
  "model_id",
  "policy",
  "policy_version",
  "bug_type",
  "validity",
  "importance",
  "triage",
  "triage_reason",
  "triage_rationale",
  "cm_note",
  "cm_user",
  "care_manager_note",
  "grader",
  "provenance",
  "cdmss_doctor_uid",
  "cdmss_alias_uids",
  "doctor_uid",
  "ruling_internal",
  "stamp_reason",
];

const FORBIDDEN_LOWER = new Set(FORBIDDEN_DOCTOR_KEYS.map((k) => k.toLowerCase()));

const isForbidden = (key: string): boolean => FORBIDDEN_LOWER.has(key.toLowerCase());

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep copy with every forbidden key removed. Never mutates the input. */
export function stripForbidden<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripForbidden(v)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isForbidden(k)) continue;
      out[k] = stripForbidden(v);
    }
    return out as T;
  }
  return value;
}

/** Key paths (never values) of every forbidden key present, e.g. `cards[0].jev_score`. */
export function findForbidden(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (isPlainObject(v)) {
      for (const [k, item] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (isForbidden(k)) found.push(p);
        else walk(item, p);
      }
    }
  };
  walk(value, "");
  return found;
}

/**
 * Guard for every JSON body leaving src/app/api/portal/**. Clean bodies are
 * serialised exactly as before; forbidden keys are stripped, and in production
 * their key paths (no values) are logged as `portal_forbidden_keys`.
 */
export function portalJson(body: unknown, init?: ResponseInit): NextResponse {
  const hits = findForbidden(body);
  if (hits.length === 0) return NextResponse.json(body, init);
  if (process.env.NODE_ENV === "production") console.error("portal_forbidden_keys", JSON.stringify({ keys: hits }));
  return NextResponse.json(stripForbidden(body), init);
}
