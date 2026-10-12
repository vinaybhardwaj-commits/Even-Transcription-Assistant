import * as React from "react";
import Link from "next/link";

/** Two server-rendered tabs for /admin/rooms. Plain links, so the tab survives a reload and works without JS. */
export function RoomsTabs({ active }: { active: "rooms" | "coverage" }) {
  const base = "inline-flex items-center min-h-11 px-4 rounded-xl text-label border";
  const on = "bg-even-white text-even-navy-800 font-semibold border-even-ink-200";
  const off = "text-even-navy-800/70 border-transparent hover:bg-even-white/60";
  return (
    <nav aria-label="Rooms views" className="flex gap-2 mb-4 flex-wrap">
      <Link href="/admin/rooms" className={`${base} ${active === "rooms" ? on : off}`} aria-current={active === "rooms" ? "page" : undefined}>
        Rooms
      </Link>
      <Link href="/admin/rooms?tab=coverage" className={`${base} ${active === "coverage" ? on : off}`} aria-current={active === "coverage" ? "page" : undefined}>
        Daily coverage
      </Link>
    </nav>
  );
}
