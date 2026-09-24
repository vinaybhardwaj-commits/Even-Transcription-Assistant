import OpenAI from 'openai';
import { serviceAccessConfigured, serviceAccessFetch } from '@/lib/service-access';

// EMBEDDINGS ONLY. Nomic on Ollama stays (the KB corpus is nomic-768); there is no chat model here.
// TEXT_MODEL (a local qwen default, read by nobody) was removed on 22 Sep with qwen's exit from ETA.
// OLLAMA_BASE_URL already includes /v1 (verified Sprint 1.F.6 H2)
const baseURL = `${process.env.OLLAMA_BASE_URL!}`;

// TUNNEL-HARDENING P2(b): behind Cloudflare Access the SDK's requests must carry the service token. `serviceAccessFetch` adds it
// per request, only for an allowed https host, and refuses redirects while it does. It is passed ONLY when a token is configured,
// so with none the client is constructed exactly as it always was.
export const llm = new OpenAI({ baseURL, apiKey: 'ollama', ...(serviceAccessConfigured() ? { fetch: serviceAccessFetch } : {}) });

export const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
export const TOP_K = parseInt(process.env.TOP_K || '8', 10);

export async function embedQuery(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding;
}

export function vectorLiteral(v: number[]): string {
  return '[' + v.map((x) => x.toFixed(7)).join(',') + ']';
}
