"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { CaptureBanner, StatusChip } from "@/components/capture/CaptureChrome";
import { SurgicalCaptureNav } from "@/components/capture/SurgicalCaptureNav";
import { SHEET_FORM_FIELDS, type SheetFormField } from "@/lib/capture/sheet-form";
import { AbxChip, ReviewChip } from "../SheetsClient";

interface SheetDetail {
  id: string;
  capture_id: string;
  hospital_code: string;
  review_status: string;
  capture_status: string;
  doc_type: string | null;
  prompt_version: string;
  classify_confidence: number | null;
  extract_confidence: number | null;
  fields: Record<SheetFormField["key"], string>;
  abx_label: string;
  abx_on_time: boolean;
  image_path: string;
  content_type: string;
  provenance: string;
  uploaded_by: string | null;
  uploaded_at: string;
  title: string;
  case_link_label: string;
  review_note: string | null;
  editable: boolean;
}

export function SheetDetailClient({ id }: { id: string }) {
  const [sheet, setSheet] = useState<SheetDetail | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/capture/sheets/${id}`)
      .then((response) => response.json())
      .then((json: { ok?: boolean; error?: string; sheet?: SheetDetail }) => {
        if (cancelled) return;
        if (!json.ok || !json.sheet) {
          setError(json.error || "OT sheet not found.");
          return;
        }
        setSheet(json.sheet);
        setFields(json.sheet.fields);
        setNote(json.sheet.review_note ?? "");
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the OT sheet.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function review(decision: "approved" | "rejected") {
    if (!sheet?.editable || busy) return;
    setBusy(decision);
    setError(null);
    try {
      const saved = await fetch(`/api/capture/sheets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const savedJson = (await saved.json()) as { ok?: boolean; error?: string; sheet?: SheetDetail };
      if (!saved.ok || !savedJson.ok || !savedJson.sheet) {
        setError(savedJson.error || "Could not save edits.");
        return;
      }
      setSheet(savedJson.sheet);
      setFields(savedJson.sheet.fields);
      const response = await fetch(`/api/capture/sheets/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      const json = (await response.json()) as { ok?: boolean; error?: string; sheet?: SheetDetail };
      if (!response.ok || !json.ok || !json.sheet) {
        setError(json.error || "Could not update the OT sheet.");
        return;
      }
      setSheet(json.sheet);
      setFields(json.sheet.fields);
    } catch {
      setError("Could not update the OT sheet.");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdits() {
    if (!sheet || busy) return;
    setBusy("save");
    setError(null);
    try {
      const response = await fetch(`/api/capture/sheets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const json = (await response.json()) as { ok?: boolean; error?: string; sheet?: SheetDetail };
      if (!response.ok || !json.ok || !json.sheet) {
        setError(json.error || "Could not save edits.");
        return;
      }
      setSheet(json.sheet);
      setFields(json.sheet.fields);
    } catch {
      setError("Could not save edits.");
    } finally {
      setBusy(null);
    }
  }

  const heic = sheet ? /hei[cf]/i.test(sheet.content_type) : false;
  const confidence =
    sheet?.extract_confidence != null ? `extract ${sheet.extract_confidence.toFixed(2)}` : sheet?.classify_confidence != null ? `classify ${sheet.classify_confidence.toFixed(2)}` : null;

  return (
    <>
      <TopNav />
      <CaptureBanner kicker="Stage 2" note="human review" />
      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-7">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-stone-500">
          <Link href="/surgical-governance" className="font-medium text-brand hover:underline">
            Surgical Governance
          </Link>
          <span>/</span>
          <Link href="/surgical-governance/ot-sheets" className="font-medium text-brand hover:underline">
            OT sheets
          </Link>
          <span>/</span>
          <span className="font-semibold text-stone-900">{sheet?.title || "Sheet"}</span>
        </div>
        <SurgicalCaptureNav current="sheets" />
        <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight">
          OT sheet{sheet ? ` · ${sheet.title}` : ""}
          {sheet && <StatusChip status={sheet.capture_status} />}
          {sheet && <ReviewChip status={sheet.review_status} />}
        </h1>
        <p className="mb-4 mt-1 max-w-3xl text-sm leading-relaxed text-stone-500">
          {sheet
            ? `${sheet.hospital_code}${sheet.fields.surgery_name ? ` · ${sheet.fields.surgery_name}` : ""}${confidence ? ` · ${confidence}` : ""}. Fields are editable until you approve or reject.`
            : "Loading the extracted sheet."}
        </p>
        {sheet && (
          <p className="mb-4 text-xs text-stone-400">
            Prompt {sheet.prompt_version}
            {sheet.doc_type ? ` · ${sheet.doc_type}` : ""}
          </p>
        )}

        <div className="mb-4 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm leading-relaxed text-teal-900">
          Human review is required before this sheet is approved. The image stays beside the fields.
          <span className="ml-1 italic">{sheet?.case_link_label || "Surgical case · not linked (Stage 3)"}.</span>
        </div>

        {error && <p className="mb-4 text-sm text-red-800">{error}</p>}

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
              <h2 className="text-sm font-semibold">Sheet image</h2>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-500">
                1 of 1
              </span>
            </div>
            <div className="p-4">
              <div className="flex min-h-[420px] items-center justify-center rounded-xl border border-dashed border-stone-300 bg-stone-50 p-4">
                {!sheet || imageFailed || heic ? (
                  <div className="text-center text-sm text-stone-500">
                    <div className="mb-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-900">
                      OT tracking sheet photo
                    </div>
                    <p>{heic ? "HEIC preview is not available in this browser. The file is stored." : "Image unavailable."}</p>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={sheet.image_path}
                    alt="OT tracking sheet"
                    className="max-h-[640px] w-full rounded-lg object-contain"
                    onError={() => setImageFailed(true)}
                  />
                )}
              </div>
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-stone-500">
                {sheet?.provenance || "Provenance —"}
                {sheet?.uploaded_at ? ` · uploaded ${sheet.uploaded_at}` : ""}
                {sheet?.uploaded_by ? ` · by “${sheet.uploaded_by}”` : ""}
              </p>
              {sheet && (
                <p className="mt-2 text-xs">
                  <Link href={`/surgical-governance/capture-queue/${sheet.capture_id}`} className="font-medium text-brand hover:underline">
                    Source capture
                  </Link>
                </p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-stone-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
              <h2 className="text-sm font-semibold">Extracted fields</h2>
              {sheet && <AbxChip label={sheet.abx_label} onTime={sheet.abx_on_time} />}
            </div>
            <div className="p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SHEET_FORM_FIELDS.map((field) => (
                  <label key={field.key} className={field.full ? "sm:col-span-2" : ""}>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">{field.label}</span>
                    {field.wide ? (
                      <textarea
                        value={fields[field.key] ?? ""}
                        rows={2}
                        disabled={!sheet?.editable || Boolean(busy)}
                        onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))}
                        className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft disabled:bg-stone-50"
                      />
                    ) : (
                      <input
                        value={fields[field.key] ?? ""}
                        disabled={!sheet?.editable || Boolean(busy)}
                        onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))}
                        className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft disabled:bg-stone-50"
                      />
                    )}
                  </label>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-4">
                <button
                  type="button"
                  disabled={!sheet?.editable || Boolean(busy)}
                  onClick={() => void review("approved")}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy === "approved" ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  disabled={!sheet?.editable || Boolean(busy)}
                  onClick={() => void review("rejected")}
                  className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy === "rejected" ? "Rejecting…" : "Reject"}
                </button>
                <button
                  type="button"
                  disabled={!sheet?.editable || Boolean(busy)}
                  onClick={() => void saveEdits()}
                  className="rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-800 disabled:opacity-50"
                >
                  {busy === "save" ? "Saving…" : "Save edits"}
                </button>
                <span className="text-xs text-stone-500">{sheet?.case_link_label || "Surgical case · not linked (Stage 3)"}</span>
              </div>
              <label className="mt-3 block">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Review note (optional)</span>
                <input
                  value={note}
                  maxLength={200}
                  disabled={!sheet?.editable || Boolean(busy)}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why you approved or rejected"
                  className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft disabled:bg-stone-50"
                />
              </label>
              {sheet?.review_note && !sheet.editable && (
                <p className="mt-3 text-sm text-stone-600">Note: {sheet.review_note}</p>
              )}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
