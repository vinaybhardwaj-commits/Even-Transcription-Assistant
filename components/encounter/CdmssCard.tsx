"use client";

import * as React from "react";
import type { CdmssOutput } from "@/lib/cdmss-stub";

/**
 * Violet "Clinical Decision Support" card. Differential list, red
 * flags, evidence-based suggestions, follow-up considerations. Each
 * sub-section collapses out if empty.
 */
export function CdmssCard({ cdmss }: { cdmss: CdmssOutput }) {
  const isEmpty =
    cdmss.differentials_to_consider.length === 0 &&
    cdmss.red_flags.length === 0 &&
    cdmss.evidence_based_suggestions.length === 0 &&
    cdmss.follow_up_considerations.length === 0;

  if (isEmpty) {
    return (
      <div className="rounded-xl border border-ai-200 bg-ai-50 p-5">
        <h3 className="text-label text-ai-700 mb-1">Clinical Decision Support</h3>
        <p className="text-caption text-ai-700/80">
          No automated suggestions for this encounter.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ai-200 bg-ai-50 p-5 space-y-4">
      <h3 className="text-label text-ai-700">Clinical Decision Support</h3>

      {cdmss.differentials_to_consider.length > 0 ? (
        <div>
          <p className="text-caption uppercase tracking-wide text-ai-700 mb-2">
            Differentials to consider
          </p>
          <ul className="space-y-2">
            {cdmss.differentials_to_consider.map((d, i) => (
              <li key={i} className="text-body">
                <span className="font-semibold text-even-ink-800">{d.dx}</span>
                {d.why ? (
                  <span className="text-even-ink-700"> — {d.why}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {cdmss.red_flags.length > 0 ? (
        <div>
          <p className="text-caption uppercase tracking-wide text-danger-700 mb-2">
            Red flags
          </p>
          <ul className="list-disc pl-5 text-body text-even-ink-800 space-y-0.5">
            {cdmss.red_flags.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {cdmss.evidence_based_suggestions.length > 0 ? (
        <div>
          <p className="text-caption uppercase tracking-wide text-ai-700 mb-2">
            Evidence-based suggestions
          </p>
          <ul className="list-disc pl-5 text-body text-even-ink-800 space-y-0.5">
            {cdmss.evidence_based_suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {cdmss.follow_up_considerations.length > 0 ? (
        <div>
          <p className="text-caption uppercase tracking-wide text-ai-700 mb-2">
            Follow-up considerations
          </p>
          <ul className="list-disc pl-5 text-body text-even-ink-800 space-y-0.5">
            {cdmss.follow_up_considerations.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
