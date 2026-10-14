'use client';

import Link from 'next/link';
import { Brain, Stethoscope } from 'lucide-react';
import CalculatorShell from './CalculatorShell';
import type { CalculatorConfig, CalculatorResult, FormField } from '@/lib/calculators/types';
import { computeNihss, type NihssInputs } from '@/lib/calculators/math/nihss';

// v2.0 — every NIHSS item gets per-option `points` + a `description` where the
// short label alone would be ambiguous (e.g. motor arms / legs, language). All
// option values stay as strings here per FormField type contract; the live-score
// wrapper Number()-coerces them before calling computeNihss.

const FIELDS: FormField[] = [
  { key: 'loc', label: '1a Level of consciousness', type: 'enum', required: true,
    subtitle: 'Examiner observation only — no painful stim needed beyond what differentiates the categories.',
    options: [
      { value: '0', label: 'Alert',                                  points: 0, description: 'Keenly responsive' },
      { value: '1', label: 'Drowsy',                                 points: 1, description: 'Arouses with minor stimulation' },
      { value: '2', label: 'Stuporous',                              points: 2, description: 'Requires repeated / strong / painful stim to arouse' },
      { value: '3', label: 'Coma / unresponsive',                    points: 3, description: 'Reflex motor or autonomic effects only, or totally unresponsive' },
    ],
    staticTooltip: 'Level of consciousness — examiner observation only, no painful stim needed beyond what differentiates the categories.' },
  { key: 'loc_questions', label: '1b LOC questions', type: 'enum', required: true,
    subtitle: 'Ask the current month and the patient\'s age. Aphasia / intubation that prevents speech scores 2; clear dysarthria can still score 0.',
    options: [
      { value: '0', label: 'Both answers correct',                   points: 0 },
      { value: '1', label: 'One answer correct',                     points: 1 },
      { value: '2', label: 'Neither answer correct',                 points: 2, description: 'Or unable to speak for any reason except intubation' },
    ],
    staticTooltip: 'Ask current month and patient\'s age. Aphasia / intubation that prevents speech scores 2; dysarthria can still score 0 if answer is comprehensible.' },
  { key: 'loc_commands', label: '1c LOC commands', type: 'enum', required: true,
    subtitle: 'Ask to open/close eyes and grip/release the non-paretic hand. Pantomime commands if there is a communication barrier.',
    options: [
      { value: '0', label: 'Performs both tasks',                    points: 0 },
      { value: '1', label: 'Performs one task',                      points: 1 },
      { value: '2', label: 'Performs neither task',                  points: 2 },
    ],
    staticTooltip: 'Ask to open/close eyes and grip/release the non-paretic hand. Substitute another 1-step command if hand cannot be used.' },
  { key: 'gaze', label: '2 Best gaze', type: 'enum', required: true,
    subtitle: 'Only assess horizontal eye movements.',
    options: [
      { value: '0', label: 'Normal',                                 points: 0 },
      { value: '1', label: 'Partial gaze palsy',                     points: 1, description: 'Gaze abnormal in one or both eyes, but no forced deviation; overcome with oculocephalic reflex' },
      { value: '2', label: 'Forced deviation',                       points: 2, description: 'Or total gaze paresis not overcome by oculocephalic manoeuvre' },
    ],
    staticTooltip: 'Horizontal eye movements only. 0=normal, 1=partial gaze palsy correctable with VOR, 2=forced deviation not overcome by oculocephalic.' },
  { key: 'visual_fields', label: '3 Visual fields', type: 'enum', required: true,
    subtitle: 'Confrontation testing in upper and lower quadrants of each eye.',
    options: [
      { value: '0', label: 'No visual loss',                         points: 0 },
      { value: '1', label: 'Partial hemianopia',                     points: 1 },
      { value: '2', label: 'Complete hemianopia',                    points: 2 },
      { value: '3', label: 'Bilateral hemianopia',                   points: 3, description: 'Including cortical blindness' },
    ],
    staticTooltip: 'Confrontation. 0=no loss, 1=partial hemianopia, 2=complete hemianopia, 3=bilateral hemianopia incl cortical blindness.' },
  { key: 'facial_palsy', label: '4 Facial palsy', type: 'enum', required: true,
    subtitle: 'Ask patient to show teeth, raise eyebrows, close eyes.',
    options: [
      { value: '0', label: 'Normal symmetrical movement',            points: 0 },
      { value: '1', label: 'Minor paralysis',                        points: 1, description: 'Flattened nasolabial fold, asymmetric smile' },
      { value: '2', label: 'Partial paralysis',                      points: 2, description: 'Total or near-total paralysis of lower face' },
      { value: '3', label: 'Complete paralysis',                     points: 3, description: 'Of one or both sides — upper + lower face' },
    ],
    staticTooltip: '0=normal, 1=minor (NL flattening), 2=partial (lower face), 3=complete (one or both sides).' },
  { key: 'motor_arm_left', label: '5a Motor arm — left', type: 'enum', required: true,
    subtitle: 'Patient holds left arm extended 90° (sitting) or 45° (supine) for 10 seconds.',
    options: [
      { value: '0', label: 'No drift',                               points: 0, description: 'Holds for full 10 s' },
      { value: '1', label: 'Drift',                                  points: 1, description: 'Drifts down before 10 s but does not hit bed' },
      { value: '2', label: 'Some effort against gravity',            points: 2, description: 'Cannot get to or maintain target position; falls to bed' },
      { value: '3', label: 'No effort against gravity',              points: 3, description: 'Limb falls immediately' },
      { value: '4', label: 'No movement',                            points: 4 },
    ],
    staticTooltip: 'Arm held 90° (sitting) or 45° (supine) × 10 s. 0=no drift, 1=drift, 2=some effort vs gravity, 3=no effort vs gravity, 4=no movement.' },
  { key: 'motor_arm_right', label: '5b Motor arm — right', type: 'enum', required: true,
    subtitle: 'Patient holds right arm extended 90° (sitting) or 45° (supine) for 10 seconds.',
    options: [
      { value: '0', label: 'No drift',                               points: 0 },
      { value: '1', label: 'Drift',                                  points: 1 },
      { value: '2', label: 'Some effort against gravity',            points: 2 },
      { value: '3', label: 'No effort against gravity',              points: 3 },
      { value: '4', label: 'No movement',                            points: 4 },
    ],
    staticTooltip: 'Same protocol as 5a, opposite side.' },
  { key: 'motor_leg_left', label: '6a Motor leg — left', type: 'enum', required: true,
    subtitle: 'Patient holds left leg at 30° (always supine) for 5 seconds.',
    options: [
      { value: '0', label: 'No drift',                               points: 0, description: 'Holds for full 5 s' },
      { value: '1', label: 'Drift',                                  points: 1, description: 'Drifts down before 5 s, does not hit bed' },
      { value: '2', label: 'Some effort against gravity',            points: 2 },
      { value: '3', label: 'No effort against gravity',              points: 3 },
      { value: '4', label: 'No movement',                            points: 4 },
    ],
    staticTooltip: 'Leg held 30° (always supine) × 5 s. Same 0-4 scale as arms.' },
  { key: 'motor_leg_right', label: '6b Motor leg — right', type: 'enum', required: true,
    subtitle: 'Patient holds right leg at 30° (always supine) for 5 seconds.',
    options: [
      { value: '0', label: 'No drift',                               points: 0 },
      { value: '1', label: 'Drift',                                  points: 1 },
      { value: '2', label: 'Some effort against gravity',            points: 2 },
      { value: '3', label: 'No effort against gravity',              points: 3 },
      { value: '4', label: 'No movement',                            points: 4 },
    ],
    staticTooltip: 'Same protocol as 6a, opposite side.' },
  { key: 'limb_ataxia', label: '7 Limb ataxia', type: 'enum', required: true,
    subtitle: 'Finger-nose-finger and heel-shin tests on both sides.',
    options: [
      { value: '0', label: 'Absent',                                 points: 0, description: 'Or unable to test due to weakness — still scores 0' },
      { value: '1', label: 'Present in 1 limb',                      points: 1 },
      { value: '2', label: 'Present in 2 or more limbs',             points: 2 },
    ],
    staticTooltip: 'Finger-nose-finger + heel-shin. 0=absent (or unable to test from weakness), 1=present in 1 limb, 2=present in 2+ limbs.' },
  { key: 'sensory', label: '8 Sensory', type: 'enum', required: true,
    subtitle: 'Pinprick on face, arms, trunk, legs — bilateral comparison.',
    options: [
      { value: '0', label: 'Normal',                                 points: 0, description: 'No sensory loss' },
      { value: '1', label: 'Mild-to-moderate loss',                  points: 1, description: 'Patient feels pinprick is less sharp / dull on affected side' },
      { value: '2', label: 'Severe-to-total loss',                   points: 2, description: 'Not aware of being touched in face, arm, and leg' },
    ],
    staticTooltip: 'Pinprick. 0=normal, 1=mild-moderate loss, 2=severe-to-total loss.' },
  { key: 'language', label: '9 Best language', type: 'enum', required: true,
    subtitle: 'Naming objects + reading + describing the cookie-theft picture.',
    options: [
      { value: '0', label: 'No aphasia, normal',                     points: 0 },
      { value: '1', label: 'Mild-to-moderate aphasia',               points: 1, description: 'Some loss of fluency or comprehension, identifiable name despite difficulty' },
      { value: '2', label: 'Severe aphasia',                         points: 2, description: 'Fragmented expression; great inference needed by listener' },
      { value: '3', label: 'Mute, global aphasia',                   points: 3, description: 'No usable speech or auditory comprehension' },
    ],
    staticTooltip: 'Naming + reading + describing the cookie-theft picture. 0=normal, 1=mild-moderate aphasia, 2=severe aphasia, 3=mute / global.' },
  { key: 'dysarthria', label: '10 Dysarthria', type: 'enum', required: true,
    subtitle: 'Articulation only — not aphasia. Have patient read standard list of words.',
    options: [
      { value: '0', label: 'Normal',                                 points: 0 },
      { value: '1', label: 'Mild-to-moderate dysarthria',            points: 1, description: 'Slurs some words; can still be understood with difficulty' },
      { value: '2', label: 'Severe dysarthria',                      points: 2, description: 'Unintelligible, or mute / anarthric' },
    ],
    staticTooltip: 'Articulation only — not aphasia. 0=normal, 1=mild-moderate, 2=severe / unintelligible / mute.' },
  { key: 'extinction', label: '11 Extinction / inattention', type: 'enum', required: true,
    subtitle: 'Double simultaneous stimulation (visual + tactile).',
    options: [
      { value: '0', label: 'No abnormality',                         points: 0 },
      { value: '1', label: 'Mild',                                   points: 1, description: 'Extinction to bilateral simultaneous stimulation in one sensory modality' },
      { value: '2', label: 'Profound',                               points: 2, description: 'Extinction to multiple modalities; denies own limb (anosognosia)' },
    ],
    staticTooltip: 'Double simultaneous stim. 0=normal, 1=mild (one modality), 2=profound (multiple modalities, denies own limb).' },
];

const CFG: CalculatorConfig = {
  name: 'nihss',
  displayTitle: 'NIHSS — NIH Stroke Scale',
  moduleHome: 'ask',
  pasteModeEnabled: false,
  apiPath: '/api/calculators/nihss',
  resultSections: ['interpretation'],
  typicalLatencySec: 2,
  fields: FIELDS,
};

type Det = { score: number; band: string; band_label: string };

const BAND_COLOR: Record<string, string> = {
  no_stroke:       'bg-emerald-100 text-emerald-700',
  minor:           'bg-yellow-100 text-yellow-800',
  moderate:        'bg-orange-100 text-orange-700',
  moderate_severe: 'bg-rose-200 text-rose-800',
  severe:          'bg-red-200 text-red-800',
};

const NIHSS_KEYS: Array<keyof NihssInputs> = [
  'loc', 'loc_questions', 'loc_commands',
  'gaze', 'visual_fields', 'facial_palsy',
  'motor_arm_left', 'motor_arm_right', 'motor_leg_left', 'motor_leg_right',
  'limb_ataxia', 'sensory', 'language', 'dysarthria', 'extinction',
];

function Result({ result }: { result: CalculatorResult & { deterministic: Det } }) {
  const d = result.deterministic;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="text-5xl font-bold tracking-tight text-slate-900">{d.score}</span>
          <span className="text-sm text-slate-500">/ 42 NIHSS</span>
          <span className={`ml-auto inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${BAND_COLOR[d.band] ?? ''}`}>{d.band_label}</span>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-slate-900">Clinical interpretation</h2>
        </div>
        <div className="text-sm leading-relaxed text-slate-700">{d.band_label}.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/ask?q=${encodeURIComponent('My NIHSS is ' + d.score + ' (' + d.band_label + '). What does this mean for tPA eligibility and disposition?')}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
          Ask deeper about this score
        </Link>
      </div>
      <div className="text-xs text-slate-400">Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{result.trace_id}</code></div>
    </div>
  );
}

export default function NihssCalculator() {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
        <Brain className="h-4 w-4 text-brand" /> NIH Stroke Scale (NINDS / AHA)
      </div>
      <CalculatorShell<Det>
        config={CFG}
        renderResult={Result}
        liveScore={(v) => {
          // String-option values from the button stack — coerce to int for math.
          // Default missing items to 0 so the running tally is meaningful from
          // the first click instead of disappearing until all 15 items fill in.
          const inputs = Object.fromEntries(
            NIHSS_KEYS.map((k) => {
              const raw = v[k];
              const n = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
              return [k, Number.isFinite(n) ? n : 0];
            }),
          ) as unknown as NihssInputs;
          const complete = NIHSS_KEYS.every((k) => {
            const raw = v[k];
            return raw !== undefined && raw !== null && raw !== '';
          });
          try {
            const r = computeNihss(inputs);
            return { score: r.score, max: 42, band: r.band, band_label: r.band_label, complete };
          } catch { return null; }
        }}
      />
    </div>
  );
}
