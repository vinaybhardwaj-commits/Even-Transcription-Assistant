"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Hospital {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

const COOKIE = "epi_hospital_filter";

function readCookieFilter(): string {
  if (typeof document === "undefined") return "all";
  const parts = document.cookie.split(";").map((s) => s.trim());
  for (const p of parts) {
    if (p.startsWith(COOKIE + "=")) {
      const raw = decodeURIComponent(p.substring(COOKIE.length + 1)).trim().toUpperCase();
      if (raw === "ALL") return "all";
      if (/^[A-Z]{2,8}$/.test(raw)) return raw;
    }
  }
  return "all";
}

/**
 * Global hospital filter dropdown — lives in TopNav.
 * Reads its current value from the epi_hospital_filter cookie;
 * POSTs to /api/hospital-filter to set + triggers router.refresh()
 * so server components re-render with the new scope.
 */
export function HospitalFilter() {
  const router = useRouter();
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [active, setActive] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setActive(readCookieFilter());
    fetch("/api/hospitals")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setHospitals(j.hospitals as Hospital[]);
      })
      .catch(() => undefined);
  }, []);

  async function pick(code: string) {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const res = await fetch("/api/hospital-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        setActive(code);
        router.refresh();
        window.dispatchEvent(new Event("epi-hospital-filter"));
      }
    } finally {
      setBusy(false);
    }
  }

  const label = active === "all" ? "All Hospitals" : active;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-stone-200 hover:bg-stone-50 text-[12px] font-medium text-stone-700 transition"
        title="Filter scope across the app"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${active === "all" ? "bg-stone-400" : "bg-brand"}`}></span>
        <span>{label}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" className="text-stone-400">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)}></div>
          <div className="absolute top-full left-0 mt-1 z-40 bg-white border border-stone-200 rounded-lg shadow-md py-1 min-w-[160px]">
            <button
              onClick={() => pick("all")}
              className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between hover:bg-stone-50 ${active === "all" ? "font-semibold text-stone-900" : "text-stone-600"}`}
            >
              <span>All Hospitals</span>
              {active === "all" && <span className="text-brand">·</span>}
            </button>
            <div className="my-1 border-t border-stone-100"></div>
            {hospitals.map((h) => (
              <button
                key={h.id}
                onClick={() => pick(h.code)}
                className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between hover:bg-stone-50 ${active === h.code ? "font-semibold text-stone-900" : "text-stone-600"}`}
              >
                <span>{h.code}</span>
                {active === h.code && <span className="text-brand">·</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
