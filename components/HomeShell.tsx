"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { RecoveryModal } from "@/components/RecoveryModal";
import { Library } from "@/components/Library";
import { NOTEGEN } from "@/lib/live-flags";

type Props = { slug: string; doctorName: string; voiceEnrolled?: boolean; clinicianType?: string };

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -6 0z" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  );
}

function PenIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

export function HomeShell({ slug, doctorName, voiceEnrolled = true, clinicianType = "physician" }: Props) {
  const router = useRouter();
  const [tab, setTab] = React.useState<"record" | "library">("record");
  const [patientLabel, setPatientLabel] = React.useState("");
  const noteOptions: ReadonlyArray<readonly [string, string]> =
    clinicianType === "dietitian" ? [["dietetic_consult", "Dietetic Consult"]]
    : clinicianType === "physiotherapist" ? [["physiotherapy", "Physiotherapy"]]
    : [["clinic_encounter", "Clinic"], ["general_medical", "General Medical"], ["operative_procedure", "Operative"]];
  const [noteType, setNoteType] = React.useState<string>(noteOptions[0][0]);

  const goRecord = React.useCallback(() => {
    if (patientLabel.trim()) {
      try { sessionStorage.setItem("eta:pending_patient_label", patientLabel.trim()); } catch { /* private mode */ }
    }
    try { sessionStorage.setItem("eta:pending_note_type", noteType); } catch { /* private mode */ }
    router.push(`/${slug}/record`);
  }, [router, slug, patientLabel, noteType]);

  const goType = React.useCallback(() => {
    if (patientLabel.trim()) {
      try { sessionStorage.setItem("eta:pending_patient_label", patientLabel.trim()); } catch { /* private mode */ }
    }
    try { sessionStorage.setItem("eta:pending_note_type", noteType); } catch { /* private mode */ }
    router.push(`/${slug}/note`);
  }, [router, slug, patientLabel, noteType]);

  const cleanName = doctorName.replace(/^Dr\.?\s+/i, "");
  const initials = cleanName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <main className="min-h-screen bg-even-ink-50">
      <header className="sticky top-0 z-10 border-b border-even-ink-100 bg-even-white/90 backdrop-blur">
        <div className="eta-page flex items-center justify-between py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-even-blue-600 text-white text-caption font-medium">{initials}</span>
            <span className="text-label text-even-navy-800">Dr {cleanName}</span>
          </div>
          <div className="inline-flex items-center gap-1 rounded-full bg-even-ink-100 p-1">
            <button type="button" onClick={() => setTab("record")} className={`eta-tab ${tab === "record" ? "eta-tab-active" : "eta-tab-idle"}`}>Record</button>
            <button type="button" onClick={() => setTab("library")} className={`eta-tab ${tab === "library" ? "eta-tab-active" : "eta-tab-idle"}`}>Library</button>
          </div>
        </div>
      </header>

      {tab === "record" ? (
        <div className="eta-page pt-6 pb-16">
          {!voiceEnrolled ? (
            <a href={`/${slug}/onboarding/voice`} className="mb-4 flex items-start gap-3 rounded-2xl border border-even-blue-200 bg-even-blue-50 px-4 py-3">
              <MicIcon className="mt-0.5 h-5 w-5 shrink-0 text-even-blue-600" />
              <span>
                <span className="block text-label text-even-navy-800">Set up voice recognition</span>
                <span className="block text-caption text-even-ink-500">~90 seconds — lets the app label you (vs the patient) in recordings.</span>
              </span>
            </a>
          ) : null}

          <div className="eta-card p-5">
            <h2 className="text-heading text-even-navy-800">New encounter</h2>
            <p className="mt-1 text-caption text-even-ink-400">Pick a note type, then tap record.</p>

            <div className="mt-5">
              <span className="mb-1.5 block text-label text-even-navy-800">Note type</span>
              <div className="eta-seg">
                {noteOptions.map(([v, lbl]) => (
                  <button key={v} type="button" onClick={() => setNoteType(v)} aria-pressed={noteType === v}
                    className={`eta-seg-item ${noteType === v ? "eta-seg-item-active" : ""}`}>{lbl}</button>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <Input label="Patient (optional)" placeholder="e.g. Sarah, 34F, chest pain f/u"
                value={patientLabel} onChange={(e) => setPatientLabel(e.target.value)}
                autoComplete="off" spellCheck={false} autoCapitalize="off" data-gramm="false" />
            </div>

            <div className="mt-8 flex flex-col items-center">
              <button type="button" onClick={goRecord} aria-label="Start recording"
                className="eta-btn-primary group h-40 w-40 flex-col rounded-full shadow-card-hover">
                <MicIcon className="h-9 w-9" />
                <span className="mt-1 text-label">Record</span>
              </button>
              <p className="mt-6 max-w-xs text-center text-caption text-even-ink-400">
                Tap to begin. We&rsquo;ll ask for microphone permission on the next screen.
              </p>
            </div>

            {NOTEGEN ? (
              <div className="mt-6 border-t border-even-ink-100 pt-5">
                <button type="button" onClick={goType}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border border-even-blue-200 bg-even-blue-50 px-4 py-3 text-label text-even-blue-700 hover:bg-even-blue-100">
                  <PenIcon className="h-5 w-5" /> Type the note instead
                </button>
                <p className="mt-2 text-center text-caption text-even-ink-400">Compose by typing &mdash; same NABH checks, same review &amp; send.</p>
              </div>
            ) : null}
          </div>

          <p className="mt-6 text-center text-caption text-even-ink-500">
            <a href={`/${slug}/recipients`} className="text-even-blue-600 hover:underline">Manage saved contacts</a>
          </p>
        </div>
      ) : (
        <div className="eta-page pt-6 pb-16">
          <h2 className="mb-4 text-heading text-even-navy-800">Library</h2>
          <Library slug={slug} />
        </div>
      )}

      <RecoveryModal slug={slug} />
    </main>
  );
}
