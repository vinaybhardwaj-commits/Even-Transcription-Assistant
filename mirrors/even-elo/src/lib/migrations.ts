/**
 * Surgical Governance migrations — inline so they bundle cleanly in Vercel serverless.
 *
 * Each migration is identified by a stable id. The migrate endpoint maintains
 * a `_migrations` marker table and skips migrations whose id is already
 * recorded. Idempotent.
 *
 * Schema source of truth: EVEN-EPI-PRD.md §4.
 * Stream catalogue: EVEN-EPI-PRD.md §5.
 * Position seed list: EVEN-EPI-PRD.md §4.2.
 *
 * Don't reorder. Append new migrations at the end.
 */

export interface Migration {
  id: string;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    description: "Create 8 PRD tables + extensions + indexes",
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      -- 4.1 vcs
      CREATE TABLE IF NOT EXISTS vcs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name text NOT NULL,
        specialty text NOT NULL,
        registration_no text,
        status text NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'suspended', 'terminated')),
        notes text,
        created_by_position text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_vcs_status ON vcs(status);
      CREATE INDEX IF NOT EXISTS idx_vcs_specialty ON vcs(specialty);

      -- 4.2 positions (replaces principals)
      CREATE TABLE IF NOT EXISTS positions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        position_name text UNIQUE NOT NULL,
        team text NOT NULL
          CHECK (team IN ('OT','Anesthesia','MS','ICN','Pharmacy','CC','Billing','UnitHead','Admin')),
        description text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- 4.3 surgical_cases
      CREATE TABLE IF NOT EXISTS surgical_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        vc_id uuid NOT NULL REFERENCES vcs(id) ON DELETE RESTRICT,
        case_ref text UNIQUE NOT NULL,
        patient_name text,
        patient_mrn text,
        surgery_date date NOT NULL,
        procedure_label text,
        los_days integer,
        case_status text NOT NULL DEFAULT 'completed'
          CHECK (case_status IN ('completed','cancelled','voided')),
        source text NOT NULL
          CHECK (source IN ('continuous','catchup_upload')),
        entered_by_position text NOT NULL,
        entered_at timestamptz NOT NULL DEFAULT now(),
        notes text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_cases_vc_date ON surgical_cases(vc_id, surgery_date DESC);
      CREATE INDEX IF NOT EXISTS idx_cases_status ON surgical_cases(case_status);

      -- 4.4 streams
      CREATE TABLE IF NOT EXISTS streams (
        id text PRIMARY KEY,
        component text NOT NULL
          CHECK (component IN ('caseload','outcomes','adherence')),
        label text NOT NULL,
        team_owner text NOT NULL,
        data_type text NOT NULL
          CHECK (data_type IN ('binary','numeric','derived')),
        default_rule text NOT NULL
          CHECK (default_rule IN ('no_event','unknown','excluded','derived')),
        direction text NOT NULL
          CHECK (direction IN ('higher_better','lower_better')),
        floor_value numeric,
        target_value numeric,
        requires_reason_when text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      -- 4.5 case_observations (insert-only with is_current toggle)
      CREATE TABLE IF NOT EXISTS case_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id uuid NOT NULL REFERENCES surgical_cases(id) ON DELETE CASCADE,
        stream_id text NOT NULL REFERENCES streams(id),
        value jsonb NOT NULL,
        entered_by_position text NOT NULL,
        entered_at timestamptz NOT NULL DEFAULT now(),
        superseded_at timestamptz,
        is_current boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_obs_case_stream_current
        ON case_observations(case_id, stream_id, is_current);
      CREATE INDEX IF NOT EXISTS idx_obs_stream_current_recent
        ON case_observations(stream_id, is_current, entered_at DESC);

      -- 4.6 weight_versions (exactly one is_current=true)
      CREATE TABLE IF NOT EXISTS weight_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        caseload_pct integer NOT NULL,
        outcomes_pct integer NOT NULL,
        adherence_pct integer NOT NULL,
        effective_from timestamptz NOT NULL DEFAULT now(),
        set_by_position text NOT NULL,
        rationale text,
        is_current boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (caseload_pct + outcomes_pct + adherence_pct = 100),
        CHECK (caseload_pct BETWEEN 0 AND 100),
        CHECK (outcomes_pct BETWEEN 0 AND 100),
        CHECK (adherence_pct BETWEEN 0 AND 100)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_weight_versions_current
        ON weight_versions(is_current) WHERE is_current = true;

      -- 4.7 score_snapshots (append-only)
      CREATE TABLE IF NOT EXISTS score_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        vc_id uuid NOT NULL REFERENCES vcs(id) ON DELETE CASCADE,
        caseload_score numeric,
        outcomes_score numeric,
        adherence_score numeric,
        composite numeric NOT NULL,
        tier text NOT NULL
          CHECK (tier IN ('distinguished','standard','watch','pip','suspension_review','no_recent_activity')),
        low_confidence boolean NOT NULL DEFAULT false,
        weights_version_id uuid NOT NULL REFERENCES weight_versions(id),
        trigger text NOT NULL
          CHECK (trigger IN ('observation_write','case_create','case_status_change','weight_change','manual')),
        triggered_by_position text NOT NULL,
        computed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_vc_recent
        ON score_snapshots(vc_id, computed_at DESC);

      -- 4.8 audit_log (append-only)
      CREATE TABLE IF NOT EXISTS audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_position text NOT NULL,
        action text NOT NULL,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        before_json jsonb,
        after_json jsonb,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_log(at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    `,
  },

  {
    id: "002_seed_streams",
    description: "Seed 18 streams (1 caseload + 8 outcomes + 9 adherence)",
    sql: `
      INSERT INTO streams (id, component, label, team_owner, data_type, default_rule, direction, floor_value, target_value, requires_reason_when) VALUES
        -- Caseload (1)
        ('cases_per_month',         'caseload',  'Cases at EHRC this month',          'OT',         'derived', 'derived',  'higher_better',  1, 8,  NULL),
        -- Outcomes (8)
        ('mortality_30d',           'outcomes',  '30-day mortality',                   'MS',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('readmission_30d',         'outcomes',  '30-day readmission',                 'MS',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('ssi',                     'outcomes',  'Surgical site infection',            'ICN',        'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('unplanned_return_ot',     'outcomes',  'Unplanned return to OT',             'OT',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('nps_discharge',           'outcomes',  'NPS at discharge',                   'CC',         'numeric', 'excluded', 'higher_better',  6, 9,  NULL),
        ('nps_day7',                'outcomes',  'NPS Day-7',                          'CC',         'numeric', 'excluded', 'higher_better',  6, 9,  NULL),
        ('complaint_raised',        'outcomes',  'Complaint raised',                   'CC',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('family_comm_done',        'outcomes',  'Family communication completed',     'CC',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        -- Adherence (9)
        ('pac_done',                'adherence', 'PAC completed',                      'Anesthesia', 'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('ot_on_time',              'adherence', 'OT on-time arrival',                 'OT',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('ot_equipment_protocol',   'adherence', 'OT equipment per protocol',          'OT',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('ot_overrun_minutes',      'adherence', 'OT minutes overrun',                 'OT',         'numeric', 'excluded', 'lower_better',   30, 0, NULL),
        ('discharge_summary_24h',   'adherence', 'Discharge summary in 24h',           'MS',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('round_attendance',        'adherence', 'Round attendance',                   'MS',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('abx_stewardship',         'adherence', 'Antibiotic stewardship appropriate', 'Pharmacy',   'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('insurance_denial',        'adherence', 'Insurance denial',                   'Billing',    'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('unit_head_anomaly',       'adherence', 'Unit Head anomaly flag',             'UnitHead',   'binary',  'no_event', 'lower_better',   NULL, NULL, 'true')
      ON CONFLICT (id) DO NOTHING;
    `,
  },

  {
    id: "003_seed_positions",
    description: "Seed 9 positions (PRD §4.2)",
    sql: `
      INSERT INTO positions (position_name, team, description) VALUES
        ('OT Coordinator',          'OT',         'Creates cases · OT discipline + return-to-OT'),
        ('Anesthesia Coordinator',  'Anesthesia', 'PAC completion'),
        ('Medical Superintendent',  'MS',         'Mortality, readmission, discharge summary, rounds'),
        ('ICN Lead',                'ICN',        'Surgical site infections'),
        ('Clinical Pharmacologist', 'Pharmacy',   'Antibiotic stewardship'),
        ('Customer Care Lead',      'CC',         'NPS, complaints, family communication'),
        ('Billing Lead',            'Billing',    'Insurance denials'),
        ('Unit Head',               'UnitHead',   'Anomaly flags, behavioural patterns'),
        ('Committee Admin',         'Admin',      'Roster, weights, stream config')
      ON CONFLICT (position_name) DO NOTHING;
    `,
  },

  {
    id: "004_seed_weights",
    description: "Seed pilot weight version 33/34/33 (current)",
    sql: `
      INSERT INTO weight_versions
        (caseload_pct, outcomes_pct, adherence_pct, set_by_position, rationale, is_current)
      SELECT 33, 34, 33, 'Committee Admin', 'Pilot launch — equal weighting per proposal §6', true
      WHERE NOT EXISTS (SELECT 1 FROM weight_versions WHERE is_current = true);
    `,
  },

  {
    id: "005_round_attendance_reason",
    description:
      "round_attendance: optional reason field shown when val=false (Inadequate). PRD D20.",
    sql: `
      UPDATE streams
      SET requires_reason_when = 'false:optional', updated_at = now()
      WHERE id = 'round_attendance';
    `,
  },

  {
    id: "006_insurance_denial_reason",
    description:
      "insurance_denial: optional reason field shown when val=true (denied). PRD §5 A8.",
    sql: `
      UPDATE streams
      SET requires_reason_when = 'true:optional', updated_at = now()
      WHERE id = 'insurance_denial';
    `,
  },
  // ────────────────────────────────────────────────────────────
  // EPI v2.0 — schema additions (lock-down spec §F.7 + EPI.0a plan)
  // ────────────────────────────────────────────────────────────
  {
    id: "007_epi_schema",
    description: "EPI v2.0 schema additions: hospitals, profiles, physicians, engagements, qualifications, privileges, audit_log_v2 + ALTER positions for hospital scoping",
    sql: `
      -- 1. hospitals (network-wide tenant table)
      CREATE TABLE IF NOT EXISTS hospitals (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code        text NOT NULL UNIQUE,
        name        text NOT NULL,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      -- 2. positions: drop v1 team CHECK (EPI broadens role list), add hospital_id
      ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_team_check;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS hospital_id uuid REFERENCES hospitals(id);
      CREATE INDEX IF NOT EXISTS idx_positions_hospital ON positions(hospital_id);

      -- 3. profiles (auth identity, 1:1 user-to-position-per-hospital)
      CREATE TABLE IF NOT EXISTS profiles (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email           text NOT NULL UNIQUE,
        full_name       text NOT NULL,
        password_hash   text NOT NULL,
        position_id     uuid NOT NULL REFERENCES positions(id),
        hospital_id     uuid NOT NULL REFERENCES hospitals(id),
        status          text NOT NULL DEFAULT 'pending_approval'
          CHECK (status IN ('pending_approval','active','suspended','rejected')),
        is_super_admin       boolean NOT NULL DEFAULT false,
        is_sgc_member        boolean NOT NULL DEFAULT false,
        is_hr                boolean NOT NULL DEFAULT false,
        is_site_medical_head boolean NOT NULL DEFAULT false,
        last_login_at   timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_hospital ON profiles(hospital_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_position ON profiles(position_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_status   ON profiles(status);

      -- 4. physicians (network-wide; hospital relationships live in physician_engagements)
      CREATE TABLE IF NOT EXISTS physicians (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name            text NOT NULL,
        preferred_name       text,
        primary_specialty    text,
        registration_number  text,
        registration_council text,
        registration_expiry  date,
        email                text,
        phone                text,
        date_joined_network  date,
        current_status       text NOT NULL DEFAULT 'active'
          CHECK (current_status IN ('active','inactive','terminated')),
        notes                text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_physicians_status ON physicians(current_status);

      -- 5. physician_engagements (one row per physician × hospital × engagement_type)
      CREATE TABLE IF NOT EXISTS physician_engagements (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id      uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id       uuid NOT NULL REFERENCES hospitals(id),
        engagement_type   text NOT NULL
          CHECK (engagement_type IN ('employed','part_time','visiting_consultant')),
        start_date        date NOT NULL,
        end_date          date,
        specialty         text,
        status            text NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','probation','terminated')),
        terminated_reason text,
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_engagements_physician ON physician_engagements(physician_id);
      CREATE INDEX IF NOT EXISTS idx_engagements_hospital  ON physician_engagements(hospital_id);

      -- 6. qualifications (file_data jsonb stores 2MB-cap base64-encoded cert per lock-down decision #26)
      CREATE TABLE IF NOT EXISTS qualifications (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id    uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        degree          text NOT NULL,
        institution     text,
        institution_tier text CHECK (institution_tier IN ('A','B','C','Unknown')),
        year_completed  integer,
        country         text,
        verified        boolean NOT NULL DEFAULT false,
        verified_by     uuid REFERENCES profiles(id),
        verified_at     timestamptz,
        file_data       jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_quals_physician ON qualifications(physician_id);

      -- 7. privileges
      CREATE TABLE IF NOT EXISTS privileges (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id           uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id            uuid NOT NULL REFERENCES hospitals(id),
        procedure_or_specialty text NOT NULL,
        granted_date           date NOT NULL,
        granted_by             uuid REFERENCES profiles(id),
        withdrawn_date         date,
        withdrawn_reason       text,
        basis                  text CHECK (basis IN ('initial','annual_review','case_review','vc_observation_pass')),
        created_at             timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_privs_physician ON privileges(physician_id);
      CREATE INDEX IF NOT EXISTS idx_privs_hospital  ON privileges(hospital_id);

      -- 8. audit_log_v2 (parallel to v1 audit_log; new EPI writes go here, v1 audit_log keeps history)
      CREATE TABLE IF NOT EXISTS audit_log_v2 (
        id            bigserial PRIMARY KEY,
        actor_user_id uuid REFERENCES profiles(id),
        actor_ip      text,
        action        text NOT NULL,
        entity_type   text NOT NULL,
        entity_id     text,
        before_json   jsonb,
        after_json    jsonb,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_v2_entity ON audit_log_v2(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_v2_actor  ON audit_log_v2(actor_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_v2_time   ON audit_log_v2(created_at DESC);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.1d — clinical_metrics_monthly (PRD §6.3 / §7.3)
  // ────────────────────────────────────────────────────────────
  {
    id: "008_clinical_metrics_monthly",
    description: "Monthly clinical metrics per (physician × hospital × month). Manual CSV upload from /admin/metrics.",
    sql: `
      CREATE TABLE IF NOT EXISTS clinical_metrics_monthly (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id    uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id     uuid NOT NULL REFERENCES hospitals(id),
        year            integer NOT NULL CHECK (year >= 2020 AND year <= 2100),
        month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
        opd_count       integer,
        ipd_admissions  integer,
        ot_cases        integer,
        revenue_inr     numeric(14,2),
        uploaded_by     uuid REFERENCES profiles(id),
        uploaded_at     timestamptz NOT NULL DEFAULT now(),
        source_file     text,
        UNIQUE (physician_id, hospital_id, year, month)
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_physician ON clinical_metrics_monthly(physician_id, year DESC, month DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_hospital  ON clinical_metrics_monthly(hospital_id);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.2a — incidents + incident_replies (PRD §6.4 + locked §E.4)
  // ────────────────────────────────────────────────────────────
  {
    id: "009_incidents",
    description: "Incident submission + right-of-reply tables. 8 categories per locked decision #20; severity submitter-set with super-admin re-classify; anonymous flag with audit-log-only identity disclosure per #19.",
    sql: `
      CREATE TABLE IF NOT EXISTS incidents (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        target_physician_id         uuid NOT NULL REFERENCES physicians(id),
        submitted_at                timestamptz NOT NULL DEFAULT now(),
        submitted_from_ip           text,
        submitter_user_id           uuid NOT NULL REFERENCES profiles(id),
        submitter_position_at_time  text NOT NULL,
        anonymous_flag              boolean NOT NULL DEFAULT false,
        hospital_id                 uuid REFERENCES hospitals(id),
        category                    text NOT NULL CHECK (category IN (
          'clinical','patient_safety','medical_error','professionalism',
          'documentation','etiquette','vendor_compliance','other'
        )),
        severity                    text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
        narrative                   text NOT NULL,
        evidence_urls               text[],
        status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','retracted')),
        retracted_by                uuid REFERENCES profiles(id),
        retracted_at                timestamptz,
        retraction_reason           text,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_target   ON incidents(target_physician_id, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_submitter ON incidents(submitter_user_id);

      CREATE TABLE IF NOT EXISTS incident_replies (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        incident_id              uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        replied_by_profile_id    uuid NOT NULL REFERENCES profiles(id),
        reply_text               text NOT NULL,
        replied_at               timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_replies_incident ON incident_replies(incident_id, replied_at ASC);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.3a — vc_prescreens (PRD §6.2 + locked decision #11/#31)
  // ────────────────────────────────────────────────────────────
  {
    id: "010_vc_prescreens",
    description: "VC onboarding pre-screen table. Physician row created only on decision='confirm_privileges' in EPI.3c; this table carries prospective email/name/specialty pre-confirmation. 12-month re-invitation cooldown enforced server-side; super_admin can override.",
    sql: `
      CREATE TABLE IF NOT EXISTS vc_prescreens (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        prospective_email        text NOT NULL,
        prospective_full_name    text NOT NULL,
        prospective_specialty    text,
        hospital_id              uuid NOT NULL REFERENCES hospitals(id),
        years_post_postgraduate  integer,
        prior_corporate_hospitals text[],
        commitments_acknowledged jsonb,
        red_flags                text,
        decision                 text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','invite','reject')),
        decision_rationale       text,
        cooldown_override        boolean NOT NULL DEFAULT false,
        stage                    text NOT NULL DEFAULT 'prescreen' CHECK (stage IN ('prescreen','observation','decision','onboarded','rejected','terminated')),
        prescreened_by           uuid NOT NULL REFERENCES profiles(id),
        prescreened_at           timestamptz NOT NULL DEFAULT now(),
        decided_at               timestamptz,
        physician_id             uuid REFERENCES physicians(id),
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_prescreens_stage    ON vc_prescreens(stage, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prescreens_email    ON vc_prescreens(lower(prospective_email));
      CREATE INDEX IF NOT EXISTS idx_prescreens_hospital ON vc_prescreens(hospital_id);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.3b — vc_observation_cases (PRD §6.2 + locked decision #30)
  // ────────────────────────────────────────────────────────────
  {
    id: "011_vc_observation_cases",
    description: "VC observation cases (3 minimum, max 5). 6-dim scoring jsonb (teamwork/emr_documentation/ot_etiquette/protocol_adherence/outcome/demeanor each 1-5). flag_severity enum (none|concern|immediate_termination_recommended) per PRD.",
    sql: `
      CREATE TABLE IF NOT EXISTS vc_observation_cases (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        prescreen_id      uuid NOT NULL REFERENCES vc_prescreens(id) ON DELETE CASCADE,
        case_number       integer NOT NULL CHECK (case_number BETWEEN 1 AND 5),
        case_date         date NOT NULL,
        procedure         text NOT NULL,
        observer_role     text NOT NULL,
        observer_user_id  uuid NOT NULL REFERENCES profiles(id),
        observer_name     text NOT NULL,
        scores            jsonb NOT NULL,
        narrative_notes   text,
        flag_severity     text NOT NULL DEFAULT 'none' CHECK (flag_severity IN ('none','concern','immediate_termination_recommended')),
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (prescreen_id, case_number)
      );
      CREATE INDEX IF NOT EXISTS idx_obs_cases_prescreen ON vc_observation_cases(prescreen_id, case_number);
      CREATE INDEX IF NOT EXISTS idx_obs_cases_flag      ON vc_observation_cases(flag_severity) WHERE flag_severity <> 'none';
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.4 — patient_feedback (PRD §6.4 + locked decision #8)
  // ────────────────────────────────────────────────────────────
  {
    id: "012_patient_feedback",
    description: "Quarterly patient-feedback rows per (physician × hospital × period). Manual CSV upload from /admin/patient-feedback. Resend / Pulse integration is v1.x scope.",
    sql: `
      CREATE TABLE IF NOT EXISTS patient_feedback (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id    uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id     uuid NOT NULL REFERENCES hospitals(id),
        feedback_period text NOT NULL,
        csat_score      numeric(4,2),
        complaint_count integer,
        source          text,
        uploaded_by     uuid REFERENCES profiles(id),
        uploaded_at     timestamptz NOT NULL DEFAULT now(),
        source_file     text,
        UNIQUE (physician_id, hospital_id, feedback_period)
      );
      CREATE INDEX IF NOT EXISTS idx_pf_physician ON patient_feedback(physician_id);
      CREATE INDEX IF NOT EXISTS idx_pf_hospital  ON patient_feedback(hospital_id);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI post-launch — add 'Medical Administrator' position to EHRC
  // ────────────────────────────────────────────────────────────
  {
    id: "013_position_medical_administrator",
    description: "Add 'Medical Administrator' as a 14th position at EHRC. Idempotent insert; safe to re-run.",
    sql: `
      INSERT INTO positions (position_name, team, description, hospital_id)
      SELECT 'Medical Administrator', 'Admin', 'Senior medical administration / governance support', h.id
      FROM hospitals h
      WHERE h.code = 'EHRC'
        AND NOT EXISTS (
          SELECT 1 FROM positions p
          WHERE p.position_name = 'Medical Administrator'
            AND p.hospital_id = h.id
        );
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI v3.0a — MULTI-HOSPITAL CUTOVER (PRD §G, 8 steps)
  // ────────────────────────────────────────────────────────────
  {
    id: "014_multi_hospital_v3",
    description: "v3.0a: seed 3 new hospitals (EHBR/EHIN/EHBO), drop positions.hospital_id (shared catalogue), profile_hospital_roles + backfill + drop per-site flags + profiles_with_roles view, incidents.hospital_id NOT NULL, vc_prescreen_hospitals join, vc_observation_cases.hospital_id, positions UNIQUE, profiles.requested_roles jsonb.",
    sql: `
      -- 1. Seed 3 new hospitals
      INSERT INTO hospitals (code, name, is_active) VALUES
        ('EHBR', 'EHBR', true),
        ('EHIN', 'EHIN', true),
        ('EHBO', 'EHBO', true)
      ON CONFLICT (code) DO NOTHING;

      -- 2. Drop positions.hospital_id (shared catalogue). EPI v1 only seeded EHRC,
      --    so the 14 position rows already have unique position_names. No de-dup needed.
      DROP INDEX IF EXISTS idx_positions_hospital;
      ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_hospital_id_fkey;
      ALTER TABLE positions DROP COLUMN IF EXISTS hospital_id;

      -- 3. profile_hospital_roles table (replaces per-site flags on profiles)
      CREATE TABLE IF NOT EXISTS profile_hospital_roles (
        profile_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        hospital_id  uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
        role         text NOT NULL CHECK (role IN ('site_medical_head','hr','sgc_member')),
        granted_by   uuid REFERENCES profiles(id),
        granted_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (profile_id, hospital_id, role)
      );
      CREATE INDEX IF NOT EXISTS idx_phr_profile  ON profile_hospital_roles(profile_id);
      CREATE INDEX IF NOT EXISTS idx_phr_hospital ON profile_hospital_roles(hospital_id);
      CREATE INDEX IF NOT EXISTS idx_phr_role     ON profile_hospital_roles(role);

      -- 3a. Backfill from existing boolean flags ONLY if the columns still exist
      --     (on re-runs after a failed first attempt, the columns are already dropped
      --     and the backfill is already done — skip cleanly).
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_site_medical_head') THEN
          INSERT INTO profile_hospital_roles (profile_id, hospital_id, role, granted_by, granted_at)
            SELECT id, hospital_id, 'site_medical_head', NULL, now() FROM profiles
              WHERE is_site_medical_head = true AND hospital_id IS NOT NULL
            ON CONFLICT DO NOTHING;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_hr') THEN
          INSERT INTO profile_hospital_roles (profile_id, hospital_id, role, granted_by, granted_at)
            SELECT id, hospital_id, 'hr', NULL, now() FROM profiles
              WHERE is_hr = true AND hospital_id IS NOT NULL
            ON CONFLICT DO NOTHING;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_sgc_member') THEN
          INSERT INTO profile_hospital_roles (profile_id, hospital_id, role, granted_by, granted_at)
            SELECT id, hospital_id, 'sgc_member', NULL, now() FROM profiles
              WHERE is_sgc_member = true AND hospital_id IS NOT NULL
            ON CONFLICT DO NOTHING;
        END IF;
      END $$;

      -- 3b. Drop the boolean columns
      ALTER TABLE profiles DROP COLUMN IF EXISTS is_site_medical_head;
      ALTER TABLE profiles DROP COLUMN IF EXISTS is_hr;
      ALTER TABLE profiles DROP COLUMN IF EXISTS is_sgc_member;

      -- 3c. Create profiles_with_roles view (derives the booleans as EXISTS subqueries).
      --     All read paths SELECT FROM this view; writes still go to profiles + PHR.
      CREATE OR REPLACE VIEW profiles_with_roles AS
      SELECT
        p.*,
        EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.role = 'site_medical_head') AS is_site_medical_head,
        EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.role = 'hr')                AS is_hr,
        EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.role = 'sgc_member')        AS is_sgc_member
      FROM profiles p;

      -- 4. Incidents.hospital_id NOT NULL (backfill any nulls to EHRC first)
      UPDATE incidents SET hospital_id = (SELECT id FROM hospitals WHERE code = 'EHRC')
        WHERE hospital_id IS NULL;
      ALTER TABLE incidents ALTER COLUMN hospital_id SET NOT NULL;

      -- 5. vc_prescreen_hospitals join table (one row per (prescreen, hospital))
      CREATE TABLE IF NOT EXISTS vc_prescreen_hospitals (
        prescreen_id uuid NOT NULL REFERENCES vc_prescreens(id) ON DELETE CASCADE,
        hospital_id  uuid NOT NULL REFERENCES hospitals(id)     ON DELETE CASCADE,
        PRIMARY KEY (prescreen_id, hospital_id)
      );
      CREATE INDEX IF NOT EXISTS idx_vcph_prescreen ON vc_prescreen_hospitals(prescreen_id);
      CREATE INDEX IF NOT EXISTS idx_vcph_hospital  ON vc_prescreen_hospitals(hospital_id);
      -- Backfill: every existing prescreen gets a single-hospital row
      INSERT INTO vc_prescreen_hospitals (prescreen_id, hospital_id)
        SELECT id, hospital_id FROM vc_prescreens
        ON CONFLICT DO NOTHING;

      -- 6. vc_observation_cases.hospital_id (each case tagged with hospital it happened at)
      ALTER TABLE vc_observation_cases ADD COLUMN IF NOT EXISTS hospital_id uuid REFERENCES hospitals(id);
      UPDATE vc_observation_cases o
         SET hospital_id = (SELECT hospital_id FROM vc_prescreens WHERE id = o.prescreen_id)
       WHERE o.hospital_id IS NULL;
      ALTER TABLE vc_observation_cases ALTER COLUMN hospital_id SET NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_obs_cases_hospital ON vc_observation_cases(hospital_id);

      -- 7. (skipped — position_name UNIQUE already established in migration v1)

      -- 8. profiles.requested_roles jsonb (populated at /auth/signup in v3.0c)
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS requested_roles jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI v3.0c fixup — refresh profiles_with_roles view to include
  // requested_roles (added to profiles AFTER the view was created in v14)
  // ────────────────────────────────────────────────────────────
  {
    id: "015_profiles_view_refresh",
    description: "DROP + recreate profiles_with_roles view so SELECT p.* picks up requested_roles. Idempotent.",
    sql: `
      DROP VIEW IF EXISTS profiles_with_roles;
      CREATE VIEW profiles_with_roles AS
      SELECT
        p.*,
        EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.role = 'site_medical_head') AS is_site_medical_head,
        EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.role = 'hr')                AS is_hr,
        EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.role = 'sgc_member')        AS is_sgc_member
      FROM profiles p;
    `,
  },

  // ────────────────────────────────────────────────────────────
  // Post-v3.0 enhancement — per-user incident read state (16 May 2026)
  // V's request: badge in TopNav should decrement per-user when an
  // admin/super-admin opens the incident. Plus a manual 'Mark reviewed'
  // button as a fallback. All admins must individually review.
  // ────────────────────────────────────────────────────────────
  {
    id: "016_incident_views",
    description: "Per-user read state for incidents. Auto-INSERTed on GET /api/incidents/[id]. PK (incident_id, profile_id).",
    sql: `
      CREATE TABLE IF NOT EXISTS incident_views (
        incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        profile_id  uuid NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
        viewed_at   timestamptz NOT NULL DEFAULT now(),
        via         text NOT NULL DEFAULT 'open' CHECK (via IN ('open','mark_reviewed')),
        PRIMARY KEY (incident_id, profile_id)
      );
      CREATE INDEX IF NOT EXISTS idx_incident_views_profile ON incident_views(profile_id);
      CREATE INDEX IF NOT EXISTS idx_incident_views_incident ON incident_views(incident_id);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // CR.1 — Credentialing & Privileging foundation (PRD v1.0)
  // Single multi-step migration; lands ALL breaking schema changes:
  //   (a) physician_engagements.category enum + backfill from engagement_type
  //       (decisions #2, #3, #18). Drops engagement_type entirely.
  //   (b) physician_engagements.status widens to 5-state enum
  //       (decision #9). Backfills probation→active, terminated→resigned.
  //   (c) physician_engagements.status_reason text + copies any existing
  //       terminated_reason values into it (decisions #9, #20).
  //   (d) privileges.is_core boolean DEFAULT false (decision #5).
  //   (e) privileges.expires_at date (decision #11 — Special only).
  //   (f) physicians.indemnity_expiry + physicians.docs_external_url
  //       (decisions #10, #11).
  //   (g) vc_observation_cases.trigger enum DEFAULT
  //       'new_visiting_consultant' (decision #6).
  //   (h) oppe_reviews table (decision #7).
  //   (i) privilege_requests table (decision #8).
  //
  // Idempotent. Uses DO $$ guards so re-runs after a partial-fail are safe.
  // ────────────────────────────────────────────────────────────
  {
    id: "017_credentialing_v1",
    description: "CR.1: physician_engagements gains category (5-value enum) + status widens to 5-state + status_reason text. Drops engagement_type. privileges gains is_core + expires_at. physicians gains indemnity_expiry + docs_external_url. vc_observation_cases gains trigger enum. New tables oppe_reviews + privilege_requests.",
    sql: `
      -- ─── (a) physician_engagements.category enum + backfill ───
      ALTER TABLE physician_engagements
        ADD COLUMN IF NOT EXISTS category text;

      -- Backfill category. Guarded by IF EXISTS so re-runs (after the column
      -- drop below) skip the engagement_type-dependent UPDATEs cleanly.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='physician_engagements' AND column_name='engagement_type'
        ) THEN
          -- visiting_consultant → visiting_consultant
          UPDATE physician_engagements
             SET category = 'visiting_consultant'
           WHERE engagement_type = 'visiting_consultant'
             AND category IS NULL;
          -- employed + status='probation' → provisional (preserves the
          -- original probationary intent in the new category model)
          UPDATE physician_engagements
             SET category = 'provisional'
           WHERE engagement_type = 'employed'
             AND status = 'probation'
             AND category IS NULL;
          -- employed (non-probation) → active
          UPDATE physician_engagements
             SET category = 'active'
           WHERE engagement_type = 'employed'
             AND category IS NULL;
          -- part_time → active
          UPDATE physician_engagements
             SET category = 'active'
           WHERE engagement_type = 'part_time'
             AND category IS NULL;
          -- locum / locum_tenens (none expected today, but defensive)
          UPDATE physician_engagements
             SET category = 'locum_tenens'
           WHERE engagement_type IN ('locum','locum_tenens')
             AND category IS NULL;
        END IF;
        -- Catch-all for any remaining nulls (incl. legacy rows that survived
        -- a partial first-run with engagement_type already dropped).
        UPDATE physician_engagements
           SET category = 'active'
         WHERE category IS NULL;
      END $$;

      ALTER TABLE physician_engagements
        ALTER COLUMN category SET NOT NULL;
      ALTER TABLE physician_engagements
        DROP CONSTRAINT IF EXISTS physician_engagements_category_check;
      ALTER TABLE physician_engagements
        ADD CONSTRAINT physician_engagements_category_check
        CHECK (category IN ('provisional','active','visiting_consultant','locum_tenens','affiliate'));
      CREATE INDEX IF NOT EXISTS idx_engagements_category
        ON physician_engagements(category);

      -- Drop engagement_type now that category is fully populated (decision #18).
      ALTER TABLE physician_engagements DROP COLUMN IF EXISTS engagement_type;

      -- ─── (b) physician_engagements.status widens to 5-state enum ───
      ALTER TABLE physician_engagements
        DROP CONSTRAINT IF EXISTS physician_engagements_status_check;
      -- Backfill: probation → active (probation/provisional now lives in category),
      -- terminated → resigned (default per PRD §J.1).
      UPDATE physician_engagements SET status = 'active'   WHERE status = 'probation';
      UPDATE physician_engagements SET status = 'resigned' WHERE status = 'terminated';
      ALTER TABLE physician_engagements
        ADD CONSTRAINT physician_engagements_status_check
        CHECK (status IN ('active','suspended','revoked','resigned','lapsed'));

      -- ─── (c) status_reason text + carry-over from terminated_reason ───
      ALTER TABLE physician_engagements
        ADD COLUMN IF NOT EXISTS status_reason text;
      -- Carry-over only where terminated_reason is populated; safe on re-run
      -- because status_reason gets a value the first time and is skipped after.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='physician_engagements' AND column_name='terminated_reason'
        ) THEN
          UPDATE physician_engagements
             SET status_reason = terminated_reason
           WHERE terminated_reason IS NOT NULL
             AND status_reason IS NULL;
        END IF;
      END $$;

      -- ─── (d) privileges.is_core ───
      ALTER TABLE privileges
        ADD COLUMN IF NOT EXISTS is_core boolean NOT NULL DEFAULT false;

      -- ─── (e) privileges.expires_at (Special only — Core privileges don't expire) ───
      ALTER TABLE privileges
        ADD COLUMN IF NOT EXISTS expires_at date;
      CREATE INDEX IF NOT EXISTS idx_privs_expires_at
        ON privileges(expires_at)
        WHERE expires_at IS NOT NULL;

      -- ─── (f) physicians.indemnity_expiry + docs_external_url ───
      ALTER TABLE physicians
        ADD COLUMN IF NOT EXISTS indemnity_expiry date;
      ALTER TABLE physicians
        ADD COLUMN IF NOT EXISTS docs_external_url text;
      CREATE INDEX IF NOT EXISTS idx_physicians_indemnity_expiry
        ON physicians(indemnity_expiry)
        WHERE indemnity_expiry IS NOT NULL;

      -- ─── (g) vc_observation_cases.trigger ───
      ALTER TABLE vc_observation_cases
        ADD COLUMN IF NOT EXISTS trigger text
        NOT NULL DEFAULT 'new_visiting_consultant';
      ALTER TABLE vc_observation_cases
        DROP CONSTRAINT IF EXISTS vc_observation_cases_trigger_check;
      ALTER TABLE vc_observation_cases
        ADD CONSTRAINT vc_observation_cases_trigger_check
        CHECK (trigger IN (
          'new_visiting_consultant',
          'new_employed_provisional',
          'special_privilege_request',
          'concern_raised'
        ));
      CREATE INDEX IF NOT EXISTS idx_obs_cases_trigger
        ON vc_observation_cases(trigger);

      -- ─── (h) oppe_reviews table (empty; populated by CR.3 scheduler) ───
      CREATE TABLE IF NOT EXISTS oppe_reviews (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id    uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id     uuid NOT NULL REFERENCES hospitals(id),
        period_start    date NOT NULL,
        period_end      date NOT NULL,
        due_at          timestamptz NOT NULL,
        status          text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','in_review','satisfactory','flagged','escalated_to_fppe')),
        packet_jsonb    jsonb,
        reviewer_id     uuid REFERENCES profiles(id),
        decision_notes  text,
        completed_at    timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_oppe_physician ON oppe_reviews(physician_id);
      CREATE INDEX IF NOT EXISTS idx_oppe_hospital  ON oppe_reviews(hospital_id);
      CREATE INDEX IF NOT EXISTS idx_oppe_status    ON oppe_reviews(status);
      CREATE INDEX IF NOT EXISTS idx_oppe_due       ON oppe_reviews(due_at);

      -- ─── (i) privilege_requests table (empty; populated by CR.4) ───
      CREATE TABLE IF NOT EXISTS privilege_requests (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id        uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id         uuid NOT NULL REFERENCES hospitals(id),
        specialty           text,
        scope_text          text NOT NULL,
        is_core             boolean NOT NULL DEFAULT false,
        evidence_jsonb      jsonb,
        status              text NOT NULL DEFAULT 'requested'
          CHECK (status IN ('requested','under_fppe','approved','denied','withdrawn')),
        requested_by        uuid REFERENCES profiles(id),
        reviewed_by         uuid REFERENCES profiles(id),
        decision_rationale  text,
        requested_at        timestamptz NOT NULL DEFAULT now(),
        decided_at          timestamptz
      );
      CREATE INDEX IF NOT EXISTS idx_prreq_physician ON privilege_requests(physician_id);
      CREATE INDEX IF NOT EXISTS idx_prreq_hospital  ON privilege_requests(hospital_id);
      CREATE INDEX IF NOT EXISTS idx_prreq_status    ON privilege_requests(status);
    `,
  },
  {
    id: "018_feedback_incidents_schema",
    description: "Feedback + Doctor Portal foundation: incidents polarity/source/commendation_category/patient_rating/patient_ref + author polymorphism (physician|profile) on incidents and incident_replies; relax severity/category/submitter NOT NULL. Additive.",
    sql: `
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS polarity text NOT NULL DEFAULT 'negative'
        CHECK (polarity IN ('positive','negative'));
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'peer'
        CHECK (source IN ('patient','peer','governance'));
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS commendation_category text;
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS patient_rating smallint
        CHECK (patient_rating IS NULL OR (patient_rating BETWEEN 1 AND 5));
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS patient_ref text;
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS submitter_physician_id uuid REFERENCES physicians(id);

      ALTER TABLE incidents ALTER COLUMN submitter_user_id DROP NOT NULL;
      ALTER TABLE incidents ALTER COLUMN severity DROP NOT NULL;
      ALTER TABLE incidents ALTER COLUMN category DROP NOT NULL;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='incidents_one_author_chk' AND table_name='incidents') THEN
          ALTER TABLE incidents ADD CONSTRAINT incidents_one_author_chk
            CHECK ((submitter_user_id IS NOT NULL)::int + (submitter_physician_id IS NOT NULL)::int = 1);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_incidents_polarity ON incidents(polarity);
      CREATE INDEX IF NOT EXISTS idx_incidents_source ON incidents(source);
      CREATE INDEX IF NOT EXISTS idx_incidents_submitter_phys ON incidents(submitter_physician_id);

      ALTER TABLE incident_replies ADD COLUMN IF NOT EXISTS replied_by_physician_id uuid REFERENCES physicians(id);
      ALTER TABLE incident_replies ALTER COLUMN replied_by_profile_id DROP NOT NULL;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='incident_replies_one_author_chk' AND table_name='incident_replies') THEN
          ALTER TABLE incident_replies ADD CONSTRAINT incident_replies_one_author_chk
            CHECK ((replied_by_profile_id IS NOT NULL)::int + (replied_by_physician_id IS NOT NULL)::int = 1);
        END IF;
      END $$;
    `,
  },
  {
    id: "019_drop_patient_feedback",
    description: "Feedback PRD #15 — patient_feedback merged into incidents. Drop the table + CSV path (bundled with code cutover). Empty table, no data loss.",
    sql: `
      DROP TABLE IF EXISTS patient_feedback CASCADE;
    `,
  },
  {
    id: "020_users_module",
    description: "Users Module #9/#11 — widen profiles.status to add 'deactivated'; add profiles.must_change_pin (force PIN change on first login). Additive.",
    sql: `
      ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_status_check;
      ALTER TABLE profiles ADD CONSTRAINT profiles_status_check
        CHECK (status IN ('pending_approval','active','suspended','rejected','deactivated'));
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS must_change_pin boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: "021_doctor_portal",
    description: "Doctor Portal #1 — physicians.portal_access/portal_pin_hash/portal_must_change_pin + resignation_requests table. Additive.",
    sql: `
      ALTER TABLE physicians ADD COLUMN IF NOT EXISTS portal_access boolean NOT NULL DEFAULT false;
      ALTER TABLE physicians ADD COLUMN IF NOT EXISTS portal_pin_hash text;
      ALTER TABLE physicians ADD COLUMN IF NOT EXISTS portal_must_change_pin boolean NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS resignation_requests (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id      uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id       uuid REFERENCES hospitals(id),
        reason            text,
        intended_last_date date,
        status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','withdrawn')),
        requested_at      timestamptz NOT NULL DEFAULT now(),
        processed_by      uuid REFERENCES profiles(id),
        processed_at      timestamptz
      );
      CREATE INDEX IF NOT EXISTS idx_resignation_physician ON resignation_requests(physician_id);
      CREATE INDEX IF NOT EXISTS idx_resignation_status    ON resignation_requests(status);
    `,
  },
  {
    id: "022_rename_ehbr_hospital",
    description: "Rename EHBR hospital record to its real name (Even Healthcare HBR Layout / Altius). Idempotent.",
    sql: `
      UPDATE hospitals SET name = 'Even Healthcare HBR Layout (Altius)' WHERE code = 'EHBR';
    `,
  },
  {
    id: "023_ehbr_existing_credentials",
    description: "Backfill EHBR-sheet credential dates onto the 4 pre-existing physicians who got an EHBR engagement during the roster import (importer is additive-only on existing). COALESCE = fill only when currently null; never overwrite.",
    sql: `
      UPDATE physicians SET
        registration_number = COALESCE(registration_number, '81226'),
        registration_expiry = COALESCE(registration_expiry, '2029-01-20'::date)
      WHERE id = '40e81ac3-cac4-44ad-8ea6-507d3eefa9bb';

      UPDATE physicians SET
        registration_number = COALESCE(registration_number, 'KMC 84341'),
        registration_council = COALESCE(registration_council, 'KMC'),
        registration_expiry = COALESCE(registration_expiry, '2026-12-21'::date),
        indemnity_expiry = COALESCE(indemnity_expiry, '2026-06-30'::date)
      WHERE id = '8f576f23-c11b-457d-a3e2-c22514395187';

      UPDATE physicians SET
        registration_number = COALESCE(registration_number, 'KMC MAH 2011 0000101 KTK'),
        registration_council = COALESCE(registration_council, 'KMC'),
        registration_expiry = COALESCE(registration_expiry, '2027-02-07'::date),
        indemnity_expiry = COALESCE(indemnity_expiry, '2026-02-20'::date)
      WHERE id = '1d2496b3-0d4f-4ae4-a59c-a037c06258a4';

      UPDATE physicians SET
        registration_number = COALESCE(registration_number, 'KMC 113696'),
        registration_council = COALESCE(registration_council, 'KMC'),
        registration_expiry = COALESCE(registration_expiry, '2026-11-15'::date)
      WHERE id = 'feb51691-b376-4552-954d-0dcff78ff814';
    `,
  },
  {
    id: "024_external_public_incidents",
    description: "Public external incident intake. Adds incidents.reporter_name + reporter_email; widens the source CHECK to include 'external_public'; swaps incidents_one_author_chk so an authorless external row is valid (source='external_public' with a reporter_email and NO profile/physician author), while preserving the one-author invariant for internal rows. Bundled with the /report public form + /api/public/* endpoints.",
    sql: `
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reporter_name  text;
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reporter_email text;

      -- Widen the source CHECK to admit external public reports (name-agnostic drop).
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'incidents'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%source%'
            AND pg_get_constraintdef(oid) ILIKE '%peer%'
            AND pg_get_constraintdef(oid) NOT ILIKE '%external_public%'
        LOOP
          EXECUTE format('ALTER TABLE incidents DROP CONSTRAINT %I', r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'incidents'::regclass AND conname = 'incidents_source_check'
        ) THEN
          ALTER TABLE incidents ADD CONSTRAINT incidents_source_check
            CHECK (source IN ('patient','peer','governance','external_public'));
        END IF;
      END $$;

      -- Allow an authorless external row; keep the internal one-author invariant otherwise.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'incidents'::regclass AND conname = 'incidents_one_author_chk'
        ) THEN
          ALTER TABLE incidents DROP CONSTRAINT incidents_one_author_chk;
        END IF;
        ALTER TABLE incidents ADD CONSTRAINT incidents_one_author_chk CHECK (
          (source = 'external_public'
             AND submitter_user_id IS NULL
             AND submitter_physician_id IS NULL
             AND reporter_email IS NOT NULL)
          OR
          ((submitter_user_id IS NOT NULL)::int + (submitter_physician_id IS NOT NULL)::int = 1)
        );
      END $$;
    `,
  },
  {
    id: "025_doctor_perf_weekly",
    description: "Doctor portal 'My Performance': physicians.metabase_doctor_email mapping (populated for the 38 matched physicians) + doctor_perf_weekly snapshot table — a weekly copy of Metabase mv_doctor_weekly_performance (keyed doctor_email+week). Snapshot is loaded via connectors and refreshed weekly; no live DB credential lives in the app.",
    sql: `
      ALTER TABLE physicians ADD COLUMN IF NOT EXISTS metabase_doctor_email text;
      CREATE INDEX IF NOT EXISTS idx_physicians_mb_email ON physicians (lower(metabase_doctor_email));

      CREATE TABLE IF NOT EXISTS doctor_perf_weekly (
        doctor_email                       text NOT NULL,
        week                               date NOT NULL,
        doctor_specialty                   text,
        doctor_channel_type                text,
        total_consults                     integer,
        csat_pct                           numeric,
        csat_responses                     integer,
        positive_csat_count                integer,
        doctor_noshow_tc_rate              numeric,
        patient_noshow_rate                numeric,
        cancellation_rate                  numeric,
        doctor_cancellation_rate           numeric,
        missing_prescription_rate          numeric,
        presc_under_30_pct                 numeric,
        inperson_consult_count             integer,
        tc_active_event_count              integer,
        tc_events_missing_recording_count  integer,
        unwritten_count                    integer,
        completed_presc_count              integer,
        cancelled_count                    integer,
        patient_noshow_count               integer,
        snapshot_at                        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (doctor_email, week)
      );
      CREATE INDEX IF NOT EXISTS idx_dpw_email ON doctor_perf_weekly (lower(doctor_email));

      UPDATE physicians p SET metabase_doctor_email = v.email
      FROM (VALUES
        ('162799b0-2517-40ad-8b8b-d5b34d6ace42','animeshbanerjee@even.in'),
        ('b90c393d-153d-434c-86b1-2027be2ca7a4','sharil.hegde@even.in'),
        ('e497eb20-3fd8-4ce9-842d-6829faeff7cf','nishita.das@even.in'),
        ('00f83381-8039-4b15-a699-d72f6cc065d9','sunil.kumar@even.in'),
        ('1bbebd13-da59-4bee-96b3-ca54dc89615e','ankitbhojani@even.in'),
        ('f3cae8c2-b09b-4624-94e1-b66953ce6f63','prashanth.nagaraj@even.in'),
        ('bfa157cc-514c-4bac-a31b-ca438d3e68fa','poornima.parasuraman@even.in'),
        ('3926b406-51c8-4172-8e3d-bb265ccff853','puneeth.bs@even.in'),
        ('d60f594e-8b71-4cd8-afff-afd6b057edaf','sanjeev.mn@even.in'),
        ('30df4231-d46e-4b2e-887f-1fdc4c9f5be9','rahul.p@even.in'),
        ('e3b62af4-d37c-417b-8e12-9bb5e871a33f','sriharee.kulkarni@even.in'),
        ('cd098b4c-458a-4935-a0e2-8d7284285079','nivedita.jha@even.in'),
        ('8a425578-6b5d-4506-b09b-bc3fe875ac7a','vishal.naik@even.in'),
        ('95ff5d32-64b6-417b-837e-9084e36f2578','yashika.s@even.in'),
        ('1a6bf4f6-01e6-4069-87b0-8f627cb9eeff','kiran.joshy@even.in'),
        ('d45d245a-0a8f-47ff-aa49-985ef706e236','anusha.s@even.in'),
        ('ef8e8f91-0d1e-4fdf-b2fe-b2221e8570ef','prabhudev@even.in'),
        ('4c547f18-079a-492a-b1aa-b62574715845','shishirakumar@even.in'),
        ('64a7566f-7b02-4db4-90ea-e8fb754a1176','manoj.s@even.in'),
        ('53b6ada9-5156-4a57-b323-124eb53d1399','nayar.sajeet@even.in'),
        ('cd93300a-6d98-4eb3-9907-0ad65f9ec6d2','harish.puranik@even.in'),
        ('8b9f5597-8aeb-4a81-af75-823c0eb4bad3','basavaraj.utagi@even.in'),
        ('dc46fa05-67ac-4fcf-94d7-57d018f56c47','abrar@even.in'),
        ('b7d78e87-c15c-41cf-924f-e463981963af','avinash.parthasarathy@even.in'),
        ('e8904cbb-82dd-468d-8603-b58687f5e8e4','srinivasan@even.in'),
        ('aab2bc16-9dc4-452d-8068-17808df5ef9c','megha.chouhan@even.in'),
        ('d29db5e7-81e6-43ea-988c-fb61bfa8f539','vineela@even.in'),
        ('92c7afd5-bc24-4470-aba0-6eff326f0c3b','girish.namagondlu@even.in'),
        ('d6be1968-7a5a-42e4-bb55-84d2dc8754c8','mala@even.in'),
        ('f544b3e6-88f6-4b4d-8915-3647c0b4dfb6','soujanya@even.in'),
        ('e971b54d-4c9c-4ee2-94b8-dc9bd19dceb6','gautham.shankar@even.in'),
        ('f637c74d-b136-4364-a1f0-f7c3a79d9809','rebecca.susan@even.in'),
        ('a5896c3d-f9c4-4276-a9d5-6e0386701de8','manukumar.h@even.in'),
        ('5f58b7db-801b-45ff-9ea9-74010f1c403c','vikas.chavan@even.in'),
        ('8da340f2-3e08-4dc7-a7ba-8fe8a28aefb1','sujay.br@even.in'),
        ('15e8e709-5ccd-4e53-b13c-f1ad91474526','abhinandhan.v@even.in'),
        ('cede9c4f-8f8e-4d0c-b0ee-38fbe028ec9b','anthony@even.in'),
        ('d1c0f961-70d9-4061-9c9c-8f309ceaf732','amresh@even.in')
      ) AS v(pid, email)
      WHERE p.id = v.pid::uuid;
    `,
  },
  {
    id: "026_gov_signal_snapshots",
    description:
      "R2 (EPI Redesign PRD v1.4 \u00a74.2): gov_signal_snapshots \u2014 daily CDMSS governance-signal snapshot store powering Overview trends/aging/lifecycle/movers.",
    sql: `
      CREATE TABLE IF NOT EXISTS gov_signal_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source text NOT NULL DEFAULT 'cdmss_opd',
        day date NOT NULL,
        period text NOT NULL DEFAULT 'day',
        generator text,
        payload jsonb NOT NULL,
        fetched_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source, day, period)
      );
      CREATE INDEX IF NOT EXISTS idx_gss_source_day ON gov_signal_snapshots(source, day DESC);
    `,
  },
  {
    id: "027_opd_governance_workflow",
    description:
      "R3b (EPI Redesign PRD v1.4 \u00a76.4-6.6): gov_interventions (did-it-work loop), gov_capture_gaps (EMR asks, seeded from the 2-Jul design report), physicians.cdmss_doctor_uid (CDMSS affected[] join key).",
    sql: `
      ALTER TABLE physicians ADD COLUMN IF NOT EXISTS cdmss_doctor_uid text;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_physicians_cdmss_uid
        ON physicians(cdmss_doctor_uid) WHERE cdmss_doctor_uid IS NOT NULL;

      CREATE TABLE IF NOT EXISTS gov_interventions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        signal_key text NOT NULL,
        signal_label text,
        kind text NOT NULL CHECK (kind IN ('huddle_briefing','supportive_1to1','spot_audit','emr_ask','other')),
        note text,
        physician_id uuid REFERENCES physicians(id),
        actor_email text,
        done_on date NOT NULL DEFAULT current_date,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_gov_interventions_key ON gov_interventions(signal_key, done_on DESC);

      CREATE TABLE IF NOT EXISTS gov_capture_gaps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text UNIQUE NOT NULL,
        attr text NOT NULL,
        source_doc text,
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','with_design','shipped')),
        baseline_mean numeric,
        shipped_at date,
        note text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO gov_capture_gaps (title, attr, source_doc, baseline_mean) VALUES
        ('Assessment/impression field', 'synthesized', 'EHRC-OPD-EMR-CAPTURE-GAP-DESIGN-REPORT-2-JUL-2026', 1.8),
        ('Prompted plan block (working dx / plan / safety-net / follow-up)', 'useful', 'EHRC-OPD-EMR-CAPTURE-GAP-DESIGN-REPORT-2-JUL-2026', 2.1),
        ('Structured HPI prompts (comorbidities + pertinent negatives)', 'thorough', 'EHRC-OPD-EMR-CAPTURE-GAP-DESIGN-REPORT-2-JUL-2026', 1.7),
        ('Med-list + latest-labs auto-pull with copy-forward flagging', 'up_to_date', 'EHRC-OPD-EMR-CAPTURE-GAP-DESIGN-REPORT-2-JUL-2026', 3.1)
      ON CONFLICT (title) DO NOTHING;
    `,
  },
  {
    id: "028_portal_announcements",
    description:
      "R5.1 (EPI R5 Portal PRD v1.1 \u00a74): portal_announcements \u2014 What's new / Coming soon content on the Doctor Portal home, managed via governance MCP tools (no admin UI by V ruling). Seeded incl. an INACTIVE incident-reporting row activated when PORTAL_INCIDENTS flips.",
    sql: `
      CREATE TABLE IF NOT EXISTS portal_announcements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('whats_new','coming_soon')),
        title text NOT NULL,
        body text,
        active boolean NOT NULL DEFAULT true,
        starts_on date,
        ends_on date,
        sort int NOT NULL DEFAULT 0,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_portal_announcements_active ON portal_announcements(active, kind, sort);

      INSERT INTO portal_announcements (kind, title, body, active, sort, created_by)
      SELECT * FROM (VALUES
        ('whats_new', 'A faster, phone-first portal', 'The portal has been redesigned for your phone \u2014 new navigation at the bottom of the screen, everything one thumb-tap away.', true, 1, 'r5-seed'),
        ('whats_new', 'Report incidents from your phone', 'You can now report any incident \u2014 patient safety, staff, facility or service \u2014 straight from the Report tab, named, confidential or anonymous.', false, 2, 'r5-seed'),
        ('coming_soon', 'Medical Councils', 'Even is forming clinical governance councils. Many physicians will be invited to council positions \u2014 invitations, agendas and council business will live here in your portal.', true, 1, 'r5-seed'),
        ('coming_soon', 'IPD Governance', 'Case-level quality and outcome measures for inpatient work, with transparent scoring.', true, 2, 'r5-seed')
      ) AS v(kind, title, body, active, sort, created_by)
      WHERE NOT EXISTS (SELECT 1 FROM portal_announcements WHERE created_by = 'r5-seed');
    `,
  },
  {
    id: "029_physician_feedback_summaries",
    description: "Sprint 3.2 — one current PHI-safe feedback summary per physician. Regenerate overwrites the row. No multi-version history.",
    sql: `
      CREATE TABLE IF NOT EXISTS physician_feedback_summaries (
        physician_id              uuid PRIMARY KEY REFERENCES physicians(id) ON DELETE CASCADE,
        summary_body              text NOT NULL CHECK (char_length(summary_body) > 0),
        generated_at              timestamptz NOT NULL DEFAULT now(),
        model_id                  text NOT NULL,
        vertex_location           text NOT NULL,
        vertex_project            text,
        feedback_count_at_gen     integer NOT NULL CHECK (feedback_count_at_gen >= 0),
        generated_by_profile_id   uuid REFERENCES profiles(id),
        updated_at                timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "030_document_audits",
    description:
      "Stage 4 — Document Audits / RMO authoring. Audits ingested into Governance; findings always record which RMO authored them; target physician remediates via portal. No RMO-as-fixer assignee model.",
    sql: `
      CREATE TABLE IF NOT EXISTS document_audits (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        external_ref      text UNIQUE,
        hospital_id       uuid REFERENCES hospitals(id),
        hospital_code     text NOT NULL,
        physician_id      uuid NOT NULL REFERENCES physicians(id),
        doc_type          text NOT NULL CHECK (doc_type IN ('progress','ot','discharge')),
        note_date         date,
        ingested_at       timestamptz NOT NULL DEFAULT now(),
        last_synced_at    timestamptz,
        cdmss_pdf_url     text,
        triage_routed_at  timestamptz,
        source            text NOT NULL DEFAULT 'cdmss',
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_document_audits_physician ON document_audits(physician_id, ingested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_document_audits_hospital ON document_audits(hospital_code, ingested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_document_audits_triage ON document_audits(physician_id, triage_routed_at)
        WHERE triage_routed_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS document_audit_findings (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        audit_id                  uuid NOT NULL REFERENCES document_audits(id) ON DELETE CASCADE,
        finding_label             text NOT NULL CHECK (char_length(finding_label) > 0),
        finding_body              text,
        severity                  text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
        status                    text NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','in_progress','remediated','contested','escalated')),
        -- RMO authors findings; always retain which RMO wrote them.
        authored_by_profile_id    uuid REFERENCES profiles(id),
        authored_by_name          text NOT NULL CHECK (char_length(authored_by_name) > 0),
        authored_at               timestamptz NOT NULL DEFAULT now(),
        -- Target physician remediates / responds (portal). Not an RMO-fixer assignee.
        physician_id              uuid NOT NULL REFERENCES physicians(id),
        recurrence_count          integer NOT NULL DEFAULT 1 CHECK (recurrence_count >= 1),
        portal_visible            boolean NOT NULL DEFAULT false,
        doctor_response_verb      text CHECK (
          doctor_response_verb IS NULL
          OR doctor_response_verb IN ('agree','disagree','needs_clarification')
        ),
        doctor_response_comment   text,
        doctor_responded_at       timestamptz,
        updated_at                timestamptz NOT NULL DEFAULT now(),
        created_at                timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_daf_status ON document_audit_findings(status, authored_at DESC);
      CREATE INDEX IF NOT EXISTS idx_daf_physician ON document_audit_findings(physician_id, authored_at DESC);
      CREATE INDEX IF NOT EXISTS idx_daf_portal ON document_audit_findings(physician_id)
        WHERE portal_visible = true;
      CREATE INDEX IF NOT EXISTS idx_daf_severity_status ON document_audit_findings(severity, status, authored_at DESC);

      -- Singleton ingest honesty row (Empty / Stale chrome). No invented volumes.
      CREATE TABLE IF NOT EXISTS document_audit_ingest_meta (
        id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        last_success_at   timestamptz,
        last_attempt_at   timestamptz,
        note              text,
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO document_audit_ingest_meta (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `,
  },
  {
    id: "031_document_audit_ingest_keys",
    description:
      "Stage 4 ingest keys for Pipe B: stable finding_ref, queue_item_ref, EHRC-AUD signal reference, note_class, and response_owner (pipe_a vs local). doctor_uid stays server-side.",
    sql: `
      ALTER TABLE document_audits
        ADD COLUMN IF NOT EXISTS note_class text,
        ADD COLUMN IF NOT EXISTS source_audit_id text,
        ADD COLUMN IF NOT EXISTS doctor_uid text;

      ALTER TABLE document_audit_findings
        ADD COLUMN IF NOT EXISTS finding_ref text,
        ADD COLUMN IF NOT EXISTS queue_item_ref text,
        ADD COLUMN IF NOT EXISTS signal_reference text,
        ADD COLUMN IF NOT EXISTS signal_type text,
        ADD COLUMN IF NOT EXISTS note_class text,
        ADD COLUMN IF NOT EXISTS response_owner text;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_daf_audit_finding_ref
        ON document_audit_findings (audit_id, finding_ref)
        WHERE finding_ref IS NOT NULL;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'daf_response_owner_chk'
        ) THEN
          ALTER TABLE document_audit_findings
            ADD CONSTRAINT daf_response_owner_chk
            CHECK (response_owner IS NULL OR response_owner IN ('pipe_a', 'local'));
        END IF;
      END $$;
    `,
  },
  {
    id: "032_gov_document_captures",
    description:
      "Stage 1 OT sheet capture — store-only queue. Images live in private Vercel Blob; this table keeps provenance and status. OCR columns stay null until Stage 2. Does not write surgical_cases.",
    sql: `
      CREATE TABLE IF NOT EXISTS gov_document_captures (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_code text NOT NULL DEFAULT 'EHRC',
        uploaded_by text,
        uploaded_at timestamptz NOT NULL DEFAULT now(),
        user_agent text,
        ip_hash text,
        blob_url text,
        blob_pathname text NOT NULL,
        content_type text NOT NULL,
        bytes integer NOT NULL CHECK (bytes >= 0),
        original_filename text,
        batch_id uuid,
        photo_index integer,
        status text NOT NULL DEFAULT 'queued'
          CHECK (status IN (
            'queued','stored','processing','classified','extracted','needs_review','failed','voided'
          )),
        doc_type text,
        classify_confidence numeric,
        extract_json jsonb,
        extract_confidence numeric,
        error text,
        processed_at timestamptz,
        linked_entity_type text,
        linked_entity_id text,
        voided_at timestamptz,
        voided_by_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
        void_reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_gov_doc_captures_status
        ON gov_document_captures (status, uploaded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gov_doc_captures_hospital
        ON gov_document_captures (hospital_code, uploaded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gov_doc_captures_batch
        ON gov_document_captures (batch_id);
      CREATE INDEX IF NOT EXISTS idx_gov_doc_captures_ip_recent
        ON gov_document_captures (ip_hash, uploaded_at DESC);
    `,
  },
  {
    id: "033_gov_ot_tracking_sheets",
    description:
      "Stage 2 OT sheet OCR. gov_ot_tracking_sheets linked by capture_id. Human review_status starts pending_human. surgical_case_id stays null until Stage 3 drops gov_ot_sheets_no_case_link_stage2. Does not write surgical_cases or OT stream cells.",
    sql: `
      ALTER TABLE gov_document_captures
        ADD COLUMN IF NOT EXISTS prompt_version text,
        ADD COLUMN IF NOT EXISTS model_id text;

      CREATE TABLE IF NOT EXISTS gov_ot_tracking_sheets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        capture_id uuid NOT NULL UNIQUE REFERENCES gov_document_captures(id) ON DELETE CASCADE,
        hospital_code text NOT NULL,
        uhid text,
        ip_no text,
        patient_name text,
        surgery_date date,
        ot_no text,
        anesthesia text,
        surgery_name text,
        surgeon_name text,
        asst_surgeon text,
        anesthetist text,
        antibiotic text,
        antibiotic_at text,
        scrub_nurse text,
        technician text,
        circulating_nurse text,
        scheduled_at text,
        wheel_in text,
        sign_in text,
        induction text,
        time_out text,
        incision text,
        closure text,
        sign_out text,
        wheel_out text,
        equipment_json jsonb,
        notes_json jsonb,
        surgical_case_id uuid,
        review_status text NOT NULL DEFAULT 'pending_human'
          CHECK (review_status IN ('auto', 'pending_human', 'approved', 'rejected')),
        classify_confidence numeric,
        extract_confidence numeric,
        prompt_version text NOT NULL,
        reviewed_by_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
        reviewed_at timestamptz,
        review_note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT gov_ot_sheets_no_case_link_stage2 CHECK (surgical_case_id IS NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_gov_ot_sheets_hospital_review
        ON gov_ot_tracking_sheets (hospital_code, review_status, surgery_date DESC);
      CREATE INDEX IF NOT EXISTS idx_gov_ot_sheets_created
        ON gov_ot_tracking_sheets (created_at DESC);
    `,
  },
  {
    id: "034_portal_login_failures",
    description:
      "A3: failed doctor-portal PIN attempts, keyed by SHA-256 digests of the account identifier and the client IP, so the 5-per-account / 20-per-IP rolling 15-minute limit holds across serverless instances.",
    sql: `
      CREATE TABLE IF NOT EXISTS portal_login_failures (
        id            bigserial PRIMARY KEY,
        subject_kind  text NOT NULL CHECK (subject_kind IN ('account', 'ip')),
        subject_key   text NOT NULL,
        attempted_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_portal_login_failures_lookup
        ON portal_login_failures (subject_kind, subject_key, attempted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_portal_login_failures_age
        ON portal_login_failures (attempted_at);
    `,
  },
  {
    id: "035_document_audit_finding_card_fields",
    description:
      "F4/F5: per-finding card content from the CDMSS export (CDMSS routed verdict, note date, evidence excerpt, citations, patient context) and a content hash so ingest can refresh a finding when CDMSS changes it.",
    sql: `
      ALTER TABLE document_audit_findings
        ADD COLUMN IF NOT EXISTS cdmss_routed boolean,
        ADD COLUMN IF NOT EXISTS note_date date,
        ADD COLUMN IF NOT EXISTS evidence_excerpt text,
        ADD COLUMN IF NOT EXISTS citations_json jsonb,
        ADD COLUMN IF NOT EXISTS patient_json jsonb,
        ADD COLUMN IF NOT EXISTS content_hash text;

      CREATE INDEX IF NOT EXISTS idx_daf_portal_visible
        ON document_audit_findings (physician_id)
        WHERE portal_visible = true;
    `,
  },
  {
    id: "036_physician_cdmss_alias_uids",
    description:
      "F1: duplicate CDMSS identities collapsed into one canonical doctor uid. The physician keeps the canonical uid in cdmss_doctor_uid and the retired duplicates here, so audits that still carry an old uid resolve to the same physician.",
    sql: `
      ALTER TABLE physicians
        ADD COLUMN IF NOT EXISTS cdmss_alias_uids text[];
    `,
  },
  {
    id: "037_gov_interventions_ruling_keys",
    description:
      "Round 2 / F3: governance rulings on routed audit threads. gov_interventions gains the ruling action, an idempotency key (one row per thread + action, so a retried ruling never creates a second row) and the state of the matching CDMSS signal-action call.",
    sql: `
      ALTER TABLE gov_interventions
        ADD COLUMN IF NOT EXISTS action text,
        ADD COLUMN IF NOT EXISTS idempotency_key text,
        ADD COLUMN IF NOT EXISTS cdmss_sync_state text
          CHECK (cdmss_sync_state IS NULL OR cdmss_sync_state IN ('pending', 'synced')),
        ADD COLUMN IF NOT EXISTS cdmss_sync_error text;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_gov_interventions_idem
        ON gov_interventions (idempotency_key);
    `,
  },
  {
    id: "038_document_audit_response_sync",
    description:
      "Round 2 / F3: a doctor's response to a CDMSS-routed document-audit finding is forwarded to CDMSS. Sync state (pending / synced / failed), last error, attempt count and a permanent flag (a 4xx is not retried) are kept per finding; the nightly cron retries the rest.",
    sql: `
      ALTER TABLE document_audit_findings
        ADD COLUMN IF NOT EXISTS cdmss_sync_state text
          CHECK (cdmss_sync_state IS NULL OR cdmss_sync_state IN ('pending', 'synced', 'failed')),
        ADD COLUMN IF NOT EXISTS cdmss_sync_error text,
        ADD COLUMN IF NOT EXISTS cdmss_sync_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cdmss_sync_permanent boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS cdmss_sync_at timestamptz;

      CREATE INDEX IF NOT EXISTS idx_daf_cdmss_sync
        ON document_audit_findings (cdmss_sync_state)
        WHERE cdmss_sync_state IN ('pending', 'failed');
    `,
  },
  {
    id: "039_cdmss_mapping_decisions",
    description:
      "Round 2 / F3: staff decisions on weak doctor-mapping matches. Every confirm (which writes physicians.cdmss_doctor_uid) and reject is recorded with who decided and when; rejected pairs stay off the review list.",
    sql: `
      CREATE TABLE IF NOT EXISTS cdmss_mapping_decisions (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        decision               text NOT NULL CHECK (decision IN ('confirm', 'reject')),
        cdmss_uid              text NOT NULL,
        cdmss_name             text,
        physician_id           uuid REFERENCES physicians(id) ON DELETE SET NULL,
        physician_name         text,
        reason                 text,
        note                   text,
        decided_by_profile_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
        decided_by_email       text NOT NULL,
        decided_at             timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_cdmss_mapping_decisions_pair
        ON cdmss_mapping_decisions (decision, cdmss_uid, physician_id);
      CREATE INDEX IF NOT EXISTS idx_cdmss_mapping_decisions_time
        ON cdmss_mapping_decisions (decided_at DESC);
    `,
  },
  {
    id: "040_ruling_retry_and_legacy_responses",
    description:
      "Round 2 / F3 refuter fixes. (1) gov_interventions keeps the raw ruling note, the thread version the ruling was made against and a retry counter, so a ruling CDMSS did not confirm can be retried by the nightly cron with the same actor and note; a retry CDMSS refuses is marked 'refused'. (2) Every doctor response that exists when this runs is marked 'legacy': it is never forwarded to CDMSS. Only responses recorded after this migration are.",
    sql: `
      ALTER TABLE gov_interventions
        ADD COLUMN IF NOT EXISTS ruling_note text,
        ADD COLUMN IF NOT EXISTS thread_version text,
        ADD COLUMN IF NOT EXISTS cdmss_sync_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cdmss_sync_at timestamptz;

      ALTER TABLE gov_interventions
        DROP CONSTRAINT IF EXISTS gov_interventions_cdmss_sync_state_check;
      ALTER TABLE gov_interventions
        ADD CONSTRAINT gov_interventions_cdmss_sync_state_check
        CHECK (cdmss_sync_state IS NULL OR cdmss_sync_state IN ('pending', 'synced', 'refused'));

      ALTER TABLE document_audit_findings
        DROP CONSTRAINT IF EXISTS document_audit_findings_cdmss_sync_state_check;
      ALTER TABLE document_audit_findings
        ADD CONSTRAINT document_audit_findings_cdmss_sync_state_check
        CHECK (cdmss_sync_state IS NULL OR cdmss_sync_state IN ('pending', 'synced', 'failed', 'legacy'));

      UPDATE document_audit_findings
        SET cdmss_sync_state = 'legacy'
        WHERE cdmss_sync_state IS NULL AND doctor_responded_at IS NOT NULL;
    `,
  },
];

