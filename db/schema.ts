import {
  pgTable, pgEnum, uuid, text, integer, boolean, jsonb, timestamp,
  numeric, inet, index, primaryKey, doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

// citext custom type — Postgres case-insensitive text
const citext = customType<{ data: string; driverData: string }>({
  dataType() { return "citext"; },
});

// bytea — Postgres binary (voice_print ECAPA centroid: 192 float32 = 768 bytes)
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
});

// ----------------------- ENUMS -----------------------
export const adminRole       = pgEnum("admin_role", ["super", "ops"]);
export const doctorStatus    = pgEnum("doctor_status", ["active", "disabled", "locked"]);
export const encounterStatus = pgEnum("encounter_status", ["draft", "processing", "complete", "failed", "deleted", "draft_partial"]);
export const sendStatusEnum  = pgEnum("send_status", ["pending", "sent", "failed"]);
export const sendEventStatus = pgEnum("send_event_status", ["queued", "sent", "delivered", "opened", "bounced", "complained", "failed"]);
export const traceStage      = pgEnum("trace_stage", ["capture", "transcribe", "clean", "critique", "revise", "cdmss", "email"]);
export const traceStatus     = pgEnum("trace_status", ["ok", "warn", "fail"]);
export const recipientRole   = pgEnum("recipient_role", ["admin", "records", "finance", "compliance", "other"]);
export const recipientSetBy  = pgEnum("recipient_set_by", ["admin", "doctor"]);
export const actorType       = pgEnum("actor_type", ["admin", "doctor", "system"]);
export const retryBackoff    = pgEnum("retry_backoff", ["linear", "exponential"]);
export const clinicianType   = pgEnum("clinician_type", ["physician", "dietitian", "physiotherapist"]); // V2.S0 (0010)
export const noteType        = pgEnum("note_type", ["clinic_encounter", "general_medical", "operative_procedure", "dietetic_consult", "physiotherapy"]); // V2.S0 (0011)

// ----------------------- TABLES -----------------------

// admin_user (PRD §6.1)
export const adminUser = pgTable("admin_user", {
  id:             uuid("id").defaultRandom().primaryKey(),
  email:          citext("email").notNull().unique(),
  name:           text("name").notNull(),
  passwordHash:   text("password_hash").notNull(),
  role:           adminRole("role").notNull().default("super"),
  lastActiveAt:   timestamp("last_active_at", { withTimezone: true }),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// doctor (PRD §6.1, §4.14, §4.15)
export const doctor = pgTable("doctor", {
  id:               text("id").primaryKey(), // doc_<8-char nanoid>
  fullName:         text("full_name").notNull(),
  email:            citext("email").notNull().unique(),
  phone:            text("phone"),
  emailShowConversationWith: boolean("email_show_conversation_with").notNull().default(false), // SD-Q4 (v2.1)
  urlSlug:          text("url_slug").notNull().unique(),
  urlToken:         text("url_token").notNull(),
  pinHash:          text("pin_hash"),
  pinSetAt:         timestamp("pin_set_at", { withTimezone: true }),
  failedPinCount:   integer("failed_pin_count").notNull().default(0),
  lockedUntil:      timestamp("locked_until", { withTimezone: true }),
  status:           doctorStatus("status").notNull().default("active"),
  lastActiveAt:     timestamp("last_active_at", { withTimezone: true }),
  joinedAt:         timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy:        uuid("created_by").notNull().references(() => adminUser.id),
  deletedAt:        timestamp("deleted_at", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUrlSlug:      index("idx_doctor_url_slug").on(t.urlSlug),
  byEmail:        index("idx_doctor_email").on(t.email),
  byStatusActive: index("idx_doctor_status_active").on(t.status, t.lastActiveAt),
}));

// clinician (V2.S0, migration 0010) — generalizes doctor. ADDITIVE: doctor stays
// the read path until V2.S6; clinician.id == doctor.id for copied rows.
export const clinician = pgTable("clinician", {
  id:               text("id").primaryKey(), // = source doctor id
  legacyDoctorId:   text("legacy_doctor_id").unique(),
  clinicianType:    clinicianType("clinician_type").notNull().default("physician"),
  fullName:         text("full_name").notNull(),
  email:            citext("email").notNull().unique(),
  phone:            text("phone"),
  emailShowConversationWith: boolean("email_show_conversation_with").notNull().default(false),
  urlSlug:          text("url_slug").notNull().unique(),
  urlToken:         text("url_token").notNull(),
  pinHash:          text("pin_hash"),
  pinSetAt:         timestamp("pin_set_at", { withTimezone: true }),
  failedPinCount:   integer("failed_pin_count").notNull().default(0),
  lockedUntil:      timestamp("locked_until", { withTimezone: true }),
  status:           doctorStatus("status").notNull().default("active"),
  lastActiveAt:     timestamp("last_active_at", { withTimezone: true }),
  joinedAt:         timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy:        uuid("created_by").references(() => adminUser.id),
  deletedAt:        timestamp("deleted_at", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUrlSlug:      index("idx_clinician_url_slug").on(t.urlSlug),
  byEmail:        index("idx_clinician_email").on(t.email),
  byType:         index("idx_clinician_type").on(t.clinicianType),
  byStatusActive: index("idx_clinician_status_active").on(t.status, t.lastActiveAt),
}));

// pin_attempt (PRD §6.1 — 90d TTL via cron)
export const pinAttempt = pgTable("pin_attempt", {
  id:         uuid("id").defaultRandom().primaryKey(),
  doctorId:   text("doctor_id").notNull().references(() => doctor.id),
  success:    boolean("success").notNull(),
  ip:         inet("ip"),
  userAgent:  text("user_agent"),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byDoctorTime: index("idx_pin_attempt_doctor_time").on(t.doctorId, t.createdAt),
}));

// encounter (PRD §6.1, §4.4, §4.9, §4.10)
export const encounter = pgTable("encounter", {
  id:                  text("id").primaryKey(), // enc_<10-char nanoid>
  doctorId:            text("doctor_id").notNull().references(() => doctor.id),
  noteType:            noteType("note_type").notNull().default("clinic_encounter"), // V2.S0 (0011)
  patientLabelRaw:     text("patient_label_raw"),
  patientAge:          integer("patient_age"),
  patientSex:          text("patient_sex"),
  chiefComplaint:      text("chief_complaint"),
  recordedAt:          timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  durationSeconds:     integer("duration_seconds"),
  status:              encounterStatus("status").notNull().default("draft"),
  audioObjectKey:      text("audio_object_key"),
  audioBytes:          integer("audio_bytes"),
  transcriptRaw:       text("transcript_raw"),
  transcriptClean:     text("transcript_clean"),
  detectedLanguage:    text("detected_language"),
  transcriptOriginal:  text("transcript_original"),
  // v2.1 speaker diarization (migration 0007)
  speakers:            jsonb("speakers"),
  transcriptSegments:  jsonb("transcript_segments"),
  overlapWindows:      jsonb("overlap_windows"),
  manualRelabels:      jsonb("manual_relabels").notNull().default(sql`'[]'::jsonb`),
  aggregates:          jsonb("aggregates"),
  taggedTranscript:    jsonb("tagged_transcript"),
  micDeviceId:         text("mic_device_id"),
  diarizeStatus:       text("diarize_status"), // pending|running|complete|skipped|failed
  diarizeStartedAt:    timestamp("diarize_started_at", { withTimezone: true }),
  diarizeCompletedAt:  timestamp("diarize_completed_at", { withTimezone: true }),
  diarizeError:        text("diarize_error"),
  diarizeUsedBuffer:   boolean("diarize_used_buffer").notNull().default(false),
  noteJson:            jsonb("note_json"),
  noteJsonEdited:      jsonb("note_json_edited"),
  cdmssJson:           jsonb("cdmss_json"),
  sendStatus:          sendStatusEnum("send_status").notNull().default("pending"),
  sentAt:              timestamp("sent_at", { withTimezone: true }),
  retryCount:          integer("retry_count").notNull().default(0),
  deletedAt:           timestamp("deleted_at", { withTimezone: true }),
  createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byDoctorRecorded: index("idx_enc_doctor_recorded").on(t.doctorId, t.recordedAt),
  byStatus:         index("idx_enc_status_recorded").on(t.status, t.recordedAt),
  bySendStatus:     index("idx_enc_send_status").on(t.sendStatus, t.recordedAt),
}));

// trace (PRD §6.1, §4.11, §4.16)
export const trace = pgTable("trace", {
  id:               text("id").primaryKey(), // trace_<6-char nanoid>
  encounterId:      text("encounter_id").notNull().references(() => encounter.id, { onDelete: "cascade" }),
  stage:            traceStage("stage").notNull(),
  model:            text("model").notNull(),
  promptFull:       text("prompt_full"),
  responseFull:     text("response_full"),
  inputTokens:      integer("input_tokens"),
  outputTokens:     integer("output_tokens"),
  latencyMs:        integer("latency_ms"),
  costEstimateUsd:  numeric("cost_estimate_usd", { precision: 10, scale: 5 }),
  status:           traceStatus("status").notNull(),
  errorMessage:     text("error_message"),
  metadataJson:     jsonb("metadata_json"),
  startedAt:        timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:      timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  byEncStarted: index("idx_trace_enc_started").on(t.encounterId, t.startedAt),
  byStageDone:  index("idx_trace_stage_completed").on(t.stage, t.completedAt),
  byStatusTime: index("idx_trace_status_started").on(t.status, t.startedAt),
}));

// recipient_global (PRD §6.1, §4.13)
export const recipientGlobal = pgTable("recipient_global", {
  id:         uuid("id").defaultRandom().primaryKey(),
  email:      citext("email").notNull(),
  name:       text("name").notNull(),
  role:       recipientRole("role").notNull(),
  active:     boolean("active").notNull().default(true),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy:  uuid("created_by").notNull().references(() => adminUser.id),
});

// recipient_per_doctor (PRD §6.1, §4.13)
export const recipientPerDoctor = pgTable("recipient_per_doctor", {
  id:         uuid("id").defaultRandom().primaryKey(),
  doctorId:   text("doctor_id").notNull().references(() => doctor.id),
  email:      citext("email").notNull(),
  name:       text("name").notNull(),
  role:       recipientRole("role").notNull(),
  setBy:      recipientSetBy("set_by").notNull(),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// send_event (PRD §6.1, §4.13)
export const sendEvent = pgTable("send_event", {
  id:                text("id").primaryKey(), // em_<9-char nanoid> — surfaced in sends UI
  encounterId:       text("encounter_id").notNull().references(() => encounter.id, { onDelete: "cascade" }),
  recipientEmail:    citext("recipient_email").notNull(),
  recipientRole:     text("recipient_role"),
  subjectRendered:   text("subject_rendered").notNull(),
  resendMessageId:   text("resend_message_id"),
  status:            sendEventStatus("status").notNull().default("queued"),
  openedAt:          timestamp("opened_at", { withTimezone: true }),
  bouncedAt:         timestamp("bounced_at", { withTimezone: true }),
  complainedAt:      timestamp("complained_at", { withTimezone: true }),
  failureReason:     text("failure_reason"),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byEncounter:    index("idx_se_encounter").on(t.encounterId),
  byStatusTime:   index("idx_se_status_created").on(t.status, t.createdAt),
  byResendMsgId:  index("idx_se_resend_msg_id").on(t.resendMessageId),
}));

// audit_log (PRD §6.1, §4.16, §4.20)
export const auditLog = pgTable("audit_log", {
  id:           uuid("id").defaultRandom().primaryKey(),
  actorType:    actorType("actor_type").notNull(),
  actorId:      text("actor_id"),
  action:       text("action").notNull(), // namespaced: doctor.create, pin.reset, etc.
  targetType:   text("target_type").notNull(),
  targetId:     text("target_id"),
  metadataJson: jsonb("metadata_json"),
  ip:           inet("ip"),
  userAgent:    text("user_agent"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byTargetTime: index("idx_audit_target_time").on(t.targetType, t.targetId, t.createdAt),
  byActorTime:  index("idx_audit_actor_time").on(t.actorId, t.createdAt),
}));

// settings (PRD §6.1) — singleton, id = 1
export const settings = pgTable("settings", {
  id:                  integer("id").primaryKey().default(1),
  subjectTemplate:     text("subject_template").notNull().default("[Even] {patient_name}, {patient_demo} - {chief_complaint} - {date}"),
  includePatientOnSend: boolean("include_patient_on_send").notNull().default(false),
  sendDrafts:          boolean("send_drafts").notNull().default(false),
  blockOnCritiqueFail: boolean("block_on_critique_fail").notNull().default(true),
  retryPolicyMax:      integer("retry_policy_max").notNull().default(3),
  retryPolicyBackoff:  retryBackoff("retry_policy_backoff").notNull().default("exponential"),
  resendFromEmail:     text("resend_from_email"),
  updatedAt:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy:           uuid("updated_by"),
  // Sprint 12: manual attestation for PRD §10.1 audio-data-loss criterion
  audioOfflineTestPassed: boolean("audio_offline_test_passed").notNull().default(false),
  audioOfflineTestAt:     timestamp("audio_offline_test_at", { withTimezone: true }),
  audioOfflineTestBy:     uuid("audio_offline_test_by"),
});


// transcription_run (migration 0006) — multi-engine comparison testbed log.
// One row per engine per encounter (Deepgram | Whisper | Sarvam | ...).
export const transcriptionRun = pgTable("transcription_run", {
  id:                  text("id").primaryKey(), // trun_<nanoid>
  encounterId:         text("encounter_id").notNull().references(() => encounter.id, { onDelete: "cascade" }),
  engine:              text("engine").notNull(),
  mode:                text("mode").notNull(), // live | submit | batch
  detectedLanguage:    text("detected_language"),
  transcriptOriginal:  text("transcript_original"),
  transcriptEnglish:   text("transcript_english"),
  latencyMs:           integer("latency_ms"),
  judgeScore:          numeric("judge_score", { precision: 4, scale: 2 }),
  isWinner:            boolean("is_winner").notNull().default(false),
  error:               text("error"),
  // STT Engine Lab (migration 0019) — tier + per-engine id + cost + scoring + scribe note
  tier:                text("tier").notNull().default("asr"), // asr | scribe
  sttEngineId:         text("stt_engine_id"),
  costUsd:             numeric("cost_usd", { precision: 10, scale: 5 }),
  wer:                 doublePrecision("wer"),
  cer:                 doublePrecision("cer"),
  medTermRecall:       doublePrecision("med_term_recall"),
  agreementScore:      doublePrecision("agreement_score"),
  noteText:            text("note_text"),
  noteJson:            jsonb("note_json"),
  metricsJson:         jsonb("metrics_json").notNull().default(sql`'{}'::jsonb`),
  createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byEncounter: index("idx_transcription_run_encounter").on(t.encounterId, t.createdAt),
}));

// stt_fanout_job (migration 0019) — one offline fan-out job per encounter.
export const sttFanoutJob = pgTable("stt_fanout_job", {
  encounterId: text("encounter_id").primaryKey().references(() => encounter.id, { onDelete: "cascade" }),
  status:      text("status").notNull().default("pending"), // pending|running|done|failed|deferred
  attempts:    integer("attempts").notNull().default(0),
  error:       text("error"),
  enqueuedAt:  timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  byStatus: index("idx_stt_fanout_job_status").on(t.status, t.enqueuedAt),
}));

// stt_lab_config (migration 0019) — singleton (id=1).
export const sttLabConfig = pgTable("stt_lab_config", {
  id:                integer("id").primaryKey().default(1),
  dailyBudgetUsd:    numeric("daily_budget_usd", { precision: 10, scale: 2 }).notNull().default("5"),
  fanoutConcurrency: integer("fanout_concurrency").notNull().default(3),
  judgeModel:        text("judge_model").notNull().default("qwen"),
  weightsJson:       jsonb("weights_json").notNull().default(sql`'{}'::jsonb`),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// stt_gold (migration 0020) — verbatim reference per gold-labeled encounter (L3).
export const sttGold = pgTable("stt_gold", {
  encounterId:       text("encounter_id").primaryKey().references(() => encounter.id, { onDelete: "cascade" }),
  referenceOriginal: text("reference_original"),
  referenceEnglish:  text("reference_english"),
  referenceLanguage: text("reference_language"),
  criticalTermsJson: jsonb("critical_terms_json").notNull().default(sql`'[]'::jsonb`),
  termsModel:        text("terms_model"),
  labeledByAdminId:  text("labeled_by_admin_id"),
  labeledAt:         timestamp("labeled_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// stt_routing (migration 0021) — active production engine per stage x language.
export const sttRouting = pgTable("stt_routing", {
  stage:            text("stage").notNull(),
  languageBucket:   text("language_bucket").notNull(),
  engineId:         text("engine_id").notNull().default("auto"),
  updatedByAdminId: text("updated_by_admin_id"),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.stage, t.languageBucket] }),
}));

// voice_print (migration 0007) — one ECAPA centroid per enrolled clinician (doctor).
// FK references doctor for now (renamed to clinician in v2.0).
export const voicePrint = pgTable("voice_print", {
  doctorId:               text("doctor_id").primaryKey().references(() => doctor.id, { onDelete: "cascade" }),
  centroid:               bytea("centroid").notNull(),
  sampleCount:            integer("sample_count").notNull().default(0),
  samplesJson:            jsonb("samples_json").notNull().default(sql`'[]'::jsonb`),
  enrolledAt:             timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  lastSampleAt:           timestamp("last_sample_at", { withTimezone: true }).notNull().defaultNow(),
  matchConfidence30dAvg:  doublePrecision("match_confidence_30d_avg"),
  needsReenrollment:      boolean("needs_reenrollment").notNull().default(false),
}, (t) => ({
  byNeedsReenroll: index("idx_voice_print_needs_reenrollment").on(t.needsReenrollment),
}));

// voice_sample (migration 0017) — per-sample retention. One row per enrollment
// clip (and, Sprint B, per passive encounter match). voice_print stays the
// computed-centroid cache = running average of all `included` rows here.
export const voiceSample = pgTable("voice_sample", {
  id:                 text("id").primaryKey(),
  clinicianId:        text("clinician_id").notNull().references(() => clinician.id, { onDelete: "cascade" }),
  source:             text("source").notNull().default("enrollment"), // enrollment | passive
  embedding:          bytea("embedding").notNull(),                   // float32[192]
  audioR2Key:         text("audio_r2_key"),
  sourceEncounterId:  text("source_encounter_id"),
  contentType:        text("content_type"),
  durationMs:         integer("duration_ms"),
  sessionId:          text("session_id"),
  sampleIndex:        integer("sample_index"),
  matchConfidence:    doublePrecision("match_confidence"),
  included:           boolean("included").notNull().default(true),
  capturedByAdminId:  text("captured_by_admin_id"),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byClinician: index("idx_voice_sample_clinician").on(t.clinicianId),
  bySource:    index("idx_voice_sample_source").on(t.source),
}));

// stt_engine (migration 0018) — STT Engine Lab registry. One row per engine;
// a code adapter (lib/stt/adapters/<adapter_key>.ts) implements the calls.
export const sttEngine = pgTable("stt_engine", {
  id:               text("id").primaryKey(),
  displayName:      text("display_name").notNull(),
  adapterKey:       text("adapter_key").notNull(),
  capabilitiesJson: jsonb("capabilities_json").notNull().default(sql`'{}'::jsonb`),
  enabled:          boolean("enabled").notNull().default(true),
  fanoutEnabled:    boolean("fanout_enabled").notNull().default(true),
  isPaid:           boolean("is_paid").notNull().default(true),
  costPerMinUsd:    numeric("cost_per_min_usd", { precision: 10, scale: 5 }),
  configJson:       jsonb("config_json").notNull().default(sql`'{}'::jsonb`),
  sortOrder:        integer("sort_order").notNull().default(100),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
