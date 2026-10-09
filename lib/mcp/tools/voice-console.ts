/**
 * lib/mcp/tools/voice-console.ts — S6A: scribe_voice_console (READ). action = overview | clinician | pairs. See lib/voice-console.ts: counts, provenance and cosines only; no vector, no audio.
 */
import { argStr, failSafe, type McpTool, type ToolArgs } from "../registry";
import { voiceSearch } from "@/lib/voice-search";
import { consoleClinician, consoleOverview, consolePairs } from "@/lib/voice-console";

export const VOICE_CONSOLE_ACTIONS = ["overview", "clinician", "pairs", "search"] as const;

export const voiceConsole: McpTool = {
  name: "scribe_voice_console",
  description: "Voice console, read only, doctors only, no vectors: action overview|clinician|pairs|search. Samples, generations, centroids, matches 30d; pairs = near pairs by cosine; search = voice similarity in a room/date scope.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...VOICE_CONSOLE_ACTIONS] },
      clinician_id: { type: "string" },
      min_cosine: { type: "number" },
      window_id: { type: "string" },
      speaker_idx: { type: "integer", minimum: 0 },
      rooms: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
      from: { type: "string" },
      to: { type: "string" },
      top_k: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ ok: false }, async () => {
      const action = argStr(args, "action", 16);
      if (action === "overview") return { ok: true, ...(await consoleOverview()) };
      if (action === "clinician") {
        const id = argStr(args, "clinician_id", 64);
        if (!id) return { ok: false, error: "clinician_id_required" };
        const r = await consoleClinician(id);
        return "error" in r ? r : { ok: true, ...r };
      }
      if (action === "pairs") return { ok: true, ...(await consolePairs(typeof args.min_cosine === "number" ? args.min_cosine : undefined)) };
      if (action === "search") return voiceSearch({ window_id: args.window_id, speaker_idx: args.speaker_idx, clinician_id: args.clinician_id, rooms: args.rooms, from: args.from, to: args.to, min_cosine: args.min_cosine, top_k: args.top_k });
      return { ok: false, error: "unknown_action", allowed: [...VOICE_CONSOLE_ACTIONS] };
    }),
};
