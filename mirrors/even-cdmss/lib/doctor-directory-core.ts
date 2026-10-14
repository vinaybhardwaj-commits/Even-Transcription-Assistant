/**
 * lib/doctor-directory-core.ts — canonical doctor-roster CORE (pure).
 *
 * The identity recipe validated on live db13 (3 Jul): the canonical key is `doctors.uid`; EPI matches
 * its physicians to it by NAME (+ mobile_last4 tiebreaker). This builds the matching source EPI pulls
 * (`GET /doctor-directory`) from the raw db13 doctor rows: filter system/generic rows, dedupe the same
 * person by mobile, and emit an order-independent `name_normalized`. Pure → unit-testable.
 */

/** Order-independent name key: lowercase, drop Dr./punctuation, split, sort tokens, rejoin.
 *  "Dr. K N Srikanth" ≡ "Srikanth K N" → "k n srikanth". */
export function normalizeDoctorName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'dr')
    .sort()
    .join(' ');
}

/** Last 4 digits of a mobile (disambiguation only — never the full number over the wire). */
export function mobileLast4(mobile?: string | null): string | null {
  const d = String(mobile || '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

/** System/placeholder rows to drop (Even Health, hello@ mailboxes, +919999999999, test/dummy). */
export function isGenericDoctorRow(row: { name?: string | null; email?: string | null; mobile?: string | null }): boolean {
  const name = String(row.name || '').toLowerCase().trim();
  const email = String(row.email || '').toLowerCase().trim();
  const mobile = String(row.mobile || '').replace(/\D/g, '');
  if (!name) return true;
  if (name.includes('even health') || name.includes('even hospital') || /\btest\b|\bdummy\b|\bdemo\b/.test(name)) return true;
  if (email.startsWith('hello@') || email.startsWith('info@') || email.startsWith('support@')) return true;
  if (/^9+$/.test(mobile) || mobile === '919999999999' || mobile === '9999999999') return true;
  return false;
}

export interface RosterInput {
  doctor_uid: string; name: string;
  email?: string | null; mobile?: string | null;
  specialty?: string | null; channel?: string | null;
  audit_active: boolean; operational_active: boolean;
}
export interface RosterRow {
  doctor_uid: string; name: string; name_normalized: string;
  specialty: string | null; channel: string | null; mobile_last4: string | null;
  has_email: boolean; audit_active: boolean; operational_active: boolean;
}

/**
 * Build the canonical roster: drop generics, dedupe same-person-by-mobile (fold activity onto one
 * canonical uid — the active one wins, else lexicographic), emit name_normalized. This is what stops
 * a duplicate splitting a doctor's audit uid from their operational uid.
 */
export function buildRoster(inputs: RosterInput[]): RosterRow[] {
  const real = inputs.filter((r) => !isGenericDoctorRow({ name: r.name, email: r.email, mobile: r.mobile }));

  const byMobile = new Map<string, RosterInput[]>();
  const noMobile: RosterInput[] = [];
  for (const r of real) {
    const m = String(r.mobile || '').replace(/\D/g, '');
    if (m.length >= 10) (byMobile.get(m) || byMobile.set(m, []).get(m)!).push(r);
    else noMobile.push(r);
  }

  const out: RosterRow[] = [];
  const emit = (canonical: RosterInput, cluster: RosterInput[]) => {
    out.push({
      doctor_uid: canonical.doctor_uid,
      name: canonical.name,
      name_normalized: normalizeDoctorName(canonical.name),
      specialty: canonical.specialty || cluster.map((c) => c.specialty).find(Boolean) || null,
      channel: canonical.channel || cluster.map((c) => c.channel).find(Boolean) || null,
      mobile_last4: mobileLast4(canonical.mobile),
      has_email: !!canonical.email,
      audit_active: cluster.some((c) => c.audit_active),
      operational_active: cluster.some((c) => c.operational_active),
    });
  };
  const activeScore = (r: RosterInput) => Number(r.audit_active) + Number(r.operational_active);
  for (const cluster of byMobile.values()) {
    const canonical = [...cluster].sort((a, b) => (activeScore(b) - activeScore(a)) || (a.doctor_uid < b.doctor_uid ? -1 : 1))[0];
    emit(canonical, cluster);
  }
  for (const r of noMobile) emit(r, [r]);

  // stable order: active first, then name
  out.sort((a, b) =>
    (Number(b.audit_active || b.operational_active) - Number(a.audit_active || a.operational_active)) ||
    a.name_normalized.localeCompare(b.name_normalized));
  return out;
}
