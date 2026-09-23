/**
 * lib/mcp/tools/diarize-labels.ts — `scribe_diarize_spend`: what the teacher has cost, per day.
 *
 * V is paying pyannote.ai to label room audio so the local diarizer can be trained to match it
 * ("I don't mind spending some money... as long as the goal is to train the local diarizer"), and
 * a spend nobody can see is a spend nobody can stop. This is that view: windows labelled,
 * audio-hours, and an ESTIMATE of the euros, per engine per IST day.
 *
 * THE MONEY IS DERIVED, NOT STORED. Every figure is computed at read time from the audio seconds
 * on each label row times a configurable rate, so a corrected rate corrects the history and
 * nothing has to be migrated. It is an estimate: pyannote.ai bills on its own measure and its own
 * rounding, and the field is named `estimated_eur` so nobody reads it as an invoice.
 *
 * Read scope, counts only — no window ids, no room labels, no audio, no text.
 */
import { failSafe, argInt, type McpTool, type ToolArgs } from "../registry";
import { dailyLabelCounts, eurPerAudioHour, EUR_PER_AUDIO_HOUR_ENV } from "@/lib/diarize-labels";

/** The most days one call will summarise. */
export const MAX_DAYS = 90;
export const DEFAULT_DAYS = 14;

const diarizeSpend: McpTool = {
  name: "scribe_diarize_spend",
  description:
    "Diarization teacher labels per IST day: how many windows each engine labelled, how many audio-hours, and an ESTIMATE of the euros spent on the paid engine (audio seconds x rate, derived at read time, never an invoice). Counts only — no window ids, no room labels, no text. Read scope.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "integer", description: `IST days back to summarise, default ${DEFAULT_DAYS}, ceiling ${MAX_DAYS}.` },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ days: [] as unknown[] }, async () => {
      const days = argInt(args, "days", DEFAULT_DAYS, 1, MAX_DAYS);
      const rows = await dailyLabelCounts({ days });
      const paid = rows.filter((r) => r.engine === "pyannoteai");
      return {
        days: rows,
        rate_eur_per_audio_hour: eurPerAudioHour(),
        rate_env: EUR_PER_AUDIO_HOUR_ENV,
        // Totals over the window asked for, so a reader does not have to add the column up — and
        // labelled `estimated_` for the same reason the per-day figure is.
        totals: {
          windows_labelled: rows.reduce((n, r) => n + r.windows, 0),
          paid_windows: paid.reduce((n, r) => n + r.windows, 0),
          paid_audio_hours: Math.round(paid.reduce((n, r) => n + r.audio_hours, 0) * 1000) / 1000,
          estimated_eur: Math.round(paid.reduce((n, r) => n + (r.estimated_eur ?? 0), 0) * 10000) / 10000,
        },
        is: "estimated from stored audio seconds; pyannote.ai bills on its own measure",
      };
    }),
};

export const DIARIZE_LABEL_TOOLS: McpTool[] = [diarizeSpend];
