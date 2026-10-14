import { execFile } from 'node:child_process'
import { posix } from 'node:path'
import { ArtefactError, safeJoin } from './errors.js'

/** Where the REB reader runs: this host's python ('local', default) or the failover host over ssh ('t4'). */
export type RebSource = 'local' | 't4'

export interface SshRunResult {
  code: number | null
  stdout: Buffer
  timedOut?: boolean
  /** ENOENT, EACCES or stdout overflow: the process never ran to a normal exit. */
  spawnFailed?: boolean
}
export type SshRunner = (argv: string[], opts: { timeoutMs: number }) => Promise<SshRunResult>

export const SSH_HOST = /^[A-Za-z0-9._-]{1,64}$/
/** Remote absolute directory, no spaces, quotes or shell characters. */
export const REMOTE_DIR = /^\/[A-Za-z0-9._/+=:@-]{0,255}$/
const REMOTE_REL = /^[A-Za-z0-9._/+=:@-]{1,512}$/
export const SSH_CONNECT_TIMEOUT_S = 10
/**
 * Remote python bound, below the node-side 30 s ssh timeout (reb-bundle.ts TIMEOUT_MS) once the 10 s connect is counted:
 * TERM at 15 s, KILL 5 s later, so at most 20 s + 10 s connect = 30 s worst case. After python dies the shell runs its EXIT trap,
 * so the temp dir is gone before the node side gives up. Python's exit 124 (TERM) or 137 (KILL) surfaces as nonzero_exit.
 */
export const REMOTE_PYTHON_TERM_S = 15
export const REMOTE_PYTHON_KILL_S = 5
const MAX_BUFFER = 64 << 20

/** Remote exit codes the wrapper command uses itself (never python's own). */
export const REMOTE_EXIT = { refused: 2, argparse: 64, outside: 65, unreadable: 66, ssh: 255 } as const

export function rebSourceOf(env: Record<string, string | undefined>): RebSource | null {
  const v = env.NEWCAT_REB_SOURCE
  if (v === undefined || v === '' || v === 'local') return 'local'
  return v === 't4' ? 't4' : null
}

/** Host alias, validated. A leading '-' is refused so it can never read as an ssh option. */
export function sshHostOf(env: Record<string, string | undefined>): string | null {
  const h = env.NEWCAT_REB_SSH_HOST
  return typeof h === 'string' && SSH_HOST.test(h) && !h.startsWith('-') ? h : null
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function sshArgv(host: string, remoteCommand: string): string[] {
  return [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    '-o', 'ClearAllForwardings=yes',
    '--', host, remoteCommand,
  ]
}

/**
 * Remote command for the bundle: the --out file goes to a mktemp -d dir (0700, umask 077) that a trap removes in the same command.
 * Only the JSON comes back on stdout. python's stderr is read on the remote for the `refused:` prefix and never returned:
 * exit 2 from python becomes REMOTE_EXIT.refused only with that prefix, otherwise REMOTE_EXIT.argparse.
 */
export function bundleSshArgv(host: string, labDir: string, root: string, uid: string): string[] {
  const cmd = [
    'umask 077',
    'd=$(mktemp -d) || exit 70',
    `trap 'rm -rf -- "$d"' EXIT`,
    `trap 'exit 143' HUP INT TERM`,
    `cd ${shq(labDir)} || exit 70`,
    `timeout -k ${REMOTE_PYTHON_KILL_S} ${REMOTE_PYTHON_TERM_S} python3 -m kit.reb.consult_bundle --uid=${shq(uid)} --out "$d/bundle.json" --root ${shq(root)} >/dev/null 2>"$d/err"`,
    'rc=$?',
    `if [ "$rc" -eq 2 ]; then if [ "$(head -c 8 "$d/err")" = 'refused:' ]; then exit ${REMOTE_EXIT.refused}; fi; exit ${REMOTE_EXIT.argparse}; fi`,
    '[ "$rc" -eq 0 ] || exit "$rc"',
    'cat -- "$d/bundle.json"',
  ].join('; ')
  return sshArgv(host, cmd)
}

/** Remote command for one track body: realpath -e of the file and of the root, compared on the remote (N1 F1), then cat. */
export function catSshArgv(host: string, root: string, full: string): string[] {
  const cmd = [
    `p=$(realpath -e -- ${shq(full)}) || exit ${REMOTE_EXIT.unreadable}`,
    `r=$(realpath -e -- ${shq(root)}) || exit ${REMOTE_EXIT.unreadable}`,
    `case "$p" in "$r"/*) cat -- "$p";; *) exit ${REMOTE_EXIT.outside};; esac`,
  ].join('; ')
  return sshArgv(host, cmd)
}

/** argv array, shell: false. stderr is never kept (it can name a uid or path). */
export const spawnSsh: SshRunner = (argv, opts) =>
  new Promise((done) => {
    const [cmd, ...args] = argv
    execFile(cmd as string, args, { encoding: 'buffer', timeout: opts.timeoutMs, maxBuffer: MAX_BUFFER, shell: false }, (err, stdout) => {
      if (!err) return done({ code: 0, stdout })
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
      if (typeof e.code === 'string') return done({ code: null, stdout: Buffer.alloc(0), spawnFailed: true })
      done({ code: typeof e.code === 'number' ? e.code : null, stdout: Buffer.alloc(0), timedOut: e.killed === true })
    })
  })

export interface RemoteConfig {
  host: string
  labDir: string
  root: string
}

/** Reads NEWCAT_REB_SSH_HOST, NEWCAT_REB_SSH_LAB_DIR, NEWCAT_REB_SSH_ROOT (remote paths). Code-only failures. */
export function remoteConfig(env: Record<string, string | undefined>): RemoteConfig {
  const host = sshHostOf(env)
  if (host === null) throw new ArtefactError('transport_failed')
  const labDir = env.NEWCAT_REB_SSH_LAB_DIR
  const root = env.NEWCAT_REB_SSH_ROOT
  if (!labDir) throw new ArtefactError('lab_dir_unset')
  if (!root) throw new ArtefactError('reb_root_unset')
  if (!REMOTE_DIR.test(labDir) || !REMOTE_DIR.test(root)) throw new ArtefactError('transport_failed')
  return { host, labDir, root }
}

/** Reads one track body from the remote host into memory. Bodies are never written to local disk. */
export async function readRemoteTrack(cfg: RemoteConfig, rel: string, run: SshRunner, timeoutMs: number): Promise<Buffer> {
  if (!REMOTE_REL.test(rel)) throw new ArtefactError('path_outside_root')
  const full = safeJoin(cfg.root, rel, posix.join, posix.resolve, posix.sep)
  if (full === null) throw new ArtefactError('path_outside_root')
  let r: SshRunResult
  try {
    r = await run(catSshArgv(cfg.host, cfg.root, full), { timeoutMs })
  } catch {
    throw new ArtefactError('spawn_failed')
  }
  if (r.spawnFailed) throw new ArtefactError('spawn_failed')
  if (r.timedOut) throw new ArtefactError('timeout')
  if (r.code === REMOTE_EXIT.ssh) throw new ArtefactError('transport_failed')
  if (r.code === REMOTE_EXIT.outside) throw new ArtefactError('path_outside_root')
  if (r.code !== 0) throw new ArtefactError('track_unreadable')
  return r.stdout
}
