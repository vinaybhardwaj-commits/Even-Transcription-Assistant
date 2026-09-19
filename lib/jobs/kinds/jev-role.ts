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
 */
import { sql } from "@/lib/db";
import { getJevClient } from "@/lib/jev/client";
import { compositeRole, type AcousticInfo } from "@/lib/jev/role-composite";
import { SETTING } from "@/lib/jev/prompts/arm-d-v1";
import { ROLE_PROMPT_VERSION, roleQid, roleQuestion } from "@/lib/jev/prompts/role-v1";
import type { JevAnswer } from "@/lib/jev/types";
import { JobArgsError, doneWith, type JobKind, type StepContext, type StepOutcome } from "../types";

export const JEV_ROLE_KIND = "jev_role";
const CHAR_FLOOR = 40;

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new JobArgsError("args must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.room_day_id !== "string" || !r.room_day_id.trim()) throw new JobArgsError("room_day_id is required");
  if (r.force !== undefined && typeof r.force !== "boolean") throw new JobArgsError("force must be a boolean");
  if (r.prompt_version !== undefined && typeof r.prompt_version !== "string") throw new JobArgsError("prompt_version must be a string");
  return { room_day_id: r.room_day_id.trim(), force: r.force === true, prompt_version: (r.prompt_version as string | undefined) ?? ROLE_PROMPT_VERSION };
}

type TurnRow = { window_id: string; speaker_idx: number; text: string; clinician_id: string | null; match_confidence: number | null };

async function run(ctx: StepContext): Promise<StepOutcome> {
  const roomDayId = ctx.args.room_day_id as string;
  const force = ctx.args.force === true;
  const promptVersion = ctx.args.prompt_version as string;

  const windows = (await sql`
    SELECT window_id FROM room_diarize_window WHERE room_day_id = ${roomDayId} AND state = 'ok'
  `) as Array<{ window_id: string }>;

  let existing = new Set<string>();
  if (!force) {
    const rows = (await sql`
      SELECT window_id, speaker_idx FROM jev_role_signal WHERE room_day_id = ${roomDayId} AND prompt_version = ${promptVersion}
    `) as Array<{ window_id: string; speaker_idx: number }>;
    existing = new Set(rows.map((r) => `${r.window_id}:${r.speaker_idx}`));
  }

  const client = getJevClient();
  let windowsProcessed = 0;
  let speakersWritten = 0;
  let calls = 0;
  let inputTokens = 0;

  for (const w of windows) {
    const turns = (await sql`
      SELECT t.window_id, t.speaker_idx, (c.payload->>'text') AS text,
             t.clinician_id, t.match_confidence
        FROM room_turn_speaker t
        JOIN cue c ON c.source_ref = t.source_ref AND c.type = 'stt_turn' AND c.room_day_id = t.room_day_id
       WHERE t.window_id = ${w.window_id}
    `) as TurnRow[];

    const bySpeaker = new Map<number, { texts: string[]; turnCount: number; clinician_id: string | null; match_confidence: number | null }>();
    for (const t of turns) {
      const text = (t.text ?? "").trim();
      if (!text) continue;
      const g = bySpeaker.get(t.speaker_idx) ?? { texts: [], turnCount: 0, clinician_id: t.clinician_id, match_confidence: t.match_confidence };
      g.texts.push(text);
      g.turnCount += 1;
      bySpeaker.set(t.speaker_idx, g);
    }

    const speakers: Array<{ idx: number; text: string; turnCount: number; charCount: number; acoustic: AcousticInfo }> = [];
    for (const [idx, g] of bySpeaker) {
      const joined = g.texts.join(" ");
      if (joined.length < CHAR_FLOOR) continue;
      if (!force && existing.has(`${w.window_id}:${idx}`)) continue;
      speakers.push({ idx, text: joined, turnCount: g.turnCount, charCount: joined.length, acoustic: { clinician_id: g.clinician_id, match_confidence: g.match_confidence } });
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
      const role = ans && ans.type === "choice" ? ans.choice : "other";
      const roleProbs = ans && ans.type === "choice" ? ans.probabilities : {};
      const roleConfidence = ans && ans.type === "choice" ? ans.confidence : 0;
      const composite = compositeRole({ role, role_confidence: roleConfidence }, s.acoustic);
      const finalRole = composite.role ?? "other";

      await sql`
        INSERT INTO jev_role_signal
          (id, window_id, room_day_id, speaker_idx, cluster_id, role, role_probs, role_confidence,
           turn_count, char_count, model, prompt_version, input_tokens, batch_id)
        VALUES
          (${`jrs_${w.window_id}_${s.idx}`}, ${w.window_id}, ${roomDayId}, ${s.idx}, ${null},
           ${finalRole}, ${JSON.stringify(roleProbs)}::jsonb, ${roleConfidence},
           ${s.turnCount}, ${s.charCount}, ${result.model}, ${promptVersion}, ${result.usage.input_tokens}, ${batchId})
        ON CONFLICT (window_id, speaker_idx, prompt_version) DO UPDATE SET
          role = EXCLUDED.role, role_probs = EXCLUDED.role_probs, role_confidence = EXCLUDED.role_confidence,
          turn_count = EXCLUDED.turn_count, char_count = EXCLUDED.char_count, model = EXCLUDED.model,
          input_tokens = EXCLUDED.input_tokens, batch_id = EXCLUDED.batch_id, created_at = now()
      `;
      speakersWritten += 1;
    }
    windowsProcessed += 1;
  }

  return doneWith({
    room_day_id: roomDayId,
    windows_total: windows.length,
    windows_processed: windowsProcessed,
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
