"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { CaseTable } from "@/components/CaseTable";
import { StreamConfig } from "@/components/EditableCell";

/**
 * Medical Superintendent owns 4 streams (PRD §5):
 *   - mortality_30d (Outcomes, no_event, lower_better)
 *   - readmission_30d (Outcomes, no_event, lower_better)
 *   - discharge_summary_24h (Adherence, unknown, higher_better)
 *   - round_attendance (Adherence, unknown, higher_better, optional reason on Inadequate)
 *
 * Display order matches mockup screen #2 component-breakdown ordering.
 */
const STREAM_IDS = [
  "mortality_30d",
  "readmission_30d",
  "discharge_summary_24h",
  "round_attendance",
];

export default function MedSupInputPage() {
  const [streams, setStreams] = useState<StreamConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/streams?team=MS")
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) {
          setError(j.error ?? "Failed to load streams");
          return;
        }
        const byId = new Map((j.streams as StreamConfig[]).map((s) => [s.id, s]));
        const ordered = STREAM_IDS.map((id) => byId.get(id)).filter(Boolean) as StreamConfig[];
        setStreams(ordered);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-stone-500 mb-2">
              <Link href="/surgical-governance/input/cases" className="hover:text-stone-900">
                Input forms
              </Link>
              <span>/</span>
              <span className="text-stone-900 font-medium">Medical Superintendent</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Med Sup entry</h1>
            <p className="text-sm text-stone-500 mt-1">
              4 streams · 30-day mortality, 30-day readmission, discharge summary in 24h, round
              attendance (Adequate / Inadequate · optional reason).
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
            {error}
          </div>
        )}

        {streams.length > 0 && (
          <CaseTable streams={streams} expectedTeam="MS" expectedTeamLabel="Med Sup" />
        )}
      </main>
    </>
  );
}
