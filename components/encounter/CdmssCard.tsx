"use client";

import * as React from "react";
import type { CdmssOutput } from "@/lib/cdmss-stub";
import type { CdmssRich, CitedItem, CitedDdx, CdmssSource } from "@/lib/cdmss-pipeline";

type Item = string | CitedItem;
type Ddx = { dx: string; why: string; cites?: number[] };

/**
 * Renders both the rich CDMSS shape (from the real pipeline with
 * citations) and the legacy stub shape (string arrays, no cites) by
 * normalizing on read.
 */
export function CdmssCard({ cdmss }: { cdmss: CdmssOutput | CdmssRich }) {
  const rich = cdmss as Partial<CdmssRich>;
  const sources: CdmssSource[] = Array.isArray(rich.sources) ? rich.sources : [];

  const ddxItems: Ddx[] = ((cdmss.differentials_to_consider ?? []) as (Ddx | CitedDdx)[]).map((d) => ({
    dx: d.dx,
    why: d.why,
    cites: "cites" in d && Array.isArray(d.cites) ? d.cites : [],
  }));
  const rfItems: Item[] = (cdmss.red_flags ?? []) as Item[];
  const sgItems: Item[] = (cdmss.evidence_based_suggestions ?? []) as Item[];
  const fuItems: Item[] = (cdmss.follow_up_considerations ?? []) as Item[];

  const isEmpty =
    ddxItems.length === 0 && rfItems.length === 0 && sgItems.length === 0 && fuItems.length === 0;

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

      {ddxItems.length > 0 ? (
        <div>
          <p className="text-caption uppercase tracking-wide text-ai-700 mb-2">
            Differentials to consider
          </p>
          <ul className="space-y-2">
            {ddxItems.map((d, i) => (
              <li key={i} className="text-body">
                <span className="font-semibold text-even-ink-800">{d.dx}</span>
                {d.why ? <span className="text-even-ink-700"> — {d.why}</span> : null}
                {d.cites && d.cites.length > 0 ? (
                  <CiteChips cites={d.cites} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rfItems.length > 0 ? (
        <Section
          title="Red flags"
          color="text-danger-700"
          items={rfItems}
        />
      ) : null}
      {sgItems.length > 0 ? (
        <Section
          title="Evidence-based suggestions"
          color="text-ai-700"
          items={sgItems}
        />
      ) : null}
      {fuItems.length > 0 ? (
        <Section
          title="Follow-up considerations"
          color="text-ai-700"
          items={fuItems}
        />
      ) : null}

      {sources.length > 0 ? <SourcesPanel sources={sources} /> : null}
    </div>
  );
}

function Section({
  title,
  color,
  items,
}: {
  title: string;
  color: string;
  items: Item[];
}) {
  return (
    <div>
      <p className={`text-caption uppercase tracking-wide ${color} mb-2`}>{title}</p>
      <ul className="list-disc pl-5 text-body text-even-ink-800 space-y-1">
        {items.map((it, i) => {
          if (typeof it === "string") return <li key={i}>{it}</li>;
          return (
            <li key={i}>
              {it.text}
              {it.cites && it.cites.length > 0 ? <CiteChips cites={it.cites} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CiteChips({ cites }: { cites: number[] }) {
  return (
    <span className="ml-2 inline-flex gap-1 align-baseline">
      {cites.map((c) => (
        <a
          key={c}
          href={`#source-${c}`}
          className="text-caption text-ai-700 bg-ai-200/70 hover:bg-ai-200 rounded px-1.5 py-0.5 no-underline"
        >
          [{c}]
        </a>
      ))}
    </span>
  );
}

function SourcesPanel({ sources }: { sources: CdmssSource[] }) {
  return (
    <details className="pt-3 border-t border-ai-200">
      <summary className="cursor-pointer text-caption uppercase tracking-wide text-ai-700">
        Sources ({sources.length})
      </summary>
      <ol className="mt-2 space-y-2 list-none pl-0">
        {sources.map((s) => (
          <li id={`source-${s.index}`} key={s.index} className="text-body">
            <p className="text-caption text-even-ink-500 mb-1">
              <span className="font-mono text-ai-700">[{s.index}]</span>{" "}
              <span className="font-semibold text-even-ink-700">{s.book ?? "—"}</span>
              {s.chapter ? <> · {s.chapter}</> : null}
              {s.section ? <> · {s.section}</> : null}
              {s.page_start ? (
                <>
                  {" "}
                  · pp.{s.page_start}
                  {s.page_end ? `-${s.page_end}` : ""}
                </>
              ) : null}
              {typeof s.similarity === "number" ? (
                <> · sim {s.similarity.toFixed(2)}</>
              ) : null}
            </p>
            <p className="text-caption text-even-ink-700 leading-relaxed whitespace-pre-line">
              {s.excerpt}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}
