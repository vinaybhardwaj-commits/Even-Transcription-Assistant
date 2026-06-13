"use client";

import * as React from "react";
import type { NativeAnalysis } from "@/lib/stt/indic-comprehension";

const LANG: Record<string, string> = {
  "kn-IN": "Kannada", "hi-IN": "Hindi", "ta-IN": "Tamil", "te-IN": "Telugu",
  "ml-IN": "Malayalam", "mr-IN": "Marathi", "bn-IN": "Bengali", "gu-IN": "Gujarati", "pa-IN": "Punjabi",
};

function Field({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-caption font-medium text-even-blue-700 mb-1">{title}</p>
      <ul className="list-disc pl-5 space-y-0.5 text-body text-even-ink-800">
        {items.map((x, i) => <li key={i}>{x}</li>)}
      </ul>
    </div>
  );
}

/** Renders the faithful native-language analysis (Indic Comprehension Layer). */
export function NativeAnalysisCard({ analysis, lang }: { analysis: NativeAnalysis | null; lang?: string | null }) {
  if (!analysis) return null;
  const label = (lang && (LANG[lang] ?? lang)) || analysis.language || null;
  return (
    <details className="rounded-2xl border border-even-navy-200 bg-even-navy-50/50 overflow-hidden">
      <summary className="cursor-pointer select-none flex items-center justify-between px-4 py-3">
        <span className="text-label text-even-navy-900">Original-language analysis{label ? ` · ${label}` : ""}</span>
        <span className="text-caption text-even-ink-400">faithful native record</span>
      </summary>
      <div className="px-4 pb-4">
        {analysis.chief_complaint ? (
          <div className="mt-1">
            <p className="text-caption font-medium text-even-blue-700 mb-1">Chief complaint</p>
            <p className="text-body text-even-ink-800">{analysis.chief_complaint}</p>
          </div>
        ) : null}
        <Field title="Symptoms" items={analysis.symptoms} />
        <Field title="Medications (as spoken)" items={analysis.medications} />
        <Field title="Stated negatives" items={analysis.negatives} />
        <Field title="Patient concerns" items={analysis.patient_concerns} />
        {analysis.summary ? (
          <div className="mt-3">
            <p className="text-caption font-medium text-even-blue-700 mb-1">Summary</p>
            <p className="text-body text-even-ink-800 whitespace-pre-line">{analysis.summary}</p>
          </div>
        ) : null}
        <p className="mt-3 text-caption text-even-ink-400">
          Generated faithfully in the patient&rsquo;s language from the original transcript — not a translation.
        </p>
      </div>
    </details>
  );
}
