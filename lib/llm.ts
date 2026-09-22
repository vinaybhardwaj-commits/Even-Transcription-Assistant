import OpenAI from 'openai';

// EMBEDDINGS ONLY. Nomic on Ollama stays (the KB corpus is nomic-768); there is no chat model here.
// TEXT_MODEL (a local qwen default, read by nobody) was removed on 22 Sep with qwen's exit from ETA.
// OLLAMA_BASE_URL already includes /v1 (verified Sprint 1.F.6 H2)
const baseURL = `${process.env.OLLAMA_BASE_URL!}`;

export const llm = new OpenAI({ baseURL, apiKey: 'ollama' });

export const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
export const TOP_K = parseInt(process.env.TOP_K || '8', 10);

export async function embedQuery(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding;
}

export function vectorLiteral(v: number[]): string {
  return '[' + v.map((x) => x.toFixed(7)).join(',') + ']';
}
