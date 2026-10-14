import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { log } from '../../log.js'
import { ArtefactError, assertUnderRealRoot, assertWorkerContext, safeJoin } from './errors.js'
import { cfg8FromPath, type ArtefactRef } from './ref.js'
import { bundleSshArgv, readRemoteTrack, rebSourceOf, remoteConfig, REMOTE_EXIT, spawnSsh, type SshRunner } from './transport.js'

/** Slots and layers exactly as consult_bundle.SLOTS. Selection (status, newest, cutter/caa) stays in the Python. */
export const SLOTS = [
  ['stt', 'stt'],
  ['translate', 'translate'],
  ['diar_sarvam', 'diar'],
  ['diar_nemotron', 'diar'],
  ['role_llm', 'role'],
  ['role_judge', 'role'],
  ['role_caa', 'role'],
  ['parts', 'parts'],
  ['acoustics', 'acoustics'],
] as const

export type Slot = (typeof SLOTS)[number][0]

export type BundleResult =
  | { status: 'ok'; refs: Record<Slot, ArtefactRef | null>; source: 'cutter' | 'caa'; unparseable: number }
  | { status: 'unavailable' | 'refused'; error_type: string }

export interface RunResult {
  code: number | null
  stdout: string
  timedOut?: boolean
  /** N1 F2: true when stderr began with `refused:` (a ScopeError). Absent from fakes: exit 2 then reads as refused, as in N1. */
  refused?: boolean
  /** N1 F4: ENOENT, EACCES or output overflow. */
  spawnFailed?: boolean
}
export type Runner = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>

export interface BundleDeps {
  env?: Record<string, string | undefined>
  runner?: Runner
  readFile?: (path: string) => Promise<Buffer>
  realpath?: (path: string) => Promise<string>
  /** t4 source only: runs the ssh argv. */
  sshRunner?: SshRunner
  timeoutMs?: number
}

let latencyLogged = false

/** Test hook: the latency line is logged once per process. */
export function resetBundleLatencyForTest(): void {
  latencyLogged = false
}

const UID = /^[A-Za-z0-9._:-]{1,128}$/
const TIMEOUT_MS = 30_000

const TrackSchema = z.object({
  path: z.string().min(1),
  version: z.string().nullable().optional(),
  engine: z.string().min(1),
  track: z.unknown(),
})
const BundleSchema = z.object({
  source: z.enum(['cutter', 'caa']),
  unparseable_tracks: z.number().int().nonnegative().default(0),
  tracks: z.record(z.string(), TrackSchema.nullable()),
})

/** argv array, no shell. stdout is the counts line only. stderr is read for the `refused:` prefix (a boolean) and dropped: it can name a uid. */
export const spawnRunner: Runner = (argv, opts) =>
  new Promise((done) => {
    const [cmd, ...args] = argv
    execFile(cmd as string, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 1 << 20, shell: false }, (err, stdout, stderr) => {
      if (!err) return done({ code: 0, stdout: String(stdout) })
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
      if (typeof e.code === 'string') return done({ code: null, stdout: '', spawnFailed: true })
      done({ code: typeof e.code === 'number' ? e.code : null, stdout: '', timedOut: e.killed === true, refused: String(stderr).startsWith('refused:') })
    })
  })

function schemaOf(track: unknown, layer: string): string {
  if (track && typeof track === 'object') {
    const t = track as Record<string, unknown>
    for (const k of ['schema', 'version']) {
      const v = t[k]
      if (typeof v === 'string' && v !== '') return v
    }
  }
  return `${layer}/unknown`
}

function outcome(r: BundleResult): BundleResult {
  log(r.status === 'ok' ? 'info' : 'warn', 'artefact.reb_bundle', r.status === 'ok' ? { status: 'ok' } : { status: r.status, error_type: r.error_type })
  return r
}

function refFrom(t: z.infer<typeof TrackSchema>, layer: string, bytes: Buffer): ArtefactRef {
  return {
    store: 'reb',
    path: t.path,
    layer,
    engine: t.engine,
    version: t.version ?? null,
    cfg8: cfg8FromPath(t.path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    schema: schemaOf(t.track, layer),
  }
}

/**
 * Wraps `python3 -m kit.reb.consult_bundle`; refs only leave this function. NEWCAT_REB_SOURCE picks where it runs:
 * 'local' (default): here, --out in a fresh 0700 temp dir, parsed once, removed in a finally block.
 * 't4': on the failover host over ssh; the remote writes --out to its own 0700 temp dir and removes it, only the JSON returns on stdout,
 * and track bodies are read over ssh into memory for the sha. Nothing is written to local disk.
 * The first ok read in the process logs one latency line (source, ms, slots).
 */
export async function readConsultBundle(consultUid: string, deps: BundleDeps = {}): Promise<BundleResult> {
  assertWorkerContext(deps.env)
  const env = deps.env ?? process.env
  if (typeof consultUid !== 'string' || !UID.test(consultUid)) return outcome({ status: 'refused', error_type: 'invalid_uid' })
  const source = rebSourceOf(env)
  if (source === null) return outcome({ status: 'unavailable', error_type: 'transport_failed' })
  const t0 = Date.now()
  const result = source === 't4' ? await readViaT4(consultUid, deps, env) : await readLocal(consultUid, deps, env)
  if (result.status === 'ok' && !latencyLogged) {
    latencyLogged = true
    log('info', 'reb.bundle_latency', { reb_source: source, duration_ms: Date.now() - t0, slots: Object.values(result.refs).filter((r) => r !== null).length })
  }
  return result
}

async function readViaT4(consultUid: string, deps: BundleDeps, env: Record<string, string | undefined>): Promise<BundleResult> {
  let cfg: ReturnType<typeof remoteConfig>
  try {
    cfg = remoteConfig(env)
  } catch (e) {
    return outcome({ status: 'unavailable', error_type: e instanceof ArtefactError ? e.code : 'internal' })
  }
  const run = deps.sshRunner ?? spawnSsh
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  try {
    let r: Awaited<ReturnType<SshRunner>>
    try {
      r = await run(bundleSshArgv(cfg.host, cfg.labDir, cfg.root, consultUid), { timeoutMs })
    } catch {
      return outcome({ status: 'unavailable', error_type: 'spawn_failed' })
    }
    if (r.spawnFailed) return outcome({ status: 'unavailable', error_type: 'spawn_failed' })
    if (r.timedOut) return outcome({ status: 'unavailable', error_type: 'timeout' })
    if (r.code === REMOTE_EXIT.ssh) return outcome({ status: 'unavailable', error_type: 'transport_failed' })
    if (r.code === REMOTE_EXIT.refused) return outcome({ status: 'refused', error_type: 'refused' })
    if (r.code !== 0) return outcome({ status: 'unavailable', error_type: 'nonzero_exit' })

    let parsed: z.infer<typeof BundleSchema>
    try {
      parsed = BundleSchema.parse(JSON.parse(r.stdout.toString('utf8')))
    } catch {
      return outcome({ status: 'unavailable', error_type: 'parse_failed' })
    }
    const refs = {} as Record<Slot, ArtefactRef | null>
    for (const [slot, layer] of SLOTS) {
      const t = parsed.tracks[slot]
      if (!t) {
        refs[slot] = null
        continue
      }
      let bytes: Buffer
      try {
        bytes = await readRemoteTrack(cfg, t.path, run, timeoutMs)
      } catch (e) {
        return outcome({ status: 'unavailable', error_type: e instanceof ArtefactError ? e.code : 'track_unreadable' })
      }
      refs[slot] = refFrom(t, layer, bytes)
    }
    return outcome({ status: 'ok', refs, source: parsed.source, unparseable: parsed.unparseable_tracks })
  } catch {
    return outcome({ status: 'unavailable', error_type: 'internal' })
  }
}

async function readLocal(consultUid: string, deps: BundleDeps, env: Record<string, string | undefined>): Promise<BundleResult> {
  const labDir = env.NEWCAT_ETA_LAB_DIR
  const root = env.NEWCAT_REB_ROOT
  if (!labDir) return outcome({ status: 'unavailable', error_type: 'lab_dir_unset' })
  if (!root) return outcome({ status: 'unavailable', error_type: 'reb_root_unset' })

  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'newcat-reb-'))
    await chmod(dir, 0o700)
    const out = join(dir, 'bundle.json')
    const argv = ['python3', '-m', 'kit.reb.consult_bundle', '--uid', consultUid, '--out', out, '--root', root]
    let run: RunResult
    try {
      run = await (deps.runner ?? spawnRunner)(argv, { cwd: labDir, timeoutMs: deps.timeoutMs ?? TIMEOUT_MS })
    } catch {
      return outcome({ status: 'unavailable', error_type: 'spawn_failed' })
    }
    if (run.spawnFailed) return outcome({ status: 'unavailable', error_type: 'spawn_failed' })
    if (run.timedOut) return outcome({ status: 'unavailable', error_type: 'timeout' })
    // F2: exit 2 is refused only with the `refused:` prefix; argparse also exits 2 and is a plain failure.
    if (run.code === 2 && run.refused !== false) return outcome({ status: 'refused', error_type: 'refused' })
    if (run.code !== 0) return outcome({ status: 'unavailable', error_type: 'nonzero_exit' })

    let parsed: z.infer<typeof BundleSchema>
    try {
      parsed = BundleSchema.parse(JSON.parse(await readFile(out, 'utf8')))
    } catch {
      return outcome({ status: 'unavailable', error_type: 'parse_failed' })
    }

    const read = deps.readFile ?? readFile
    const real = deps.realpath ?? realpath
    const refs = {} as Record<Slot, ArtefactRef | null>
    for (const [slot, layer] of SLOTS) {
      const t = parsed.tracks[slot]
      if (!t) {
        refs[slot] = null
        continue
      }
      const full = safeJoin(root, t.path, join, resolve, sep)
      if (full === null) return outcome({ status: 'unavailable', error_type: 'path_outside_root' })
      let bytes: Buffer
      try {
        await assertUnderRealRoot(root, full, real, sep)
        bytes = await read(full)
      } catch (e) {
        return outcome({ status: 'unavailable', error_type: e instanceof ArtefactError ? e.code : 'track_unreadable' })
      }
      refs[slot] = refFrom(t, layer, bytes)
    }
    return outcome({ status: 'ok', refs, source: parsed.source, unparseable: parsed.unparseable_tracks })
  } catch {
    return outcome({ status: 'unavailable', error_type: 'internal' })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
