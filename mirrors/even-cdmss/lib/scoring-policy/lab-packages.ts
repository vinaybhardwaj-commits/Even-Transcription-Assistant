/**
 * lib/scoring-policy/lab-packages.ts — reading the ACTIVE lab-package set.
 *
 * Two sources, in order:
 *   1. `scoring_policy_versions` with note_type='lab_packages' — the published, versioned set that
 *      the CSV round-trip maintains. Reuses the Phase A tables wholesale (§7.3: "no third table, no
 *      schema divergence").
 *   2. `data/lab-packages.json` — the generated file the engine reads, and the fallback before
 *      anything has been published.
 *
 * ⚠️ THE VERSIONING SHAPE DIVERGES BY NOTE TYPE (§12.3, and it is intentional):
 *   · discharge_summary / opd_rx → `weights` is an OBJECT of {fieldKey: tier}
 *   · lab_packages               → `weights` is an ARRAY of package objects
 * Every reader must branch on note_type and must never assume the object shape.
 * `parseStoredLabPackages` is the array branch; `toVector` in ./store.ts is the object branch.
 *
 * ⚠️ SAFETY (§7.2, §8.9): an empty OR malformed set must leave the judge context byte-identical to
 * today's. Every path here returns [] rather than throwing, and [] renders no prompt block at all.
 * It must NEVER be read as "no packages exist, therefore everything is a duplicate."
 */

import { sql } from '../db';
import { parseStoredLabPackages, type LabPackage } from './lab-packages-csv';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export const LAB_PACKAGES_NOTE_TYPE = 'lab_packages';

export interface ActiveLabPackages {
  packages: LabPackage[];
  version: number;
  /** 'db' when a published version was read, 'file' when it fell back to data/lab-packages.json. */
  origin: 'db' | 'file';
}

// Module-scope cache, mirroring the active-policy cache in ./store.ts: the judge reads this on
// every Order-check run and it changes only on publish.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; value: ActiveLabPackages } | null = null;

export function invalidateLabPackagesCache(): void { cache = null; }

/** The committed file. Never throws — an unreadable or malformed file yields []. */
export function fileLabPackages(): LabPackage[] {
  try {
    // Static import would inline the file into every bundle that touches the judge; require keeps
    // it a runtime read, and the try/catch makes an absent or malformed file a no-op.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw = require('../../data/lab-packages.json') as unknown;
    return parseStoredLabPackages(raw);
  } catch {
    return [];
  }
}

/**
 * The active set. NEVER THROWS.
 *
 * INFERRED SQL (the Phase A table, reused):
 *   SELECT version, weights FROM scoring_policy_versions
 *    WHERE note_type = 'lab_packages' AND is_active ORDER BY version DESC LIMIT 1
 */
export async function activeLabPackages(): Promise<ActiveLabPackages> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  let value: ActiveLabPackages = { packages: fileLabPackages(), version: 0, origin: 'file' };
  try {
    const rows = await run(
      `SELECT version, weights FROM scoring_policy_versions
        WHERE note_type = $1 AND is_active ORDER BY version DESC LIMIT 1`,
      [LAB_PACKAGES_NOTE_TYPE],
    );
    const r = rows[0];
    if (r) {
      // THE ARRAY BRANCH. `weights` is a package array here, not a {key: tier} object.
      const packages = parseStoredLabPackages(r.weights);
      // A published-but-empty version is a legitimate state (someone removed every package), so it
      // is honoured rather than silently falling back to the file.
      value = { packages, version: Number(r.version ?? 0), origin: 'db' };
    }
  } catch {
    // Table missing / migration unrun / DB down → the committed file, which is what the engine
    // read before this module existed.
  }
  cache = { at: Date.now(), value };
  return value;
}

/** The judge's projection: name, aliases and constituents only. Nothing evaluative. */
export async function labPackageContext(): Promise<{ package: string; aliases: string[]; contains: string[] }[]> {
  const { packages } = await activeLabPackages();
  return packages.map((p) => ({ package: p.package, aliases: p.aliases ?? [], contains: p.contains }));
}
