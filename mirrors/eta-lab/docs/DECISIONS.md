# DECISIONS — every open decision for V

Written by the `roadmap` pane. Plain words: each item is the question, the choices, and what I recommend. Closed decisions move to the bottom with the date and V's answer.

Last revision: **28 Sep 2026, ~15:10 IST** (rev 9).

---

## OPEN

### D-6 — RECORDER: which room follows Home Office in the 0.1.25 rollout?
- **Question:** 0.1.25 is PASSed (1da7232) and a signed test build is going to Home Office only (auto-start left on). Scope/owner (scribe build + minibot monitor) is settled. What's left is the next hop after the Home Office canary.
- **Options:** (a) a low-traffic OPD room next; (b) wait for a full nightly SELFTEST cycle first; (c) name the room now so scribe can prep.
- **Recommendation:** (a) once the Home Office self_test scores clean.
- **Raised:** 26 Sep; narrowed 27 Sep after 0.1.25 PASS. **Status:** open. Update 28 Sep: the Home Office canary itself is now blocked one step earlier — the app's self_test needs a server permission fix (minibot's MCP token lacks write scope) before it can even run once at Home Office, so this decision is not yet actionable.

### D-8 — ROOMS: OPD 4 physical mic; Cardiology restart
- **Question:** DEVICE_MISSING still flags on OPD 4 at 07:58 this morning even though the app reports the C270 by name — someone needs to physically look at it before clinic opens. Separately, Cardiology OPD has had no kiosk since 26 Sep (offline, last heartbeat 26 Sep 19:54) and is not expected to start on its own.
- **Options:** (a) dispatch a hands-on-site check of the OPD 4 mic now; (b) for Cardiology: send someone to open the kiosk page, or leave it off until further notice.
- **Recommendation:** (a) for OPD 4 (blocks clinic recording there); (b) leave Cardiology off unless you want it recording today.
- **Raised:** 26 Sep; updated 27 Sep 08:00 with today's room-readiness reads. **Status:** open. Update 28 Sep: NOT independently re-verified this revision — no OPD 4 or Cardiology status appeared in today's bus range (4285-5320). Carried forward as last known state; do not assume it is still accurate without a fresh check.

### D-14 — ROOMS: permission rule for fleet's read-only report_diag
- **Question:** fleet's one named, read-only `report_diag` command to OPD 4 (to check for signature_mismatch) was refused by fleet's own pane classifier as a remote write. The exact command is posted on the bus (#4221).
- **Options:** (a) add a Bash/MCP permission rule for that one command in fleet's pane; (b) you or Fable run the exact line and hand fleet the reply.
- **Recommendation:** (a) if this kind of read-only room diagnostic will recur; (b) as a one-off.
- **Raised:** 27 Sep (W34.3). **Status:** open, but lower priority: sig-debug/sig-research closed out the signature_mismatch investigation this revision using only read-only Scribe MCP calls, without needing this permission rule, so nothing is currently blocked on it. Leave open in case another read-only room diagnostic hits the same wall.

### D-10 — FOUNDRY: Zen top-up cadence
- **Question:** Zen is pay-per-token from prepaid credit; no auto-reload (r407). When should it be topped up?
- **Options:** (a) V tops up on Fable's alert (< $10 or < 24 h runway); (b) enable auto-reload $20.
- **Recommendation:** (a) — keep it manual.
- **Raised:** 25 Sep; re-confirmed 26 Sep (r452). **Status:** open (standing).

### D-16 — BACKFILL: re-attempt PARITY-389 later, or accept HF as an unproven backup path?
- **Question:** the HF-vs-Mini transcription comparison came back NO MATCH because the HF capture couldn't reach the Mini's own SraVaani instance (a tailnet/network permission gap), not because the STT itself disagreed in a worrying way. Fixing the network path would let a cleaner comparison run later.
- **Options:** (a) fix the tailnet ACL so HF can reach the Yoga SraVaani instance, and re-run the comparison later; (b) leave HF as an unproven overflow path indefinitely (no GCP-disk deletion decision rides on this until it's revisited).
- **Recommendation:** (b) for now — no pressing need for HF overflow today; revisit if/when it's actually needed.
- **Raised:** 28 Sep (from the 27 Sep PARITY-389 final verdict). **Status:** open, not urgent.

### D-17 — ACOUSTICS/ROOMS: Third Floor needs a physical acoustic fix
- **Question:** Third Floor Consultation room measurably misses 23.7% of real speech before it ever reaches the transcription engine (the noise-detector cuts it) — a software threshold tune was tried and does not fix it. It needs a physical change: move the mic, swap it, or reduce a noise source in the room.
- **Options:** (a) send someone to move/swap the mic and re-test; (b) leave as-is and accept the loss.
- **Recommendation:** (a) — this is a measured, material gap in what gets transcribed for that room.
- **Raised:** 28 Sep (W39 final report). **Status:** open.

---

## Tasks waiting on V's hands (not decisions — just do)

1. **Rate the 200 label200 rows** at /rate/label200 — no longer a CLARITY gate (W33 ruled automatic scoring instead), but still wanted as a later spot-check against the automatic scores.
2. ~~Run the 337b translation pass~~ **done.**
3. ~~Run the c3 apply script 81207f53~~ **done.**
4. **Top up OpenRouter** (≥ $0.50) for ceiling audio checks.
5. ~~Re-save the ElevenLabs key~~ **done — diar-lab's first real ElevenLabs synth landed 26 Sep night (rev 13).**
6. **Deploy the gcloud shim be2b6682** + temporary Vertex credentials (unblocks VJ arm 4).
7. **Authorise the GCP S7 delete** (gcloud auth on the Air, after the 24 h window; also gated on the PARITY-389 verdict, see BACKFILL).
8. ~~SHIP D4~~ **done — shipped 27 Sep 21:16-21:48 (dpl_3s2o, then post-D4 train 4d7d8e0 live 21:48); migrations 0119/0121 applied, Jev model pinned.**
9. **VOICEPRINT:** run the vj-seal-decrypt v3 `--apply` (tomorrow) so vj-refuter can verify.
10. ~~Restart the eta-bus MCP server~~ **done.**
11. **Approve the Kanglish SELFTEST phrase set** once, before the first nightly run that includes it (S1 ruling, standing ask).
12. **Physically check OPD 4's C270** before clinic opens — DEVICE_MISSING still flags it at 07:58 (see D-8).
13. ~~FREESCRIPT: answer the two open questions~~ **done — resolved by your 27 Sep 11:05 ruling (ZDR confirmed generally, no-doctor-paste artifact approach); D-15 closed.**
14. **W52 Manoj package:** be reachable / have your MacBook Air online around 15:00-17:00 IST today (28 Sep) to receive the first cut and the full package — you're on a spotty hotspot today, which Fable has already flagged as a risk.
15. **Rotate the R2 read key `r2_audio_read`** (`~/.claude/secrets/r2_audio_read`) — part of it was printed to a tool output during routine housekeeping. No content was ever posted on the bus and every agent correctly refused to open or handle it themselves; this needs your hands (agents never create or rotate credentials). When you rotate it, every consumer (box, Mini, HF) needs the new value or reads will start failing.
16. **W52 first cut is ready now** — `~/eta-data/manoj-package-cut1` is frozen, independently verified (26/26 checks), and waiting for Fable to pull to your Air whenever you're reachable; no need to wait for the full 17:00 package.

---

## CLOSED

- **V via Fable #6990 (29 Sep ~18:50 IST), ORBOX D-2..D-5:** D-2 = BOTH, more microphones and more speakers around the OT. D-3 = DROPPED: video consent is already settled (V); the ORBOX video stream is the robotic surgical device's telemetry display, not video of the patient, so the patient-video concern leaves the design and test plan. D-4 = a full itemised kit list for a vendor quote (mics, speakers, telemetry video capture); orbox writes the list only and buys nothing (board task T-ORBOX-5). D-5 = HOLD: no ORBOX building of any kind until V says so; the kit list is paperwork, not building.
- **V via Fable #6051 (29 Sep, ~13:10 IST):** patient audio allowed on Hugging Face GPUs (approved ZDR vendor). Private buckets only; our own code and open-weight models only; outputs come back to the box; each job posts job id, machines, hours, spend; guard USD 150/day across all HF jobs; up to 10 L4 at once. Closes D-16 in spirit (HF is now a used path, not only a backup); D-16 itself left open until V says so.
- **V via Fable #6161 (29 Sep):** keep patient data in the HF buckets until V says delete. No bucket or file is deleted after copy-back. hf-fleet keeps the ledger at ~/eta-data/hf-buckets-ledger.md.

- **D-15 (27 Sep, FREESCRIPT ZDR + staging-parse questions): RESOLVED.** V's 11:05 ruling (Jev/OpenRouter are ZDR for Even generally; no doctor-paste, no Pulse code change — ETA hands Pulse a structured artifact instead) answers both questions in substance. W38 shipped and closed on this basis.
- **D-1 (26 Sep, ROOMS auto-start): APPROVED by V.** Built into RECORDER 0.1.25 (R25/W34.1): per-room schedule (`lib/room-schedule.ts` 93a1f17), 08:30 clinic rooms / 06:00 ORB3, never Dietary unless re-enabled, 10-min grace, a room already started by hand is left alone; fleet-watch alerts if a room has not started 10 min after open.
- **D-9 (27 Sep, SELFTEST spec + TTS route): RULED (S1 order).** Phrase-set owner = diar-lab (invented only, V approves Kanglish once); TTS = ElevenLabs first, Google Cloud TTS fallback; nightly 23:30 IST + manual trigger, never in clinic hours; scores the PRODUCTION path, offline models as shadow columns only.
- **W33 (27 Sep, CLARITY automatic judging): V ruled — no human listening today.** Every CLARITY change (starting with the router fix) is judged by three pre-registered automatic scores: S1 synthetic truth (SELFTEST WER/CER/hit-rate), S2 clinical truth (CAP capture score vs Pulse, scorer efcc9c9 unchanged), S3 language truth (a Gemini 3.8 Flash judge via the ZDR route, itself proven ≥95%/≥90% on known-language audio first). **A change ships only if S2 improves and S1/S3 do not get worse.** V's own labels become a later spot-check, not a gate.
- **Home Office as a test room, 26-27 Sep: RULED.** Home Office is usable as the acoustic/self-test rig at any time (not just clinic-closed hours); during clinic hours (08:15-20:30) it stays limited to install/play/record/upload only — no scoring or STT on the Mini, no service restarts — and only on an order naming the action (minibot #4223).
- **Pool assignments, 26-27 Sep: RULED (standing).** Pool A (main OpenCode Go) = NO-PHI, invented/public material only, until Fable confirms otherwise (W29). Pool B (personal OpenCode Go) = PHI OK, no training, small-dose lanes — one task then stop (W28). Pool C (V's personal Claude Max) = the main PHI harness. See SESSIONS for the full pool key.
- **D-7 (26 Sep, VOICEPRINT final scoring venue, item 137):** approved — vj-refuter does it inside the 0700 sealed vault (temp decrypt, removed after, each decrypt logged); arm 4 WAITS for V's gcloud shim + Vertex credential, no fallback scoring (recorded by vj-refuter, #3845).
- **D-11 (26 Sep):** the nophi-run account — V stopped it (free model refused on both paths, paid refused insufficient funds). It stays stopped/unused. Free-model fire attribution (mini dirs) is Fable's separate routing call.
- **FABLE 453 (26 Sep):** 451 email-hash thread closed — deployed, verified by Zaki's successful login; the two list shas stay off-bus by V's 451 rule. Plus 453a usage table, 453.B governance (change-gated waves, id-paged bus reads).
- **r434 (26 Sep):** create this roadmap + records programme. → V approved; the `roadmap` pane owns it.
- **FABLE 449 (26 Sep):** checker model → opencode-go/deepseek-v4-pro now; kimi-k3 reserved for Fable + PHI/security/production checks; the OpenRouter $478 per-model split was **skipped**.
- **FABLE 450 (26 Sep):** R2 literal-exclusive follow-mode reading **KEPT literal** (inclusive flip rejected — a behaviour change needing re-check); calib30 chunkPlan fix **queued as its own check, not tonight**.
- **FABLE 452 (26 Sep):** all panes to Go now; **Zen = overflow-only** with logging; all -cc Claude panes stopped; Zen console anchor $194.76.
- **r407b (25 Sep):** HYBRID split — checkers stay Claude, builders move to OpenCode. (Superseded for checkers by r449.)
- **r421a (26 Sep):** calib30 FAIL → V rates all 200 label200 rows himself.
- **r370 (V):** room live-transcription switches stay OFF in production.
- **r409 (25 Sep):** OpenCode migration waves 1-3 executed (18 panes).
- **r308 → r406 (25 Sep):** Link-3 interim class join → reopened by V to widen the translated stratum.
