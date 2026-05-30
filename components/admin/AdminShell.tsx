"use client";

/**
 * AdminShell — navy sidebar + light content area used by every admin page.
 *
 * Matches Figma `Even Encounter Assistant — Admin Desktop` pp1-7.
 * Sections: OPERATE (Dashboard, Doctors, Encounters), OBSERVE (LLM traces,
 * Sends), CONFIGURE (Settings). Per V's Sprint 6 Q5 lock, only Dashboard
 * + LLM traces are clickable in this sprint; the rest render visually
 * matched but greyed with a 'Coming soon' affordance.
 *
 * Why client component: the sidebar items use Next.js <Link> which works
 * in either, but the avatar/Sign out + Change password buttons want client
 * interactivity. Keeping the whole shell client keeps render boundaries
 * obvious.
 */

import * as React from "react";
import Link from "next/link";
import { ChangePasswordModal } from "@/components/admin/ChangePasswordModal";

export type AdminNavKey =
  | "dashboard"
  | "doctors"
  | "encounters"
  | "traces"
  | "sends"
  | "settings"
  | "diarization";

type NavItem = {
  key: AdminNavKey;
  label: string;
  href: string | null;
  icon: string;        // small monogram glyph; matches Figma look
  section: "operate" | "observe" | "configure";
};

const NAV: NavItem[] = [
  { key: "dashboard",  label: "Dashboard",  href: "/admin",          icon: "▤", section: "operate" },
  { key: "doctors",    label: "Clinicians",    href: "/admin/doctors",  icon: "◯", section: "operate" },
  { key: "encounters", label: "Encounters", href: "/admin/encounters", icon: "◐", section: "operate" },
  { key: "traces",     label: "LLM traces", href: "/admin/traces",   icon: "◈", section: "observe" },
  { key: "sends",      label: "Sends",      href: "/admin/sends",    icon: "◉", section: "observe" },
  { key: "diarization", label: "Diarization", href: "/admin/diarization", icon: "◍", section: "observe" },
  { key: "settings",   label: "Settings",   href: "/admin/settings", icon: "◧", section: "configure" },
];

type Props = {
  adminEmail: string;
  active: AdminNavKey;
  pageTitle: string;
  // Right-side header slot (e.g. + Add doctor, Export buttons). Optional.
  headerRight?: React.ReactNode;
  // Breadcrumb prefix shown above the page title (e.g. 'Doctors / Dr Anjali').
  // Optional.
  breadcrumb?: string;
  children: React.ReactNode;
};

export function AdminShell({
  adminEmail,
  active,
  pageTitle,
  headerRight,
  breadcrumb,
  children,
}: Props) {
  const [changingPw, setChangingPw] = React.useState(false);

  const onLogout = React.useCallback(async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.reload();
  }, []);

  const renderSection = (section: NavItem["section"], heading: string) => (
    <div>
      <p className="px-3 mb-2 text-[10px] uppercase tracking-[0.14em] font-semibold text-even-navy-800/40">
        {heading}
      </p>
      <ul className="space-y-0.5">
        {NAV.filter((n) => n.section === section).map((n) => {
          const isActive = n.key === active;
          const isDisabled = n.href === null;
          const base =
            "flex items-center gap-3 px-3 py-2 rounded-md text-label transition-colors";
          if (isDisabled) {
            return (
              <li key={n.key}>
                <span
                  className={`${base} text-even-navy-800/30 cursor-not-allowed`}
                  title="Coming in a future sprint"
                  aria-disabled="true"
                >
                  <span aria-hidden="true" className="w-4 text-center">
                    {n.icon}
                  </span>
                  <span className="flex-1">{n.label}</span>
                  <span className="text-[10px] text-even-navy-800/40">soon</span>
                </span>
              </li>
            );
          }
          return (
            <li key={n.key}>
              <Link
                href={n.href!}
                className={`${base} ${
                  isActive
                    ? "bg-even-white text-even-navy-800 font-semibold"
                    : "text-even-navy-800/80 hover:bg-even-white/60 hover:text-even-navy-800"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                <span aria-hidden="true" className="w-4 text-center">
                  {n.icon}
                </span>
                <span className="flex-1">{n.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );

  // Bottom-left avatar derived from email (first letter of local part + first letter after dot).
  const initials = React.useMemo(() => {
    const local = adminEmail.split("@")[0] ?? "";
    const parts = local.split(/[.\-_]/).filter(Boolean);
    if (parts.length >= 2) {
      return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
    }
    return (parts[0]?.slice(0, 2) ?? "??").toUpperCase();
  }, [adminEmail]);

  return (
    <div className="min-h-screen flex bg-even-ink-50">
      {/* Sidebar — sticky, navy. */}
      <aside className="sticky top-0 h-screen w-56 shrink-0 bg-even-ink-100/80 border-r border-even-ink-200 flex flex-col">
        <div className="px-4 pt-5 pb-6">
          <p className="text-label font-semibold text-even-navy-800 leading-tight">
            Even <span className="text-even-blue-600">ETA</span>
          </p>
          <p className="text-[10px] uppercase tracking-[0.14em] text-even-navy-800/50 mt-0.5">
            Admin
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 space-y-5">
          {renderSection("operate", "Operate")}
          {renderSection("observe", "Observe")}
          {renderSection("configure", "Configure")}
        </nav>

        {/* Bottom user card. */}
        <div className="border-t border-even-ink-200 px-3 py-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-even-navy-800 text-even-white text-caption font-semibold">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-caption text-even-navy-800 truncate">{adminEmail}</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setChangingPw(true)}
              className="text-[11px] text-even-blue-600 hover:underline"
            >
              Change password
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="text-[11px] text-even-blue-600 hover:underline"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0">
        <header className="bg-even-white border-b border-even-ink-100 px-6 py-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {breadcrumb ? (
              <p className="text-caption text-even-ink-500 mb-1 truncate">
                {breadcrumb}
              </p>
            ) : null}
            <h1 className="text-heading text-even-navy-800">{pageTitle}</h1>
          </div>
          {headerRight ? (
            <div className="shrink-0 flex items-center gap-2">{headerRight}</div>
          ) : null}
        </header>

        <main className="px-6 py-6 max-w-7xl">{children}</main>
      </div>

      {changingPw ? (
        <ChangePasswordModal onClose={() => setChangingPw(false)} onChanged={() => setChangingPw(false)} />
      ) : null}
    </div>
  );
}
