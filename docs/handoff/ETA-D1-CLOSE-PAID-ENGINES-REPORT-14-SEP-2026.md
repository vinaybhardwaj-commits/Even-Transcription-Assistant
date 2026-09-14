# ETA — D1 — CLOSE THE PAID ENGINES — REPORT
**14 Sep 2026 · Builder `scribe` · branch `vinay/s1-auto-drain`**

**Result.** 0093 is applied to production, and the read-back is verified with **`sarvam` still `enabled = t`**. **§4 was not run:** no health probe is reachable from this session. **The row is a PARTIAL control:** it stops the fan-out, routing and scribe tier, while four Deepgram paths and two health probes ignore it and still call the vendors.

## C26 — the row is a PARTIAL control (stop accepted by V; paths not fixed this round)
**Read the row, skip a disabled engine (fail closed):** fan-out `lib/stt/fanout.ts:80,415` · scribe tier `fanout.ts:364` · routing `lib/stt/routing.ts:26` (room drain `room-drain.ts:763`, note choice `finalize-upload/route.ts:179`).

**IGNORE the row and keep calling Deepgram (fail open), env `DEEPGRAM_API_KEY`:**
1. **Browser live consult** — `components/recording/RecordingScreen.tsx` → `lib/use-deepgram-live.ts:79,106` → `app/[slug]/api/transcribe/deepgram-token/route.ts` → `lib/deepgram-token.ts:28,54`. Runs on every recorded encounter.
2. **Encounter processing, diarized batch** — `app/[slug]/api/encounters/[id]/process/route.ts:623` → `lib/transcribe.ts:92-110` (English, no Sarvam segments).
3. **Voice transcribe-window** — `app/api/voice/transcribe-window/route.ts:38` and `app/[slug]/api/voice/transcribe-window/route.ts:46` → `lib/transcribe.ts:23-42`.
4. **MCP `scribe_transcribe_range` naming the engine** — `lib/mcp/tools/bench.ts:1969` `adapterFor(engine)`. `guardPaidEngine` (`lib/stt/paid-engines.ts:116`) checks the name and a duration cap, never `enabled`.

**IGNORE the row and probe anyway — the two health probes:** `lib/mcp/tools/stt.ts:35-45` (feeds `lib/mcp/tools/health.ts`) and `app/api/admin/stt-lab/health/route.ts:18-27`. Both call `adapter.health()` for every non-virtual engine: Deepgram `GET api.deepgram.com/v1/projects`; ElevenLabs and ElevenLabs-Scribe `GET api.elevenlabs.io/v1/models`.

The full per-path table, with the `stt_routing` rows (no code resolves stage `live`) and the room-path correction (room → `route` per 0084/0086), is in the `10a0894` version of this file.

## C27 — migration 0093 (statements verbatim; the file header records the partial-control scope)
```sql
UPDATE stt_engine
   SET enabled = false,
       fanout_enabled = false
 WHERE id IN ('deepgram', 'elevenlabs', 'elevenlabs_scribe', 'ekascribe')
   AND (enabled = true OR fanout_enabled = true);

INSERT INTO schema_migrations (version, name)
VALUES (93, '0093_disable_paid_engines_except_sarvam')
ON CONFLICT DO NOTHING;
```
**Applied:** `psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0093_disable_paid_engines_except_sarvam.sql` → `SET` · `UPDATE 3` · `INSERT 0 1` · exit 0. It is `UPDATE 3`, not 4, because `ekascribe` was already `f/f` and the guard skipped it. Before, `max(version)` was 92.

**Read-back** (id | enabled | fanout_enabled | is_paid), all 11 rows:
```
deepgram f f t · ekascribe f f t · elevenlabs f f t · elevenlabs_scribe f f t · gemini f f t
even_pipeline t t f · indicconformer t t f · indicconformer_scribe t t f · route t f f · whisper t t f
sarvam t t t        ← the row that proves the round
```
- Version `93 | 0093_disable_paid_engines_except_sarvam` recorded.
- Pre-read, same session: `deepgram`, `elevenlabs` and `elevenlabs_scribe` were `t t t`; every other row is unchanged.
- `scribe_system view=stt_engines` (operator MCP) independently reports the same flags.

## C28 — health probe: NOT RUN
Not reachable from this session:
- the operator MCP's health tools are not among this session's connected tools;
- `/api/admin/stt-lab/health` needs a production admin session, and I hold no admin secret.

**Expected from the code, not observed:**
- `deepgram`, `elevenlabs` and `elevenlabs_scribe` will **still probe, and report healthy** while their keys are set. Their adapters do not read `enabled`.
- Only `gemini` reports disabled, through its own `GEMINI_STT` gate (`adapters/gemini.ts:345`).
- `health.ts:116` stops *counting* them, since it filters on `enabled`, but the vendor calls continue.
- This is the finding §4 anticipated. Whoever has the health tool should confirm it.

## Flags
- **D1-1:** Deepgram spend continues through paths 1–3 on doctor encounters, and path 4 on operator request. The Lab now shows the engine disabled, so the spend is less visible, not stopped. Closing it is application code (a later round), or removing `DEEPGRAM_API_KEY` in Vercel (V's call).
- **D1-2:** ElevenLabs has no direct path outside the registry, so its transcription is stopped. Only its health probe still calls the vendor.
- **D1-3:** `migrations-self-record` was not re-run while M7 holds the Mini; the recording line is in the required form.
