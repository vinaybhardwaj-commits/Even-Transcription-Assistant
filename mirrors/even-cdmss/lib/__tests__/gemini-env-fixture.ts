/**
 * lib/__tests__/gemini-env-fixture.ts — put Vertex "on" for a test file.
 *
 * WHY IT IS A MODULE AND NOT THREE LINES AT THE TOP OF THE TEST. lib/llm.ts captures GCP_PROJECT
 * in a module-level const, and ESM evaluates every import before the importing module's own body
 * runs — so `process.env.GCP_PROJECT = …` written at the top of a test file executes AFTER llm.ts
 * has already read it, and geminiConfigured() stays false. Importing this FIRST is what makes the
 * assignment happen first. Import order is load-bearing:
 *
 *   import './gemini-env-fixture';   // must precede any import that reaches lib/llm.ts
 *   import { defaultJudge } from '../lvc';
 *
 * Values are stubs. Nothing here can reach Vertex — every test that uses it injects the provider
 * call — it only makes the ROUTING decisions (geminiConfigured / geminiModelFor) resolve the way
 * production resolves them.
 */
process.env.GCP_PROJECT = process.env.GCP_PROJECT || 'test-project';
process.env.GCP_SA_KEY = process.env.GCP_SA_KEY || '{"stub":true}';
process.env.GEMINI_ALL = '1';
// LLM_PIPELINE=mini would send every surface local and is the one switch that outranks the above.
delete process.env.LLM_PIPELINE;

export const GEMINI_ENV_READY = true;
