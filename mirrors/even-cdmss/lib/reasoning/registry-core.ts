/**
 * lib/reasoning/registry-core.ts — pure load/validate/merge for the prompt registry
 * (Reasoning Observability Stage 0). Joins the GENERATED registry facts
 * (data/reasoning-registry/prompts.generated.json, written by scripts/reasoning-registry-gen.mjs)
 * with the hand-authored sidecar metadata (./manifest.ts) into the research-export payload.
 *
 * RESEARCH-ONLY CONTRACT: the export contains prompt/rubric/metadata fields ONLY — no clinical
 * data, no patient text, no trace/run content, no PHI. renderRegistryExport() enforces this
 * structurally (per-section key allowlists; an unexpected key is a hard throw), and
 * lib/__tests__/reasoning-registry.test.ts additionally scans every key against a forbidden
 * pattern. Pure module: no db, no fetch, no env.
 */

import GENERATED from '../../data/reasoning-registry/prompts.generated.json';
import { PROMPT_MANIFESTS, ENGINE_MANIFESTS, type Maturity, type EngineManifest } from './manifest';

export type { Maturity, EngineManifest } from './manifest';

/** Engine lookup (additive, IPD M1): resolve an engine_version string — base or a declared
 *  variant (e.g. '-mini') — to its EngineManifest. Unknown id → null, never a throw. */
export function engineManifestFor(engineVersion: string): EngineManifest | null {
  return ENGINE_MANIFESTS.find((e) => e.id === engineVersion || (e.variants ?? []).includes(engineVersion)) ?? null;
}

export interface GeneratedPrompt {
  id: string;
  const: string;
  feature: string;
  group: string;
  file: string;
  kind: string;
  version_hint: string;
  sha256: string;
  sha12: string;
  chars: number;
  lines: number;
  text: string;
}

export interface RegistryPrompt extends GeneratedPrompt {
  maturity: Maturity;
  owner: string | null;             // honest blank until assigned in the manifest
  clinicianApprover: string | null;
  rubricId: string | null;
  schemaId: string | null;
}

export interface GeneratedRubric {
  id: string;
  kind: string;
  version: string;
  source?: string;
  feature?: string;
  sha256?: string;
  keys?: string[];
  meta?: unknown;
  embedded_in?: string;
  text?: string | null;
}

export interface RegistryBuilder { fn: string; file: string; feature: string }

export interface RegistryExport {
  export: string;
  schema: string;
  source_repo: string;
  scope_note: string;
  coverage_note: string;
  counts: { prompts: number; rubrics: number; user_message_builders: number; features: number };
  prompts: RegistryPrompt[];
  rubrics: GeneratedRubric[];
  user_message_builders: RegistryBuilder[];
}

/** Sidecar lookup. Unknown/unlisted id → 'unregistered' metadata — NEVER a throw (PRD §6). */
export function manifestFor(id: string): Pick<RegistryPrompt, 'maturity' | 'owner' | 'clinicianApprover' | 'rubricId' | 'schemaId'> {
  const m = PROMPT_MANIFESTS.find((p) => p.id === id);
  if (!m) return { maturity: 'unregistered', owner: null, clinicianApprover: null, rubricId: null, schemaId: null };
  return {
    maturity: m.maturity,
    owner: m.owner ?? null,
    clinicianApprover: m.clinicianApprover ?? null,
    rubricId: m.rubricId ?? null,
    schemaId: m.schemaId ?? null,
  };
}

// ── invocation-envelope fingerprint (Stage 1) ───────────────────────────────────────────────────

export interface PromptFingerprint {
  id: string;
  version: string;                          // the registry version hint (e.g. 'OPD_ENGINE_VERSION=…' | 'unversioned (git-tracked)')
  hash: string;                             // sha256 of the exact prompt text (from the generated registry — never recomputed here)
  schemaId: string | null;                  // from the sidecar manifest (none registered yet)
  rubricIds: string[];                      // linked rubric ids from the sidecar manifest
  rubricVersions: Record<string, string>;   // rubricId → registry version string (→ trace_events.rubric_versions)
}

/**
 * Resolve a registry id to its invocation-envelope fingerprint — the SINGLE source
 * tracedChat stamps from (a hash is never hardcoded at a call site). Pure: reads the
 * committed generated registry + sidecar manifest only. Unknown id → null, never a throw
 * (an untagged or mistagged call degrades to model/token columns only).
 */
export function promptFingerprint(id: string): PromptFingerprint | null {
  const gen = GENERATED as unknown as { prompts: GeneratedPrompt[]; rubrics: GeneratedRubric[] };
  const p = gen.prompts.find((x) => x.id === id);
  if (!p) return null;
  const m = manifestFor(id);
  const rubricIds = m.rubricId ? [m.rubricId] : [];
  const rubricVersions: Record<string, string> = {};
  for (const rid of rubricIds) {
    const r = gen.rubrics.find((x) => x.id === rid);
    if (r?.version) rubricVersions[rid] = r.version;
  }
  return { id: p.id, version: p.version_hint, hash: p.sha256, schemaId: m.schemaId, rubricIds, rubricVersions };
}

// ── research-only key allowlists (structural enforcement) ───────────────────────────────────────
const PROMPT_KEYS = new Set(['id', 'const', 'feature', 'group', 'file', 'kind', 'version_hint',
  'sha256', 'sha12', 'chars', 'lines', 'text', 'maturity', 'owner', 'clinicianApprover', 'rubricId', 'schemaId']);
const RUBRIC_KEYS = new Set(['id', 'kind', 'version', 'source', 'feature', 'sha256', 'keys', 'meta', 'embedded_in', 'text']);
const BUILDER_KEYS = new Set(['fn', 'file', 'feature']);
const TOP_KEYS = new Set(['export', 'schema', 'source_repo', 'scope_note', 'coverage_note',
  'counts', 'prompts', 'rubrics', 'user_message_builders']);

function assertKeys(obj: object, allowed: Set<string>, what: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`registry export: unexpected ${what} key "${k}" — research export carries prompt/rubric/metadata fields only`);
  }
}

/**
 * The research-export payload: generated facts + sidecar metadata, nothing else.
 * Deterministic (a pure projection of two committed files).
 */
export function renderRegistryExport(): RegistryExport {
  const gen = GENERATED as unknown as {
    export: string; schema: string; source_repo: string; scope_note: string; coverage_note: string;
    counts: RegistryExport['counts'];
    prompts: GeneratedPrompt[]; rubrics: GeneratedRubric[]; user_message_builders: RegistryBuilder[];
  };
  const payload: RegistryExport = {
    export: gen.export,
    schema: gen.schema,
    source_repo: gen.source_repo,
    scope_note: gen.scope_note,
    coverage_note: gen.coverage_note,
    counts: gen.counts,
    prompts: gen.prompts.map((p) => ({ ...p, ...manifestFor(p.id) })),
    rubrics: gen.rubrics,
    user_message_builders: gen.user_message_builders,
  };
  assertKeys(payload, TOP_KEYS, 'top-level');
  for (const p of payload.prompts) assertKeys(p, PROMPT_KEYS, 'prompt');
  for (const r of payload.rubrics) assertKeys(r, RUBRIC_KEYS, 'rubric');
  for (const b of payload.user_message_builders) assertKeys(b, BUILDER_KEYS, 'builder');
  return payload;
}

// ── Stage 2 — pure UI formatters (server components render these; no DB here) ───────────────────

/** 'NAME=value' version hint → 'value'; 'unversioned (git-tracked)' → 'unversioned'. */
export function shortVersion(hint: string): string {
  if (!hint) return '—';
  const eq = hint.indexOf('=');
  if (eq > 0) return hint.slice(eq + 1);
  return hint.startsWith('unversioned') ? 'unversioned' : hint;
}

/** Compact prompt ref for table cells: 'lvc-core/JUDGE_SYSTEM' → 'lvc-core/judge'. */
export function shortPromptRef(id: string): string {
  const slash = id.indexOf('/');
  if (slash < 0) return id;
  const file = id.slice(0, slash);
  const c = id.slice(slash + 1).replace(/_SYSTEM$/, '').toLowerCase();
  return `${file}/${c || 'system'}`;
}

export interface RegistryTabRow {
  id: string; shortId: string; version: string; sha12: string; feature: string; group: string;
  rubricId: string | null; schemaId: string | null; owner: string | null; clinicianApprover: string | null;
  maturity: Maturity; chars: number; lines: number; text: string;
}

/** The Reasoning-tab registry view: one display row per prompt, generated + manifest merged. */
export function registryTabRows(): RegistryTabRow[] {
  return renderRegistryExport().prompts.map((p) => ({
    id: p.id, shortId: shortPromptRef(p.id), version: shortVersion(p.version_hint), sha12: p.sha12,
    feature: p.feature, group: p.group, rubricId: p.rubricId, schemaId: p.schemaId,
    owner: p.owner, clinicianApprover: p.clinicianApprover, maturity: p.maturity,
    chars: p.chars, lines: p.lines, text: p.text,
  }));
}

/** Raw envelope row as read from trace_events (every field nullable — pre-Stage-1 rows). */
export interface EnvelopeEventRow {
  seq?: number | null; stage?: string | null;
  prompt_id?: string | null; prompt_version?: string | null; prompt_hash?: string | null;
  rubric_versions?: unknown; output_schema_version?: string | null;
  call_model?: string | null; call_provider?: string | null; gen_params?: unknown;
  tokens_in?: number | null; tokens_out?: number | null; latency_ms?: number | null;
}

export interface FingerprintRow {
  promptId: string; shortId: string; version: string; sha12: string;
  rubrics: string[]; schema: string | null; model: string | null; provider: string | null;
  temperature: string | null; maxTokens: string | null;
}

function asObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } }
  return {};
}

/** Distinct fingerprints in a trace, from raw envelope rows. NULL-tolerant by contract:
 *  pre-Stage-1 rows (no prompt_id) are skipped, never a throw; empty in → empty out. */
export function fingerprintRows(rows: EnvelopeEventRow[]): FingerprintRow[] {
  const out = new Map<string, FingerprintRow>();
  for (const r of rows ?? []) {
    const id = r?.prompt_id;
    if (!id) continue;
    const gp = asObj(r.gen_params);
    const existing = out.get(id);
    const row: FingerprintRow = existing ?? {
      promptId: id, shortId: shortPromptRef(id),
      version: shortVersion(String(r.prompt_version ?? '')),
      sha12: String(r.prompt_hash ?? '').slice(0, 12) || '—',
      rubrics: Object.keys(asObj(r.rubric_versions)),
      schema: r.output_schema_version ?? null,
      model: null, provider: null, temperature: null, maxTokens: null,
    };
    if (r.call_model) row.model = String(r.call_model);
    if (r.call_provider) row.provider = String(r.call_provider);
    if (gp.temperature != null) row.temperature = String(gp.temperature);
    if (gp.max_tokens != null) row.maxTokens = Number(gp.max_tokens).toLocaleString();
    out.set(id, row);
  }
  return [...out.values()];
}

export interface StageRollupRow {
  stage: string; promptShortId: string | null; model: string | null;
  tokensIn: number | null; tokensOut: number | null; latencyMs: number | null;
}

/** Per-stage LLM rollup: one row per response-bearing event (tokens present). NULL-tolerant. */
export function stageRollupRows(rows: EnvelopeEventRow[]): StageRollupRow[] {
  return (rows ?? [])
    .filter((r) => r && (r.tokens_in != null || r.tokens_out != null))
    .map((r) => ({
      stage: String(r.stage ?? '—'),
      promptShortId: r.prompt_id ? shortPromptRef(r.prompt_id) : null,
      model: r.call_model ? String(r.call_model) : null,
      tokensIn: r.tokens_in ?? null,
      tokensOut: r.tokens_out ?? null,
      latencyMs: r.latency_ms ?? null,
    }));
}

export interface PromptVersionCostRow { promptId: string; promptVersion: string; model: string; hi: boolean; inTok: number; outTok: number; calls: number }
export interface PromptVersionCostGroup { key: string; label: string; inr: number; calls: number }

/** Pure by-prompt-version cost aggregation (the 4th cost breakdown). `price` is injected so
 *  the pricing config stays in lib/llm-cost — this only groups and sums. */
export function groupPromptVersionCost(
  rows: PromptVersionCostRow[],
  price: (model: string, inTok: number, outTok: number, hi: boolean) => number,
): PromptVersionCostGroup[] {
  const map = new Map<string, PromptVersionCostGroup>();
  for (const r of rows ?? []) {
    if (!r?.promptId) continue;
    const key = `${r.promptId} · ${shortVersion(r.promptVersion || '')}`;
    const g = map.get(key) ?? { key, label: `${shortPromptRef(r.promptId)} · ${shortVersion(r.promptVersion || '')}`, inr: 0, calls: 0 };
    g.inr += price(r.model, r.inTok, r.outTok, r.hi);
    g.calls += r.calls;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.inr - a.inr);
}

export interface VersionFirstSeen { promptId: string; promptVersion: string; firstSeenMs: number }
export interface VersionChange { promptId: string; shortId: string; fromVersion: string; toVersion: string; firstSeenMs: number }

/** Prompt-version rollouts inside the watch window: a prompt whose NEWEST version first
 *  appeared after `cutoffMs` while an older version existed before it. Feeds the
 *  regression-watch attribution line. Pure; empty/NULL-tolerant. */
export function promptVersionChanges(rows: VersionFirstSeen[], cutoffMs: number): VersionChange[] {
  const byPrompt = new Map<string, VersionFirstSeen[]>();
  for (const r of rows ?? []) {
    if (!r?.promptId || !Number.isFinite(r.firstSeenMs)) continue;
    const list = byPrompt.get(r.promptId) ?? [];
    list.push(r);
    byPrompt.set(r.promptId, list);
  }
  const out: VersionChange[] = [];
  for (const [promptId, list] of byPrompt) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.firstSeenMs - b.firstSeenMs);
    const newest = sorted[sorted.length - 1];
    if (newest.firstSeenMs >= cutoffMs) {
      out.push({
        promptId, shortId: shortPromptRef(promptId),
        fromVersion: shortVersion(sorted[sorted.length - 2].promptVersion),
        toVersion: shortVersion(newest.promptVersion),
        firstSeenMs: newest.firstSeenMs,
      });
    }
  }
  return out.sort((a, b) => b.firstSeenMs - a.firstSeenMs);
}

/**
 * Governed-layer coverage SNAPSHOT rendered by the Reasoning tab. The live scan
 * (scripts/reasoning-governance-check.mjs) reads the source tree, which does not exist in
 * the deployed serverless bundle — so the tab renders this committed snapshot, and
 * lib/__tests__/reasoning-ui-core.test.ts diffs it against the LIVE scan in CI: any new
 * direct call site fails the build until this snapshot (and the tab) is updated.
 * Stage 4: every direct site migrated through the governed layer; the scan is a HARD CI
 * gate (exit 1) and this snapshot's zeros are what it enforces. The concordance runs table
 * remains as the feature's own result store, mirrored into `traces` (no longer blind).
 * (Human wording here on purpose — the literal table name would count as a reference in
 * the scan's parallel-store pattern.)
 */
export const GOVERNANCE_SNAPSHOT = {
  capturedAt: 'Stage 4',
  directSites: 0,
  directFiles: 0,
  concordanceRefs: 15,
  taggedPromptRefs: 11,   // Right Care family wrappers (lvc/pathway/doc-audit) + PR5 cite-gate (verify-core/VERIFY_SYSTEM)
  ungovernedFiles: [] as string[],
};

// ── HTML rendering for ?format=html (pure string; self-contained, no scripts) ──────────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderRegistryHtml(x: RegistryExport): string {
  const promptRows = x.prompts.map((p) => `
    <tr><td><code>${esc(p.id)}</code></td><td>${esc(p.feature)}</td><td>${esc(p.maturity)}</td>
    <td>${esc(p.rubricId ?? '—')}</td><td>${esc(p.version_hint)}</td><td><code>${esc(p.sha12)}</code></td>
    <td class="n">${p.chars}</td></tr>
    <tr class="text"><td colspan="7"><details><summary>prompt text (${p.lines} lines)</summary><pre>${esc(p.text)}</pre></details></td></tr>`).join('');
  const rubricRows = x.rubrics.map((r) => `
    <tr><td><code>${esc(r.id)}</code></td><td>${esc(r.kind)}</td><td>${esc(r.embedded_in ?? r.source ?? '—')}</td><td>${esc(r.version)}</td></tr>`).join('');
  const builderRows = x.user_message_builders.map((b) => `
    <tr><td><code>${esc(b.fn)}</code></td><td>${esc(b.file)}</td><td>${esc(b.feature)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>CDMSS reasoning registry</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;color:#0f172a;margin:2rem auto;max-width:64rem;padding:0 1rem}
table{border-collapse:collapse;width:100%;margin:0 0 2rem}th,td{border:1px solid #e2e8f0;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f8fafc}code{font-size:12px}pre{white-space:pre-wrap;font-size:12px;background:#f8fafc;padding:8px;border-radius:4px}
.n{text-align:right}.note{color:#64748b;font-size:13px;max-width:56rem}tr.text td{border-top:none}
</style></head><body>
<h1>CDMSS reasoning registry</h1>
<p class="note">${esc(x.scope_note)}</p>
<p class="note">${esc(x.coverage_note)}</p>
<p><b>${x.counts.prompts}</b> prompts · <b>${x.counts.rubrics}</b> rubrics · <b>${x.counts.user_message_builders}</b> user-message builders · <b>${x.counts.features}</b> features · schema <code>${esc(x.schema)}</code></p>
<h2>Prompts</h2>
<table><thead><tr><th>id</th><th>feature</th><th>maturity</th><th>rubric</th><th>version hint</th><th>sha12</th><th>chars</th></tr></thead><tbody>${promptRows}</tbody></table>
<h2>Rubrics</h2>
<table><thead><tr><th>id</th><th>kind</th><th>where</th><th>version</th></tr></thead><tbody>${rubricRows}</tbody></table>
<h2>User-message builders</h2>
<table><thead><tr><th>fn</th><th>file</th><th>feature</th></tr></thead><tbody>${builderRows}</tbody></table>
</body></html>`;
}
