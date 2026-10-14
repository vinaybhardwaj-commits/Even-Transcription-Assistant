export function CaptureBanner({ kicker = "Stage 1", note = "store only" }: { kicker?: string; note?: string }) {
  return (
    <div className="bg-stone-900 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-50">
      <span className="text-teal-300">{kicker}</span>
      <span> · OT Sheet Capture · {note}</span>
    </div>
  );
}

const HOSPITALS = ["EHRC", "EHBR", "EHBO", "EHIN"] as const;

export function HospitalSwitcher({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  return (
    <div className="ml-auto flex gap-1" role="group" aria-label="Hospital">
      {HOSPITALS.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => onChange(code)}
          className={
            "rounded-md border px-2.5 py-1 text-[12px] font-semibold " +
            (value === code
              ? "border-brand bg-brand text-white shadow-sm"
              : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50")
          }
        >
          {code}
        </button>
      ))}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone =
    status === "queued" || status === "stored"
      ? "bg-indigo-100 text-indigo-800"
      : status === "processing"
        ? "bg-amber-100 text-amber-900"
        : status === "needs_review"
          ? "bg-orange-100 text-orange-900"
          : status === "extracted" || status === "classified"
            ? "bg-emerald-100 text-emerald-800"
            : status === "voided" || status === "failed"
              ? "bg-red-100 text-red-800"
              : "bg-stone-100 text-stone-600";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>
      {status}
    </span>
  );
}
