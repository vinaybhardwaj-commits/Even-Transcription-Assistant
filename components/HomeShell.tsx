"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type Props = { slug: string; doctorName: string };

export function HomeShell({ slug, doctorName }: Props) {
  const [tab, setTab] = React.useState<"record" | "library">("record");
  const [patientLabel, setPatientLabel] = React.useState("");

  return (
    <main className="min-h-screen bg-even-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-even-ink-100">
        <span className="text-label text-even-navy-800">
          Dr {doctorName.replace(/^Dr\.?\s+/i, "")}
        </span>
        <span className="text-caption text-even-ink-400">{/* settings + menu (Sprint 1.E) */}</span>
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
              disabled
              className="w-44 h-44 rounded-full bg-even-blue-600 disabled:bg-even-blue-300 text-white text-display flex flex-col items-center justify-center gap-2 shadow-card-hover"
              aria-label="Start recording (wired in Sprint 1.E)"
            >
              <span className="text-4xl" aria-hidden="true">🎤</span>
              <span className="text-label">Record</span>
            </button>
          </div>

          <p className="mt-8 text-caption text-even-ink-400 text-center">
            Recording wiring (MediaRecorder + Deepgram + Whisper) lands in Sprint 1.E.
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
    </main>
  );
}
