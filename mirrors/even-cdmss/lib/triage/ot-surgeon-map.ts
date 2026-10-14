/**
 * lib/triage/ot-surgeon-map.ts — curated surgeon string → Pulse doctor_uid (pure).
 *
 * Fail-closed like the DS treating-doctor hop, but the identity source is different:
 * free-text `surgeon` on kx_clinical_template_ot_notes, never KX *_doctor_id, and never
 * current_treating_doctor as the operating surgeon. Multiline / multi-surgeon dumps
 * hold as multi_surgeon_hold. Exact map key only — no fuzzy name match.
 */

export type OtMapStatus = 'mapped' | 'unmapped' | 'multi_surgeon_hold';

export interface OtSurgeonResolution {
  map_status: OtMapStatus;
  doctor_uid: string | null;
  surgeon_key: string | null;
  reason: string;
}

/** Normalize for map lookup: trim + collapse internal whitespace. Preserves case for storage key
 *  equality against the seed (lookup uses a case-insensitive map). */
export function normalizeSurgeonKey(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

/** Newline or pipe / semicolon multi-name dumps — do not pick first. */
export function isMultiSurgeonDump(raw: string | null | undefined): boolean {
  const text = String(raw ?? '');
  if (/[\r\n]/.test(text)) return true;
  // Two or more "Dr"/"DR" tokens separated by separators often mean co-surgeons on one line.
  const parts = text.split(/\s*(?:\/|;|\||\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => /\bdr\.?\b/i.test(p) || p.length > 2)) {
    return parts.length >= 2 && /(?:\/|;|\||\band\b)/i.test(text);
  }
  return false;
}

/**
 * Resolve one surgeon string against a curated map (surgeon_key → doctor_uid).
 * Keys are matched case-insensitively after whitespace normalization.
 */
export function resolveOtSurgeon(
  surgeonRaw: string | null | undefined,
  mapByKey: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): OtSurgeonResolution {
  const key = normalizeSurgeonKey(surgeonRaw);
  if (!key) {
    return { map_status: 'unmapped', doctor_uid: null, surgeon_key: null, reason: 'empty_surgeon' };
  }
  if (isMultiSurgeonDump(surgeonRaw)) {
    return { map_status: 'multi_surgeon_hold', doctor_uid: null, surgeon_key: key, reason: 'multi_surgeon_hold' };
  }

  const lookup = mapByKey instanceof Map
    ? mapByKey
    : new Map(Object.entries(mapByKey).map(([k, v]) => [k, v]));

  const lower = key.toLowerCase();
  let hit: string | null = null;
  let hitKey: string | null = null;
  for (const [k, uid] of lookup) {
    if (normalizeSurgeonKey(k).toLowerCase() !== lower) continue;
    const doctorUid = String(uid || '').trim();
    if (!doctorUid) continue;
    if (hit && hit !== doctorUid) {
      return { map_status: 'unmapped', doctor_uid: null, surgeon_key: key, reason: 'ambiguous_map' };
    }
    hit = doctorUid;
    hitKey = normalizeSurgeonKey(k);
  }
  if (!hit) {
    return { map_status: 'unmapped', doctor_uid: null, surgeon_key: key, reason: 'unmapped_surgeon' };
  }
  return { map_status: 'mapped', doctor_uid: hit, surgeon_key: hitKey, reason: 'resolved' };
}

/** Build a CI lookup map from seed rows. Duplicate keys with differing uids are dropped. */
export function buildSurgeonLookup(
  rows: readonly { surgeon: string; doctor_uid: string }[],
): Map<string, string> {
  const byLower = new Map<string, { key: string; uid: string }>();
  const ambiguous = new Set<string>();
  for (const row of rows ?? []) {
    const key = normalizeSurgeonKey(row.surgeon);
    const uid = String(row.doctor_uid || '').trim();
    if (!key || !uid) continue;
    const lower = key.toLowerCase();
    const prior = byLower.get(lower);
    if (prior && prior.uid !== uid) {
      ambiguous.add(lower);
      byLower.delete(lower);
      continue;
    }
    if (ambiguous.has(lower)) continue;
    byLower.set(lower, { key, uid });
  }
  const out = new Map<string, string>();
  for (const { key, uid } of byLower.values()) out.set(key, uid);
  return out;
}
