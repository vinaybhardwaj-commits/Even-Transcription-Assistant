"use client";

import { usePathname } from "next/navigation";

const items = [
  { label: "Dashboard", href: "/safety#dashboard" },
  { label: "Queue", href: "/safety#queue" },
  { label: "Recurring patterns", href: "/safety#recurring" },
  // "Notification rules", not "Notifications": this tab renders on every safety
  // screen INCLUDING /safety/incidents/[id], where "Notifications" read as a tab
  // belonging to the incident you were viewing. The rules are global — one
  // inc_notify_route table consulted for every incident (observed 25 Jul).
  { label: "Notification rules", href: "/safety/notifications" },
];

/** Sticky sub-nav shown on every Safety screen — jump to any section/page. */
export default function SafetyNav() {
  const path = usePathname();
  return (
    <div className="sticky top-[56px] z-30 -mx-8 mb-6 border-b border-stone-200 bg-white/85 px-8 backdrop-blur">
      <div className="flex items-center gap-3 py-2.5">
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">Incidents</span>
          {items.map((i) => {
            const active = i.href === "/safety/notifications" && path === "/safety/notifications";
            return (
              <a
                key={i.href}
                href={i.href}
                className={
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition " +
                  (active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900")
                }
              >
                {i.label}
              </a>
            );
          })}
        </nav>
        <a
          href="/safety/report"
          className={
            "shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-[13px] font-semibold shadow-sm transition " +
            (path === "/safety/report"
              ? "bg-teal-800 text-white ring-2 ring-teal-200"
              : "bg-teal-700 text-white hover:bg-teal-800")
          }
        >
          Report an incident
        </a>
      </div>
    </div>
  );
}
