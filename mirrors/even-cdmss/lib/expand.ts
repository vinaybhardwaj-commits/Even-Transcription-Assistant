import { geminiUtilityModel } from './llm';
import { governedChat } from './trace';
import { evidenceFromCompletion, evidenceFromError, type TelemetryCapture } from './retrieval-capture';

// Use llama3.1:8b for speed — this runs on every retrieval, so we want it cheap.
const FAST_MODEL = 'llama3.1:8b';

/** Fixed seed for the retrieval-LLM calls (query expansion + variant generation). With temperature 0
 *  this makes expansion/variants DETERMINISTIC run-to-run, removing the dominant source of churn in
 *  the retrieved candidate pool. Shared: multi-query.ts imports this via its existing './expand' import. */
export const RETRIEVAL_LLM_SEED = 42;

const SYSTEM = `You are a medical query rewriter. Rewrite the user's clinical question into a single dense paragraph (40-80 words) that:
- Expands medical acronyms (HFrEF → heart failure with reduced ejection fraction; COPD → chronic obstructive pulmonary disease; etc.)
- Uses precise clinical terminology and likely textbook phrasing
- Includes relevant adjacent terms (pathophysiology, diagnostic criteria, first-line management)
- Reads like a textbook excerpt that would directly answer the question — NOT like a question

Return only the paragraph. No preamble, no explanation, no quotes.`;

export async function expandQuery(question: string, traceId?: string, capture?: TelemetryCapture): Promise<string> {
  try {
    // Governed envelope (Stage 4): traceless callers behave exactly as before; a caller
    // that threads its traceId gets the expand/SYSTEM fingerprint stamped.
    const r = await governedChat(traceId, 'expand', {
      model: FAST_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: question },
      ],
      temperature: 0,
      max_tokens: 200,
        ...({ options: { num_ctx: 16384, seed: RETRIEVAL_LLM_SEED }, keep_alive: '15m' } as Record<string, unknown>),
      }, { gemini: geminiUtilityModel(), promptRef: 'expand/SYSTEM' });
    if (capture) {
      capture.expansion = { status: 'expanded', inputText: question, evidence: evidenceFromCompletion(r) };
    }
    const txt = r.choices?.[0]?.message?.content?.trim() || '';
    // Belt + suspenders: always retrieve the ORIGINAL question's terms too, so we don't lose specificity
    return txt ? `${question}\n\n${txt}` : question;
  } catch (e) {
    // ⚠️ THE ERROR IS BOUND (D14). This catch discarded it — `catch {` — so a fail-open expansion
    // left no evidence of WHY, and the failure attribution the transport now attaches to the thrown
    // error was unreachable at the one site that most needed it. Binding it changes nothing about
    // what is returned: the fail-open below is byte-identical.
    if (capture) {
      capture.expansion = { status: 'failed_open', inputText: question, evidence: evidenceFromError(e) };
    }
    return question; // fail open
  }
}
