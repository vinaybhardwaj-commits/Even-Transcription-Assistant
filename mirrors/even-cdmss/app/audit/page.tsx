import { redirect } from 'next/navigation';
import { auditAccessAllowed } from '@/lib/pharmacist-cookie';
import AuditClient from './audit-client';

export const dynamic = 'force-dynamic';

// Clinical Pharmacist audit surface. Pharmacist-gated; served at medaudit.evenos.app.
export default async function AuditPage() {
  if (!(await auditAccessAllowed())) redirect('/audit/login');
  return <AuditClient />;
}
