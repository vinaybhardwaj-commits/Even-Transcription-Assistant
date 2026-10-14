"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * /admin button — super_admin one-shot to seed OPPE rows for every Active
 * engagement per credentialing PRD decision #21.
 */
export function KickstartOppeButton({ visible }: { visible: boolean }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!visible) return null;

  async function kickstart() {
    if (!confirm(
      "Kickstart the OPPE backlog?\n\n" +
      "This creates one OPPE row per existing Active engagement " +
      "(due in 30 days), so the SMH/super_admin team can start signing them " +
      "off. Safe to re-run — skips engagements that already have an open OPPE.",
    )) return;
    setWorking(true); setError(null); setResult(null);
    try {
      const r = await fetch("/api/admin/oppe-kickstart", { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || "Kickstart failed."); setWorking(false); return; }
      setResult({ created: j.created_count, skipped: j.skipped_count });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={kickstart}
        disabled={working}
        className="px-3 py-2 rounded-lg text-sm font-medium text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-60"
      >
        {working ? "Kickstarting…" : "Kickstart OPPE backlog"}
      </button>
      {result && (
        <div className="text-[11px] text-emerald-700">
          Created {result.created} · skipped {result.skipped}
        </div>
      )}
      {error && <div className="text-[11px] text-red-700">{error}</div>}
    </div>
  );
}
