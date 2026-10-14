"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { UserMenu, type UserSummary } from "./UserMenu";
import { ShellV2 } from "./v2/ShellV2";
import { HospitalFilter } from "./HospitalFilter";

interface NavItem {
  label: string;
  href: string;
  pending?: boolean;
  badge?: number;
}

/**
 * Top nav — EPI shell, client component.
 * Fetches /api/auth/me on mount + (if super_admin) polls pending-approval count.
 */
/**
 * Flag switch (EPI Redesign PRD v1.4-LOCKED, R1): NEXT_PUBLIC_UI_V2=1 renders the
 * redesigned sidebar shell; unset/anything else keeps the legacy top nav.
 * Kill switch = unset the env + redeploy. Wrapper (not an early return inside the
 * old component) so hook order is unconditional in both branches.
 */
export function TopNav(props: { nav?: NavItem[] } = {}) {
  if (process.env.NEXT_PUBLIC_UI_V2 === "1") return <ShellV2 />;
  return <TopNavV1 {...props} />;
}

function TopNavV1({ nav }: { nav?: NavItem[] } = {}) {
  const [user, setUser] = useState<UserSummary | null>(null);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.user) setUser(j.user as UserSummary);
      })
      .catch(() => undefined);
  }, []);

  const showElo = !!user && user.is_super_admin; // Surgical Governance is super_admin-only (Users PRD #18)
  const showAdmin = !!user && user.is_super_admin;
  const showSafety = !!user && (user.is_super_admin || user.is_sgc_member);
  const showAuditFindings = !!user && (user.is_super_admin || user.is_sgc_member || !!user.is_site_medical_head);
  const navItems: NavItem[] = nav ?? defaultNav(showElo, showAdmin, showSafety, showAuditFindings);

  return (
    <header className="bg-white border-b border-stone-200 sticky top-0 z-40">
      <div className="max-w-[1400px] mx-auto px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/home" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-brand">
              <span className="text-white text-[11px] font-bold tracking-wide">EPI</span>
            </div>
            <span className="font-semibold text-[15px]">Even Physician Index</span>
          </Link>
          {user && <HospitalFilter />}
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href + item.label}
                href={item.href}
                className={
                  item.pending
                    ? "text-stone-400 cursor-not-allowed px-3 py-1.5 rounded-md text-[13px] font-medium pointer-events-none"
                    : "text-stone-600 hover:text-stone-900 hover:bg-stone-100 px-3 py-1.5 rounded-md text-[13px] font-medium transition flex items-center gap-1.5"
                }
              >
                {item.label}
                {item.pending && <span className="ml-1 text-[10px] text-stone-300">soon</span>}
                {item.badge ? (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-brand text-white text-[10px] font-medium">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {user ? <UserMenu user={user} /> : <div className="w-8 h-8 rounded-full bg-stone-100" />}
        </div>
      </div>
    </header>
  );
}

function defaultNav(showElo: boolean, showAdmin: boolean, showSafety: boolean, showAuditFindings: boolean): NavItem[] {
  const items: NavItem[] = [
    { label: "Home", href: "/home" },
    { label: "Physician DB", href: "/physicians" },
    { label: "Credentialing", href: "/onboarding" },
    { label: "Patient Feedback", href: "/incidents" },
  ];
  if (showAuditFindings) items.push({ label: "Audit findings", href: "/audit-findings" });
  if (showSafety) items.push({ label: "Incidents (e-IRIS)", href: "/safety" });
  if (showSafety) items.push({ label: "Safety Report", href: "/safety/report" });
  if (showSafety) items.push({ label: "M&M", href: "/mm" }); // same SGC/super predicate (M&M PRD decision 13)
  if (showElo) items.push({ label: "Surgical ELO", href: "/surgical-governance" });
  if (showAdmin) items.push({ label: "Admin", href: "/admin" });
  items.push({ label: "Guide", href: "/guide" });
  return items;
}
