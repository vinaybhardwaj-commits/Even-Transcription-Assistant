"use client";

/**
 * AdminDashboard — content for /admin (Sprint 11 final).
 *
 * Pure overview now. GlobalRecipients moved to /admin/settings/global-cc;
 * doctors table moved to /admin/doctors (Sprint 10).
 */

import { AdminDashboardOverview } from "@/components/admin/AdminDashboardOverview";

export function AdminDashboard({ adminName }: { adminName: string }) {
  return (
    <div>
      <AdminDashboardOverview adminName={adminName} />
    </div>
  );
}
