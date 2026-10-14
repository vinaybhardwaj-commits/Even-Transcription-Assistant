"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { getCurrentPosition, onPositionChange } from "@/lib/position";

interface PreviewedRow {
  index: number;
  raw: {
    vc_full_name: string;
    surgery_date: string;
    procedure_label?: string;
    patient_name?: string;
    patient_mrn?: string;
    notes?: string;
  };
  vc_id?: string;
  resolved_vc?: { id: string; full_name: string; specialty: string };
  duplicate_of?: string;
  errors: string[];
}

interface PreviewResponse {
  ok: boolean;
  rows: PreviewedRow[];
  summary: { total: number; ready_to_insert: number; errors: number; duplicates: number };
  error?: string;
}

const SAMPLE = `vc_full_name\tsurgery_date\tprocedure_label\tpatient_name\tpatient_mrn
Dr Manoj Kumar\t2026-04-24\tLap Cholecystectomy\tMr Ashish Kumar\tEHRC-018-92341
Dr Ajay Sharma\t2026-04-22\tTotal Knee Replacement\tMrs Geeta Devi\tEHRC-018-92355`;

function parseTSV(text: string): PreviewedRow["raw"][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const out: PreviewedRow["raw"][] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = (cells[idx] ?? "").trim();
    });
    out.push({
      vc_full_name: row.vc_full_name ?? "",
      surgery_date: row.surgery_date ?? "",
      procedure_label: row.procedure_label,
      patient_name: row.patient_name,
      patient_mrn: row.patient_mrn,
      notes: row.notes,
    });
  }
  return out;
}

export default function UploadCasesPage() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);

  useEffect(() => {
    setPosition(getCurrentPosition());
    return onPositionChange((name) => setPosition(name));
  }, []);

  async function runPreview() {
    if (!position) {
      setError("Pick a position from the chip in the top-right first.");
      return;
    }
    setPreviewing(true);
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const rows = parseTSV(text);
      if (rows.length === 0) {
        setError("No data rows found. Header line + at least one data row required.");
        return;
      }
      const r = await fetch("/api/cases/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preview", rows, entered_by_position: position }),
      });
      const j: PreviewResponse = await r.json();
      if (!j.ok) throw new Error(j.error ?? "preview failed");
      setPreview(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function runCommit() {
    if (!position || !preview) return;
    setCommitting(true);
    setError(null);
    try {
      const rows = parseTSV(text);
      const r = await fetch("/api/cases/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "commit", rows, entered_by_position: position }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "commit failed");
      setResult(
        `Inserted ${j.summary.inserted} cases · Skipped ${j.summary.skipped} · Affected ${j.summary.affected_vcs} VCs (recomputes triggered)`,
      );
      setPreview(null);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <>
      <TopNav />
      <main className="max-w-[1100px] mx-auto px-8 py-12">
        <div className="flex items-center gap-2 text-xs text-stone-500 mb-2">
          <Link href="/surgical-governance/input/cases" className="hover:text-stone-900">
            New Case
          </Link>
          <span>/</span>
          <span className="text-stone-900 font-medium">Catch-up upload</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight mb-1">Catch-up case upload</h1>
        <p className="text-sm text-stone-500 mb-8">
          Paste tab-separated rows. First line must be the header. Required columns:{" "}
          <span className="font-mono text-xs bg-stone-100 px-1 rounded">vc_full_name</span>,{" "}
          <span className="font-mono text-xs bg-stone-100 px-1 rounded">surgery_date</span>{" "}
          (YYYY-MM-DD). Optional: procedure_label, patient_name, patient_mrn, notes.
        </p>

        <div className="grid grid-cols-1 gap-6">
          <div className="bg-white border border-stone-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-medium">Paste rows</label>
              <button
                type="button"
                onClick={() => setText(SAMPLE)}
                className="text-xs text-brand hover:underline"
              >
                Insert sample
              </button>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-xs bg-white font-mono"
              placeholder={SAMPLE}
            />
            <div className="flex items-center justify-between mt-4">
              <div className="text-xs text-stone-500">
                Stamped as{" "}
                <span className="font-medium text-stone-900">
                  {position ?? "(no position)"}
                </span>
              </div>
              <button
                onClick={runPreview}
                disabled={previewing || !text.trim() || !position}
                className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
              >
                {previewing ? "Validating…" : "Preview"}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              ✓ {result}
            </div>
          )}

          {preview && (
            <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">Preview</div>
                  <div className="text-xs text-stone-500 mt-0.5 num">
                    {preview.summary.total} rows · {preview.summary.ready_to_insert} ready ·{" "}
                    {preview.summary.errors} errors · {preview.summary.duplicates} duplicates
                  </div>
                </div>
                <button
                  onClick={runCommit}
                  disabled={committing || preview.summary.ready_to_insert === 0}
                  className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                >
                  {committing
                    ? "Importing…"
                    : `Import ${preview.summary.ready_to_insert} rows`}
                </button>
              </div>
              <table className="w-full">
                <thead className="bg-stone-50 text-[11px] font-medium text-stone-500 tracking-wider uppercase">
                  <tr>
                    <th className="px-4 py-3 text-left w-12">#</th>
                    <th className="px-4 py-3 text-left">VC</th>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-left">Procedure</th>
                    <th className="px-4 py-3 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {preview.rows.map((p) => (
                    <tr
                      key={p.index}
                      className={
                        p.errors.length > 0
                          ? "bg-red-50/40"
                          : p.duplicate_of
                            ? "bg-amber-50/40"
                            : ""
                      }
                    >
                      <td className="px-4 py-3 text-xs text-stone-500 num">{p.index + 1}</td>
                      <td className="px-4 py-3 text-sm">
                        {p.resolved_vc ? (
                          <>
                            <span className="font-medium">{p.resolved_vc.full_name}</span>
                            <span className="text-xs text-stone-500 ml-2">
                              {p.resolved_vc.specialty}
                            </span>
                          </>
                        ) : (
                          <span className="text-red-700">{p.raw.vc_full_name || "—"}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-stone-600 num">
                        {p.raw.surgery_date || "—"}
                      </td>
                      <td className="px-4 py-3 text-sm text-stone-600">
                        {p.raw.procedure_label || "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {p.errors.length > 0 ? (
                          <span className="text-red-700">{p.errors.join("; ")}</span>
                        ) : p.duplicate_of ? (
                          <span className="text-amber-700">
                            Duplicate of existing case
                          </span>
                        ) : (
                          <span className="text-emerald-700">Ready</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
