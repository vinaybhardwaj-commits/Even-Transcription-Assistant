import Link from "next/link";
import { SurgicalCaptureNav } from "@/components/capture/SurgicalCaptureNav";
import { TopNav } from "@/components/TopNav";
import { HeadlineStrip, type HeadlineStat } from "@/components/shell/HeadlineStrip";
import { adherencePresentation, outcomesLabContext, type EloCounts } from "@/lib/overview-modules";

/**
 * Surgical ELO when production tables are empty (or unreadable).
 * No VC list, no composite chart, no adherence percent.
 */
export function SurgicalEloEmpty({ counts }: { counts: EloCounts | null }) {
  const adherence = adherencePresentation();
  const lab = outcomesLabContext();
  const unavailable = counts === null;

  const stats: HeadlineStat[] = unavailable
    ? [
        { label: "Visiting consultants (VCs)", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "Surgical cases", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "Score snapshots", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "VC observation cases", value: "—", hint: "Counts unavailable", tone: "muted" },
      ]
    : [
        { label: "Visiting consultants (VCs)", value: String(counts.vcs), hint: "LIVE · table vcs", tone: "muted" },
        { label: "Surgical cases", value: String(counts.cases), hint: "LIVE · surgical_cases", tone: "muted" },
        { label: "Score snapshots", value: String(counts.snapshots), hint: "LIVE · score_snapshots", tone: "muted" },
        { label: "VC observation cases", value: String(counts.observationCases), hint: "LIVE · vc_observation_cases", tone: "muted" },
      ];

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1180px] px-6 py-8 lg:px-8">
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px] text-stone-500">
          <Link href="/overview" className="font-medium text-brand hover:underline">
            Overview
          </Link>
          <span className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">Surgical ELO</span>
        </div>
        <SurgicalCaptureNav current="home" />

        <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight text-stone-900">
          Surgical ELO
          <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
            {unavailable ? "Unavailable" : "Empty"}
          </span>
        </h1>
        <p className="mb-5 mt-1 max-w-3xl text-sm leading-relaxed text-stone-500">
          {unavailable
            ? "Live table counts could not be read. Volumes are omitted rather than shown as zero."
            : "Honest production empty-state. Counts come from the VC, case, and score tables — no fabricated visiting consultants, cases, or ELO scores."}
        </p>

        <HeadlineStrip stats={stats} />

        <div className="mb-5 rounded-[10px] border border-teal-200 bg-teal-50 px-4 py-3 text-[13.5px] leading-relaxed text-teal-900">
          <strong className="font-semibold">PRD honesty: </strong>
          Do not invent VCs or caseload from document audits. <strong>Adherence</strong> is{" "}
          {adherence.state === "empty" ? "empty until audits or surgical feedback arrive" : `live (${adherence.label})`}{" "}
          from Stage 4 document audits + surgical feedback.{" "}
          <strong>Outcomes</strong> below are Lab / EHRC cohort context only — not ELO scores.
        </div>

        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
              <h2 className="text-[0.98rem] font-semibold">Caseload</h2>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
                {unavailable ? "— / —" : `${counts.vcs} / ${counts.cases}`}
              </span>
            </div>
            <div className="p-4">
              <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-4 py-7 text-center">
                <div className="text-[0.98rem] font-semibold text-stone-900">
                  {unavailable ? "Caseload counts unavailable" : "No VCs or surgical cases"}
                </div>
                <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-stone-500">
                  {unavailable
                    ? "The vcs and surgical_cases tables could not be counted. Nothing is filled in."
                    : `Production tables count ${counts.vcs} VCs and ${counts.cases} cases. Caseload appears when real VC / case feeds are wired — not from note audits alone.`}
                </p>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
              <h2 className="text-[0.98rem] font-semibold">Outcomes</h2>
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-800">
                Lab-linked
              </span>
            </div>
            <div className="p-4">
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-[13.5px] leading-relaxed text-indigo-950">
                <strong>{lab.label} — {lab.stays} stays</strong> ({lab.lockedNote}).
                <br />
                Shown here as Lab / warehouse context only. This is not a Surgical ELO score and is not inventable from staff notes.
              </div>
              <p className="mt-3 text-[12.5px] leading-relaxed text-stone-500">
                Outcomes stay Lab-rubric / warehouse-driven. This panel does not display an ELO number.
              </p>
            </div>
          </section>
        </div>

        <section className="mb-5 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
          <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
            <h2 className="text-[0.98rem] font-semibold">Adherence</h2>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide " +
                (adherence.state === "live"
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-stone-100 text-stone-600")
              }
            >
              {adherence.label}
            </span>
          </div>
          <div className="p-4">
            {adherence.state === "live" && adherence.percent !== null ? (
              <div>
                <div className="text-[2rem] font-bold tracking-tight text-stone-900">{adherence.percent}%</div>
                <p className="mt-1.5 max-w-lg text-[13px] leading-relaxed text-stone-500">{adherence.detail}</p>
                <p className="mt-2 text-[12px] text-stone-500">{adherence.sourceSummary}</p>
                <Link
                  href="/document-audits"
                  className="mt-3 inline-block text-[12.5px] font-semibold text-brand hover:underline"
                >
                  Document Audits →
                </Link>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-4 py-7 text-center">
                <div className="text-[0.98rem] font-semibold text-stone-900">{adherence.label}</div>
                <p className="mx-auto mt-1.5 max-w-lg text-[13px] leading-relaxed text-stone-500">
                  {adherence.detail} Progress / OT / Discharge audits and surgical feedback feed this leg when
                  present — Stage 4 starts Adherence now (no Stage 5 deferral).
                </p>
                <Link
                  href="/document-audits"
                  className="mt-3 inline-block text-[12.5px] font-semibold text-brand hover:underline"
                >
                  Document Audits →
                </Link>
              </div>
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
          <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
            <h2 className="text-[0.98rem] font-semibold">Scores</h2>
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
              {unavailable ? "Not shown" : `${counts.snapshots} snapshots`}
            </span>
          </div>
          <div className="p-4">
            <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-4 py-7 text-center">
              <div className="text-[0.98rem] font-semibold text-stone-900">
                {unavailable ? "Score counts unavailable" : "No score snapshots"}
              </div>
              <p className="mx-auto mt-1.5 max-w-lg text-[13px] leading-relaxed text-stone-500">
                {unavailable
                  ? "score_snapshots could not be counted. No composite is drawn."
                  : `score_snapshots count is ${counts.snapshots}. Visiting-consultant ratings and composite ELO are not invented.`}
              </p>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
