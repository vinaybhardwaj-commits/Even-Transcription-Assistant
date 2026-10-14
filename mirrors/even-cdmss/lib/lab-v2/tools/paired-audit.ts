/**
 * lib/lab-v2/tools/paired-audit.ts — paired signed/override OPD audit.
 *
 * `paired_audit_submit` queues the batch and returns a run id. The lab-v2 cron drains it.
 * Structured override JSON is required. `override_text` is accepted only when
 * `debug_text_override` is set, and a text parse that drops a line is skipped.
 * `paired_audit_status` is counts only.
 * `paired_audit_results` is the de-identified read: pair_key, no uid, no external_ref,
 * no clinician uid, no rationale, no finding subject. `paired_audit_results_identifying`
 * returns those fields and is identifying on every call.
 */
import { z } from 'zod';
import type { Db } from '../db';
import {
  PAIRED_DEFAULT_MODEL, PAIRED_MAX_LLM_CALLS, PAIRED_MAX_OVERRIDE_REPEATS, PAIRED_MAX_PAIRS,
  PAIRED_MAX_SIGNED_REPEATS, PAIRED_UID_RE, hasStructuredContent, overrideUnparsed, type StructuredOverride,
} from '../paired-audit-core';
import {
  pairedAuditResults, pairedAuditResultsIdentifying, pairedAuditStatus, submitPairedAudit,
} from '../paired-audit';

const ARM_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const findingCore = {
  verdict: z.string().nullable(),
  confidence: z.number().nullable(),
  domain: z.string().nullable(),
  informational: z.boolean(),
  signal_type: z.string().nullable(),
  rule_ref: z.string().nullable(),
  lvc_category: z.string().nullable(),
  direction: z.string().nullable(),
  severity: z.string().nullable(),
};

const publicFindingSchema = z.object(findingCore);
const findingSchema = z.object({ ...findingCore, subject: z.string().nullable(), rationale: z.string().nullable() });

const publicFlagSchema = z.object({
  key: z.string(),
  verdict: z.string().nullable(),
  signal_type: z.string().nullable(),
  domain: z.string().nullable(),
  severity: z.string().nullable(),
});

const flagSchema = publicFlagSchema.extend({ subject: z.string().nullable() });

const publicAgreementSchema = z.object({
  key: z.string(),
  signal_type: z.string().nullable(),
  verdict: z.string().nullable(),
  present_in: z.number().int(),
  repeats: z.number().int(),
  agreement: z.number(),
});

const agreementSchema = publicAgreementSchema.extend({ subject: z.string().nullable() });

const medicationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  generic_name: z.string().min(1).max(200).optional(),
  brand: z.string().min(1).max(200).optional(),
  brand_name: z.string().min(1).max(200).optional(),
  dose: z.string().max(80).optional(),
  dosage: z.string().max(80).optional(),
  strength: z.string().max(80).optional(),
  route: z.string().max(80).optional(),
  route_of_administration: z.string().max(80).optional(),
  frequency: z.string().max(80).optional(),
  duration: z.string().max(80).optional(),
  instruction: z.string().max(500).optional(),
  instruction_to_patient: z.string().max(500).optional(),
}).refine((m) => !!(m.name || m.generic_name || m.brand || m.brand_name), {
  message: 'a medication needs a name',
});

const namedSchema = z.union([
  z.string().min(1).max(300),
  z.object({ name: z.string().min(1).max(300) }),
]);

const structuredSchema = z.object({
  medications: z.array(medicationSchema).max(80).optional(),
  diagnoses: z.array(z.object({
    name: z.string().max(300).optional(),
    diagnosis: z.string().max(300).optional(),
    icd_code: z.string().max(32).optional(),
  })).max(40).optional(),
  investigations: z.array(namedSchema).max(40).optional(),
  procedures: z.array(namedSchema).max(40).optional(),
  advice: z.array(z.string().min(1).max(2000)).max(40).optional(),
  plan: z.array(z.string().min(1).max(2000)).max(40).optional(),
  exam: z.array(z.string().min(1).max(2000)).max(40).optional(),
  follow_up: z.union([
    z.string().min(1).max(200),
    z.object({
      type: z.string().max(80).optional(),
      date: z.string().max(40).optional(),
    }),
  ]).optional(),
  reason: z.string().min(1).max(2000).optional(),
  presenting_complaints: z.union([
    z.string().min(1).max(4000),
    z.array(z.string().min(1).max(2000)).max(40),
  ]).optional(),
  no_medications: z.boolean().optional(),
});

const pairSchema = z.object({
  uid: z.string().regex(PAIRED_UID_RE),
  override_text: z.string().min(1).max(100_000).optional(),
  override: structuredSchema.optional(),
  external_ref: z.string().min(1).max(200),
}).superRefine((pair, ctx) => {
  if (!pair.override_text && !hasStructuredContent(pair.override as StructuredOverride | undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a pair needs override (structured) or override_text',
    });
  }
});

const repeatPublic = z.object({
  pair_key: z.string(),
  repeats: z.number().int(),
  identical_flag_sets: z.boolean(),
  flag_agreement: z.array(publicAgreementSchema),
});

const repeatIdentifying = z.object({
  uid: z.string(),
  repeats: z.number().int(),
  identical_flag_sets: z.boolean(),
  flag_agreement: z.array(agreementSchema),
});

export const PAIRED_AUDIT_SCHEMAS = {
  paired_audit_submit: {
    input: z.object({
      experiment_label: z.string().min(1).max(120),
      idempotency_key: z.string().min(1).max(200),
      pairs: z.array(pairSchema).min(1).max(PAIRED_MAX_PAIRS),
      arms: z.tuple([z.string().min(1).max(32), z.string().min(1).max(32)]),
      signed_repeats: z.number().int().min(1).max(PAIRED_MAX_SIGNED_REPEATS).default(1),
      override_repeats: z.number().int().min(1).max(PAIRED_MAX_OVERRIDE_REPEATS).default(1),
      noise_uids: z.array(z.string().regex(PAIRED_UID_RE)).max(PAIRED_MAX_PAIRS).default([]),
      max_llm_calls: z.number().int().min(1).max(PAIRED_MAX_LLM_CALLS),
      max_spend_microusd: z.number().int().positive().nullable().optional(),
      model: z.string().min(3).max(200).default(PAIRED_DEFAULT_MODEL),
      debug_text_override: z.boolean().default(false),
    }).superRefine((data, ctx) => {
      const signed = data.arms.filter((arm) => arm === 'signed').length;
      if (signed !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms'], message: 'arms must include signed exactly once' });
      }
      const other = data.arms.find((arm) => arm !== 'signed');
      if (!other || !ARM_RE.test(other)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['arms'],
          message: 'the non-signed arm must match ^[a-z][a-z0-9_-]{0,31}$',
        });
      }
      const uids = data.pairs.map((p) => p.uid);
      if (new Set(uids).size !== uids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pairs'], message: 'duplicate uid in one batch' });
      }
      const known = new Set(uids);
      if ((data.signed_repeats > 1 || data.override_repeats > 1) && data.noise_uids.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['noise_uids'],
          message: 'repeats above 1 require the subset of uids to repeat',
        });
      }
      for (const uid of data.noise_uids) {
        if (!known.has(uid)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['noise_uids'], message: `noise uid ${uid} is not in pairs` });
        }
      }
      data.pairs.forEach((pair, i) => {
        const structured = pair.override as StructuredOverride | undefined;
        if (structured && overrideUnparsed(structured)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom, path: ['pairs', i, 'override'],
            message: 'override_unparsed',
          });
        }
        if (!data.debug_text_override) {
          if (pair.override_text) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom, path: ['pairs', i, 'override_text'],
              message: 'override_text requires debug_text_override',
            });
          }
          if (!hasStructuredContent(structured)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom, path: ['pairs', i, 'override'],
              message: 'a pair needs a structured override',
            });
          }
        }
      });
    }),
    output: z.object({
      run_id: z.string().uuid(),
      deduplicated: z.boolean(),
      experiment_label: z.string(),
      engine_version: z.string(),
      prompt_hash: z.string(),
      model: z.string(),
      status: z.string(),
      counts: z.object({
        pairs: z.number().int(),
        items: z.number().int(),
        queued: z.number().int(),
      }),
    }),
  },
  paired_audit_status: {
    input: z.object({ run_id: z.string().uuid() }),
    output: z.object({
      run_id: z.string().uuid(),
      status: z.string(),
      stop_reason: z.string().nullable(),
      experiment_label: z.string(),
      engine_version: z.string(),
      prompt_hash: z.string(),
      model: z.string(),
      calls_used: z.number(),
      spend_microusd: z.number(),
      max_llm_calls: z.number(),
      max_spend_microusd: z.number().nullable(),
      external_ref_unkeyed: z.number().int(),
      counts: z.object({
        queued: z.number().int(),
        running: z.number().int(),
        succeeded: z.number().int(),
        deduped: z.number().int(),
        skipped: z.number().int(),
        failed: z.number().int(),
        stopped: z.number().int(),
      }),
    }),
  },
  paired_audit_results: {
    input: z.object({
      run_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.object({
      run_id: z.string().uuid(),
      items: z.array(z.object({
        pair_key: z.string(),
        arm: z.string(),
        repeat_idx: z.number().int(),
        status: z.string(),
        skip_reason: z.string().nullable(),
        input_path: z.string(),
        engine_version: z.string(),
        prompt_hash: z.string(),
        band: z.string().nullable(),
        note_quality_index: z.number().nullable(),
        llm_leg_failed: z.boolean().nullable(),
        findings: z.array(publicFindingSchema),
      })),
      diffs: z.array(z.object({
        pair_key: z.string(),
        only_a: z.array(publicFlagSchema),
        only_b: z.array(publicFlagSchema),
        both: z.array(publicFlagSchema),
      })),
      signed_repeats: z.array(repeatPublic),
      override_repeats: z.array(repeatPublic.extend({ arm: z.string() })),
      limit: z.number().int(),
      offset: z.number().int(),
      total: z.number().int(),
    }),
  },
  paired_audit_results_identifying: {
    input: z.object({
      run_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.object({
      run_id: z.string().uuid(),
      items: z.array(z.object({
        uid: z.string(),
        external_ref: z.string(),
        arm: z.string(),
        repeat_idx: z.number().int(),
        status: z.string(),
        skip_reason: z.string().nullable(),
        input_path: z.string(),
        clinician_uid: z.string().nullable(),
        engine_version: z.string(),
        prompt_hash: z.string(),
        band: z.string().nullable(),
        note_quality_index: z.number().nullable(),
        llm_leg_failed: z.boolean().nullable(),
        findings: z.array(findingSchema),
      })),
      diffs: z.array(z.object({
        uid: z.string(),
        external_ref: z.string(),
        only_a: z.array(flagSchema),
        only_b: z.array(flagSchema),
        both: z.array(flagSchema),
      })),
      signed_repeats: z.array(repeatIdentifying),
      override_repeats: z.array(repeatIdentifying.extend({ arm: z.string() })),
      limit: z.number().int(),
      offset: z.number().int(),
      total: z.number().int(),
    }),
  },
} as const;

type SubmitArgs = {
  experiment_label: string;
  idempotency_key: string;
  pairs: { uid: string; override_text?: string; override?: StructuredOverride; external_ref: string }[];
  arms: [string, string];
  signed_repeats: number;
  override_repeats: number;
  noise_uids: string[];
  max_llm_calls: number;
  max_spend_microusd?: number | null;
  model: string;
  debug_text_override?: boolean;
};

export async function pairedAuditSubmitTool(deps: { db: Db; principal: string }, args: SubmitArgs) {
  return submitPairedAudit(deps.db, deps.principal, {
    experiment_label: args.experiment_label,
    idempotency_key: args.idempotency_key,
    pairs: args.pairs,
    arms: args.arms,
    signed_repeats: args.signed_repeats,
    override_repeats: args.override_repeats,
    noise_uids: args.noise_uids,
    max_llm_calls: args.max_llm_calls,
    max_spend_microusd: args.max_spend_microusd ?? null,
    model: args.model,
    debug_text_override: args.debug_text_override,
  });
}

export async function pairedAuditStatusTool(deps: { db: Db }, args: { run_id: string }) {
  return pairedAuditStatus(deps.db, args.run_id);
}

export async function pairedAuditResultsTool(
  deps: { db: Db },
  args: { run_id: string; limit: number; offset: number },
) {
  return pairedAuditResults(deps.db, args.run_id, args.limit, args.offset);
}

export async function pairedAuditResultsIdentifyingTool(
  deps: { db: Db },
  args: { run_id: string; limit: number; offset: number },
) {
  return pairedAuditResultsIdentifying(deps.db, args.run_id, args.limit, args.offset);
}
