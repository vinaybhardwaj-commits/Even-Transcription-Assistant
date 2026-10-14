# DECISIONS — every open decision for V

Written by the `roadmap` pane. Plain words: each item is the question, the choices, and what I recommend. Closed decisions move to the bottom with the date and V's answer.

Last revision: **26 Sep 2026, ~10:45 IST** (rev 7).

---

## OPEN

### D-2 — ORBOX: you wrote "speakers" around the OT — do you mean microphones?
- **Question:** the brief lists "more speakers around the room". Speakers make sound; microphones collect it. Which do you want?
- **Options:** (a) microphones (more pickup); (b) speakers (playback); (c) both.
- **Recommendation:** (a) — capture needs more mics, not more speakers.
- **Raised:** 26 Sep. **Status:** open. Update 27 Sep: orbox's design v2 prices both bundles assuming (a); flip this and the bundles change.

### D-3 — ORBOX: video of patients in the OT — consent and PHI policy?
- **Question:** the robotic-surgery webcam records VIDEO of the patient and the room. Video is more sensitive than audio. What are the rules?
- **Options:** (a) full video with patient consent form; (b) audio-only until consent is sorted; (c) video with face blur / non-identifying framing.
- **Recommendation:** (a) with a proper consent step, or (b) as a safe first phase.
- **Raised:** 26 Sep. **Status:** open. **This is your call, V — it is a patient-data decision.** Update 27 Sep: orbox's design v2 test plan assumes audio+video sync only, no patient video yet.

### D-4 — ORBOX: hardware purchase
- **Question:** what to buy for the OT upgrade?
- **Options:** (a) USB webcam (audio+video separately) + a few wired mics; (b) add wireless directional mics; (c) full kit list for a quote.
- **Recommendation:** (a) first (webcam + 2-3 mics), defer wireless directional mics until the wired setup is proven. Update 27 Sep: two priced bundles (lean/full) are ready in orbox's design v2 (`~/oc/orbox/ORBOX-DESIGN-v2.md`) — this decision can now be made against real rupee numbers.
- **Raised:** 26 Sep. **Status:** open.

### D-5 — ORBOX: who owns the build?
- **Question:** which pane runs the ORBOX project?
- **Options:** (a) lab-mover (Linux/capture); (b) scribe/minibot (recorder lineage); (c) a new dedicated pane.
- **Recommendation:** (a) lab-mover for capture software + herdr-kit for Linux install, fleet for monitoring — reuse, don't mint.
- **Raised:** 26 Sep. **Status:** open.

### D-6 — RECORDER: which room follows Home Office in the 0.1.25 rollout?
- **Question:** 0.1.25 is PASSed (1da7232) and a signed test build is going to Home Office only (auto-start left on). Scope/owner (scribe build + minibot monitor) is settled. What's left is the next hop after the Home Office canary.
- **Options:** (a) a low-traffic OPD room next; (b) wait for a full nightly SELFTEST cycle first; (c) name the room now so scribe can prep.
- **Recommendation:** (a) once the Home Office self_test scores clean.
- **Raised:** 26 Sep; narrowed 27 Sep after 0.1.25 PASS. **Status:** open.

### D-8 — ROOMS: OPD 4 physical mic; Cardiology restart
- **Question:** DEVICE_MISSING still flags on OPD 4 at 07:58 this morning even though the app reports the C270 by name — someone needs to physically look at it before clinic opens. Separately, Cardiology OPD has had no kiosk since 26 Sep (offline, last heartbeat 26 Sep 19:54) and is not expected to start on its own.
- **Options:** (a) dispatch a hands-on-site check of the OPD 4 mic now; (b) for Cardiology: send someone to open the kiosk page, or leave it off until further notice.
- **Recommendation:** (a) for OPD 4 (blocks clinic recording there); (b) leave Cardiology off unless you want it recording today.
- **Raised:** 26 Sep; updated 27 Sep 08:00 with today's room-readiness reads. **Status:** open.

### D-14 — ROOMS: permission rule for fleet's read-only report_diag
- **Question:** fleet's one named, read-only `report_diag` command to OPD 4 (to check for signature_mismatch) was refused by fleet's own pane classifier as a remote write. The exact command is posted on the bus (#4221).
- **Options:** (a) add a Bash/MCP permission rule for that one command in fleet's pane; (b) you or Fable run the exact line and hand fleet the reply.
- **Recommendation:** (a) if this kind of read-only room diagnostic will recur; (b) as a one-off.
- **Raised:** 27 Sep (W34.3). **Status:** open.

### D-15 — FREESCRIPT: two open questions before any pilot
- **Question:** the FreeScript bridge design (option A: doctor pastes an ETA-written note into FreeScript) needs two answers before even an offline pilot: is Gemini's ZDR route acceptable for the stage-A note-writer LLM, and will Even run the staging parse (vs. Pulse's own team)?
- **Options:** (a) approve Gemini ZDR + Even runs staging, start the 20-consult offline pilot; (b) hold for a different model or team.
- **Recommendation:** (a) — matches how CAP-1's ceiling listening and CLARITY's S3 judge already use the Gemini ZDR route.
- **Raised:** 27 Sep (W35). **Status:** open.

### D-10 — FOUNDRY: Zen top-up cadence
- **Question:** Zen is pay-per-token from prepaid credit; no auto-reload (r407). When should it be topped up?
- **Options:** (a) V tops up on Fable's alert (< $10 or < 24 h runway); (b) enable auto-reload $20.
- **Recommendation:** (a) — keep it manual.
- **Raised:** 25 Sep; re-confirmed 26 Sep (r452). **Status:** open (standing).

---

## Tasks waiting on V's hands (not decisions — just do)

1. **Rate the 200 label200 rows** at /rate/label200 — no longer a CLARITY gate (W33 ruled automatic scoring instead), but still wanted as a later spot-check against the automatic scores.
2. ~~Run the 337b translation pass~~ **done.**
3. ~~Run the c3 apply script 81207f53~~ **done.**
4. **Top up OpenRouter** (≥ $0.50) for ceiling audio checks.
5. ~~Re-save the ElevenLabs key~~ **done — diar-lab's first real ElevenLabs synth landed 26 Sep night (rev 13).**
6. **Deploy the gcloud shim be2b6682** + temporary Vertex credentials (unblocks VJ arm 4).
7. **Authorise the GCP S7 delete** (gcloud auth on the Air, after the 24 h window; also gated on the PARITY-389 verdict, see BACKFILL).
8. **SHIP D4 (now 21:00 tonight, Fable-gated):** confirm SCRIBE_MCP_TOKENS_EXTRA + WHISPER_BULK_URLS r394 removal in the Vercel dashboard, and name someone with Vercel promote access — scribe's pane cannot promote.
9. **VOICEPRINT:** run the vj-seal-decrypt v3 `--apply` (tomorrow) so vj-refuter can verify.
10. ~~Restart the eta-bus MCP server~~ **done.**
11. **Approve the Kanglish SELFTEST phrase set** once, before the first nightly run that includes it (S1 ruling, standing ask).
12. **Physically check OPD 4's C270** before clinic opens — DEVICE_MISSING still flags it at 07:58 (see D-8).
13. **FREESCRIPT:** answer the two open questions (D-15) before any pilot.

---

## CLOSED

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
