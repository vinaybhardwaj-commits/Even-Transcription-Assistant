// lib/clinical-state/format.ts — formatClinicalState(state): the prose block that will
// feed the DDx presentation (app/api/ddx/route.ts displayForPrompt) in PHASE 2.
// Built and tested now; consumed by NOTHING in 1a (neutrality contract).

import type { ClinicalState, ClinicalFinding } from './schema';

function findingLine(f: ClinicalFinding): string {
  const bits: string[] = [f.concept];
  const v = [f.value, f.unit ?? undefined].filter(Boolean).join(' ');
  if (v) bits.push(v);
  const t = f.temporality;
  if (t) {
    const tt = [t.duration, t.onset, t.course].filter(Boolean).join(', ');
    if (tt) bits.push(`(${tt})`);
  }
  return bits.join(' ');
}

export function formatClinicalState(s: ClinicalState): string {
  const lines: string[] = [];

  const demo: string[] = [];
  if (s.demographics.age != null) demo.push(`${s.demographics.age}y`);
  if (s.demographics.sex) demo.push(s.demographics.sex);
  lines.push(`Patient: ${demo.length ? demo.join(' / ') : 'demographics not given'}`);

  if (s.positives.length) lines.push(`Findings (stated): ${s.positives.map(findingLine).join('; ')}`);
  if (s.negatives.length) lines.push(`Explicitly negative: ${s.negatives.map((f) => f.concept).join('; ')}`);
  if (s.unknowns.length) lines.push(`Not mentioned (do not assume either way): ${s.unknowns.map((f) => f.concept).join('; ')}`);
  if (s.riskFactors.length) lines.push(`Risk factors: ${s.riskFactors.join('; ')}`);
  if (s.exposures.length) lines.push(`Exposures: ${s.exposures.join('; ')}`);
  if (s.medications.length) lines.push(`Medications: ${s.medications.join('; ')}`);
  if (s.procedures?.length) lines.push(`Procedures: ${s.procedures.join('; ')}`);

  if (s.investigations.length) {
    lines.push('Investigations (reported):');
    for (const f of s.investigations) {
      const v = [f.value, f.unit ?? undefined].filter(Boolean).join(' ');
      lines.push(`- [${f.flag.toUpperCase()}] ${f.test}${v ? ' ' + v : ''}${f.note ? ' — ' + f.note : ''}`);
    }
  }

  if (s.instability.unstable) lines.push(`UNSTABLE: ${s.instability.reasons.join('; ')}`);
  if (s.disposition) lines.push(`Disposition: ${s.disposition}`);
  if (s.adminFacts) {
    const a = s.adminFacts;
    const bits = [
      a.lengthOfStayDays != null ? `stay ${a.lengthOfStayDays}d` : '',
      a.admissionType ?? '', a.careSetting ?? '',
    ].filter(Boolean);
    if (bits.length) lines.push(`Stay: ${bits.join('; ')}`);
  }
  if (s.missingCriticalData.length) lines.push(`Missing critical data: ${s.missingCriticalData.join('; ')}`);

  return lines.join('\n');
}
