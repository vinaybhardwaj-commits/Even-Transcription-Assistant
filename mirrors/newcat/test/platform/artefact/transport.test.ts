import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bundleSshArgv,
  REMOTE_PYTHON_KILL_S,
  REMOTE_PYTHON_TERM_S,
  SSH_CONNECT_TIMEOUT_S,
  catSshArgv,
  clearTrackCache,
  readConsultBundle,
  rebSourceOf,
  REMOTE_EXIT,
  resetBundleLatencyForTest,
  resolveTrack,
  SLOTS,
  sshHostOf,
  type Runner,
  type SshRunner,
} from '../../../src/platform/artefact/index.js'

const MARK = 'synthetic-marker-zebra-quartz'
const UID = 'u-synth-1'
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

const T4 = {
  NEWCAT_REB_SOURCE: 't4',
  NEWCAT_REB_SSH_HOST: 'tt4',
  NEWCAT_REB_SSH_LAB_DIR: '/lab/eta-lab',
  NEWCAT_REB_SSH_ROOT: '/data/reb',
}
const REL = '2026-01-01/room_x/_consults/u1/stt__e__aaaaaaaa.json'
const BODY = JSON.stringify({ segments: [{ text: MARK }] })

let logged: string
let fakeFiles: Record<string, Buffer>
let calls: string[][]

function bundleJson(paths: Record<string, string>) {
  const tracks: Record<string, unknown> = Object.fromEntries(SLOTS.map(([s]) => [s, null]))
  for (const [slot, path] of Object.entries(paths)) tracks[slot] = { path, status: 'ok', version: 'v1', engine: 'e', track: { schema: 'reb.stt/1' } }
  return { unparseable_tracks: 0, consult_uid: UID, source: 'cutter', tracks }
}

/** Plays the remote host: the bundle command answers with JSON, a cat command with the file named after `realpath -e -- '<path>'`. */
function remote(bundle: unknown, over: { bundleCode?: number; catCode?: number } = {}): SshRunner {
  return async (argv) => {
    calls.push(argv)
    const cmd = argv[argv.length - 1] as string
    if (cmd.includes('kit.reb.consult_bundle')) return { code: over.bundleCode ?? 0, stdout: Buffer.from(JSON.stringify(bundle)) }
    const p = /realpath -e -- '([^']+)'/.exec(cmd)?.[1] as string
    if (over.catCode) return { code: over.catCode, stdout: Buffer.alloc(0) }
    const f = fakeFiles[p]
    return f ? { code: 0, stdout: f } : { code: REMOTE_EXIT.unreadable, stdout: Buffer.alloc(0) }
  }
}

beforeEach(() => {
  logged = ''
  calls = []
  fakeFiles = { [`/data/reb/${REL}`]: Buffer.from(BODY) }
  clearTrackCache()
  resetBundleLatencyForTest()
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((logged += String(c)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((logged += String(c)), true))
})
afterEach(() => vi.restoreAllMocks())

describe('t4 transport: argv shape', () => {
  it('is an argv array with BatchMode, ConnectTimeout, `--` before the host, and no shell', () => {
    const argv = bundleSshArgv('tt4', '/lab/eta-lab', '/data/reb', UID)
    expect(argv.slice(0, 7)).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes'])
    expect(argv.slice(7, 9)).toEqual(['--', 'tt4'])
    expect(argv).toHaveLength(10)
    const cmd = argv[9] as string
    expect(cmd).toContain(`--uid='${UID}'`)
    expect(cmd).toContain('python3 -m kit.reb.consult_bundle')
  })

  it('removes the remote temp dir in the same command: 0700 mktemp, trap, only stdout returns', () => {
    const cmd = bundleSshArgv('tt4', '/lab/eta-lab', '/data/reb', UID)[9] as string
    expect(cmd).toContain('umask 077')
    expect(cmd).toContain('d=$(mktemp -d)')
    expect(cmd).toContain(`trap 'rm -rf -- "$d"' EXIT`)
    expect(cmd).toContain('--out "$d/bundle.json"')
    expect(cmd).toContain('>/dev/null 2>"$d/err"')
    expect(cmd.indexOf('trap')).toBeLessThan(cmd.indexOf('kit.reb.consult_bundle'))
    expect(cmd.trimEnd().endsWith('cat -- "$d/bundle.json"')).toBe(true)
    expect(cmd).toContain(`'refused:'`)
  })

  it('bounds remote python with timeout -k below the node-side 30 s so the trap always runs', () => {
    const cmd = bundleSshArgv('tt4', '/lab/eta-lab', '/data/reb', UID)[9] as string
    expect(cmd).toContain('timeout -k 5 15 python3 -m kit.reb.consult_bundle')
    expect(REMOTE_PYTHON_TERM_S + REMOTE_PYTHON_KILL_S + SSH_CONNECT_TIMEOUT_S).toBeLessThanOrEqual(30)
  })

  it('cat command compares realpath -e of file and root on the remote', () => {
    const cmd = catSshArgv('tt4', '/data/reb', `/data/reb/${REL}`)[9] as string
    expect(cmd).toContain(`realpath -e -- '/data/reb/${REL}'`)
    expect(cmd).toContain(`realpath -e -- '/data/reb'`)
    expect(cmd).toContain('case "$p" in "$r"/*) cat -- "$p"')
  })

  it('validates the host alias and the source value', () => {
    for (const h of ['tt4', 'eta-lab-t4', 'a.b_c-1']) expect(sshHostOf({ NEWCAT_REB_SSH_HOST: h })).toBe(h)
    for (const h of ['', 'a b', 'a;rm', '-oProxyCommand=x', 'a'.repeat(65), 'a\nb', 'a$(x)', 'user@host']) {
      expect(sshHostOf({ NEWCAT_REB_SSH_HOST: h })).toBeNull()
    }
    expect(sshHostOf({})).toBeNull()
    expect(rebSourceOf({})).toBe('local')
    expect(rebSourceOf({ NEWCAT_REB_SOURCE: 'local' })).toBe('local')
    expect(rebSourceOf({ NEWCAT_REB_SOURCE: 't4' })).toBe('t4')
    expect(rebSourceOf({ NEWCAT_REB_SOURCE: 'r2' })).toBeNull()
  })

  it('validates the uid before any spawn and the remote dirs before any command', async () => {
    const ssh = vi.fn(remote(bundleJson({})))
    for (const uid of ['', 'a b', "a'b", 'a;rm', '$(x)', 'x'.repeat(129), 'a\nb']) {
      expect(await readConsultBundle(uid, { env: T4, sshRunner: ssh })).toEqual({ status: 'refused', error_type: 'invalid_uid' })
    }
    for (const bad of [{ NEWCAT_REB_SSH_HOST: '-x' }, { NEWCAT_REB_SSH_LAB_DIR: "/a'b" }, { NEWCAT_REB_SSH_ROOT: 'rel/dir' }, { NEWCAT_REB_SSH_ROOT: '/a b' }]) {
      expect(await readConsultBundle(UID, { env: { ...T4, ...bad }, sshRunner: ssh })).toEqual({ status: 'unavailable', error_type: 'transport_failed' })
    }
    expect(await readConsultBundle(UID, { env: { ...T4, NEWCAT_REB_SSH_LAB_DIR: undefined }, sshRunner: ssh })).toEqual({ status: 'unavailable', error_type: 'lab_dir_unset' })
    expect(await readConsultBundle(UID, { env: { ...T4, NEWCAT_REB_SOURCE: 'r2' }, sshRunner: ssh })).toEqual({ status: 'unavailable', error_type: 'transport_failed' })
    expect(ssh).not.toHaveBeenCalled()
  })
})

describe('t4 transport: bundle read', () => {
  it('builds refs from remote bytes hashed in node; nothing is written locally; no identifier or body in logs', async () => {
    const r = await readConsultBundle(UID, { env: T4, sshRunner: remote(bundleJson({ stt: REL })) })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.refs.stt?.sha256).toBe(sha(BODY))
    expect(r.refs.stt?.path).toBe(REL)
    expect(r.refs.translate).toBeNull()
    expect(JSON.stringify(r)).not.toContain(MARK)
    expect(calls).toHaveLength(2)
    expect(calls.every((a) => a[0] === 'ssh')).toBe(true)
    expect(logged).not.toContain(MARK)
    expect(logged).not.toContain(UID)
    expect(logged).not.toContain(REL)
    expect(logged).not.toContain('u1')
  })

  it('maps failures to the existing codes plus transport_failed', async () => {
    const ok = bundleJson({ stt: REL })
    const run = (r: SshRunner) => readConsultBundle(UID, { env: T4, sshRunner: r })
    expect(await run(remote(ok, { bundleCode: 255 }))).toEqual({ status: 'unavailable', error_type: 'transport_failed' })
    expect(await run(remote(ok, { bundleCode: REMOTE_EXIT.refused }))).toEqual({ status: 'refused', error_type: 'refused' })
    expect(await run(remote(ok, { bundleCode: REMOTE_EXIT.argparse }))).toEqual({ status: 'unavailable', error_type: 'nonzero_exit' })
    expect(await run(remote(ok, { bundleCode: 1 }))).toEqual({ status: 'unavailable', error_type: 'nonzero_exit' })
    expect(await run(async () => ({ code: null, stdout: Buffer.alloc(0), timedOut: true }))).toEqual({ status: 'unavailable', error_type: 'timeout' })
    expect(await run(async () => ({ code: null, stdout: Buffer.alloc(0), spawnFailed: true }))).toEqual({ status: 'unavailable', error_type: 'spawn_failed' })
    expect(
      await run(async () => {
        throw new Error('ENOENT ssh ' + MARK)
      }),
    ).toEqual({ status: 'unavailable', error_type: 'spawn_failed' })
    expect(await run(async () => ({ code: 0, stdout: Buffer.from('not json ' + MARK) }))).toEqual({ status: 'unavailable', error_type: 'parse_failed' })
    expect(await run(remote(ok, { catCode: 255 }))).toEqual({ status: 'unavailable', error_type: 'transport_failed' })
    expect(await run(remote(ok, { catCode: REMOTE_EXIT.outside }))).toEqual({ status: 'unavailable', error_type: 'path_outside_root' })
    expect(await run(remote(ok, { catCode: REMOTE_EXIT.unreadable }))).toEqual({ status: 'unavailable', error_type: 'track_unreadable' })
    expect(await run(remote(bundleJson({ stt: '../../etc/passwd' })))).toEqual({ status: 'unavailable', error_type: 'path_outside_root' })
    expect(await run(remote(bundleJson({ stt: "a/'; rm -rf x; '.json" })))).toEqual({ status: 'unavailable', error_type: 'path_outside_root' })
    expect(logged).not.toContain(MARK)
  })
})

describe('t4 transport: resolveTrack', () => {
  const ref = (sha256: string) => ({ store: 'reb' as const, path: REL, layer: 'stt', engine: 'e', version: 'v1', cfg8: 'aaaaaaaa', sha256, schema: 'stt/unknown' })

  it('returns the body when the sha matches, using `ssh host cat` only', async () => {
    const ssh = vi.fn(remote({}))
    const body = (await resolveTrack(ref(sha(BODY)), { env: T4, sshRunner: ssh })) as { segments: { text: string }[] }
    expect(body.segments[0]?.text).toBe(MARK)
    expect(ssh).toHaveBeenCalledTimes(1)
    const argv = ssh.mock.calls[0]?.[0] as string[]
    expect(argv.slice(0, 3)).toEqual(['ssh', '-o', 'BatchMode=yes'])
    expect(argv[9]).toContain(`'/data/reb/${REL}'`)
  })

  it('refuses on sha mismatch (artefact_changed) without keeping the body', async () => {
    const err = (await resolveTrack(ref(sha('other')), { env: T4, sshRunner: remote({}) }).catch((e: unknown) => e)) as Error
    expect(err.message).toBe('artefact_changed')
    expect(String(err.stack)).not.toContain(MARK)
  })

  it('refuses a ref path that escapes, a bad character, and maps ssh failures', async () => {
    const ssh = vi.fn(remote({}))
    await expect(resolveTrack({ ...ref(sha(BODY)), path: '../x.json' }, { env: T4, sshRunner: ssh })).rejects.toMatchObject({ code: 'path_outside_root' })
    await expect(resolveTrack({ ...ref(sha(BODY)), path: "a b'.json" }, { env: T4, sshRunner: ssh })).rejects.toMatchObject({ code: 'path_outside_root' })
    expect(ssh).not.toHaveBeenCalled()
    await expect(resolveTrack(ref(sha(BODY)), { env: T4, sshRunner: remote({}, { catCode: 255 }) })).rejects.toMatchObject({ code: 'transport_failed' })
    await expect(resolveTrack(ref(sha(BODY)), { env: T4, sshRunner: remote({}, { catCode: REMOTE_EXIT.outside }) })).rejects.toMatchObject({ code: 'path_outside_root' })
    await expect(resolveTrack(ref(sha(BODY)), { env: { ...T4, NEWCAT_REB_SOURCE: 'x' }, sshRunner: ssh })).rejects.toMatchObject({ code: 'transport_failed' })
    await expect(resolveTrack(ref(sha(BODY)), { env: { ...T4, VERCEL: '1' }, sshRunner: ssh })).rejects.toMatchObject({ code: 'vercel_forbidden' })
  })
})

describe('latency log', () => {
  it('logs one counts-only line on the first ok read, then never again', async () => {
    const deps = { env: T4, sshRunner: remote(bundleJson({ stt: REL })) }
    await readConsultBundle(UID, deps)
    await readConsultBundle(UID, deps)
    const lines = logged.split('\n').filter((l) => l.includes('reb.bundle_latency'))
    expect(lines).toHaveLength(1)
    const o = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(o).toMatchObject({ event: 'reb.bundle_latency', reb_source: 't4', slots: 1 })
    expect(typeof o.duration_ms).toBe('number')
    expect(Object.keys(o).sort()).toEqual(['duration_ms', 'event', 'level', 'reb_source', 'slots', 'ts'])
  })

  it('a failed first read does not consume the one line', async () => {
    await readConsultBundle(UID, { env: T4, sshRunner: remote({}, { bundleCode: 255 }) })
    expect(logged).not.toContain('reb.bundle_latency')
    await readConsultBundle(UID, { env: T4, sshRunner: remote(bundleJson({})) })
    expect(logged.split('\n').filter((l) => l.includes('reb.bundle_latency'))).toHaveLength(1)
  })
})

describe('N1 follow-ups on the local path', () => {
  let root: string
  const SCOPE = '2026-01-01/room_x/_consults/u1'
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'newcat-test-reb-'))
  })
  const env = () => ({ NEWCAT_ETA_LAB_DIR: '/lab', NEWCAT_REB_ROOT: root })
  const writing = (b: unknown, extra: Partial<Awaited<ReturnType<Runner>>> = {}): Runner => async (argv) => {
    writeFileSync(argv[argv.indexOf('--out') + 1] as string, JSON.stringify(b))
    return { code: 0, stdout: '', ...extra }
  }

  it('F1: a symlink inside the root pointing outside is refused (bundle and resolve)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'newcat-test-out-'))
    writeFileSync(join(outside, 'secret.json'), BODY)
    mkdirSync(join(root, SCOPE), { recursive: true })
    symlinkSync(join(outside, 'secret.json'), join(root, SCOPE, 'stt__e__aaaaaaaa.json'))
    const rel = `${SCOPE}/stt__e__aaaaaaaa.json`
    const r = await readConsultBundle('u1', { env: env(), runner: writing(bundleJson({ stt: rel })) })
    expect(r).toEqual({ status: 'unavailable', error_type: 'path_outside_root' })
    const ref = { store: 'reb' as const, path: rel, layer: 'stt', engine: 'e', version: 'v1', cfg8: 'aaaaaaaa', sha256: sha(BODY), schema: 'stt/unknown' }
    await expect(resolveTrack(ref, { env: env() })).rejects.toMatchObject({ code: 'path_outside_root' })
    expect(dirname(root)).toBeTruthy()
  })

  it('F2: exit 2 is refused only with the refused: prefix; argparse exit 2 is nonzero_exit', async () => {
    expect(await readConsultBundle('u1', { env: env(), runner: writing({}, { code: 2, refused: true }) })).toEqual({ status: 'refused', error_type: 'refused' })
    expect(await readConsultBundle('u1', { env: env(), runner: writing({}, { code: 2, refused: false }) })).toEqual({ status: 'unavailable', error_type: 'nonzero_exit' })
  })

  it('F4: ENOENT and output overflow are spawn_failed', async () => {
    expect(await readConsultBundle('u1', { env: env(), runner: async () => ({ code: null, stdout: '', spawnFailed: true }) })).toEqual({ status: 'unavailable', error_type: 'spawn_failed' })
  })

  it('local latency line carries source local', async () => {
    mkdirSync(join(root, SCOPE), { recursive: true })
    writeFileSync(join(root, SCOPE, 'stt__e__aaaaaaaa.json'), BODY)
    const b = bundleJson({ stt: `${SCOPE}/stt__e__aaaaaaaa.json` })
    expect((await readConsultBundle('u1', { env: env(), runner: writing(b) })).status).toBe('ok')
    expect(logged).toContain('"reb_source":"local"')
  })
})
