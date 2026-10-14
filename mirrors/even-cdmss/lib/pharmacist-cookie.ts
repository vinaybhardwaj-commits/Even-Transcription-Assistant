import { cookies, headers } from 'next/headers';
import { timingSafeEqual } from 'crypto';

// Fail-closed gate for the Clinical Pharmacist audit surface (medaudit.evenos.app),
// mirroring lib/admin-cookie.ts. The surface holds patient-identified audit data,
// so it stays LOCKED unless the `med_audit` cookie matches PHARMACIST_TOKEN.
// If PHARMACIST_TOKEN is unset, the surface is locked (never open by default).
export const PHARM_COOKIE = 'med_audit';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

export async function isPharmacistUnlocked(): Promise<boolean> {
  const token = process.env.PHARMACIST_TOKEN;
  if (!token) return false;
  const jar = await cookies();
  const val = jar.get(PHARM_COOKIE)?.value || '';
  return !!val && safeEq(val, token);
}

export function pharmacistTokenConfigured(): boolean {
  return !!process.env.PHARMACIST_TOKEN;
}

// Host-aware access gate for the audit surface.
//  - medaudit.evenos.app (external, tagged x-surface=medaudit by middleware):
//    REQUIRE the pharmacist token — it's an internet-facing standalone tool.
//  - CAT host (even-cdmss.vercel.app): allow — CAT is itself the access boundary,
//    so the audit tool is open to CAT clinicians like CAT's other tools.
export async function auditAccessAllowed(): Promise<boolean> {
  const surface = (await headers()).get('x-surface');
  if (surface === 'medaudit') return isPharmacistUnlocked();
  return true;
}

export function pharmacistTokenMatches(presented: string): boolean {
  const token = process.env.PHARMACIST_TOKEN;
  return !!token && safeEq(presented, token);
}
