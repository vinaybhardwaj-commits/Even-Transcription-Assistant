"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { CaseTable } from "@/components/CaseTable";
import { StreamConfig } from "@/components/EditableCell";

const STREAM_IDS = ["abx_stewardship"];

export default function PharmacyInputPage() {
  const [streams, setStreams] = useState<StreamConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/streams?team=Pharmacy")
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) {
          setError(j.error ?? "Failed to load streams");
          return;
        }
        const filtered = (j.streams as StreamConfig[]).filter((s) => STREAM_IDS.includes(s.id));
        setStreams(filtered);
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
              <span className="text-stone-900 font-medium">Pharmacy</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Antibiotic stewardship</h1>
            <p className="text-sm text-stone-500 mt-1">
              1 stream · default unknown. Mark each case as appropriate prophylaxis or not.
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
            {error}
          </div>
        )}

        {streams.length > 0 && (
          <CaseTable streams={streams} expectedTeam="Pharmacy" expectedTeamLabel="Pharmacy" />
        )}
      </main>
    </>
  );
}
