"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { CaptureBanner, StatusChip } from "@/components/capture/CaptureChrome";
import { SurgicalCaptureNav } from "@/components/capture/SurgicalCaptureNav";

interface CaptureItem {
  id: string;
  title: string;
  subtitle: string;
  provenance: string;
  status: string;
  image_path: string;
  content_type: string;
  bytes: number;
  hospital_code: string;
  uploaded_by: string | null;
  void_reason: string | null;
  voided_at: string | null;
  doc_type: string | null;
  ocr_error: string | null;
}

export function DetailClient({ id }: { id: string }) {
  const [row, setRow] = useState<CaptureItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/capture/${id}`)
      .then((response) => response.json())
      .then((json: { ok?: boolean; error?: string; capture?: CaptureItem; sheet_id?: string | null }) => {
        if (!json.ok || !json.capture) {
          setError(json.error || "Capture not found.");
          return;
        }
        setRow(json.capture);
        setSheetId(json.sheet_id ?? null);
      })
      .catch(() => setError("Could not load the capture."));
  }, [id]);

  async function voidJunk() {
    if (!row || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/capture/${id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const json = (await response.json()) as { ok?: boolean; error?: string; capture?: CaptureItem };
      if (!response.ok || !json.ok || !json.capture) {
        setError(json.error || "Could not void this capture.");
        return;
      }
      setRow(json.capture);
    } catch {
      setError("Could not void this capture.");
    } finally {
      setBusy(false);
    }
  }

  const heic = row ? /hei[cf]/i.test(row.content_type) : false;
  const canVoid = row?.status === "queued" || row?.status === "stored";

  return (
    <>
      <TopNav />
      <CaptureBanner />
      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-7">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-stone-500">
          <Link href="/surgical-governance" className="font-medium text-brand hover:underline">
            Surgical Governance
          </Link>
          <span>/</span>
          <Link href="/surgical-governance/capture-queue" className="font-medium text-brand hover:underline">
            Capture queue
          </Link>
          <span>/</span>
          <span className="font-semibold text-stone-900">Image</span>
        </div>
        <SurgicalCaptureNav current="detail" />
        <h1 className="flex flex-wrap items-center gap-2 text-[1.45rem] font-bold tracking-tight">
          {row?.title || "Capture"}
          {row && <StatusChip status={row.status} />}
        </h1>
        <p className="mb-4 mt-1 text-sm text-stone-500">{row?.subtitle || "Stored image."}</p>

        <div className="mb-4 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm leading-relaxed text-teal-900">
          Void here only drops a junk upload that is still queued. Extracted fields are reviewed on OT sheets.
          Nothing is written to a surgical case.
          {sheetId && (
            <>
              {" "}
              <Link href={`/surgical-governance/ot-sheets/${sheetId}`} className="font-semibold text-brand hover:underline">
                Open the extracted sheet
              </Link>
            </>
          )}
        </div>

        {error && <p className="mb-4 text-sm text-red-800">{error}</p>}

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
              <h2 className="text-sm font-semibold">Sheet image</h2>
              <span className="text-xs text-stone-400">1 of 1</span>
            </div>
            <div className="flex min-h-[420px] items-center justify-center bg-stone-100 p-4">
              {!row || imageFailed ? (
                <div className="text-center text-sm text-stone-500">
                  <div className="mb-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-900">
                    Stored image
                  </div>
                  <p>{heic ? "HEIC preview is not available in this browser. The file is stored." : "Image unavailable."}</p>
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={row.image_path}
                  alt="Stored OT tracking sheet"
                  className="max-h-[640px] w-full rounded-lg object-contain"
                  onError={() => setImageFailed(true)}
                />
              )}
            </div>
          </section>

          <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold">Provenance</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Who uploaded</dt>
                <dd>{row?.uploaded_by || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Hospital</dt>
                <dd>{row?.hospital_code || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Provenance</dt>
                <dd className="font-mono text-xs text-stone-600">{row?.provenance || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Bytes</dt>
                <dd>{row ? row.bytes.toLocaleString("en-IN") : "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">OCR</dt>
                <dd>
                  {row?.doc_type || "—"}
                  {row?.ocr_error ? ` · ${row.ocr_error}` : ""}
                </dd>
              </div>
              {row?.void_reason && (
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Void reason</dt>
                  <dd>{row.void_reason}</dd>
                </div>
              )}
            </dl>
            {canVoid && (
              <div className="mt-5 border-t border-stone-200 pt-4">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-stone-500" htmlFor="void-reason">
                  Void reason (optional)
                </label>
                <input
                  id="void-reason"
                  value={reason}
                  maxLength={200}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Junk, duplicate, unreadable…"
                  className="mt-1 w-full rounded-md border border-stone-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void voidJunk()}
                  className="mt-3 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? "Voiding…" : "Void junk"}
                </button>
              </div>
            )}
            <p className="mt-4 rounded-md border border-dashed border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-500">
              Surgical case link — not linked (Stage 3).
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
