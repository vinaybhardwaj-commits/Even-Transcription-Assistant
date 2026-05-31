/**
 * STT Engine Lab — reference-free scoring (L2).
 *
 * For each encounter with >=2 successful ASR engine runs:
 *  (a) inter-engine AGREEMENT — each engine's mean token-similarity to the
 *      others (flags outliers; zero human input).
 *  (b) N-engine LLM JUDGE — a BLINDED qwen call rates each transcript 1-10 +
 *      ranks them (no engine names shown, to avoid brand bias).
 * Results are written back onto each transcription_run row (agreement_score,
 * judge_score, metrics_json{judge_rank,judge_reasoning,...}) + is_winner.
 */
import { sql } from "@/lib/db";
import { qwenJson } from "@/lib/qwen";
import { wer, cer, termRecall } from "./wer";

const MAX_TOKENS = 1500;

function normTokens(text: string): string[] {
  const t = (text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return t.length > MAX_TOKENS ? t.slice(0, MAX_TOKENS) : t;
}

/** 1 - (token-level Levenshtein / max length). 1 = identical, 0 = disjoint. */
function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[n];
  return 1 - dist / Math.max(m, n);
}

export type ScoreItem = { runId: string; engine: string; text: string };

export function computeAgreement(items: ScoreItem[]): Map<string, number> {
  const toks = items.map((i) => normTokens(i.text));
  const out = new Map<string, number>();
  if (items.length < 2) return out; // no peers -> agreement is N/A (null)
  for (let i = 0; i < items.length; i++) {
    let sum = 0, n = 0;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      sum += tokenSimilarity(toks[i], toks[j]); n++;
    }
    out.set(items[i].engine, n ? Math.round((sum / n) * 1000) / 1000 : 1);
  }
  return out;
}

const JUDGE_SYSTEM = `You are an expert medical transcription evaluator. You are shown several transcripts (and/or English translations) of the SAME clinical encounter audio, each from a different speech-to-text engine. You are NOT told which engine produced which — judge only on the text.

Rate each transcript 1-10 on: faithfulness/coherence, plausibility of medical terms (drugs, doses, findings), fluency, and absence of obvious hallucination or garbling. A clearly garbled, empty, or wrong-language transcript scores low.

Output STRICT JSON only, no markdown, this exact shape (one entry per provided transcript label):
{"scores":{"A":<1-10>,"B":<1-10>,...},"ranking":["<best label>",...,"<worst label>"],"reasoning":"<one or two sentences>"}`;

type JudgeOut = { scores: Record<string, number>; ranking: string[]; reasoning: string };

async function judgeTranscripts(items: ScoreItem[], labels: string[]): Promise<JudgeOut | null> {
  if (items.length < 2) return null;
  const user = items.map((it, i) => `Transcript ${labels[i]}:\n${(it.text || "").slice(0, 4000)}`).join("\n\n---\n\n");
  try {
    const r = await qwenJson<JudgeOut>(JUDGE_SYSTEM, user, { temperature: 0, timeoutMs: 60_000 });
    return r.json ?? null;
  } catch {
    return null;
  }
}

export type ScoreResult = { encounter_id: string; scored: number; judged: boolean };

export async function scoreEncounter(encounterId: string): Promise<ScoreResult> {
  const rows = (await sql`
    SELECT id, engine, transcript_english, transcript_original
      FROM transcription_run
     WHERE encounter_id = ${encounterId} AND mode = 'batch' AND tier = 'asr' AND error IS NULL
  `) as Array<{ id: string; engine: string; transcript_english: string | null; transcript_original: string | null }>;
  const items: ScoreItem[] = rows
    .map((r) => ({ runId: r.id, engine: r.engine, text: (r.transcript_english || r.transcript_original || "").trim() }))
    .filter((i) => i.text.length > 0);
  if (items.length === 0) return { encounter_id: encounterId, scored: 0, judged: false };

  const agreement = computeAgreement(items);

  const labels = items.map((_, i) => String.fromCharCode(65 + i));
  const labelToEngine = new Map(labels.map((l, i) => [l, items[i].engine]));
  const j = items.length >= 2 ? await judgeTranscripts(items, labels) : null;

  const judgeByEngine = new Map<string, { score: number | null; rank: number | null }>();
  if (j) {
    const ranking = Array.isArray(j.ranking) ? j.ranking : [];
    ranking.forEach((lab, idx) => {
      const eng = labelToEngine.get(lab);
      if (eng) judgeByEngine.set(eng, { score: typeof j.scores?.[lab] === "number" ? j.scores[lab] : null, rank: idx + 1 });
    });
    for (const [lab, sc] of Object.entries(j.scores ?? {})) {
      const eng = labelToEngine.get(lab);
      if (eng && !judgeByEngine.has(eng)) judgeByEngine.set(eng, { score: typeof sc === "number" ? sc : null, rank: null });
    }
  }

  for (const it of items) {
    const ag = agreement.has(it.engine) ? (agreement.get(it.engine) as number) : null;
    const je = judgeByEngine.get(it.engine);
    const js = je && typeof je.score === "number" ? Math.max(0, Math.min(10, je.score)) : null;
    const meta = JSON.stringify({ judge_rank: je?.rank ?? null, judge_reasoning: j?.reasoning ?? null, agreement_n: items.length, scored_at: new Date().toISOString() });
    await sql`
      UPDATE transcription_run
         SET agreement_score = ${ag}, judge_score = ${js}, metrics_json = COALESCE(metrics_json, '{}'::jsonb) || ${meta}::jsonb
       WHERE id = ${it.runId}
    `;
  }

  // Winner = highest judge score, tie-broken by agreement.
  let winner: ScoreItem | null = null;
  let best = -1;
  for (const it of items) {
    const js = judgeByEngine.get(it.engine)?.score ?? null;
    const ag = agreement.get(it.engine) ?? 0;
    const composite = (js ?? 0) * 10 + ag; // judge dominates; agreement tie-breaks
    if (composite > best) { best = composite; winner = it; }
  }
  if (winner) {
    await sql`UPDATE transcription_run SET is_winner = false WHERE encounter_id = ${encounterId} AND mode = 'batch' AND tier = 'asr'`;
    await sql`UPDATE transcription_run SET is_winner = true WHERE id = ${winner.runId}`;
  }

  return { encounter_id: encounterId, scored: items.length, judged: !!j };
}

/** Score up to `limit` encounters that have unscored batch ASR rows. */
export async function scorePending(limit = 5): Promise<{ processed: number; results: ScoreResult[] }> {
  const encs = (await sql`
    SELECT DISTINCT encounter_id FROM transcription_run
     WHERE mode = 'batch' AND tier = 'asr' AND error IS NULL
       AND COALESCE(NULLIF(TRIM(transcript_english), ''), NULLIF(TRIM(transcript_original), '')) IS NOT NULL
       AND (metrics_json ->> 'scored_at') IS NULL
     LIMIT ${limit}
  `) as Array<{ encounter_id: string }>;
  const results: ScoreResult[] = [];
  for (const e of encs) {
    try { results.push(await scoreEncounter(e.encounter_id)); }
    catch (err) { results.push({ encounter_id: e.encounter_id, scored: 0, judged: false }); void err; }
  }
  return { processed: encs.length, results };
}


/** Clear all scores so every encounter is re-scored fresh (e.g. after a judge-prompt change). */
export async function resetScores(): Promise<number> {
  const r = (await sql`
    UPDATE transcription_run SET agreement_score = NULL, judge_score = NULL, is_winner = false,
           metrics_json = (COALESCE(metrics_json, '{}'::jsonb) - 'scored_at')
     WHERE mode = 'batch' AND tier = 'asr' RETURNING id
  `) as Array<{ id: string }>;
  return r.length;
}

// ---- L3: gold-set objective accuracy (WER/CER + medical-term fidelity) ------

const EXTRACT_SYSTEM = `You extract the clinically critical terms from a medical encounter transcript: drug names, doses with units, lab/vital values, diagnoses, anatomical sites, procedures, and explicit negations (e.g. "no chest pain"). Return STRICT JSON only: {"terms":[{"term":"<verbatim phrase>","type":"drug|dose|finding|diagnosis|site|procedure|negation|other"}]}. Include only terms actually present in the text. Keep each term short (the exact phrase). No commentary.`;

type Term = { term: string; type: string };

/** Extract critical terms from the gold reference. Prefers a cloud LLM (OPENAI_API_KEY)
 *  per the Q1 decision; falls back to the Mac-Mini qwen so it works without a key. */
export async function extractCriticalTerms(reference: string): Promise<{ terms: Term[]; model: string }> {
  const text = (reference || "").slice(0, 8000);
  if (!text.trim()) return { terms: [], model: "none" };

  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const model = process.env.STT_GOLD_EXTRACT_MODEL || "gpt-4o-mini";
      const r = await client.chat.completions.create({
        model, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: text }],
      });
      const j = JSON.parse(r.choices[0]?.message?.content || "{}") as { terms?: Term[] };
      return { terms: Array.isArray(j.terms) ? j.terms.filter((t) => t && t.term) : [], model: `cloud:${model}` };
    } catch { /* fall through to qwen */ }
  }
  try {
    const r = await qwenJson<{ terms?: Term[] }>(EXTRACT_SYSTEM, text, { temperature: 0, timeoutMs: 60_000 });
    return { terms: Array.isArray(r.json?.terms) ? r.json!.terms!.filter((t) => t && t.term) : [], model: "qwen2.5:14b" };
  } catch {
    return { terms: [], model: "none" };
  }
}

/** Compute WER/CER + term-recall for every engine run of a gold-labeled encounter. */
export async function scoreGold(encounterId: string): Promise<{ ok: boolean; engines: number; terms: number }> {
  const g = (await sql`
    SELECT reference_original, reference_english, critical_terms_json
      FROM stt_gold WHERE encounter_id = ${encounterId} LIMIT 1
  `) as Array<{ reference_original: string | null; reference_english: string | null; critical_terms_json: unknown }>;
  if (!g[0]) return { ok: false, engines: 0, terms: 0 };
  const refOrig = (g[0].reference_original || "").trim();
  const refEng = (g[0].reference_english || "").trim();
  const refPrimary = refEng || refOrig;
  if (!refPrimary) return { ok: false, engines: 0, terms: 0 };
  const terms = (Array.isArray(g[0].critical_terms_json) ? g[0].critical_terms_json : []) as Term[];

  const rows = (await sql`
    SELECT id, engine, transcript_english, transcript_original
      FROM transcription_run
     WHERE encounter_id = ${encounterId} AND mode = 'batch' AND tier = 'asr' AND error IS NULL
  `) as Array<{ id: string; engine: string; transcript_english: string | null; transcript_original: string | null }>;

  for (const r of rows) {
    const hyp = (r.transcript_english || r.transcript_original || "");
    const w = wer(refPrimary, hyp);
    const c = cer(refPrimary, hyp);
    const recall = termRecall(terms, hyp);
    const extra: Record<string, unknown> = { gold_scored_at: new Date().toISOString() };
    if (refOrig && r.transcript_original) extra.wer_original = wer(refOrig, r.transcript_original);
    await sql`
      UPDATE transcription_run
         SET wer = ${w}, cer = ${c}, med_term_recall = ${recall},
             metrics_json = COALESCE(metrics_json, '{}'::jsonb) || ${JSON.stringify(extra)}::jsonb
       WHERE id = ${r.id}
    `;
  }
  return { ok: true, engines: rows.length, terms: terms.length };
}

/** Save (upsert) a verbatim gold reference, extract its critical terms, then score WER/term-recall. */
export async function saveGold(opts: {
  encounterId: string;
  referenceOriginal?: string | null;
  referenceEnglish?: string | null;
  referenceLanguage?: string | null;
  adminId?: string | null;
}): Promise<{ ok: boolean; terms: number; terms_model: string; engines: number }> {
  const { encounterId } = opts;
  const refOrig = (opts.referenceOriginal ?? "").trim() || null;
  const refEng = (opts.referenceEnglish ?? "").trim() || null;
  const refPrimary = (refEng || refOrig || "").trim();
  if (!refPrimary) return { ok: false, terms: 0, terms_model: "none", engines: 0 };

  const { terms, model } = await extractCriticalTerms(refPrimary);
  await sql`
    INSERT INTO stt_gold (encounter_id, reference_original, reference_english, reference_language, critical_terms_json, terms_model, labeled_by_admin_id, labeled_at, updated_at)
    VALUES (${encounterId}, ${refOrig}, ${refEng}, ${opts.referenceLanguage ?? null}, ${JSON.stringify(terms)}::jsonb, ${model}, ${opts.adminId ?? null}, NOW(), NOW())
    ON CONFLICT (encounter_id) DO UPDATE SET
      reference_original = EXCLUDED.reference_original,
      reference_english = EXCLUDED.reference_english,
      reference_language = EXCLUDED.reference_language,
      critical_terms_json = EXCLUDED.critical_terms_json,
      terms_model = EXCLUDED.terms_model,
      updated_at = NOW()
  `;
  const scored = await scoreGold(encounterId);
  return { ok: true, terms: terms.length, terms_model: model, engines: scored.engines };
}
