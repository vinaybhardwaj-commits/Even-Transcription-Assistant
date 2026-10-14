import { sql } from './db';
import { TEXT_MODEL } from './llm';
import { governedChat } from './trace';

// Curator: mine recent clinician queries → propose NEW high-demand harvest topics.
// PHI-safe: queries go only to the LOCAL Ollama (same as every Ask request); the
// model is instructed to emit GENERALIZED clinical concepts, and only those
// (never raw query text) are stored. New topics auto-enable, capped per run.
const WEEKLY_CAP = 5;

const sqlA = sql as unknown as (q: string, p: unknown[]) => Promise<Array<Record<string, unknown>>>;

export async function runCurator(opts: { days?: number; cap?: number } = {}): Promise<{ considered: number; added: string[]; skipped: number; error?: string }> {
  const days = opts.days ?? 30;
  const cap = opts.cap ?? WEEKLY_CAP;
  try {
    const qrows = (await sqlA(
      `SELECT query_text FROM user_queries
       WHERE feature IN ('ask','ddx') AND query_text IS NOT NULL
         AND char_length(query_text) BETWEEN 8 AND 400
         AND created_at > now() - ($1 || ' days')::interval
       ORDER BY created_at DESC LIMIT 300`,
      [String(days)],
    )) as Array<{ query_text: string }>;
    if (qrows.length === 0) return { considered: 0, added: [], skipped: 0 };

    const existing = (await sqlA(`SELECT topic FROM ingest_topics`, [])) as Array<{ topic: string }>;
    const existingNames = existing.map((e) => e.topic);
    const existingLower = new Set(existingNames.map((n) => n.toLowerCase()));

    const sample = qrows.map((q) => `- ${q.query_text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
    const system =
      'You are a clinical librarian curating PubMed harvest topics for a hospital point-of-care tool. ' +
      'Given real clinician queries and the topics already covered, identify NEW, recurring clinical topics NOT already covered. ' +
      'Output GENERALIZED clinical concepts ONLY — never patient-specific details, names, ages, or identifiers. ' +
      `Return at most ${cap} topics. Respond ONLY with JSON: ` +
      '{"topics":[{"topic":"<short clinical topic label>","query_terms":"<PubMed terms; use \\"quoted phrases\\" and OR/AND>"}]}. ' +
      'If nothing genuinely new is warranted, return {"topics":[]}.';
    const user = `Already covered:\n${existingNames.map((n) => '- ' + n).join('\n')}\n\nRecent clinician queries:\n${sample}`;

    // Governed envelope (Stage 4): traceless + no gemini → byte-identical local call.
    // Inline curator prompt is not a Stage-0 registry asset (operational, not clinical).
    const res = await governedChat(undefined, 'curator_topics', {
      model: TEXT_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
    });
    let rawc = (res.choices?.[0]?.message?.content ?? '').trim();
    if (rawc.startsWith('```')) rawc = rawc.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const match = rawc.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : rawc) as { topics?: Array<{ topic: string; query_terms: string }> };

    const added: string[] = [];
    let skipped = 0;
    for (const t of parsed.topics ?? []) {
      if (added.length >= cap) break;
      if (!t.topic || !t.query_terms) { skipped++; continue; }
      if (existingLower.has(t.topic.trim().toLowerCase())) { skipped++; continue; }
      const ins = (await sqlA(
        `INSERT INTO ingest_topics (topic, query_terms) VALUES ($1,$2) ON CONFLICT (topic) DO NOTHING RETURNING id`,
        [t.topic.trim(), t.query_terms.trim()],
      )) as Array<{ id?: number }>;
      if (ins.length) added.push(t.topic.trim()); else skipped++;
    }
    await sqlA(
      `INSERT INTO ingest_runs (kind, finished_at, found, inserted, detail) VALUES ('curator', now(), $1, $2, $3)`,
      [qrows.length, added.length, JSON.stringify({ added, skipped })],
    );
    return { considered: qrows.length, added, skipped };
  } catch (e) {
    return { considered: 0, added: [], skipped: 0, error: (e as Error).message };
  }
}
