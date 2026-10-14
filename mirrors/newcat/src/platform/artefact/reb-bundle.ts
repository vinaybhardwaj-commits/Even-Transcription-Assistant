import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { log } from '../../log.js'
import { assertWorkerContext, safeJoin } from './errors.js'
import { cfg8FromPath, type ArtefactRef } from './ref.js'

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
}
export type Runner = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>

export interface BundleDeps {
  env?: Record<string, string | undefined>
  runner?: Runner
  readFile?: (path: string) => Promise<Buffer>
  timeoutMs?: number
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

/** argv array, no shell. stdout is the counts line only; stderr is discarded (it can name a uid). */
export const spawnRunner: Runner = (argv, opts) =>
  new Promise((done) => {
    const [cmd, ...args] = argv
    execFile(cmd as string, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 1 << 20, shell: false }, (err, stdout) => {
      if (!err) return done({ code: 0, stdout: String(stdout) })
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
      done({ code: typeof e.code === 'number' ? e.code : null, stdout: '', timedOut: e.killed === true })
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

/**
 * Wraps `python3 -m kit.reb.consult_bundle`. The --out file holds track bodies (transcript text): it lives in a fresh 0700 temp dir,
 * is parsed once, and is removed in a finally block. Only refs leave this function.
 */
export async function readConsultBundle(consultUid: string, deps: BundleDeps = {}): Promise<BundleResult> {
  assertWorkerContext(deps.env)
  const env = deps.env ?? process.env
  if (typeof consultUid !== 'string' || !UID.test(consultUid)) return outcome({ status: 'refused', error_type: 'invalid_uid' })
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
    if (run.timedOut) return outcome({ status: 'unavailable', error_type: 'timeout' })
    if (run.code === 2) return outcome({ status: 'refused', error_type: 'refused' })
    if (run.code !== 0) return outcome({ status: 'unavailable', error_type: 'nonzero_exit' })

    let parsed: z.infer<typeof BundleSchema>
    try {
      parsed = BundleSchema.parse(JSON.parse(await readFile(out, 'utf8')))
    } catch {
      return outcome({ status: 'unavailable', error_type: 'parse_failed' })
    }

    const read = deps.readFile ?? readFile
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
        bytes = await read(full)
      } catch {
        return outcome({ status: 'unavailable', error_type: 'track_unreadable' })
      }
      refs[slot] = {
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
    return outcome({ status: 'ok', refs, source: parsed.source, unparseable: parsed.unparseable_tracks })
  } catch {
    return outcome({ status: 'unavailable', error_type: 'internal' })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
