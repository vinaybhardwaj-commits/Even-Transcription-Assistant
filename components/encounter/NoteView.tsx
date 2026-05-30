"use client";

import * as React from "react";
import type { EncounterNote, GeneralMedicalNote, OperativeProcedureNote, AnyNote } from "@/lib/note-generation";

/**
 * Renders a Medical Encounter Note as a clinical document. Prose
 * sections (HPI, examination, assessment, follow-up) render as
 * paragraphs; list sections (PMH, meds, allergies, plan items) render
 * as bulleted lists. Empty sections collapse out of the way.
 */
export function NoteView({ note: noteAny, noteType }: { note: AnyNote; noteType?: string }) {
  if (noteType === "general_medical") return <GeneralMedicalView note={noteAny as GeneralMedicalNote} />;
  if (noteType === "operative_procedure") return <OperativeView note={noteAny as OperativeProcedureNote} />;
  const note = noteAny as EncounterNote;
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

function OperativeView({ note }: { note: OperativeProcedureNote }) {
  const meta = [
    note.procedure_date_time ? `Date/time: ${note.procedure_date_time}` : "",
    note.surgical_specialty ? `Specialty: ${note.surgical_specialty}` : "",
    note.surgeon ? `Surgeon: ${note.surgeon}` : "",
    note.assistants.length ? `Assistants: ${note.assistants.join(", ")}` : "",
    note.anesthesiologist ? `Anesthesiologist: ${note.anesthesiologist}` : "",
    note.anesthesia_type ? `Anesthesia: ${note.anesthesia_type}` : "",
  ].filter(Boolean);
  const intra = [
    note.estimated_blood_loss_ml != null ? `EBL: ${note.estimated_blood_loss_ml} ml` : "",
    note.fluids_in ? `Fluids in: ${note.fluids_in}` : "",
    note.urine_output_ml != null ? `Urine output: ${note.urine_output_ml} ml` : "",
    note.antibiotic_given ? `Antibiotic: ${note.antibiotic_given}` : "",
    note.counts_correct != null ? `Counts correct: ${note.counts_correct ? "Yes" : "No"}` : "",
  ].filter(Boolean);
  return (
    <article className="space-y-5 text-body text-even-ink-800">
      {meta.length > 0 ? <Section title="Procedure details"><BulletList items={meta} /></Section> : null}
      {note.pre_op_diagnosis ? <Section title="Pre-operative diagnosis"><p className="whitespace-pre-line">{note.pre_op_diagnosis}</p></Section> : null}
      {note.post_op_diagnosis ? <Section title="Post-operative diagnosis"><p className="whitespace-pre-line">{note.post_op_diagnosis}</p></Section> : null}
      {note.procedure_performed.length > 0 ? <Section title="Procedure(s) performed"><BulletList items={note.procedure_performed} /></Section> : null}
      {note.indication ? <Section title="Indication"><p className="whitespace-pre-line">{note.indication}</p></Section> : null}
      {note.findings ? <Section title="Findings"><p className="whitespace-pre-line">{note.findings}</p></Section> : null}
      {note.procedure_narrative ? <Section title="Procedure narrative"><p className="whitespace-pre-line">{note.procedure_narrative}</p></Section> : null}
      {note.specimens.length > 0 ? <Section title="Specimens"><BulletList items={note.specimens.map((sp) => `${sp.description} → ${sp.sent_to}`)} /></Section> : null}
      {note.implants.length > 0 ? <Section title="Implants"><BulletList items={note.implants.map((im) => im.catalog_or_serial ? `${im.description} (${im.catalog_or_serial})` : im.description)} /></Section> : null}
      {note.drains_placed.length > 0 ? <Section title="Drains"><BulletList items={note.drains_placed} /></Section> : null}
      {intra.length > 0 ? <Section title="Intra-operative summary"><BulletList items={intra} /></Section> : null}
      {note.complications ? <Section title="Complications"><p className="whitespace-pre-line">{note.complications}</p></Section> : null}
      {note.disposition ? <Section title="Disposition"><p>{note.disposition}</p></Section> : null}
    </article>
  );
}

function GeneralMedicalView({ note }: { note: GeneralMedicalNote }) {
  return (
    <article className="space-y-5 text-body text-even-ink-800">
      {note.reason_for_visit ? (
        <Section title="Reason for visit"><p>{note.reason_for_visit}</p></Section>
      ) : null}
      {note.active_problems.length > 0 ? (
        <Section title="Active problems"><BulletList items={note.active_problems} /></Section>
      ) : null}
      {note.interval_history ? (
        <Section title="Interval history"><p className="whitespace-pre-line">{note.interval_history}</p></Section>
      ) : null}
      {note.current_medications.length > 0 ? (
        <Section title="Current medications"><BulletList items={note.current_medications} /></Section>
      ) : null}
      {note.allergies.length > 0 ? (
        <Section title="Allergies"><BulletList items={note.allergies} /></Section>
      ) : null}
      {note.examination ? (
        <Section title="Examination"><p className="whitespace-pre-line">{note.examination}</p></Section>
      ) : null}
      {note.impression ? (
        <Section title="Impression"><p className="whitespace-pre-line">{note.impression}</p></Section>
      ) : null}
      {note.plan.investigations_ordered.length > 0 ||
      note.plan.treatment_changes.length > 0 ||
      note.plan.consultations_requested.length > 0 ||
      note.plan.follow_up ? (
        <Section title="Plan">
          {note.plan.investigations_ordered.length > 0 ? (
            <><p className="text-label text-even-ink-500 mt-1 mb-1">Investigations ordered</p><BulletList items={note.plan.investigations_ordered} /></>
          ) : null}
          {note.plan.treatment_changes.length > 0 ? (
            <><p className="text-label text-even-ink-500 mt-3 mb-1">Treatment changes</p><BulletList items={note.plan.treatment_changes} /></>
          ) : null}
          {note.plan.consultations_requested.length > 0 ? (
            <><p className="text-label text-even-ink-500 mt-3 mb-1">Consultations requested</p><BulletList items={note.plan.consultations_requested} /></>
          ) : null}
          {note.plan.follow_up ? (
            <><p className="text-label text-even-ink-500 mt-3 mb-1">Follow-up</p><p className="whitespace-pre-line">{note.plan.follow_up}</p></>
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
