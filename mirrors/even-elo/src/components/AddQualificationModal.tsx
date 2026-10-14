"use client";

import { useState } from "react";

const TIERS = ["A", "B", "C", "Unknown"] as const;
const ALLOWED_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip "data:<mime>;base64," prefix
      const idx = result.indexOf(",");
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function AddQualificationModal({
  physicianId,
  onClose,
  onSaved,
}: {
  physicianId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [degree, setDegree] = useState("");
  const [institution, setInstitution] = useState("");
  const [tier, setTier] = useState<string>("Unknown");
  const [year, setYear] = useState<string>("");
  const [country, setCountry] = useState("India");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickFile(f: File | null) {
    setError(null);
    if (!f) return setFile(null);
    const mime = f.type === "image/jpg" ? "image/jpeg" : f.type;
    if (!ALLOWED_MIME.has(mime)) {
      setError("Only PDF, PNG, JPEG allowed.");
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError(`File is ${(f.size / 1024 / 1024).toFixed(2)} MB — max 2 MB.`);
      return;
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!degree.trim()) {
      setError("Degree is required.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      let payload: Record<string, unknown> = {
        degree: degree.trim(),
        institution: institution.trim() || null,
        institution_tier: tier || null,
        year_completed: year ? parseInt(year, 10) : null,
        country: country.trim() || null,
      };
      if (file) {
        const data = await fileToBase64(file);
        const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
        payload = {
          ...payload,
          file: { filename: file.name, mime, size_bytes: file.size, data },
        };
      }
      const r = await fetch(`/api/physicians/${physicianId}/qualifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not save qualification.");
        setSubmitting(false);
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[520px] shadow-xl">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Add qualification</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Degree *</label>
            <input
              type="text"
              value={degree}
              onChange={(e) => setDegree(e.target.value)}
              placeholder="MBBS, MD General Medicine, MS Orthopaedics, DM Cardiology…"
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Institution</label>
            <input
              type="text"
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              placeholder="AIIMS New Delhi, KMC Manipal, JIPMER…"
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Tier</label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              >
                {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Year</label>
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                min="1950"
                max={new Date().getFullYear()}
                placeholder="2014"
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Country</label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Certificate (PDF / PNG / JPEG, max 2 MB)</label>
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-stone-100 file:text-stone-700 file:text-xs file:font-medium hover:file:bg-stone-200"
            />
            {file && (
              <div className="text-xs text-stone-500 mt-1">{file.name} · {(file.size / 1024).toFixed(0)} KB</div>
            )}
          </div>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
              {submitting ? "Saving…" : "Add qualification"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
