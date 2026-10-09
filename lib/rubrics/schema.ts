/**
 * lib/rubrics/schema.ts — S7-1: a small validator for the JSON-schema SUBSET a rubric's `output` uses (type, enum, properties, required, additionalProperties, items, minimum/maximum,
 * minLength/maxLength, minItems/maxItems, and a type list such as ["number","null"]). No dependency: ajv is not a direct dependency of this repository, and a rubric's output schema is
 * authored here. Returns the list of problems as short closed strings with a JSON path (never a value), so a problem can be logged without logging model output.
 */
type Json = Record<string, unknown>;

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const matchesType = (t: string, v: unknown): boolean => (t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

export function validateAgainst(schema: Json, value: unknown, path = "$"): string[] {
  const out: string[] = [];
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (types && !types.some((t) => matchesType(t, value))) return [`${path}: type ${typeOf(value)} not in ${types.join("|")}`];
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((e) => e === value)) out.push(`${path}: not in enum`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) out.push(`${path}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) out.push(`${path}: above maximum`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) out.push(`${path}: too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) out.push(`${path}: too long`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) out.push(`${path}: too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) out.push(`${path}: too many items`);
    if (schema.items && typeof schema.items === "object") value.forEach((v, i) => out.push(...validateAgainst(schema.items as Json, v, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Json>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in (value as Json))) out.push(`${path}.${r}: missing`);
    for (const [k, v] of Object.entries(value as Json)) {
      if (props[k]) out.push(...validateAgainst(props[k]!, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
    }
  }
  return out;
}
