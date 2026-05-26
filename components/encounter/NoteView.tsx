"use client";

import * as React from "react";
import type { EncounterNote } from "@/lib/note-generation";

/**
 * Renders a Medical Encounter Note as a clinical document. Prose
 * sections (HPI, examination, assessment, follow-up) render as
 * paragraphs; list sections (PMH, meds, allergies, plan items) render
 * as bulleted lists. Empty sections collapse out of the way.
 */
export function NoteView({ note }: { note: EncounterNote }) {
  return (
    <article className="space-y-5 text-body text-even-ink-800">
      {note.chief_complaint ? (
        <Section title="Chief complaint">
          <p>{note.chief_complaint}</p>
        </Section>
      ) : null}

      {note.history_present_illness ? (
        <Section title="History of present illness">
          <p className="whitespace-pre-line">{note.history_present_illness}</p>
        </Section>
      ) : null}

      {note.past_medical_history.length > 0 ? (
        <Section title="Past medical history">
          <BulletList items={note.past_medical_history} />
        </Section>
      ) : null}

      {note.current_medications.length > 0 ? (
        <Section title="Current medications">
          <BulletList items={note.current_medications} />
        </Section>
      ) : null}

      {note.allergies.length > 0 ? (
        <Section title="Allergies">
          <BulletList items={note.allergies} />
        </Section>
      ) : null}

      {note.examination ? (
        <Section title="Examination">
          <p className="whitespace-pre-line">{note.examination}</p>
        </Section>
      ) : null}

      {note.assessment ? (
        <Section title="Assessment">
          <p className="whitespace-pre-line">{note.assessment}</p>
        </Section>
      ) : null}

      {note.plan.investigations.length > 0 ||
      note.plan.treatment.length > 0 ||
      note.plan.follow_up ? (
        <Section title="Plan">
          {note.plan.investigations.length > 0 ? (
            <>
              <p className="text-label text-even-ink-500 mt-1 mb-1">Investigations</p>
              <BulletList items={note.plan.investigations} />
            </>
          ) : null}
          {note.plan.treatment.length > 0 ? (
            <>
              <p className="text-label text-even-ink-500 mt-3 mb-1">Treatment</p>
              <BulletList items={note.plan.treatment} />
            </>
          ) : null}
          {note.plan.follow_up ? (
            <>
              <p className="text-label text-even-ink-500 mt-3 mb-1">Follow-up</p>
              <p className="whitespace-pre-line">{note.plan.follow_up}</p>
            </>
          ) : null}
        </Section>
      ) : null}
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-label text-even-navy-800 uppercase tracking-wide text-caption mb-1">
        {title}
      </h3>
      <div className="leading-relaxed">{children}</div>
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 space-y-0.5">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}
