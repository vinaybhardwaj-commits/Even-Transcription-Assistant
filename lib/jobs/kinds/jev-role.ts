/**
 * lib/jobs/kinds/jev-role.ts — Slice J3 (ETA-JEV-ARM-D §6.2). Text role signal per diarized
 * speaker cluster, per window. Bench-only; never feeds room_turn_speaker (§6.1).
 *
 * STT_TURN PAYLOAD TEXT (UNVERIFIED item in the spec, resolved from bench.ts's `buildTurns`):
 * the ONLY text key on an `stt_turn` cue's payload is `text`, and it is whatever language ASR
 * produced for that turn — the ORIGINAL language, never English. J0 (Slice J0) supplies English
 * only at the WINDOW level (`jev_window_text`), never per turn, so there is no per-turn English
 * to read. v1 sends `payload.text` as-is (documented limitation: Jev is English-primary and a
 * code-mixed turn is read in its original language here; per-turn translation is future work,
 * out of this slice's scope per spec §9's allowed-changes list, which does not include a new
 * per-turn translation path). This is recorded in the build report, not silently assumed.
 *
 * Single step (bench-only, one room-day's diarized windows are small relative to MAX_STEP_MS;
 * a future slice can split this the way jev-window.ts splits by batch if that stops holding).
 *
 * REFUTER F4/F7/F8 (19 Sep):
 *  - F4: `ans.choice` is validated against the five CHECK-constrained roles before it goes
 *    anywhere near `compositeRole` or the INSERT; an off-menu value is mapped to "other" and the
 *    raw value is kept in the new `note` column rather than aborting the job or letting a bad
 *    string reach the database's own CHECK. `prompt_version` is now NOT NULL in 0107 (edited in
 *    place — the migration is unreleased).
 *  - F7: because `detected_language` is NULL everywhere (see the STT_TURN note above), whether a
 *    window's underlying text is genuinely English is read from J0's own `jev_window_text.source`
 *    instead: `run_english`/`native_en` are clean English, `translated` (or no row at all) means
 *    the window's turns were never confirmed English, so role questions for that window are
 *    skipped (`skipped:non_english`) UNLESS `ETA_JEV_ROLE_ALLOW_NON_ENGLISH` is on (default off).
 *  - F8 (role half): a speaker's acoustic identity (`clinician_id`/`match_confidence`) is now
 *    taken from whichever of their turns has the HIGHEST `match_confidence`, not whichever turn
 *    happened to be read first; `cluster_id` is populated from `room_turn_speaker` when present.
 */
import { sql } from "@/lib/db";
import { parseFlag, FlagValueError } from "@/lib/flags";
import { getJevClient } from "@/lib/jev/client";
import { compositeRole, type AcousticInfo } from "@/lib/jev/role-composite";
import { SETTING } from "@/lib/jev/prompts/arm-d-v1";
import { ROLE_PROMPT_VERSION, roleQid, roleQuestion } from "@/lib/jev/prompts/role-v1";
import type { JevAnswer } from "@/lib/jev/types";
import { JobArgsError, doneWith, type JobKind, type StepContext, type StepOutcome } from "../types";

export const JEV_ROLE_KIND = "jev_role";
const CHAR_FLOOR = 40;
const VALID_ROLES = new Set(["clinician", "patient", "attendant", "nurse_or_staff", "other"]);
/** Sources J0 (jev_window_text) records that mean "this window's text was confirmed English". */
const CLEAN_ENGLISH_SOURCES = new Set(["run_english", "native_en"]);

function flagOn(name: string): boolean {
  try {
    return parseFlag(name);
  } catch (e) {
    if (e instanceof FlagValueError) throw e;
    throw e;
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new JobArgsError("args must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.room_day_id !== "string" || !r.room_day_id.trim()) throw new JobArgsError("room_day_id is required");
  if (r.force !== undefined && typeof r.force !== "boolean") throw new JobArgsError("force must be a boolean");
  if (r.prompt_version !== undefined && typeof r.prompt_version !== "string") throw new JobArgsError("prompt_version must be a string");
  return { room_day_id: r.room_day_id.trim(), force: r.force === true, prompt_version: (r.prompt_version as string | undefined) ?? ROLE_PROMPT_VERSION };
}

type TurnRow = { window_id: string; speaker_idx: number; text: string; clinician_id: string | null; match_confidence: number | null; cluster_id: string | null };

async function run(ctx: StepContext): Promise<StepOutcome> {
  const roomDayId = ctx.args.room_day_id as string;
  const force = ctx.args.force === true;
  const promptVersion = ctx.args.prompt_version as string;
  const allowNonEnglish = flagOn("ETA_JEV_ROLE_ALLOW_NON_ENGLISH");

  const windows = (await sql`
    SELECT window_id FROM room_diarize_window WHERE room_day_id = ${roomDayId} AND state = 'ok'
  `) as Array<{ window_id: string }>;

  // F7: J0's own record of whether a window's text was confirmed English, keyed by window_id
  // (jev_window_text.window_id and room_diarize_window.window_id both reference bench_window(id)).
  const textRows = (await sql`
    SELECT window_id, source FROM jev_window_text WHERE room_day_id = ${roomDayId}
  `) as Array<{ window_id: string; source: string }>;
  const sourceById = new Map(textRows.map((r) => [r.window_id, r.source]));

  let existing = new Set<string>();
  if (!force) {
    const rows = (await sql`
      SELECT window_id, speaker_idx FROM jev_role_signal WHERE room_day_id = ${roomDayId} AND prompt_version = ${promptVersion}
    `) as Array<{ window_id: string; speaker_idx: number }>;
    existing = new Set(rows.map((r) => `${r.window_id}:${r.speaker_idx}`));
  }

  const client = getJevClient();
  let windowsProcessed = 0;
  let windowsSkippedNonEnglish = 0;
  let speakersWritten = 0;
  let calls = 0;
  let inputTokens = 0;

  for (const w of windows) {
    // F7: a window whose text was never confirmed English is skipped unless the flag opts in.
    if (!allowNonEnglish) {
      const source = sourceById.get(w.window_id);
      const cleanEnglish = source !== undefined && CLEAN_ENGLISH_SOURCES.has(source);
      if (!cleanEnglish) {
        windowsSkippedNonEnglish += 1;
        continue;
      }
    }

    const turns = (await sql`
      SELECT t.window_id, t.speaker_idx, (c.payload->>'text') AS text,
             t.clinician_id, t.match_confidence, t.cluster_id
        FROM room_turn_speaker t
        JOIN cue c ON c.source_ref = t.source_ref AND c.type = 'stt_turn' AND c.room_day_id = t.room_day_id
       WHERE t.window_id = ${w.window_id}
    `) as TurnRow[];

    const bySpeaker = new Map<number, { texts: string[]; turnCount: number; clinician_id: string | null; match_confidence: number | null; cluster_id: string | null }>();
    for (const t of turns) {
      const text = (t.text ?? "").trim();
      if (!text) continue;
      const g = bySpeaker.get(t.speaker_idx) ?? { texts: [], turnCount: 0, clinician_id: null, match_confidence: null, cluster_id: null };
      g.texts.push(text);
      g.turnCount += 1;
      // F8: the HIGHEST match_confidence across a speaker's turns wins, not the first turn read.
      if (t.match_confidence !== null && (g.match_confidence === null || t.match_confidence > g.match_confidence)) {
        g.match_confidence = t.match_confidence;
        g.clinician_id = t.clinician_id;
      }
      if (t.cluster_id && !g.cluster_id) g.cluster_id = t.cluster_id;
      bySpeaker.set(t.speaker_idx, g);
    }

    const speakers: Array<{ idx: number; text: string; turnCount: number; charCount: number; acoustic: AcousticInfo; cluster_id: string | null }> = [];
    for (const [idx, g] of bySpeaker) {
      const joined = g.texts.join(" ");
      if (joined.length < CHAR_FLOOR) continue;
      if (!force && existing.has(`${w.window_id}:${idx}`)) continue;
      speakers.push({
        idx,
        text: joined,
        turnCount: g.turnCount,
        charCount: joined.length,
        acoustic: { clinician_id: g.clinician_id, match_confidence: g.match_confidence },
        cluster_id: g.cluster_id,
      });
    }
    if (speakers.length === 0) continue;

    const state = { setting: SETTING, speakers: speakers.map((s) => ({ id: `S${s.idx}`, turns: [s.text] })) };
    const questions: Record<string, ReturnType<typeof roleQuestion>> = {};
    for (const s of speakers) questions[roleQid(`S${s.idx}`)] = roleQuestion(`S${s.idx}`);

    const batchId = `${roomDayId}:${w.window_id}`;
    const result = await client.systemOne({ state, questions }, { signal: ctx.signal });
    calls += 1;
    inputTokens += result.usage.input_tokens;

    for (const s of speakers) {
      const ans: JevAnswer | undefined = result.answers[roleQid(`S${s.idx}`)];
      const rawChoice = ans && ans.type === "choice" ? String(ans.choice) : "other";
      const roleProbs = ans && ans.type === "choice" ? ans.probabilities : {};
      const roleConfidence = ans && ans.type === "choice" ? ans.confidence : 0;

      // F4: never let an off-menu answer reach the CHECK constraint or abort the job.
      const offMenu = !VALID_ROLES.has(rawChoice);
      const textRole = offMenu ? "other" : rawChoice;

      const composite = compositeRole({ role: textRole, role_confidence: roleConfidence }, s.acoustic);
      const finalRole = composite.role ?? "other";

      const notes: string[] = [];
      if (offMenu) notes.push(`off_menu_choice:${rawChoice}`);
      if (composite.role === null) notes.push("low_confidence");
      const note = notes.length > 0 ? notes.join(";") : null;

      await sql`
        INSERT INTO jev_role_signal
          (id, window_id, room_day_id, speaker_idx, cluster_id, role, role_probs, role_confidence,
           turn_count, char_count, model, prompt_version, input_tokens, batch_id, note)
        VALUES
          (${`jrs_${w.window_id}_${s.idx}`}, ${w.window_id}, ${roomDayId}, ${s.idx}, ${s.cluster_id},
           ${finalRole}, ${JSON.stringify(roleProbs)}::jsonb, ${roleConfidence},
           ${s.turnCount}, ${s.charCount}, ${result.model}, ${promptVersion}, ${result.usage.input_tokens}, ${batchId}, ${note})
        ON CONFLICT (window_id, speaker_idx, prompt_version) DO UPDATE SET
          cluster_id = EXCLUDED.cluster_id, role = EXCLUDED.role, role_probs = EXCLUDED.role_probs, role_confidence = EXCLUDED.role_confidence,
          turn_count = EXCLUDED.turn_count, char_count = EXCLUDED.char_count, model = EXCLUDED.model,
          input_tokens = EXCLUDED.input_tokens, batch_id = EXCLUDED.batch_id, note = EXCLUDED.note, created_at = now()
      `;
      speakersWritten += 1;
    }
    windowsProcessed += 1;
  }

  return doneWith({
    room_day_id: roomDayId,
    windows_total: windows.length,
    windows_processed: windowsProcessed,
    windows_skipped_non_english: windowsSkippedNonEnglish,
    speakers_written: speakersWritten,
    calls,
    input_tokens: inputTokens,
    est_cost_usd: inputTokens * 42e-9,
  });
}

export const jevRoleKind: JobKind = {
  name: JEV_ROLE_KIND,
  first: "run",
  scope: "invoke",
  parseArgs,
  run,
};
