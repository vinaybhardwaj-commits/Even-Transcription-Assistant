/**
 * lib/mcp-v2/schema-bridge.ts — Zod 3 → Standard Schema with JSON Schema
 * (LAB-MCP-V2-PRD-v1.0 §14.2, the bridge that section anticipates).
 *
 * WHY THIS FILE EXISTS, MEASURED RATHER THAN ASSUMED.
 *
 * @modelcontextprotocol/server 2.0.0 accepts tool schemas as `StandardSchemaWithJSON`,
 * which its own types define as the intersection of TWO Standard Schema interfaces: the
 * validation half (`~standard.validate`) AND the JSON Schema half (`~standard.jsonSchema`,
 * a converter with `input(options)` / `output(options)`). Its documentation names Zod v4,
 * ArkType and Valibot as libraries that implement both.
 *
 * This repository pins zod to 3.25.76 (§14.2). Zod 3.25's `~standard` was inspected
 * directly and carries exactly `['version', 'vendor', 'validate']` — it implements the
 * validation half and NOT the JSON Schema half. Registering a bare Zod 3 schema therefore
 * fails inside the SDK at `tools/list` time with `std.jsonSchema[io] is not a function`,
 * which was reproduced before this bridge was written.
 *
 * So the bridge supplies the missing half: it walks a Zod 3 type into a JSON Schema once,
 * at registration, and hands the SDK an object that delegates `validate` to Zod and
 * answers `jsonSchema` from the precomputed document. Upgrading the repo to Zod 4 would
 * make this file deletable — that is a deliberate, separate decision, not one to smuggle
 * into a slice whose dependency list is fixed.
 *
 * SCOPE. It covers the Zod constructs lib/lab-v2/contracts.ts actually uses. An
 * unrecognised node degrades to `{}` (the JSON Schema "anything") rather than throwing:
 * the schema is ADVERTISING, while enforcement is Zod's own `validate` here and the
 * explicit dispatch-time parse in lib/lab-v2/service.ts. A slightly loose advertised
 * schema costs a client some autocomplete; a thrown registration would cost the endpoint.
 */
import type { ZodTypeAny } from 'zod';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

export type JsonSchema = Record<string, unknown>;

/** The shape @modelcontextprotocol/server 2.0.0 requires of a tool schema. */
export interface StandardSchemaWithJson {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
    readonly jsonSchema: { readonly input: () => JsonSchema; readonly output: () => JsonSchema };
  };
}

interface ZodDefLike {
  typeName?: string;
  checks?: { kind?: string }[];
  value?: unknown;
  values?: readonly unknown[];
  type?: ZodTypeAny;
  innerType?: ZodTypeAny;
  valueType?: ZodTypeAny;
  options?: ZodTypeAny[];
  shape?: () => Record<string, ZodTypeAny>;
  defaultValue?: () => unknown;
  description?: string;
}

function defOf(t: unknown): ZodDefLike | null {
  const d = (t as { _def?: ZodDefLike } | null)?._def;
  return d ?? null;
}

/** True for wrappers that make a property optional in an object's `required` list. */
function isOptionalNode(t: unknown): boolean {
  const name = defOf(t)?.typeName;
  return name === 'ZodOptional' || name === 'ZodDefault';
}

export function toJsonSchema(t: unknown): JsonSchema {
  const d = defOf(t);
  if (!d) return {};
  const described = (out: JsonSchema): JsonSchema => (d.description ? { ...out, description: d.description } : out);

  switch (d.typeName) {
    case 'ZodString': return described({ type: 'string' });
    case 'ZodNumber': return described(d.checks?.some((c) => c.kind === 'int') ? { type: 'integer' } : { type: 'number' });
    case 'ZodBoolean': return described({ type: 'boolean' });
    case 'ZodNull': return described({ type: 'null' });
    case 'ZodLiteral': return described({ const: d.value as never });
    case 'ZodEnum': return described({ type: 'string', enum: [...(d.values ?? [])] });
    case 'ZodNativeEnum': return described({ type: 'string' });
    case 'ZodArray': return described({ type: 'array', items: toJsonSchema(d.type) });
    case 'ZodOptional': case 'ZodDefault': return toJsonSchema(d.innerType);
    case 'ZodNullable': return described({ anyOf: [toJsonSchema(d.innerType), { type: 'null' }] });
    case 'ZodUnion': return described({ anyOf: (d.options ?? []).map(toJsonSchema) });
    case 'ZodRecord': return described({ type: 'object', additionalProperties: toJsonSchema(d.valueType) });
    case 'ZodAny': case 'ZodUnknown': return described({});
    case 'ZodObject': {
      const shape = typeof d.shape === 'function' ? d.shape() : {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = toJsonSchema(child);
        if (!isOptionalNode(child)) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length) out.required = required;
      return described(out);
    }
    default:
      return {};
  }
}

/**
 * Wrap a Zod 3 schema for the SDK. `validate` is Zod's own Standard Schema entry, so
 * validation semantics are Zod's exactly — the bridge adds a JSON Schema, it does not
 * reimplement checking.
 */
export function sdkSchema(zodType: ZodTypeAny): StandardSchemaWithJSON {
  const json = toJsonSchema(zodType);
  const std = (zodType as unknown as { '~standard': { validate: (v: unknown) => unknown } })['~standard'];
  const converter = { input: () => json, output: () => json };
  const bridged: StandardSchemaWithJson = {
    '~standard': {
      version: 1,
      vendor: 'cdmss-lab-v2',
      validate: (value: unknown) => std.validate(value),
      jsonSchema: converter,
    },
  };
  // The SDK's own interface carries optional phantom `types` members for inference that a
  // hand-built object cannot express; the runtime contract (validate + jsonSchema.input/
  // output) is satisfied exactly, and is covered by lib/lab-v2/__tests__/mcp-surface.test.ts.
  return bridged as unknown as StandardSchemaWithJSON;
}
