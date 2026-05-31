/** STT Engine Lab registry — maps adapter_key -> code adapter, and reads the
 *  stt_engine rows. Adding an engine = drop an adapter + INSERT a row. */
import { sql } from "@/lib/db";
import type { SttAdapter } from "./types";
import { deepgramAdapter } from "./adapters/deepgram";
import { whisperAdapter } from "./adapters/whisper";
import { sarvamAdapter } from "./adapters/sarvam";
import { elevenlabsAdapter } from "./adapters/elevenlabs";

export const ADAPTERS: Record<string, SttAdapter> = {
  deepgram: deepgramAdapter,
  whisper: whisperAdapter,
  sarvam: sarvamAdapter,
  elevenlabs: elevenlabsAdapter,
};

export function adapterFor(key: string): SttAdapter | null {
  return ADAPTERS[key] ?? null;
}

export type EngineRow = {
  id: string;
  display_name: string;
  adapter_key: string;
  enabled: boolean;
  fanout_enabled: boolean;
  is_paid: boolean;
  cost_per_min_usd: number | null;
  capabilities_json: unknown;
  config_json: unknown;
  sort_order: number;
};

export async function listEngines(): Promise<EngineRow[]> {
  return (await sql`
    SELECT id, display_name, adapter_key, enabled, fanout_enabled, is_paid,
           cost_per_min_usd, capabilities_json, config_json, sort_order
      FROM stt_engine
     ORDER BY sort_order ASC, id ASC
  `) as EngineRow[];
}
