import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';
import { isAdminUnlocked } from './admin-cookie';

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

// Principal gate for the audit surface, on every host.
// A pharmacist session (medaudit login) or an admin unlock session (cat_admin)
// may open it. The host is not a principal: cat.evenos.app used to skip this
// check entirely because middleware only tagged medaudit.evenos.app.
export async function auditAccessAllowed(): Promise<boolean> {
  if (await isPharmacistUnlocked()) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export function pharmacistTokenMatches(presented: string): boolean {
  const token = process.env.PHARMACIST_TOKEN;
  return !!token && safeEq(presented, token);
}
