/**
 * lib/mcp/tools/meta.ts — S0.7/S0.8 (8 Oct 2026): the door describes and measures itself.
 *
 *   scribe_help  — one tool's full contract, from the registry. No DB, no network.
 *   scribe_usage — tools/call counts, error rates and latency percentiles from audit_log.
 *
 * Both are read scope and ungrouped. scribe_help imports the surface lazily: surface.ts imports this
 * file for PUBLISHED_TOOLS, so a static import back would be a cycle.
 */
import { sql } from "@/lib/db";
import { argInt, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";

type Surface = typeof import("../surface");
const surface = (): Promise<Surface> => import("../surface");

// ---------------------------------------------------------------------------
// scribe_help
// ---------------------------------------------------------------------------

/** Levenshtein distance, two-row. Names are short (<= 40 chars). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The five accepted names closest to `wanted`: substring and prefix hits first, then token overlap, then edit distance. */
export function closestNames(wanted: string, names: readonly string[], n = 5): string[] {
  const w = wanted.toLowerCase().replace(/^scribe_/, "");
  const wTokens = new Set(w.split(/[_\W]+/).filter(Boolean));
  return names
    .map((name) => {
      const bare = name.toLowerCase().replace(/^scribe_/, "");
      const tokens = bare.split(/[_\W]+/).filter(Boolean);
      const overlap = tokens.filter((t) => wTokens.has(t)).length;
      const contains = w.length >= 3 && (bare.includes(w) || w.includes(bare)) ? 1 : 0;
      const prefix = w.length >= 3 && (bare.startsWith(w) || w.startsWith(bare)) ? 1 : 0;
      return { name, score: contains * 50 + prefix * 30 + overlap * 10 - 3 * editDistance(w, bare) };
    })
    .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name))
    .slice(0, n)
    .map((x) => x.name);
}

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  const cut = flat.search(/(?<=[.!?])\s/);
  const first = cut > 0 ? flat.slice(0, cut) : flat;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

const help: McpTool = {
  name: "scribe_help",
  description:
    "One tool's full contract from the registry: scope, complete description, input schema, and for a group its selector and what each value runs. " +
    "Accepts any name tools/call accepts, old names included. An unknown name answers { error: 'unknown_tool', suggestions } with the five closest names. Reads no database.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: { tool: { type: "string", description: "Tool name, e.g. scribe_rooms or an older name such as scribe_list_rooms." } },
    required: ["tool"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const S = await surface();
    const wanted = argStr(args, "tool", 128);
    const accepted = [...S.CALLABLE_TOOLS.keys()];
    if (!wanted) return { error: "tool_required", suggestions: [] as string[] };
    const tool = S.CALLABLE_TOOLS.get(wanted);
    if (!tool) return { error: "unknown_tool", suggestions: closestNames(wanted, accepted) };

    const members = S.groupMembers(tool);
    if (members.length > 0) {
      // A group: selector + what each value runs.
      const probes = S.groupProbes(tool);
      const keys = new Set(probes.flatMap((p) => Object.keys(p.probe)));
      const isSelector = keys.size === 1 && probes.every((p) => Object.values(p.probe)[0] === p.value);
      const selectorKey = isSelector ? [...keys][0]! : null;
      return {
        name: tool.name,
        scope: tool.scope,
        accepted_legacy_names: members.filter((m) => m !== tool.name),
        description: tool.description,
        input_schema: tool.inputSchema,
        members: {
          selector: selectorKey,
          ...(selectorKey ? {} : { routed_by: "which argument is passed (see description)" }),
          values: probes.map((p) => ({
            value: p.value,
            runs: p.member,
            meaning: oneLine(S.CALLABLE_TOOLS.get(p.member)?.description ?? ""),
            ...(selectorKey ? {} : { example_args: p.probe }),
          })),
        },
      };
    }

    // Ungrouped, or an old name that a group now fronts.
    const group = S.GROUPS.find((g) => S.groupMembers(g).includes(tool.name));
    return {
      name: tool.name,
      scope: tool.scope,
      ...(group ? { group: group.name, listed: false } : { listed: true }),
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  },
};

// ---------------------------------------------------------------------------
// scribe_usage
// ---------------------------------------------------------------------------

const USAGE_DEFAULT_HOURS = 24;
const USAGE_MAX_HOURS = 336;
const USAGE_MAX_ROWS = 100;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

const usage: McpTool = {
  name: "scribe_usage",
  description:
    "How the door has been used, from audit_log: per tool (and group variant) the calls, errors, error_rate, p50/p95/max latency in ms and the actors, plus calls per actor. " +
    "An error is a row whose ok is false — the handler threw OR answered { error } / { degraded: true } (rows before 8 Oct 2026 count throws only). since_hours default 24, max 336; tool filters to one tool name as called. per_tool is capped at 100 rows.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      since_hours: { type: "number", minimum: 1, maximum: USAGE_MAX_HOURS, default: USAGE_DEFAULT_HOURS, description: "Look-back window in hours." },
      tool: { type: "string", description: "Only calls whose target tool is this name (as called, e.g. scribe_rooms)." },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const hours = argInt(args, "since_hours", USAGE_DEFAULT_HOURS, 1, USAGE_MAX_HOURS);
    const tool = argStr(args, "tool", 128);
    return failSafe({ since_hours: hours, total: 0, per_tool: [] as unknown[], per_actor: [] as unknown[] }, async () => {
      // Bound parameters only. `tool` is passed as NULL or text; ::text keeps the NULL typed.
      const [perTool, perActor, totalRows] = await Promise.all([
        sql`
          SELECT target_id AS tool,
                 COALESCE(metadata_json->>'variant', '') AS variant,
                 count(*)::int AS calls,
                 (count(*) FILTER (WHERE metadata_json->>'ok' = 'false'))::int AS errors,
                 percentile_cont(0.5)  WITHIN GROUP (ORDER BY NULLIF(metadata_json->>'ms', '')::numeric) AS p50_ms,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY NULLIF(metadata_json->>'ms', '')::numeric) AS p95_ms,
                 max(NULLIF(metadata_json->>'ms', '')::numeric) AS max_ms,
                 jsonb_agg(DISTINCT actor_id) AS actors
            FROM audit_log
           WHERE action = 'mcp.tools/call'
             AND created_at >= now() - make_interval(hours => ${hours}::int)
             AND (${tool}::text IS NULL OR target_id = ${tool}::text)
           GROUP BY target_id, COALESCE(metadata_json->>'variant', '')
           ORDER BY count(*) DESC, target_id ASC
           LIMIT ${USAGE_MAX_ROWS}::int
        `,
        sql`
          SELECT actor_id AS actor, count(*)::int AS calls
            FROM audit_log
           WHERE action = 'mcp.tools/call'
             AND created_at >= now() - make_interval(hours => ${hours}::int)
             AND (${tool}::text IS NULL OR target_id = ${tool}::text)
           GROUP BY actor_id
           ORDER BY count(*) DESC, actor_id ASC
           LIMIT ${USAGE_MAX_ROWS}::int
        `,
        sql`
          SELECT count(*)::int AS n
            FROM audit_log
           WHERE action = 'mcp.tools/call'
             AND created_at >= now() - make_interval(hours => ${hours}::int)
             AND (${tool}::text IS NULL OR target_id = ${tool}::text)
        `,
      ]);
      return {
        since_hours: hours,
        ...(tool ? { tool } : {}),
        total: num((totalRows as Array<{ n: unknown }>)[0]?.n),
        per_tool: (perTool as Array<Record<string, unknown>>).map((r) => {
          const calls = num(r.calls);
          const errors = num(r.errors);
          const actors = Array.isArray(r.actors) ? (r.actors as unknown[]).filter((a): a is string => typeof a === "string") : [];
          return {
            tool: String(r.tool),
            ...(r.variant ? { variant: String(r.variant) } : {}),
            calls,
            errors,
            error_rate: calls > 0 ? Math.round((errors / calls) * 10000) / 10000 : 0,
            p50_ms: round1(num(r.p50_ms)),
            p95_ms: round1(num(r.p95_ms)),
            max_ms: round1(num(r.max_ms)),
            actors,
          };
        }),
        per_actor: (perActor as Array<Record<string, unknown>>).map((r) => ({ actor: String(r.actor), calls: num(r.calls) })),
      };
    });
  },
};

export const META_TOOLS: McpTool[] = [help, usage];
