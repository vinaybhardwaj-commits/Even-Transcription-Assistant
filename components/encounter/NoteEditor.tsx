"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import type { EncounterNote, GeneralMedicalNote, OperativeProcedureNote, AnyNote } from "@/lib/note-generation";

type Props = {
  initial: AnyNote;
  noteType?: string;
  onSave: (note: AnyNote) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
};

export function NoteEditor({ initial, noteType, onSave, onCancel }: Props) {
  if (noteType === "general_medical") {
    return <GeneralMedicalEditor initial={initial as GeneralMedicalNote} onSave={onSave} onCancel={onCancel} />;
  }
  if (noteType === "operative_procedure") {
    return <OperativeEditor initial={initial as OperativeProcedureNote} onSave={onSave} onCancel={onCancel} />;
  }
  return <ClinicEditor initial={initial as EncounterNote} onSave={onSave} onCancel={onCancel} />;
}

function ClinicEditor({ initial, onSave, onCancel }: { initial: EncounterNote; onSave: (note: AnyNote) => Promise<{ ok: boolean; error?: string }>; onCancel: () => void }) {
  const [note, setNote] = React.useState<EncounterNote>(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    setError(null);
    const r = await onSave(note);
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? "Save failed");
    }
  }, [note, onSave]);

  const setStr = React.useCallback(
    (field: keyof EncounterNote, value: string) =>
      setNote((prev) => ({ ...prev, [field]: value })),
    [],
  );
  const setArr = React.useCallback(
    (field: keyof EncounterNote, value: string[]) =>
      setNote((prev) => ({ ...prev, [field]: value })),
    [],
  );
  const setPlan = React.useCallback(
    <K extends keyof EncounterNote["plan"]>(
      field: K,
      value: EncounterNote["plan"][K],
    ) =>
      setNote((prev) => ({
        ...prev,
        plan: { ...prev.plan, [field]: value },
      })),
    [],
  );

  return (
    <div className="space-y-5">
      <StringField label="Chief complaint" value={note.chief_complaint} onChange={(v) => setStr("chief_complaint", v)} singleLine />
      <StringField label="History of present illness" value={note.history_present_illness} onChange={(v) => setStr("history_present_illness", v)} rows={5} />
      <ListField label="Past medical history" items={note.past_medical_history} onChange={(v) => setArr("past_medical_history", v)} placeholder="e.g. Type 2 diabetes" />
      <ListField label="Current medications" items={note.current_medications} onChange={(v) => setArr("current_medications", v)} placeholder="e.g. Metformin 500 mg BD" />
      <ListField label="Allergies" items={note.allergies} onChange={(v) => setArr("allergies", v)} placeholder="e.g. Penicillin (rash)" />
      <StringField label="Examination" value={note.examination} onChange={(v) => setStr("examination", v)} rows={4} />
      <StringField label="Assessment" value={note.assessment} onChange={(v) => setStr("assessment", v)} rows={3} />

      <fieldset className="space-y-4 pt-2">
        <legend className="text-label text-even-navy-800 uppercase tracking-wide text-caption">Plan</legend>
        <ListField label="Investigations" items={note.plan.investigations} onChange={(v) => setPlan("investigations", v)} placeholder="e.g. Troponin in 6h" small />
        <ListField label="Treatment" items={note.plan.treatment} onChange={(v) => setPlan("treatment", v)} placeholder="e.g. Aspirin 325 mg stat" small />
        <StringField label="Follow-up" value={note.plan.follow_up} onChange={(v) => setPlan("follow_up", v)} rows={2} small />
      </fieldset>

      {error ? <p className="text-caption text-danger-700">{error}</p> : null}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-even-ink-100">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save edits"}
        </Button>
      </div>
    </div>
  );
}

function OperativeEditor({ initial, onSave, onCancel }: { initial: OperativeProcedureNote; onSave: (note: AnyNote) => Promise<{ ok: boolean; error?: string }>; onCancel: () => void }) {
  const [note, setNote] = React.useState<OperativeProcedureNote>(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const handleSave = React.useCallback(async () => {
    setSaving(true);
    setError(null);
    const r = await onSave(note);
    setSaving(false);
    if (!r.ok) setError(r.error ?? "Save failed");
  }, [note, onSave]);
  const setStr = (field: keyof OperativeProcedureNote, value: string) =>
    setNote((prev) => ({ ...prev, [field]: value }));
  const setArr = (field: keyof OperativeProcedureNote, value: string[]) =>
    setNote((prev) => ({ ...prev, [field]: value }));
  const autoBits = [
    note.estimated_blood_loss_ml != null ? `EBL ${note.estimated_blood_loss_ml} ml` : "",
    note.urine_output_ml != null ? `Urine ${note.urine_output_ml} ml` : "",
    note.counts_correct != null ? `Counts ${note.counts_correct ? "correct" : "incorrect"}` : "",
    note.specimens.length ? `${note.specimens.length} specimen(s)` : "",
    note.implants.length ? `${note.implants.length} implant(s)` : "",
  ].filter(Boolean);
  return (
    <div className="space-y-5">
      <StringField label="Procedure date / time" value={note.procedure_date_time} onChange={(v) => setStr("procedure_date_time", v)} singleLine />
      <StringField label="Surgical specialty" value={note.surgical_specialty} onChange={(v) => setStr("surgical_specialty", v)} singleLine />
      <StringField label="Pre-operative diagnosis" value={note.pre_op_diagnosis} onChange={(v) => setStr("pre_op_diagnosis", v)} rows={2} />
      <StringField label="Post-operative diagnosis" value={note.post_op_diagnosis} onChange={(v) => setStr("post_op_diagnosis", v)} rows={2} />
      <ListField label="Procedure(s) performed" items={note.procedure_performed} onChange={(v) => setArr("procedure_performed", v)} placeholder="first entry = primary" />
      <StringField label="Surgeon" value={note.surgeon} onChange={(v) => setStr("surgeon", v)} singleLine />
      <ListField label="Assistants" items={note.assistants} onChange={(v) => setArr("assistants", v)} />
      <StringField label="Anesthesiologist" value={note.anesthesiologist} onChange={(v) => setStr("anesthesiologist", v)} singleLine />
      <StringField label="Anesthesia type" value={note.anesthesia_type} onChange={(v) => setStr("anesthesia_type", v)} singleLine />
      <StringField label="Indication" value={note.indication} onChange={(v) => setStr("indication", v)} rows={2} />
      <StringField label="Findings" value={note.findings} onChange={(v) => setStr("findings", v)} rows={3} />
      <StringField label="Procedure narrative" value={note.procedure_narrative} onChange={(v) => setStr("procedure_narrative", v)} rows={6} />
      <ListField label="Drains placed" items={note.drains_placed} onChange={(v) => setArr("drains_placed", v)} small />
      <StringField label="Complications" value={note.complications} onChange={(v) => setStr("complications", v)} rows={2} />
      <StringField label="Antibiotic given" value={note.antibiotic_given} onChange={(v) => setStr("antibiotic_given", v)} singleLine />
      <StringField label="Fluids in" value={note.fluids_in} onChange={(v) => setStr("fluids_in", v)} singleLine />
      <StringField label="Disposition" value={note.disposition} onChange={(v) => setStr("disposition", v)} singleLine />
      {autoBits.length > 0 ? (
        <div className="rounded-md border border-even-ink-100 bg-even-ink-50/40 px-3 py-2">
          <p className="text-caption text-even-ink-500">Auto-captured (re-record to change): {autoBits.join(" · ")}</p>
        </div>
      ) : null}
      {error ? <p className="text-caption text-danger-700">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-even-ink-100">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save edits"}
        </Button>
      </div>
    </div>
  );
}

function GeneralMedicalEditor({ initial, onSave, onCancel }: { initial: GeneralMedicalNote; onSave: (note: AnyNote) => Promise<{ ok: boolean; error?: string }>; onCancel: () => void }) {
  const [note, setNote] = React.useState<GeneralMedicalNote>(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    setError(null);
    const r = await onSave(note);
    setSaving(false);
    if (!r.ok) setError(r.error ?? "Save failed");
  }, [note, onSave]);

  const setStr = (field: keyof GeneralMedicalNote, value: string) =>
    setNote((prev) => ({ ...prev, [field]: value }));
  const setArr = (field: keyof GeneralMedicalNote, value: string[]) =>
    setNote((prev) => ({ ...prev, [field]: value }));
  const setPlan = <K extends keyof GeneralMedicalNote["plan"]>(field: K, value: GeneralMedicalNote["plan"][K]) =>
    setNote((prev) => ({ ...prev, plan: { ...prev.plan, [field]: value } }));

  return (
    <div className="space-y-5">
      <StringField label="Reason for visit" value={note.reason_for_visit} onChange={(v) => setStr("reason_for_visit", v)} singleLine />
      <ListField label="Active problems" items={note.active_problems} onChange={(v) => setArr("active_problems", v)} placeholder="e.g. CAP, AKI" />
      <StringField label="Interval history" value={note.interval_history} onChange={(v) => setStr("interval_history", v)} rows={5} />
      <ListField label="Current medications" items={note.current_medications} onChange={(v) => setArr("current_medications", v)} placeholder="e.g. Ceftriaxone 1 g BD" />
      <ListField label="Allergies" items={note.allergies} onChange={(v) => setArr("allergies", v)} placeholder="e.g. Penicillin (rash)" />
      <StringField label="Examination" value={note.examination} onChange={(v) => setStr("examination", v)} rows={4} />
      <StringField label="Impression" value={note.impression} onChange={(v) => setStr("impression", v)} rows={3} />

      <fieldset className="space-y-4 pt-2">
        <legend className="text-label text-even-navy-800 uppercase tracking-wide text-caption">Plan</legend>
        <ListField label="Investigations ordered" items={note.plan.investigations_ordered} onChange={(v) => setPlan("investigations_ordered", v)} placeholder="e.g. Repeat CBC AM" small />
        <ListField label="Treatment changes" items={note.plan.treatment_changes} onChange={(v) => setPlan("treatment_changes", v)} placeholder="e.g. Stop frusemide" small />
        <ListField label="Consultations requested" items={note.plan.consultations_requested} onChange={(v) => setPlan("consultations_requested", v)} placeholder="e.g. Cardiology" small />
        <StringField label="Follow-up" value={note.plan.follow_up} onChange={(v) => setPlan("follow_up", v)} rows={2} small />
      </fieldset>

      {error ? <p className="text-caption text-danger-700">{error}</p> : null}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-even-ink-100">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save edits"}
        </Button>
      </div>
    </div>
  );
}

function StringField({
  label,
  value,
  onChange,
  singleLine = false,
  rows = 3,
  small = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  singleLine?: boolean;
  rows?: number;
  small?: boolean;
}) {
  return (
    <div>
      <label className={`block text-${small ? "caption" : "label"} text-even-ink-${small ? "500" : "800"} mb-1`}>
        {label}
      </label>
      {singleLine ? (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
        />
      ) : (
        <textarea
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body leading-relaxed focus:outline-none focus:ring-2 focus:ring-even-blue-300"
        />
      )}
    </div>
  );
}

function ListField({
  label,
  items,
  onChange,
  placeholder,
  small = false,
}: {
  label: string;
  items: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  small?: boolean;
}) {
  const updateAt = (idx: number, v: string) => {
    const next = items.slice();
    next[idx] = v;
    onChange(next);
  };
  const removeAt = (idx: number) => onChange(items.filter((_, i) => i !== idx));
  const addBlank = () => onChange([...items, ""]);

  return (
    <div>
      <label className={`block text-${small ? "caption" : "label"} text-even-ink-${small ? "500" : "800"} mb-1`}>
        {label}
      </label>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={it}
              onChange={(e) => updateAt(i, e.target.value)}
              placeholder={placeholder}
              className="flex-1 rounded-md border border-even-ink-200 px-3 py-1.5 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="text-caption text-even-ink-400 hover:text-danger-700 px-2"
              aria-label={`Remove ${label} row ${i + 1}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={addBlank}
        className="mt-2 text-caption text-even-blue-600 hover:underline"
      >
        + Add row
      </button>
    </div>
  );
}
