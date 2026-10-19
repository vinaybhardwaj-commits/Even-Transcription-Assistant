/**
 * tests/support/mcp-oauth-fake-store.ts — an in-memory stand-in for lib/mcp/oauth/store with the SAME atomic semantics (single-use claim, rotation claim).
 * The SQL itself is exercised by tests/unit/mcp-oauth-o2-pg.test.ts against a real Postgres when Docker is available.
 */
import { REFRESH_FAMILY_MAX_AGE_S, SESSION_MAX_AGE_S } from "@/lib/mcp/oauth/config";
import type { ClientRow, CodeRow, PersonRow, TokenRow } from "@/lib/mcp/oauth/store";

let clock = 0;
const tick = (): number => ++clock; // a strictly increasing stand-in for now(), so "created after granted" is exact
export const state = {
  people: new Map<string, PersonRow>(),
  clients: new Map<string, ClientRow>(),
  codes: new Map<string, CodeRow & { exp: number }>(),
  tokens: new Map<string, TokenRow & { exp: number }>(),
  families: new Set<string>(), // the tombstones
  granted: new Map<string, number>(), // email -> tick of the last (re)grant
  created: new Map<string, number>(), // token hash -> tick of creation
  codeCreated: new Map<string, number>(), // code hash -> tick of creation
  burned: new Set<string>(), // R3: consent csrf hashes already used
  emailCodes: new Map<string, { id: string; pending_id: string; email: string; code_hash: string; attempts: number; used: boolean; exp: number; created: number; seq: number; lastAtt?: number }>(),
  emailLocks: new Map<string, number>(), // R4: address -> locked_until (nowE based)
  familyBorn: new Map<string, number>(), // family id -> Date.now() of its first token (R2 F3); a test may backdate it
};
export function resetFakeStore(): void {
  for (const m of Object.values(state)) m.clear();
  emailClock.offsetMs = 0;
  blacklistedFake.clear();
}
export const addPerson = (email: string, scopes = ["read", "invoke", "write", "admin"], status: "active" | "revoked" = "active"): void => {
  const old = state.people.get(email);
  if (!old || old.status !== status) state.granted.set(email, tick()); // a scope change on an unchanged status keeps granted_at, like the SQL
  state.people.set(email, { email, scopes, status });
};
const predates = (hash: string, email: string): boolean => (state.created.get(hash) ?? Infinity) < (state.granted.get(email) ?? -Infinity);

export const familyOfCode = (h: string): string => `f_${h.slice(0, 32)}`;
export const getPerson = async (email: string) => state.people.get(email) ?? null;
export const getClient = async (id: string) => state.clients.get(id) ?? null;
export const upsertClient = async (c: { client_id: string; kind: "cimd" | "dcr"; redirect_uris: string[]; metadata_url: string | null; client_name: string | null }) => {
  const old = state.clients.get(c.client_id);
  if (old && old.kind !== "cimd") return;
  state.clients.set(c.client_id, { ...c, created_at: new Date().toISOString() });
};
export const touchClient = async (_id: string) => {};
export const personGrantedSinceCode = async (email: string, codeHash: string, _ttlS: number) => (state.granted.get(email) ?? -Infinity) >= (state.codeCreated.get(codeHash) ?? Infinity);
export const insertCode = async (c: { code_hash: string; client_id: string; email: string; code_challenge: string; redirect_uri: string; resource: string; scopes: string[]; ttl_s: number; key_id?: string | null }) => {
  state.codeCreated.set(c.code_hash, tick());
  state.codes.set(c.code_hash, { code_hash: c.code_hash, client_id: c.client_id, email: c.email, code_challenge: c.code_challenge, redirect_uri: c.redirect_uri, resource: c.resource, scopes: c.scopes, key_id: c.key_id ?? null, expires_at: "", used_at: null, exp: Date.now() + c.ttl_s * 1000 });
};
export const burnConsent = async (h: string) => {
  if (state.burned.has(h)) return false;
  state.burned.add(h);
  return true;
};
export const claimCode = async (h: string) => {
  const c = state.codes.get(h);
  if (!c || c.used_at || c.exp <= Date.now()) return null;
  c.used_at = new Date().toISOString();
  return c;
};
export const codeWasUsed = async (h: string) => Boolean(state.codes.get(h)?.used_at);
export const insertToken = async (t: { token_hash: string; kind: "access" | "refresh"; email: string; client_id: string; scopes: string[]; resource: string; family_id: string; ttl_s: number; key_id?: string | null }) => {
  if (state.families.has(t.family_id)) return false;
  state.created.set(t.token_hash, tick());
  if (!state.familyBorn.has(t.family_id)) state.familyBorn.set(t.family_id, Date.now());
  state.tokens.set(t.token_hash, { token_hash: t.token_hash, kind: t.kind, email: t.email, client_id: t.client_id, scopes: t.scopes, resource: t.resource, family_id: t.family_id, key_id: t.key_id ?? null, expires_at: "", revoked_at: null, rotated_to: null, exp: Date.now() + t.ttl_s * 1000 });
  return true;
};
export const familyRevoked = async (fam: string) => state.families.has(fam);
export const getToken = async (h: string, familyMaxAgeS = REFRESH_FAMILY_MAX_AGE_S) => {
  const t = state.tokens.get(h);
  const born = t ? state.familyBorn.get(t.family_id) : undefined;
  return t ? { ...t, expired: t.exp <= Date.now(), family_revoked: state.families.has(t.family_id), predates_grant: predates(h, t.email), family_expired: born !== undefined && born <= Date.now() - familyMaxAgeS * 1000 } : null;
};
export const claimRefresh = async (oldHash: string, newHash: string) => {
  const t = state.tokens.get(oldHash);
  if (!t || t.kind !== "refresh" || t.rotated_to || t.revoked_at || t.exp <= Date.now() || state.families.has(t.family_id)) return false;
  t.rotated_to = newHash;
  return true;
};
export const revokeFamily = async (fam: string, _reason = "revoked") => {
  state.families.add(fam);
  for (const t of state.tokens.values()) if (t.family_id === fam && !t.revoked_at) t.revoked_at = new Date().toISOString();
};

// ─── O3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const lookupFail = { on: false };
export const lookupAccessToken = async (h: string) => {
  if (lookupFail.on) throw new Error("db_down");
  const t = state.tokens.get(h);
  if (!t || t.kind !== "access") return null;
  const p = state.people.get(t.email);
  const born = state.familyBorn.get(t.family_id);
  return { ...t, expired: t.exp <= Date.now(), family_expired: born !== undefined && born <= Date.now() - SESSION_MAX_AGE_S * 1000, family_revoked: state.families.has(t.family_id), predates_grant: predates(h, t.email), person_status: p?.status ?? null, person_scopes: p?.scopes ?? null };
};
export const grantPerson = async (email: string, scopes: string[], _by: string) => {
  const prev = state.people.get(email)?.status ?? null;
  if (prev !== "active") state.granted.set(email, tick());
  state.people.set(email, { email, scopes, status: "active" });
  return { email, scopes, status: "active" as const, granted_at: new Date().toISOString(), revoked_at: null, previous_status: prev };
};
export const listPeople = async () => [...state.people.values()].map((p) => ({ email: p.email, scopes: p.scopes, status: p.status, granted_at: "t", revoked_at: null }));
export const revokePerson = async (email: string, _by: string) => {
  const p = state.people.get(email);
  let n = 0;
  for (const t of state.tokens.values()) if (t.email === email && !t.revoked_at) { t.revoked_at = new Date().toISOString(); n += 1; }
  const wasActive = p?.status === "active";
  if (p) p.status = "revoked";
  const fams = new Set([...state.tokens.values()].filter((t) => t.email === email).map((t) => t.family_id));
  for (const f of fams) state.families.add(f);
  return { person_found: Boolean(p), was_active: wasActive, tokens_revoked: n, families_tombstoned: fams.size };
};

// ─── email codes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let emailSeq = 0;
/** a test may move time: rows are aged by subtracting from `created` and `exp` through this offset */
export const emailClock = { offsetMs: 0 };
const nowE = (): number => Date.now() + emailClock.offsetMs;
export const insertEmailCode = async (c: { pending_id: string; email: string; code_hash: string; ttl_s: number; lock_s?: number; max_per_email: number; window_s: number; max_attempts: number }) => {
  const rows = [...state.emailCodes.values()];
  if ((state.emailLocks.get(c.email) ?? 0) > nowE()) return null;
  if (rows.filter((r) => r.email === c.email && (r.lastAtt ?? -Infinity) > nowE() - (c.lock_s ?? 900) * 1000).reduce((a, r) => a + r.attempts, 0) >= c.max_attempts) return null; // the 15 min address lock
  if (rows.filter((r) => r.email === c.email && r.created > nowE() - c.window_s * 1000).length >= c.max_per_email) return null;
  if (rows.filter((r) => r.pending_id === c.pending_id).reduce((a, r) => a + r.attempts, 0) >= c.max_attempts) return null;
  const id = String(++emailSeq);
  state.emailCodes.set(id, { id, pending_id: c.pending_id, email: c.email, code_hash: c.code_hash, attempts: 0, used: false, exp: nowE() + c.ttl_s * 1000, created: nowE(), seq: emailSeq });
  return id;
};
export const countRecentEmailCodes = async (email: string, windowS: number) => [...state.emailCodes.values()].filter((r) => r.email === email && r.created > nowE() - windowS * 1000).length;
export const deleteEmailCode = async (id: string) => { state.emailCodes.delete(id); };
export const takeEmailAttempt = async (pendingId: string, max: number, lockS = 900) => {
  const mine = [...state.emailCodes.values()].filter((r) => r.pending_id === pendingId);
  const live = mine.filter((r) => !r.used && r.exp > nowE() && r.attempts < max).sort((a, b) => b.seq - a.seq)[0];
  if (!live || mine.reduce((a, r) => a + r.attempts, 0) >= max) return null;
  if ((state.emailLocks.get(live.email) ?? 0) > nowE()) return null;
  if ([...state.emailCodes.values()].filter((r) => r.email === live.email && (r.lastAtt ?? -Infinity) > nowE() - lockS * 1000).reduce((a, r) => a + r.attempts, 0) >= max) return null;
  live.attempts += 1;
  live.lastAtt = nowE();
  if ([...state.emailCodes.values()].filter((r) => r.email === live.email && (r.lastAtt ?? -Infinity) > nowE() - lockS * 1000).reduce((a, r) => a + r.attempts, 0) >= max) state.emailLocks.set(live.email, Math.max(state.emailLocks.get(live.email) ?? 0, nowE() + lockS * 1000));
  return { id: live.id, email: live.email, code_hash: live.code_hash };
};
export const consumeEmailCode = async (id: string) => {
  const r = state.emailCodes.get(id);
  if (!r || r.used) return false;
  r.used = true;
  return true;
};

/** R6: addresses the fake treats as blacklisted (the real store reads mcp_identity). Cleared by resetFakeStore callers via .clear(). */
export const blacklistedFake = new Set<string>();
export const addressBlacklisted = async (email: string): Promise<boolean> => blacklistedFake.has(email);
