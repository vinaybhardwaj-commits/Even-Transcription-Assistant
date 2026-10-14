import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/db/open.js'
import type { Sql } from '../../../src/db/sql.js'
import { NEEDS_ALLOWLIST_REVIEW } from '../../../src/platform/cdmss/identifiers.js'
import { assertReadOnly, CdmssClientError, openCdmssConnection, openCdmssReadOnly, type CdmssQuery } from '../../../src/platform/cdmss/client.js'
import {
  CDMSS_SQL,
  clinicalStatesByEncounterRef,
  clinicalStatesBySourceUid,
  clinicalStatesByWindow,
  lvcRecommendationById,
  lvcRecommendations,
  opdAuditsByConsultUid,
  opdAuditsByDoctorUid,
  opdAuditsByPrescriptionUid,
  opdAuditsByWindow,
  otAuditsByDoctorUid,
  otAuditsByUid,
  otAuditsByWindow,
  preopFindingsByEpisodeKey,
  preopFindingsByIndividualUid,
  preopFindingsByWindow,
  CdmssReadError,
} from '../../../src/platform/cdmss/read-models.js'

const ddl = readFileSync(fileURLToPath(new URL('./fixtures/cdmss-ddl.sql', import.meta.url)), 'utf8')

let sql: Sql

beforeAll(async () => {
  sql = await openDatabase(undefined)
  await sql.exec(ddl)
  // Synthetic rows only.
  await sql.exec(`
    INSERT INTO opd_note_audits (uid, consult_uid, doctor_uid, kx_encounter_id, note_date, prescription_type, consult_type, note_quality_index, band, findings, engine_version)
    VALUES ('rx-synth-0001', 'cn-synth-0001', 'dr-synth-0001', 'enc-synth-1', '2026-10-01T05:00:00Z', 'GP', 'GENERAL_PRACTITIONER', 72, 'amber', '[{"code":"X1"}]', 'opd-note-audit/0.1'),
           ('rx-synth-0001', 'cn-synth-0001', 'dr-synth-0001', 'enc-synth-1', '2026-10-01T05:00:00Z', 'GP', 'GENERAL_PRACTITIONER', 80, 'green', '[]', 'opd-note-audit/0.2'),
           ('rx-synth-0002', 'cn-synth-0002', 'dr-synth-0002', NULL, '2026-10-05T05:00:00Z', 'GP', 'HOSPITAL_GP', 55, 'red', NULL, 'opd-note-audit/0.1');
    INSERT INTO ot_note_audits (uid, doctor_uid, surgery_name, note_day, map_status, n_findings, findings, uhid, note)
    VALUES ('ot-synth-0001', 'dr-synth-0001', 'synthetic procedure', '2026-10-02', 'mapped', 1, '[{"code":"O1"}]', 'UH-SYNTH', 'synthetic body'),
           ('ot-synth-0002', NULL, 'synthetic procedure b', '2026-10-09', 'unmapped', 0, NULL, NULL, NULL);
    INSERT INTO preop_findings (episode_key, individual_uid, patient_name, surgery_date, tier, needs_review, snapshot, snapshot_fingerprint)
    VALUES ('ep-synth-0001', 'ind-synth-0001', 'Synthetic Person', '2026-10-20', 'amber', true, '{}', 'fp1'),
           ('ep-synth-0002', 'ind-synth-0001', NULL, '2026-11-20', 'green', false, '{}', 'fp2');
    INSERT INTO clinical_states (doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json)
    VALUES ('ot_note', 'src-synth-0001', 'mem-synth-0001', 'enc-synth-1', 'v1', 'ok', '{"k":1}'),
           ('discharge', 'src-synth-0002', NULL, 'enc-synth-2', 'v1', 'absent', '{}');
    INSERT INTO lvc_recommendations (id, region, society, specialty, statement, action_type, keywords, status)
    VALUES ('cwin-synth-001', 'IN', 'synthetic society', 'cardiology', 'Do not do synthetic thing', 'imaging', ARRAY['k1','k2'], 'active'),
           ('cwus-synth-002', 'US', 'synthetic society', 'cardiology', 'Do not do other thing', 'lab', '{}', 'withdrawn');
  `)
})

afterAll(async () => {
  await sql.close()
})

describe('CDMSS read models against the CDMSS DDL (PGlite)', () => {
  it('opd: by prescription uid returns every engine version, newest first, typed, source cdmss', async () => {
    const rows = await opdAuditsByPrescriptionUid(sql, 'rx-synth-0001')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === 'cdmss')).toBe(true)
    expect(rows[0]?.note_date).toBe('2026-10-01T05:00:00.000Z')
    expect(rows.map((r) => r.note_quality_index).sort()).toEqual([72, 80])
  })

  it('opd: by consult uid, doctor uid and date window', async () => {
    expect(await opdAuditsByConsultUid(sql, 'cn-synth-0002')).toHaveLength(1)
    expect(await opdAuditsByDoctorUid(sql, 'dr-synth-0001')).toHaveLength(2)
    const win = await opdAuditsByWindow(sql, { from: '2026-10-04T00:00:00Z', to: '2026-10-06T00:00:00Z' })
    expect(win.map((r) => r.uid)).toEqual(['rx-synth-0002'])
    expect(win[0]?.kx_encounter_id).toBeNull()
  })

  it('opd: unknown uid is an empty list, limit is clamped', async () => {
    expect(await opdAuditsByPrescriptionUid(sql, 'nope')).toEqual([])
    expect(await opdAuditsByDoctorUid(sql, 'dr-synth-0001', { limit: 1 })).toHaveLength(1)
    expect(await opdAuditsByDoctorUid(sql, 'dr-synth-0001', { limit: -5 })).toHaveLength(1)
  })

  it('ot: by uid, doctor uid and note_day window; note and uhid are not selected', async () => {
    const one = await otAuditsByUid(sql, 'ot-synth-0001')
    expect(one).toHaveLength(1)
    expect(one[0]?.note_day).toBe('2026-10-02')
    expect(one[0]?.source).toBe('cdmss')
    expect(one[0]).not.toHaveProperty('note')
    expect(one[0]).not.toHaveProperty('uhid')
    expect(await otAuditsByDoctorUid(sql, 'dr-synth-0001')).toHaveLength(1)
    const win = await otAuditsByWindow(sql, { from: '2026-10-08', to: '2026-10-10' })
    expect(win.map((r) => r.uid)).toEqual(['ot-synth-0002'])
  })

  it('preop: by episode key, individual uid, surgery_date window; patient_name and snapshot are not selected', async () => {
    const one = await preopFindingsByEpisodeKey(sql, 'ep-synth-0001')
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ source: 'cdmss', tier: 'amber', needs_review: true, surgery_date: '2026-10-20' })
    expect(one[0]).not.toHaveProperty('patient_name')
    expect(one[0]).not.toHaveProperty('uhid')
    expect(one[0]).not.toHaveProperty('snapshot')
    expect(await preopFindingsByIndividualUid(sql, 'ind-synth-0001')).toHaveLength(2)
    const win = await preopFindingsByWindow(sql, { from: '2026-11-01', to: '2026-12-01' })
    expect(win.map((r) => r.episode_key)).toEqual(['ep-synth-0002'])
  })

  it('clinical_states: by source uid, encounter ref and created_at window', async () => {
    const bySource = await clinicalStatesBySourceUid(sql, 'src-synth-0001')
    expect(bySource[0]).toMatchObject({ source: 'cdmss', doc_kind: 'ot_note', state_json: { k: 1 } })
    expect(await clinicalStatesByEncounterRef(sql, 'enc-synth-2')).toHaveLength(1)
    const all = await clinicalStatesByWindow(sql, { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' })
    expect(all).toHaveLength(2)
  })

  it('clinical_states: superseded rows are hidden by default, shown with includeSuperseded', async () => {
    await sql.exec(`INSERT INTO clinical_states (doc_kind, source_uid, encounter_ref, schema_version, status, state_json, superseded_by)
      VALUES ('discharge', 'src-synth-0003', 'enc-synth-3', 'v1', 'absent', '{}', gen_random_uuid())`)
    const w = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' }
    expect(await clinicalStatesBySourceUid(sql, 'src-synth-0003')).toEqual([])
    expect(await clinicalStatesByEncounterRef(sql, 'enc-synth-3')).toEqual([])
    expect(await clinicalStatesByWindow(sql, w)).toHaveLength(2)
    const shown = await clinicalStatesBySourceUid(sql, 'src-synth-0003', { includeSuperseded: true })
    expect(shown).toHaveLength(1)
    expect(shown[0]?.superseded_by).toEqual(expect.any(String))
    expect(await clinicalStatesByWindow(sql, { ...w, includeSuperseded: true })).toHaveLength(3)
  })

  it('errors are code-only: a bad window string never appears in the error', async () => {
    const bad = 'not-a-date-SYNTH-MARKER'
    const err = await opdAuditsByWindow(sql, { from: bad, to: bad }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CdmssReadError)
    expect(err).toMatchObject({ code: 'query_failed', message: 'cdmss_read_query_failed' })
    expect(JSON.stringify(err) + String((err as Error).stack) + String((err as { cause?: unknown }).cause)).not.toContain('SYNTH-MARKER')
    const badRow = { query: async () => ({ rows: [{ id: 5 }] }) } as unknown as Sql
    await expect(opdAuditsByDoctorUid(badRow, 'x')).rejects.toMatchObject({ code: 'bad_row', message: 'cdmss_read_bad_row' })
  })

  it('NEEDS_ALLOWLIST_REVIEW lists the free-text fields stripIdentifiers lets through', () => {
    expect([...NEEDS_ALLOWLIST_REVIEW].sort()).toEqual(['component_json', 'note', 'reviewed_by', 'surgeon'])
  })

  it('lvc: active only, filters by region, specialty and action type, keywords array', async () => {
    const all = await lvcRecommendations(sql)
    expect(all.map((r) => r.id)).toEqual(['cwin-synth-001'])
    expect(all[0]).toMatchObject({ source: 'cdmss', keywords: ['k1', 'k2'] })
    expect(await lvcRecommendations(sql, { region: 'US' })).toEqual([])
    expect(await lvcRecommendations(sql, { actionType: 'imaging', specialty: 'cardiology' })).toHaveLength(1)
    expect((await lvcRecommendationById(sql, 'cwus-synth-002'))?.status).toBe('withdrawn')
    expect(await lvcRecommendationById(sql, 'missing')).toBeNull()
  })

  it('every SQL string is a read: SELECT only, parameterised', () => {
    for (const text of Object.values(CDMSS_SQL)) {
      expect(text.startsWith('SELECT ')).toBe(true)
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i)
      expect(text).toMatch(/\$1/)
    }
  })
})

const probeRow = (over: Record<string, unknown> = {}) =>
  ({ query: async () => ({ rows: [{ read_only_default: true, no_writes: true, no_create: true, ...over }] }) }) as unknown as Sql

describe('read-only boot probe (spec section 13)', () => {
  it('refuses when any of the three conditions fails (stub)', async () => {
    for (const over of [{ read_only_default: false }, { no_writes: false }, { no_create: false }]) {
      await expect(assertReadOnly(probeRow(over))).rejects.toMatchObject({ code: 'writable_role' })
    }
    await expect(assertReadOnly(probeRow())).resolves.toBeUndefined()
  })

  it('sends the three-condition probe', async () => {
    const seen: string[] = []
    const ro = {
      query: async (text: string) => {
        seen.push(text)
        return { rows: [{ read_only_default: true, no_writes: true, no_create: true }] }
      },
    } as unknown as Sql
    await assertReadOnly(ro)
    expect(seen[0]).toContain(`current_setting('default_transaction_read_only')`)
    expect(seen[0]).toContain(`'INSERT,UPDATE,DELETE,TRUNCATE'`)
    expect(seen[0]).toContain(`has_any_column_privilege(c.oid, 'INSERT,UPDATE')`)
    expect(seen[0]).toContain(`has_schema_privilege('public', 'CREATE')`)
  })

  it('fails closed when the probe errors, returns nothing, or returns a non-boolean', async () => {
    const boom = { query: async () => { throw new Error('secret-connection-detail') } } as unknown as Sql
    await expect(assertReadOnly(boom)).rejects.toMatchObject({ code: 'probe_failed', message: 'cdmss_probe_failed' })
    const empty = { query: async () => ({ rows: [] }) } as unknown as Sql
    await expect(assertReadOnly(empty)).rejects.toMatchObject({ code: 'probe_failed' })
    await expect(assertReadOnly(probeRow({ no_create: null }))).rejects.toMatchObject({ code: 'probe_failed' })
  })

  describe('real PGlite roles', () => {
    const asRole = async (role: string, setup: string, readOnlyDefault: boolean) => {
      await sql.exec(`CREATE ROLE ${role}; ${setup}`)
      await sql.exec(`SET ROLE ${role}; ${readOnlyDefault ? 'SET default_transaction_read_only = on;' : ''}`)
    }
    const reset = async () => {
      await sql.exec('RESET default_transaction_read_only; RESET ROLE')
    }
    const expectCode = async (code: string) => {
      try {
        await expect(assertReadOnly(sql)).rejects.toMatchObject({ code })
      } finally {
        await reset()
      }
    }

    it('owner/superuser is refused', async () => {
      await expect(assertReadOnly(sql)).rejects.toBeInstanceOf(CdmssClientError)
    })

    it('UPDATE/DELETE on one table is refused', async () => {
      await asRole('ro_upd', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_upd; GRANT UPDATE, DELETE ON opd_note_audits TO ro_upd;', true)
      await expectCode('writable_role')
    })

    it('INSERT/DELETE on a different table is refused', async () => {
      await asRole('ro_lvc', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_lvc; GRANT INSERT, DELETE ON lvc_recommendations TO ro_lvc;', true)
      await expectCode('writable_role')
    })

    it('column-level INSERT is refused', async () => {
      await asRole('ro_col', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_col; GRANT INSERT (uid, note_quality_index, band) ON opd_note_audits TO ro_col;', true)
      await expectCode('writable_role')
    })

    it('CREATE on schema public is refused', async () => {
      await asRole('ro_cre', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_cre; GRANT CREATE ON SCHEMA public TO ro_cre;', true)
      await expectCode('writable_role')
    })

    it('default_transaction_read_only off is refused', async () => {
      await asRole('ro_off', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_off;', false)
      await expectCode('writable_role')
    })

    it('INSERT on an updatable view is refused (relkind v)', async () => {
      await sql.exec('CREATE VIEW ro_view_opd AS SELECT uid, note_quality_index, band FROM opd_note_audits')
      await asRole('ro_view', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_view; GRANT INSERT ON ro_view_opd TO ro_view;', true)
      try {
        await expect(assertReadOnly(sql)).rejects.toMatchObject({ code: 'writable_role' })
      } finally {
        await reset()
        await sql.exec('DROP VIEW ro_view_opd')
      }
    })

    it('INSERT on a foreign table is refused (relkind f)', async () => {
      await sql.exec('CREATE FOREIGN DATA WRAPPER w; CREATE SERVER s FOREIGN DATA WRAPPER w; CREATE FOREIGN TABLE ft (a int) SERVER s')
      await asRole('ro_ft', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_ft; GRANT INSERT ON ft TO ro_ft;', true)
      try {
        await expect(assertReadOnly(sql)).rejects.toMatchObject({ code: 'writable_role' })
      } finally {
        await reset()
        await sql.exec('DROP FOREIGN TABLE ft; DROP SERVER s; DROP FOREIGN DATA WRAPPER w')
      }
    })

    it('INSERT on a table in another schema is refused', async () => {
      await sql.exec('CREATE SCHEMA other_synth; CREATE TABLE other_synth.t (a int)')
      await asRole('ro_oth', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_oth; GRANT USAGE ON SCHEMA other_synth TO ro_oth; GRANT INSERT ON other_synth.t TO ro_oth;', true)
      try {
        await expect(assertReadOnly(sql)).rejects.toMatchObject({ code: 'writable_role' })
      } finally {
        await reset()
        await sql.exec('DROP SCHEMA other_synth CASCADE')
      }
    })

    it('a clean SELECT-only role with the setting on passes and can read', async () => {
      await asRole('ro_ok', 'REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ro_ok; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_ok;', true)
      try {
        await expect(assertReadOnly(sql)).resolves.toBeUndefined()
        expect((await opdAuditsByPrescriptionUid(sql, 'rx-synth-0001')).length).toBe(2)
      } finally {
        await reset()
      }
    })
  })

  it('openCdmssReadOnly: the handle is query-only (type level and runtime)', async () => {
    const calls: string[] = []
    const fake = {
      query: async (text: string) => {
        calls.push(text)
        return { rows: [{ read_only_default: true, no_writes: true, no_create: true }] }
      },
      exec: async () => undefined,
      withTx: async () => undefined,
      close: async () => undefined,
    } as unknown as Sql
    const handle = await openCdmssReadOnly({ CDMSS_DATABASE_URL_RO: 'postgres://stub' }, async () => fake)
    // @ts-expect-error the handle has no exec
    void handle.exec
    // @ts-expect-error the handle has no withTx
    void handle.withTx
    // @ts-expect-error the handle has no close
    void handle.close
    expect(Object.keys(handle)).toEqual(['query'])
    expect('exec' in handle).toBe(false)
    expect('withTx' in handle).toBe(false)
    expect((handle as unknown as Record<string, unknown>).exec).toBeUndefined()
    const before = calls.length
    await handle.query(CDMSS_SQL.lvcById, ['cwin-synth-001'])
    expect(calls.length).toBe(before + 1)
  })

  it('the handle runs only the registered CDMSS_SQL texts, by string equality', async () => {
    const seen: string[] = []
    const inner = {
      query: async (text: string) =>
        text.includes('default_transaction_read_only')
          ? { rows: [{ read_only_default: true, no_writes: true, no_create: true }] }
          : (seen.push(text), { rows: [] }),
      close: async () => undefined,
    } as unknown as Sql
    const handle = await openCdmssReadOnly({ CDMSS_DATABASE_URL_RO: 'postgres://stub' }, async () => inner)
    for (const text of Object.values(CDMSS_SQL)) await handle.query(text, [])
    expect(seen).toEqual(Object.values(CDMSS_SQL))
    seen.length = 0
    const refused = [
      'SELECT 1',
      `${CDMSS_SQL.lvcById};`,
      `${CDMSS_SQL.lvcById}; SELECT 1`,
      ` ${CDMSS_SQL.lvcById}`,
      CDMSS_SQL.lvcById.toLowerCase(),
      `BEGIN; ${CDMSS_SQL.lvcById}; COMMIT`,
      "SELECT set_config('default_transaction_read_only','off',false)",
      '',
    ]
    for (const reg of Object.values(CDMSS_SQL)) {
      refused.push(`${reg} `, `${reg}\n`, `${reg}\t`, `${reg}; DELETE FROM ot_note_audits`, `${reg};\nSELECT 1`)
    }
    for (const text of refused) {
      await expect(handle.query(text, [])).rejects.toMatchObject({ code: 'sql_not_registered', message: 'cdmss_read_sql_not_registered' })
      await expect(handle.query(text, [])).rejects.toBeInstanceOf(CdmssReadError)
    }
    expect(seen).toEqual([])
  })

  it('openCdmssConnection: the handle is allowlisted and the owner keeps close', async () => {
    let closed = false
    const fake = {
      query: async (text: string) =>
        text.includes('default_transaction_read_only')
          ? { rows: [{ read_only_default: true, no_writes: true, no_create: true }] }
          : { rows: [] },
      close: async () => {
        closed = true
      },
    } as unknown as Sql
    const conn = await openCdmssConnection({ CDMSS_DATABASE_URL_RO: 'postgres://stub' }, async () => fake)
    await expect(conn.query.query('SELECT 1')).rejects.toMatchObject({ code: 'sql_not_registered' })
    expect(await conn.query.query(CDMSS_SQL.lvcById, ['x'])).toEqual({ rows: [] })
    expect(closed).toBe(false)
    await conn.close()
    expect(closed).toBe(true)
  })

  it('read models accept the query-only handle', async () => {
    const queryOnly: CdmssQuery = { query: (t, p) => sql.query(t, p) }
    expect(await opdAuditsByPrescriptionUid(queryOnly, 'rx-synth-0001')).toHaveLength(2)
  })

  it('openCdmssReadOnly: no URL is a refusal, never an in-memory database', async () => {
    let opened = false
    const open = async () => {
      opened = true
      return sql
    }
    await expect(openCdmssReadOnly({}, open)).rejects.toMatchObject({ code: 'not_configured' })
    expect(opened).toBe(false)
  })

  it('openCdmssReadOnly: reads CDMSS_DATABASE_URL_RO, closes the connection when the role is writable', async () => {
    let url: string | undefined
    let closed = false
    const writable = {
      query: async () => ({ rows: [{ read_only_default: true, no_writes: false, no_create: true }] }),
      close: async () => {
        closed = true
      },
    } as unknown as Sql
    await expect(
      openCdmssReadOnly({ CDMSS_DATABASE_URL_RO: 'postgres://stub' }, async (u) => {
        url = u
        return writable
      }),
    ).rejects.toMatchObject({ code: 'writable_role' })
    expect(url).toBe('postgres://stub')
    expect(closed).toBe(true)
  })
})
