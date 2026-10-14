/**
 * v1.7 Sprint E + v1.7c — central registry for custom fenced-code-block infographic types.
 *
 * Add a new block type by:
 *   1. Build a React component that consumes validated data
 *   2. Define a Zod schema in the component file
 *   3. Add one entry to INFOGRAPHIC_BLOCKS below
 *   4. Add example usage to the SYSTEM_PROMPT in /app/api/{ask,ddx,coach}/route.ts
 *
 * That's it. No markdown library changes, no prompt-engineering, no LLM retraining.
 */
import { DosingCard, DosingCardSchema } from './blocks/DosingCard';
import { RiskScore, RiskScoreSchema } from './blocks/RiskScore';
import { DrugComparison, DrugComparisonSchema } from './blocks/DrugComparison';
import { LabTrend, LabTrendSchema } from './blocks/LabTrend';
import { DecisionTree, DecisionTreeSchema } from './blocks/DecisionTree';
import type { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZod = z.ZodSchema<any>;

export const INFOGRAPHIC_BLOCKS: Record<string, {
  schema: AnyZod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: (props: { data: any; onCite?: (n: string) => void }) => React.ReactNode;
}> = {
  'dosing-card':     { schema: DosingCardSchema,     component: DosingCard },      // v1.7
  'risk-score':      { schema: RiskScoreSchema,      component: RiskScore },       // v1.7c
  'drug-comparison': { schema: DrugComparisonSchema, component: DrugComparison },  // v1.7c
  'lab-trend':       { schema: LabTrendSchema,       component: LabTrend },        // v1.7c
  'decision-tree':   { schema: DecisionTreeSchema,   component: DecisionTree },    // v1.7c
};
