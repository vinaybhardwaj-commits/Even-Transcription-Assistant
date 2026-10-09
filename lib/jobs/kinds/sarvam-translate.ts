/**
 * lib/jobs/kinds/sarvam-translate.ts — S8A. Translate a STORED non-English transcript to English with mayura:v1 through the AWS gateway.
 *
 *   args: exactly one of { encounter_id } | { transcription_run_id }, where the run's subject_type must be 'encounter'.
 *   A bench window, a window-subject run, or any room/session argument is scope_consult_only: room tape text is not sent to Sarvam (V's standing rule).
 *   prepare    pick the stored text (encounter: transcript_original, else transcript_raw; run: transcript_original), decide whether it needs translating,
 *              write the R2 object mcp-sarvam/<job_id>.json with no English yet
 *   translate  <= 900-char requests, spread over claims; the deadline is checked per chunk and the English so far is saved after EACH chunk
 *
 * NEVER WRITES a clinical table: it reads encounter / transcription_run and writes one R2 object. Already-English (the language code says so) or
 * empty text finishes `done` with a reason and makes NO Sarvam call. With NO language code nothing is assumed: the text is sent with source "auto"
 * (lib/sarvam.ts:312). Transient errors (429, 5xx, timeout) throw, so the runner retries; a terminal 4xx fails the job.
 * The text lives in R2 and in the source row only, never in `progress` or `result`.
 */
import { z } from "zod";
import { sql } from "@/lib/db";
import { gatewayConfigured } from "@/lib/sarvam-gateway";
import { chunkText, gwTranslateChunk, SARVAM_GW_TRANSLATE_MODEL } from "@/lib/sarvam-gw";
import { appendLedger, touchLane } from "@/lib/sarvam-lab";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { jobError } from "../errors";
import { detectScript, isNonLatinScript, nonLatinLetterRatio } from "@/lib/script-detect";
import { looksNonEnglish, readJson, resultKey, writeJson } from "./sarvam-common";
import { ROOM_AUDIO_ARGS, sarvamTiming } from "./sarvam-transcribe";

export const SARVAM_TRANSLATE_KIND = "sarvam_translate";
const STEPS = { prepare: "prepare", translate: "translate" } as const;

const Args = z.object({
  encounter_id: z.string().trim().min(1).max(128).optional(),
  transcription_run_id: z.string().trim().min(1).max(128).optional(),
}).strict();

export type SarvamTranslateArgs = { kind: "encounter"; id: string } | { kind: "transcription_run"; id: string };

/** PURE. Exactly one source id; window / room / session sources are scope_consult_only. */
export function parseSarvamTranslateArgs(raw: unknown): SarvamTranslateArgs {
  const o = (raw ?? {}) as Record<string, unknown>;
  const room = ROOM_AUDIO_ARGS.filter((k) => o[k] !== undefined && o[k] !== null);
  if (room.length > 0) throw new JobArgsError(`scope_consult_only: only an encounter transcript may be sent to Sarvam (not ${room.join(", ")})`);
  const p = Args.safeParse(o);
  if (!p.success) throw new JobArgsError(`bad args: ${p.error.issues[0]?.path.join(".") || "args"} ${p.error.issues[0]?.message ?? ""}`.trim().slice(0, 160));
  const a = p.data;
  if ((a.encounter_id === undefined) === (a.transcription_run_id === undefined)) throw new JobArgsError("give exactly one of encounter_id, transcription_run_id");
  return a.encounter_id !== undefined ? { kind: "encounter", id: a.encounter_id } : { kind: "transcription_run", id: a.transcription_run_id! };
}

type Picked = { text: string; language: string | null; column: string } | "missing" | "scope";

/** The stored text to translate, read fresh each step (stable). A run counts only when its subject is an ENCOUNTER. */
export async function pickSourceText(a: SarvamTranslateArgs): Promise<Picked> {
  if (a.kind === "encounter") {
    const rows = (await sql`SELECT transcript_original, transcript_raw, detected_language FROM encounter WHERE id = ${a.id}::text LIMIT 1`) as Array<Record<string, string | null>>;
    const r = rows[0];
    if (!r) return "missing";
    const orig = (r.transcript_original ?? "").trim();
    return orig ? { text: orig, language: r.detected_language ?? null, column: "transcript_original" } : { text: (r.transcript_raw ?? "").trim(), language: r.detected_language ?? null, column: "transcript_raw" };
  }
  const rows = (await sql`SELECT subject_type, transcript_original, detected_language FROM transcription_run WHERE id = ${a.id}::text LIMIT 1`) as Array<Record<string, string | null>>;
  const r = rows[0];
  if (!r) return "missing";
  if (r.subject_type !== "encounter") return "scope";
  return { text: (r.transcript_original ?? "").trim(), language: r.detected_language ?? null, column: "transcript_original" };
}

/**
 * S8A4: what to translate. The file-level language label is not trusted to say "all English": when it says non-English (or says nothing) the whole text is one unit, as
 * before; when it says English, the text is split into sentences and every sentence written in an Indic script is a unit of its own, so a Kannada line inside an
 * en-IN-labelled consult is translated and the English sentences around it are kept verbatim. PURE and deterministic (the same text always gives the same units).
 */
export type Unit = { text: string; translate: boolean };
export function planUnits(text: string, language: string | null): Unit[] {
  if (looksNonEnglish(text, language)) return [{ text, translate: true }];
  const units: Unit[] = [];
  for (const sentence of text.split(/(?<=[.!?।\n])\s+/)) {
    if (!sentence.trim()) continue;
    const translate = isNonLatinScript(detectScript(sentence)) || nonLatinLetterRatio(sentence) > 0.15; // ANY non-Latin script (Urdu included), not only the nine Indic ones
    const last = units[units.length - 1];
    if (last && last.translate === translate) last.text += ` ${sentence}`;
    else units.push({ text: sentence, translate });
  }
  return units;
}
const chunksOf = (units: Unit[]): string[] => units.filter((u) => u.translate).flatMap((u) => chunkText(u.text));
/** The English text: translated units from `parts` (in chunk order), the others verbatim. */
function assemble(units: Unit[], parts: string[]): string {
  let k = 0;
  return units.map((u) => (u.translate ? chunkText(u.text).map(() => parts[k++] ?? "").join(" ").trim() : u.text)).filter(Boolean).join(" ").trim();
}

type Doc = { source: { kind: string; id: string; column: string }; chars_in: number; chars_out: number; english: string; parts: string[]; chunks_total: number; language: string | null };

export const sarvamTranslateKind: JobKind = {
  name: SARVAM_TRANSLATE_KIND,
  first: STEPS.prepare,
  roomData: false,
  roomDataNote: "source is an encounter or an stt run of an encounter (no room placement); anything else is refused",
  scope: "invoke",
  parseArgs: (raw) => parseSarvamTranslateArgs(raw) as unknown as Record<string, unknown>,
  // S4: one open job per (source kind, id); a second ask returns the open job's id
  dedupeOn: (args) => {
    const a = args as unknown as SarvamTranslateArgs;
    return [["kind", a.kind], ["id", a.id]];
  },
  async run(ctx: StepContext) {
    const out = await runStep(ctx);
    // a job that never reached Sarvam (prepare ended it) is not "Sarvam work"; the lane still gets its end-of-work rewrite
    const terminal = out.kind !== "next";
    await touchLane({ force: terminal, excludeJobId: terminal ? ctx.job.id : null });
    return out;
  },
};

async function runStep(ctx: StepContext): Promise<StepOutcome> {
  switch (ctx.step) {
    case STEPS.prepare: return prepareStep(ctx);
    case STEPS.translate: return translateStep(ctx);
    default: return failWith(jobError("unknown_step", ctx.step));
  }
}

async function prepareStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as unknown as SarvamTranslateArgs;
  const picked = await pickSourceText(a);
  if (picked === "missing") return failWith(jobError("source_not_found"));
  if (picked === "scope") return failWith(jobError("scope_consult_only", "the run's subject is not an encounter"));
  const source = { kind: a.kind, id: a.id, column: picked.column };
  // empty / already English: finished, and Sarvam is not called (so this needs no gateway)
  if (!picked.text) return doneWith({ reason: "empty_text", source, chars_in: 0, chars_out: 0 });
  const units = planUnits(picked.text, picked.language);
  // already English = the label says so AND no sentence is written in an Indic script (a label alone is not evidence: saaras labels a whole file once)
  if (!units.some((u) => u.translate)) return doneWith({ reason: "already_english", source, chars_in: picked.text.length, chars_out: 0 });
  if (!gatewayConfigured()) return failWith(jobError("sarvam_gateway_not_configured"));
  const chunks = chunksOf(units);
  const charsIn = units.length === 1 ? picked.text.length : chunks.reduce((n, c) => n + c.length, 0); // a mixed text sends only its Indic sentences
  const doc: Doc = { source, chars_in: charsIn, chars_out: 0, english: "", parts: [], chunks_total: chunks.length, language: picked.language };
  try {
    await writeJson(resultKey(ctx.job.id), doc);
  } catch {
    return failWith(jobError("result_write_failed"));
  }
  return nextStep(STEPS.translate, { column: picked.column, chunks_total: chunks.length, chars_in: charsIn, scope: "encounter", ref: a.kind === "encounter" ? a.id : `run:${a.id}`, started_at: new Date().toISOString() });
}

const httpStatusOf = (error: string): number | null => {
  const m = /(?:^|_|\s)(\d{3})(?:\s|$)/.exec(error);
  return m ? Number(m[1]) : null;
};

async function ledger(ctx: StepContext, status: "ok" | "failed", chars: number, httpStatus: number | null, throttled: boolean): Promise<void> {
  const a = ctx.args as unknown as SarvamTranslateArgs;
  await appendLedger({
    caller: "scribe-mcp", machine: "vercel", job_id: ctx.job.id, request_id: null, route: "gateway", mode: "sync", task: "text_translate", model: SARVAM_GW_TRANSLATE_MODEL,
    audio_s: 0, chars, started_at: typeof ctx.progress.started_at === "string" ? ctx.progress.started_at : new Date().toISOString(), finished_at: new Date().toISOString(),
    status, http_status: httpStatus, throttled, scope: "encounter", ref: String(ctx.progress.ref ?? (a.kind === "encounter" ? a.id : `run:${a.id}`)),
  });
}

/** INPUT characters already sent: the source chunks translated so far (what the contract's `chars` means), never the English that came back. */
const inputCharsDone = (chunks: string[], done: number): number => chunks.slice(0, done).reduce((n, c) => n + c.length, 0);

async function translateStep(ctx: StepContext): Promise<StepOutcome> {
  if (!gatewayConfigured()) return failWith(jobError("sarvam_gateway_not_configured"));
  const a = ctx.args as unknown as SarvamTranslateArgs;
  const key = resultKey(ctx.job.id);
  const doc = await readJson<Doc>(key);
  if (!doc) return failWith(jobError("sarvam_result_failed", "result_missing"));
  const picked = await pickSourceText(a);
  if (picked === "missing" || picked === "scope" || !picked.text) return failWith(jobError("source_not_found"));
  const units = planUnits(picked.text, picked.language);
  const chunks = chunksOf(units);
  if (chunks.length !== doc.chunks_total) return failWith(jobError("sarvam_result_failed", "source_changed"));
  const deadline = Date.now() + sarvamTiming.translateStepMs;
  const throttled = ctx.progress.throttled === true;
  // the deadline is checked per CHUNK and the English so far is saved after EACH one: a claim never re-sends a translated chunk
  while (doc.parts.length < chunks.length) {
    if (Date.now() >= deadline) break;
    const r = await gwTranslateChunk(chunks[doc.parts.length]!, units.length === 1 && units[0]!.translate ? doc.language : null);
    if (!r.ok) {
      await writeJson(key, doc).catch(() => undefined);
      console.error("[sarvam] translate failed", JSON.stringify({ job: ctx.job.id, err: r.error, transient: r.transient }));
      if (r.transient) throw new Error(`sarvam_translate_failed: ${r.error}`);
      await ledger(ctx, "failed", inputCharsDone(chunks, doc.parts.length), r.status ?? httpStatusOf(r.error), throttled || r.status === 429);
      return failWith(jobError("sarvam_translate_failed", r.error));
    }
    doc.parts.push(r.english);
    try {
      await writeJson(key, doc);
    } catch {
      throw new Error("result_write_failed");
    }
  }
  if (doc.parts.length < chunks.length) return nextStep(STEPS.translate, { ...ctx.progress, chunks_done: doc.parts.length, translate_chars: inputCharsDone(chunks, doc.parts.length) });
  doc.english = assemble(units, doc.parts);
  doc.chars_out = doc.english.length;
  try {
    await writeJson(key, doc);
  } catch {
    throw new Error("result_write_failed");
  }
  await ledger(ctx, "ok", doc.chars_in, 200, throttled);
  return doneWith({ r2_key: key, source: doc.source, chars_in: doc.chars_in, chars_out: doc.chars_out, chunks: doc.chunks_total });
}
