"use client";

import * as React from "react";
import type { EncounterNote, GeneralMedicalNote, OperativeProcedureNote, DieteticConsultNote, PhysiotherapyNote, AnyNote } from "@/lib/note-generation";

/**
 * Renders a Medical Encounter Note as a clinical document. Prose
 * sections (HPI, examination, assessment, follow-up) render as
 * paragraphs; list sections (PMH, meds, allergies, plan items) render
 * as bulleted lists. Empty sections collapse out of the way.
 */
export function NoteView({ note: noteAny, noteType }: { note: AnyNote; noteType?: string }) {
  if (noteType === "general_medical") return <GeneralMedicalView note={noteAny as GeneralMedicalNote} />;
  if (noteType === "operative_procedure") return <OperativeView note={noteAny as OperativeProcedureNote} />;
  if (noteType === "dietetic_consult") return <DieteticView note={noteAny as DieteticConsultNote} />;
  if (noteType === "physiotherapy") return <PhysioView note={noteAny as PhysiotherapyNote} />;
  const note = noteAny as EncounterNote;
  return (
    <article className="space-y-6 text-body text-even-ink-800">
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

function PhysioView({ note }: { note: PhysiotherapyNote }) {
  const pa = note.pain_assessment;
  const pain = [
    pa.location ? `Location: ${pa.location}` : "",
    pa.score_0_10 != null ? `Score: ${pa.score_0_10}/10` : "",
    pa.quality ? `Quality: ${pa.quality}` : "",
    pa.aggravating_factors.length ? `Aggravating: ${pa.aggravating_factors.join(", ")}` : "",
    pa.relieving_factors.length ? `Relieving: ${pa.relieving_factors.join(", ")}` : "",
  ].filter(Boolean);
  const tp = note.treatment_plan;
  const tpEmpty =
    !tp.modalities.length && !tp.exercises_prescribed.length && !tp.home_program.length &&
    !tp.precautions.length && !tp.expected_outcomes && tp.sessions_per_week == null && tp.expected_duration_weeks == null;
  return (
    <article className="space-y-6 text-body text-even-ink-800">
      {note.reason_for_consult ? <Section title="Reason for consult"><p>{note.reason_for_consult}</p></Section> : null}
      {note.relevant_medical_history.length > 0 ? <Section title="Relevant medical history"><BulletList items={note.relevant_medical_history} /></Section> : null}
      {note.current_medications.length > 0 ? <Section title="Current medications"><BulletList items={note.current_medications} /></Section> : null}
      {note.functional_status_baseline ? <Section title="Baseline functional status"><p className="whitespace-pre-line">{note.functional_status_baseline}</p></Section> : null}
      {note.current_functional_status ? <Section title="Current functional status"><p className="whitespace-pre-line">{note.current_functional_status}</p></Section> : null}
      {pain.length > 0 ? <Section title="Pain assessment"><BulletList items={pain} /></Section> : null}
      {note.rom_findings ? <Section title="Range of motion"><p className="whitespace-pre-line">{note.rom_findings}</p></Section> : null}
      {note.strength_findings ? <Section title="Strength"><p className="whitespace-pre-line">{note.strength_findings}</p></Section> : null}
      {note.special_tests.length > 0 ? <Section title="Special tests"><BulletList items={note.special_tests} /></Section> : null}
      {note.posture_and_gait ? <Section title="Posture & gait"><p className="whitespace-pre-line">{note.posture_and_gait}</p></Section> : null}
      {note.assessment ? <Section title="Assessment"><p className="whitespace-pre-line">{note.assessment}</p></Section> : null}
      {!tpEmpty ? (
        <Section title="Treatment plan">
          {tp.modalities.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Modalities</p><BulletList items={tp.modalities} /></> : null}
          {tp.exercises_prescribed.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Exercises prescribed</p><BulletList items={tp.exercises_prescribed} /></> : null}
          {tp.home_program.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Home program</p><BulletList items={tp.home_program} /></> : null}
          {tp.precautions.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Precautions</p><BulletList items={tp.precautions} /></> : null}
          {tp.expected_outcomes ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Expected outcomes</p><p>{tp.expected_outcomes}</p></> : null}
          {tp.sessions_per_week != null || tp.expected_duration_weeks != null ? (
            <p className="mt-2">{[tp.sessions_per_week != null ? `${tp.sessions_per_week} sessions/week` : "", tp.expected_duration_weeks != null ? `${tp.expected_duration_weeks} weeks` : ""].filter(Boolean).join(" \u00b7 ")}</p>
          ) : null}
        </Section>
      ) : null}
      {note.follow_up ? <Section title="Follow-up"><p className="whitespace-pre-line">{note.follow_up}</p></Section> : null}
    </article>
  );
}

function DieteticView({ note }: { note: DieteticConsultNote }) {
  const a = note.anthropometrics;
  const anthro = [
    a.weight_kg != null ? `Weight: ${a.weight_kg} kg` : "",
    a.height_cm != null ? `Height: ${a.height_cm} cm` : "",
    a.bmi != null ? `BMI: ${a.bmi}` : "",
    a.waist_circumference_cm != null ? `Waist: ${a.waist_circumference_cm} cm` : "",
    a.body_fat_percent != null ? `Body fat: ${a.body_fat_percent}%` : "",
    a.other ? a.other : "",
  ].filter(Boolean);
  const dp = note.diet_plan;
  const planEmpty =
    dp.daily_calorie_target_kcal == null && !dp.macronutrient_distribution &&
    dp.meal_pattern.length === 0 && dp.foods_to_emphasize.length === 0 &&
    dp.foods_to_limit_or_avoid.length === 0 && dp.supplements_recommended.length === 0 &&
    dp.behavioural_goals.length === 0;
  return (
    <article className="space-y-6 text-body text-even-ink-800">
      {note.reason_for_consult ? <Section title="Reason for consult"><p>{note.reason_for_consult}</p></Section> : null}
      {note.relevant_medical_history.length > 0 ? <Section title="Relevant medical history"><BulletList items={note.relevant_medical_history} /></Section> : null}
      {note.current_medications.length > 0 ? <Section title="Current medications"><BulletList items={note.current_medications} /></Section> : null}
      {note.allergies_and_intolerances.length > 0 ? <Section title="Allergies & intolerances"><BulletList items={note.allergies_and_intolerances} /></Section> : null}
      {anthro.length > 0 ? <Section title="Anthropometrics"><BulletList items={anthro} /></Section> : null}
      {note.diet_recall ? <Section title="24-hour diet recall"><p className="whitespace-pre-line">{note.diet_recall}</p></Section> : null}
      {note.food_preferences_and_aversions.length > 0 ? <Section title="Food preferences & aversions"><BulletList items={note.food_preferences_and_aversions} /></Section> : null}
      {note.nutritional_assessment ? <Section title="Nutritional assessment"><p className="whitespace-pre-line">{note.nutritional_assessment}</p></Section> : null}
      {!planEmpty ? (
        <Section title="Diet plan">
          {dp.daily_calorie_target_kcal != null ? <p className="mb-1">Calorie target: {dp.daily_calorie_target_kcal} kcal/day</p> : null}
          {dp.macronutrient_distribution ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Macronutrients</p><p>{dp.macronutrient_distribution}</p></> : null}
          {dp.meal_pattern.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Meal pattern</p><BulletList items={dp.meal_pattern} /></> : null}
          {dp.foods_to_emphasize.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Foods to emphasize</p><BulletList items={dp.foods_to_emphasize} /></> : null}
          {dp.foods_to_limit_or_avoid.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Foods to limit / avoid</p><BulletList items={dp.foods_to_limit_or_avoid} /></> : null}
          {dp.supplements_recommended.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Supplements</p><BulletList items={dp.supplements_recommended} /></> : null}
          {dp.behavioural_goals.length > 0 ? <><p className="text-label text-even-ink-500 mt-2 mb-1">Behavioural goals</p><BulletList items={dp.behavioural_goals} /></> : null}
        </Section>
      ) : null}
      {note.follow_up ? <Section title="Follow-up"><p className="whitespace-pre-line">{note.follow_up}</p></Section> : null}
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
    <article className="space-y-6 text-body text-even-ink-800">
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
    <article className="space-y-6 text-body text-even-ink-800">
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
      <h3 className="text-caption font-medium text-even-blue-700 mb-1.5">
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
