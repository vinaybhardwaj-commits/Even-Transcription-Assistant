# ETA Post-Launch Bug Log

Started 27 May 2026 after V's first real transcription test on `evenscribe.app`.

---

## B1 — "Load failed" on Submit Recording (open, investigating)

**Reported:** 27 May 2026 ~10:30 IST
**Reporter:** V (first transcription test)

**Symptom:** Recording UI captured ~30 seconds of speech fine — live Deepgram transcript visible, Whisper chunks processing (30 chunks / 8 finals, 797 KB total, audio/webm;codecs=opus). On tap **Submit recording**, red "Load failed" text appeared below the button. Encounter never reached `/process`.

**Screenshot:** V's phone at `evenscribe.app/dr-vinay-bhardwaj-cjzs` (PWA via WhatsApp deeplink).

**Investigation so far:**

- Vercel runtime logs for the relevant time window show NO request to `/[slug]/api/encounters/[id]/upload-url`. The browser fetch failed BEFORE reaching the server.
- "Load failed" is the browser's generic message for `TypeError` thrown by `fetch()` at the network layer (CORS rejection, connection refused, etc).
- The submit flow (`lib/use-encounter-submit.ts`) does three network calls in sequence: POST `/upload-url` → PUT to R2 (presigned) → POST `/finalize-upload`. Failure is at the first call.

**Prime hypothesis: apex/www CORS mismatch.**

V's screenshot footer says `evenscribe.app` (apex, no www). Vercel routes apex → 307 → `www.evenscribe.app`. If the doctor PWA was opened at apex and stayed at apex (Safari sometimes preserves the originally-tapped URL for installed PWAs), then:
- Page origin = `evenscribe.app`
- JS does relative `fetch("/dr-vinay-X/api/encounters/X/upload-url")` → hits apex
- Apex 307s to www
- Browser cross-origin preflight needed (apex → www are different origins for CORS)
- Our `/upload-url` route has no `Access-Control-Allow-Origin` headers
- Preflight OPTIONS fails → `fetch()` throws TypeError → "Load failed"

**Secondary hypothesis: R2 CORS.**

Even if the upload-url POST succeeds, the next step is a direct PUT to R2 with the presigned URL. R2 bucket `eta-audio` was originally configured with CORS allowing only `eta.llmvinayminihome.uk`. Requests from `www.evenscribe.app` or `evenscribe.app` would be rejected by R2 with no CORS headers → browser throws "Load failed" on the PUT step. But this would surface as the 2nd failure, not the 1st — and logs would show the upload-url POST succeeded.

**Fix plan:**

1. Test whether V's browser URL bar shows apex or www after PWA cold-launch.
2. If apex: flip the Vercel domain config so www → apex (apex-canonical), eliminating the cross-origin redirect.
   - OR: add `evenscribe.app` to R2 CORS allowed origins + add CORS headers to our /upload-url and /finalize-upload routes so the cross-origin POST is allowed.
3. Update R2 bucket CORS to allow both `https://evenscribe.app` and `https://www.evenscribe.app` (defensive — the audio PUT happens regardless of which page-origin the user is on).

**Status:** ✅ FIXED — R2 CORS updated, V to verify submit flow

**Final outcome (27 May 2026, ~14:30 IST):**
- V created admin-scope R2 API token (`eta-cors-admin`, TTL 7 days)
- Token Access Key + Secret added to Vercel env as `R2_ADMIN_ACCESS_KEY_ID` + `R2_ADMIN_SECRET_ACCESS_KEY` (Sensitive)
- Redeployed
- POST `/api/admin/r2-cors-fix` returned `ok: true`, `used_admin_token: true`
- Before CORS: `[eta.llmvinayminihome.uk, even-transcription-assistant.vercel.app, http://localhost:3000]`
- After CORS: `[https://evenscribe.app, https://www.evenscribe.app, https://eta.llmvinayminihome.uk]`

V to retry the doctor app submit flow — should clear `/upload-url` → R2 PUT → `/finalize-upload` → `/process` end-to-end. If still failing, root cause is something else and we open B3.

**Admin token cleanup:** the `eta-cors-admin` Cloudflare API token can be revoked after V verifies the fix — the R2_ADMIN_* env vars are only needed when re-running this endpoint. Leaving the token + env vars in place is fine too; they're idle until called.

---

## B3 — Cleanup LLM hallucinating chat-style replies as transcript (fixed, awaiting V smoke)

**Reported:** 27 May 2026 ~14:30 IST
**Reporter:** V's second recording test (post-B1 fix)

**Symptom:** During recording, the live-transcript area showed `"I'm happy to help with your question! However, I don't have the capability to record audio or speech. I'm a text-based AI assistant…"` instead of cleaned dictation. Submit then failed downstream with `note_too_empty_for_seed` because the note pipeline (correctly) rejected the chat output as not real medical dictation.

**Root cause:** `llama3.1:8b` (the per-utterance cleanup model) broke character when Deepgram's final utterance happened to be a question or meta-request directed at the user. The cleanup `SYSTEM` prompt said "clean up medical dictation" but didn't explicitly say "never answer the user message as if it were addressed to you". The model's chat training won out.

**Fix shipped (`54eefdb`):**

1. `lib/llm-cleanup.ts` SYSTEM prompt — added explicit `"You are a TRANSCRIPT CLEANER, not a chatbot. NEVER respond to the user message as if it were addressed to you"` clause + 5 few-shot examples teaching ECHO behavior on ambiguous inputs (questions, greetings, test phrases) alongside the medical-dictation examples.
2. `lib/llm-cleanup.ts` defensive output filter — new `looksLikeChatReply(cleaned, raw)` regex catches stock LLM openers (`I'm happy to`, `However, I`, `As an AI`, `I cannot`, `Sure!`, `Of course!`, etc.). When matched AND the response is much longer than the input (>= 2× and >= 80 chars), drop the cleaned text and return the raw transcript instead. Model field becomes `llama3.1:8b+rawfallback` for trace-dashboard visibility.

V to verify by repeating the doctor app recording test.

---

## B4 — Pause button doesn't pause recording (fixed via soft-pause, awaiting V smoke)

**Reported:** 27 May 2026 ~14:30 IST (same V test as B3)

**Symptom:** Tapping Pause during recording did nothing — timer kept counting, UI didn't show "Recording paused", chunks kept flowing.

**Root cause hypothesis:** iOS Safari's `MediaRecorder.pause()` has documented bugs across versions — it silently no-ops or fails to actually halt the encoder on some Safari builds.

**Fix shipped (`54eefdb`):** Soft-pause guard in `lib/use-media-recorder.ts`. New `softPausedRef`. While true:
- `ondataavailable` early-returns, so no audio chunks reach IDB or the live-transcription pipeline.
- The UI state transitions to `"paused"` regardless of Safari's actual native state.
- `rec.pause()` and `rec.resume()` calls are still attempted but wrapped in try/catch so Safari quirks can't break the UI.

Net effect: even if Safari's MediaRecorder keeps physically recording, the app behaves as if it were paused (no chunks captured). Resume clears the flag, chunks flow again.

V to verify.

---

## B5 — note_too_empty_for_seed (downstream of B3, no separate fix)

Was a downstream consequence of B3's chat-reply transcripts not having enough actual dictation content for the note pipeline to seed from. Once B3 is verified fixed, B5 should auto-resolve on the next real recording. If it still surfaces with real dictation, open as B5.1.

---

**Fix shipped (commit `599b3f1`):** New POST `/api/admin/r2-cors-fix` endpoint. Admin-cookie gated. Uses the existing `@aws-sdk/client-s3` dep (same code path that signs upload URLs) to call `PutBucketCors` on the `eta-audio` bucket. Adds `evenscribe.app`, `www.evenscribe.app`, and `eta.llmvinayminihome.uk` to allowed origins. Idempotent. Audit-logged.

**First attempt failed `Access Denied`:** The R2 token the app uses (R2_ACCESS_KEY_ID) has Object scope only — fine for PutObject (upload) but `PutBucketCors` requires Admin scope.

**Fix v2 (commit `52fb272`):** Endpoint now prefers `R2_ADMIN_ACCESS_KEY_ID` + `R2_ADMIN_SECRET_ACCESS_KEY` when set. V creates a separate Admin Read & Write R2 token in Cloudflare, pastes into Vercel env, redeploys, re-runs the fetch. The regular token stays Object-only — admin token only used for ops like this. Response includes `used_admin_token: bool` so V can verify.

**How V triggers it after deploy lands:**
1. Sign in to `evenscribe.app/admin` (already done — admin session active)
2. Open DevTools Console (`Cmd+Opt+J`) on any admin page
3. Paste: `fetch('/api/admin/r2-cors-fix', { method: 'POST' }).then(r => r.json()).then(console.log)`
4. Should see `{ ok: true, allowed_origins: [...], before: [...], after: [...] }`
5. Re-try the doctor submit flow — should work end-to-end

---

## B6 — note_too_empty_for_seed despite ~5 min of recording (fixed `c167542`, awaiting V smoke)

**Reported:** 28 May 2026 ~early hours IST
**Reporter:** V's second clean test (post-B3/B4 fix). Recording showed sensible cleaned transcripts on-screen: 177 chunks · 4907.5 KB · 50 finals. Whisper showed an "error · pass #17" mid-recording (separate, tracked as B7) but live transcript looked healthy. Submit succeeded; `/process` came back `note_too_empty_for_seed`.

**V's verbatim question:** "I did another test. This time the live transcription seemed to work more appropriately. But inspite of getting what i thought was 5 minutes of speech, it still said that the note was too empty for the seed. Thats really strange. What is too empty? What is full enough? How are we deciding this?"

### What "too empty" actually means

`note_too_empty_for_seed` is thrown by `lib/cdmss-pipeline.ts:326`. The CDMSS pipeline doesn't read the transcript directly — it reads the **EncounterNote** that qwen2.5:14b produced from the transcript. The note has 9 fields (chief_complaint, history_present_illness, examination, assessment, plan.investigations[], plan.treatment[], plan.follow_up, etc.). The pipeline calls `noteToSeedQuery(note)` which concatenates 5 of these (chief_complaint, assessment, HPI, exam, plan items). If after `.trim()` that concatenation is an empty string — i.e. the note has nothing in any of those slots — the pipeline bails with `note_too_empty_for_seed`.

So "too empty" = the LLM-generated note has no chief complaint, no assessment, no HPI, no exam, and no plan items. There is no character threshold — it's a presence check on those five fields.

### Why V's note was empty even with 5 minutes of speech

The transcript saved to `encounter.transcript_raw` (which qwen2.5:14b reads) wasn't the on-screen 5 minutes. It was a SHORT Whisper stub frozen mid-recording.

Mechanism:
- `useWhisperRolling` runs a Whisper pass every 10s, each pass uploads ALL accumulated audio, replaces (not appends) its `latest.text` on success.
- It only updates `latest.text` on a SUCCESSFUL pass. On error, it sets state to "error" but keeps `latest` pointing to the last good pass.
- V's screenshot showed "Whisper · error · pass #17" — passes were erroring mid-recording. So `wh.latest.text` was frozen at the text from pass #N where N is whatever the last good pass was (could be from 30-90s in).
- The submit path sends BOTH transcripts to `/finalize-upload`:
  - `deepgramTranscript` = `finals.map(f => cleanup.cleanedById[f.id] ?? f.text).join(" ")` — the full 50-utterance transcript visible on screen, ~5 minutes worth.
  - `whisperTranscript` = `wh.latest?.text ?? ""` — the frozen short stub.
- `/finalize-upload` was preferring Whisper unconditionally when present (a stale "Whisper has better medical-term accuracy" rule from Sprint 1). It saved the short Whisper text, discarded the long Deepgram text.
- qwen2.5:14b then got a transcript covering only the first minute or so — not enough context to populate the assessment / plan / HPI fields. Note came back almost entirely empty. CDMSS pipeline saw the empty note and bailed.

### Fix (`c167542`)

`app/[slug]/api/encounters/[id]/finalize-upload/route.ts`:
- New rule: trust Whisper only when materially longer than Deepgram (`whisper.length >= 1.2 × deepgram.length`). Whisper IS more accurate on medical terms, but a small/equal length means it didn't actually cover the full audio. In that case prefer the Deepgram-cleaned text, which is appended to throughout the recording.
- If only one source is present, use it.
- Logs the chosen source + character counts via `console.log` (visible in Vercel runtime logs).
- Returns the same in the response body under `transcript: { chosen_source, whisper_chars, deepgram_chars, kept_chars }` so dev-tools / future client UI can show it.

### Verification plan

V to run another recording test. Expected behavior:
- `/finalize-upload` response now includes a `transcript` block with `chosen_source` and char counts.
- If Whisper still errors mid-recording, `chosen_source` should now report `deepgram` (since Whisper text will be shorter), and the saved `transcript_raw` will be the full 5-minute Deepgram cleaned transcript.
- Note generation should populate chief_complaint / HPI / assessment from the full transcript, and CDMSS should run end-to-end.

If `note_too_empty_for_seed` still surfaces with a real 5-minute recording, the next suspect is the qwen2.5:14b note-generation prompt or the JSON-parsing layer — open as B6.1.

---

## B9 — Email "View in app" link 404s (missing /[slug] prefix) (fixed, awaiting V smoke)

**Reported:** 28 May 2026 ~morning IST by V's first successful email arriving for enc_rm4dq7tbvh.

**Symptom:** Email's "View in app" link points to `evenscribe.app/encounter/{id}` — no doctor slug. Clicking it lands on a Next.js 404 ("This page could not be found"). Our actual doctor encounter route is `/[slug]/encounter/[id]`.

**Root cause:** `lib/email-template.ts` builds the link as `${appUrl}/encounter/${encounterId}` (lines 248 + 305). The doctor's slug isn't threaded through `renderNoteEmail()` so it can't be in the link. The bug is harmless within a single deploy but every email sent so far has the broken form, so a forward-compat fix is needed.

**Fix shipped:** New server component at `app/encounter/[id]/page.tsx`. Given just the encounter id, it looks up `doctor.url_slug` via a single JOIN, then 307-redirects to `/{slug}/encounter/{id}`. The doctor-scoped page then runs its normal PIN auth flow. If the encounter doesn't exist or was deleted, returns 404.

This fixes both **future emails** (template URL stays the same) and **already-sent emails** (the link resolves once V is on the new deploy). Zero schema delta.

**V to verify:** Click the "View in app" link from the same email — should land on the doctor PIN page or directly on the encounter detail depending on cookie state.

---

## B10 — Email rendered with empty note (no clinical content) (fixed, awaiting V smoke)

**Reported:** 28 May 2026 ~8:36 AM IST. Same email as B9: header chrome + disclosure banner only, zero clinical sections.

**Why this passed all guards but produced an empty email:**

The CDMSS pipeline's `note_too_empty_for_seed` check (lib/cdmss-pipeline.ts:326) requires ANY ONE of chief_complaint / assessment / HPI / exam / plan items to be non-empty. The email template renders each section conditionally — every clinical section uses `note.field ? renderSection : ""`. So a note where qwen2.5:14b populated only `current_medications` or only `allergies` (an array check, not a string check) passes the seed-empty bail-out but produces an email body with zero clinical content.

V's specific enc_rm4dq7tbvh ran shortly **before** the B6 fix (deploy READY at 8:37 AM IST; email sent at 8:36 AM IST). Same root mechanism: a short Whisper stub was preferred over the longer Deepgram transcript, qwen2.5:14b extracted just enough to pass the seed check, but not enough for any of the rendered email sections.

**Fixes shipped (three layers):**

1. **`/[slug]/api/encounters/[id]/send` guard.** Computes `hasContent` across all clinical fields (CC, HPI, exam, assessment, PMH, meds, allergies, all 3 plan fields). If every one is empty, the request 400s with `note_has_no_clinical_content` BEFORE Resend is called. No more silent empty sends.

2. **`/api/admin/encounters/[id]/resend` guard.** Same predicate, same 400 response — covers the admin-initiated resend path.

3. **`lib/email-template.ts` defensive fallback.** If the conditional section-render pipeline produces an empty `noteSections` string (i.e. somehow the guards above were bypassed), the email body shows a prominent red warning card: "No clinical content was extracted from this recording. The transcript may have been too short, silent, or non-clinical." Recipient sees the failure mode loudly instead of guessing what happened.

The B6 fix already addresses the underlying root cause (transcript selection). These three layers ensure that even if a future failure mode produces an empty note (e.g. qwen2.5:14b times out and we fall back to a blank stub), the user-facing symptom is loud rather than silent.

**V to verify:** Run another recording test. New encounters that pass through (post-B6 transcript fix) should have real content. If a future encounter somehow produces a blank note, the doctor app will refuse to send and surface the error.

---

## B7 — Whisper rolling passes 413 cliff at ~3 min cumulative (fixed via delta uploads, awaiting V smoke)

**Reported:** 28 May 2026 ~11:18 IST (re-prioritised — three of V's screenshots all show pass #17 frozen at 4333 KB, identical across recording sessions).

### Symptom

During recording, the Whisper status pill flips to `error` and stays there. The badge displays `pass #17 · 8.1s · 4333 KB` regardless of how much longer the recording runs. All three of V's screenshots (03:13, 05:37, 06:09 elapsed) showed the *same* pass #17 readings — deterministic, not flaky. The Deepgram live transcript above continued updating fine, so the recording itself was healthy; only the Whisper rolling was stuck.

### Forensics

Pulled Vercel runtime logs (`mcp__vercel__get_runtime_logs`) for V's 5-minute recording window 05:39–05:44 IST. Pattern:

```
05:44:32 GET /dr-vinay-bhardwaj-cjzs/api/transcribe/whisper-chunk  413
05:44:24 POST /dr-vinay-bhardwaj-cjzs/api/transcribe/whisper-chunk 200
05:44:22 GET /dr-vinay-bhardwaj-cjzs/api/transcribe/whisper-chunk  413
…
```

The 200 POSTs are utterance cleanup calls firing as Deepgram finals arrive. The every-10-seconds 413s are the rolling Whisper passes. The "GET" label on the 413 rows is a Vercel logging artifact — when a request body exceeds the platform 4.5 MB limit, Vercel rejects at the edge before invoking the function and normalises the displayed method to GET. The actual client request is a POST with a multi-MB multipart body.

### Root cause

**Vercel serverless function body limit = 4.5 MB.** The rolling client (`lib/use-whisper-rolling.ts`) POSTed the FULL cumulative WebM blob on every pass — pre-fix design was "cumulative-from-zero" to keep the WebM container valid for whisper.cpp. With ~28 KB chunks emitted every second, the cumulative size grows linearly:

| Pass | Time | Cumulative | Outcome |
|------|------|------------|---------|
| 1    | ~10s | ~280 KB    | 200 ok  |
| 10   | ~100s | ~2.8 MB   | 200 ok  |
| 17   | ~170s | ~4.4 MB   | 200 ok (the last one V saw succeed — badge frozen here) |
| 18+  | >180s | >4.5 MB   | **413** at platform edge, function never runs |

The hook had no recovery: it kept the same growing cumulative blob in memory and re-POSTed it every 10 seconds, all rejected. The state went to `error` and stayed there. `latest` (the source of the badge readings) was last set by pass #17, so V saw pass #17 frozen forever.

### Fix shipped (`a70bc34`, capstone `bf5962e`)

V's lock: **delta uploads + R2 buffer.**

**Client (`lib/use-whisper-rolling.ts`):**
- Track `nextChunkIdxRef`. Each pass sends only `chunks[nextChunkIdxRef .. chunks.length)` — typically one pass-interval's worth (~280 KB), well under the platform limit.
- Form payload gains `is_first` and `encounter_id` (now required, keys the server-side buffer).
- **Self-healing retry:** on failure, do NOT advance the watermark. Next interval tick retries the same delta plus anything new. Pre-fix the rolling silently froze at first failure; post-fix any single failure recovers on the next 10-second tick.
- `WhisperPass` gains `cumulative_bytes` so the badge can surface buffer size if we want.

**Server (`app/[slug]/api/transcribe/whisper-chunk/route.ts`):**
- On `is_first=1`: PUT the delta as the new buffer at `whisper-buffer/{encounter_id}.webm` (this delta carries the WebM init segment).
- Otherwise: GET existing buffer, concat with the new delta, PUT back.
- Hand the FULL concatenated audio to Mac Mini whisper.cpp. The Vercel→Mac Mini hop has no 4.5 MB inbound limit (that cap is for requests *to* Vercel only); the Cloudflare tunnel handles up to 100 MB.
- `MAX_BUFFER_BYTES = 60 MB` guard prevents runaway buffers (60 MB ≈ 30+ min of opus, well past any OPD visit).
- Response adds `cumulative_bytes` for client observability.

**R2 helpers (`lib/r2.ts`):**
- New `whisperBufferKey(encounterId)` for a well-known prefix (helpful for sweeps).
- `getObjectBytes(key)`: `GetObjectCommand` + `transformToByteArray()` with `AsyncIterable<Buffer>` fallback. Returns `null` on `NoSuchKey` so callers can branch cleanly.
- `putObjectBytes(key, bytes, contentType)`: thin wrapper.
- `deleteObject(key)`: best-effort, swallows errors (missing object is fine).

**Cleanup (`app/[slug]/api/encounters/[id]/finalize-upload/route.ts`):**
- After the DB row flips to `processing`, `void deleteObject(whisperBufferKey(id))`. Best-effort; failure here doesn't affect the encounter.
- Orphan buffers from drafts that never submit are capped at 60 MB each by the route guard. R2 lifecycle TTL on the `whisper-buffer/` prefix can be configured later if storage cost becomes a concern. (R2 is ~$0.015 per GB-month — orphan tax is negligible at OPD scale.)

### Hotfix history

- **H1 `a70bc34`** — `dpl_GTxc1716urd99ARrk4LZHEPi9uYD` (B7 capstone `bf5962e`) failed TS compile with `Cannot find name 'deleteObject'`. My in-sandbox sed import edit got overwritten when I copy-staged the locally-edited cleanup file back to the repo. One-line re-import widen. Deploy `dpl_F4SWKa6vW4tTsZovSuDEDkuxbjEH` READY in 35s.

### Verification plan

1. Hard-refresh the doctor PWA so the new SW takes over (B11 already bumped it to `eta-shell-v2`).
2. Record **>3 minutes** (the old failure threshold). Past pass #17:
   - Whisper badge should keep advancing — pass #18, #19, #20… with growing `cumulative_bytes` in the next response.
   - Whisper pill stays green (`Whisper · waiting` / `transcribing…`), never `error`.
   - If a single network blip causes one pass to 5xx, the next tick should recover.
3. Submit the encounter. Verify final email has full clinical content.
4. Optional admin check: open R2 dashboard and confirm `whisper-buffer/enc_<...>.webm` was deleted after submit (look in the `eta-audio` bucket).
5. Open `/admin/traces` and look at the encounter's traces — whisper pass durations should be visible and growing modestly per pass (more buffer = slightly more whisper.cpp inference time, but well within the 60s budget).

### What this also fixes downstream

B6 (`c167542`) — "finalize-upload prefers LONGER transcript" — was a defensive cover for B7. The Whisper transcript was being short-circuited to whatever pass #17 produced, so we fell back to Deepgram. With B7 fixed, the Whisper rolling produces a full transcript for the entire recording, and the B6 longer-of-two rule will start preferring Whisper again on long medical recordings (more accurate terminology). B6 stays in place as belt-and-suspenders.

**Status:** ✅ FIXED on `a70bc34`. V to verify after the next recording >3 min.

---

## B2 — Cloudflare R2 dashboard stuck on loading spinner (closed)

**Symptom:** `dash.cloudflare.com/.../buckets/eta-audio/settings` shows the Cloudflare orange-cloud spinner indefinitely. No timeout, no error, no redirect to login. Even `/login` URL exhibits same behavior in this session.

**Suspected causes:** silent session expiry; regional Cloudflare issue; ad-blocker / privacy extension blocking dashboard XHRs.

**Blocks:** B1 fix via UI. Workaround = use the S3-compatible API to update R2 bucket CORS programmatically using the project's R2 credentials (currently only in Vercel env, not in local secrets file — would need to retrieve via Vercel API or have V paste them).

**Status:** unblocked — V to investigate why the dashboard is hung in their browser

---

## B11 — Patient label never saved + Library stuck on stale list (fixed, awaiting V smoke)

**Reported:** 28 May 2026 ~11:18 IST
**Reporter:** V via screenshots — Library showing 5 untitled drafts from 07:35–08:30 IST and a Yesterday-09:42 Sent row, while two SENT emails (`Cough and breathlessness` at 11:16 and `Severe chest pain and shortness of breath` at 11:04) had clearly landed in V's inbox the same morning.

**Symptom (two parts as V phrased it):**

> Part A: "I had typed in and named the encounters appropriately, but the names were never saved. It seems like almost every time I try to name an encounter, it fails."
>
> Part B: "The library is not showing these new fully completed encounters."

The two parts were unrelated bugs that manifested together and were easy to conflate.

### Root cause — Part A: patient label dropped on the floor

`HomeShell.tsx` exposes a "Patient (optional)" input on the Record tab. On tap of the big Record button, it writes the trimmed string to `sessionStorage` under key `eta:pending_patient_label`:

```ts
// HomeShell.tsx (unchanged code, pre-fix)
if (patientLabel.trim()) {
  try {
    sessionStorage.setItem("eta:pending_patient_label", patientLabel.trim());
  } catch { /* private mode */ }
}
router.push(`/${slug}/record`);
```

That key is then read by **nothing**. `grep -rn "pending_patient_label"` returns one write and zero reads. The `/record` page (`RecordingScreen.tsx`) creates a draft encounter as soon as preflight passes:

```ts
// RecordingScreen.tsx (pre-fix)
const res = await fetch(`/${slug}/api/encounters`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),   // ← empty body, label not passed
});
```

The POST handler at `app/[slug]/api/encounters/route.ts` does accept a `patient_label` field and writes it to `encounter.patient_label_raw` — but since the client always sent `{}`, the column ended up `NULL` for every encounter created since the recording flow was built.

The library uses `chief_complaint || patient_label || "Untitled encounter"` for its row title. When the LLM populated `note_json.chief_complaint` (e.g., yesterday's "Genital pain, abdominal discomfort"), the title showed. When the LLM produced no chief_complaint (or hadn't run yet for that snapshot), the row read "Untitled encounter" — exactly what V was seeing.

The chief_complaint inside the email body (e.g., "REASON FOR VISIT: Cough and breathlessness") was populated correctly by the LLM and is unrelated to the patient_label field V was typing. V's typed names were going to `/dev/null` from the moment HomeShell wrote them.

### Root cause — Part B: service worker pinned doctor-scoped API responses

`public/sw.js` had this fetch handler logic:

```js
// Network-first for /api/* (no caching of RAG responses)
if (url.pathname.startsWith('/api/')) {
  e.respondWith(fetch(e.request).catch(...));
  return;
}
// Static assets — cache-first, fall through to network
if (e.request.method === 'GET') {
  e.respondWith(caches.match(e.request).then((cached) =>
    cached || fetch(e.request).then((resp) => {
      if (resp.ok && resp.type !== 'opaque') {
        caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone));
      }
      return resp;
    })
  ));
}
```

The `startsWith('/api/')` exclusion matches `https://evenscribe.app/api/health` but NOT `https://evenscribe.app/dr-vinay-bhardwaj-cjzs/api/encounters`. The doctor-scoped GET fell through to the cache-first branch.

So the first time V's PWA hit the Library tab, the SW fetched `/dr-vinay-bhardwaj-cjzs/api/encounters`, got an `ok` JSON response, and cached it in the `eta-shell-v1` cache. Every subsequent GET — tab switch, manual refresh, page reload — was served from cache. The doctor's library was permanently frozen at the snapshot from the first visit, regardless of how many new encounters were sent.

The `cache: "no-store"` on the client `fetch(...)` only suppresses the HTTP cache; it does not stop the service worker from intercepting. The SW's `activate` handler clears caches not matching `SHELL_CACHE` — so the cache name stays the same across deploys and the stale cached payload survives indefinitely.

This also explains why even the most recent "08:30 Sent" library row showed "Untitled encounter" with a 5m6s duration: the cached snapshot was taken before the LLM had finished populating `note_json.chief_complaint` for that encounter.

### Fix shipped (`6a0affd`)

Three small edits, one commit.

**1. `components/recording/RecordingScreen.tsx`** — read sessionStorage, pass label, clear key:

```ts
let pendingLabel: string | null = null;
try {
  const raw = sessionStorage.getItem("eta:pending_patient_label");
  if (raw && raw.trim().length > 0) {
    pendingLabel = raw.trim().slice(0, 200);
  }
  sessionStorage.removeItem("eta:pending_patient_label");
} catch { /* private mode */ }

const res = await fetch(`/${slug}/api/encounters`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(pendingLabel ? { patient_label: pendingLabel } : {}),
});
```

Clearing the key prevents a subsequent "no name typed" recording from inheriting an old label.

**2. `public/sw.js`** — match any `/api/` path, bump cache version, narrow the static-asset allowlist:

```js
const SHELL_CACHE = 'eta-shell-v2';   // ← bumped from v1

// inside fetch handler:
if (url.pathname.includes('/api/')) {       // ← was startsWith
  e.respondWith(fetch(e.request).catch(...));
  return;
}
if (e.request.method === 'GET') {
  const cacheable =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.ico');
  if (!cacheable) return;   // pure network for everything else
  // ...cache-first only for hashed Next.js bundles + static icons
}
```

The cache version bump triggers the existing `activate` handler to wipe `eta-shell-v1` and any other non-current caches as soon as the new SW takes over. Combined with the existing `controllerchange` reload logic in `public/register-sw.js`, the user's app refreshes once and is back to clean network-first behaviour.

**3. `components/Library.tsx`** — refetch on tab return + manual Refresh button:

```ts
React.useEffect(() => {
  const onVisible = () => {
    if (document.visibilityState === "visible") void load();
  };
  const onPageshow = (e: PageTransitionEvent) => {
    if (e.persisted) void load();  // bfcache restore (iOS Safari swipe-back)
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  window.addEventListener("pageshow", onPageshow);
  return () => { /* cleanup */ };
}, [load]);
```

Defence-in-depth: even if a future SW regression re-introduces a similar caching bug, the user can hit Refresh and get truth from the server.

### Verification plan

After Vercel deploy goes READY:

1. **Hard refresh** `https://evenscribe.app/dr-vinay-bhardwaj-cjzs/` (PWA users: kill the PWA, relaunch). The new `eta-shell-v2` SW activates → `activate` handler drops `eta-shell-v1` → first reload completes.
2. **Library should immediately show the 11:04 + 11:16 sent encounters** — they have always been in the DB, the SW was just hiding them.
3. **Test Part A:** type "Test patient — B11 check" in the Patient input on Record tab → tap Record → record 10 seconds → submit. Return to Library. New row should show "Test patient — B11 check" as the title (or the chief_complaint extracted by the LLM, whichever applies). The patient_label should also persist in the email body's PATIENT block.
4. **Test Part B refresh:** record + send another encounter. Stay on `/encounter/[id]`. Swipe-back to the doctor home. Switch to Library tab. The newly sent encounter must appear without a manual page reload.

### Notes

- **The orphan-drafts problem in V's screenshot** (5 drafts between 07:35 and 08:30) is a separate, pre-existing UX issue — the recording screen creates a draft encounter every time the user lands on `/record`, even if they back out without speaking. Not in scope for B11; could be a B12 if V wants it.
- **APP_URL in Vercel env** is still pointed at `eta.even.in` (carryover trap §6). All code paths that need it go through `canonicalAppUrl()` which falls back correctly, so this remains cosmetic — but V can clean it up in the Vercel env dashboard when convenient.

**Status:** ✅ FIXED on `6a0affd` (pushed 28 May 2026 ~11:30 IST). V to verify after the Vercel deploy reaches READY.

---

---

## B12 — Multilingual (Sarvam) Kannada encounter produced an empty/garbage note (29 May 2026)

**Reported:** V recorded a Kannada medical encounter on the live app; "failed miserably."

**Symptom (from `enc_nybwbnvufd`, 79s, 13:10 IST):** `status=complete` but `detected_language=null`, `transcript_original=null`, `note_json` entirely empty. `transcript_raw` was hallucinated English ("Who does that mean? ... I'm not saying anything ... You're going to be angry") — Deepgram `nova-3-medical`/`en-IN` force-fitting English onto Kannada audio. The Sarvam rolling route ran 8× (every 10s) all HTTP 200, yet contributed nothing.

**Root cause:** Sarvam's REST API validates the multipart file part's MIME against a strict allow-list that accepts **bare `audio/webm`** but **rejects `audio/webm; codecs=opus`** (HTTP 400 `invalid_request_error: Invalid file type: audio/webm;codecs=opus`). Browser `MediaRecorder` blobs carry the codec parameter (`audio/webm; codecs=opus` on Chrome/Android, `audio/mp4; codecs=...` on iOS Safari). `lib/sarvam.ts` passed `blob.type` through verbatim, so **every** Sarvam call (transcribe + translate, every block including block 0) returned 400 → soft-failed to null → the route returned 200 with null text → the rolling hook accumulated nothing → `sv.language` stayed null → `finalize-upload`'s `svNonEnglish` was false → no Sarvam override → fell back to the Deepgram/Whisper (English-only) path → empty note.

**Why it slipped QA:** all pre-ship probes sent the file with a hand-set bare `type=audio/webm`, which Sarvam accepts. The deploy-timing/env-var were ruled out (the keyed deploy `b5791b6` was live at 13:05, before the 13:10 test; key confirmed present). Confirmed via a temporary admin `sarvam-debug` route that pulled the real R2 audio (`content_type: "audio/webm; codecs=opus"`) and reproduced the 400.

**Fix (`76cff00`):** `lib/sarvam.ts` `callSync` strips MIME parameters before building the upload Blob — `const baseType = contentType.split(";")[0].trim().toLowerCase() || "audio/webm"`. Covers both Chrome (`audio/webm`) and iOS Safari (`audio/mp4`). Temp debug route removed.

**Verification:** POSTed `sample.webm` to the LIVE `/dr-…/api/transcribe/sarvam-live` with the file part's Content-Type set to exactly `audio/webm; codecs=opus` → HTTP 200, `language_code: kn-IN`, Kannada original + English translation, `errors: {transcribe:null, translate:null}`. Reproduced bare-vs-parameterized against Sarvam directly (200 vs 400).

**Remaining:** V device re-test (record Kannada → native script live → submit → English note). Separately noted: the live rolling is best-effort near-live; the canonical note still depends on the rolling having accumulated text, so if a recording is very short or the rolling stalls, consider a submit-time Sarvam pass on the full R2 file (Batch API for >30s) as a belt-and-suspenders — backlog item, not required now.

---

## B13 — iOS Safari: recording froze (stuck) after Pause → Resume (29 May 2026)

**Reported:** V (iPhone Safari) was recording a Hindi test, paused, switched what audio was playing (no device change), tapped Resume — recording froze: timer/transcript stopped updating, though the UI stayed responsive. Created `enc_9ayc4jp4hz` as a `draft` (dur=None, never finalized). No server errors.

**Root cause:** iOS Safari's `MediaRecorder.resume()` after `pause()` frequently fails to restart **timeslice** data emission — `ondataavailable` never fires again, so no chunks reach IDB / Deepgram / Whisper / Sarvam, even though `rec.state` reports "recording". The app's soft-pause guard (B4) couldn't help because the *native* recorder itself had stopped emitting. The recorder was effectively dead after the iOS resume.

**Fix (`507ec3b`):** stop using native `MediaRecorder.pause()`/`resume()` entirely (`lib/use-media-recorder.ts`). The recorder now runs **continuously** for the whole session; "pause"/"resume" only toggle `softPausedRef`, which gates `ondataavailable` (paused chunks are dropped before forwarding, so they're excluded from IDB/transcription). Resume is a flag flip with no fragile native call to fail. The final audio is the non-paused chunks with a time gap where the pause was — which is the desired behavior (paused audio excluded). Verified that gapped audio still decodes at Sarvam (even a harsh mid-stream byte-drop returned a clean transcript), so excising the pause doesn't break the submit-time batch translate. Chunk indices stay contiguous (the soft-pause early-return happens before `chunkIdxRef` increments).

**Side effects (acceptable):** during a pause the mic stays active (chunks produced + dropped). Deepgram's WS may idle-close on a long pause and not reconnect (background engine only — the visible Sarvam codemix box is stateless REST per window and recovers automatically on resume).

**Verification plan:** V re-tests on iPhone Safari — record, pause, switch audio, resume; confirm the timer/transcript resume and the encounter submits with the paused section excluded.

---

## B14 — Marathi encounter: hallucinated English ad-copy heads the transcript & "English translation" (30 May 2026)

**Reported:** V, after a 5-min Marathi live-transcription test (`enc_g754qhq7z8`). Verbatim: *"the English translation is not in English, let alone is it a translation… definitely a big bug."*

**What V saw:** the "English translation" box opens with fluent nonsense — *"My podcast, honest answer speech… Introducing Orient Aero Silent… India's most silent BRDC fan…"* — and the whole encounter reads like a TV soap, not a consult. The generated medical note ("mother's post-surgery sleep disturbance / OSA") is meaningless.

**What actually happened (pulled the stored fields for `enc_g754qhq7z8` from the DB via the admin API + checked Vercel runtime logs):** this is **NOT a translation failure.**
- `detected_language = mr-IN`; the Sarvam live codemix won → `transcript_original` (3114 ch). Submit-time Sarvam **batch translate ran cleanly** (no `[process] batch-translate failed` in runtime logs) → `transcript_raw`/`transcript_clean` (3908 ch).
- The **body** of `transcript_raw` is a faithful English translation of the Marathi. Matched pairs: `मम्मी आली…लगेच जायची गरज नाही` → "Mom has come, there is no need to go there immediately"; `दिले 2 कॉम्पोस. 5 मिनिटात झोपली` → "I gave her two composts, she slept in five minutes" (Compose = the sedative); `काल त्यांनी तो scan काढला…रक्ताची गाठ वगैरे काही नाही` → "yesterday they took that scan… no blood clots or anything"; `Ram…Ravana…Jatayu…जखमी` → "just like Jatayu was injured in the battle between Ram and Ravan". **The translation engine is working.**
- **The audio was a played Marathi TV serial (V confirmed).** The Devanagari is scripted melodrama (saas-bahu conflict, hospitalised relative, Ram/Ravana/Jatayu, Bhagavad Gita, pension, a steam-engine metaphor) — hence the meaningless "medical" note: garbage in, garbage note.
- **The defect is the OPENING.** The serial began with what reads as a real English Orient "AeroSilent" fan TV ad — reproduced *near-identically by all three engines* (Deepgram, Whisper AND Sarvam: "Introducing Orient Aero(sol/Silent), reverse aero(dynamic/foil) plate design, India's most silent [P/B]RDC fan"). Three independent models agreeing on that specific ad copy is the signature of **real English audio at the head of the clip** (a TV ad / pre-roll), not pure hallucination — mixed with disjoint hallucinated filler ("Silly me, I thought. Friends. Say something. Technical."). That English opening:
  1. **leaked into the live transcript** because streaming connects on `language-code=unknown` and only **locks** to Marathi after a few utterances; the early English is captured before the lock, and the lock-swap *preserves* (does not retro-scrub) the accumulated transcript — see live-language-lock-fix `fa41130`; and
  2. **is carried verbatim into `transcript_raw`** (Sarvam batch keeps genuinely-English audio as English), so it heads the "English translation" box and reads as garbage on first glance even though the body is correctly translated.

**Root cause (the recordable bug):** there is **no no-speech / hallucination guard anywhere in the pipeline.** All engines — Whisper especially — emit confident fluent text on non-speech / foreign-intro / low-confidence audio, and that fabricated text flows verbatim into `transcript_raw` → the LLM note → the email. In real OPD use the trigger won't be a TV ad but **mic warm-up, a few seconds of ambient/waiting-room noise before the doctor speaks, or background TV** — any of which can inject fabricated content into a clinical note. Patient-safety / data-integrity gap, currently ungated.

**Severity:** P2. Not a translation failure, and not reproducible in this exact form without a TV playing — but the underlying ungated hallucination is a real clinical-safety gap for the pilot.

**Proposed fix (layered, highest value first):**
1. **Leading foreign-language trim.** When `detected_language` is a non-English Indic language, strip a *leading run of pure-English segments* (no Indic script U+0900–U+0DFF) that precedes the first Indic content, in both `transcript_original` and `transcript_raw`. Cheap; kills the visible symptom. MUST only trim a *leading pure-English run* — inline/codemix English mid-consult is legitimate and must be kept.
2. **No-speech / hallucination guard at the engines.** Whisper: drop segments by `no_speech_prob` / `avg_logprob` thresholds + `condition_on_previous_text=false` to stop loop hallucination. Sarvam/Deepgram: VAD-gate the windows (skip pure silence/noise; the PCM worklet can add an energy/VAD check before sending a window).
3. **Submit-time VAD head/tail trim** before the Sarvam batch translate, so warm-up silence/noise isn't transcribed at all.
4. **Known-hallucination blocklist** (stopgap): strip notorious ASR ghost-phrases / ad copy ("thanks for watching", "subscribe", "Orient … fan", …). Brittle; secondary.

**Also seen on this encounter (separate, not B14):** `diarize_status = failed` — track under the diarization items.

**Status:** ✅ CLOSED (30 May 2026) — fixed app-side AND source-side, both verified. App: tag `b14-transcript-guard-shipped` @ `eeaad21`, build green, all 6 services healthy. Source: V applied the Whisper no-speech/VAD guard on the Mac Mini (`uk.llmvinayminihome.whisper` relaunched with `--vad --vad-model …silero… --no-speech-thold 0.7 --suppress-nst`); independently confirmed from the sandbox — `whisper.llmvinayminihome.uk/healthz` `{"ok":true}` and a 3 s silence clip → `{"text":""}` (was `" Thank you."`). See `ETA-MAC-MINI-BACKEND-HANDOVER.md` §13 + `ETA-WHISPER-NOSPEECH-GUARD-MAC-MINI-TASK.md`. **Only follow-up left: V's device re-test with a clean Marathi consult (confidence check, not a fix dependency).**

**What shipped (app-side, live now):** new `lib/transcript-guard.ts` — two conservative, leading-anchored, bounded (≤700 chars / ≤8 sentences), length-floored passes: (1) `stripLeadingForeign` drops a leading pure-English run before the first Indic char for a non-English-Indic encounter (inline/code-mix English in the body preserved); (2) `stripLeadingNoise` drops leading sentences matching a curated hallucination/ad blocklist (thanks-for-watching/subscribe ghost phrases + the Orient-fan ad copy; "aerosol" deliberately NOT matched to protect pulmonology consults). A length floor (revert if >60 % removed or <40 chars left) guarantees a transcript can never be gutted. `process/route.ts` runs `guardTranscripts()` after `translateIfNeeded()` in **both** the streaming and non-streaming paths, cleaning `transcript_raw` (note source + `transcript_clean`), `transcript_original` (vernacular box), and trimming leading noise entries before `tagged_transcript`. Soft-fail — never blocks the encounter.

**Verified** by replicating the guard exactly against `enc_g754qhq7z8`'s real stored fields: English 3908→3713 ch (removed "My podcast…" + the two Orient/aerofoil/BRDC-fan sentences), original 3114→2820 ch (English ad lead-in removed, starts at the first Devanagari); consult body fully preserved (Jatayu / composts / scan / hospital all intact). Deliberately conservative, so some non-ad connective filler ("Honestly I love my defense… Sir fans will always be noisy") remains rather than risk clinical content — acceptable; the named-product ad copy that triggered the report is gone.

**Source-side guard (delivered, pending V on the Mac Mini):** `ETA-WHISPER-NOSPEECH-GUARD-MAC-MINI-TASK.md` — relaunch the Mac Mini `whisper.cpp` server with `--vad` (+ Silero VAD model) / `--no-speech-thold` / `--suppress-nst` so **silence/noise produces empty output instead of hallucinated text** at the source. Verification = a 5 s silence clip returns empty. Sandbox can't reach the LAN, so V applies it. (Sarvam's streaming engine already does server-side VAD, so the live multilingual path needed no client-side gate — that's why no worklet/live-capture change was shipped: low value, regression risk.)

**Remaining:** (1) V device re-test — record a clean Marathi consult (no TV), confirm the boxes read cleanly and the note is sane; (2) V applies the Whisper runbook on the Mac Mini → then B14 fully closed (app-side + source-side).

---

## B15 — Post-`DROP TABLE doctor` 500s: six `.tsx` page reads survived the S8 sweep (31 May 2026)

**Reported:** V, testing the admin view after the v2.0 `doctor`-table drop — clicking a clinician's name (the voice-sampling flow) 500'd.

**Root cause:** the V2.S8 read-sweep used `grep --include=*.ts`, which **excluded `.tsx`**, so six page-level `FROM/JOIN doctor` reads survived the `DROP TABLE doctor` (0015) and now hit a non-existent table: `app/[slug]/record` (CRITICAL), `app/[slug]/encounter/[id]`, `app/[slug]/recipients`, `app/[slug]/onboarding/voice`, `app/admin/doctors/[id]/voice` (the one V hit), `app/encounter/[id]`.

**Fix (`43063e7`):** switched all six `FROM/JOIN doctor` → `clinician`. Verified live: voice kiosk + clinician list + clinician detail + doctor `/record` all **200**.

**Lesson:** when sweeping reads across the app, glob `.ts` AND `.tsx` (and `.jsx`). A type-only grep silently misses page components.

---

## B16 — Build fail: duplicate `import { sql }` in admin clinician [id] route (31 May 2026)

**Reported:** the PIN-visibility commit `7fc0169` errored on the Vercel build (webpack "Identifier sql already declared") — `sql` was already imported at the top of `app/api/admin/doctors/[id]/route.ts`. **Prod safely held on the prior good sha** (failed build never deploys).

**Fix (`750e5e4`):** removed the duplicate import. PIN-visibility (`clinician.pin_plaintext`, migration 0016) then shipped clean.

**Related build-time holds during the STT Engine Lab sprint (all caught by Vercel, prod never broke):**
- **schema close-paren class (×2):** a Drizzle `pgTable` with NO index callback must close `});` not `}));` — slipped on `stt_engine` (0018, `b24f3c9`→`61bfb9c`) and `stt_lab_config` (0019, `8ac379c`→`5578b8d`).
- **`Button` not imported** in `SttLabClient.tsx` (L3, `22d4d7e`→`3f0bc7a`).
- **qwen judge silent no-op:** `lib/qwen.ts` read only `LLM_BASE_URL` (unset in prod) → judge never ran; fixed to fall back to `OLLAMA_BASE_URL` (`5088efb`).
- **Neon nested-fragment risk:** the leaderboard WHERE was rewritten from `sql` fragment composition (unsupported by the Neon HTTP driver) to value-param interpolation.

These are documented here so the patterns aren't re-hit next thread. See `ETA-CARRYOVER-PROMPT-31-MAY-2026.md` §5 (schema/Neon/qwen traps).

---

## B17 — STT Lab: EkaScribe never produced data (ASR `no_output_for_template`; scribe `template_failure`) (1 Jun 2026, FIXED)

**Reported:** V, from the STT Lab Leaderboard — EkaScribe v2 sat at composite 0, all metrics dashed, 0 successful runs, while the other 4 engines had 26 runs each. "Why is the EkaScribe API not being used?"

**Root cause — three layered issues (diagnosed by reproducing the raw eka.care `/voice/api/v3/status` response against the real ICU clip `enc_3ynb7acfzf` via a temporary `ekascribe-probe` endpoint):**
1. **Coverage:** EkaScribe was enabled at L7 *after* the 25-encounter backfill had already drained + been marked `done`. The per-encounter fan-out queue is idempotent, so EkaScribe was never run on the existing corpus — its only ASR run was 1 newer encounter, which failed.
2. **ASR tier impossible on this account:** `transcript_template` ("basic transcription") is **silently dropped** by eka.care for our account — a `200` returns only `clinical_notes_template` + `eka_emr_template`, never `transcript_template`. So `output.find(template_id==='transcript_template')` → `no_output_for_template`. EkaScribe cannot return a verbatim transcript here; it is a scribe, not raw ASR.
3. **Scribe tier broken too:** `generateNote()` requested `clinical_notes_template` **alone** → eka returns `206/status:failure` `"Template not found for id: clinical_notes_template"` (`llm_structring_failure`). The probe proved it **succeeds only when `eka_emr_template` is co-requested** in the same `init`.

**Fix (`stt-lab-complete`→ `9e66276` + `4725453`, migration 0023):**
- **Scribe-only** (V's decision, matches the 2-tier design): dropped `asr` from EkaScribe's `capabilities_json` (migration 0023) so the ASR fan-out/leaderboard no longer select it; deleted the stale failed ASR run; `transcribe()` now returns an explicit `asr_unsupported_on_account`.
- **Scribe co-request:** `generateNote()` now requests `[clinical_notes_template, eka_emr_template]` and extracts the clinical note; runJob refactored for multi-template + keeps polling on `206`-partial (env `EKASCRIBE_SCRIBE_COMPANION_TEMPLATE`, default `eka_emr_template`).
- Added a targeted per-encounter scribe trigger to the worker: `POST /api/admin/stt-lab/run-fanout {scribe:true, encounterId}`.
- Temporary `ekascribe-probe` endpoint added then removed (prod clean at `4725453`).

**Result:** EkaScribe scribe verified working on real clinical audio. Scribe leaderboard now populated — EkaScribe **ok 6, judge avg 6.33** (range 3–9 vs Even pipeline's reference ~9–10) across the real clinical clips; non-clinical test clips correctly yield `empty_output`.

**Two follow-ups surfaced:**
- **eka.care free session quota EXHAUSTED** — bulk runs hit `init_400 txn_limit_exceeded "You're out of free Eka Scribe sessions"`. Remaining encounters can't be processed until V tops up / upgrades the eka.care plan (same pattern as the ElevenLabs Rs.1000 top-up). The earlier `status_500`s were the quota starting to bite.
- **Pre-existing `scribePending` infinite-loop bug:** junk clips whose `note_json` renders empty (e.g. `enc_6nm357qgfx`) never get a `scored_at` done-marker (`scoreScribe` returns early on empty refText), so blind `scribePending` re-picks the same encounter forever and never advances. Worked around by driving via the targeted trigger; the loop itself is unfixed (flagged to V).

---

## B18 — iOS: `no_audio_chunks` on Submit for non-English (Kannada) consults (2 Jun 2026, FIXED — pending device retest)

**Reported:** V relayed from Dr. Ankit Bhojani (iPhone/Safari, evenscribe.app). Submit fails with red `no_audio_chunks`; **live Kannada transcript shows fine**. "Both morning consultations the same error; **yesterday did not have an issue**; third consult also failed — so it's an error **today only**."

**Server evidence:** Dr. Ankit's 2 encounters today (`enc_v3nu9fzxcb` 04:04Z, `enc_63uk24aguv` 04:13Z) are `status=draft`, `has_note=false`, `duration=None` — created but **no audio ever uploaded** (the client `no_audio_chunks` guard fires before `/upload-url`). Yesterday: 6/6 encounters `complete` with real durations (139–482s).

**Root cause (NOT a code regression — git shows nothing touched the recording path since before 31 May):** on **iOS/WebKit, MediaRecorder and a WebAudio worklet cannot both consume the same `getUserMedia` track**. The non-English **Sarvam *streaming*** path (`useSarvamStreaming`) does `AudioContext.createMediaStreamSource(micStream)` on the SAME track MediaRecorder is recording → the worklet starves MediaRecorder → `ondataavailable` never delivers data → `onChunk` (and thus `putChunk` → IndexedDB) never runs → IDB empty → `no_audio_chunks` on Submit. The live transcript still shows because it's fed by the worklet, not by chunks. **English consults are chunk-based (Deepgram `sendChunk`) = single consumer → unaffected (worked yesterday).** "Today only" = his consults today are Kannada (streaming active) and/or the Sarvam relay was healthy today (when the relay errors, the app already falls back to chunk-based rolling, which works); when the relay is up on iOS, the worklet runs and breaks capture.

**Fix (`d134ef0`, RecordingScreen only):** on iOS (`detectIOS()` — iPhone/iPad UA + iPadOS-as-Mac w/ touch), set `STREAMING=false` so the streaming worklet never starts; the app falls back to the existing **chunk-based Sarvam *rolling*** path (single consumer = MediaRecorder). Chunks then persist to IDB and Submit works. Desktop/Android keep true streaming (unchanged). Note quality is unaffected (the note is built from the full submitted audio, not the live transcript). **Build green, deployed. Device-verification pending Dr. Ankit re-testing a Kannada consult on his iPhone** (after a full reload to pick up the new bundle — watch for the service worker serving a stale cache).

**Immediate unblock offered:** use a non-iOS device (Android/desktop Chrome) — no WebKit dual-consumer limit there — or reload to the new build on the iPhone.

**Follow-up option (not done):** restore true streaming on iOS by giving the worklet a *cloned* audio track (`track.clone()`) so MediaRecorder keeps the original — deferred until the rolling-fallback fix is device-confirmed, since it can't be verified from the sandbox.

**UPDATE (2 Jun, same day) — the real root cause was different; `d134ef0` did NOT fix it.** After `d134ef0`, Dr. Ankit still got `no_audio_chunks` — but his screen now showed the debug line **"149 chunks · 4127.6 KB · 8 finals · audio/webm;codecs=opus"** and the address bar read **"evenscribe.app — Private"**. So MediaRecorder was recording fine all along (the worklet-starvation theory was wrong, or at most a second latent issue); the actual blocker is **iOS Safari Private Browsing, which disables/zeroes IndexedDB** — our chunk buffer. `putChunk` is fire-and-forget so it failed silently; the live transcript still showed (memory-fed); Submit found 0 persisted chunks → `no_audio_chunks`. "Today only" = he was in a Private tab today (yesterday's 6 were a normal tab). Lesson: the worklet diagnosis was made from incomplete evidence (assumed 0 chunks, never confirmed the on-screen count). `d134ef0` (iOS→rolling) is still a legitimate hardening and stays.

**Immediate unblock given to V:** open evenscribe.app in a **normal (non-Private) Safari tab**, or add to Home Screen and launch as a PWA.

**Durable fix SHIPPED `e884ca0` (build green, PENDING Dr-Ankit retest on a reloaded bundle):** **in-memory chunk failsafe** — `RecordingScreen` keeps every emitted chunk in a `chunksMemRef` buffer for the current encounter; `useEncounterSubmit` now reads IndexedDB *tolerantly* (a throw no longer aborts) and **falls back to the in-memory buffer** when IDB returns nothing. So Submit succeeds even when IndexedDB is dead (Private Browsing / storage disabled / full) — audio is no longer lost mid-session. Also added `chunk-store.probeIdbWritable()` + a **preflight warning** ("Local audio backup is blocked — likely Private Browsing…") so the clinician is told before the consult. Trade-off in Private mode: no cross-reload crash recovery (memory is per-session), but the consult's audio uploads fine. This is Sprint 1 of `ETA-AUDIO-FAILSAFE-PRD.md` (#2 preflight + the failsafe); #3 unified-capture and #4 server-side relay capture still pending.

---

## B19 — Proactive code audit (2 Jun 2026) — register of latent bugs found before they bite

Triggered by V after B18: three parallel reviewers swept the client recording pipeline, the server API/processing pipeline, and the STT-lab/admin/auth surface, hunting for the "silent failure / data-loss / unguarded-assumption" class. Findings below are deduped and severity-ranked; the headline P0s were re-verified by hand against the code. **Status (2 Jun, this session): the P0 RecoveryModal data-loss item is FIXED (`cbe9bfe`); a non-mutating prod smoke test (`scripts/smoke.mjs`, `npm run smoke`) + a silent-failure scanner (`scripts/check-silent-failures.mjs`) + a vitest unit suite (`tests/unit/`, run in CI via npx; `detectIOS`→`lib/platform.ts`) were added (repo HEAD `fdb68d6`). Security P0s are DEFERRED by V — parked here. The rest remain open.** Baseline before this session: CI ran lint+typecheck only; no tests existed.

> **UPDATE 2 Jun 2026 (later same day): the full non-security backlog is now SHIPPED.** Every P1 and P2 below (and the Tier 1–5 scoped items) is fixed and live — repo HEAD `1857130`, all commits built green, smoke 9/9, migrations 0024+0025 applied, `check:silent` now a hard CI gate. Per-item commit shas are annotated inline below and in `ETA-BACKLOG-SCOPED.md`. **Still PARKED (security, by V):** the 3 security P0s (seed-team auth, admin RBAC gates, finalize-upload key-binding) + admin-login lockout. Tier-4 items (#17/#18/#19) shipped **behind `NEXT_PUBLIC_*` flags default OFF** pending device-test — see `ETA-TIER4-FLAGS-DEVICE-TEST.md`.

### P0 — security / clinical data loss (fix first)

- **[confirmed] Unauthenticated super-admin creation + in-repo password** — `app/api/admin/admins/seed-team/route.ts:33`. The route's own comment says "NO auth gate"; `POST` (re)creates the three `@even.in` super-admins with the hard-coded password `<REDACTED>` (line 27, also in the repo + carryover). Anyone who can reach the URL can (re)create/keep a super-admin login. *Fix:* require an authenticated super-admin (or `ADMIN_TOKEN` bearer like `/bootstrap`); never embed plaintext; rotate the password.
- **[confirmed] Missing RBAC role gates on sensitive admin mutations** — `reset-pin` (`.../reset-pin/route.ts:43`), `rotate-url`, `voice-enroll`, doctors create/PATCH, `encounters/[id]/resend` (note exfiltration to any email), `recipients/*`, `r2-cors-fix`. These authenticate the cookie but never check role, while `engines/routing/gold/voice-retrain/voice-samples-delete` *do* gate `viewer`. So a read-only admin can reset PINs, rotate login URLs, enrol voiceprints, disable doctors, resend clinical notes to arbitrary recipients, and rewrite the R2 CORS policy. *Fix:* a shared `requireAdminRole([...])` helper on every mutating route (`reset-pin`/`rotate-url`/`r2-cors-fix` → `super`).
- **[confirmed] `finalize-upload` doesn't bind the R2 key to the encounter** — `app/[slug]/api/encounters/[id]/finalize-upload/route.ts:87`. Only checks `key.startsWith("encounters/")`, not that it equals this encounter's key. A client can set encounter A's `audio_object_key` to *any* `encounters/…` object (another patient's audio) → downstream note/diarization/voiceprint process the wrong audio under A's identity. *Fix:* require `body.key` to match `audioObjectKey(id, …)` (or at least the `encounters/<id>.` prefix).
- **[confirmed] Recovered audio after a tab reload can only be Discarded → clinical audio loss** — `components/RecoveryModal.tsx:133` + `RecordingScreen.tsx:432`. The Submit button is gated on `chunksCount > 0` (in-memory state, resets on reload) and `chunksMemRef` is also memory-only; the durable copy in IndexedDB is real but the recovery UI only offers **Discard** ("Submit-from-recovered-audio lands in the next sprint"). A mid-consult reload (iOS memory pressure / accidental swipe) thus strands the audio with the only action being to lose it. **Direct sibling of B18.** *Fix:* wire RecoveryModal "Keep"→ the existing `getChunksForEncounter` + submit flow. **✅ FIXED `cbe9bfe`:** RecoveryModal now has a per-row **Submit** that uploads recovered audio via the new `lib/submit-from-store.ts` (read IDB → upload-url → R2 PUT → finalize → process), then navigates to the encounter. Additive (live submit path untouched). Pending V/device retest.

### P1 — real bugs / reliability

- **[confirmed] Deepgram live has NO reconnect** — `lib/use-deepgram-live.ts:176-189` (vs Sarvam streaming's backoff). A WS blip on an English consult silently stops the live English transcript (and truncates `deepgram_transcript`); only the pill shows it. *Fix:* add reconnect-with-backoff + re-mint token. **✅ FIXED `9dab463` (flag `NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT`, default OFF, pending device-test):** hoisted `connect()`/`scheduleReconnect()`, exp backoff 1/2/4/8s max 5, token re-mint on abnormal close, reset on open; no-op when flag off.
- **[confirmed] Unbounded in-memory chunk buffers** — `use-whisper-rolling.ts:65`, `use-sarvam-rolling.ts:63`, `use-speaker-identify.ts:25` each retain every 250ms blob for the whole consult (4+ full audio copies in heap incl. IDB + `chunksMemRef`). Long consults on low-RAM iPhones → memory pressure → the reload that triggers the P0 above. *Fix:* trim consumed chunks past each hook's watermark. **✅ FIXED `9dab463` (flag `NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS`, default OFF, pending device-test):** whisper/sarvam-rolling drop consumed chunks via a `baseRef` offset after the watermark; speaker-identify caps its tail (`SPK_MAX_CHUNKS=120`). Canonical upload copies (IDB + `chunksMemRef`) untouched.
- **[confirmed] `getUserMedia` uses a hard `sampleRate: 16000` constraint** — `use-media-recorder.ts:85`. Exact (not `ideal`) → `OverconstrainedError` on mics that can't open at 16 kHz → recording never starts, cryptic error. *Fix:* drop it or make it `{ ideal: 16000 }`. **✅ FIXED `9d4e86d`** (shipped as the Playwright-e2e byproduct: `sampleRate`/`channelCount` exact → `{ ideal }`).
- **[confirmed] Duplicate emails on /send retry** — `app/[slug]/api/encounters/[id]/send/route.ts:113-118,164`. No `send_status='sent'` guard; Resend `Idempotency-Key` is a fresh `seId` per attempt → double-click / retry-after-timeout sends the note to every recipient again. *Fix:* stable idempotency key (`enc.id + email`) + already-sent guard. **✅ FIXED `b9fde47`:** send route skips a recipient already sent in the last 90s (`deduped:true`); deliberate resends past the window + the admin resend route are unaffected.
- **[confirmed] Resend webhook: terminal status downgraded + no replay window** — `app/api/webhooks/resend/route.ts:96-122,24-57`. An `opened` event arriving after `bounced` overwrites it; and there's no `svix-timestamp` freshness check (captured webhook replayable forever). *Fix:* guard status transitions (`WHERE status NOT IN ('bounced','complained','failed')`) + reject `|now − ts| > 5 min`. **✅ FIXED `b9fde47`:** negative terminal status (bounced/complained/failed) is now sticky vs late delivered/opened (open ts still recorded via COALESCE); rejects `svix-timestamp` >5 min as replay.
- **[confirmed] `sarvamBatchTranslate` fetches have no per-request timeout** — `lib/sarvam.ts:151-213` (7 fetches incl. the full-audio Azure PUT + download). Only the poll loop is bounded; a hung PUT/download stalls `/process` until `maxDuration=300`. *Fix:* `AbortSignal.timeout(...)` on each + forward `opts.signal`. **✅ FIXED `53039a8`:** all 7 batch fetches go through `tfetch()` (caller signal + per-request deadline: control 20s / transfer 60s / poll 15s); a slow status poll retries instead of aborting the job.
- **[confirmed] Daily STT budget cap is a no-op** — `lib/stt/fanout.ts:131-148`. `todaySpendUsd()` sums `cost_usd`, but every adapter returns `costUsd: null`/`0`, so `allowPaid` is always true and the `$5/day` cap can never pause paid engines. *Fix:* compute `cost_usd = cost_per_min_usd × duration` at insert, or gate on run-count. **✅ FIXED `f9ecb18`:** `estimateCostUsd()` fills `cost_usd` at insert (adapter cost, else cost_per_min×duration, else conservative default for an unpriced PAID engine; free=0) so spend accrues and the cap binds.
- **[confirmed] `drainFanout` queue claim is not atomic** — `lib/stt/fanout.ts:151-162`. Unconditionally resets ALL `running→pending` then selects without `FOR UPDATE SKIP LOCKED`; concurrent `after()` hook + manual drain double-process (the root cause `dedupRuns()` cleans up). Scoring/judge double-runs. *Fix:* atomic claim + only reclaim stale-`running`. **✅ FIXED `f9ecb18` (+ migration 0025):** single `UPDATE … WHERE encounter_id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`; reclaims only stale `running` (`started_at` > 5 min/null). Verified live on Neon HTTP.
- **[confirmed, known] `scribePending` infinite loop — two trigger paths** — `lib/stt/fanout.ts:316` + `lib/stt/scoring.ts:301-311`. `scoreScribe` returns early without a done-marker when the reference note renders empty or there are no scored rows → the encounter is re-selected on every drain forever. *Fix:* stamp a done-marker on all return paths (or decouple the predicate from `scored_at`). **✅ FIXED `f9ecb18`:** `scoreScribe` now calls `markScribeDone()` (stamps `scored_at` + `scribe_skip`) on the empty-reference and no-candidate-rows early returns.
- **[latent] Encounter can get stuck in `processing`** — `finalize-upload:199` + `process:107`. If `/process` hard-crashes before any persist, the row stays `processing` and `upload-url`/`finalize` require `draft`; only a client retry recovers, no server reaper. *Fix:* sweep stale `processing` → `failed`/`draft_partial`. **✅ FIXED `595d16c` (+ hourly Vercel cron `4390fdd`):** new `POST/GET /api/admin/reap-stuck` sweeps `processing` beyond N min (default 30) → `draft_partial` if a note exists else `failed`, + system audit_log. Verified live (reaped a real 7-day-stuck encounter).
- **[latent] Desktop Safari streaming starvation (B18 class, not yet live)** — `RecordingScreen.tsx:28`. `detectIOS()` misses desktop Safari on non-touch Macs; if `NEXT_PUBLIC_STT_RELAY_URL` is enabled there, the worklet shares the mic track with MediaRecorder again. Latent while REST rolling is the default. *Fix:* gate streaming off for all WebKit, or `track.clone()` the worklet input. **✅ FIXED `9dab463` (flag `NEXT_PUBLIC_ETA_SAFARI_STREAMING_GUARD`, default OFF, pending device-test):** new pure+tested `detectDesktopSafari()` extends the iOS worklet-skip to desktop Safari.

### P2 — robustness / cleanup
- `AbortSignal.timeout` unguarded → preflight mislabels healthy backend on Safari < 16 (`PreflightCheck.tsx:58`). **✅ FIXED `78a5eb6`** (`timeoutSignal()` feature-detect + AbortController fallback).
- Deepgram pre-open queue evicts the WebM header chunk first (`use-deepgram-live.ts:226`). **✅ FIXED `78a5eb6`** (cap evicts oldest *non-header* via `splice(1,1)`).
- PINs from `Math.random()` not `crypto.randomInt` (`doctors/route.ts:105`, `reset-pin:34`). **✅ FIXED `0f40743`** (`crypto.randomInt`).
- Admin login has no lockout/rate-limit (doctor PINs do) (`admin/login/route.ts`). **⏸ PARKED (security-adjacent) by V.**
- `scoreScribe`/`scoreEncounter` stamp `scored_at` even when the judge is unavailable → marked "scored" with null score, never retried (`scoring.ts`). **◐ PARTIAL:** `scoreScribe` early-return loop closed in `f9ecb18` (#11); the scoreEncounter judge-unavailable-still-stamped nuance is unchanged (low impact — re-score via `rescore`).
- `extractCriticalTerms` failure swallowed → term component silently drops from the composite (`scoring.ts:192`). **✅ FIXED `0f40743`** (returns `model:"extract_failed"` instead of silently "none").
- `db-neon-http.ts:5` eager `DATABASE_URL!` at import (vs lazy `lib/db.ts`). **✅ FIXED `0f40743`** (lazy Proxy accessor).
- Whisper rolling-buffer R2 read-modify-write race (ephemeral) (`whisper-chunk/route.ts:113`). **✅ FIXED `53039a8`** (transient R2 read → fresh buffer, no mid-consult hard-fail).
- Submitted-then-purge-failed encounters reappear in RecoveryModal (`use-encounter-submit.ts:213`). **✅ FIXED `78a5eb6`** (`markEncounterSubmitted()` sentinel written before purge; `listEncounterSummaries()` filters it).
- `voice_sample` passive capture lacks a unique `(clinician_id, source_encounter_id)` index (`migration 0017`). **✅ FIXED `0f40743`** (migration 0024, partial unique index where source='passive').

### Verified-clean (no action) — recorded so they're not re-flagged
Service worker is network-first for navigations + `/api/` with killswitch + cache-version purge (no stale-bundle risk). NDJSON `sawDone` swallow is a correct iOS workaround that re-throws real mid-stream errors. `run-migrations` dollar-quote splitter + per-migration transaction are sound and idempotent. Email template HTML-escapes all user/LLM content. `/process` is idempotent with per-step persist, partial-note preservation, and timeouts on all LLM/HTTP calls. No nested `sql` fragment composition anywhere (Neon-safe). PIN-login requires the URL-embedded token. `scorePending`/`resolveRouting` terminate safely.

---

## B20 — Admin "Audio" tab stuck on "Loading audio…" (2 Jun 2026, FIXED)

**Reported:** V (screenshot) right after the admin encounter-audio play/download feature shipped (`97b2dc5`). The new **Audio** tab on `/admin/encounters/[id]` showed "Loading audio…" forever; the player never appeared.

**Root cause (client effect, not server):** the lazy fetch effect listed `audioLoading`/`audioInfo` in its dependency array AND toggled `audioLoading` inside itself. So `setAudioLoading(true)` re-ran the effect; the previous run's cleanup set `cancelled = true`; the in-flight request's result was then discarded in the `if (cancelled) return` guard — so `audioInfo`/`audioErr`/`audioLoading=false` were never applied and the spinner stuck. (The request itself was completing fine; the server `audio-url` endpoint was healthy.)

**Fix (`6fd5b64`):** replaced the cancel-on-rerun pattern with an `audioReqRef` guard keyed by `encounterId` (no cleanup-cancel), deps reduced to `[activeTab, data, encounterId]`; on error the ref resets so reopening the tab retries. Verified: build green, endpoint 401 unauth (no presigned-URL leak), smoke 9/9. Authed playback PENDING V visual check.

**Lesson:** never put a loading/result state in an effect's deps when the effect toggles that same state and uses a cleanup-cancel — it self-cancels. Use a ref guard instead.

---

## 2 Jun 2026 — session features shipped (not bugs; logged for context)

Reliability backlog complete (all 20 non-security items, Tiers 1–5 — see `ETA-BACKLOG-SCOPED.md`) + new admin surfaces: **/buglog** (this page, auth-gated, repo-sourced), **encounter Audio play/download** tab, **Admins management** (add + reset password; `seed-team` retired), and a **System Map** module. Full handoff: `ETA-CARRYOVER-PROMPT-2-JUN-2026.md`. The B19 register above is annotated with per-item FIX shas; the only OPEN security items are the 3 parked P0s (RBAC gates, finalize-upload key-binding, admin-login lockout) + the shared-password risk.

---

## B21 — CI had NEVER actually run: failed at "Setup Node" on every run since creation (6 Jun 2026, FIXED)

**Found:** 6 Jun 2026, while dispatching the mic-denied e2e's first run.

**Symptom:** Every `CI` workflow run in the repo's history (back through the 2 Jun hardening sprint) was red. Failure was at the **Setup Node** step — before install/typecheck/tests — so the "hard CI gates" (vitest unit suite, `check:silent` swallow-handler gate) had **never once executed in CI**. The Tier-5 claim "check:silent is now a hard CI gate at baseline 0" was true in the workflow file but vacuous in practice.

**Root cause (three stacked, all lockfile-related):** the repo has **never had a `package-lock.json`** (no commit in history ever added one — Vercel builds with `npm install`, not `npm ci`).
1. `actions/setup-node@v4` with `cache: "npm"` hard-errors when no lockfile exists ("Dependencies lock file is not found").
2. Next step `npm ci` would also have failed for the same reason.
3. Once those were fixed, two more latent failures surfaced because the later steps were finally reached for the first time: `next lint` exits 1 (no ESLint config exists — it prompts interactively), and bare `npx vitest@^2 run` can't resolve `vitest/config` from `vitest.config.ts` (vitest lives in the npx cache, not `node_modules`).

**Fix (3 commits, 6 Jun):** `6bb3deb` drop the npm cache + `npm ci` → `npm install --no-audit --no-fund`; `c6ff5fa` drop the configless `next lint` step (typecheck is the real gate, matching the Vercel build); `6fcd2c8` install vitest ephemerally in the job (`npm i -D vitest@^2` then `npx vitest run` — the same pattern e2e.yml uses for Playwright). **CI is now green end-to-end for the first time**: typecheck → vitest (3 suites) → check:silent all really run. E2E was unaffected (its workflow never used the npm cache); its dispatched run incl. the mic-denied spec's first execution passed 3/3.

**Lesson:** a gate that has never been seen green is not a gate. When adding a CI step, watch its first run actually pass before calling it a gate.

---

## 6 Jun 2026 — session changes (not bugs; logged for context)

- **Tier-4 flag #17 ACTIVATED for device-test:** `NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS=1` set in Vercel (Production+Preview) and baked into the live bundle. #18/#19 to follow one at a time after V's device test passes.
- **EkaScribe RETIRED (V: too expensive), ElevenLabs showcased instead:** migration `0026` disables the `ekascribe` engine row (adapter code + API path + row all kept — reversible from the Engines tab). New composite scribe-tier engine **`elevenlabs_scribe`** (`lib/stt/adapters/elevenlabs-scribe.ts`): ElevenLabs Scribe v2 ASR → the SAME Even note-gen LLM → note, rubric-scored vs `even_pipeline` — so the scribe leaderboard isolates the ASR as the only variable. Fanned out across all encounters with note+audio (2 junk/silent clips correctly errored `asr: empty_transcript`). `runScribeForEncounter` now passes `encounter.note_type` as the template hint; new worker mode `{scribe:true, missing:true}` fills a newly added scribe engine on already-scored encounters (and counts errored attempts as attempted — avoids the B17-style junk-clip loop).
- **eka.care `txn_limit_exceeded` RESOLVED** (credits now linked: auth + presigned + full scribe job all worked) — moot for spend now that EkaScribe is disabled, but the account works if ever re-enabled.

---

## B22 — Dr Ankit (weak signal): live `http_413 FUNCTION_PAYLOAD_TOO_LARGE` + `FetchEvent.respondWith ... Load failed` (6 Jun 2026, FIXED)

**Reporter:** V, relaying Dr Ankit Bhojani — two recurring errors on his device (both screenshots show 2 bars of cellular).

### (1) Live transcript: `Sarvam: http_413: Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE`
**Symptom:** mid-recording (footer "~162 chunks · ~4500 KB"), the live transcript box turns red with the 413; once it starts it never recovers for the rest of the consult.

**Root cause:** `lib/use-sarvam-rolling.ts` sends the **entire uncommitted span** (`chunks[watermark..end]`, header prepended) to `/{slug}/api/transcribe/sarvam-live`, a Vercel serverless function. Vercel caps function request bodies at ~4.5 MB (`FUNCTION_PAYLOAD_TOO_LARGE`). The span only committed — advancing the watermark and resetting the window — when Sarvam returned a **non-empty** tail **and** the span reached ≥ `COMMIT_CHUNKS` (~88). So on sustained silence/empty tails, or on iOS Safari (which ignores the 250 ms `timeslice` and emits large ~1 s chunks), the window grew past 4.5 MB → 413. And because the watermark hadn't advanced, **every subsequent tick re-sent an even larger window → permanent wedge** (the recurring errors). The 4.5 MB cap is a Vercel platform limit on serverless request bodies and can't be raised by route config, so the fix must be client-side.

**Fix (`52bb906`):** bound the window by **bytes** — `MAX_WINDOW_BYTES = 3.5 MB`; walk back from the newest chunk keeping only what fits, sliding the effective start forward (drops the oldest *uncommitted* live audio only). And **commit on chunk-count OR a forced size-advance, no longer gated on a non-empty tail**, so silence can't grow the span without bound and a 413 can't recur. Tail text is appended only when present. The submitted **note is unaffected** — it's always built from the full uploaded audio, never the live tail.

### (2) Encounter page: `FetchEvent.respondWith received an error: Load failed`
**Symptom:** opening an encounter (status Processing) shows a red "Processing problem" card with this text + a Retry button.

**Root cause:** `public/sw.js` static-asset branch ended in `.catch(() => cached)`. On a **cache miss + network failure** (weak signal, asset not yet cached), `cached` is `undefined`, so `respondWith(undefined)` — the browser surfaces the cryptic "received an error: Load failed" and crashes the request instead of letting it fail like a normal (retryable) fetch.

**Fix (`52bb906`):** `.catch(() => cached || Response.error())` — returns a real network-error Response so the request fails normally and is retryable; bumped `SHELL_CACHE` v2 → v3 (forces the new SW to activate; old caches purged on activate). Navigation and `/api/` branches were already safe (they always return a Response).

**Verified:** build green, live `52bb906`, `npm run smoke` 9/9, served `/sw.js` is v3, CI green. **PENDING-V device retest on Dr Ankit's phone:** (a) a long consult no longer 413s the live box; (b) opening an encounter on weak signal degrades gracefully (Retry) instead of the SW error. Note: Dr Ankit must reload once so SW v3 activates.

### (3) FOLLOW-UP (6 Jun, `f669150`) — the SW `Load failed` recurred on a NEW encounter (`enc_wy3bjj44kz`, hi-IN, weak signal)
The v3 cache-miss fix wasn't the whole story. Opening an encounter still in `processing` **auto-fires the long streaming `POST /process`** (30-90s NDJSON: translate → diarize → note-gen → CDMSS RAG). On a 1-bar connection that stream drops, and **the SW was intercepting the `/api/` POST and proxying the stream** — so Safari attributed the mid-stream drop to the SW and surfaced the same `FetchEvent.respondWith received an error: Load failed`. The `/api/` branch's `.catch()` only catches the INITIAL fetch rejection (pre-headers), never a mid-stream body failure; and SW-proxied streams can truncate on Safari. The client then showed it as a hard "Processing problem" even though `/process` is **idempotent** and the server **persists the note regardless of whether the client keeps reading** — so retrying re-ran the whole expensive pipeline for nothing. (Reaper dry-run confirmed `stuck_count=0`, i.e. not a server wedge — purely a client/SW streaming-resilience issue.)

**Fix (`f669150`):**
- `public/sw.js`: **bypass ALL non-GET requests** (`if (e.request.method !== 'GET') return;`). `/process`, `/send`, `/note` are never cacheable and need no offline fallback, so they now run directly — the page's own AbortController + error handling work natively and a dropped stream is a normal, retryable fetch error, not an SW crash. SHELL_CACHE v3 → **v4**. (GET `/api/` keeps its offline-503 fallback for Library/encounter polling.)
- `components/encounter/EncounterDetailClient.tsx`: on a `/process` stream error that is a **network drop** (not a user Cancel), **auto-retry once** (idempotent `/process` returns the persisted note if the server already finished); if it drops again, show a calm, accurate message — *"Connection interrupted — your note may still be processing. Tap Retry to check."* — instead of the raw `Load failed`. Bounded to exactly one auto-retry per user attempt (`netRetriedRef`).

**Verified:** build green, live `f669150`, `npm run smoke` 9/9, served `/sw.js` is **v4** with the non-GET bypass, CI green. **PENDING-V (Dr Ankit, must reload ONCE for SW v4):** open a processing encounter on weak signal → it should auto-retry and either show the note or a calm "connection interrupted" message, never the `FetchEvent.respondWith` error.
