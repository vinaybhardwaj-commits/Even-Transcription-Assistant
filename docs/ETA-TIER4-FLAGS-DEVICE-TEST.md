# ETA Tier 4 — Feature Flags & Device-Test Checklist

> **STATUS 6 Jun 2026:** Flag **#17 `NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS=1` is SET in Vercel
> (Production+Preview) and baked into the live bundle** — rollout is one-flag-at-a-time per V.
> **PENDING-V: run the #17 device test below.** If it passes, Claude sets #18, then #19 the
> same way. If anything regresses: unset the var in Vercel + redeploy (instant revert).

**Shipped 2 Jun 2026, commit `9dab463` (live, build green, smoke 9/9).** All three
Tier-4 items are gated behind `NEXT_PUBLIC_*` flags in `lib/live-flags.ts`, each
**defaulting OFF**. With the flags unset, the production recording path is
byte-identical to before — nothing changes until you set a flag in Vercel and
device-test it. To revert any flag instantly: unset it and redeploy.

These touch the LIVE clinical recording/capture path (the B18 audio-loss area),
which is why they're flag-gated and must be confirmed on real devices — the
sandbox/headless CI cannot exercise iOS WebKit or true mic capture.

## The flags (set in Vercel → Project → Settings → Environment Variables → Production, value `1`, then redeploy)

| Flag | Item | What it does when ON |
|---|---|---|
| `NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS` | #17 | The 3 live-transcription hooks (whisper-rolling, sarvam-rolling, speaker-identify) drop already-consumed chunks off the front of their in-memory buffers instead of growing them for the whole consult. The canonical upload copies (IndexedDB + RecordingScreen `chunksMemRef`) are **not** touched — so audio you submit is unaffected. Reduces memory pressure on long consults (memory pressure is a B18-class reload trigger). |
| `NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT` | #18 | English live transcription (Deepgram WS) reconnects with exponential backoff (1/2/4/8s, max 5 tries) and re-mints its token if the socket drops mid-consult, instead of just going silent. |
| `NEXT_PUBLIC_ETA_SAFARI_STREAMING_GUARD` | #19 | Treats **desktop Safari** like iOS: skips the streaming worklet and uses the chunk-based rolling path, so the MediaRecorder-vs-worklet dual-consumer issue (B18) can't bite desktop Safari if the relay is enabled. |

Note quality is unaffected by all of these — the saved note is built from the
submitted audio, never the live transcript.

## Recommended rollout (one flag at a time)

For each flag: set it to `1` in Vercel → redeploy → run the device test below →
if good, leave on; if anything regresses, unset and redeploy (instant revert).

### #17 TRIM_LIVE_BUFFERS — device test
1. iPhone Safari (normal tab) **and** an Android Chrome device.
2. Record a **long** consult (≥ 8–10 min) in a non-English language (Sarvam path)
   and one in English (Deepgram path).
3. Watch the live transcript stays correct/continuous the whole time (no reset,
   no garbling after the first few minutes).
4. **Submit** → confirm the note generates and the audio uploaded (chunk count /
   bytes look right; no `no_audio_chunks`).
5. Repeat once on desktop Chrome.

### #18 DEEPGRAM_RECONNECT — device test
1. English consult on a laptop. Start recording.
2. Briefly drop Wi-Fi / toggle airplane mode for ~5–10s, then restore.
3. Confirm the live English transcript resumes within a few seconds (reconnect),
   rather than staying frozen until the end.
4. Submit → note generates normally.

### #19 SAFARI_STREAMING_GUARD — device test
1. **Desktop Safari** (macOS) with the relay enabled (`NEXT_PUBLIC_STT_RELAY_URL` set).
2. Record a non-English consult.
3. Confirm chunks accumulate (chunk count climbs) and Submit succeeds — i.e. the
   worklet is NOT starving MediaRecorder. Live tail may use the ~2s rolling path
   instead of sub-250ms streaming; that's expected on this guard.

## Verified now (flags OFF)
- Build green, HEAD `9dab463` live, `npm run smoke` 9/9.
- `lib/platform.ts isDesktopSafariUserAgent()` unit-tested (Safari yes; Chrome/
  Firefox/iOS no) — runs in the vitest CI step.
- Existing Playwright e2e (auth + B18 IndexedDB-blocked regression) still applies
  because the recording path is unchanged while the flags are off.

## Rollback
Each flag is independent. Unset the env var in Vercel + redeploy to revert that
item to the previous (shipped, proven) behaviour. No migration or data change is
involved in any Tier-4 item.
