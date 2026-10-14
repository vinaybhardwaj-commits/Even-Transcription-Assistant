import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ArtefactChanged, ArtefactError, assertWorkerContext, safeJoin } from './errors.js'
import { refKey, type ArtefactRef } from './ref.js'

export interface ResolveDeps {
  env?: Record<string, string | undefined>
  readFile?: (path: string) => Promise<Buffer>
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
  const root = (deps.env ?? process.env).NEWCAT_REB_ROOT
  if (!root) throw new ArtefactError('reb_root_unset')
  const full = safeJoin(root, ref.path, join, resolve, sep)
  if (full === null) throw new ArtefactError('path_outside_root')
  const key = refKey(ref)
  const hit = cache.get(key)
  if (hit && hit.sha256 === ref.sha256) return structuredClone(hit.body)
  let bytes: Buffer
  try {
    bytes = await (deps.readFile ?? readFile)(full)
  } catch {
    throw new ArtefactError('track_unreadable')
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
