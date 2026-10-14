/**
 * lib/ccb-extract-cache-core.ts — CCB v2 P1: per-document extract cache, PURE half.
 *
 * The cache key. We store the SHA-256 of the document URL rather than the URL itself: the URL is
 * an opaque GCS object id, and hashing it keeps even that out of the table (P1 kickoff, PHI note).
 *
 * The URL is the key EXACTLY as given — no trimming, no normalising, no case folding. Two URLs
 * that differ by a byte are two documents as far as this cache is concerned. That is deliberate:
 * a signed-URL query string or a different object path is a different object, and a false cache
 * hit would serve one document's extract for another.
 */

import { createHash } from 'node:crypto';
import type { ExtractedReport } from './ccb-brief-core';

export type { ExtractedReport };

/** Lowercase hex SHA-256 of the exact URL string. Deterministic; 64 hex chars. */
export function docSha(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex');
}
