"use client";

/**
 * SettingsTabs — horizontal sub-nav for /admin/settings/* sub-routes.
 * Renders inside AdminShell. V's Q1 lock (Sprint 11): proper sub-routes.
 */

import * as React from "react";
import Link from "next/link";

type TabKey = "global-cc" | "retention" | "resend" | "health" | "launch-readiness";

const TABS: Array<{ key: TabKey; label: string; href: string }> = [
  { key: "global-cc",        label: "Global CC list",   href: "/admin/settings/global-cc" },
  { key: "retention",        label: "Retention",        href: "/admin/settings/retention" },
  { key: "resend",           label: "Resend config",    href: "/admin/settings/resend" },
  { key: "health",           label: "Health probes",    href: "/admin/settings/health" },
  { key: "launch-readiness", label: "Launch readiness", href: "/admin/settings/launch-readiness" },
];

export function SettingsTabs({
  current,
  children,
}: {
  current: TabKey;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <nav className="flex gap-1 border-b border-even-ink-100 -mt-2" aria-label="Settings sections">
        {TABS.map((t) => {
          const active = current === t.key;
          return (
            <Link
              key={t.key}
              href={t.href}
              className={`px-3 py-2 text-label transition-colors border-b-2 -mb-px ${
                active
                  ? "border-even-blue-600 text-even-navy-800 font-semibold"
                  : "border-transparent text-even-ink-500 hover:text-even-ink-800"
              }`}
              aria-current={active ? "page" : undefined}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div>{children}</div>
    </div>
  );
}
