import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ArtefactChanged, ArtefactError, assertUnderRealRoot, assertWorkerContext, safeJoin } from './errors.js'
import { refKey, type ArtefactRef } from './ref.js'
import { readRemoteTrack, rebSourceOf, remoteConfig, spawnSsh, type SshRunner } from './transport.js'

export interface ResolveDeps {
  env?: Record<string, string | undefined>
  readFile?: (path: string) => Promise<Buffer>
  realpath?: (path: string) => Promise<string>
  /** t4 source only. */
  sshRunner?: SshRunner
  timeoutMs?: number
}

const CACHE_MAX = 32
const cache = new Map<string, { sha256: string; body: unknown }>()

export function clearTrackCache(): void {
  cache.clear()
}

/**
 * Reads the track at read time and checks its bytes against the ref. In-process cache only (keyed by store, path, cfg8; bounded);
 * a hit counts only when it was read under the same sha. Returns a copy so a caller cannot change the cache.
 */
export async function resolveTrack(ref: ArtefactRef, deps: ResolveDeps = {}): Promise<unknown> {
  assertWorkerContext(deps.env)
  if (ref.store !== 'reb') throw new ArtefactError('store_unsupported')
  const env = deps.env ?? process.env
  const source = rebSourceOf(env)
  if (source === null) throw new ArtefactError('transport_failed')
  const key = refKey(ref)
  let full: string | null = null
  let root = ''
  if (source === 'local') {
    root = env.NEWCAT_REB_ROOT ?? ''
    if (!root) throw new ArtefactError('reb_root_unset')
    full = safeJoin(root, ref.path, join, resolve, sep)
    if (full === null) throw new ArtefactError('path_outside_root')
  }
  const hit = cache.get(key)
  if (hit && hit.sha256 === ref.sha256) return structuredClone(hit.body)
  let bytes: Buffer
  if (source === 't4') {
    // Body held in memory only; the path is rebuilt from the validated ref and checked again on the remote with realpath -e.
    bytes = await readRemoteTrack(remoteConfig(env), ref.path, deps.sshRunner ?? spawnSsh, deps.timeoutMs ?? 30_000)
  } else {
    try {
      await assertUnderRealRoot(root, full as string, deps.realpath ?? realpath, sep)
      bytes = await (deps.readFile ?? readFile)(full as string)
    } catch (e) {
      throw e instanceof ArtefactError && e.code === 'path_outside_root' ? e : new ArtefactError('track_unreadable')
    }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new ArtefactChanged()
  let body: unknown
  try {
    body = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ArtefactError('track_unparseable')
  }
  cache.delete(key)
  cache.set(key, { sha256: ref.sha256, body })
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return structuredClone(body)
}
