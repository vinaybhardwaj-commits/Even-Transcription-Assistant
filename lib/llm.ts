import OpenAI from 'openai';

const baseURL = `${process.env.OLLAMA_BASE_URL!}/v1`;

export const llm = new OpenAI({ baseURL, apiKey: 'ollama' });

export const TEXT_MODEL = process.env.TEXT_MODEL || 'qwen2.5:14b';
export const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
export const TOP_K = parseInt(process.env.TOP_K || '8', 10);

export async function embedQuery(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding;
}

export function vectorLiteral(v: number[]): string {
  return '[' + v.map((x) => x.toFixed(7)).join(',') + ']';
}
