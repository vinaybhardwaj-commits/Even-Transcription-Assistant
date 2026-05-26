"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { RecoveryModal } from "@/components/RecoveryModal";

type Props = { slug: string; doctorName: string };

export function HomeShell({ slug, doctorName }: Props) {
  const router = useRouter();
  const [tab, setTab] = React.useState<"record" | "library">("record");
  const [patientLabel, setPatientLabel] = React.useState("");

  const goRecord = React.useCallback(() => {
    // patient_label is captured in the recording screen / submit step;
    // we pass via sessionStorage so the create call can hand it to the API.
    if (patientLabel.trim()) {
      try {
        sessionStorage.setItem("eta:pending_patient_label", patientLabel.trim());
      } catch {
        /* private mode */
      }
    }
    router.push(`/${slug}/record`);
  }, [router, slug, patientLabel]);

  return (
    <main className="min-h-screen bg-even-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-even-ink-100">
        <span className="text-label text-even-navy-800">
          Dr {doctorName.replace(/^Dr\.?\s+/i, "")}
        </span>
        <span className="text-caption text-even-ink-400">{/* settings + menu (Sprint 2) */}</span>
      </header>

      <div className="px-4 pt-4">
        <div className="inline-flex rounded-md border border-even-ink-200 overflow-hidden text-label">
          <button
            type="button"
            onClick={() => setTab("record")}
            className={`px-4 py-2 ${tab === "record" ? "bg-even-blue-600 text-white" : "bg-even-white text-even-navy-800"}`}
          >
            Record
          </button>
          <button
            type="button"
            onClick={() => setTab("library")}
            className={`px-4 py-2 ${tab === "library" ? "bg-even-blue-600 text-white" : "bg-even-white text-even-navy-800"}`}
          >
            Library
          </button>
        </div>
      </div>

      {tab === "record" ? (
        <div className="px-4 pt-6 pb-12">
          <h2 className="text-heading text-even-navy-800 mb-4">New encounter</h2>

          <Input
            label="Patient (optional)"
            placeholder="e.g. Sarah, 34F, chest pain f/u"
            value={patientLabel}
            onChange={(e) => setPatientLabel(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            data-gramm="false"
          />

          <div className="flex justify-center mt-12">
            <button
              type="button"
              onClick={goRecord}
              className="w-44 h-44 rounded-full bg-even-blue-600 hover:bg-even-blue-700 active:bg-even-blue-800 text-white text-display flex flex-col items-center justify-center gap-2 shadow-card-hover focus:outline-none focus:ring-4 focus:ring-even-blue-300 transition"
              aria-label="Start recording"
            >
              <span className="text-4xl" aria-hidden="true">🎤</span>
              <span className="text-label">Record</span>
            </button>
          </div>

          <p className="mt-8 text-caption text-even-ink-400 text-center">
            Tap to begin. We will ask for microphone permission on the next screen.
          </p>
        </div>
      ) : (
        <div className="px-4 pt-6 pb-12">
          <h2 className="text-heading text-even-navy-800 mb-4">Library</h2>
          <p className="text-body text-even-ink-500 text-center mt-12">
            No encounters yet. Tap Record to begin.
          </p>
        </div>
      )}

      <RecoveryModal />
    </main>
  );
}
