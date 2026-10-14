/**
 * Pure core for the model-programme meters (LEARNING-LOOP-V2 §2.4). Targets from the sample-size
 * math doc. Pre-freeze (app_settings model_v1_version absent → frozenVersion null) EVERY model-side
 * meter renders "armed — awaits engine freeze" (NEVER fake movement); only the human-side reviewer
 * cadence moves. No db / Next imports.
 */

export const PROGRAMME = {
  teacherPool: 15000,     // teacher audits at a frozen v1 to train on
  evalPairs: 1500,        // held-out teacher–student pairs to evaluate against
  panelPerClass: 125,     // rare-class panel: findings per LLM class
  panelClasses: 6,        // number of LLM classes
  adjMin: 500,            // minimum adjudicated disagreements
  adjBudget: 1500,        // adjudication budget
} as const;

export const ARMED_LABEL = 'armed — awaits engine freeze';

export interface Meter {
  key: string; label: string;
  value: number | null;   // null while armed → rendered "—" / "armed"
  target: number;
  armed: boolean;
  sub: string;
  fill: number | null;    // 0..1 progress bar, null while armed
}
export interface ProgrammeInput {
  frozenVersion: string | null;
  teacherPool: number; evalPairs: number; panelsFilled: number; adjudications: number;
  cadenceWeek: number; cadenceTarget: number; roster: number;
}

function meter(key: string, label: string, value: number, target: number, armed: boolean, sub: string): Meter {
  return {
    key, label,
    value: armed ? null : value,
    target,
    armed,
    sub: armed ? ARMED_LABEL : sub,
    fill: armed || target <= 0 ? null : Math.max(0, Math.min(1, value / target)),
  };
}

/** Five meters, mockup order. The four model-side meters are armed until the engine freezes at v1;
 *  reviewer cadence (human-side, reuses review_goal) always moves. */
export function buildMeters(i: ProgrammeInput): Meter[] {
  const armed = i.frozenVersion == null;
  return [
    meter('teacher_pool', 'Teacher pool @ v1', i.teacherPool, PROGRAMME.teacherPool, armed, `at ${i.frozenVersion ?? 'v1'}`),
    meter('eval_pairs', 'Eval pairs (held-out)', i.evalPairs, PROGRAMME.evalPairs, armed, 'teacher–student pairs'),
    meter('panels', 'Rare-class panels', i.panelsFilled, PROGRAMME.panelClasses, armed, `${PROGRAMME.panelPerClass} findings each · ${PROGRAMME.panelClasses} classes`),
    meter('adjudications', 'Adjudications', i.adjudications, PROGRAMME.adjBudget, armed, `${PROGRAMME.adjMin} min · ${PROGRAMME.adjBudget} budget`),
    // human-side — never armed
    meter('cadence', 'Reviewer cadence', i.cadenceWeek, Math.max(1, i.cadenceTarget), false, `target ${i.cadenceTarget}/wk · ${i.roster} reviewers`),
  ];
}
