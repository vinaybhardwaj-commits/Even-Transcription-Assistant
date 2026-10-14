"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const LINKS = [
  { id: "home", href: "/surgical-governance", label: "Surgical ELO" },
  { id: "queue", href: "/surgical-governance/capture-queue", label: "Capture queue" },
  { id: "sheets", href: "/surgical-governance/ot-sheets", label: "OT sheets" },
] as const;

/**
 * In-module links for OT capture. Renders nothing unless FEATURE_OT_CAPTURE is on
 * for this super-admin session. Stays off the main Governance sidebar and top nav.
 */
export function SurgicalCaptureNav({ current }: { current: "home" | "queue" | "sheets" | "detail" }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/capture/status")
      .then((response) => response.json())
      .then((json: { ok?: boolean; enabled?: boolean }) => {
        if (json.ok && json.enabled) setEnabled(true);
      })
      .catch(() => undefined);
  }, []);

  if (!enabled) return null;

  return (
    <nav aria-label="Surgical Governance capture" className="mb-4 flex flex-wrap items-center gap-1.5">
      {LINKS.map((link) => {
        const active = link.id === current || (current === "detail" && link.id === "queue");
        return (
          <Link
            key={link.href}
            href={link.href}
            className={
              "rounded-full border px-3 py-1 text-[13px] font-medium no-underline " +
              (active
                ? "border-brand bg-brand-soft text-[#0d5f58]"
                : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50")
            }
          >
            {link.label}
          </Link>
        );
      })}
      <Link href="/capture" className="ml-1 text-[13px] font-medium text-brand hover:underline">
        Phone capture
      </Link>
    </nav>
  );
}
