"use client";

/**
 * AdminDashboard — content for the /admin landing page.
 *
 * Sprint 10 refactor: the doctors-management table moved to /admin/doctors
 * (its own page). This component now just renders the overview chrome
 * (KPIs, attention, chart, health, activity feed) and the GlobalRecipients
 * section. Sprint 11 will move GlobalRecipients to /admin/settings.
 */

import * as React from "react";
import Link from "next/link";
import { GlobalRecipients } from "@/components/admin/GlobalRecipients";
import { AdminDashboardOverview } from "@/components/admin/AdminDashboardOverview";

export function AdminDashboard({ adminName }: { adminName: string }) {
  return (
    <div className="space-y-10">
      <AdminDashboardOverview adminName={adminName} />

      <section className="space-y-3">
        <header className="pb-2 border-b border-even-ink-100 flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1">Global CC list</p>
            <h2 className="text-heading text-even-navy-800">Recipients on every send</h2>
            <p className="text-caption text-even-ink-500 mt-0.5">
              Will move to <code className="font-mono">/admin/settings</code> in Sprint 11.
            </p>
          </div>
          <Link
            href="/admin/doctors"
            className="text-label text-even-blue-600 hover:underline whitespace-nowrap"
          >
            Manage doctors →
          </Link>
        </header>
        <GlobalRecipients />
      </section>
    </div>
  );
}
