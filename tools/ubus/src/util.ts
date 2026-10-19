import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let t = now;
  const chars: string[] = new Array(26);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCK[t % 32]!;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) chars[10 + i] = CROCK[bytes[i]! & 31]!;
  return chars.join("");
}

export function id(prefix: string, now?: number): string {
  return `${prefix}${ulid(now)}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256Buf(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    out[key] = sortValue(obj[key]);
  }
  return out;
}

export function chainHash(prev: string, payload: unknown): string {
  return sha256(prev + "\n" + canonical(payload));
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function bytesLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function istStamp(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} IST`;
}

export interface Clock {
  now(): number;
  iso(): string;
  advance(ms: number): void;
}

export class ManualClock implements Clock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  iso(): string {
    return new Date().toISOString();
  }
  advance(): void {
    throw new Error("cannot advance the system clock");
  }
}

export function utcParts(ms: number): { y: string; m: string; d: string; h: string } {
  const dt = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return {
    y: p(dt.getUTCFullYear(), 4),
    m: p(dt.getUTCMonth() + 1),
    d: p(dt.getUTCDate()),
    h: p(dt.getUTCHours()),
  };
}

/** Compare dotted numeric versions. Missing or non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
