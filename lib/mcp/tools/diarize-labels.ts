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
import { failSafe, argInt, argStr, type McpTool, type ToolArgs } from "../registry";
import { readWorkerHeartbeats, readNemotronLatency24h } from "@/lib/room-access/nemotron-store";
import { workerBoard } from "@/lib/diarize-nemotron/worker-health";
import { blindLabelCount, dailyLabelCounts, eurPerAudioHour, EUR_PER_AUDIO_HOUR_ENV } from "@/lib/diarize-labels";

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
      engine: { type: "string", enum: ["local", "pyannoteai", "nemotron"], description: "Only this engine's rows. Omit for every engine (unchanged)." },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ days: [] as unknown[] }, async () => {
      const days = argInt(args, "days", DEFAULT_DAYS, 1, MAX_DAYS);
      const engine = argStr(args, "engine", 16);
      if (engine && !["local", "pyannoteai", "nemotron"].includes(engine)) return { days: [], error: "bad_engine" };
      const all = await dailyLabelCounts({ days });
      const rows = engine ? all.filter((r) => r.engine === engine) : all;
      const n_blind_excluded = await blindLabelCount({ days }); // K3-4: held-out labels are left out of every figure and counted
      const paid = rows.filter((r) => r.engine === "pyannoteai");
      return {
        days: rows,
        n_blind_excluded,
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
        // Epic #23 (i): Nemotron spend as the WORKER reports it on its heartbeat (HF jobs and USD, last 24 h). Never an invoice.
        nemotron_hf_reported: await nemotronHfReported(),
      };
    }),
};

async function nemotronHfReported(): Promise<{ hf_jobs_24h: number | null; hf_usd_24h: number | null } | null> {
  try {
    const board = workerBoard(await readWorkerHeartbeats(), { windows_24h: 0, box_24h: 0, hf_24h: 0, p95_latency_s: null }, new Date());
    const jobs = board.workers.map((w) => w.hf_jobs_24h).filter((x): x is number => x !== null);
    return { hf_jobs_24h: jobs.length ? jobs.reduce((a, b) => a + b, 0) : null, hf_usd_24h: board.hf_usd_today_reported };
  } catch {
    return null;
  }
}

const nemotronWorker: McpTool = {
  name: "scribe_nemotron_worker",
  description:
    "Nemotron diarize worker health (epic #23 i), read-only: status ok|lagging|stale|down (stale = no heartbeat for over 10 min → alert; lagging = clinic hours 07:30-21:30 IST and p95 close-to-stored latency or the oldest waiting window over 30 min → warning), queue depth, oldest-waiting age, windows per hour, p95 latency, box vs HF share, reported HF USD, last error code, and each worker's last heartbeat. Ids, counts and timings only; no embeddings, no text. Read scope.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () =>
    failSafe({ board: null as unknown }, async () => {
      const [rows, lat] = await Promise.all([readWorkerHeartbeats(), readNemotronLatency24h()]);
      return { board: workerBoard(rows, lat, new Date()), asof: new Date().toISOString() };
    }),
};

export const DIARIZE_LABEL_TOOLS: McpTool[] = [diarizeSpend, nemotronWorker];
