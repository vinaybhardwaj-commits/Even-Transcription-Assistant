/**
 * SystemMap — a custom, code-derived architecture infographic for the Evenscribe
 * (ETA) system. Static (no data fetch). Architecture-overview depth.
 */
import * as React from "react";

type TierKey = "client" | "vercel" | "neon" | "r2" | "mini" | "third";
const TIERS: Record<TierKey, { label: string; color: string }> = {
  client: { label: "Browser / PWA", color: "#4f46e5" },
  vercel: { label: "Vercel · Next API", color: "#0f172a" },
  neon: { label: "Neon Postgres", color: "#16a34a" },
  r2: { label: "Cloudflare R2", color: "#ea580c" },
  mini: { label: "Mac Mini backend", color: "#9333ea" },
  third: { label: "Third-party API", color: "#0891b2" },
};

type Stage = { n: number; title: string; detail: string; tiers: TierKey[]; tech?: string[] };
const PHASES: Array<{ phase: string; blurb: string; stages: Stage[] }> = [
  {
    phase: "A · Capture",
    blurb: "On the doctor's phone — the red Record button to the moment they tap Stop.",
    stages: [
      { n: 1, title: "Preflight & auto-start", detail: "/{slug}/record loads. PreflightCheck probes /api/health and tests that IndexedDB is writable; an encounter row is created (status=draft); RecordingScreen AUTO-STARTS the recorder — the big button is Stop, not Start.", tiers: ["client", "vercel"], tech: ["Next.js PWA", "PreflightCheck"] },
      { n: 2, title: "Record continuously", detail: "MediaRecorder captures the mic for the whole visit and emits a chunk every 250ms (WebM/Opus). Pause is a soft-pause — recording keeps running, emission is gated.", tiers: ["client"], tech: ["MediaRecorder", "250ms timeslice"] },
      { n: 3, title: "Live transcript (parallel, non-blocking)", detail: "Each chunk fans out to the live engines so the doctor sees text immediately. None of this is the saved note — it's the on-screen preview.", tiers: ["client", "third", "mini"], tech: ["Deepgram", "Sarvam", "Whisper", "Speaker-ID"] },
      { n: 4, title: "Persist locally", detail: "Every chunk is written to IndexedDB (durable on-device) AND a parallel in-memory failsafe buffer, so a dead IndexedDB (iOS Safari Private Browsing) can't lose the audio.", tiers: ["client"], tech: ["IndexedDB", "in-mem failsafe"] },
    ],
  },
  {
    phase: "B · Submit & store",
    blurb: "Tap Stop → the recording becomes one durable file in object storage.",
    stages: [
      { n: 5, title: "Submit", detail: "All chunks are concatenated into ONE WebM blob. The client asks /upload-url for a presigned R2 PUT, uploads the blob DIRECTLY to R2 (bypassing the 4.5MB serverless body limit), then calls /finalize-upload.", tiers: ["client", "vercel", "r2"], tech: ["presigned PUT", "finalize-upload"] },
      { n: 6, title: "Audio stored + status flips", detail: "finalize-upload records audio_object_key / bytes / duration and sets status=processing. The audio lives as one object per encounter at encounters/<id>.webm — retained indefinitely.", tiers: ["r2", "neon"], tech: ["encounters/<id>.webm"] },
    ],
  },
  {
    phase: "C · Process",
    blurb: "Server-side (Vercel after() / background) — raw audio becomes a finished clinical note.",
    stages: [
      { n: 7, title: "Batch translate (non-English)", detail: "For Indian-language consults, the whole conversation is re-translated full-file by Sarvam into clean English (soft-fail back to the live transcript if unavailable).", tiers: ["vercel", "third"], tech: ["Sarvam translate"] },
      { n: 8, title: "Transcript cleanup", detail: "An LLM pass strips non-clinical lead-in (waiting-room chatter, ads) and produces the clean transcript the note is built from.", tiers: ["vercel", "mini"], tech: ["LLM cleanup"] },
      { n: 9, title: "Diarization + speaker ID (non-blocking)", detail: "pyannote on the Mac Mini segments who-spoke-when; segments are reconciled with the engine's diarized utterances; the clinician is NAMED by cosine-matching their enrolled voiceprint. Never blocks the note.", tiers: ["mini"], tech: ["pyannote", "voiceprint cosine"] },
      { n: 10, title: "Note generation", detail: "qwen2.5:14b (Ollama on the Mac Mini) turns the clean transcript into the structured Medical Encounter Note — chief complaint, history, assessment, plan.", tiers: ["mini"], tech: ["qwen2.5:14b"] },
      { n: 11, title: "Clinical decision support → complete", detail: "llama3.1:8b plus KB retrieval (pgvector over ~304k MKSAP/StatPearls chunks) generates the CDS / CDMSS card. status=complete.", tiers: ["mini", "neon"], tech: ["llama3.1:8b", "RAG / pgvector"] },
    ],
  },
  {
    phase: "D · Deliver & observe",
    blurb: "The note goes out, delivery is tracked, and the system watches itself.",
    stages: [
      { n: 12, title: "Send the note", detail: "An admin or the doctor picks recipients; the email template is rendered; Resend is called once per recipient (a 90s dedup guard stops double-sends). One send_event row per recipient.", tiers: ["vercel", "third"], tech: ["Resend", "send_event"] },
      { n: 13, title: "Delivery webhooks", detail: "Resend posts delivered / opened / bounced / complained / failed back to /api/webhooks/resend, which updates send_event — replay-guarded (svix timestamp) and negative statuses are sticky.", tiers: ["third", "vercel"], tech: ["svix webhook"] },
      { n: 14, title: "Observe & self-heal", detail: "Every privileged action writes to audit_log; LLM calls are traced; the STT Engine Lab scores engines offline; an hourly Vercel cron reaps any encounter stuck in 'processing'.", tiers: ["vercel", "neon"], tech: ["audit_log", "STT Lab", "reaper cron"] },
    ],
  },
];

const LIVE_ENGINES: Array<{ name: string; tier: TierKey; role: string }> = [
  { name: "Deepgram (live WS)", tier: "third", role: "English real-time transcript; short-lived minted token, optional auto-reconnect." },
  { name: "Sarvam (rolling REST)", tier: "third", role: "Indian-language transcript; growing-window 'refine + commit' (~2s tail)." },
  { name: "Whisper.cpp (rolling)", tier: "mini", role: "Robust safety-net transcript; delta uploads concatenated server-side in an R2 buffer." },
  { name: "Speaker-identify", tier: "mini", role: "Live 'you / other voice' cue from the doctor's enrolled voiceprint." },
];

const INFRA: Array<{ group: string; tier: TierKey; items: Array<{ k: string; v: string }> }> = [
  { group: "Client", tier: "client", items: [
    { k: "Next.js 15.5 + React 19 PWA", v: "mobile-first; installable; service worker (network-first)" },
    { k: "MediaRecorder + IndexedDB", v: "capture + on-device durable chunk store" },
  ] },
  { group: "Hosting & compute", tier: "vercel", items: [
    { k: "Vercel Pro (region bom1)", v: "Node serverless API; auto-deploy on push to main" },
    { k: "Vercel Cron", v: "hourly stuck-encounter reaper" },
  ] },
  { group: "Data", tier: "neon", items: [
    { k: "Neon Postgres (HTTP driver)", v: "app database (encounters, sends, lab, audit)" },
    { k: "Neon KB (pgvector)", v: "~304k MKSAP / StatPearls / UpToDate chunks for RAG" },
  ] },
  { group: "Object storage", tier: "r2", items: [
    { k: "Cloudflare R2 (S3-compatible)", v: "original encounter audio; presigned PUT/GET" },
  ] },
  { group: "Self-hosted backend (Mac Mini, HTTPS tunnels)", tier: "mini", items: [
    { k: "whisper.cpp", v: "rolling + batch STT safety net" },
    { k: "pyannote", v: "speaker diarization" },
    { k: "Sarvam STT relay + voiceprint enroll/identify", v: "streaming relay; clinician voiceprints" },
    { k: "Ollama", v: "hosts qwen2.5:14b (note) + llama3.1:8b (CDS)" },
  ] },
  { group: "Third-party APIs", tier: "third", items: [
    { k: "Deepgram / Sarvam / eka.care", v: "live + batch + scribe STT engines" },
    { k: "Resend", v: "transactional email + delivery webhooks" },
    { k: "OpenAI / ElevenLabs", v: "LLM fallback; STT-lab comparison engine" },
  ] },
];

const TABLES: Array<{ name: string; purpose: string }> = [
  { name: "encounter", purpose: "the consult: status, audio key, transcripts, note_json, cdmss_json, diarize_*, send_status" },
  { name: "clinician", purpose: "doctors — url_slug, bcrypt PIN, enrolled voiceprint link" },
  { name: "admin_user", purpose: "admins — email, bcrypt password, role=super (all equal)" },
  { name: "send_event", purpose: "one row per recipient per send + delivery status" },
  { name: "recipient_global / _per_doctor", purpose: "recipient address books" },
  { name: "transcription_run", purpose: "STT Engine Lab — per-engine ASR/scribe runs + scores" },
  { name: "stt_engine / _routing / _gold", purpose: "engine registry, routing, gold-standard labels" },
  { name: "stt_fanout_job / _lab_config", purpose: "offline scoring queue + daily budget config" },
  { name: "voice_print / voice_sample", purpose: "clinician voiceprint centroids + enrollment clips" },
  { name: "audit_log", purpose: "every privileged action (creates, resends, audio access…)" },
  { name: "trace / llm_traces", purpose: "per-call LLM tracing for the Observe surfaces" },
  { name: "settings / pin_attempt / identification_label", purpose: "config, PIN lockout, speaker labels" },
];

const ALGOS: Array<{ name: string; detail: string }> = [
  { name: "Continuous 250ms chunking", detail: "one MediaRecorder for the whole visit; soft-pause; chunks are the unit of capture, persistence and live STT." },
  { name: "Audio failsafe", detail: "IndexedDB + parallel in-memory buffer; tolerant read at submit; recovers when IndexedDB is unavailable (iOS Private Browsing)." },
  { name: "Whisper rolling buffer", detail: "client sends only NEW chunks; server appends to a per-encounter R2 buffer and runs whisper on the full concatenation — no body-size cap." },
  { name: "Sarvam 'refine + commit'", detail: "re-transcribes a small uncommitted window every ~2s so words self-heal across tick boundaries; commits (freezes) near the 22s cap." },
  { name: "Diarization + voiceprint ID", detail: "pyannote segments speakers; reconciled with engine utterances; the clinician is named by cosine similarity to their enrolled centroid." },
  { name: "Note → CDS (LLM)", detail: "structured extraction with qwen2.5:14b → clinical decision support with llama3.1:8b grounded by pgvector KB retrieval." },
  { name: "STT Engine Lab scoring", detail: "reference-free inter-engine agreement + an LLM-judge rubric; WER/CER/medical-term-recall; daily budget; atomic FOR-UPDATE-SKIP-LOCKED queue claim." },
  { name: "Delivery integrity", detail: "90s email idempotency window; webhook replay guard; negative delivery statuses are sticky; hourly reaper clears stuck encounters." },
];

function TierDot({ t }: { t: TierKey }) {
  return <span className="sm-tier"><span className="sm-dot" style={{ background: TIERS[t].color }} />{TIERS[t].label}</span>;
}

export function SystemMap() {
  return (
    <div className="sm-wrap">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header className="sm-head">
        <h1>Evenscribe — System Map</h1>
        <p>How a consult flows from the red <b>Record</b> button to the delivered note — and the infrastructure, data model, and algorithms behind it. Architecture overview, generated from the codebase.</p>
        <div className="sm-stack">
          {(["client", "vercel", "neon", "r2", "mini", "third"] as TierKey[]).map((t) => (
            <span key={t} className="sm-legend"><span className="sm-dot" style={{ background: TIERS[t].color }} />{TIERS[t].label}</span>
          ))}
        </div>
      </header>

      {/* Pipeline */}
      <section>
        <h2 className="sm-h2">End-to-end pipeline</h2>
        <div className="sm-flow">
          {PHASES.map((ph, pi) => (
            <div key={ph.phase} className="sm-phase">
              <div className="sm-phase-head"><span className="sm-phase-tag">{ph.phase}</span><span className="sm-phase-blurb">{ph.blurb}</span></div>
              {ph.stages.map((st) => (
                <div key={st.n} className="sm-stage" style={{ borderLeftColor: TIERS[st.tiers[0]].color }}>
                  <div className="sm-stage-n" style={{ background: TIERS[st.tiers[0]].color }}>{st.n}</div>
                  <div className="sm-stage-body">
                    <div className="sm-stage-title">{st.title}</div>
                    <div className="sm-stage-detail">{st.detail}</div>
                    {st.n === 3 ? (
                      <div className="sm-engines">
                        {LIVE_ENGINES.map((e) => (
                          <div key={e.name} className="sm-engine" style={{ borderColor: TIERS[e.tier].color + "55" }}>
                            <span className="sm-dot" style={{ background: TIERS[e.tier].color }} />
                            <b>{e.name}</b> — {e.role}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="sm-stage-meta">
                      <span className="sm-tiers">{st.tiers.map((t) => <TierDot key={t} t={t} />)}</span>
                      {st.tech ? <span className="sm-techs">{st.tech.map((tc) => <span key={tc} className="sm-chip">{tc}</span>)}</span> : null}
                    </div>
                  </div>
                </div>
              ))}
              {pi < PHASES.length - 1 ? <div className="sm-arrow">↓</div> : null}
            </div>
          ))}
        </div>
      </section>

      {/* Infra */}
      <section>
        <h2 className="sm-h2">Infrastructure & dependencies</h2>
        <div className="sm-grid sm-grid-2">
          {INFRA.map((g) => (
            <div key={g.group} className="sm-card" style={{ borderTopColor: TIERS[g.tier].color }}>
              <div className="sm-card-h"><span className="sm-dot" style={{ background: TIERS[g.tier].color }} />{g.group}</div>
              {g.items.map((it) => (
                <div key={it.k} className="sm-kv"><b>{it.k}</b><span>{it.v}</span></div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* Data model */}
      <section>
        <h2 className="sm-h2">Data model — key tables</h2>
        <div className="sm-grid sm-grid-2">
          {TABLES.map((t) => (
            <div key={t.name} className="sm-row"><code>{t.name}</code><span>{t.purpose}</span></div>
          ))}
        </div>
      </section>

      {/* Algorithms */}
      <section>
        <h2 className="sm-h2">Key algorithms</h2>
        <div className="sm-grid sm-grid-2">
          {ALGOS.map((a) => (
            <div key={a.name} className="sm-card sm-algo"><div className="sm-algo-name">{a.name}</div><div className="sm-algo-detail">{a.detail}</div></div>
          ))}
        </div>
      </section>

      <footer className="sm-foot">Architecture overview · derived from the codebase. Deeper detail: the bug log at <code>/buglog</code> and the PRDs. This page is a living map — update it as the system evolves.</footer>
    </div>
  );
}

const CSS = `
.sm-wrap { max-width: 1080px; color: #0f172a; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.sm-head { margin-bottom: 28px; }
.sm-head h1 { font-size: 24px; font-weight: 800; margin: 0 0 6px; color: #0f172a; }
.sm-head p { color: #475569; max-width: 760px; margin: 0 0 12px; }
.sm-stack { display: flex; flex-wrap: wrap; gap: 8px; }
.sm-legend, .sm-tier { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #475569; background: #f1f5f9; border-radius: 999px; padding: 3px 9px; }
.sm-dot { width: 9px; height: 9px; border-radius: 999px; display: inline-block; flex: none; }
.sm-h2 { font-size: 16px; font-weight: 700; margin: 34px 0 14px; color: #0f172a; }
.sm-flow { }
.sm-phase { }
.sm-phase-head { display: flex; align-items: baseline; gap: 10px; margin: 4px 0 10px; flex-wrap: wrap; }
.sm-phase-tag { font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #0f172a; background: #e2e8f0; border-radius: 6px; padding: 3px 8px; }
.sm-phase-blurb { font-size: 12.5px; color: #64748b; }
.sm-stage { display: flex; gap: 12px; background: #fff; border: 1px solid #e5e7eb; border-left: 4px solid #888; border-radius: 12px; padding: 14px 16px; margin: 0 0 10px; }
.sm-stage-n { flex: none; width: 26px; height: 26px; border-radius: 999px; color: #fff; font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center; }
.sm-stage-title { font-weight: 700; font-size: 14.5px; margin-bottom: 2px; }
.sm-stage-detail { color: #475569; font-size: 13px; }
.sm-stage-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; align-items: center; }
.sm-tiers { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.sm-techs { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.sm-chip { font-size: 11px; background: #0f172a; color: #fff; border-radius: 6px; padding: 2px 8px; opacity: .82; }
.sm-arrow { text-align: center; color: #94a3b8; font-size: 20px; margin: 2px 0 14px; }
.sm-engines { margin: 10px 0 2px; display: grid; gap: 6px; }
.sm-engine { font-size: 12px; color: #475569; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 10px; display: flex; align-items: center; gap: 7px; }
.sm-engine b { color: #0f172a; }
.sm-grid { display: grid; gap: 12px; }
.sm-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sm-card { background: #fff; border: 1px solid #e5e7eb; border-top: 3px solid #888; border-radius: 12px; padding: 14px 16px; }
.sm-card-h { font-weight: 700; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.sm-kv { display: flex; flex-direction: column; padding: 5px 0; border-top: 1px solid #f1f5f9; }
.sm-kv b { font-size: 13px; color: #0f172a; }
.sm-kv span { font-size: 12px; color: #64748b; }
.sm-row { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; }
.sm-row code { background: #eef2ff; color: #4338ca; border-radius: 5px; padding: 1px 6px; font-size: 12.5px; font-weight: 600; }
.sm-row span { display: block; color: #64748b; font-size: 12px; margin-top: 3px; }
.sm-algo { border-top-color: #6366f1; }
.sm-algo-name { font-weight: 700; font-size: 13.5px; margin-bottom: 3px; }
.sm-algo-detail { color: #475569; font-size: 12.5px; }
.sm-foot { margin: 30px 0 8px; color: #94a3b8; font-size: 12px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
.sm-foot code { background: #f1f5f9; border-radius: 4px; padding: 1px 5px; }
@media (max-width: 720px) { .sm-grid-2 { grid-template-columns: 1fr; } }
`;
