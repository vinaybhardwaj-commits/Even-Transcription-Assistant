import * as React from "react";
import type { Light } from "@/lib/enc/view";

/** ENC stages on /admin/system-map (contract UI item 5): one green or red light per stage. Text carries the state too, not colour alone. */
export function EncLights({ lights }: { lights: Light[] }) {
  return (
    <section aria-label="ENC stages" className="bg-even-white rounded-xl border border-even-ink-200 p-4 mb-4" data-testid="enc-lights">
      <p className="text-label font-semibold text-even-navy-800 mb-1">ENC - daily encounter isolation</p>
      <p className="text-caption text-even-ink-500 mb-3">Box export to R2, ETA sync, steward. Green = recent and healthy.</p>
      <ul className="space-y-2">
        {lights.map((l) => (
          <li key={l.key} className="flex items-center gap-3 text-caption text-even-navy-800">
            <span
              className={`inline-block h-3 w-3 rounded-full shrink-0 ${l.ok ? "bg-green-600" : "bg-red-600"}`}
              role="img"
              aria-label={l.ok ? "green" : "red"}
              data-light={l.ok ? "green" : "red"}
            />
            <span className="font-medium">{l.title}</span>
            <span className="text-even-ink-500">{l.ok ? "ok" : "stale"} - {l.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
