# ETA — D1 — CLOSE THE PAID ENGINES — REPORT (STOPPED AT C26: THE ROW IS NOT THE CONTROL)
**14 Sep 2026 · Builder `scribe` · branch `vinay/s1-auto-drain` · code read only · no DB access used · not pushed**

**Result: §2's stop condition is met.** Deepgram is called from paths that never read `stt_engine`, so disabling its row would not stop the spend.
- **Not done:** 0093 was not written or applied (§3), the §4 probe was not run, and I opened no database session.
- **Unchanged:** production database, application code, flags. No Mini work, no tests.

## C26 — every path to the three engines, and what a disabled row does
| Path | Where | Reads the row? | If disabled |
|---|---|---|---|
| **Browser live consult, Deepgram** | `components/recording/RecordingScreen.tsx` → `useDeepgramLive({enabled: encounter !== null})` (`lib/use-deepgram-live.ts:79,106`) → `app/[slug]/api/transcribe/deepgram-token/route.ts` → `mintLiveToken` (`lib/deepgram-token.ts:28,54`, env `DEEPGRAM_API_KEY`) | **no** | **FAILS OPEN** — every recorded encounter still opens a paid Deepgram live stream |
| **Encounter processing, Deepgram diarized batch** | `app/[slug]/api/encounters/[id]/process/route.ts:623` → `transcribeDiarized` (`lib/transcribe.ts:92-110`, env key) for English encounters with no Sarvam entries | **no** | **FAILS OPEN** |
| **Voice window transcription, Deepgram** | `app/api/voice/transcribe-window/route.ts:38` and `app/[slug]/api/voice/transcribe-window/route.ts:46` → `transcribeAudio` (`lib/transcribe.ts:23-42`, env key) | **no** | **FAILS OPEN** |
| **Four-engine browser path** | the same `RecordingScreen.tsx`: Deepgram live (above) plus Sarvam, Whisper and Indic hooks. ElevenLabs is not in it. | Deepgram: no | Deepgram part fails open |
| **Offline fanout / STT Lab queue** | `lib/stt/fanout.ts:80,364,415` (ASR); `:364` scribe tier (Eka Scribe) | yes: `enabled AND fanout_enabled` | **fails closed** (skipped) |
| **Routing** (room drain, note choice) | `lib/stt/routing.ts:26`; callers `room-drain.ts:763` (`room`), `finalize-upload/route.ts:179` (`note`) | yes | **fails closed** (`null`) |
| **`stt_routing` rows** | seeded by `0021:19-23`: `('live','english','deepgram')`. **No code resolves stage `live`**: the only `resolveRouting` calls are `room` and `note`, so that row is inert. | n/a | no effect |
| **MCP `scribe_transcribe_range`, engine named explicitly** | `lib/mcp/tools/bench.ts:1969` `adapterFor(engine)` (a map lookup, `registry.ts:32`) + `guardPaidEngine` (`paid-engines.ts:116`: named + duration cap; reads `is_paid`/cost, **not** `enabled`) | **no** | **FAILS OPEN** — an operator naming `deepgram`/`elevenlabs` can still run it, capped |
| **Health probes** | `lib/mcp/tools/stt.ts:35-45` (feeds `health.ts`) and `app/api/admin/stt-lab/health/route.ts:18-27`: `adapter.health()` for every non-virtual engine | **no** | **probes anyway**: Deepgram `GET api.deepgram.com/v1/projects`, ElevenLabs (and Scribe, which delegates) `GET api.elevenlabs.io/v1/models` |
| **MCP engine listings** | `lib/mcp/tools/stt.ts:54-76`, `stores.ts:94` | display only | reports the flag |

**Why §4 would have failed too.**
- `gemini` reports `gemini_stt_disabled` because **its adapter** checks the `GEMINI_STT` env gate (`adapters/gemini.ts:345`), not because the probe reads the row.
- The Deepgram and ElevenLabs probes would keep reporting healthy after a row disable, and keep calling the vendors.
- `health.ts:116` would stop *counting* them, because it filters on `enabled`, but the calls would still be made.
- These probe calls are metadata endpoints, not billed transcription minutes. UNVERIFIED against vendor billing.

## Known fact §8 — room path: partly corrected
- **Confirmed:** room windows do not go through fanout. `room-drain.ts:763` resolves `resolveRouting("room", …)` only.
- **Correction:** by the migrations, they route to **`route`**, not Sarvam. `0084` points both room rows at `route`, and `0086` adds the engine row.
- The live `stt_routing` values were **not** read, since the database was licensed for §3 only.
- Either way, D1's row change does not alter the room path.

## What would make the row the control (for the ruling — nothing changed)
- **Deepgram's three direct callers** (`deepgram-token` route, `process` route `:623`, both `transcribe-window` routes) need a gate on the engine row, or on a server flag, before calling `lib/transcribe.ts` or `lib/deepgram-token.ts`.
- **The browser** must not start `useDeepgramLive` when the gate is closed.
- **`guardPaidEngine`** (or `bench.ts:1969`) should refuse a disabled engine.
- **The two health probes** should skip or mark disabled engines instead of calling `adapter.health()`.
- All of that is application code, which D1 excluded, so it needs its own round. Alternative, V's call: remove `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY` from Vercel. The direct callers then fail loudly with `deepgram_key_missing` / `DEEPGRAM_API_KEY not set`.

## Flags
- **D1-1:** after 0093, Deepgram spend would continue on every encounter recording and English note, and nothing would show it, since the Lab would report the engine disabled.
- **D1-2:** ElevenLabs has no direct path outside the registry, so a row disable would stop its transcription. Only its health probe would still call the vendor.
- **D1-3:** Eka Scribe is already fail-closed.
- **D1-4:** not pushed. §5's push was for the migration record, and there is no migration. This report and the kickoff are committed locally.
