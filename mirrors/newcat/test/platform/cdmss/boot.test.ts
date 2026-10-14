import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { loadEnv } from '../../../src/config.js'
import { CDMSS_CONNECT_TIMEOUT_MS, CDMSS_PROBE_TIMEOUT_MS, openBootCdmss } from '../../../src/boot.js'
import type { Sql } from '../../../src/db/sql.js'
import { CDMSS_SQL } from '../../../src/platform/cdmss/read-models.js'

const prod = (extra: Record<string, string> = {}) => loadEnv({ NEWCAT_ENV: 'production', ...extra })
const URL_RO = 'postgres://stub.invalid/synthetic'

const probe = (row: Record<string, unknown>, onClose?: () => void) =>
  ({
    query: async () => ({ rows: [row] }),
    close: async () => onClose?.(),
  }) as unknown as Sql
const ok = { read_only_default: true, no_writes: true, no_create: true }

describe('CDMSS_DATABASE_URL_RO in env and boot', () => {
  it('is optional text; blank counts as unset', () => {
    expect(loadEnv({}).CDMSS_DATABASE_URL_RO).toBeUndefined()
    expect(loadEnv({ CDMSS_DATABASE_URL_RO: '   ' }).CDMSS_DATABASE_URL_RO).toBeUndefined()
    expect(loadEnv({ CDMSS_DATABASE_URL_RO: ` ${URL_RO} ` }).CDMSS_DATABASE_URL_RO).toBe(URL_RO)
  })

  it('unset: boot continues with no handle and never opens a connection', async () => {
    let opened = false
    const conn = await openBootCdmss(prod(), async () => ((opened = true), probe(ok)))
    expect(conn).toBeUndefined()
    expect(opened).toBe(false)
  })

  it('outside production the URL is ignored', async () => {
    let opened = false
    const env = loadEnv({ NEWCAT_ENV: 'test', CDMSS_DATABASE_URL_RO: URL_RO })
    expect(await openBootCdmss(env, async () => ((opened = true), probe(ok)))).toBeUndefined()
    expect(opened).toBe(false)
  })

  it('production + URL + read-only role: returns an allowlisted handle and an owner close', async () => {
    let closed = false
    let url: string | undefined
    const conn = await openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async (u) => ((url = u), probe(ok, () => (closed = true))))
    expect(url).toBe(URL_RO)
    expect(Object.keys(conn!.query)).toEqual(['query'])
    await expect(conn!.query.query('SELECT 1')).rejects.toMatchObject({ code: 'sql_not_registered' })
    expect(Object.values(CDMSS_SQL)).toContain(CDMSS_SQL.lvcById)
    await conn!.close()
    expect(closed).toBe(true)
  })

  it('production + URL + writable role: refuses to boot, naming only the env var, and closes', async () => {
    let closed = false
    const err = await openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async () =>
      probe({ ...ok, no_writes: false }, () => (closed = true)),
    ).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('refusing to boot: CDMSS_DATABASE_URL_RO is not a read-only connection')
    expect((err as Error).message).not.toContain('stub.invalid')
    expect(closed).toBe(true)
  })

  const warnSpy = () => {
    const lines: string[] = []
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => (lines.push(String(c)), true)) as never)
    return { lines, restore: () => w.mockRestore() }
  }

  it('connect error: boots without a handle, logs only cdmss_probe_failed, never the cause', async () => {
    const spy = warnSpy()
    try {
      const conn = await openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async () => {
        throw new Error('password=hunter2 host=stub.invalid')
      })
      expect(conn).toBeUndefined()
    } finally {
      spy.restore()
    }
    const out = spy.lines.join('')
    expect(out).toContain('cdmss_probe_failed')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('stub.invalid')
  })

  it('probe error or non-boolean row: no handle, connection closed', async () => {
    let closed = 0
    const spy = warnSpy()
    try {
      const boom = await openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async () =>
        ({ query: async () => { throw new Error('secret') }, close: async () => void closed++ }) as unknown as Sql,
      )
      expect(boom).toBeUndefined()
      const odd = await openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async () =>
        probe({ ...ok, no_create: 'yes' }, () => void closed++),
      )
      expect(odd).toBeUndefined()
    } finally {
      spy.restore()
    }
    expect(closed).toBe(2)
  })

  it('a probe that never resolves settles within the bound, with no handle, and closes the pool', async () => {
    let closed = false
    const spy = warnSpy()
    try {
      const hung = { query: () => new Promise(() => undefined), close: async () => void (closed = true) } as unknown as Sql
      const conn = await openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async () => hung, 30)
      expect(conn).toBeUndefined()
    } finally {
      spy.restore()
    }
    expect(closed).toBe(true)
  })

  it('a probe and a close that both never resolve still settle within the bound', async () => {
    const spy = warnSpy()
    try {
      const hung = { query: () => new Promise(() => undefined), close: () => new Promise(() => undefined) } as unknown as Sql
      const conn = await Promise.race([
        openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async () => hung, 30),
        new Promise<string>((r) => setTimeout(() => r('STILL PENDING'), 500)),
      ])
      expect(conn).toBeUndefined()
    } finally {
      spy.restore()
    }
  })

  it('passes the driver connect bound to the CDMSS opener, and main DB callers pass nothing', async () => {
    let seen: unknown = 'unset'
    const spy = warnSpy()
    try {
      await openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async (_url, options) => {
        seen = options
        return probe(ok, () => undefined)
      })
    } finally {
      spy.restore()
    }
    expect(seen).toEqual({ connectionTimeoutMillis: CDMSS_CONNECT_TIMEOUT_MS })
    expect(CDMSS_CONNECT_TIMEOUT_MS).toBeLessThan(CDMSS_PROBE_TIMEOUT_MS)
    const src = readFileSync(new URL('../../../src/boot.ts', import.meta.url), 'utf8')
    expect(src).toContain('openDatabase(env.DATABASE_URL)')
  })

  it('an open that never resolves settles within the bound; a late connection is closed', async () => {
    let closed = false
    let release: (s: Sql) => void = () => undefined
    const spy = warnSpy()
    try {
      const conn = await openBootCdmss(
        prod({ CDMSS_DATABASE_URL_RO: URL_RO }),
        () => new Promise<Sql>((resolve) => (release = resolve)),
        30,
      )
      expect(conn).toBeUndefined()
    } finally {
      spy.restore()
    }
    release(probe(ok, () => (closed = true)))
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(true)
  })

  it('a writable role still throws the exact env-var-only message, even when other failures degrade', async () => {
    await expect(
      openBootCdmss(prod({ CDMSS_DATABASE_URL_RO: URL_RO }), async () => probe({ ...ok, read_only_default: false })),
    ).rejects.toThrow(/^refusing to boot: CDMSS_DATABASE_URL_RO is not a read-only connection$/)
  })
})
