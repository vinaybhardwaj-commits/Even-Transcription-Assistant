# Even Transcription Assistant — PRD v1.0 (FINAL — design complete, ready for build)

**Last updated:** Tue 26 May 2026
**Status:** All 16 product decisions locked (§4) · §5 open questions resolved · §6 data model + §7 API contract specified · §8 UX delivered in Figma · §9 sprint plan + §10 success criteria defined.
**Figma file:** [Even Encounter Assistant — v1](https://www.figma.com/design/1MwbnF1HubCOyTEIn7EM5U) (Cover · Design System · Mobile · Doctor app · Admin · Desktop · Email template · Flows)

**Owner:** Dr Vinay Bhardwaj
**Date:** 26 May 2026
**Status:** Draft v0.1 — feature spec from V locked in §4; open decisions in §5 being worked through one-by-one before scope freeze
**Predecessor doc:** `EVEN-TRANSCRIPTION-ASSISTANT-SOURCE-CATALOG.md` v0.2 (the source-code inventory and extraction plan)

---

## 1. Summary

The **Even Transcription Assistant** is a mobile-first web app for doctors to record patient encounters end-to-end. The doctor opens their personal app link on their phone, enters a 4-digit PIN, and taps a single button to record. The dictation is transcribed live on screen with filler words removed in real time. The doctor can pause, resume, edit the live transcript, and submit. On submit, the cleaned transcript is processed by LLMs into a structured **Medical Encounter Note** (reason for visit, history, comorbidities, exam, vitals, disposition, prescription, suggestions, referrals). A second LLM layer grounded in the existing **CDMSS knowledge base** (304k MKSAP/StatPearls/UpToDate/OpenFDA/PubMed chunks) adds investigation / treatment / referral / follow-up suggestions. The final outputs are emailed via Resend to the participating doctor(s). Doctors are onboarded by an administrator; each gets a unique landing URL they save on their phone.

## 2. Problem statement / why this exists

[**TBD — V to provide.** Placeholder: voice dictation matches the natural pace of clinical thinking; manual note-writing breaks that flow; existing dictation tools either don't structure the output or aren't grounded in clinical evidence. The Transcription Assistant aims to capture the encounter at the speed of speech, return a structured note and a grounded analysis layer, and deliver both to the doctor's inbox in under five minutes from "End recording" to "Email sent".]

## 3. Scope

### 3.1 In scope (v1)
- Mobile-first web client (PWA-ready), recording on the doctor's own phone via browser MediaRecorder
- Live transcription with filler-removed real-time display, dual-engine (Deepgram + Whisper)
- Single recording button: Record / Pause / Unpause / End
- Live editable transcript before submit
- LLM-driven structuring of submitted transcript into a Medical Encounter Note
- CDMSS-grounded LLM analysis layer (investigation / treatment / referral / follow-up suggestions)
- Email delivery of transcript + note + analysis via Resend
- Doctor onboarding via admin panel (name + email + 4-digit PIN)
- Per-doctor unique landing URLs
- LLM trace panel + completion bar + heartbeats during processing (ported wholesale from OPD/CDMSS)

### 3.2 Out of scope (v1 — deferred to v2+)
- Standalone "voice notes" (short-form dictation outside the encounter context)
- Integration with OPD-Encounter-App as a recording source
- ICD-10 extraction with KB-cited evidence
- Coach mode (Socratic teaching on past encounters)
- Clinical calculators inside the app (eGFR / NEWS2 / ABG / hyponatremia / sepsis)
- qwen-vision OCR of photographed paper notes
- Patient-side outputs (anything sent to patients directly)
- Multi-hospital tenancy
- Cross-language transcription / translation (English only v1)
- HIS / EHR write-back (KareXpert, etc.)
- Self-service doctor signup (admin-onboarding only)
- Password / magic-link auth (PIN only)

## 4. Locked decisions (from V's feature spec, 26 May 2026)

### 4.1 Form factor and client
Mobile-first PWA. Uses the phone's native microphone via the browser's MediaRecorder API. Installable to home screen (PWA manifest + service worker — patterns lifted verbatim from `Even-CDMSS/public/`). Standalone display, portrait orientation. Tablet renders acceptably; **desktop is reserved for the admin surface only**.

### 4.2 Live transcription with real-time cleanup

The doctor's dictation is transcribed and shown on screen as they speak. Filler words ("uh", "um", false starts, repeated words) are removed in real time. The transcription is cleaned up — sentence-level reformulation, capitalization, punctuation, medical-term casing — in real time. Both Deepgram and Whisper are available.

**Technical strategy: Hybrid live (Deepgram streaming + Whisper rolling chunks) — Q1 locked 26 May 2026.**

Pipeline:
1. **Live path (Deepgram)** — Browser opens a WebSocket through the backend to Deepgram's streaming API. Doctor sees text appear in real time (~300ms latency from speech). On each Deepgram `is_final` utterance, the backend fires a fast `llama3.1:8b` cleanup pass (~200-300ms) that returns the cleaned version, which replaces the raw utterance in the live transcript.
2. **Rolling polish path (Whisper)** — In parallel, the recording is chunked every 15 seconds and POSTed to the Mac Mini `whisper.cpp` server. When each Whisper chunk lands (~1-2s after the chunk closes), the corresponding span in the displayed transcript is silently swapped for the Whisper-cleaned version. The swap is suppressed if the doctor is actively editing that span (focus/typing detection) — queued and applied on next un-focus.
3. **End state** — by the time the doctor taps End, all but the last ~15 seconds of audio is already at Whisper quality. The final chunk processes in 1-2s. The edit view opens essentially instantly with the polished transcript.

Failure handling:
- Whisper chunk fails → silent retry once → if still fails, the span stays at Deepgram-cleaned quality (still good, doctor never knows; the failure is logged to the trace dashboard).
- Deepgram WebSocket drops → reconnect with exponential backoff, audio buffer locally; Whisper rolling continues independently so the transcript still progresses.
- Mid-edit Whisper swap → suppressed; visual indicator (200ms gentle highlight that fades) shows where a swap was deferred for later.

**Cleanup level: Level 3 — filler removal + punctuation + sentence reformulation. Q2 locked 26 May 2026.**

The live cleanup pass (per-utterance `llama3.1:8b` call, ~200-300ms budget) applies these transformations:

1. **Remove filler:** "uh", "um", "er", "you know", "like" (when used as filler), repeated words, false starts, dangling self-corrections.
2. **Add punctuation + capitalization:** periods, commas, question marks where Deepgram missed them; capitalize sentence starts, proper nouns, and medical abbreviations (HbA1c, BP, CKD, etc.).
3. **Restructure spoken grammar into clean written sentences.** Example: *"the patient she is um 34 and uh she has chest pain"* → *"The patient is a 34-year-old female with chest pain."*

**Safety rail — preserve medical content exactly:** the cleanup prompt explicitly requires the LLM to preserve **all numeric values, drug names, dosages, lab values, vital signs, and medical abbreviations exactly as transcribed.** No substitutions, no autocorrection, no inference from context. Heavier medical formatting (e.g. "BP 120 over 80" → "BP 120/80 mmHg", drug-dose normalization) is deferred to the Submit-time note-generation pipeline where critique+revise can catch errors.

**Cleanup applies at both live-Deepgram and Whisper-rolling layers** — every utterance gets one cleanup pass, whether from the Deepgram live stream or a Whisper rolling chunk. Identical prompt; identical safety rail.

### 4.3 Recording controls and editable transcript
The mobile UI is dominated by a single recording button with four states:
- **Record** — start a new encounter (begins audio capture + live transcription)
- **Pause** — suspend audio capture; the live transcript freezes
- **Unpause** — resume audio capture and live transcription where it left off
- **End** — stop recording entirely; transcript becomes editable in a finalize / review view

**Editability: anytime, including during active recording — Q3 locked 26 May 2026.**

The transcript is always editable, in every state (recording, paused, ended). The doctor can tap into the transcript and correct words at any time. New utterances always append at the bottom (no conflict with edits earlier in the text). Whisper rolling-chunk swaps near the doctor's cursor are suppressed per the §4.2 conflict handling.

Two specific UI rails support this without confusing the doctor:
- **Always-visible recording indicator** — while the microphone is capturing, a small pulsing red dot is visible in the top bar near the record button. Doctor can see at a glance that audio is still being captured even while they're editing.
- **No autocorrect / no autosuggest** on the transcript field — `autocomplete="off"`, `spellcheck="false"`, `autocapitalize="off"`, `data-gramm="false"` (Grammarly off). Medical terminology fights with phone keyboards; the doctor's edits must be exactly what they type.

On **Submit** (from the finalize view), the LLM pipeline kicks in: the **completion bar**, the **trace panel**, and the **heartbeat indicators** (ported from `Even-CDMSS/components/TracePanel.tsx` + `OPD-Encounter-App/src/components/llm-trace/*`) show real-time progress through the structuring + analysis stages.

### 4.4 Medical Encounter Note structure
The submitted, cleaned transcript is processed by an LLM into a structured **Medical Encounter Note** with at minimum these sections:
1. Reason for visit
2. Medical history
3. Comorbidities
4. Medical examination
5. Vitals (if dictated)
6. Disposition
7. Prescription
8. Suggestions
9. Referrals

Exact field schema, ordering, allowed-empty rules, and structured-vs-prose representation per field are open decisions (§5 Q5).

### 4.5 CDMSS-grounded analysis layer
The entire transcribed encounter is also analyzed by an LLM grounded in the **CDMSS knowledge base** (`KB_DATABASE_URL` — 304,399 chunks across MKSAP 19, StatPearls 8,981 articles, UpToDate 21.3 partial, OpenFDA, PubMed; embedding via `nomic-embed-text`; HyDE rewriter via `llama3.1:8b`; draft via `qwen2.5:14b`).

The analysis covers four dimensions:
1. **Investigation suggestions** — labs, imaging, procedures the doctor may want to consider
2. **Treatment suggestions** — medications, interventions, monitoring
3. **Referral suggestions** — specialties, urgency, indications
4. **Follow-up suggestions** — timeline, what to assess, red-flag triggers

Uses the existing CDMSS retrieval architecture (vector + BM25 RRF fusion, with the D12.2 `bm25Query` narrow-the-query pattern). Exact pipeline depth (which subset of the 8-stage CDMSS pipeline runs here), presentation, and placement relative to the note are open decisions (§5 Q6, Q7).

### 4.6 Email delivery via Resend
On submit-and-finalize, the app emails the participating doctor(s) the following artifacts:
- Cleaned transcript
- Medical Encounter Note (structured)
- CDMSS analysis layer

Sender configured via `RESEND_API_KEY` + `RESEND_FROM_EMAIL`. Recipient email list managed via the admin panel. Full timing/recipient/format details locked in §4.13.

### 4.7 Doctor onboarding via admin panel + per-doctor URLs + 4-digit PIN
- Doctors are onboarded by an administrator through the admin panel.
- Each new doctor: admin enters their **name** + **email** + **sets a 4-digit PIN** during registration.
- When a doctor is added, the admin panel **generates a unique landing URL** for that doctor. URL format is an open decision (§5 Q9).
- The doctor saves their personal URL on their phone (browser bookmark or "Add to Home Screen" PWA install).
- The doctor visits their URL, enters their 4-digit PIN, and lands directly in the recording UI.
- No password resets or magic links in v1. PIN reset is admin-only. PIN security model (session length, lockout, etc.) is an open decision (§5 Q10).

### 4.8 Patient identification

**Approach: Hybrid — optional pre-recording label + LLM extraction at Submit. Q4 locked 26 May 2026.**

Two complementary sources populate patient-identifying fields on each encounter:

1. **Optional pre-recording label.** On the home screen, above the Record button, a single text field is present: *"Patient (optional) — e.g. Sarah, 34F, chest pain f/u"*. The doctor may type a short label or skip it entirely. The Record button is always enabled. The label is stored as `patient_label TEXT NULL` on the encounter row.

2. **LLM-extracted structured fields at Submit.** During the Submit-time pipeline (the same pass that produces the Medical Encounter Note), the LLM extracts the following from the transcript as structured fields on the encounter row:
   - `patient_name_extracted TEXT NULL` — full name if mentioned in the dictation
   - `patient_age_extracted INTEGER NULL`
   - `patient_sex_extracted TEXT NULL` — 'M' | 'F' | 'O' | NULL
   - `chief_complaint_extracted TEXT NULL` — one-line summary

These extracted fields cost no additional LLM call — they're added to the existing structured-output prompt for the encounter note.

**Display precedence:** the doctor's manual `patient_label` (if provided) is shown verbatim as the encounter title in email subjects and the library. If the label is empty, the display falls back to a composed title from the extracted fields: e.g. *"Sarah Acharya, 34F — chest pain"*. If both are empty (no label, no extraction), the title falls back to a timestamp: *"Encounter — 10:23 AM, 26 May"*.

**Downstream use:** structured `patient_age_extracted` and `patient_sex_extracted` are also passed into the CDMSS analysis prompt so age/sex-relevant chunks are preferentially retrieved. No structured patient registry / Patients table in v1 — these fields live on the encounter row, not in a shared patients table. (Multi-encounter-per-patient linking is a v2 decision.)

**UI rail:** the patient-label field must look visibly optional — placeholder text only, no asterisk, no "required" indicator. The Record button is enabled regardless of whether the field has content.

### 4.9 Encounter persistence and library

**Approach: Minimal library — list + view + re-send, no editing. Q5 locked 26 May 2026.**

Every submitted encounter is persisted to the new Neon Postgres DB (audio blob → Vercel Blob; transcript + note + analysis → encounter row). In addition to the email delivery, the doctor has access to an in-app library:

**Library list view:**
- Accessible from a tab/icon in the doctor's app shell (not the recording home)
- List of all submitted encounters belonging to this doctor, newest first
- Each card shows: encounter title (per §4.8 display precedence), chief complaint, timestamp, duration, send status
- Tap a card → opens the encounter detail view

**Encounter detail view (read-only):**
- Full cleaned transcript
- Medical Encounter Note (structured display per §4.10 schema — TBD Q6)
- CDMSS analysis layer
- Trace ID + "View trace" link
- **Re-send button** — opens the recipient picker, defaults to the participating doctor list from admin panel, allows ad-hoc additions, sends fresh email via Resend

**Out of scope for v1 (deferred):**
- Editing past encounters (note, analysis, or transcript). The doctor's review pass happens BEFORE Submit, at the finalize view (§4.3). Post-submit edits are v2+ scope (requires versioning + audit + stale-email handling).
- Draft mode (save partial encounter pre-submit). The background/foreground handling described below covers the common interruption case.
- Search across past encounters (v2; could be free-text against transcript + note + label).
- Sharing encounters between doctors / handoff.

**Background/foreground handling (orthogonal — applies regardless of v1 scope):**
- App backgrounded mid-recording → audio capture auto-pauses, state persists to local storage
- App foregrounded → restore state; doctor can resume or end
- Phone locks or browser tab hidden → same as background
- Catastrophic crash → on next open, an "Unfinished encounter from [time]" recovery card offers resume-or-discard

**Library card design (sketch, to be properly designed in Figma):**
```
┌─────────────────────────────────────────┐
│  Sarah Acharya, 34F                     │
│  chest pain f/u                         │
│  10:23 AM · today · 12 min              │
│                          ✓ Sent · ⓘ ↗   │
└─────────────────────────────────────────┘
```

### 4.10 Medical Encounter Note — schema and generation pipeline

**Approach: Mixed prose + structured schema, draft+critique+revise pipeline. Q6 locked 26 May 2026.**

The submitted, cleaned transcript is processed into a structured Medical Encounter Note. Narrative sections are prose strings; clinical-data sections (vitals, prescription, referrals, comorbidities) are structured objects/arrays so they can be validated, rendered as tables in the email, and consumed by downstream features.

**Schema (locked):**

```typescript
type MedicalEncounterNote = {
  // Narrative sections — prose strings
  reason_for_visit: string;        // 1-3 sentences
  medical_history: string;         // PMH, surgical, social, family woven in
  medical_examination: string;     // physical exam findings as prose
  disposition: string;             // where the patient goes next
  suggestions: string;             // doctor's verbal suggestions to the patient

  // Structured clinical data
  comorbidities: string[];         // ["T2DM", "HTN", "CKD G3a"]
  vitals: {
    bp?: string;                   // "120/80 mmHg"
    hr?: number;                   // bpm
    rr?: number;                   // breaths/min
    temp?: string;                 // "37.1 °C"
    spo2?: number;                 // %
    weight_kg?: number;
    height_cm?: number;
    other?: string;                // free-form for anything else dictated
  } | null;                        // null if no vitals dictated
  prescription: Array<{
    drug: string;                  // "Metformin"
    dose: string;                  // "500 mg"
    route: string;                 // "PO" | "IV" | "SC" | "IM" | "topical" | …
    frequency: string;             // "BD" | "TDS" | "HS" | "PRN" | …
    duration: string;              // "30 days" | "until next visit" | …
    notes?: string;                // "take with food"
  }>;
  referrals: Array<{
    specialty: string;             // "Cardiology"
    urgency: string;               // "routine" | "urgent" | "stat"
    indication: string;            // "for ECG and stress test"
  }>;
};
```

**Empty-section policy:** every field is allowed to be empty (`""`, `[]`, or `null`). The LLM is explicitly instructed NOT to fabricate content for sections the doctor didn't address. The email and library renderer omits empty sections rather than rendering "(none)" placeholders.

**Generation pipeline — draft + critique + revise:**

1. **Draft (qwen2.5:14b, streaming).** Receives the cleaned transcript + patient_label + (extracted patient demographics from Q4 §4.8) + the schema spec. Emits the full JSON note. Prompt explicitly forbids hallucinating drug doses, vital values, or any clinical content not present in the transcript. Uses double-quote discipline (CDMSS anti-pattern memory).
2. **Critique (qwen2.5:7b).** Receives the transcript + the drafted note. Audits for: (a) hallucinated drug names/doses, (b) vital values that weren't dictated, (c) findings attributed to the patient but not actually said, (d) missing sections that the doctor clearly addressed, (e) drug-route or frequency errors. Emits a JSON list of flagged issues with severity.
3. **Revise (qwen2.5:7b).** Receives the transcript + drafted note + critique flags. Applies fixes for flagged issues. Outputs the final note.

Implemented using the `tracedChat` wrapper (lifted from `Even-CDMSS/lib/trace.ts`) so every stage writes a forensic `trace_events` row. The TracePanel renders three stages with heartbeats: *Drafting → Reviewing → Revising → Done*.

**Estimated wall time:** 20-40 seconds for a typical 5-15 minute encounter. Acceptable Submit-then-wait budget; matches the CDMSS /ask experience the user base already knows.

**Field-extraction co-output:** in the same `Draft` call, the LLM also emits the patient-identification fields locked in §4.8 (`patient_name_extracted`, `patient_age_extracted`, `patient_sex_extracted`, `chief_complaint_extracted`). No separate LLM call for these — they're additional fields in the schema. The critique pass also validates these.

### 4.11 CDMSS analysis pipeline — depth and schema

**Approach: Standard CDMSS pipeline + critique + revise, fired in parallel with the note pipeline. Q7 locked 26 May 2026.**

The CDMSS-grounded analysis is a **separate artifact** from the encounter note. The note structures the doctor's own words; the analysis surfaces clinical decision support grounded in the 304k-chunk knowledge base.

**Pipeline (7 stages, fires in parallel with §4.10 note pipeline on Submit):**

1. **HyDE expansion** — `llama3.1:8b` rewrites the encounter context (chief complaint + extracted demographics + comorbidities) as a dense textbook-style paragraph for embedding. Uses the existing `Even-CDMSS/lib/expand.ts` prompt verbatim.
2. **Multi-query variants** — `llama3.1:8b` generates 4 query angles, one per dimension (investigation / treatment / referral / follow-up).
3. **Hybrid retrieval per variant** — vector cosine (`mxbai-embed-large` against `KB_DATABASE_URL`) + BM25 with the `bm25Query` narrow-query pattern (high-IDF terms: chief complaint keywords, drug names mentioned, condition names) per the D12.2 lesson. RRF fusion (k=60) per variant.
4. **Fused chunk pool** — top-N chunks across all 4 variants, deduped, with source-quality weighting.
5. **Draft** — `qwen2.5:14b` (streaming) generates the full 4-dimensional analysis with citations to chunk IDs. Prompt explicitly forbids suggestions not grounded in retrieved chunks.
6. **Critique** — `qwen2.5:7b` audits: (a) every suggestion has at least one valid chunk citation, (b) no hallucinated drug doses, (c) no follow-up timelines or referral urgencies not supported by retrieved evidence, (d) age/sex appropriateness, (e) `citation-check.ts` pattern strips any chunk_id not in the actually-retrieved set.
7. **Revise** — `qwen2.5:7b` applies critique fixes; outputs the final analysis.

**Parallel firing with note pipeline:**

```
Submit ──┬── Note pipeline (draft → critique → revise) ────┐
         │                                                  ├── both ready ──→ assemble email + persist
         └── CDMSS pipeline (HyDE → ...→ critique → revise) ┘
```

Total wall time = `max(note_pipeline, cdmss_pipeline)` ≈ 40-60s for typical encounters. TracePanel shows two pipelines side by side with independent progress bars.

**Schema (locked):**

```typescript
type CdmssAnalysis = {
  investigation_suggestions: Array<{
    suggestion: string;        // "Consider HbA1c, fasting lipid panel, urine ACR"
    rationale: string;         // "Given new T2DM diagnosis at 34y; assess macro/microvascular risk"
    citations: number[];       // chunk_ids from the KB
  }>;
  treatment_suggestions: Array<{
    suggestion: string;
    rationale: string;
    citations: number[];
  }>;
  referral_suggestions: Array<{
    suggestion: string;
    rationale: string;
    urgency?: string;          // "routine" | "urgent" | "stat"
    citations: number[];
  }>;
  followup_suggestions: Array<{
    suggestion: string;
    rationale: string;
    timeline?: string;         // "3 months" | "6 weeks" | …
    citations: number[];
  }>;
};
```

**Empty dimensions allowed.** A simple URTI follow-up may legitimately have nothing in `referral_suggestions`. Email and library renderers omit empty dimensions rather than showing "(none)" placeholders.

**Citation rendering:** in email, citations appear as numbered superscripts `[1] [2]` with a "References" footer listing source + book + page. In the library detail view, citations are tap-to-expand (preview of the chunk text inline). Implements the `citation-check.ts` hallucination guard from `Even-CDMSS/lib/calculators/citation-check.ts`.

**Infrastructure lifted:** `lib/expand.ts`, `lib/retrieve.ts`, `lib/stream.ts`, `lib/trace.ts`, `lib/ndjson-client.ts`, `lib/calculators/citation-check.ts` — all from `Even-CDMSS` per the Source Catalog v0.2 §10.4.

### 4.12 Visual hierarchy and artifact placement

**Approach: Sequential below the note, visually distinct "Clinical Decision Support" card, collapsed transcript at the bottom. Q8 locked 26 May 2026.**

The three artifacts (note, analysis, transcript) render in this fixed vertical order across **all three surfaces** — the email, the library detail view, and any printable export:

```
┌─ HEADER ────────────────────────────────────────────┐
│  [Patient label or extracted title]                 │
│  Recorded by Dr X · 10:23 AM, 26 May · 12 min       │
│  Note + 4 clinical suggestions · Trace [abc12345]   │
└─────────────────────────────────────────────────────┘

┌─ MEDICAL ENCOUNTER NOTE ────────────────────────────┐
│  Reason for visit                                   │
│  Medical history                                    │
│  Comorbidities  ·  [T2DM] [HTN] [CKD G3a]           │
│  Vitals  ·  BP 120/80 · HR 78 · …                   │
│  Medical examination                                │
│  Disposition                                        │
│  Prescription                                       │
│  ┌─ Drug ──── Dose ── Route ── Freq ── Duration ─┐ │
│  │ Metformin  500mg   PO       BD       30 days  │ │
│  │ ...                                             │ │
│  └────────────────────────────────────────────────┘ │
│  Suggestions  (doctor's verbal advice)              │
│  Referrals                                          │
└─────────────────────────────────────────────────────┘

┌─ CLINICAL DECISION SUPPORT ───── (CDMSS-grounded) ──┐  ← visually distinct
│  [violet-tinted background; ✨ icon]                │     accent (matches OPD v4
│                                                     │     "AI" color convention)
│  Investigation suggestions                          │
│  • suggestion [1] [2]                               │
│    rationale                                        │
│  • ...                                              │
│                                                     │
│  Treatment suggestions                              │
│  • ...                                              │
│                                                     │
│  Referral suggestions                               │
│  • ...                                              │
│                                                     │
│  Follow-up suggestions                              │
│  • ...                                              │
│                                                     │
│  References                                         │
│  [1] MKSAP 19 · Endocrinology · p.142               │
│  [2] StatPearls · Diabetes management · 2024        │
│  [3] UpToDate · ASCVD risk assessment               │
└─────────────────────────────────────────────────────┘

▶ Show transcript (12 min, 1,847 words)  ← collapsed by default
```

**Authorship boundary rules:**

- The note section uses the standard typography of doctor-authored content (no AI accent color, no ✨ icon, no "generated by" subtitle).
- The Clinical Decision Support card uses the violet accent and ✨ icon (the AI color from OPD v4 — keeps the visual language consistent across V's apps). Subtitle reads *"Generated from CDMSS knowledge base · 304k clinical chunks · for your consideration"* — makes the authorship unambiguous.
- The transcript is collapsed by default with a one-line preview ("12 min, 1,847 words") — it's available for audit but the doctor doesn't need to read it once they trust the note.

**Header callout:** the encounter header explicitly mentions both artifacts ("Note + 4 clinical suggestions") so a doctor skimming their email doesn't miss the CDS card below the note. Empty dimensions reduce the count ("Note + 3 clinical suggestions" if `referral_suggestions` is empty).

**Citation rendering details:**
- Email: superscript [1] [2] inline with suggestions; numbered "References" footer with source + book + page.
- Library detail view: same superscripts, but tap-to-expand inline chunk preview (no leaving the page).
- Citations hyperlink to the library detail view if rendered outside the app (so an email recipient can click through if they have library access).

### 4.13 Email delivery policy

**Approach: Auto-send on Submit completion + admin-managed global CC list + per-encounter override. Q9 locked 26 May 2026.**

**Recipient model — interpretation (b) locked.** The admin-panel doctor list is a **directory** (used for picking CCs), not a "everyone gets every encounter" inbox. Each recording doctor receives their own encounters by default. CCs are explicit.

**Recipients per encounter:**

1. **Recording doctor** (always; their email from admin profile). Cannot be removed.
2. **Admin-managed global CC list** — emails configured once in the admin panel that get CC'd on every encounter. Use case: V wants visibility into all RMO encounters → V's email lives on the global CC list. Admin can add/remove entries at any time; changes apply prospectively only.
3. **Per-encounter override** — at the finalize/review view (before Submit), an optional "+ Add CC" affordance lets the doctor add ad-hoc emails for THIS encounter only. They can also remove a default-CC for THIS encounter (e.g., "this one's a sensitive case, drop V's CC"). Default state: empty/no override.

**Timing — auto-send on pipeline completion.**

```
Doctor taps Submit
     │
     ├──── Note pipeline (Q6) ──┐
     │                          ├── both ready ──→ assemble HTML → send via Resend → mark library row 'sent'
     └──── CDMSS pipeline (Q7) ─┘
```

The doctor's intent at Submit is "commit and ship." No additional confirmation step. While pipelines run, the TracePanel shows progress; on completion the email goes out automatically and the library row updates to status `sent`.

**Format — HTML email only for v1. PDF attachment deferred to v2.**

The styled artifacts from §4.12 (prescription table, Clinical Decision Support violet card, citation footnotes) require HTML to render properly. PDF generation adds a rendering pipeline (puppeteer or pdf-lib templates) + styling decisions + storage in Vercel Blob — not blocking for v1. Doctors who need a PDF artifact can print-to-PDF from their email client.

**Email subject line format:**

```
[Patient label OR extracted title] — [chief complaint]
```

Examples:
- Doctor provided label: `Sarah Acharya, 34F — chest pain f/u`
- Only extraction available: `Sarah Acharya, 34F — chest pain`
- No label, no extraction: `Encounter — 10:23 AM, 26 May 2026`

**Send-failure handling:**
- Resend API returns error → encounter saved in library with `send_status = 'failed'`; error message logged to `trace_events`
- Library card shows a "Retry send" button instead of "Sent" badge
- Doctor can re-attempt from the library via the Re-send button (Q5 lock; opens recipient picker, defaults to original recipients, doctor can adjust)
- After 3 consecutive automatic retries (60s, 5min, 30min later) the encounter is marked `send_status = 'failed_permanent'` and only manual re-send is available

**Audit:** every send attempt writes a row to a `send_events` table — `(encounter_id, attempted_at, recipients, status, resend_message_id, error_message)`. Used by the admin panel to surface delivery problems.

**Resend infrastructure:**
- Env vars: `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (e.g., `transcripts@eta.llmvinayminihome.uk`)
- Tagged sends: every email includes Resend tags `app=eta`, `doctor=<doctor_id>`, `encounter=<encounter_id>` for delivery analytics

### 4.14 Per-doctor URL format

**Approach: Slug + short token (`/dr-vinay-7k3p`). Q10 locked 26 May 2026.**

Each doctor gets a unique landing URL constructed from a readable name slug plus a short random token:

```
https://eta.llmvinayminihome.uk/dr-vinay-7k3p
                   └─slug─┘ └token┘
```

**Slug generation (at admin onboarding):**
- Format: `dr-{firstname-lowercased}-{lastname-lowercased}` (hyphens replace spaces, non-ASCII normalized)
- Collision handling: append `-2`, `-3`, etc. on collision (`dr-john-smith`, `dr-john-smith-2`)
- Slug is stable across the doctor's lifetime (rotating it would break the doctor's bookmark)

**Token generation:**
- 4 chars from a URL-safe alphabet excluding ambiguous characters (`0`, `O`, `l`, `1`, `I`) — uses the 32-char alphabet `abcdefghjkmnpqrstuvwxyz23456789`
- ~20 bits of entropy (~1 million combinations)
- Generated via `crypto.randomBytes(3).toString('base64url').slice(0, 4)` then ambiguous-char filtering
- Rotatable: admin can regenerate the token (preserving the slug) if compromise is suspected; doctor's old URL 404s, new URL is emailed to them

**Database:** `doctors` table has `url_slug TEXT UNIQUE NOT NULL` storing the full path component (e.g. `dr-vinay-7k3p`).

**Admin panel affordances on each doctor profile card:**
- Display the full URL with a "Copy URL" button
- "Email URL to doctor" button — sends an onboarding/recovery email via Resend with the doctor's URL + PIN reset instructions
- "Rotate URL token" button — regenerates the 4-char token, keeps the slug, triggers an email to the doctor with the new URL

**Probe-proofing rail:** when an unknown URL is hit (e.g., `eta.llmvinayminihome.uk/dr-fake-name-zzzz`), the server returns a real HTTP 404 indistinguishable from a typo. **Never** a "Doctor not found, did you mean..." message — that would leak the doctor directory.

**Why slug + short token:** the 4-digit PIN (10,000 combinations) is the security boundary by design. With rate limiting (Q11 TBD), brute force is bounded. But pure slug URLs (`/dr-vinay-bhardwaj`) are enumerable — attackers can guess common-name slugs and parallel-attack PINs across many discovered login pages. Token entropy on top means an attacker can't even find a valid login page without knowing both the slug and the token (~20 bits × however many doctors). Combined floor is significantly higher than either alone, without sacrificing the readability that makes the URL useful as an identifier.

### 4.15 PIN security model

**Approach: 30-day session, no idle re-prompt, escalating lockout, admin-mediated reset. Q11 locked 26 May 2026.**

**PIN storage:** stored as a **bcrypt hash** on the `doctors` row. Admin can SET or RESET the PIN via the admin panel (input → hashed on save) but cannot display the existing PIN. Even admin can't look up a doctor's current PIN — only set a new one.

**Session token:**
- Signed JWT (HS256) via the `jose` library (lifted verbatim from `OPD-Encounter-App/src/lib/auth.ts`)
- Cookie name: `eta_session`
- Payload: `{ doctor_id, slug, iat, exp }`
- Set on successful PIN entry

**Cookie attributes:**
- `HttpOnly` — no JS access
- `Secure` — HTTPS only
- `SameSite=Strict` — CSRF prevention
- `Path=/{slug}-{token}/` — scoped to the doctor's URL prefix; cookies from one doctor's URL don't apply to another's
- `Max-Age=30 days` (2,592,000 seconds)
- **Rolling renewal** — every authenticated request resets the expiry. A doctor using the app daily stays logged in indefinitely; a doctor away for 31 days re-enters their PIN once.

**No idle re-prompt.** The phone's own lock screen is the primary device-level defense. The app PIN is the secondary boundary. Re-prompting mid-session adds friction without meaningfully improving security in the realistic clinic workflow (constant context switches between patient, phone, EMR).

**Lockout escalation:**

Stored on the `doctors` row: `failed_pin_attempts INTEGER DEFAULT 0`, `locked_until TIMESTAMPTZ NULL`. Counter resets on successful PIN entry.

| Attempts | Action |
|---|---|
| 1-4 | Counter increments, no lockout |
| 5 | `locked_until = NOW() + 15 min` |
| 10 | `locked_until = NOW() + 1 hour` + email alert to admin |
| 20 | `locked_until = NOW() + 24 hour` + escalated email alert to admin |
| 30 | Account flagged for admin review; login disabled until admin re-enables |

While locked, the PIN screen shows: *"Too many incorrect attempts. Try again in [N] minutes, or contact your administrator."* Server enforces lockout regardless of what the client shows.

**Admin PIN reset flow:**

1. Admin opens the doctor profile in the admin panel
2. Clicks "Reset PIN"
3. Inputs a new 4-digit PIN
4. On save: bcrypt-hashed, stored; `failed_pin_attempts` and `locked_until` cleared
5. Optional "Email new PIN to doctor" checkbox — sends the doctor an email via Resend with their new PIN (this is the recovery channel; admin and doctor coordinate verbally or in person at first)

**Optional manual lock affordance:** the app's settings menu has a "Lock app" button that clears the session cookie immediately. Useful if the doctor hands the phone to someone briefly or wants to step away from a shared device.

**Rate-limit defense in depth (server-side):** the PIN-verify endpoint applies per-slug rate limiting (max 1 attempt per second, max 60 per hour) on top of the `failed_pin_attempts` counter, defending against an attacker who tries to script around the lockout via fast requests.

### 4.16 Admin panel scope

**Approach: Standard + operational controls. Q12 locked 26 May 2026.**

**Admin authentication model:**
- Admin lives at a non-discoverable URL: `eta.llmvinayminihome.uk/{ADMIN_BASE_PATH}/` where `ADMIN_BASE_PATH` is a 32-char URL-safe random string set as a Vercel env var
- Probes to `/admin`, `/dashboard`, `/cms`, `/wp-admin`, `/.env` etc. return real HTTP 404
- Authentication: single shared `ADMIN_TOKEN` env var via the `lib/admin-gate.ts` Bearer-or-query-param pattern lifted verbatim from `Even-CDMSS`. Header `Authorization: Bearer <token>` OR query `?token=<token>` on first hit; session cookie scoped to admin path after that.
- Single admin in v1 (V). Multi-admin roles, per-admin auth, audit log of admin actions — all deferred to v2.

**Admin panel surfaces (locked):**

```
/{ADMIN_BASE_PATH}/
├── /                              Admin home — top-line counts:
│                                   - active doctors
│                                   - encounters today / this week
│                                   - failed sends pending retry
│                                   - locked-out doctors
│                                   - LLM error rate (24h)
│
├── /doctors                       Doctor list with filter (active/disabled) and search
│   ├── /doctors/new               Add doctor — fields: name, email, PIN, optional notes
│   └── /doctors/{id}              Doctor profile — edit fields, "Reset PIN", "Rotate URL token",
│                                   "Email URL to doctor", "Unlock account" (clears
│                                   failed_pin_attempts + locked_until), "Force logout"
│                                   (revokes all active sessions), "Disable" (soft delete)
│
├── /encounters                    All encounters (across all doctors) with filters:
│                                   doctor, date range, send status (sent / failed / pending)
│   └── /encounters/{id}           Read-only encounter detail (transcript + note + analysis + trace)
│                                   with action affordances: "Retry send" (re-fires Resend),
│                                   "View trace" (deep link to forensic page), "Delete encounter"
│                                   (with confirm modal — purges audio + transcript + note + analysis)
│
├── /traces                        LLM trace dashboard — direct port from
│                                   OPD-Encounter-App/src/app/llm/dashboard/page.tsx.
│                                   Per-surface aggregates: count, errored_count, p50_ms, p90_ms
│                                   via percentile_cont. Surfaces: note-pipeline, cdmss-analysis,
│                                   transcribe-compare, cleanup-live, cleanup-rolling.
│   └── /traces/{trace_id}         Forensic detail — every event, every prompt, every response.
│                                   Direct port from OPD `/llm/trace/[id]/page.tsx`.
│
├── /sends                         Send-events log:
│                                   - Per-recipient delivery rate
│                                   - Bounce/complaint rate per domain
│                                   - List of failed sends with retry buttons
│                                   - Resend API status indicator
│
└── /settings
    ├── /settings/global-cc        Manage global CC list (added/removed emails;
    │                                  changes apply prospectively per §4.13 Q9)
    ├── /settings/retention        Audio retention policy controls (per Q13 — defers to Tier E)
    ├── /settings/resend           Resend config (from-address read-only;
    │                                  sandbox/production toggle)
    └── /settings/health           Health probes (DB, LLM tunnel, Whisper tunnel, KB) —
                                      same shape as `/api/health` but human-readable
```

**Implementation note:** the trace dashboard and forensic detail pages are direct lifts from `OPD-Encounter-App/src/app/llm/dashboard/page.tsx` + `OPD-Encounter-App/src/app/llm/trace/[id]/page.tsx` (per Source Catalog v0.2 §10.9). The encounter list/detail follows the doctor's library pattern (§4.9) with additional admin actions. Estimated 3-4 sprints to ship the full admin surface; the doctor-facing CRUD subset (just `/doctors/*`) is 1 sprint and unblocks doctor onboarding for early pilots.

### 4.17 Audio retention policy

**Approach: Keep audio indefinitely (no automatic purge). Default-yes doctor delete privilege. Q13 locked 26 May 2026.**

Every encounter's raw audio file (typically 5-50 MB for 5-30 minute recordings, stored in Vercel Blob) is retained **indefinitely**. There is no daily cron purge in v1.

**Rationale:**
- Maximum debugging window for early-stage operations — V can audit any historical encounter for transcription quality, re-run pipelines with improved prompts, etc.
- Maximum future utility — audio + corrected transcripts are the training corpus if Even Hospital ever fine-tunes a Whisper variant on its specific accent + medical vocabulary
- Audit ground truth — for any dispute about what was said, the audio is canonical

**Cost trajectory (transparency, not a recommendation to revisit):**
- At ~50 MB/encounter × 30 encounters/day = 1.5 GB/day per active doctor
- ≈ 550 GB/year per active doctor
- At Vercel Blob storage pricing (~$0.15/GB-month, subject to change), annual storage accretion is ~$80/year/doctor by year-end
- Acceptable at v1 pilot scale (1-2 doctors); admin can graduate to a time-based retention policy in v2 (§4.16 `/settings/retention` is reserved for this) if scale changes the calculus

**Default-yes doctor delete privilege (privacy escape hatch):**

Even with no automatic purge, individual encounters need a deletion path for legitimate cases — doctor recorded the wrong patient, patient withdrew consent post-hoc, accidental capture of private conversation, etc.

- The doctor's library detail view has a "Delete encounter" button
- Tap → confirm modal: *"This permanently deletes the audio, transcript, note, analysis, and removes the encounter from your library. The deletion will be logged for audit. This cannot be undone."*
- On confirm: set `deleted_at = NOW()`, null `transcript`, `note_json`, `analysis_json`, `audio_blob_url` (Blob deleted immediately via API). Encounter row stays.
- Doctor's library: encounter disappears. Email already sent stays in inbox (we can't reach into Gmail).
- Admin's `/encounters?include_deleted=true` view: shows tombstone with `deleted_at`, `deleted_by_doctor`, and no content (content is gone).
- `send_events` and `trace_events` rows for this encounter are retained (audit trail of "this encounter existed and was deleted" is itself useful audit data).

**Admin delete:** also available from admin encounter detail view, with the same tombstone pattern. Difference: admin tombstone marked `deleted_by_admin`.

**No automatic purge of any artifact in v1:** audio, transcript, note, analysis, traces, send_events — all retained indefinitely. The only deletions are explicit (doctor-initiated or admin-initiated).

### 4.18 Offline behavior

**Approach: Pre-flight check at recording start + dropout tolerance during recording + queue-submit-on-reconnect. Q14 locked 26 May 2026.**

The app requires online connectivity to **start** a recording, then tolerates intermittent network blips during recording, and queues the Submit pipelines if the device is offline at Submit time. Full offline-first capture (record-with-no-network-at-all) is deferred to v2.

**Pre-flight check (at "tap Record"):**

```
Doctor taps Record
     │
     ├──→ fetch GET /api/health/ping (2s timeout)
     │     │
     │     ├─ 200 OK → start recording (Deepgram WebSocket opens, MediaRecorder begins)
     │     │
     │     └─ timeout / network error → modal:
     │            "You're offline. Recording requires an internet connection.
     │             Please reconnect to start."
     │             [Try again]  [Cancel]
```

The `/api/health/ping` endpoint is the cheapest possible — returns `{ ok: true, ts: <unix> }` with no DB call.

**Mid-recording dropouts (graceful degradation, leveraging §4.2 reconnection logic):**

- **Deepgram WebSocket drops** → exponential-backoff reconnect (1s, 2s, 4s, 8s, max 30s). Audio capture continues via MediaRecorder locally during the drop. Live transcript shows a small "Reconnecting…" indicator next to the recording dot. On reconnect, Deepgram resumes from the audio buffer.
- **Whisper rolling chunk upload fails** → silent retry once after 2s. If still fails, the span stays at Deepgram-cleaned quality (the failure is logged to the trace dashboard; the doctor never sees it).
- **LLM tunnel unreachable (cleanup pass)** → the per-utterance live cleanup is skipped for that utterance (raw Deepgram text remains). Whisper rolling chunks still attempt to land later when tunnel returns.
- The recording dot pulses red throughout — the doctor knows audio capture is uninterrupted even if other things are degraded.

**End/Submit while offline:**

- If connectivity is healthy at Submit, pipelines fire normally per §4.10 + §4.11
- If offline at Submit:
  - Encounter enters `pending_submit` state in IndexedDB (with full transcript + edits)
  - Submit button label changes to: *"Will submit when reconnected"*
  - App polls connectivity every 30s (via the same `/api/health/ping`)
  - On reconnect: pipelines fire automatically; doctor receives a notification ("Encounter for [patient label] is processing")
  - On completion: encounter appears in library with normal status; email goes out

**Service Worker scope:**

- Registered for PWA capability (manifest + service worker lifted from `Even-CDMSS/public/sw.js` per Source Catalog §10.4)
- Caches app shell (HTML, CSS, JS, icons) for fast subsequent loads
- Does NOT aggressively cache API responses in v1 (no stale-data risk)
- The `pending_submit` state lives in IndexedDB (managed by the React app), not the Service Worker cache

**What v1 does NOT support (v2 backlog):**

- Recording without any network connectivity (fully offline capture)
- Background sync of audio chunks via Service Worker
- Recording on cellular while the LLM tunnel is unreachable but Deepgram is reachable (partial-connectivity tolerance — currently treated as degraded experience, not a distinct mode)

### 4.19 Patient consent UX

**Approach: No in-app consent gate. Doctor handles consent outside the app per clinic policy. Q15 locked 26 May 2026.**

The app does NOT present a per-recording consent affirmation. The doctor is responsible for obtaining patient consent outside the app via:
- Clinic-level signed consent forms covering data processing (including audio recording for clinical documentation), OR
- Verbal consent obtained as part of the routine encounter intake, OR
- Whatever consent process Even Hospital has in place for clinical recording

The app makes no in-app claim about consent status. There is no `consent_confirmed_at` column on the encounter row. The home screen has only the patient-label field (§4.8) and the Record button — no consent checkbox between them.

**Rationale (V's choice):**
- Even Hospital's clinic-level processes are the source of consent truth — duplicating that as a per-encounter app affirmation would be redundant friction
- Doctor-driven app: the doctor is the medical-ethics authority for each encounter, not the app
- Lowest possible friction at the "tap Record" moment matches V's design priority (mobile-first, frictionless capture)

**Operational rails (still in v1, even without an in-app gate):**

- **Doctor onboarding paperwork (admin responsibility):** when admin adds a new doctor via the admin panel, V/admin ensures the doctor is briefed on Even Hospital's consent policy and that their clinic workflow obtains patient consent before recording. This is process, not code.
- **Doctor-initiated deletion** is the recovery path if a patient withdraws consent post-hoc — covered by the default-yes doctor-delete privilege locked in §4.17.
- **Privacy notice in app:** the doctor's PIN-entry screen has a small footer line: *"By recording, you confirm patient consent has been obtained per your clinic's policy."* This is informational, not a gate — it nudges without blocking.

**Reversibility:** if V later decides per-encounter affirmation is needed (e.g., regulatory pressure, expansion beyond Even Hospital, doctor feedback), adding the checkbox UI + `consent_confirmed_at` column is a small change. The schema is forward-compatible (NULL means "no in-app confirmation captured," which is the v1 default).

### 4.20 Compliance posture

**Approach: Defer formal compliance work to v2+. Ship product first; formalize when stakeholders ask. Q16 locked 26 May 2026.**

v1 ships without compliance-specific instrumentation beyond the security primitives already locked. No admin audit log, no privacy page, no breach response runbook, no DPDP-formal documentation. The focus is product velocity to first pilot.

**What v1 still has by virtue of other locks (compliance-relevant primitives exist even without formal framing):**

- Bcrypt-hashed PINs (§4.15)
- HTTPS + scoped `HttpOnly` / `Secure` / `SameSite=Strict` cookies (§4.15)
- Doctor- and admin-initiated deletion with tombstone audit (§4.17)
- Probe-proof 404s for unknown URLs (§4.14)
- Resend `send_events` audit table (§4.13)
- LLM `trace_events` table from CDMSS — forensic log of every model call (§4.11)
- Admin-only access to encounter content (§4.16)
- Single shared `ADMIN_TOKEN` env-var auth — appropriate at v1 single-admin scale (§4.16)

These give v1 a defensible **technical** baseline even without the **documentation** layer.

**Known tension (acknowledged, not addressed in v1):**

- DPDP Act 2023's storage limitation principle nudges toward retention windows. Q13's "keep audio forever" choice creates a documented tension. Mitigation: doctor and admin deletion paths (§4.17) provide individual-subject erasure on request.
- No published privacy notice on the doctor-facing PIN page beyond the footer line referenced in §4.19 (*"By recording, you confirm patient consent has been obtained per your clinic's policy."*)
- No `admin_actions` audit log. Admin actions are not retrospectively reviewable in v1.

**Path to compliance work when triggered (v2 backlog):**

The compliance work deferred from v1 is captured as v2 backlog items so it can be picked up cleanly when a stakeholder asks:

1. `admin_actions` table + middleware on every admin POST/PUT/DELETE; surfaced at `/{ADMIN_BASE_PATH}/audit`
2. `/privacy` public route with plain-language data-flow summary
3. `PRIVACY-DATA-FLOW.md` internal document
4. `BREACH-RESPONSE-RUNBOOK.md` — incident response steps including 72-hour Data Protection Board notification timeline
5. `/api/health/version` endpoint — app version + commit SHA for incident timelines
6. DPO contact in app footer
7. Storage-limitation review (revisit Q13 with usage data + regulatory feedback)
8. Vendor due diligence documentation (Deepgram, Resend, Vercel Blob, the Mac Mini Cloudflare-tunneled whisper.cpp + Ollama infrastructure)

**Trigger conditions for promoting this work to v1.5 or v2:**

- First doctor outside Even Hospital is onboarded (single-clinic assumption breaks)
- Any regulatory inquiry, audit, or stakeholder formal review
- Any compliance-relevant incident (real or near-miss)
- Even Hospital's internal counsel raises formalization as a requirement
- Doctor count exceeds ~5 (single-admin / single-policy assumptions strain)

Until any of those triggers fires, the technical primitives above are the compliance posture.

## 5. Open decisions (the working roadmap)

These are worked through one at a time. Each gets its own subsection below as it's locked. Items in **bold** are blocking before sprint planning.

### Tier A — Technical heart (live transcription) — ✅ COMPLETE
- ✅ **Q1 — Live transcription strategy.** *LOCKED: Option C — Hybrid (DG live + Whisper rolling chunks, silent swap). See §4.2.*
- ✅ **Q2 — Real-time cleanup level.** *LOCKED: Level 3 — filler + punctuation + sentence reformulation. Medical content preserved verbatim via safety rail. See §4.2.*
- ✅ **Q3 — Transcript editability rules.** *LOCKED: Edit anytime including active recording, with always-visible mic indicator + no-autocorrect. See §4.3.*

### Tier B — Product fundamentals (data model) — ✅ COMPLETE
- ✅ **Q4 — Patient identification approach.** *LOCKED: Hybrid — optional pre-recording label + LLM extraction at Submit. See §4.8.*
- ✅ **Q5 — Encounter persistence and library.** *LOCKED: Minimal library — list + view + re-send, no editing. See §4.9.*

### Tier C — Output processing (the note + CDMSS layer) — ✅ COMPLETE
- ✅ **Q6 — Encounter note schema + pipeline.** *LOCKED: Mixed prose+structured schema (β) + draft+critique+revise (Pipeline 2). See §4.10.*
- ✅ **Q7 — CDMSS analysis pipeline depth.** *LOCKED: Standard pipeline + critique+revise, parallel with note pipeline. See §4.11.*
- ✅ **Q8 — Visual hierarchy and artifact placement.** *LOCKED: Sequential below note in distinct "Clinical Decision Support" card; collapsed transcript at bottom. See §4.12.*

### Tier D — Delivery + accounts — ✅ COMPLETE
- ✅ **Q9 — Email delivery policy.** *LOCKED: Auto-send on Submit + admin global CC + per-encounter override + HTML format. See §4.13.*
- ✅ **Q10 — Per-doctor URL format.** *LOCKED: Slug + short 4-char token (`/dr-vinay-7k3p`). See §4.14.*
- ✅ **Q11 — PIN security model.** *LOCKED: 30-day session, no idle re-prompt, escalating lockout, admin-mediated reset. See §4.15.*
- ✅ **Q12 — Admin panel scope.** *LOCKED: Standard + operational controls — doctors, encounters, traces, sends, settings. See §4.16.*

### Tier E — Operational — ✅ COMPLETE
- ✅ **Q13 — Audio retention policy.** *LOCKED: Keep indefinitely + default-yes doctor delete with tombstone-not-purge audit. See §4.17.*
- ✅ **Q14 — Offline behavior.** *LOCKED: Pre-flight check + dropout tolerance + queue-submit-on-reconnect. See §4.18.*
- ✅ **Q15 — Patient consent UX.** *LOCKED: No in-app gate; doctor handles consent outside the app per clinic policy. See §4.19.*
- ✅ **Q16 — Compliance posture.** *LOCKED: Defer formal compliance work to v2+; ship product first. See §4.20.*

**🎯 SCOPE FREEZE ACHIEVED — 26 May 2026.** All 16 open product decisions are locked. Tiers A through E complete. The product spec is at full v1 freeze and ready for §6 data model + §7 API surfaces + §8 UX-spec-for-Figma + §9 sprint plan + §10 success criteria.

---

## 6. Data model

Two physical databases (per source catalog): `KB_DATABASE` (existing, 304,399 chunks for CDMSS retrieval — untouched by ETA) and `APP_DATABASE` (new, Neon Postgres on `bom1`). Schema below is the `APP_DATABASE` only. All IDs are application-generated short ids (e.g. `enc_8h2k7a9b`) except where noted. All timestamps are `timestamptz`, stored UTC. Soft-deletes use `deleted_at` (null = live); per §4.14 retention, hard-delete only on explicit admin "delete (permanent)" action.

### 6.1 Tables

#### `admin_user`
Minimal v1 admin auth. Vinay is the only row at launch.
- `id` (uuid, pk)
- `email` (citext, unique)
- `name` (text)
- `password_hash` (text — bcrypt cost 12)
- `role` (enum: `super` | `ops`; v1 only `super`)
- `last_active_at` (timestamptz, null)
- `created_at`, `updated_at`

#### `doctor`
Per §4.7, §4.14, §4.15.
- `id` (text, pk — e.g. `doc_3p4n9q2x`, 8-char nanoid prefixed)
- `full_name` (text)
- `email` (citext, unique)
- `phone` (text, null)
- `url_slug` (text, unique — e.g. `/dr/anjali-mehta-p4n9`; slugified name + 4-char disambiguator)
- `url_token` (text — 32-char secret, rotatable via admin; never logged)
- `pin_hash` (text — bcrypt cost 12, null when reset and awaiting set)
- `pin_set_at` (timestamptz, null)
- `failed_pin_count` (int, default 0)
- `locked_until` (timestamptz, null — set by lockout escalation per §4.15)
- `status` (enum: `active` | `disabled` | `locked`)
- `last_active_at` (timestamptz, null)
- `joined_at` (timestamptz)
- `created_by` (uuid, fk → admin_user.id)
- `deleted_at`, `created_at`, `updated_at`
- Indexes: `(url_slug)`, `(email)`, `(status, last_active_at desc)` for admin doctors list

#### `pin_attempt`
For lockout escalation, audit, and security forensics. Per §4.15.
- `id` (uuid, pk)
- `doctor_id` (text, fk → doctor.id)
- `success` (bool)
- `ip` (inet)
- `user_agent` (text)
- `created_at` (timestamptz)
- Indexes: `(doctor_id, created_at desc)`; partition by month if volume grows
- Retention: rolling 90 days (the only table with TTL)

#### `encounter`
The core artifact. Per §4.4, §4.9, §4.10.
- `id` (text, pk — e.g. `enc_8h2k7a9b`)
- `doctor_id` (text, fk → doctor.id)
- `patient_label_raw` (text — free-text "Sarah Acharya, 34F" per §4.8)
- `patient_age` (int, null — extracted)
- `patient_sex` (text, null — extracted: `M`/`F`/`Other`)
- `chief_complaint` (text, null — extracted in cleanup)
- `recorded_at` (timestamptz — recording start)
- `duration_seconds` (int)
- `status` (enum: `draft` | `processing` | `complete` | `failed` | `deleted`)
- `audio_object_key` (text — R2 / S3-compatible blob key; bytes not in Postgres)
- `audio_bytes` (int — size for ops visibility)
- `transcript_raw` (text — raw concatenated chunks from streaming engine)
- `transcript_clean` (text — after cleanup stage)
- `note_json` (jsonb — structured Medical Encounter Note per §4.10 schema)
- `cdmss_json` (jsonb — analysis + citation pointers per §4.11)
- `send_status` (enum: `pending` | `sent` | `failed` — separate from pipeline status; pipeline can complete but send fail)
- `sent_at` (timestamptz, null)
- `retry_count` (int, default 0)
- `deleted_at`, `created_at`, `updated_at`
- Indexes: `(doctor_id, recorded_at desc)` for library; `(status, recorded_at desc)` for admin lists; `(send_status, recorded_at desc)` for retry queue

#### `trace`
LLM observability per §4.16, §8.3. One row per pipeline stage per encounter. Stores full prompts and responses (cost is acceptable per Q14 keep-forever).
- `id` (text, pk — e.g. `trace_a7g3k2`)
- `encounter_id` (text, fk → encounter.id)
- `stage` (enum: `capture` | `transcribe` | `clean` | `critique` | `revise` | `cdmss` | `email`)
- `model` (text — e.g. `qwen2.5:14b`, `llama3.1:8b`, `whisper-large-v3`, `deepgram-nova-2`, `nomic-embed-text`, `resend-api`)
- `prompt_full` (text — full system + user prompt for LLM stages; null for capture/transcribe/email)
- `response_full` (text — full model output; null for capture/email)
- `input_tokens` (int, null)
- `output_tokens` (int, null)
- `latency_ms` (int)
- `cost_estimate_usd` (numeric(10,5), null — for cost dashboards)
- `status` (enum: `ok` | `warn` | `fail`)
- `error_message` (text, null)
- `metadata_json` (jsonb — stage-specific extras: critique flags, citation IDs retrieved, etc.)
- `started_at`, `completed_at` (timestamptz)
- Indexes: `(encounter_id, started_at asc)` for pipeline timeline view; `(stage, completed_at desc)` for admin trace list; `(status, started_at desc)` for failure dashboards

#### `recipient_global`
Per §4.13. Admins-only edit. CC'd on every send.
- `id` (uuid, pk)
- `email` (citext)
- `name` (text)
- `role` (enum: `admin` | `records` | `finance` | `compliance` | `other`)
- `active` (bool, default true)
- `created_at`, `updated_at`, `created_by` (uuid, fk → admin_user.id)

#### `recipient_per_doctor`
Per §4.13. Set by admin from doctor detail, or by doctor in their settings.
- `id` (uuid, pk)
- `doctor_id` (text, fk → doctor.id)
- `email` (citext)
- `name` (text)
- `role` (enum: same as global)
- `set_by` (enum: `admin` | `doctor`)
- `created_at`, `updated_at`

#### `send_event`
One row per (encounter × recipient) email. Resend webhook hydrates lifecycle events.
- `id` (text, pk — e.g. `em_9k3h7m2a`; this is the email message id, surfaced in sends UI)
- `encounter_id` (text, fk → encounter.id)
- `recipient_email` (citext)
- `recipient_role` (text — snapshot of role at send time)
- `subject_rendered` (text — actual rendered subject after token substitution)
- `resend_message_id` (text — external id from Resend API)
- `status` (enum: `queued` | `sent` | `delivered` | `opened` | `bounced` | `complained` | `failed`)
- `opened_at`, `bounced_at`, `complained_at` (timestamptz, null)
- `failure_reason` (text, null)
- `created_at`, `updated_at`
- Indexes: `(encounter_id)`, `(status, created_at desc)`, `(resend_message_id)` for webhook lookups

#### `audit_log`
Append-only. Per §4.16, §4.20. Surfaces in doctor detail audit panel and per-encounter audit log.
- `id` (uuid, pk)
- `actor_type` (enum: `admin` | `doctor` | `system`)
- `actor_id` (text, null — admin_user.id or doctor.id depending on actor_type)
- `action` (text — namespaced: `doctor.create`, `doctor.disable`, `pin.reset`, `url.rotate`, `encounter.delete`, `encounter.resend`, `settings.update`, etc.)
- `target_type` (text)
- `target_id` (text, null)
- `metadata_json` (jsonb)
- `ip` (inet, null)
- `user_agent` (text, null)
- `created_at` (timestamptz)
- Indexes: `(target_type, target_id, created_at desc)` for "show me everything about this doctor/encounter"; `(actor_id, created_at desc)` for actor timeline

#### `settings`
Single-row table (config singleton). KV-style for flexibility.
- `id` (int, pk, default 1, check id=1)
- `subject_template` (text — default `"[Even] {patient_name}, {patient_demo} · {chief_complaint} · {date}"`)
- `include_patient_on_send` (bool, default false)
- `send_drafts` (bool, default false)
- `block_on_critique_fail` (bool, default true)
- `retry_policy_max` (int, default 3)
- `retry_policy_backoff` (enum: `linear` | `exponential`, default `exponential`)
- `resend_from_email` (text — read-only, env-driven)
- `updated_at`, `updated_by` (uuid)

### 6.2 Storage outside Postgres

- **Audio blobs:** Cloudflare R2 (or S3-compatible). Key pattern: `audio/{yyyy}/{mm}/{dd}/{encounter_id}.opus`. Retained per §4.17 (forever in v1). Signed URLs for playback; never public.
- **KB chunks:** Neon `KB_DATABASE` (existing, separate from `APP_DATABASE`). Read-only from ETA via the existing CDMSS retrieval service.

### 6.3 Identifiers

| Prefix      | Purpose                  | Example          | Notes |
|-------------|--------------------------|------------------|-------|
| `doc_`      | Doctor                   | `doc_3p4n9q2x`   | 8-char nanoid |
| `enc_`      | Encounter                | `enc_8h2k7a9b`   | 10-char nanoid |
| `trace_`    | LLM trace row            | `trace_a7g3k2`   | 6-char nanoid |
| `em_`       | Email send event         | `em_9k3h7m2a`    | 9-char nanoid |
| (uuid)      | Admin user, audit, recipients | -          | Postgres uuid v4 |

Mono-typeface display of all IDs in UI, per design system.
## 7. API surfaces

All endpoints under `https://eta.llmvinayminihome.uk`. JSON bodies unless noted. Auth via JWT in `Authorization: Bearer <token>` header except where noted. Doctor JWT and admin JWT are separate token classes with non-overlapping audiences.

### 7.1 Doctor-facing (mobile PWA)

#### Auth
- `POST /api/auth/pin` — public. Body `{ slug, token, pin }`. The slug+token tuple comes from the personal URL; the PIN is entered. Returns `{ jwt, expires_at, doctor: { id, full_name } }` or `401 { error, lockout_until? }` per §4.15 escalation.
- `POST /api/auth/refresh` — auth. Returns rolled JWT.
- `POST /api/auth/logout` — auth. Invalidates server-side session record.

#### Recording lifecycle
- `POST /api/encounter/start` — auth. Body `{ patient_label_raw? }`. Returns `{ encounter_id, websocket_url, audio_upload_url }`. Encounter created in `draft` status.
- `WS /api/encounter/{id}/stream` — auth. Bidirectional. Client streams audio chunks (opus-encoded, ~250 ms windows). Server pushes interim transcripts `{ type: 'interim'|'final', text, ts }`. Per §4.2 hybrid: Deepgram drives interim; Whisper polish supplements.
- `POST /api/encounter/{id}/audio-chunk` — auth. Multipart fallback for HTTP-only environments. Body: chunk index + opus blob.
- `POST /api/encounter/{id}/finalize` — auth. Body `{ patient_label_raw, transcript_final, cc_picks: string[] }`. Returns `{ encounter_id, status: 'processing' }`. Triggers the async pipeline (clean → critique → revise → cdmss → email).
- `GET /api/encounter/{id}/status` — auth. Server-sent events stream: per-stage start/end with timings; final event includes complete encounter payload. Closes when send completes or fails terminally.

#### Library
- `GET /api/library` — auth. Query: `?limit=20&before=<id>&q=<text>&status=<all|sent|failed>`. Returns paged encounters (this doctor only).
- `GET /api/encounter/{id}` — auth. Full encounter (own only). Returns `{ encounter, note_json, cdmss_json, send_events[] }`.
- `POST /api/encounter/{id}/edit` — auth. Body `{ patient_label_raw?, note_json? }`. Per Q3 edit-anytime. Re-renders email but does NOT auto-resend (admin action).
- `DELETE /api/encounter/{id}` — auth. Soft delete (own only).

#### Settings (doctor)
- `GET /api/settings` — auth. Returns `{ recipients_global[], recipients_personal[], pin_meta }`.
- `POST /api/settings/pin/change` — auth. Body `{ current_pin, new_pin }`. 400 on current mismatch.
- `POST /api/settings/recipients` — auth. Body `{ add?: {email,name,role}, remove_id? }`. Adds/removes per-doctor recipient.

### 7.2 Admin-facing (desktop)

#### Auth
- `POST /api/admin/auth/login` — public. Body `{ email, password }`. Returns admin JWT.
- `POST /api/admin/auth/logout` — auth.

#### Dashboard
- `GET /api/admin/dashboard` — admin. Returns `{ kpis: { today, sent, failed, active_doctors }, attention: [...], recent_activity: [...], health: { whisper, deepgram, ollama, neon_kb, neon_app, resend, cloudflare }, chart_7d: [...] }`.

#### Doctors
- `GET /api/admin/doctors` — admin. Query: `?status=<all|active|disabled|locked|inactive_7d>&q=<text>&sort=<last_active|name|joined>`.
- `POST /api/admin/doctors` — admin. Body `{ full_name, email, phone? }`. Creates row, generates `url_slug` and `url_token`, optionally sends welcome email with personal URL. Returns full doctor object.
- `GET /api/admin/doctors/{id}` — admin. Full profile + stats + recent encounters + per-doctor recipients + audit_log slice.
- `PATCH /api/admin/doctors/{id}` — admin. Body any of `{ full_name, email, phone }`.
- `POST /api/admin/doctors/{id}/rotate-url` — admin. Generates new `url_token`. Old URL stops working immediately. Audit-logged.
- `POST /api/admin/doctors/{id}/reset-pin` — admin. Clears `pin_hash`. Doctor must set new PIN on next login. Audit-logged.
- `POST /api/admin/doctors/{id}/disable` — admin. Sets status `disabled`. Doctor login fails with friendly error.
- `POST /api/admin/doctors/{id}/enable` — admin. Reverses disable.
- `DELETE /api/admin/doctors/{id}` — admin. Soft delete (sets `deleted_at`). Hard delete only via separate `?hard=true` flag with reconfirm (per "permanent" UX in design).
- `POST /api/admin/doctors/{id}/email-url` — admin. Re-sends the personal URL email.

#### Encounters
- `GET /api/admin/encounters` — admin. Query: `?status=<all|sent|failed|draft|processing>&doctor_id=<id>&date_from=<>&date_to=<>&q=<text>&limit=20&before=<id>`.
- `GET /api/admin/encounters/{id}` — admin. Full encounter including all trace rows and send_events.
- `POST /api/admin/encounters/{id}/resend` — admin. Triggers email retry with current recipients. Audit-logged.
- `DELETE /api/admin/encounters/{id}` — admin. `?hard=true` for permanent. Cascades to traces, send_events; audio_object_key marked for R2 deletion via async job.

#### Traces
- `GET /api/admin/traces` — admin. Query: `?stage=<>&model=<>&status=<>&date_from=<>&date_to=<>&q=<text>&limit=20&before=<id>`. Returns paged list with snippet of prompt/response.
- `GET /api/admin/traces/{id}` — admin. Full row including complete `prompt_full` and `response_full`.
- `GET /api/admin/encounters/{id}/traces` — admin. All 7 stages for one encounter, ordered by `started_at`. Used by encounter detail pipeline trace UI.

#### Sends
- `GET /api/admin/sends` — admin. Query: `?status=<>&date_from=<>&date_to=<>&q=<email>&limit=20&before=<id>`. Returns paged send_event rows.
- `GET /api/admin/sends/funnel` — admin. Query: `?range=<24h|7d|30d>`. Returns `{ queued, sent, delivered, opened, bounced, complained, failed }` for funnel viz.
- `POST /api/admin/sends/{id}/resend` — admin. Resend a single message (different from encounter resend which sends to all recipients).

#### Settings
- `GET /api/admin/settings` — admin. Returns full settings + recipient_global rows.
- `PATCH /api/admin/settings` — admin. Patch any of the singleton fields.
- `POST /api/admin/settings/recipients` — admin. Body `{ add?: {email,name,role}, remove_id? }`. Global recipient CRUD.
- `GET /api/admin/health` — admin. Same payload as dashboard `health` block but with deeper diagnostics: probe latencies, last error per service, retry counts. Drives the future `/settings/health` sub-page.

### 7.3 Webhooks (inbound)

- `POST /api/webhooks/resend` — public, signed. Resend posts `email.delivered`, `email.opened`, `email.bounced`, `email.complained` events. Server verifies signature, looks up `send_event` by `resend_message_id`, updates status + timestamps, emits audit_log entry.

### 7.4 Background jobs

Triggered by cron or by encounter finalize:
- `pipeline.process(encounter_id)` — orchestrates clean → critique → revise → cdmss in sequence; cdmss is parallel-eligible after clean. Writes a `trace` row per stage. On terminal failure, sets `encounter.status = 'failed'` and emits audit entry.
- `email.send(encounter_id)` — renders template, calls Resend, creates `send_event` rows with `status=queued`, transitions to `sent` on API success. Honors `settings.block_on_critique_fail`.
- `email.retry(send_event_id)` — exponential backoff up to `settings.retry_policy_max`. Terminal failure surfaces in dashboard "Needs your attention" panel.
- `audit.gc()` — daily. Trims `pin_attempt` rows older than 90 days. No other table has TTL in v1.

### 7.5 Error envelope

All errors return:
```json
{
  "error": {
    "code": "PIN_LOCKED",
    "message": "Account locked for 15 minutes. Contact admin to reset.",
    "retry_after_seconds": 900,
    "trace_id": "req_..."
  }
}
```
Codes used in v1: `PIN_INVALID`, `PIN_LOCKED`, `PIN_NOT_SET`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_FAILED`, `PIPELINE_FAILED`, `SEND_FAILED`, `UPSTREAM_UNAVAILABLE` (Whisper/Ollama down), `RATE_LIMITED`.
## 8. UX & screens — Figma input

This section is the brief for the Figma stage. It specifies **what exists on each screen, in which states, and how it behaves** — but does NOT specify exact pixel sizes, color values, typography choices, spacing units, or animation timing. Those are Figma's job. The ASCII mockups are layout-intent diagrams, not pixel mockups.

### 8.0 Visual language & design tokens

**Form factor priorities:**
- Doctor-facing app: **mobile portrait, single-column** (375-430px viewport). Installable as PWA. Tablet acceptable but not optimized. Desktop layout shown for the admin surface only.
- Admin panel: **desktop, multi-column** (1280px+). Mobile/tablet acceptable but secondary.

**Semantic color roles** (Figma chooses actual values):
- `--brand` — primary buttons, links, active states. Suggest a calm clinical blue or teal.
- `--ai-accent` — Clinical Decision Support card background tint, ✨ icon, AI-generated badges. **Violet** to match OPD v4's "AI" color convention (consistency across V's apps).
- `--recording` — recording dot, "Rec" indicator. Saturated red, pulsing animation when active.
- `--success` — "Sent" badges, success toasts. Green.
- `--warning` — "Reconnecting", pending states. Amber.
- `--danger` — failed sends, delete confirmations, lockout messages. Red.
- `--surface` / `--surface-elevated` — backgrounds (light theme default; dark theme optional v2)
- `--text-primary` / `--text-secondary` / `--text-muted` — text hierarchy
- `--border-subtle` / `--border-default` — divider lines, card edges

**Typography roles** (Figma chooses families + sizes):
- `--text-display` — headings, large titles
- `--text-body` — prose (transcript, note sections). Generous line-height; this is long-form reading.
- `--text-mono` — drug doses, vitals values, lab values, structured medical data where alignment matters
- `--text-label` — form labels, badges, metadata
- `--text-caption` — timestamps, counts, footer text

**Spacing & tap targets:**
- Minimum tap target: 44pt (mobile) / 32px (admin)
- Default vertical rhythm: ~16px between content blocks
- Card padding: ~20-24px on mobile, ~16px on admin

**Iconography:**
- Use [lucide-react](https://lucide.dev) (already a dependency in OPD/CDMSS — consistent across V's apps)
- Key icons referenced below: `Mic`, `Pause`, `Square` (stop/end), `Play` (resume), `Send`, `Trash2`, `Clock`, `Check`, `X`, `Sparkles` (✨, AI), `RotateCcw` (re-send), `Lock`, `Settings`, `Plus`, `ChevronLeft`, `ChevronRight`, `ChevronDown`, `Eye`, `Copy`, `RefreshCw`, `AlertCircle`, `WifiOff`.

**Status badges** (semantic, reused across screens):
- `Sent` — green pill, ✓ icon
- `Failed` — red pill, ⚠ icon
- `Pending` — amber pill, ⏳ icon
- `Queued` (offline submit) — amber pill, 📡 icon
- `Deleted` — gray pill, 🗑 icon (admin-only view)

---

### 8.1 Doctor-facing app — mobile PWA screens

The doctor's app is **3 primary screens** with state variations + several modals: PIN entry → Home (with Record / Library tabs) → Recording → Finalize → Library detail. All other surfaces are modals or sub-states.

#### 8.1.1 PIN entry screen

**Trigger:** doctor visits `eta.llmvinayminihome.uk/dr-vinay-7k3p` for the first time, OR session cookie expired/invalid.

**Layout:**

```
┌──────────────────────────────────────┐
│                                      │
│           Even Hospital              │  ← clinic name / logo (configurable in admin)
│                                      │
│        Encounter Assistant           │  ← app name
│                                      │
│   ┌──────────────────────────────┐   │
│   │  Welcome back, Dr Vinay      │   │  ← name from doctor profile
│   │                              │   │
│   │  Enter your 4-digit PIN      │   │
│   │                              │   │
│   │     ●   ●   ●   ●            │   │  ← PIN dots (filled as typed)
│   │                              │   │
│   │   ┌─────────────────────┐    │   │
│   │   │  1   2   3          │    │   │  ← numeric pad (large tap targets)
│   │   │  4   5   6          │    │   │
│   │   │  7   8   9          │    │   │
│   │   │      0   ⌫          │    │   │
│   │   └─────────────────────┘    │   │
│   └──────────────────────────────┘   │
│                                      │
│   By recording, you confirm patient  │  ← consent footer per §4.19
│   consent has been obtained per      │     (small, muted text)
│   your clinic's policy.              │
│                                      │
│        Forgot PIN? Contact admin     │  ← link/text, no self-service
│                                      │
└──────────────────────────────────────┘
```

**States:**
- **Default** — empty PIN dots, numeric pad active
- **Typing** — dots fill left-to-right as digits entered
- **Submitting** — brief spinner after 4th digit; no explicit Submit button (auto-submit on completion)
- **Wrong PIN** — dots clear, brief red shake animation, message: *"Incorrect PIN. {N} attempts remaining before lockout."* (suppress count if N ≥ 3; show count only when N ≤ 2)
- **Locked out** — pad disabled, message: *"Too many incorrect attempts. Try again in {N} minutes, or contact your administrator."*; auto-refresh countdown
- **Account disabled** — pad disabled, message: *"This account is currently disabled. Please contact your administrator."* (Q11 attempt 30+ state)
- **Loading initial** — brief shimmer while the doctor's name + clinic name resolve from `GET /api/doctor/profile`

**Behavior:**
- Auto-focus first input on mount
- On successful PIN → set `eta_session` cookie → redirect to home (8.1.2)
- Numeric pad is the only input affordance — no keyboard input field (avoids autocomplete leaking the PIN to password managers, which would treat 4-digit codes as weak passwords)

**Accessibility:**
- Numeric pad buttons have aria-labels ("Digit 1", "Backspace")
- PIN dots have aria-live region for assistive announcements
- High-contrast mode supported

---

#### 8.1.2 Home / Record start screen

**Trigger:** successful PIN entry, OR returning with valid session cookie. The default landing.

**Layout:**

```
┌──────────────────────────────────────┐
│  Dr Vinay  ▾                  ⚙       │  ← header: doctor name menu + settings icon
├──────────────────────────────────────┤
│                                      │
│   ┌────────────────────────────┐     │
│   │  [Record]  │  Library  │   │     │  ← tab switcher (Record active)
│   └────────────────────────────┘     │
│                                      │
│                                      │
│   New encounter                      │  ← section heading
│                                      │
│   Patient (optional)                 │  ← label, visibly optional per §4.8
│   ┌──────────────────────────────┐   │
│   │  e.g. Sarah, 34F, chest pain │   │  ← placeholder, no asterisk
│   │  f/u                         │   │
│   └──────────────────────────────┘   │
│                                      │
│                                      │
│            ╭──────────╮              │
│            │          │              │
│            │   🎤     │              │  ← BIG round record button
│            │          │              │     primary action
│            │  Record  │              │
│            │          │              │
│            ╰──────────╯              │
│                                      │
│                                      │
│   Last recording: 2 hr ago           │  ← caption — most recent encounter timestamp
│                                      │
└──────────────────────────────────────┘
```

**States:**
- **Default** — patient label empty, Record button enabled (label is optional)
- **Patient label typed** — Record button unchanged (still enabled); label shows in field
- **Pre-flight checking** (on Record tap) — Record button shows brief spinner while `GET /api/health/ping` runs
- **Pre-flight failed** — modal per 8.1.11 ("You're offline")
- **Pending submit visible** — if there's an unsent encounter queued (offline at submit), a banner above the tabs: *"⏳ Pending submit — will send when reconnected"* with a tap-to-view affordance
- **Recovery state** — if returning from a backgrounded recording (foreground recovery per §4.9), an "Unfinished encounter from 10:14 AM (3 min recorded)" card appears at top with [Resume] / [Discard] buttons

**Behavior:**
- Patient label field: `autocomplete="off"`, `spellcheck="false"`, `autocapitalize="off"`, `data-gramm="false"` (per §4.3 standard — no autocorrect on medical content)
- Tap Record → pre-flight ping → if OK, transition to 8.1.3 (recording active) with audio capture starting immediately
- Doctor name `▾` menu opens a small dropdown: "Lock app" (clears session per §4.15), "About" (version + commit SHA)
- Settings ⚙ opens 8.1.10

---

#### 8.1.3 Recording active screen

**Trigger:** tap Record from 8.1.2 with valid pre-flight, OR resume from foreground recovery.

**Layout:**

```
┌──────────────────────────────────────┐
│  ●  Recording · 02:14                │  ← header: pulsing red dot + label + elapsed time
│                                      │
│  Patient: Sarah, 34F, chest pain f/u │  ← patient label echoed if provided
├──────────────────────────────────────┤
│                                      │
│  TRANSCRIPT (editable)               │  ← section heading; small caption
│                                      │
│  Patient is a 34-year-old female     │
│  presenting with intermittent left-  │  ← transcript text, prose
│  sided chest pain for the past two   │     auto-scrolls as text appears
│  weeks. The pain is described as     │     editable per §4.3
│  pressure-like, radiating to the     │
│  left arm.                           │
│                                      │
│  She reports associated dyspnea on   │
│  exertion but denies syncope or...   │
│                                      │
│  ◌                                   │  ← cursor blink (or current utterance)
│                                      │
│                                      │
│                                      │
├──────────────────────────────────────┤  ← controls dock (always visible at bottom)
│                                      │
│        ⏸ Pause       ⏹ End          │  ← pause and end buttons
│                                      │
└──────────────────────────────────────┘
```

**States:**
- **Live (default)** — text appears in real-time as Deepgram returns cleaned utterances (per §4.2 hybrid pipeline). Pulsing red dot in header.
- **Editing** — when the doctor taps into the transcript text, the cursor appears, the mic dot keeps pulsing (visual reassurance audio is still being captured), Whisper rolling swaps near the cursor are suppressed per §4.2.
- **Reconnecting** — when Deepgram WebSocket drops, header shows: `● Reconnecting · 02:14` (dot stays red but adds a subtle ↻ icon next to "Reconnecting"). Transcript may visibly freeze at the last received line; new audio continues to capture locally.
- **Whisper polishing** (subtle, optional visual) — when a Whisper rolling chunk lands and a span swaps, the span has a 200ms gentle highlight that fades. Not intrusive.
- **Edit conflict deferred** — when a Whisper swap was suppressed because the doctor was editing the relevant span, a small caption appears briefly: *"Refined wording available — tap to apply"* with a refresh icon next to the affected line. Tap → apply pending swap.

**Behavior:**
- Auto-scroll keeps the latest text in view; doctor can scroll up to read earlier; tapping any line gives editable cursor
- No autocorrect / no autosuggest in the transcript editor per §4.3
- Pause button → transitions to 8.1.4
- End button → confirm modal: *"End recording? You can review and edit before submitting."* [Cancel] [End] → transitions to 8.1.5
- Backgrounding the app → auto-pauses + persists state per §4.9 (returning foregrounded shows the same screen with a "Resumed" toast)

---

#### 8.1.4 Recording paused screen

**Trigger:** tap Pause from 8.1.3.

**Layout:**

```
┌──────────────────────────────────────┐
│  ⏸  Paused · 02:14                   │  ← header: pause icon + label + elapsed
│                                      │
│  Patient: Sarah, 34F, chest pain f/u │
├──────────────────────────────────────┤
│                                      │
│  TRANSCRIPT (editable)               │
│                                      │
│  [same transcript as 8.1.3,          │
│  no new text appending]              │
│                                      │
│                                      │
├──────────────────────────────────────┤
│                                      │
│     ▶ Resume        ⏹ End            │  ← resume and end buttons
│                                      │
└──────────────────────────────────────┘
```

**Differences from 8.1.3:**
- Header dot is non-pulsing pause icon (not the recording dot)
- "Paused" label replaces "Recording"
- Elapsed time freezes (doesn't tick during pause)
- Pause control replaced by Resume
- Mic capture is OFF (no audio captured during pause)
- All other behavior identical (transcript still editable, doctor can scroll, etc.)

---

#### 8.1.5 Finalize / Review screen

**Trigger:** tap End from 8.1.3 or 8.1.4 and confirm.

**Layout:**

```
┌──────────────────────────────────────┐
│  ← Back        Review                │  ← header: back arrow + title
├──────────────────────────────────────┤
│                                      │
│  Patient: Sarah, 34F, chest pain f/u │  ← editable label here too
│                                      │
│  Total: 12:34 · 1,847 words          │  ← caption with stats
│                                      │
├──────────────────────────────────────┤
│                                      │
│  TRANSCRIPT                          │
│  Edit anything before submitting     │  ← subtitle
│                                      │
│  Patient is a 34-year-old female     │
│  presenting with intermittent left-  │  ← full transcript, editable
│  sided chest pain for the past two   │
│  weeks. The pain is described as     │
│  pressure-like, radiating to the     │
│  left arm.                           │
│  ...                                 │
│  [full transcript, scrollable]       │
│  ...                                 │
│                                      │
├──────────────────────────────────────┤
│                                      │
│  + Add CC (optional)                 │  ← per-encounter CC affordance per §4.13
│                                      │     tap → opens CC picker modal
│  ┌────────────────────────────────┐  │
│  │       Submit & Send            │  │  ← primary action
│  └────────────────────────────────┘  │
│                                      │
└──────────────────────────────────────┘
```

**States:**
- **Default** — full transcript loaded (Whisper-polished version after final chunks land, typically within 1-2s of End tap). Patient label editable in-place.
- **Last chunk processing** — if Whisper hasn't finished the last 15s of audio, a small caption above the transcript reads: *"Final polish in progress…"* with subtle spinner. Submit button still enabled — pipelines will use whatever's available.
- **CC picker open** — modal listing admin global CCs (checkboxes, pre-checked by default) + per-encounter additions (free-form email entry). Tap a default CC to deselect; type new emails to add. [Cancel] [Done].
- **Submitting** — Submit button transitions to 8.1.6 immediately on tap

**Behavior:**
- Back arrow → confirm modal: *"Discard recording? Your audio and transcript will be lost."* [Cancel] [Discard]
- Edit any text in the transcript: standard mobile text editing, no autocorrect
- Edit patient label: tap, edit, blur to save (just updates the field; commits on Submit)
- Submit & Send → on tap, both pipelines fire in parallel per §4.10 + §4.11 → transition to 8.1.6
- If offline at Submit: button changes to "Will submit when reconnected" + encounter saved to `pending_submit` state per §4.18; transition to 8.1.2 with a banner

---

#### 8.1.6 Submit processing screen

**Trigger:** Submit tapped from 8.1.5. Pipelines firing.

**Layout:**

```
┌──────────────────────────────────────┐
│        Processing your encounter     │  ← header: title only, no back
│                                      │
│  Sarah, 34F, chest pain f/u          │  ← echo patient label
│  12:34 recording · 1,847 words       │  ← stats
├──────────────────────────────────────┤
│                                      │
│   ┌─ NOTE ─────────────────────┐     │  ← pipeline card 1
│   │  ✓ Drafting                 │     │     check or spinner per stage
│   │  ⟳ Reviewing                │     │
│   │  ○ Revising                 │     │
│   │  ──────────                 │     │
│   │  ●●●○○  (estimated 20s)     │     │  ← progress bar + ETA
│   └────────────────────────────┘     │
│                                      │
│   ┌─ CLINICAL DECISION SUPPORT ─┐    │  ← pipeline card 2 (violet tint)
│   │  ✨                          │    │
│   │  ✓ Expanding query          │    │
│   │  ✓ Retrieving evidence      │    │
│   │  ⟳ Drafting                 │    │
│   │  ○ Reviewing                │    │
│   │  ○ Revising                 │    │
│   │  ──────────                 │    │
│   │  ●●●●●○○ (estimated 35s)   │    │
│   └────────────────────────────┘     │
│                                      │
│   [Cancel and edit]                  │  ← escape hatch (rare use)
│                                      │
└──────────────────────────────────────┘
```

**States:**
- **Active (default)** — both pipelines streaming heartbeats; stages tick from `○` (pending) to `⟳` (active, spinning) to `✓` (complete). TracePanel infrastructure handles this per §4.11 and the existing OPD/CDMSS implementation.
- **One complete, one pending** — completed pipeline card collapses to a single line ("✓ Note ready · 18s"), other continues
- **Both complete** — brief "All done" state for ~500ms → auto-transition to 8.1.8 (library detail view of the just-completed encounter)
- **Error in one pipeline** — failed pipeline shows ⚠ + error summary + [Retry] button. Other pipeline can still complete. Encounter still saves with partial output.
- **Both fail** — modal: *"Processing failed. Your transcript is saved. Tap Retry to try again, or Cancel and edit to return to the review screen."* [Cancel and edit] [Retry]
- **Cancel and edit** — confirm modal: *"Cancel processing? Your transcript will return to the review screen for editing. The pipelines will not run."* [Keep processing] [Yes, cancel] → returns to 8.1.5

**Behavior:**
- This screen is intentionally calm and informative — V emphasized making the wait legible
- The TracePanel uses the same component logic as OPD's `BackgroundTraceToaster.tsx` + `AiActivityList.tsx` (Source Catalog v0.2 §10.9)
- Doctor can navigate away (tap Cancel and edit) but the pipelines continue server-side; the encounter will appear in library when complete (status `processed`) or with a failure badge (`processing_failed`)

---

#### 8.1.7 Library list screen

**Trigger:** tap "Library" tab from 8.1.2.

**Layout:**

```
┌──────────────────────────────────────┐
│  Dr Vinay  ▾                  ⚙      │
├──────────────────────────────────────┤
│                                      │
│   ┌────────────────────────────┐     │
│   │  Record  │  [Library]  │   │     │  ← Library tab active
│   └────────────────────────────┘     │
│                                      │
│   ┌────────────────────────────────┐ │
│   │  🔍 Search                     │ │  ← search bar (v2 — disabled in v1)
│   └────────────────────────────────┘ │
│                                      │
│   ─── Today ─────────────────────    │  ← date grouping divider
│                                      │
│   ┌──────────────────────────────┐   │
│   │  Sarah Acharya, 34F          │   │  ← encounter card
│   │  chest pain f/u              │   │
│   │  10:23 AM · 12 min · ✓ Sent  │   │
│   └──────────────────────────────┘   │
│                                      │
│   ┌──────────────────────────────┐   │
│   │  Encounter — 09:45 AM         │   │  ← card with no label / no extraction
│   │  09:45 AM · 8 min · ⚠ Failed │   │
│   └──────────────────────────────┘   │
│                                      │
│   ─── Yesterday ─────────────────    │
│                                      │
│   ┌──────────────────────────────┐   │
│   │  Mr Acharya, 67M             │   │
│   │  diabetes follow-up          │   │
│   │  04:12 PM · 7 min · ✓ Sent   │   │
│   └──────────────────────────────┘   │
│                                      │
│   ─── This week ─────────────────    │
│                                      │
│   ...                                │
│                                      │
│   [Load more]                        │  ← pagination at bottom
│                                      │
└──────────────────────────────────────┘
```

**States:**
- **Default** — encounters grouped by date (Today / Yesterday / This week / This month / Older), most recent first
- **Empty** — illustration + caption: *"No encounters yet. Tap Record to begin."*
- **Loading** — skeleton cards (3-4 shimmer placeholders) while fetching
- **Refreshing** — pull-to-refresh gesture supported (standard mobile pattern)
- **Failed cards** — `⚠ Failed` badge in red; card is still tappable to view detail and retry
- **Pending submit cards** — `📡 Queued` badge in amber for encounters waiting on reconnect
- **Processing cards** — `⏳ Processing` badge for encounters where pipelines are still running (rare, but possible if doctor navigates away from 8.1.6)

**Behavior:**
- Tap any card → 8.1.8 (detail view)
- Long-press a card → context menu: View / Delete (with confirm per §4.17) / Re-send
- Cards show status badge per §8.0 status semantics
- Pagination: load 20 encounters at a time; infinite scroll OR explicit "Load more" button (Figma can pick)

---

#### 8.1.8 Library detail / encounter view

**Trigger:** tap a card from 8.1.7, OR auto-redirected from 8.1.6 after successful processing.

**Layout:**

```
┌──────────────────────────────────────┐
│  ←  Encounter                  ⋯     │  ← back arrow + overflow menu
├──────────────────────────────────────┤
│                                      │
│   Sarah Acharya, 34F                 │  ← title (per §4.8 display precedence)
│   chest pain f/u                     │
│   10:23 AM, 26 May · 12 min          │
│                                      │
│   ✓ Sent to: vinay@evenhospital.in,  │  ← recipients + status
│              v@evenheaven.in (CC)    │
│                                      │
│   ⟳ Re-send  ·  📋 Copy share link   │  ← action chips
│                                      │
├──────────────────────────────────────┤
│                                      │
│   ┌─ MEDICAL ENCOUNTER NOTE ──────┐  │
│   │                                │  │
│   │  Reason for visit              │  │
│   │  [prose paragraph]             │  │
│   │                                │  │
│   │  Medical history               │  │
│   │  [prose paragraph]             │  │
│   │                                │  │
│   │  Comorbidities                 │  │
│   │  [T2DM] [HTN] [CKD G3a]        │  │  ← pill list
│   │                                │  │
│   │  Vitals                        │  │
│   │  BP 120/80 mmHg  HR 78  ...    │  │  ← structured table/grid
│   │                                │  │
│   │  Examination                   │  │
│   │  [prose paragraph]             │  │
│   │                                │  │
│   │  Disposition                   │  │
│   │  [prose paragraph]             │  │
│   │                                │  │
│   │  Prescription                  │  │
│   │  ┌──────────────────────────┐  │  │
│   │  │ Metformin · 500mg · PO   │  │  │
│   │  │ BD · 30 days             │  │  │
│   │  │ Take with food           │  │  │
│   │  └──────────────────────────┘  │  │  ← prescription row
│   │  ...                           │  │
│   │                                │  │
│   │  Suggestions (verbal)          │  │
│   │  [prose paragraph]             │  │
│   │                                │  │
│   │  Referrals                     │  │
│   │  Cardiology · routine          │  │
│   │  Indication: ECG + stress test │  │
│   │  ...                           │  │
│   └────────────────────────────────┘  │
│                                      │
│   ┌─ ✨ CLINICAL DECISION SUPPORT ─┐  │  ← violet-tinted card per §4.12
│   │  Generated from CDMSS · 304k   │  │
│   │  clinical chunks · for your    │  │
│   │  consideration                 │  │
│   │                                │  │
│   │  Investigation suggestions     │  │
│   │  • [suggestion] [1] [2]        │  │
│   │    rationale ...               │  │  ← rationale in lighter weight
│   │  • [suggestion] [3]            │  │
│   │    rationale ...               │  │
│   │                                │  │
│   │  Treatment suggestions         │  │
│   │  • ...                         │  │
│   │                                │  │
│   │  Referral suggestions          │  │
│   │  • ...                         │  │
│   │                                │  │
│   │  Follow-up suggestions         │  │
│   │  • ...                         │  │
│   │                                │  │
│   │  References                    │  │
│   │  [1] MKSAP 19 · Endocrinology  │  │  ← tap to expand chunk preview
│   │      · p.142                   │  │
│   │  [2] StatPearls · Diabetes     │  │
│   │      mgmt · 2024               │  │
│   │  [3] UpToDate · ASCVD risk     │  │
│   └────────────────────────────────┘  │
│                                      │
│   ▶ Show transcript (1,847 words)    │  ← collapsed by default per §4.12
│                                      │     tap to expand inline
└──────────────────────────────────────┘
```

**States:**
- **Default (sent)** — full layout as shown, "✓ Sent" badge
- **Pending send / queued** — recipient row shows: *"📡 Queued — will send when reconnected"*. Re-send button replaced by "Send now" (forces an attempt).
- **Failed send** — recipient row shows: *"⚠ Send failed: [reason]"*. Prominent **[Retry send]** button. Action chip says "Retry" instead of "Re-send".
- **Processing** — note + analysis cards show skeleton/placeholder content with subtle spinner; banner at top: *"Still processing… check back in a moment."*
- **Processing failed** — note + analysis cards show error states with [Retry processing] button. Transcript still available (collapsed below).
- **Transcript expanded** — the "Show transcript" affordance expands inline into a scrollable transcript card. Read-only.
- **Citation expanded** — tap any `[n]` inline → small popover with the chunk text preview + source. Tap outside to dismiss.

**Behavior:**
- Overflow menu `⋯` opens: "Re-send", "Copy share link" (a link back to this view, doctor-scoped), "Delete encounter" (per §4.17 with confirm modal — tombstone-not-purge)
- "Re-send" → opens CC picker modal (same as 8.1.5) → tap Send → spinner → toast: "Sent ✓"
- "Copy share link" copies a URL like `https://eta.llmvinayminihome.uk/dr-vinay-7k3p/encounter/{id}` to clipboard (note: recipients without a session will hit the PIN screen)

---

#### 8.1.9 Settings screen

**Trigger:** tap ⚙ from any header.

**Layout:**

```
┌──────────────────────────────────────┐
│  ← Back     Settings                 │
├──────────────────────────────────────┤
│                                      │
│  Profile                             │
│  ┌──────────────────────────────┐    │
│  │  Dr Vinay Bhardwaj           │    │  ← read-only
│  │  vinay@evenhospital.in       │    │
│  └──────────────────────────────┘    │
│                                      │
│  Your URL                            │
│  ┌──────────────────────────────┐    │
│  │  eta.llmvinayminihome.uk/dr-vinay-7k3p   │    │
│  │                       📋 Copy │    │
│  └──────────────────────────────┘    │
│                                      │
│  Session                             │
│  ┌──────────────────────────────┐    │
│  │  Signed in 3 days ago        │    │  ← session age
│  │       🔒 Lock app             │    │
│  └──────────────────────────────┘    │
│                                      │
│  About                               │
│  ┌──────────────────────────────┐    │
│  │  Even Encounter Assistant     │    │
│  │  Version 1.0.0 · build a3f2   │    │  ← from /api/health/version
│  │  ─────────────                │    │
│  │  Contact admin: v@even.in     │    │
│  └──────────────────────────────┘    │
│                                      │
└──────────────────────────────────────┘
```

**Behavior:**
- Profile is read-only (changes via admin only)
- "Copy" → copies URL to clipboard, toast confirmation
- "Lock app" → confirm modal → clears `eta_session` cookie → redirects to PIN screen (8.1.1)

---

#### 8.1.10 Modals & toasts (cross-cutting)

**Modal patterns (mobile bottom-sheet style):**

```
┌──────────────────────────────────────┐
│                                      │
│  [page dimmed behind]                │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  ━                           │    │  ← drag handle
│  │                              │    │
│  │  {Title}                     │    │
│  │                              │    │
│  │  {Body — may include input,  │    │
│  │   list, form, etc.}          │    │
│  │                              │    │
│  │  ┌─────────┐  ┌──────────┐   │    │
│  │  │ Cancel  │  │ Confirm  │   │    │
│  │  └─────────┘  └──────────┘   │    │
│  └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

**Modal types referenced above:**
- **End recording** confirmation
- **Discard recording** confirmation
- **CC picker** (8.1.5 / 8.1.8 re-send)
- **Delete encounter** confirmation (per §4.17)
- **Lock app** confirmation (8.1.9)
- **Pre-flight offline** (8.1.11)
- **Processing failed** (8.1.6)

**Toast pattern (top-anchored, auto-dismiss):**

```
┌──────────────────────────────────────┐
│   ┌────────────────────────────┐     │
│   │ ✓ Sent to vinay@even.in   │     │  ← green toast, ~3s dismiss
│   └────────────────────────────┘     │
│                                      │
│  [rest of page]                      │
└──────────────────────────────────────┘
```

**Toast variants:** success (green ✓), error (red ⚠), info (blue ⓘ), warning (amber ⚠).

---

#### 8.1.11 Pre-flight offline modal

**Trigger:** tap Record at 8.1.2 with no connectivity.

**Content:**

```
┌──────────────────────────────────────┐
│                                      │
│  [page dimmed]                       │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  ━                           │    │
│  │                              │    │
│  │  📡  You're offline           │    │
│  │                              │    │
│  │  Recording requires an       │    │
│  │  internet connection. Please │    │
│  │  reconnect to start.         │    │
│  │                              │    │
│  │  ┌─────────┐  ┌──────────┐   │    │
│  │  │ Cancel  │  │ Try again │  │    │
│  │  └─────────┘  └──────────┘   │    │
│  └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

**Behavior:**
- "Try again" → re-runs `/api/health/ping` → if OK, dismiss modal + start recording; if still failing, stays open
- "Cancel" → dismisses modal, returns to 8.1.2

---

### 8.2 Email template

The HTML email per §4.13 + §4.12. Single template, used for initial send and all re-sends. Rendered server-side using React Email or equivalent.

```
─────────────────────────────────────────────────────────────
From: transcripts@eta.llmvinayminihome.uk
To: vinay@evenhospital.in
CC: v@evenheaven.in
Subject: Sarah Acharya, 34F — chest pain f/u

[EMAIL BODY]

╔═══════════════════════════════════════════════════════════╗
║  EVEN HOSPITAL · Encounter Assistant                       ║  ← header bar
╠═══════════════════════════════════════════════════════════╣
║                                                            ║
║  Sarah Acharya, 34F                                        ║  ← title (big)
║  chest pain f/u                                            ║
║                                                            ║
║  Recorded by Dr Vinay · 10:23 AM, 26 May 2026 · 12 min     ║
║  Note + 4 clinical suggestions · Trace [abc12345]          ║  ← summary line
║                                                            ║
║  ──────────────────────────────────────────────────────    ║
║                                                            ║
║  MEDICAL ENCOUNTER NOTE                                    ║  ← section header
║                                                            ║
║  Reason for visit                                          ║
║  Patient presents for follow-up of chest pain ...          ║
║                                                            ║
║  Medical history                                           ║
║  ...                                                       ║
║                                                            ║
║  Comorbidities                                             ║
║  • T2DM                                                    ║
║  • HTN                                                     ║
║  • CKD G3a                                                 ║
║                                                            ║
║  Vitals                                                    ║
║  ┌──────────┬──────────┬──────────┐                        ║
║  │ BP       │ 120/80   │ mmHg     │                        ║
║  │ HR       │ 78       │ bpm      │                        ║
║  │ ...      │ ...      │ ...      │                        ║
║  └──────────┴──────────┴──────────┘                        ║
║                                                            ║
║  Examination                                               ║
║  ...                                                       ║
║                                                            ║
║  Disposition                                               ║
║  ...                                                       ║
║                                                            ║
║  Prescription                                              ║
║  ┌──────────────┬──────┬──────┬──────┬─────────┐           ║
║  │ Drug         │ Dose │ Route│ Freq │ Duration│           ║
║  ├──────────────┼──────┼──────┼──────┼─────────┤           ║
║  │ Metformin    │ 500mg│ PO   │ BD   │ 30 days │           ║
║  │ Atorvastatin │ 10mg │ PO   │ HS   │ 30 days │           ║
║  └──────────────┴──────┴──────┴──────┴─────────┘           ║
║                                                            ║
║  Suggestions (verbal)                                      ║
║  ...                                                       ║
║                                                            ║
║  Referrals                                                 ║
║  • Cardiology · routine · for ECG and stress test          ║
║                                                            ║
║                                                            ║
║  ┌────────────────────────────────────────────────────┐    ║
║  │ ✨ CLINICAL DECISION SUPPORT                         │  ← violet card
║  │ Generated from CDMSS · 304k clinical chunks ·        │
║  │ for your consideration                               │
║  │                                                      │
║  │ Investigation suggestions                            │
║  │ • Consider HbA1c, fasting lipid panel, urine ACR [1][2]
║  │   Rationale: given new T2DM diagnosis at 34y...      │
║  │ • [more]                                             │
║  │                                                      │
║  │ Treatment suggestions                                │
║  │ • [suggestion] [3]                                   │
║  │                                                      │
║  │ Referral suggestions                                 │
║  │ • [suggestion] [4]                                   │
║  │                                                      │
║  │ Follow-up suggestions                                │
║  │ • Repeat HbA1c in 3 months; clinic review 6 weeks    │
║  │                                                      │
║  │ References                                           │
║  │ [1] MKSAP 19 · Endocrinology · p.142                 │
║  │ [2] StatPearls · Diabetes management · 2024          │
║  │ [3] UpToDate · ASCVD risk assessment                 │
║  │ [4] PubMed · 36742891 · 2023                         │
║  └────────────────────────────────────────────────────┘    ║
║                                                            ║
║  ──────────────────────────────────────────────────────    ║
║                                                            ║
║  ▶ Open full encounter in app                              ║  ← deep link to library
║                                                            ║
║  Transcript (1,847 words)                                  ║
║  [collapsed by default in email — link to view             ║
║   in app, OR include below for completeness]               ║
║                                                            ║
╚═══════════════════════════════════════════════════════════╝

Footer: This email was generated by Even Encounter Assistant.
        For questions, contact v@evenheaven.in.
```

**Decision deferred to Figma stage:** whether the transcript renders inline in the email (long emails) or as a "View in app" link only (shorter emails, requires app access). My instinct is the latter for cleanliness, but V or Figma can decide based on stakeholder feedback.

---

### 8.3 Admin panel — desktop screens

The admin surface lives at `eta.llmvinayminihome.uk/{ADMIN_BASE_PATH}/`. Desktop-first multi-column layout. 9 screens total per §4.16.

#### 8.3.1 Admin landing (token entry)

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│              Even Encounter Assistant — Admin                │
│                                                              │
│   ┌─────────────────────────────────┐                        │
│   │ Admin token                     │                        │
│   │ [                             ] │                        │
│   │                                 │                        │
│   │       [ Sign in ]               │                        │
│   └─────────────────────────────────┘                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Simple. Token input → POST → if valid, set admin session cookie + redirect to 8.3.2. Otherwise generic "Invalid" message (no info leakage).

#### 8.3.2 Admin home (counts dashboard)

```
┌──────────────────────────────────────────────────────────────┐
│  Even ETA Admin     │ Doctors  Encounters  Traces  Sends  ⚙ │
├─────────────────────┴────────────────────────────────────────┤
│                                                              │
│  Welcome back, Admin.                                        │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │
│  │ Active        │ │ Encounters    │ │ Failed sends  │         │
│  │ doctors       │ │ today         │ │ pending retry │         │
│  │      3        │ │     14        │ │      1        │         │
│  └──────────────┘ └──────────────┘ └──────────────┘         │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐                          │
│  │ Locked-out    │ │ LLM error     │                          │
│  │ doctors       │ │ rate (24h)    │                          │
│  │      0        │ │     0.8%      │                          │
│  └──────────────┘ └──────────────┘                          │
│                                                              │
│  Recent activity                                             │
│  • 10:23 AM — Dr Vinay submitted encounter (Sarah, 34F)      │
│  • 10:15 AM — Dr Rohan started recording                     │
│  • 09:45 AM — Encounter send failed (will retry)             │
│  ...                                                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### 8.3.3 Doctors — list + profile

**List view:**

```
┌──────────────────────────────────────────────────────────────┐
│  Doctors                                    [+ Add doctor]   │
├──────────────────────────────────────────────────────────────┤
│  ┌─────────┬─────────────┬────────────┬──────────┬─────────┐ │
│  │ Name    │ Email       │ URL        │ Status   │ Actions │ │
│  ├─────────┼─────────────┼────────────┼──────────┼─────────┤ │
│  │ Vinay   │ vinay@...   │ /dr-vinay- │ Active   │ Edit    │ │
│  │ Bhardwaj│             │ 7k3p       │          │         │ │
│  │ Rohan   │ rohan@...   │ /dr-rohan- │ Active   │ Edit    │ │
│  │ Priya   │ priya@...   │ /dr-priya- │ Locked   │ Edit    │ │
│  └─────────┴─────────────┴────────────┴──────────┴─────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Profile / edit view:**

```
┌──────────────────────────────────────────────────────────────┐
│  ← Doctors / Dr Vinay Bhardwaj                               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Profile                                                     │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Name      [Dr Vinay Bhardwaj          ]              │    │
│  │ Email     [vinay@evenhospital.in      ]              │    │
│  │ Notes     [optional internal notes...]               │    │
│  │                                            [Save]    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  URL                                                         │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ eta.llmvinayminihome.uk/dr-vinay-7k3p                            │    │
│  │  [📋 Copy] [↻ Rotate token] [✉ Email URL to doctor] │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  PIN                                                         │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Set during onboarding                                │    │
│  │ Failed attempts: 0   |   Status: Active              │    │
│  │  [🔑 Reset PIN]  [🔓 Unlock account]                 │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Sessions                                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ 1 active session (last activity: 2 hours ago)        │    │
│  │  [Force logout]                                       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Lifecycle                                                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  [Disable doctor]   (red, with confirm modal)        │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**New doctor screen:** identical form layout to profile, but with a PIN field (input on creation) and no URL section yet (generated on save).

#### 8.3.4 Encounters

**List view:**

```
┌──────────────────────────────────────────────────────────────┐
│  Encounters                                                  │
│                                                              │
│  Filters: Doctor [All ▾]  Date [Last 7d ▾]  Status [All ▾]  │
├──────────────────────────────────────────────────────────────┤
│  ┌────────┬───────────┬──────────────┬──────────┬─────────┐ │
│  │ Time   │ Doctor    │ Patient      │ Duration │ Status  │ │
│  ├────────┼───────────┼──────────────┼──────────┼─────────┤ │
│  │ 10:23  │ Vinay     │ Sarah, 34F   │ 12 min   │ ✓ Sent  │ │
│  │ 09:45  │ Vinay     │ —            │ 8 min    │ ⚠ Fail  │ │
│  │ 09:14  │ Rohan     │ Mr Singh,    │ 7 min    │ ✓ Sent  │ │
│  │        │           │ 67M          │          │         │ │
│  └────────┴───────────┴──────────────┴──────────┴─────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Detail view:** same as doctor's 8.1.8 but with admin action footer:

```
┌──────────────────────────────────────────────────────────────┐
│  ← Encounters / Sarah Acharya, 34F                           │
│  Dr Vinay · 10:23 AM, 26 May 2026                            │
│                                                              │
│  Admin actions                                               │
│  [⟳ Retry send] [📋 View trace] [🗑 Delete encounter]        │
│                                                              │
│  [... full encounter content per 8.1.8 ...]                 │
└──────────────────────────────────────────────────────────────┘
```

#### 8.3.5 Traces (LLM dashboard + forensic)

**Dashboard view** — direct port from `OPD-Encounter-App/src/app/llm/dashboard/page.tsx`:

```
┌──────────────────────────────────────────────────────────────┐
│  LLM Traces                                                  │
│                                                              │
│  Surface       │ Count │ Errors │ p50    │ p90    │ Actions │
│  ──────────────┼───────┼────────┼────────┼────────┼─────────│
│  note-pipeline │ 247   │ 2      │ 24.1s  │ 38.7s  │ View    │
│  cdmss-analysis│ 247   │ 1      │ 41.2s  │ 58.9s  │ View    │
│  cleanup-live  │ 4,891 │ 12     │ 287ms  │ 612ms  │ View    │
│  cleanup-roll  │ 1,247 │ 5      │ 1.2s   │ 2.1s   │ View    │
│  transcribe    │ 247   │ 0      │ 14.7s  │ 22.1s  │ View    │
└──────────────────────────────────────────────────────────────┘
```

**Forensic detail** — direct port from `OPD-Encounter-App/src/app/llm/trace/[id]/page.tsx`. Per-stage event timeline with prompts, responses, latencies, errors.

#### 8.3.6 Sends

```
┌──────────────────────────────────────────────────────────────┐
│  Sends — delivery analytics                                  │
│                                                              │
│  Last 24h: 14 sent · 13 delivered · 1 failed · 0 bounced     │
│                                                              │
│  Per-recipient domain                                        │
│  evenhospital.in    14 / 14   100%                           │
│  evenheaven.in       7 / 8    87.5% (1 bounce)               │
│                                                              │
│  Failed sends (pending retry)                                │
│  ┌──────────┬──────────┬─────────────┬──────────────────┐    │
│  │ Time     │ Encounter│ Recipient   │ Error    Actions │    │
│  ├──────────┼──────────┼─────────────┼──────────────────┤    │
│  │ 09:45    │ #847     │ xyz@...     │ bounced  Retry   │    │
│  └──────────┴──────────┴─────────────┴──────────────────┘    │
│                                                              │
│  Resend status: ✓ Operational                                │
└──────────────────────────────────────────────────────────────┘
```

#### 8.3.7 Settings (sub-pages per §4.16)

- `/settings/global-cc` — simple list editor: add email, remove email, save
- `/settings/retention` — currently informational only (v1 = "Audio retained indefinitely. Doctor and admin deletion paths available."); v2 graduates to controls
- `/settings/resend` — read-only display of `RESEND_FROM_EMAIL`, sandbox/production toggle (hits a single env-driven setting)
- `/settings/health` — same probes as `/api/health` but with traffic-light visual: DB ✓, LLM tunnel ✓, Whisper tunnel ✓, KB ✓

---

### 8.4 Component patterns (shared library)

These components recur across the app — Figma should define each once as a master/component:

1. **Encounter card** (used in library list + admin encounter list) — title, subtitle, timestamp, duration, status badge, action chips
2. **Status badge** (sent/failed/queued/pending/deleted) — pill shape, color-coded, icon + label
3. **Pipeline progress card** (used in 8.1.6) — title, stage list with check/spinner/pending, progress bar, ETA
4. **Section card** (used in note + CDS) — title, content, optional accent border
5. **AI accent card** — section card variant with violet tint + ✨ icon (specifically for the CDS card; never used for non-AI content)
6. **Citation chip** — inline `[n]` superscript with tap-to-expand chunk preview popover
7. **CC picker modal** (8.1.5 + 8.1.8) — list of admin global CCs (checkbox, default checked) + free-form additions
8. **Recipient row** (8.1.8 detail) — "Sent to: a, b (CC)" with truncation + tap to expand
9. **Confirm modal** (delete, discard, end recording) — title, body, [Cancel] [Confirm/Destroy] (destroy is red when destructive)
10. **Toast** (success/error/info/warning) — top-anchored, auto-dismiss, color + icon per type
11. **Patient label field** — text input with placeholder, autocomplete-off attributes per §4.3 standard
12. **Numeric PIN pad** (8.1.1) — 3x4 grid, large tap targets, dots-indicator above
13. **Tab switcher** (Record / Library on 8.1.2 + 8.1.7) — pill-style, two options, active state
14. **Record button** — large circular primary action button, icon + label, multiple states (idle, processing, disabled)

---

### 8.5 Figma deliverable — design ledger (DELIVERED)

**File:** [Even Encounter Assistant — v1](https://www.figma.com/design/1MwbnF1HubCOyTEIn7EM5U)
**Status:** Complete · all surfaces locked · ready for build.

#### Pages

| Page              | Frames | Notes |
|-------------------|--------|-------|
| **Cover**         | 1      | Project name, version (v1.0), status (FINAL), last-updated date |
| **Design System** | 5 cards | Colors (blue/navy/pink/ink/violet/AI/semantic), typography (6 roles), spacing + radii, components (buttons × 5 × 3 states, cards × 3, status badges × 5, inputs × 4 states), iconography |
| **Mobile · Doctor app** | 11 screens × 5 variants = 55 frames | Per §8.1 |
| **Email template** | 4 frames | Inbox preview · desktop email · mobile email · design rationale |
| **Admin · Desktop** | 9 surfaces | Per §8.3 |
| **Flows**         | (followup) | Connector diagrams to be added during build |

#### Mobile screens (§8.1) — 11 × 5 variants

| § | Screen | Variants delivered |
|---|--------|--------------------|
| 8.1.1 | PIN entry | Default · Typing · Wrong PIN · Locked out · Account disabled |
| 8.1.2 | Home / Record start | Default · Patient typed · Pre-flight · Pending submit · Recovery card |
| 8.1.3 | Recording active | Active · Whisper polish · Reconnecting · Long transcript · Mid-edit |
| 8.1.4 | Recording paused | Paused · Edit mode · Resume confirm |
| 8.1.5 | Finalize / Review | Default · Patient editing · CC picker · CC added · Submitting |
| 8.1.6 | Submit processing | Dual-pipeline live with partial output materializing (italic gray) · twin cards (blue NOTE + violet CDMSS) · concentric thinking rings · asymmetric completion |
| 8.1.7 | Library list | Date-grouped · Search · With failed item · Empty state · Loading |
| 8.1.8 | Library detail | Top of detail · Note middle · CDMSS section · Citation expanded · Send failed |
| 8.1.9 | Settings | Main · Change PIN · Default recipients · Privacy & consent · Sign-out modal |
| 8.1.10 | Modals & toasts | Success toast · Error toast · Confirmation modal · Bottom sheet · Inline banner |
| 8.1.11 | Pre-flight offline modal | Failed · Retrying · Persistent · Offline confirmed · Reconnected |

#### Email template (§8.2)

Single page with 4 reference frames: Gmail-style inbox preview row · desktop 640w hero with full content · mobile 380w responsive single-column · design rationale panel with 10 numbered annotations. Subject format locked: `[Even] {patient_name}, {patient_demo} · {chief_complaint} · {date}`.

#### Admin desktop (§8.3) — 9 surfaces

| Surface | Route | Highlights |
|---------|-------|-----------|
| 1. **Dashboard** | `/` | 4 KPI cards with sparklines · "Needs your attention" triage panel with severity · 7-day encounters chart · 8-service system health card · recent activity feed |
| 2. **Doctors list** | `/doctors` | Status filter pills · sortable columns (last active, name, joined) · row-hover action menu (View profile · Email URL · Rotate URL · Reset PIN · Disable · Delete) · status pills color-coded · live-dot for recency |
| 3. **Doctor detail** | `/doctors/{id}` | Hero with avatar + actions · 4 quick KPIs · two-column body: Account & access (Edit fields, Send test, Copy URL, Rotate, Reset PIN, Device bindings) + Recent encounters / Default recipients + Audit log + Danger zone |
| 4. **Encounters list** | `/encounters` | Date-grouped table (Today / Yesterday / Earlier this week) · pipeline state distinct from send state · row-hover surfaces action menu (View · Resend · View LLM trace · Delete) |
| 5. **Encounter detail** | `/encounters/{id}` | Hero + 7-stage pipeline trace (Vercel-style: ring + ✓ + duration + model + detail per stage) + tabbed body (Note default · Transcript · CDMSS · Send · Audio · Audit) + right rail (Send status with per-recipient delivery timeline · 8-event audit log · danger zone) |
| 6. **LLM Traces list** | `/traces` | Cost dashboard + filter pills (stage · model · status · date) + table with mono trace IDs, prompt snippets, latency, tokens, cost |
| 7. **Trace detail** | `/traces/{id}` | Full prompt + completion in code blocks with line numbers and role-highlighted tags · 5-card metric strip (latency, input/output tokens, cost, model) · request params · timing breakdown (queue/prompt/gen) · sibling traces from same encounter |
| 8. **Sends** | `/sends` | Resend webhook event stream · KPIs (247 today · 99.6% deliverability · 61.9% open rate) · delivery funnel viz · status filters (All · Delivered · Opened · Bounced · Failed · Complained) · table with mono email IDs, recipients, subjects, status pills, open counts, links to parent encounters |
| 9. **Settings** | `/settings/*` | Vertical sub-nav (11 sub-pages × 4 groups: General · Operations · Observability · Security) · save bar appears only when dirty · Global CCs editor · Send rules with toggles · Email subject template with token highlighting + live preview |

#### Component patterns (§8.4) — built and reused

All 14 patterns from §8.4 are realized in the Figma file and used consistently across screens. Notably:
- The violet **AI accent card** appears in 4 places: mobile library detail CDMSS section, mobile submit processing twin card, email body AI block, encounter detail note panel CDMSS preview. Identical visual treatment in all four.
- The **Pipeline progress card** appears as the mobile dual-pipeline submit screen *and* the admin encounter detail 7-stage horizontal trace — same conceptual data, different layouts for context.

#### Design tokens — locked

- **Brand:** even.blue (50–950, primary 600 `#0055FF`), even.navy (50–950, brand 800 `#002054`), even.pink (50–900, brand 500 `#F96EB1`), even.ink (50–800 grayscale), even.white (`#FCFCFC` default, `#F9F8F4` cream)
- **AI:** Tailwind violet 50/100/200/300/600/700 — always with ✦ icon
- **Semantic:** emerald (success), amber (warning), red (danger)
- **Type:** Inter for UI, Roboto Mono for medical values and IDs
- **Radii:** sm 2 / md 6 (inputs) / lg 8 (cards) / xl 12 (modals + mobile buttons) / full (chips)
- **Spacing:** 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 64

---
## 9. Sprint plan

One engineer (full-time) + V as PM. Estimated 5 weeks of working days (~25 working days). Sprints are sequential; the system is shippable at the end of Sprint 4 but Sprint 5 hardens it.

### Sprint 0 — Setup (2 days)
- Repo init, monorepo or single Next.js 15 app on Vercel team `team_yu1wWpsKdjsf90haai1ETJDG` (bom1 / Mumbai)
- DNS for `eta.llmvinayminihome.uk` pointed to Vercel
- Provision Neon `APP_DATABASE` (separate from existing `KB_DATABASE`) · run §6 schema migrations
- Verify Cloudflare tunnels: `llm.llmvinayminihome.uk/v1` (Ollama) + `whisper.llmvinayminihome.uk`
- Resend account + domain verification + webhook endpoint URL configured
- R2 bucket for audio blobs · CORS for signed uploads
- CI: GitHub Actions, lint, type-check, deploy preview per PR
- Skeleton: PIN-entry page renders, admin login renders, `/api/health` returns service status

**Exit criteria:** All services reachable from production. CI green. One throwaway deploy lives at eta.llmvinayminihome.uk.

### Sprint 1 — Doctor recording loop (5 days)
- Mobile PWA shell: install prompt, offline shell, manifest, service worker
- §8.1.1 PIN entry → auth flow (bcrypt + JWT) with lockout escalation
- §8.1.2 Home / Record start with pre-flight checks (mic permission, network, services up)
- §8.1.3 Recording active with live transcript (Deepgram WebSocket primary, Whisper polish secondary per §4.2 hybrid)
- §8.1.4 Recording paused with edit-anytime transcript
- §8.1.5 Finalize / Review with patient label, CC picker
- §8.1.11 Pre-flight offline modal + dropout tolerance
- §8.1.10 Modals & toasts wired

**Exit criteria:** V records a complete encounter from PIN entry through finalize on his phone, with live transcript visible the whole time. Transcript matches audio to within minor cleanup edits.

### Sprint 2 — Pipeline + library (5 days)
- §8.1.6 Submit processing screen with live pipeline UI (dual cards, ETA estimate)
- Clean stage: llama3.1:8b via Ollama tunnel
- Critique + Revise stages: qwen2.5:14b
- CDMSS stage: parallel retrieval from `KB_DATABASE` (nomic-embed-text or mxbai-embed) + grounded analysis with citations
- §4.10 Medical Encounter Note schema enforced on note_json
- §4.11 CDMSS schema enforced on cdmss_json
- §8.1.7 Library list (date-grouped, search, empty states)
- §8.1.8 Library detail with citation chips and CDMSS section
- Soft delete from library
- §8.1.9 Settings: change PIN, default recipients view (read-only of admin globals)

**Exit criteria:** V records 5 encounters end-to-end. Each generates a structured note + CDMSS analysis with ≥1 citation. Library shows all 5 with correct grouping. Total pipeline p50 < 60s.

### Sprint 3 — Email + admin foundation (4 days)
- §8.2 Email template renderer (HTML + plaintext fallback)
- Resend integration: send API, webhook receiver, signature verification
- Send retry policy (3 retries exponential per locked default)
- Admin auth (email + password + bcrypt + JWT, separate from doctor auth)
- Admin sidebar shell + topbar with breadcrumb + search + notification + avatar
- Admin §8.3 Surface 1 Dashboard (KPIs, attention, chart, health, activity)
- Admin §8.3 Surface 2 Doctors list + filters + status pills
- Admin §8.3 Surface 3 Doctor detail + onboard flow (create doctor → generate URL → email URL)
- Audit log writes on every admin action

**Exit criteria:** Vinay onboards a second doctor via admin panel. That doctor records an encounter. Email arrives to V + records@even.in + the second doctor's per-doctor CC. Open events show up in Sends dashboard.

### Sprint 4 — Admin observability + remaining surfaces (4 days)
- Admin §8.3 Surface 4 Encounters list (cross-doctor, date-grouped, pipeline state separate from send state)
- Admin §8.3 Surface 5 Encounter detail (the investigation surface: hero, pipeline trace, tabbed body, send timeline, audit, danger zone)
- Admin §8.3 Surface 6+7 LLM Traces list + detail (full prompt + completion display)
- Admin §8.3 Surface 8 Sends (Resend webhook viz, delivery funnel, per-message detail)
- Admin §8.3 Surface 9 Settings (vertical sub-nav, global CCs, send rules, subject template with live preview)
- All admin tools audit-logged

**Exit criteria:** V can investigate any encounter from any angle (transcript, note, CDMSS, send, traces, audit) and retry/delete from the UI. The system explains itself.

### Sprint 5 — Hardening + launch (3 days)
- Performance: cold-start latencies on tunnel endpoints, request retry resilience, p95 latency budgets
- PIN lockout escalation production-hardened (rate limits, abuse logging)
- R2 deletion job for hard-deleted encounters
- `pin_attempt` 90-day TTL cron
- Documentation: README, runbook for ops, doctor onboarding script for V
- Soft launch: V's hospital, 3–5 doctors, daily standup with V for first week

**Exit criteria:** §10 launch metrics tracked. V signs off for broader rollout.

### Out of v1 (parked for v2)
- Formal compliance certification (HIPAA, DPDP audit pass) — see §4.20
- Multi-tenant hospital onboarding (different organizations)
- Native mobile apps (iOS/Android wrappers)
- Patient-facing portal
- Multi-language transcription (v1 is English + Hinglish via Whisper/Deepgram defaults)
- Per-encounter granular retention controls (v1 is keep-forever)

---
## 10. Success criteria

Two categories: **launch-day correctness** (table-stakes, must hold from day 1) and **30-day adoption** (the actual product validation).

### 10.1 Launch-day correctness

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Pipeline end-to-end completes | ≥99% of encounters | `encounter.status` reaches `complete` not `failed` |
| Email send success | ≥98% incl. retries | `send_event.status` reaches `sent`/`delivered` |
| Pipeline p50 latency | <60s recording-stop → email-sent | `trace` completion timestamps |
| Pipeline p95 latency | <90s | same |
| Audio data loss | 0 in tested offline scenarios | manual offline-recovery test pass |
| PIN auth median | <1s | `pin_attempt` timestamps |
| Admin panel actions audit-logged | 100% | `audit_log` row count == admin action count |
| Resend webhook reliability | 100% events processed | `send_event.updated_at` lag <30s |
| Cost per encounter | <$0.20 | `trace.cost_estimate_usd` sum |

### 10.2 30-day adoption

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Doctors onboarded | ≥5 | distinct `doctor.id` with ≥1 encounter |
| Total encounters | ≥50 | `encounter` row count |
| Active doctors (≥3 enc/wk) | ≥3 | doctors with rolling 7d count ≥3 |
| Transcript edits per encounter | median ≤1 manual correction | rough proxy: encounters where `transcript_clean` differs >5% from `transcript_raw` after doctor save |
| "Did not need to re-do this note" | qualitative ≥70% | V's structured feedback collection |
| Send open rate | ≥50% | `send_event.opened_at` not null / total sent |
| Investigation time on failures | <30s from dashboard to root cause | V self-reports |
| Doctor self-resolves PIN/URL issues without contacting V | ≥80% | inverse: count of doctor → V support pings |

### 10.3 Qualitative gates before broader rollout

- V personally uses the system on his own patients for ≥1 week before doctor #2 is onboarded
- 2 doctors beyond V describe the system as "saving time" in informal feedback
- Zero PHI leaks: no `audit_log` entries indicating unauthorized cross-doctor access
- Pipeline trace screen has been used by V to investigate ≥1 real failure successfully (proves the observability is enough)

### 10.4 Anti-goals (explicit non-criteria)

We are NOT optimizing for in v1:
- Throughput (multi-hospital scale)
- Sub-second pipeline latency (60s is fine for an async send-by-email model)
- Native app feel (PWA is the deliberate choice per §4.1)
- Custom UI per doctor (uniform across all)
- Patient-side anything

---

## 11. Handoff

This PRD is the contract between product (V) and engineering (build team). The Figma file ([link](https://www.figma.com/design/1MwbnF1HubCOyTEIn7EM5U)) is the visual specification. Where the two conflict, the PRD wins on behavior and Figma wins on visual treatment. Where genuinely ambiguous, ask V.

**Build order:** §9 sprints in sequence. Do not start Sprint N+1 until Sprint N exit criteria pass.

**Open items at PRD v1.0 finalization (26 May 2026):** none in scope; all v1 questions resolved. v2 items are parked in §9 out-of-v1 list and §4.20 compliance posture.
