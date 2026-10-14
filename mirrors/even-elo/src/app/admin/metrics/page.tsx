"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface PreviewSample {
  email: string;
  hospital: string;
  year: number;
  month: number;
  opd: number | null;
  ipd: number | null;
  ot: number | null;
  revenue: number | null;
}

interface PreviewResp {
  ok: boolean;
  mode?: "preview" | "commit";
  parsed_count?: number;
  valid_count?: number;
  errors?: string[];
  sample?: PreviewSample[];
}

interface CommitResp {
  ok: boolean;
  inserted?: number;
  skipped?: number;
  errors?: string[];
  file_hash?: string;
  error?: string;
}

export default function MetricsUploadPage() {
  const [csv, setCsv] = useState<string>("");
  const [filename, setFilename] = useState<string>("");
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<CommitResp | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pickFile(file: File | null) {
    if (!file) return;
    setFilename(file.name);
    setCommitted(null);
    setPreview(null);
    const text = await file.text();
    setCsv(text);
  }

  async function dryRun() {
    setCommitted(null);
    const r = await fetch("/api/admin/clinical-metrics/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv, mode: "preview", source_file: filename }),
    });
    const j = (await r.json()) as PreviewResp;
    setPreview(j);
  }

  async function commit() {
    if (!preview || !preview.ok) return;
    setCommitting(true);
    try {
      const r = await fetch("/api/admin/clinical-metrics/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, mode: "commit", source_file: filename }),
      });
      const j = (await r.json()) as CommitResp;
      setCommitted(j);
    } finally {
      setCommitting(false);
    }
  }

  function reset() {
    setCsv("");
    setFilename("");
    setPreview(null);
    setCommitted(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <>
      <TopNav />
      <main className="max-w-[1100px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/admin" className="hover:text-stone-900">Admin</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">Clinical metrics upload</span>
        </div>
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Clinical metrics</h1>
            <div className="text-sm text-stone-500 mt-1">
              Monthly CSV: physician_email · hospital_code · year · month · opd · ipd · ot · revenue.
              {" "}<a href="/api/admin/clinical-metrics/template" className="text-brand font-medium">Download template</a>.
            </div>
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">CSV file</label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              className="text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-stone-100 file:text-stone-700 file:text-xs file:font-medium hover:file:bg-stone-200"
            />
            {filename && (
              <div className="text-xs text-stone-500 mt-1">{filename} · {csv.length.toLocaleString()} chars</div>
            )}
          </div>

          {csv && (
            <div className="flex items-center gap-2">
              <button
                onClick={dryRun}
                className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover"
              >
                Preview
              </button>
              <button onClick={reset} className="btn-ghost">Reset</button>
            </div>
          )}

          {preview && (
            <div className="border-t border-stone-100 pt-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-sm font-semibold">Preview</div>
                  <div className="text-xs text-stone-500 mt-0.5">
                    {preview.parsed_count ?? 0} parsed · {preview.valid_count ?? 0} valid · {preview.errors?.length ?? 0} errors
                  </div>
                </div>
                {preview.ok && preview.valid_count! > 0 && !committed && (
                  <button
                    onClick={commit}
                    disabled={committing}
                    className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-60"
                  >
                    {committing ? "Committing…" : `Commit ${preview.valid_count} rows`}
                  </button>
                )}
              </div>

              {preview.errors && preview.errors.length > 0 && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3 max-h-40 overflow-y-auto">
                  <div className="font-medium mb-1">Errors</div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {preview.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}

              {preview.sample && preview.sample.length > 0 && (
                <table className="w-full text-xs border border-stone-200 rounded-lg overflow-hidden">
                  <thead className="bg-stone-50">
                    <tr className="text-left text-[11px] font-medium text-stone-500 uppercase tracking-wider">
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Hosp</th>
                      <th className="px-3 py-2">Year</th>
                      <th className="px-3 py-2">Mo</th>
                      <th className="px-3 py-2 text-right">OPD</th>
                      <th className="px-3 py-2 text-right">IPD</th>
                      <th className="px-3 py-2 text-right">OT</th>
                      <th className="px-3 py-2 text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {preview.sample.map((s, i) => (
                      <tr key={i} className="text-stone-700">
                        <td className="px-3 py-1.5">{s.email}</td>
                        <td className="px-3 py-1.5">{s.hospital}</td>
                        <td className="px-3 py-1.5 num">{s.year}</td>
                        <td className="px-3 py-1.5 num">{String(s.month).padStart(2, "0")}</td>
                        <td className="px-3 py-1.5 text-right num">{s.opd ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right num">{s.ipd ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right num">{s.ot ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right num">{s.revenue?.toLocaleString("en-IN") ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.sample && preview.sample.length === 0 && preview.parsed_count! > 0 && (
                <div className="text-xs text-stone-500 italic">All rows had errors — none would be inserted.</div>
              )}
            </div>
          )}

          {committed && (
            <div className={`mt-4 p-4 rounded-lg border ${committed.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
              {committed.ok ? (
                <>
                  <div className="text-sm font-medium text-emerald-800">
                    ✓ Inserted {committed.inserted} rows
                    {committed.skipped ? ` · skipped ${committed.skipped} duplicate(s)` : ""}
                  </div>
                  {committed.file_hash && (
                    <div className="text-[11px] text-emerald-700 mt-1 mono">sha256: {committed.file_hash}</div>
                  )}
                </>
              ) : (
                <div className="text-sm font-medium text-red-700">Upload failed: {committed.error}</div>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
