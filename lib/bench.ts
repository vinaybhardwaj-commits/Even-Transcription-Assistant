/**
 * lib/bench.ts — server-side helpers for the Room Bench (Room-Bench PRD v1.0).
 *
 * - id generators: 'room_' / 'bs_' / 'bc_' + 8-char nanoid (same alphabet as
 *   doctor ids)
 * - room slug builder: 'OPD 3' → 'opd-3-{4-char-token}' (token-suffixed like
 *   doctor slugs, via lib/doctor-slug's generateToken)
 * - admin guard (eta_admin_session) shared by the admin-gated bench routes
 * - bench_session lookup joined to room (used by upload-url / chunks / PATCH)
 * - CRC-32 + hand-rolled STORE-only (method 0) ZIP writer for the day
 *   download (D7 — no new npm deps; WebM is already compressed)
 *
 * SQL note (PRD §3.7): this sandbox has no live DB — every query below is
 * INFERRED against migration 0041 and fail-safe (errors degrade to null/
 * empty, never wrong data).
 */

import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt, type AdminClaims } from "@/lib/auth";
import { generateToken } from "@/lib/doctor-slug";

const benchId = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 8);

export function newRoomId(): string {
  return `room_${benchId()}`;
}
export function newSessionId(): string {
  return `bs_${benchId()}`;
}
export function newChunkId(): string {
  return `bc_${benchId()}`;
}

/** 'OPD 3' → base 'opd-3'; full slug 'opd-3-k4hz'. */
export function buildRoomSlug(name: string): { base: string; token: string; full: string } {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const token = generateToken(4);
  return { base, token, full: `${base}-${token}` };
}

/** Probe-proof pattern guard for /room/{slug} (mirrors parseDoctorSlug). */
export function isRoomSlugShaped(slug: string): boolean {
  return /^[a-z0-9-]+-[a-z2-9]{4}$/.test(slug);
}

/**
 * UTC calendar date (YYYY-MM-DD) of a timestamp — used for the R2 key's
 * date segment. UTC is the conservative, locale-free choice (the PRD does
 * not name a timezone; flagged in the build report).
 */
export function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export type AdminGuard =
  | { ok: true; claims: AdminClaims }
  | { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string };

export async function benchAdminGuard(): Promise<AdminGuard> {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    const claims = await verifyAdminJwt(cookie);
    return { ok: true, claims };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

// ---------------------------------------------------------------------------
// Shared lookups (INFERRED SQL — see build report)
// ---------------------------------------------------------------------------

export type BenchSessionRow = {
  id: string;
  room_id: string;
  label: string | null;
  mic_label: string | null;
  started_at: string | Date;
  ended_at: string | Date | null;
  status: "recording" | "paused" | "ended";
  notes: string | null;
  room_slug: string;
  room_name: string;
};

/** Session joined to its room; null on missing OR db error (fail-safe). */
export async function findBenchSession(sessionId: string): Promise<BenchSessionRow | null> {
  try {
    const rows = (await sql`
      SELECT s.id, s.room_id, s.label, s.mic_label, s.started_at, s.ended_at,
             s.status, s.notes, r.slug AS room_slug, r.name AS room_name
        FROM bench_session s
        JOIN room r ON r.id = s.room_id
       WHERE s.id = ${sessionId}
       LIMIT 1
    `) as BenchSessionRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export type BenchChunkRow = {
  id: string;
  idx: number;
  r2_key: string;
  content_type: string;
  started_at: string | Date;
  ended_at: string | Date;
  duration_ms: number;
  size_bytes: number | string | null;
  upload_state: string;
  gap_before_ms: number;
  created_at: string | Date;
};

/** All chunk rows for a session in idx order; [] on error (fail-safe). */
export async function listBenchChunks(sessionId: string): Promise<BenchChunkRow[]> {
  try {
    return (await sql`
      SELECT id, idx, r2_key, content_type, started_at, ended_at, duration_ms,
             size_bytes, upload_state, gap_before_ms, created_at
        FROM bench_chunk
       WHERE session_id = ${sessionId}
       ORDER BY idx
    `) as BenchChunkRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (standard polynomial 0xEDB88320) + STORE-only ZIP writer (D7)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  let c = seed;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return c >>> 0;
}

export function crc32Final(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

type ZipEntryMeta = {
  name: string;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
};

function dosDateTime(d: Date): { dosTime: number; dosDate: number } {
  // ZIP timestamps are local-ish two-second-resolution; UTC fields are fine
  // for an archive artifact.
  const year = Math.max(1980, d.getUTCFullYear());
  const dosDate = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { dosTime, dosDate };
}

function le16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function le32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * Incremental STORE-only zip builder. Entries are written one at a time
 * (each fully buffered — a 5-min opus chunk is ~5–15 MB); the caller
 * streams each returned Uint8Array out before the next entry is read.
 * No zip64: the caller must assert total size < 4 GB first (PRD §9.3 —
 * return 413 otherwise).
 */
export class StoreZipWriter {
  private entries: ZipEntryMeta[] = [];
  private offset = 0;

  /** Local file header + data for one entry. */
  entry(name: string, data: Uint8Array, mtime: Date): Uint8Array {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32Final(crc32(data));
    const { dosTime, dosDate } = dosDateTime(mtime);
    const header = new Uint8Array([
      ...le32(0x04034b50), // local file header signature
      ...le16(20),         // version needed to extract (2.0)
      ...le16(0x0800),     // general purpose flags: UTF-8 names
      ...le16(0),          // method 0 = STORE
      ...le16(dosTime),
      ...le16(dosDate),
      ...le32(crc),
      ...le32(data.length), // compressed size (= uncompressed for STORE)
      ...le32(data.length), // uncompressed size
      ...le16(nameBytes.length),
      ...le16(0),          // extra field length
      ...nameBytes,
    ]);
    this.entries.push({
      name,
      crc,
      size: data.length,
      offset: this.offset,
      dosTime,
      dosDate,
    });
    const out = new Uint8Array(header.length + data.length);
    out.set(header, 0);
    out.set(data, header.length);
    this.offset += out.length;
    return out;
  }

  /** Central directory + end-of-central-directory record. */
  finish(): Uint8Array {
    const parts: number[] = [];
    for (const e of this.entries) {
      const nameBytes = new TextEncoder().encode(e.name);
      parts.push(
        ...le32(0x02014b50), // central directory header signature
        ...le16(20),         // version made by
        ...le16(20),         // version needed
        ...le16(0x0800),     // flags: UTF-8
        ...le16(0),          // method STORE
        ...le16(e.dosTime),
        ...le16(e.dosDate),
        ...le32(e.crc),
        ...le32(e.size),
        ...le32(e.size),
        ...le16(nameBytes.length),
        ...le16(0),          // extra len
        ...le16(0),          // comment len
        ...le16(0),          // disk number
        ...le16(0),          // internal attrs
        ...le32(0),          // external attrs
        ...le32(e.offset),
        ...nameBytes,
      );
    }
    const cdSize = parts.length;
    const cdOffset = this.offset;
    parts.push(
      ...le32(0x06054b50), // EOCD signature
      ...le16(0),          // disk number
      ...le16(0),          // cd start disk
      ...le16(this.entries.length),
      ...le16(this.entries.length),
      ...le32(cdSize),
      ...le32(cdOffset),
      ...le16(0),          // comment length
    );
    return new Uint8Array(parts);
  }
}
