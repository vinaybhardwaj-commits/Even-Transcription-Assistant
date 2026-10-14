import { createHash } from "node:crypto";
import type { EnvSource } from "./access";

const NAME_MAX = 120;
const REASON_MAX = 200;
const UA_MAX = 512;

function readRaw(env: EnvSource, name: string): string {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** Prefer a dedicated salt. Fall back to the session secret so hashes are not bare SHA-256(ip). */
export function captureIpSalt(env: EnvSource = process.env): string {
  return readRaw(env, "CAPTURE_IP_HASH_SALT") || readRaw(env, "JWT_SECRET") || "ot-capture-stage1";
}

export function clientIpFromHeaders(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim() ?? "";
  return real || null;
}

/** Hex SHA-256. The raw IP is an input only and must not be stored. */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`ot-capture-ip|${salt}|${ip.trim()}`).digest("hex");
}

export function ipHashPrefix(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const clean = hash.trim().toLowerCase();
  if (!/^[0-9a-f]{8,}$/.test(clean)) return null;
  return clean.slice(0, 8);
}

export function sanitizeFreeText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

export function sanitizeUploaderName(raw: unknown): string | null {
  return sanitizeFreeText(raw, NAME_MAX);
}

export function sanitizeVoidReason(raw: unknown): string | null {
  return sanitizeFreeText(raw, REASON_MAX);
}

export function truncateUserAgent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, UA_MAX);
}
