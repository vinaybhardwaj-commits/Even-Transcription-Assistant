# Room STT off for the clinic day — 23 Sep 2026 (V's direction, 12:45 IST)

What V asked: turn live STT off on all room kiosks for the rest of today's clinic day, keep recording, free the STT infrastructure (Mini whisper + router) for our daytime work; restart the whisper shim.

What Fable did:
- Vercel production env ROOM_AUTO_DRAIN_ENABLED: "1" -> "off" (type config) at ~12:45.
- Redeployed production (same commit 95cf2c9) from dpl_7x5k6ogBJPN7gYDxrqjCJG6sCfjD; new build aliased to www.evenscribe.app at ~12:47; /api/health sha 95cf2c9.
- Verified: GET /api/admin/drain-windows (CRON_SECRET) -> enqueued 0, considered 0.
- Recording is untouched (the flag only stops the auto-drain cron from enqueueing room windows). Per-room Transcript switches in the DB were NOT changed.
- One room_window job already in flight at the switch (job_6xcv7x9j15bw) was allowed to finish before the shim restart.

Restore at 21:25 IST (before night-drain's 21:30 closed-hours start):
1. cd ~/dev/Even-Transcription-Assistant
2. npx -y vercel@latest env rm ROOM_AUTO_DRAIN_ENABLED production --yes
3. printf '1' | npx -y vercel@latest env add ROOM_AUTO_DRAIN_ENABLED production --type config
4. Confirm with env pull to a mktemp file: ROOM_AUTO_DRAIN_ENABLED="1"; delete the file.
5. Redeploy the CURRENT production deployment (look it up; do not redeploy an older dpl): npx -y vercel@latest redeploy <current prod dpl> --target production. Hold all pane pushes while it builds.
6. Verify /api/health sha unchanged and GET /api/admin/drain-windows shows considered > 0 or a normal refusal.
7. Tell scribe pushes may resume. Day backlog (12:45 -> 21:30) is picked up by the drain + night-drain (drain looks back AUTO_DRAIN_MAX_AGE_HOURS=6 — the rest is night-drain's).

While off: any production push by a pane is fine (it builds with the env off) but must be announced to Fable so the restore redeploys the latest commit.

## Update 15:00 (Fable)
Production is now a104723 / dpl_4jCCzMpHmVMErEVHpEwmubKeTRi8 (scribe batch d1d9ec1+3b827bc+0c77d44+ledger pointer, deployed 14:45, drain still off). The 21:25 restore redeploys THIS dpl unless a later deploy lands first -- check the served dpl at 21:25.

## Update 15:50 (Fable)
Production is now cf49a55 / dpl_3jaNcDg5U7BQjZB4rWDauRb4hzoM (jev-core, flags off). Migration 0116 applied 15:50 (applied: 0116_jev_decision). The 21:25 restore redeploys THIS dpl unless a later deploy lands first.

## Update 16:50 (Fable)
Production is now d519d7b (hybrid + E-6 fusion, flags off). Migrations 0117+0118 applied 16:50. The 21:25 restore redeploys the CURRENT prod dpl (check served dpl at 21:25).

## RESTORED EARLY 17:53 (Fable, V approved "do it now")
overnight-translate: ALLOW_DAYTIME and OPEN_EARLY removed from plist, reloaded (waits for 21:30). eta-diarize restarted 17:47, /embed_speakers SMOKE OK. Vercel prod env: ROOM_AUTO_DRAIN_ENABLED=1, DIARIZE_ENGINE=pyannoteai, DIARIZE_TEACHER_LABELS=1 (type config); redeployed d519d7b as dpl_2MyRMyGsGZyGmuyCvuAG7D6h6g6h, READY, health ok. Drain considered=0 at first because windows refused with flag_off sit in the 60-min refusal cooldown; they come back as cooldowns expire. Cancelled job_34d1dvuof6wh (overnight-translate room_window stuck polling router job 5d5e68... for 4.5 h -- the router restarted at ~13:17 and lost it).

## Kiosks stop 20:30 IST (V, 23 Sep 18:02)
V confirmed: clinic day ends and kiosks are stopped at 20:30 IST. No new audio after that; the overnight run processes what was recorded. Tonight: raise AUTO_DRAIN_MAX_AGE_HOURS to 16 and decide night-drain local diarize vs pyannote.ai cron (split-speaker analysis due 18:45).
