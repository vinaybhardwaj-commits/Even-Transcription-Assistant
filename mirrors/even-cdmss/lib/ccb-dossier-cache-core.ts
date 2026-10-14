/**
 * lib/ccb-dossier-cache-core.ts — CCB v2 P1: member-snapshot cache, PURE half.
 *
 * Freshness arithmetic, the TTL env read, and the row→bundle mapper. No DB import, no network,
 * no env side-effects. Everything here is unit-tested; the wired half (ccb-dossier-cache.ts)
 * carries the Neon calls.
 */

import type { DossierBundle } from './ccb-dossier-core';

/** TTL when `CCB_SNAPSHOT_TTL_H` is unset or unusable. */
export const SNAPSHOT_TTL_H_DEFAULT = 24;

/**
 * Shape version of the cached `DossierBundle`.
 *
 * Bump this whenever the bundle gains fields that the UI depends on. A stored row whose
 * `_schemaVersion` does not match reads as a cache MISS, forcing a re-assemble on the first open —
 * so a shape change appears immediately after deploy instead of waiting out the 24h TTL.
 *
 * v1 (P1) rows carry no `_schemaVersion` at all, so they read as `undefined !== 2` → miss → re-enrich.
 *
 *   1 — P1: member + snapshot + timeline(opd|ipd|diagnostic|radiology) + latestEpisodeUid
 *   2 — v2 Build B: timeline gains order|surgery|hcu|event kinds and `docUrl`
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/**
 * Parse the TTL env. Anything non-finite, non-positive, or unparseable falls back to the default
 * rather than silently disabling the cache (TTL 0 would make every open a live assemble).
 */
export function snapshotTtlHours(raw: string | undefined = process.env.CCB_SNAPSHOT_TTL_H): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SNAPSHOT_TTL_H_DEFAULT;
}

/**
 * Fresh iff `nowMs - refreshedAtMs < maxAgeH * 3600_000`.
 *
 * A non-positive TTL means "never fresh" — the caller asked for no caching, and we honour it here
 * rather than treating it as unbounded. A refreshed_at in the future (clock skew) reads as age <= 0
 * and is therefore fresh; that is the safe direction (serve, then refresh on the next TTL lapse).
 */
export function isSnapshotFresh(refreshedAtMs: number, maxAgeH: number, nowMs: number): boolean {
  if (!Number.isFinite(refreshedAtMs) || !Number.isFinite(maxAgeH) || !Number.isFinite(nowMs)) return false;
  if (maxAgeH <= 0) return false;
  return nowMs - refreshedAtMs < maxAgeH * 3_600_000;
}

/** The shape `getMemberSnapshot` resolves to. */
export interface CachedSnapshot {
  bundle: DossierBundle;
  refreshedAt: number; // epoch ms
}

/** A row of `ccb_member_snapshot` as the Neon driver hands it back. */
export interface SnapshotRow {
  snapshot: unknown; // jsonb → object; a text column or a driver quirk → string
  refreshed_at: unknown; // timestamptz → Date | string
}

/**
 * Map one row to a CachedSnapshot. Returns null for a missing row, an unparseable snapshot, an
 * unreadable timestamp, or a bundle written under a different `_schemaVersion` — every one of which
 * the caller must treat as a cache MISS, never as a stale-but-servable hit.
 */
export function mapSnapshotRow(row: SnapshotRow | undefined | null): CachedSnapshot | null {
  if (!row) return null;

  let bundle: unknown = row.snapshot;
  if (typeof bundle === 'string') {
    try { bundle = JSON.parse(bundle); } catch { return null; }
  }
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;

  // Shape guard: a bundle from an older (or newer) build is not servable. Re-assemble instead.
  const version = (bundle as { _schemaVersion?: unknown })._schemaVersion;
  if (version !== SNAPSHOT_SCHEMA_VERSION) return null;

  const refreshedAt = toEpochMs(row.refreshed_at);
  if (refreshedAt === null) return null;

  return { bundle: bundle as DossierBundle, refreshedAt };
}

/** timestamptz arrives as a Date (pg type parsing) or an ISO string. Accept both; reject the rest. */
export function toEpochMs(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
