// lib/episode-state/store.ts — persist EpisodeState (Neon `episode_states`, migrations/0016).
//
// The I/O layer for the projection — schema.ts and build-intra.ts stay PURE; this is the only file
// in the namespace that touches the DB. Idempotent UPSERT on (document_id, version): a re-audit
// refreshes the row in place. De-identified by construction — the state is already PHI-free (the
// toKxEnvelope mapper drops the db13 PHI before the object is built), and only link-back keys
// (document_id / ip_uid) plus the state JSONB are written. No LLM, no db13 read here.

import { sql } from '../db';
import { EPISODE_STATE_VERSION, type EpisodeState } from './schema';

/** Idempotent upsert of one EpisodeState. Keyed by (document_id, version) so a re-audit refreshes
 *  in place and a future schema bump coexists rather than clobbers. Returns whether the row was
 *  freshly inserted or updated. `documentId` is the db13 link-back key (the episode's stable id);
 *  `ip_uid` is read from the state's own episodeRef. */
export async function saveEpisodeState(documentId: string, state: EpisodeState): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!documentId) return 'skipped';
  const rows = (await sql(
    `INSERT INTO episode_states (document_id, ip_uid, version, state)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (document_id, version) DO UPDATE SET
       ip_uid = EXCLUDED.ip_uid, state = EXCLUDED.state, updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [documentId, state.episodeRef || null, state.version, JSON.stringify(state)],
  )) as Array<{ inserted: boolean }>;
  return rows.length ? (rows[0].inserted ? 'inserted' : 'updated') : 'skipped';
}

/** Read the persisted EpisodeState for a document (the current schema version). Read-only — no
 *  build, no re-extract. Returns null when no row exists (the caller renders nothing). */
export async function fetchEpisodeState(documentId: string, version: string = EPISODE_STATE_VERSION): Promise<EpisodeState | null> {
  if (!documentId) return null;
  const rows = (await sql(
    `SELECT state FROM episode_states WHERE document_id = $1 AND version = $2 LIMIT 1`,
    [documentId, version],
  )) as Array<{ state: unknown }>;
  const raw = rows[0]?.state;
  if (raw == null) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as EpisodeState;
}

export { EPISODE_STATE_VERSION };
