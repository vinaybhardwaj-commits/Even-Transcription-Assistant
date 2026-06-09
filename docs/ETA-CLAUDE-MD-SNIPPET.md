# Snippet to add to your global CLAUDE.md

> I couldn't edit your global `CLAUDE.md` directly — it lives in an app-internal location the sandbox can't reach. Paste the block below into that file (after the "Current Focus: Even OS" section) so ETA/Evenscribe is documented as an active project. This makes it discoverable in any future thread without re-explaining.

---

## Active Project: Evenscribe (ETA — Even Transcription Assistant)

A mobile-first PWA for clinicians at Even Hospital: PIN login → record a patient encounter → live multilingual transcription (Deepgram + Sarvam + Mac Mini Whisper) → speaker diarization (Mac Mini pyannote) → structured clinical note (qwen2.5:14b) → real CDMSS (HyDE→MKSAP retrieve→draft→critique→revise→cite) → edit + email via Resend. Separate repo/host from Even OS.

- **Repo:** `vinaybhardwaj-commits/Even-Transcription-Assistant` · **Host:** Vercel Pro (project `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z`, team `team_yu1wWpsKdjsf90haai1ETJDG`, region `bom1`) · **Domain:** evenscribe.app · **DB:** Neon HTTP driver.
- **Authoritative handoff:** `Daily Dash EHRC/ETA/ETA-CARRYOVER-PROMPT-31-MAY-2026.md` (self-contained — all secrets/env/PAT/MCPs, deploy loop, full state). Paste it as message 1 of a new ETA thread.
- **State (31 May 2026):** HEAD `d815c20`, migrations 0001–0022. v1 hardened + multilingual + diarization + **v2.0 complete** (5 note types × 3 clinician types; `clinician` is the sole identity table) + **STT Engine Lab L0–L7 complete** (5 ASR engines + 2-tier scribe; new engine = 1 adapter + 1 registry row) + **voiceprint retention A/B live** + admin PIN visibility.
- **Key docs (in `Daily Dash EHRC/ETA/`):** `ETA-OPEN-ITEMS.md`, `ETA-BUG-LOG.md`, `ETA-STT-ENGINE-LAB-PRD.md`, `ETA-VOICEPRINT-RETENTION-PRD.md`, `ETA-MAC-MINI-BACKEND-HANDOVER.md`, `ETA-V2-PRD.md`.
- **Patterns:** Neon HTTP driver — value-param interpolation only, NOT nested `sql` fragment composition; timestamps return as strings. A Drizzle `pgTable` with no index callback closes `});` not `}));`. qwen reads `OLLAMA_BASE_URL`. Deploy loop = push main → Vercel auto-build → poll `/api/health` for the new `sha` → tag. Mac Mini services reachable only via their public HTTPS tunnels; never `pip`/`brew upgrade` the diarize venv (pins are load-bearing).
