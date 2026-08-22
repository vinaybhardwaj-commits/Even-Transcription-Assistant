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
 *
 * ─── K3 A1: THE SIDEBAR COLLAPSES BELOW `lg` ─────────────────────────────────────────────
 *
 * This file wraps EVERY page under app/admin, so it is the riskiest thing in the K3 build and
 * the change is deliberately shaped to be inert on a desktop.
 *
 * The sidebar used to be `sticky top-0 h-screen w-56 shrink-0` with no breakpoint at all: a
 * fixed 224px, always, which on a 768px portrait iPad left 544px for the page. Below `lg` it is
 * now an off-canvas drawer behind a menu button in the header; at `lg` and above it is the same
 * sticky column it always was, the button is `lg:hidden`, and `lg:translate-x-0` means the
 * drawer's open/closed state cannot affect a desktop even if it is somehow left open.
 *
 * The Tailwind order matters: base `fixed inset-y-0 left-0 z-50` is overridden at the breakpoint
 * by `lg:sticky lg:inset-y-auto lg:z-auto`, because Tailwind emits responsive variants after
 * their base utilities. Verified in the built CSS, not assumed.
 *
 * The drawer closes on: a nav tap, the backdrop, and Escape. It does NOT lock body scroll —
 * the backdrop covers the page and a scroll lock is one more thing to leak onto a desktop.
 */

import * as React from "react";
import Link from "next/link";
import { ChangePasswordModal } from "@/components/admin/ChangePasswordModal";

export type AdminNavKey =
  | "dashboard"
  | "admins"
  | "system-map"
  | "doctors"
  | "encounters"
  | "traces"
  | "sends"
  | "settings"
  | "diarization"
  | "stt-lab"
  | "bench";

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
  { key: "stt-lab", label: "STT Lab", href: "/admin/stt-lab", icon: "◎", section: "observe" },
  { key: "bench", label: "Bench", href: "/admin/bench", icon: "⏺", section: "observe" },
  { key: "admins",     label: "Admins",     href: "/admin/admins",   icon: "◑", section: "configure" },
  { key: "system-map", label: "System map", href: "/admin/system-map", icon: "▦", section: "configure" },
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
  /** A1 — the drawer, below `lg` only. At `lg` the sidebar ignores this entirely. */
  const [navOpen, setNavOpen] = React.useState(false);
  const closeNav = React.useCallback(() => setNavOpen(false), []);

  // Escape closes the drawer. Bound only while it is open, so a desktop never carries a
  // key listener it has no use for.
  React.useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

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
            "flex items-center gap-3 px-3 py-2 rounded-xl text-label transition-colors";
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
                onClick={closeNav}
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
      {/* A1 — the backdrop. Below `lg` and only while open; `lg:hidden` so it can never appear
          on a desktop even if the drawer state is somehow true. */}
      {navOpen ? (
        <div
          className="fixed inset-0 z-40 bg-even-navy-800/40 lg:hidden"
          onClick={closeNav}
          aria-hidden="true"
        />
      ) : null}

      {/* Sidebar — a drawer below `lg`, the original sticky column at `lg` and above. */}
      <aside
        id="admin-nav"
        className={`fixed inset-y-0 left-0 z-50 h-screen w-56 shrink-0 bg-even-ink-100/80 border-r border-even-ink-200 flex flex-col transition-transform duration-200 ease-out ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        } lg:sticky lg:top-0 lg:inset-y-auto lg:z-auto lg:translate-x-0 lg:transition-none`}
        aria-hidden={undefined}
      >
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
          {/* A3 — 11px text in a ~14px-tall box was the smallest hit area in the admin. The
              TEXT grows to caption and the PADDING carries the rest to 44px; the label is not
              shrunk to make room, which is the whole point of the rule. */}
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              onClick={() => setChangingPw(true)}
              className="min-h-11 px-2 py-2 rounded-lg text-caption text-even-blue-600 hover:bg-even-white/70 hover:underline"
            >
              Change password
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="min-h-11 px-2 py-2 rounded-lg text-caption text-even-blue-600 hover:bg-even-white/70 hover:underline"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0">
        <header className="bg-even-white border-b border-even-ink-100 px-4 sm:px-6 py-3 sm:py-4 flex items-start justify-between gap-3">
          {/* A1 — the menu button. 44x44 minimum, `lg:hidden`, and the ONLY way to reach the
              nav below `lg`. */}
          <button
            type="button"
            onClick={() => setNavOpen((v) => !v)}
            aria-expanded={navOpen}
            aria-controls="admin-nav"
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            className="lg:hidden shrink-0 -ml-1 h-11 w-11 inline-flex items-center justify-center rounded-xl border border-even-ink-200 bg-even-white text-even-navy-800 active:bg-even-ink-100"
          >
            <span aria-hidden="true" className="text-heading leading-none">{navOpen ? "✕" : "☰"}</span>
          </button>
          <div className="min-w-0 flex-1">
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

        <main className="px-4 sm:px-6 py-4 sm:py-6 max-w-7xl">{children}</main>
      </div>

      {changingPw ? (
        <ChangePasswordModal onClose={() => setChangingPw(false)} onChanged={() => setChangingPw(false)} />
      ) : null}
    </div>
  );
}
