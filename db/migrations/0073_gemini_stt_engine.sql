-- =====================================================================
-- Migration 0073 — Gemini enters the registry, DARK.
--
-- WHY (PRD §5, Build 3). One adapter file plus one row is the whole contract for a new engine
-- (`0018_stt_engine.sql` header, and the `0027_indicconformer.sql` precedent). The adapter landed
-- in this build; this is its row.
--
-- ─── IT SHIPS DARK, AND EVERY GATE THAT KEEPS IT DARK IS DELIBERATE ──────────────────────
--
--   fanout_enabled = false   The fan-out runs EVERY eligible engine CONCURRENTLY via Promise.all
--                            on one encounter, and the drain processes several encounters. Adding
--                            Gemini to that pool means bursts of concurrent Vertex calls each
--                            carrying a multi-megabyte audio payload — and the CDMSS finding is
--                            that the Vertex 403s there were a CONCURRENCY QUOTA, not IAM. There
--                            is no limiter, no backoff and no 429 handling anywhere in the Gemini
--                            path. The room drain, by contrast, is one paid call per window and
--                            naturally serialised. Same reason 0027 shipped IndicConformer dark.
--
--   NO ROUTING REPOINT       `stt_routing` is NOT touched. room/english and room/indic stay on
--                            sarvam. Flipping a routing cell is a Routing-tab edit that takes
--                            effect without a deploy and is reversible in one click; doing it
--                            inside a migration would make the first Gemini run happen whenever
--                            this file was applied, rather than when an operator decided. PRD §5:
--                            "First runs happen only after Build 2 is verified."
--
--   GEMINI_STT               The kill-switch. Unset, the adapter refuses before any network call.
--                            So this row is inert three times over: no routing points at it, the
--                            fan-out excludes it, and the code gate is off.
--
-- config_json HOLDS ENV NAMES, NEVER VALUES — the house convention since 0018
-- (`{"model":"saaras:v3","key_env":"SARVAM_API_KEY"}`). Note there is deliberately no "model"
-- key here: unlike every other engine, this adapter has NO default model, because a default would
-- silently attribute every measurement to whatever model the default happened to name. The model
-- comes from GEMINI_STT_MODEL and its absence is a loud config error, not a substitution.
--
-- cost_per_min_usd IS NULL, ON PURPOSE. Vertex bills audio per TOKEN, not per minute, so a
-- per-minute rate would be a fiction. The adapter derives cost from the response's usage block
-- and returns null when the response carries none. The fan-out's own $0.02/min placeholder still
-- applies downstream as a labelled ESTIMATE, which is why null here is safe rather than free.
--
-- THE FAMILY ROW ALREADY EXISTS. `0072_evidence_spine.sql` seeded ('gemini', 'google') ahead of
-- this engine precisely so the scorer's family join could never find a missing row — an
-- unregistered engine fails closed as FAMILY_CONTAMINATION, so an omission would have silently
-- blocked scoring. This migration therefore adds NO family row; it would be a no-op.
--
-- ADDITIVE AND IDEMPOTENT. One INSERT … ON CONFLICT DO NOTHING. No table is created, altered or
-- dropped; no existing row is rewritten.
--
-- NOT TOUCHED: stt_routing, stt_engine_family, transcription_run, and every table from 0071/0072.
-- =====================================================================

INSERT INTO stt_engine
  (id, display_name, adapter_key, capabilities_json,
   enabled, fanout_enabled, is_paid, cost_per_min_usd, config_json, sort_order)
VALUES
  ('gemini', 'Gemini (Vertex)', 'gemini',
   '{"tiers":["asr"],"stages":["room","note"],"languages":["multi","indic"],"streaming":false,"translates":false,"async":false}'::jsonb,
   true, false, true, NULL,
   '{"model_env":"GEMINI_STT_MODEL","gate_env":"GEMINI_STT","key_env":"GCP_SA_KEY","project_env":"GCP_PROJECT","location_env":"GCP_LOCATION","input_rate_env":"GEMINI_STT_USD_PER_1K_INPUT_TOKENS","output_rate_env":"GEMINI_STT_USD_PER_1K_OUTPUT_TOKENS","allow_mime_env":"GEMINI_STT_ALLOW_MIME","note":"ships dark: fanout_enabled=false and no routing repoint; audio MIME blocked on the WebM transcode (see build report)"}'::jsonb,
   70)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE stt_engine IS
  'STT Engine Lab registry. One row per engine; a code adapter (lib/stt/adapters/<adapter_key>.ts) implements the calls. A new engine = 1 adapter file + 1 row.';

INSERT INTO schema_migrations (version, name)
VALUES (73, '0073_gemini_stt_engine')
ON CONFLICT DO NOTHING;
