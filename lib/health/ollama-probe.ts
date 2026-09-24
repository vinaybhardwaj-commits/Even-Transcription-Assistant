/**
 * lib/health/ollama-probe.ts — the ONE request the health route and the admin dashboard both make to the ollama host:
 * GET {OLLAMA_BASE_URL}/models. It used to be two copies. It is one so the Cloudflare Access headers
 * (lib/service-access.ts, TUNNEL-HARDENING P2(b), Fable ruling 121) are attached in exactly one place, and testable.
 * The caller decides what a non-2xx means and how long it may take; this returns the Response untouched.
 */
import { withServiceAccess } from "@/lib/service-access";

export async function fetchOllamaModels(base: string, timeoutMs: number): Promise<Response> {
  const url = `${base}/models`;
  return fetch(url, withServiceAccess(url, {
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY ?? "ollama"}` },
    signal: AbortSignal.timeout(timeoutMs),
  }));
}
