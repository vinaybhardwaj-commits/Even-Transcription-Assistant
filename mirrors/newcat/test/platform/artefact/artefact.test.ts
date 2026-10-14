import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArtefactChanged,
  ArtefactRefSchema,
  cfg8FromPath,
  clearTrackCache,
  readConsultBundle,
  refKey,
  resolveTrack,
  SLOTS,
  type Runner,
} from '../../../src/platform/artefact/index.js'

const MARK = 'synthetic-marker-zebra-quartz'
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

let root: string
let files: Record<string, string>
let outPaths: string[]

function put(rel: string, body: unknown): string {
  const text = JSON.stringify(body)
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
  files[rel] = text
  return rel
}

const SCOPE = '2026-01-01/room_x/_consults/u1'
function slotEntry(rel: string, engine: string, version: string | null, track: unknown) {
  return { path: rel, status: 'ok', version, engine, track }
}

function bundleJson(extra: Record<string, unknown> = {}) {
  const tracks: Record<string, unknown> = Object.fromEntries(SLOTS.map(([s]) => [s, null]))
  return { unparseable_tracks: 0, consult_uid: 'u1', scope_path: SCOPE, manifest: {}, source: 'cutter', cutter_row: null, tracks, ...extra }
}

function runnerWriting(content: string | (() => string), code = 0, argvSeen?: string[][]): Runner {
  return async (argv) => {
    argvSeen?.push(argv)
    const out = argv[argv.indexOf('--out') + 1] as string
    outPaths.push(out)
    writeFileSync(out, typeof content === 'function' ? content() : content, { mode: 0o600 })
    return { code, stdout: '{}' }
  }
}

function env(extra: Record<string, string | undefined> = {}) {
  return { NEWCAT_ETA_LAB_DIR: '/lab', NEWCAT_REB_ROOT: root, ...extra }
}

let logged: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'newcat-test-reb-'))
  files = {}
  outPaths = []
  logged = ''
  clearTrackCache()
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((logged += String(c)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((logged += String(c)), true))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('ref', () => {
  it('cfg8FromPath follows consult_bundle counts()', () => {
    expect(cfg8FromPath('d/room/_consults/u1/stt__sarvam__v1__a1b2c3d4.json')).toBe('a1b2c3d4')
    expect(cfg8FromPath('a/b/onlyname.json')).toBe('onlyname')
    expect(cfg8FromPath('x__y.json')).toBe('y')
  })
  it('strict schema, key includes cfg8', () => {
    const ref = { store: 'reb', path: 'a/s__aaaaaaaa.json', layer: 'stt', engine: 'e', version: null, cfg8: 'aaaaaaaa', sha256: sha('x'), schema: 'stt/unknown' }
    expect(ArtefactRefSchema.safeParse(ref).success).toBe(true)
    expect(ArtefactRefSchema.safeParse({ ...ref, extra: 1 }).success).toBe(false)
    expect(ArtefactRefSchema.safeParse({ ...ref, store: 'nope' }).success).toBe(false)
    expect(refKey(ref as never)).not.toBe(refKey({ ...ref, cfg8: 'bbbbbbbb' } as never))
  })
})

describe('readConsultBundle', () => {
  function fullBundle() {
    const b = bundleJson()
    const tracks = b.tracks as Record<string, unknown>
    const spec: Record<string, [string, string, string | null, Record<string, unknown>]> = {
      stt: ['stt', 'sarvam-saaras-v3', 'v1', { schema: 'reb.stt/1', segments: [{ text: MARK }] }],
      translate: ['translate', 'sarvam-mayura-v1', 'v2', { version: 'tr/3', segments: [{ text: MARK }] }],
      diar_sarvam: ['diar', 'sarvam-saaras-v3', null, { segments: [] }],
      diar_nemotron: ['diar', 'nemotron', 'v1', { segments: [] }],
      role_llm: ['role', 'llm-roles', 'v1', { segments: [{ text: MARK }] }],
      role_judge: ['role', 'text-judge', 'v1', { segments: [] }],
    }
    for (const [slot, [layer, engine, version, body]] of Object.entries(spec)) {
      const rel = put(`${SCOPE}/${layer}__${engine}__cfg${slot.length}${slot[0]}00000.json`.replace(/cfg\d/, 'c'), body)
      tracks[slot] = slotEntry(rel, engine, version, body)
    }
    return b
  }

  it('builds refs per slot, nulls stay null, sha from the file bytes, argv is shell-free', async () => {
    const b = fullBundle()
    const seen: string[][] = []
    const r = await readConsultBundle('u1', { env: env(), runner: runnerWriting(JSON.stringify(b), 0, seen) })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.source).toBe('cutter')
    expect(Object.keys(r.refs)).toEqual(SLOTS.map(([s]) => s))
    expect(r.refs.role_caa).toBeNull()
    expect(r.refs.parts).toBeNull()
    expect(r.refs.acoustics).toBeNull()
    for (const [slot, layer] of SLOTS) {
      const ref = r.refs[slot]
      if (!ref) continue
      expect(ArtefactRefSchema.safeParse(ref).success).toBe(true)
      expect(ref.layer).toBe(layer)
      expect(ref.store).toBe('reb')
      expect(ref.sha256).toBe(sha(files[ref.path] as string))
      expect(ref.cfg8).toBe(cfg8FromPath(ref.path))
    }
    expect(r.refs.stt?.schema).toBe('reb.stt/1')
    expect(r.refs.translate?.schema).toBe('tr/3')
    expect(r.refs.diar_sarvam?.schema).toBe('diar/unknown')
    expect(r.refs.diar_sarvam?.version).toBeNull()
    expect(JSON.stringify(r)).not.toContain(MARK)
    expect(seen[0]?.slice(0, 4)).toEqual(['python3', '-m', 'kit.reb.consult_bundle', '--uid'])
    expect(seen[0]).toContain('u1')
    expect(seen[0]?.[seen[0].indexOf('--root') + 1]).toBe(root)
    expect(logged).not.toContain(MARK)
    expect(logged).not.toContain('u1"')
  })

  it('removes the out file and dir on success, with 0700 dir, and on parse failure', async () => {
    let mode = 0
    const probe: Runner = async (argv) => {
      const out = argv[argv.indexOf('--out') + 1] as string
      outPaths.push(out)
      mode = statSync(dirname(out)).mode & 0o777
      writeFileSync(out, JSON.stringify(bundleJson()))
      return { code: 0, stdout: '' }
    }
    expect((await readConsultBundle('u1', { env: env(), runner: probe })).status).toBe('ok')
    expect(mode).toBe(0o700)
    expect(existsSync(outPaths[0] as string)).toBe(false)
    expect(existsSync(dirname(outPaths[0] as string))).toBe(false)

    const bad = await readConsultBundle('u1', { env: env(), runner: runnerWriting(`{"tracks": ${MARK}`) })
    expect(bad).toEqual({ status: 'unavailable', error_type: 'parse_failed' })
    expect(existsSync(dirname(outPaths[1] as string))).toBe(false)
    expect(logged).not.toContain(MARK)
  })

  it('refused: exit 2 and bad uid (no spawn)', async () => {
    const runner = vi.fn(runnerWriting('{}', 2))
    expect(await readConsultBundle('u1', { env: env(), runner })).toEqual({ status: 'refused', error_type: 'refused' })
    expect(existsSync(dirname(outPaths[0] as string))).toBe(false)
    runner.mockClear()
    for (const uid of ['', 'a b', 'a;rm', '../x', 'x'.repeat(129), 'a\nb']) {
      expect(await readConsultBundle(uid, { env: env(), runner })).toEqual({ status: 'refused', error_type: 'invalid_uid' })
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('unavailable: spawn failure, timeout, nonzero exit, missing env, unreadable track, path escape', async () => {
    const boom: Runner = async () => {
      throw new Error('ENOENT python3 ' + MARK)
    }
    expect(await readConsultBundle('u1', { env: env(), runner: boom })).toEqual({ status: 'unavailable', error_type: 'spawn_failed' })
    const slow: Runner = async () => ({ code: null, stdout: '', timedOut: true })
    expect(await readConsultBundle('u1', { env: env(), runner: slow })).toEqual({ status: 'unavailable', error_type: 'timeout' })
    expect(await readConsultBundle('u1', { env: env(), runner: runnerWriting('{}', 1) })).toEqual({ status: 'unavailable', error_type: 'nonzero_exit' })
    expect((await readConsultBundle('u1', { env: env({ NEWCAT_ETA_LAB_DIR: undefined }), runner: slow })).status).toBe('unavailable')
    expect((await readConsultBundle('u1', { env: env({ NEWCAT_REB_ROOT: undefined }), runner: slow })).status).toBe('unavailable')

    const missing = bundleJson()
    ;(missing.tracks as Record<string, unknown>).stt = slotEntry(`${SCOPE}/stt__e__aaaaaaaa.json`, 'e', 'v1', {})
    expect(await readConsultBundle('u1', { env: env(), runner: runnerWriting(JSON.stringify(missing)) })).toEqual({ status: 'unavailable', error_type: 'track_unreadable' })
    const escape = bundleJson()
    ;(escape.tracks as Record<string, unknown>).stt = slotEntry('../../etc/passwd', 'e', 'v1', {})
    expect(await readConsultBundle('u1', { env: env(), runner: runnerWriting(JSON.stringify(escape)) })).toEqual({ status: 'unavailable', error_type: 'path_outside_root' })
    expect(outPaths.every((p) => !existsSync(dirname(p)))).toBe(true)
    expect(logged).not.toContain(MARK)
  })

  it('refuses to run on Vercel', async () => {
    const runner = vi.fn(runnerWriting('{}'))
    await expect(readConsultBundle('u1', { env: env({ VERCEL: '1' }), runner })).rejects.toMatchObject({ code: 'vercel_forbidden' })
    vi.stubEnv('VERCEL', '1')
    await expect(readConsultBundle('u1', { env: env(), runner })).rejects.toMatchObject({ code: 'vercel_forbidden' })
    vi.unstubAllEnvs()
    expect(runner).not.toHaveBeenCalled()
  })

  it.skipIf(!process.env.NEWCAT_ETA_LAB_DIR)('integration: spawns python (needs NEWCAT_ETA_LAB_DIR and NEWCAT_REB_ROOT)', async () => {
    expect(spawnSync('python3', ['--version']).status).toBe(0)
    const r = await readConsultBundle('no-such-consult', { env: process.env })
    expect(['refused', 'unavailable']).toContain(r.status)
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('newcat-reb-'))).toEqual([])
  })
})

describe('resolveTrack', () => {
  function refFor(rel: string) {
    return { store: 'reb' as const, path: rel, layer: 'stt', engine: 'e', version: 'v1', cfg8: cfg8FromPath(rel), sha256: sha(files[rel] as string), schema: 'stt/unknown' }
  }

  it('returns the parsed JSON when the sha matches, caches by key, hands out copies', async () => {
    const rel = put(`${SCOPE}/stt__e__aaaaaaaa.json`, { segments: [{ text: MARK }] })
    const reader = vi.fn(async (p: string) => (await import('node:fs/promises')).readFile(p))
    const ref = refFor(rel)
    const a = (await resolveTrack(ref, { env: env(), readFile: reader })) as { segments: { text: string }[] }
    expect(a.segments[0]?.text).toBe(MARK)
    a.segments[0]!.text = 'mutated'
    const b = (await resolveTrack(ref, { env: env(), readFile: reader })) as { segments: { text: string }[] }
    expect(b.segments[0]?.text).toBe(MARK)
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('throws ArtefactChanged (code only) on sha mismatch, even after a cached read', async () => {
    const rel = put(`${SCOPE}/stt__e__aaaaaaaa.json`, { segments: [{ text: MARK }] })
    const ref = refFor(rel)
    await resolveTrack(ref, { env: env() })
    const changed = { ...ref, sha256: sha('other') }
    const err = (await resolveTrack(changed, { env: env() }).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(ArtefactChanged)
    expect(err.message).toBe('artefact_changed')
    expect(String(err.stack)).not.toContain(MARK)
    clearTrackCache()
    writeFileSync(join(root, rel), '{"edited":true}')
    await expect(resolveTrack(ref, { env: env() })).rejects.toBeInstanceOf(ArtefactChanged)
  })

  it('other refusals: store, root, path escape, missing, unparseable, Vercel', async () => {
    const rel = put(`${SCOPE}/stt__e__aaaaaaaa.json`, {})
    const ref = refFor(rel)
    await expect(resolveTrack({ ...ref, store: 'pulse' }, { env: env() })).rejects.toMatchObject({ code: 'store_unsupported' })
    await expect(resolveTrack(ref, { env: { NEWCAT_ETA_LAB_DIR: '/lab' } })).rejects.toMatchObject({ code: 'reb_root_unset' })
    await expect(resolveTrack({ ...ref, path: '../x.json' }, { env: env() })).rejects.toMatchObject({ code: 'path_outside_root' })
    await expect(resolveTrack({ ...ref, path: 'nope__aaaaaaaa.json' }, { env: env() })).rejects.toMatchObject({ code: 'track_unreadable' })
    writeFileSync(join(root, 'bad__aaaaaaaa.json'), 'not json')
    await expect(resolveTrack({ ...ref, path: 'bad__aaaaaaaa.json', sha256: sha('not json') }, { env: env() })).rejects.toMatchObject({ code: 'track_unparseable' })
    await expect(resolveTrack(ref, { env: env({ VERCEL: '1' }) })).rejects.toMatchObject({ code: 'vercel_forbidden' })
  })
})
