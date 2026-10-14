'use client';

/**
 * CCB v2 P2 — the split-screen brief (mockup view ②).
 *
 *   LEFT   the source document: a switcher across the episode's documents, each framed in an
 *          <iframe>. Order-only episodes (no prescription PDF) fall back to the parsed encounter
 *          text rendered as a "paper" sheet, matching the mockup's facsimile.
 *   RIGHT  <CareBriefClient/> — reused UNCHANGED, which in turn renders CcbBriefView unchanged.
 *
 * The CAT sidebar collapses for this route via the shell's existing `fullBleed` mechanism
 * (components/Shell.tsx) — the same one Review Mode uses. Nothing about the shell is forked.
 *
 * PHI: the document URLs and the member chip are join-back data the /care role is authorized to
 * see. They are never sent to any model; the brief pane stays de-identified as today.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import CareBriefClient from './CareBriefClient';
import MemberStateCallContext from './MemberStateCallContext';
import CallPanel from './CallPanel';
import type { MemberVitals } from '@/lib/member-state/vitals-read';

interface EpisodeDoc {
  kind: string;
  label: string;
  url: string;
  processedUrl: string | null;
}
interface Encounter {
  presentingComplaint: string | null;
  diagnoses: string[];
  investigations: string[];
  planOfManagement: string | null;
}
interface Member {
  individualUid: string | null;
  uhid: string | null;
  noteDate: string | null;
}

const ICON: Record<string, string> = {
  prescription: '℞',
  radiology: '📄',
  diagnostic: '🧪',
  hcu: '🩺',
};

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'source'; }
}

/** PDF open-parameters so the browser viewer hides its thumbnail rail + toolbar and fits width
 *  (continuous, single-column, page-by-page scroll). Applied to the iframe SRC only — frameSrc stays raw. */
const pdfSrc = (u: string) => (u.includes('#') ? u : `${u}#toolbar=0&navpanes=0&view=FitH`);

/** The parsed encounter note, rendered as the mockup's "paper" sheet (order-only fallback). */
function EncounterPaper({ enc, noteDate }: { enc: Encounter | null; noteDate: string | null }) {
  const Field = ({ label, value }: { label: string; value: string }) =>
    value ? (
      <div className="mb-[11px]">
        <div className="text-[9.5px] font-bold uppercase tracking-[0.05em] text-slate-400">{label}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-slate-800">{value}</div>
      </div>
    ) : null;

  const hasAny =
    !!enc && (enc.presentingComplaint || enc.planOfManagement || enc.diagnoses.length || enc.investigations.length);

  return (
    <div className="h-max w-full max-w-[520px] rounded-sm bg-white px-8 py-7 shadow-[0_6px_24px_rgba(0,0,0,.35)]">
      <div className="mb-3.5 flex justify-between border-b-2 border-teal-600 pb-2.5">
        <div>
          <h3 className="text-[15px] font-semibold text-teal-700">Encounter note</h3>
          <p className="text-[10.5px] text-slate-500">Parsed from the record</p>
        </div>
        <div className="text-right text-[10.5px] text-slate-500">{noteDate || ''}</div>
      </div>
      {hasAny ? (
        <>
          <Field label="Presenting complaint / history" value={enc!.presentingComplaint || ''} />
          <Field label="Diagnosis / impression" value={enc!.diagnoses.join(' · ')} />
          <Field label="Investigations advised" value={enc!.investigations.join(' · ')} />
          <Field label="Plan / referral" value={enc!.planOfManagement || ''} />
        </>
      ) : (
        <p className="text-[12.5px] text-slate-500">No encounter text was parsed for this episode.</p>
      )}
      <p className="mt-5 border-t border-slate-100 pt-2.5 text-[10.5px] italic text-slate-400">
        No source PDF is attached to this episode — this is the parsed encounter text, not a facsimile of the
        original document.
      </p>
    </div>
  );
}

export default function CareBriefSplit({ uid, memberStateUi = false, careCallUi = false, vitals }: { uid: string; memberStateUi?: boolean; careCallUi?: boolean; vitals?: MemberVitals }) {
  const [docs, setDocs] = useState<EpisodeDoc[] | null>(null);
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [active, setActive] = useState(0);
  const [docErr, setDocErr] = useState<string>('');

  useEffect(() => {
    let alive = true;
    fetch(`/api/ccb/episode-docs?uid=${encodeURIComponent(uid)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setDocs(Array.isArray(j.docs) ? j.docs : []);
        setEncounter(j.encounter ?? null);
        setMember(j.member ?? null);
        if (j.ok === false) setDocErr(String(j.error || 'Could not load the source documents.'));
      })
      .catch(() => {
        if (!alive) return;
        setDocs([]);
        setDocErr('Could not load the source documents.');
      });
    return () => { alive = false; };
  }, [uid]);

  const current = docs && docs.length ? docs[Math.min(active, docs.length - 1)] : null;
  const frameSrc = current ? current.processedUrl || current.url : null;
  const backHref = member?.individualUid ? `/care/m/${encodeURIComponent(member.individualUid)}` : '/care';

  return (
    <div className="flex h-screen flex-col" style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* corner bar — back + member chip + episode meta */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-2 pl-14">
        <Link href={backHref} className="inline-flex items-center gap-1 text-[12.5px] text-teal-700 hover:text-teal-800">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to member
        </Link>
        {member?.uhid && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11.5px] font-medium text-slate-600">
            UHID {member.uhid}
          </span>
        )}
        <span className="ml-auto text-[11.5px] text-slate-400">
          Episode {uid}
          {member?.noteDate ? ` · ${member.noteDate}` : ''}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* ── LEFT: source document ───────────────────────────────────────── */}
        <div className="flex min-h-[50vh] flex-col border-slate-300 bg-[#525659] md:min-h-0 md:flex-[1.05] md:border-r">
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2 bg-[#33373b] px-3 py-2">
            <span className="inline-flex flex-wrap rounded-md bg-[#22262a] p-[3px]">
              {docs === null ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-[5px] text-[11.5px] text-slate-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading documents…
                </span>
              ) : docs.length === 0 ? (
                <span className="px-2.5 py-[5px] text-[11.5px] font-semibold text-slate-400">
                  {ICON.prescription} Encounter note
                </span>
              ) : (
                docs.map((d, i) => (
                  <button
                    key={d.url}
                    type="button"
                    onClick={() => setActive(i)}
                    className={
                      'whitespace-nowrap rounded-[5px] px-2.5 py-[5px] text-[11.5px] font-semibold ' +
                      (i === active ? 'bg-teal-600 text-white' : 'text-slate-400 hover:text-slate-200')
                    }
                  >
                    {ICON[d.kind] || '📄'} {d.label}
                  </button>
                ))
              )}
            </span>
            <span className="ml-auto text-[11px] text-slate-400">
              {frameSrc ? `live PDF · ${hostOf(frameSrc)}` : 'parsed text · no source PDF'}
            </span>
          </div>

          <div className="flex flex-1 justify-center overflow-auto p-5">
            {frameSrc ? (
              <iframe
                key={frameSrc}
                src={pdfSrc(frameSrc)}
                title={current?.label || 'Source document'}
                className="h-full w-full rounded-sm border-0 bg-white shadow-[0_6px_24px_rgba(0,0,0,.35)]"
              />
            ) : (
              <EncounterPaper enc={encounter} noteDate={member?.noteDate ?? null} />
            )}
          </div>

          {docErr && (
            <div className="flex-shrink-0 bg-[#33373b] px-3 py-1.5 text-[11px] text-amber-300">
              <FileText className="mr-1 inline h-3 w-3" />
              {docErr}
            </div>
          )}
        </div>

        {/* ── RIGHT: the brief, unchanged ─────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-auto bg-white">
          <div className="mx-auto max-w-3xl px-5 py-6">
            {memberStateUi && <MemberStateCallContext prescUid={uid} vitals={vitals} encounter={encounter} />}
            <CareBriefClient uid={uid} />
            {careCallUi && <CallPanel prescUid={uid} />}
          </div>
        </div>
      </div>
    </div>
  );
}
