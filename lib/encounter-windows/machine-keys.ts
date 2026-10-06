/**
 * lib/encounter-windows/machine-keys.ts — the spellings under which one Mac's presence rows can be filed.
 *
 * Extension rows key `machine` on the extension's machine_id, the NORMALISED hostname ("EHRC-ECHOs-Mac-mini"). Poller rows written BEFORE the 5 Oct 2026
 * cutover (04:44Z, poller commit "key machine on full hostname") key it on a short name ("echo"); every row since keys on the full hostname,
 * `unreachable` rows included. A reader that wants "the newest POLLER row for this Mac" at ANY instant — including an `asOf` before the cutover — must look
 * under every spelling (ext-health's poller reads do, through machineKeys()). Extension rows never carried a short key: ext lookups use the full
 * normalised hostname only.
 *
 * Kept in its own dependency-free file so ext-health.ts (imported by fleet-attention.ts) can use it without a cycle, and fleet-attention.ts re-exports
 * the two names it has always exported.
 */
import { normalizeHostname } from "./types";

/**
 * Poller rows written BEFORE the 5 Oct 2026 cutover key `machine` on the short name. The two `-2` Macs (OPD 1, OPD 4 Ortho) were always keyed on full
 * names and have no short form. Legacy key -> canonical key.
 */
export const POLLER_LEGACY_KEYS: Readonly<Record<string, string>> = {
  consul4: "EHRC-CONSUL4s-Mac-mini",
  consul5: "EHRC-CONSUL5s-Mac-mini",
  consul6: "EHRC-CONSUL6s-Mac-mini",
  consul7: "EHRC-CONSUL7s-Mac-mini",
  echo: "EHRC-ECHOs-Mac-mini",
  discussion: "EHRC-DISCUSSIONs-Mac-mini",
  audiometry: "EHRC-AUDIOMETRYs-Mac-mini",
};

/** A poller row's `machine` (full hostname, or a pre-5-Oct short key) in the extension's machine_id spelling. */
export function canonicalPollerKey(machine: string): string {
  return POLLER_LEGACY_KEYS[machine] ?? normalizeHostname(machine);
}

/** The pre-rename poller key for a canonical machine key, or null. */
export function legacyPollerKey(canonical: string): string | null {
  for (const [legacy, canon] of Object.entries(POLLER_LEGACY_KEYS)) if (canon === canonical) return legacy;
  return null;
}

/** Every `machine` spelling a Mac's rows can carry: the canonical key first, then the raw hostname (when different), then the legacy poller key. */
export function machineKeys(hostname: string): string[] {
  const canonical = normalizeHostname(hostname);
  const keys = [canonical];
  if (hostname !== canonical) keys.push(hostname);
  const legacy = legacyPollerKey(canonical);
  if (legacy) keys.push(legacy);
  return keys;
}
