// /admin/scoring-policy/nabh-completeness — the main weightage screen (PRD §5.3).
//
// Server component: holds the admin gate and the first read, then hands off to the client editor.
// The `ot_note` tab renders locked (decision §1.4); its 35-field count is the rubric's own.
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { getActivePolicy, getDraft, listVersions, ipdPreviewCohort, opdAccumulatedCount, PREVIEW_WINDOW_DAYS } from '@/lib/scoring-policy/store';
import { PHASE_A_NOTE_TYPES, fieldsFor, weightedKeysFor, labelFor, type WeightVector } from '@/lib/scoring-policy/weights';
import { DISCHARGE_SUMMARY_COND_KEYS } from '@/lib/scoring-policy/completeness';
import { previewImpact, missingPrevalence, systemicDefectWarnings } from '@/lib/scoring-policy/preview';
import { Locked, WeightageEditor, type PreviewPayload } from '../ui';

export const dynamic = 'force-dynamic';

const NOTE_TYPE_LABEL: Record<string, string> = {
  discharge_summary: 'Discharge summary',
  opd_rx: 'OPD prescription',
};

export default async function NabhCompletenessPage({ searchParams }: { searchParams: Promise<{ note_type?: string; locked?: string; restore?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) {
    return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} next="/admin/scoring-policy/nabh-completeness" />;
  }

  const noteType = (PHASE_A_NOTE_TYPES as string[]).includes(String(sp.note_type)) ? String(sp.note_type) : 'discharge_summary';
  const fields = fieldsFor(noteType);

  const [active, draft] = await Promise.all([getActivePolicy(noteType), getDraft(noteType)]);

  // §5.5 RESTORE — load an earlier version's weights into the editor. This does NOT write anything:
  // the user still publishes, which creates a NEW version. History stays append-only.
  let restore: { version: number; vector: WeightVector } | null = null;
  if (sp.restore) {
    const want = Number(sp.restore);
    const found = Number.isFinite(want) ? (await listVersions(noteType)).find((v) => v.version === want) : undefined;
    if (found) restore = { version: found.version, vector: found.vector };
  }

  const candidate = restore?.vector ?? draft?.vector ?? active.vector;

  // First preview, server-rendered so the panel is never empty on arrival.
  let initialPreview: PreviewPayload | null = null;
  if (noteType === 'opd_rx') {
    const accumulated = await opdAccumulatedCount();
    initialPreview = {
      emptyState: true, accumulated,
      message: 'OPD audits began recording per-field detail with this release. Impact preview will appear once enough audits have accumulated. Weights you publish here apply to new audits from the moment they go live.',
    };
  } else {
    const rows = await ipdPreviewCohort();
    if (rows.length) {
      const impact = previewImpact(rows, active.vector, candidate, { condKeys: DISCHARGE_SUMMARY_COND_KEYS });
      const prevalence = missingPrevalence(rows);
      initialPreview = {
        ...impact, prevalence, n: rows.length, windowDays: PREVIEW_WINDOW_DAYS,
        warnings: systemicDefectWarnings(candidate, prevalence, (k) => labelFor(noteType, k)),
      };
    } else {
      initialPreview = { emptyState: true, n: 0, message: 'No audits in the last 90 days to preview against.' };
    }
  }

  const noteTypeTabs = [
    { noteType: 'discharge_summary', label: 'Discharge summary', count: weightedKeysFor('discharge_summary').length },
    { noteType: 'opd_rx', label: 'OPD prescription', count: weightedKeysFor('opd_rx').length },
    // data/nabh-rubric.json `ot_note` — 35 fields. Locked in Phase A.
    { noteType: 'ot_note', label: 'OT note', count: 35, locked: true },
  ];

  return (
    <WeightageEditor
      noteType={noteType}
      noteTypeLabel={NOTE_TYPE_LABEL[noteType] ?? noteType}
      fields={fields}
      activeVector={active.vector}
      activeVersion={active.version}
      activeVersionString={active.versionString}
      activeFallback={active.fallback}
      draftVector={restore?.vector ?? draft?.vector ?? null}
      draftUpdatedAt={draft?.updatedAt ?? null}
      initialPreview={initialPreview}
      noteTypeTabs={noteTypeTabs}
      restoredFromVersion={restore?.version ?? null}
    />
  );
}
