# DECISIONS — every open decision for V

Written by the `roadmap` pane. Plain words: each item is the question, the choices, and what I recommend. Closed decisions move to the bottom with the date and V's answer.

Last revision: **26 Sep 2026, ~16:00 IST** (rev 2).

---

## OPEN

### D-1 — ROOMS: build auto-start so recording begins at clinic opening?
- **Question:** today there is no auto-start at all — staff press Start manually each morning (found 26 Sep, bus #3373). Do you want the recorder to start rooms automatically at clinic open?
- **Options:** (a) build an automated start scheduler; (b) keep manual start; (c) build a morning reminder instead.
- **Recommendation:** (a), with a visible on/off so staff can still control it, and a loud failure alert.
- **Raised:** 26 Sep (item 151). **Status:** open.

### D-2 — ORBOX: you wrote "speakers" around the OT — do you mean microphones?
- **Question:** the brief lists "more speakers around the room". Speakers make sound; microphones collect it. Which do you want?
- **Options:** (a) microphones (more pickup); (b) speakers (playback); (c) both.
- **Recommendation:** (a) — capture needs more mics, not more speakers.
- **Raised:** 26 Sep. **Status:** open.

### D-3 — ORBOX: video of patients in the OT — consent and PHI policy?
- **Question:** the robotic-surgery webcam records VIDEO of the patient and the room. Video is more sensitive than audio. What are the rules?
- **Options:** (a) full video with patient consent form; (b) audio-only until consent is sorted; (c) video with face blur / non-identifying framing.
- **Recommendation:** (a) with a proper consent step, or (b) as a safe first phase.
- **Raised:** 26 Sep. **Status:** open. **This is your call, V — it is a patient-data decision.**

### D-4 — ORBOX: hardware purchase
- **Question:** what to buy for the OT upgrade?
- **Options:** (a) USB webcam (audio+video separately) + a few wired mics; (b) add wireless directional mics; (c) full kit list for a quote.
- **Recommendation:** (a) first (webcam + 2-3 mics), defer wireless directional mics until the wired setup is proven.
- **Raised:** 26 Sep. **Status:** open.

### D-5 — ORBOX: who owns the build?
- **Question:** which pane runs the ORBOX project?
- **Options:** (a) lab-mover (Linux/capture); (b) scribe/minibot (recorder lineage); (c) a new dedicated pane.
- **Recommendation:** (a) lab-mover for capture software + herdr-kit for Linux install, fleet for monitoring — reuse, don't mint.
- **Raised:** 26 Sep. **Status:** open.

### D-6 — RECORDER: confirm the next Room Recorder release scope + owner
- **Question:** the brief says current version 0.1.24 and owner scribe/minibot; the scribe handover records ORB3's Linux recorder at 0.1.22.2. Confirm the version and which fixes ship next.
- **Options:** (a) confirm owner = scribe (build) + minibot (Mini monitor) and ship the queued list (self-test hooks, mute/device-missing detection, auto-start if D-1 passes); (b) trim the list.
- **Recommendation:** (a).
- **Raised:** 26 Sep. **Status:** open.

### D-7 — VOICEPRINT: final scoring venue (item 137)
- **Question:** where does the final VJ scoring run from the sealed truth vault?
- **Options:** (a) vj-refuter only (as today); (b) a one-shot V-run script on the box; (c) defer.
- **Recommendation:** (a) — keep the truth with the one pane allowed to see it.
- **Raised:** earlier; still open. **Status:** open.

### D-8 — ROOMS: OPD 4 restart + Dietary Mac identity
- **Question:** OPD 4 has been NOT_RECORDING/DEVICE_MISSING ~4.5 h and looks physical; the Dietary Mac has been silent since 24 Sep and we don't know which Mac it is.
- **Options:** (a) authorise a physical check + restart of OPD 4; (b) tell us which Mac is "Dietary" and send someone to check it.
- **Recommendation:** (a) and (b) — both are hands-on; only you can confirm.
- **Raised:** 26 Sep. **Status:** open.

### D-9 — SELFTEST: rule on the spec + re-save the ElevenLabs key
- **Question:** the diag-rig spec (7e55ef3) awaits a ruling on three points (phrase-set owner, Indic TTS voice fallbacks, cron schedule); the ElevenLabs key returns 401.
- **Options:** (a) approve the spec with Google TTS fallback for unsupported languages + a nightly run; (b) adjust.
- **Recommendation:** (a). Re-save the ElevenLabs key to `~/.claude/secrets/elevenlabs_key`.
- **Raised:** 26 Sep (r428/428b). **Status:** open.

### D-10 — FOUNDRY: Zen top-up cadence
- **Question:** Zen is pay-per-token from prepaid credit; no auto-reload (r407). When should it be topped up?
- **Options:** (a) V tops up on Fable's alert (< $10 or < 24 h runway); (b) enable auto-reload $20.
- **Recommendation:** (a) — keep it manual.
- **Raised:** 25 Sep; re-confirmed 26 Sep (r452). **Status:** open (standing).

---

## Tasks waiting on V's hands (not decisions — just do)

1. **Rate the 200 label200 rows** at /rate/label200 (unblocks CLARITY).
2. **Run the 337b translation pass:** `bash ~/run-337b-v5.sh 12` (feeds CAP-1).
3. **Run the c3 apply script 81207f53** (mounts `eta-data-ro`, binds machine id) — dry-run first, hash pinned.
4. **Top up OpenRouter** (≥ $0.50) for ceiling audio checks.
5. **Re-save the ElevenLabs key** (HTTP 401).
6. **Deploy the gcloud shim be2b6682** + temporary Vertex credentials (unblocks VJ arm 4).
7. **Authorise the GCP S7 delete** (gcloud auth on the Air, after the 24 h window).
8. ~~Restart the eta-bus MCP server~~ **done — `fable` recipient resolves (stored_poll) per #3711.**

---

## CLOSED

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
