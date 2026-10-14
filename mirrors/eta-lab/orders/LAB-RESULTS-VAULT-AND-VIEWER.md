# LAB-RESULTS VAULT + VIEWER (ruling 184)

V asked for this on 24 Sep at 18:30: "build the viewer page, and make sure those STT artefacts are safe and getting saved with every new run. Eventually we will have to do other analysis on them."

V's Cloudflare grant applies. Fable created the R2 bucket **eta-lab-results** at 18:29 IST. Owner: **lab-viewer** (NEW Sonnet builder pane on the box). Advisers: join-shard (Workers + R2 bindings, already deployed eta-audio join), tunnel-ops (Access). Refuter: **eta-refuter-2**. Fable owns the verdicts.

## A. Vault: every STT/mining artefact is kept, immutable, with provenance (tonight, by 23:00)
1. **Ingest Worker `eta-lab-ingest`** (wrangler, R2 binding RESULTS=eta-lab-results):
   - `PUT /v1/obj/<key>` with a Bearer secret (wrangler secret; the secret file on the box at `~/.claude/secrets/lab_ingest`, 0600, never argv).
   - **Write-once:** an existing key returns 409, unless the body sha256 is identical (then 200 no-op).
   - There is NO delete and NO list-with-write. The size cap is 50 MB. Keys are only accepted under `runs/`, `manifests/` and `index/`.
2. **Key layout:**
   - `runs/<run_id>/<room_id>/<ist_date>/<window_or_chunk_id>.json`
   - `manifests/<run_id>.json`
   - run_id = `<producer>-<YYYYMMDDTHHMM>-<shortsha>`
3. **Provenance.** Every transcript file and manifest carries:
   - run_id and producer (hist-bulk / hist-miner / vj / production-export);
   - the STT stack: whisper model + flags (vad off, temperature_inc), IndicConformer model id, SraVaani version, router commit + config hash;
   - guard versions (shim anti-loop, english_hallucination_guard, transcript-guard, loop-guard number rule);
   - diarizer + version, the R2 audio keys of the source chunks, created_at.

   hist-bulk and hist-miner add any missing fields to their writers now (lab-viewer tells them what is missing). Files already written are backfilled into the vault under run_id `<producer>-backfill-20260924`, with whatever provenance exists and a `provenance_complete` flag.
4. **Uploader** (`kit/vault-push.py` on the box):
   - Called at the end of every unit a producer finishes, plus a 15-min catch-up timer (systemd user timer) that pushes anything not yet in the vault.
   - It keeps a local ledger (sha256 per key) so it never double-pushes.
5. **Copies:**
   - (a) the box original;
   - (b) R2 vault (immutable);
   - (c) the Mini hourly copy at `~/dev/ETA-lab-results` (already live, launchd `in.even.eta-lab-results-sync`), which V browses at /Volumes/MiniDev/ETA-lab-results.
   - A daily count check compares the three and alerts the conductor on any gap.
6. **Analysis-ready index:**
   - `index/windows.jsonl` (one row per window: run_id, room, date, doctor if linked, languages, n_turns, n_words, has_surgery_candidate, provenance hash);
   - a nightly Parquet snapshot `index/windows-<date>.parquet` for future analysis.

## B. Viewer: "ETA Lab Transcripts" (Worker `eta-lab-viewer`, behind Cloudflare Access; tomorrow 13:00)
- **Access (tunnel-ops):** an Access app on the viewer hostname (a workers.dev route with Access, or a Fable-approved hostname). Policy: V's and Sandhya's even.in emails only. An unauthenticated request must be refused; that is a refuter check.
- **Bindings:** RESULTS (eta-lab-results, read) and AUDIO (eta-audio, read-only). The viewer never writes.
- **Pages (phone-first):**
  1. **Days:** a room × date grid with filters for date range, room, doctor (from the VOICE-LINKAGE links once they exist), language, has-surgery-candidate, run. A search box does full-text search over the English and the original text, from index files built nightly.
  2. **Window:** the turns in order, each with time, speaker label (and doctor name when linked), original text and English side by side, and a ▶ per line.
     - The ▶ streams that span from the source R2 chunk via Range requests; the Worker maps window time to chunk + offset.
     - A full-window player highlights the current line.
     - It shows provenance (run_id, stack) and has download JSON.
  3. **Runs:** every run_id with counts, stack versions and status, so outputs of different stack versions can be compared later.
- **Style:** no PHI in URLs beyond ids, no analytics, no third-party scripts.

## Verification (eta-refuter-2)
- Write-once: a second PUT with different bytes returns 409; there is no delete route; oversize is refused.
- Access: an unauthenticated GET on the viewer is refused; V's identity passes.
- Provenance fields are present on new runs; the backfill is flagged.
- The three copies' counts match.
- Audio spans line up with the transcript times on 5 random lines.

## Hard rules
- No production DB writes, and no change to the eta-audio bucket or the production audio-join Worker.
- Secrets live in files or wrangler secrets, never argv or logs.
- Nothing goes in the public ETA repo; code lives in eta-lab `kit/lab-vault/` and `kit/lab-viewer/`.
