/**
 * lib/lab-execution-context.ts — the Lab v2 research/production isolation boundary
 * (LAB-MCP-V2-PRD-v1.0 §7, decision 6).
 *
 * A Lab v2 run executes a PRODUCTION clinical engine (auditOpdNote and friends) with
 * research inputs. The engine's own code reaches for production IO all over the place:
 * `sql` for the LVC rules and the doctor directory, `metabaseQuery` for db13, `retrieve`
 * for the corpus, the trace writers for observability. None of that may happen on a
 * research run — a research key must not be able to write a production row or spend a
 * production trace id, and it must not be able to do so by ACCIDENT either.
 *
 * The guard is an AsyncLocalStorage store rather than a parameter because the engine is
 * hundreds of call frames deep and threading a flag through all of them would be both a
 * huge diff and a thing a future edit could forget. A context is inherited by every
 * frame beneath it by construction, which is the property we actually want.
 *
 * FAIL-CLOSED. `sql` and `metabaseQuery` THROW inside the context (they are writes or
 * identifying reads); `retrieve` DELEGATES to the edge the caller supplied; the trace
 * writers return without writing. Outside the context every one of those functions is
 * byte-for-byte its current self — the guards are all `if (labExecution())` early exits,
 * so an unguarded (i.e. production) call pays one function call and one undefined check.
 *
 * ⚠️ `withLabExecution` may be imported ONLY from files under `lib/lab-v2/`. That is not
 * a convention, it is a gate: lib/lab-v2/__tests__/isolation.test.ts greps app/** and
 * lib/** and fails the build on any other importer. A stray `withLabExecution` in a
 * request path would silently swap real retrieval for a lab edge on a real patient's
 * note, which is the one failure this whole module exists to make impossible.
 *
 * LabError lives HERE rather than in lib/lab-v2/contracts.ts so that the four guarded
 * core files (db, metabase, retrieve, trace) import exactly one tiny module with no
 * dependencies of its own. contracts.ts re-exports it, so the PRD's "contracts.ts
 * exports LabError" still holds; what it must not do is pull zod into lib/db.ts's
 * module graph, which every route in the app already imports.
 */
import { AsyncLocalStorage } from 'async_hooks';

/** Every error code this platform raises. The MCP surface returns these verbatim. */
export type LabErrorCode =
  | 'SCOPE_DENIED'          // §3.2 — a call to a tool this principal cannot see
  | 'INVALID_INPUT'         // §8 — input schema rejected at dispatch
  | 'NOT_FOUND'             // a run/dataset/experiment id that does not exist
  | 'OWNER_ONLY'            // §8.1 — run_cancel / run_retry on another principal's run
  | 'CASE_NOT_FOUND'        // §8.1 — dataset_create found no such OPD note
  | 'SOURCE_UNAVAILABLE'    // §13 — db13 unreachable during dataset_create
  | 'STORE_UNAVAILABLE'     // §13 — the v2 database is unreachable
  | 'NOT_CONFIGURED'        // LAB_V2_DATABASE_URL unset
  | 'MODEL_UNSUPPORTED'     // §6.1 — (provider, model) not in the capability report
  | 'BUDGET_UNBOUNDED'      // §4.2 — an arm stage with no max_cost_microusd
  | 'STAGE_UNKNOWN'         // §4.2 (decision 11) — an arm names a stage the engine does not list
  | 'BUDGET_EXHAUSTED'      // §6.3 — reservation refused at the cap
  | 'DATASET_HASH_MISMATCH' // §8.1 — experiment_create's dataset_hash does not match
  | 'ENGINE_UNSUPPORTED'    // an engine with no round-1 adapter
  | 'CLASSIFICATION_REQUIRED'// §3.3 / decision 34 — a request body carrying an identifying field
  | 'REPLAY_DIVERGED'        // §10 / decision 45 — a replayed stage's request hash differs from the stored one
  | 'PLAN_STALE'             // §17.6 / decision 68 — the rows a repair plan was built from have moved
  | 'REPAIR_FROZEN_CASE'     // §17.6 / decision 75 — a repair was handed a REPLAY case and refused before writing
  | 'OUTPUT_INVALID'         // §17.6 / decision 72 — a handler's output did not match its own schema
  // ── Slice C, §11 and §17.7 decisions 79a, 80 and 81 ────────────────────────────────
  | 'APPROVAL_MISSING'       // release_apply: no approval binds this release and this hash
  | 'APPROVAL_STALE'         // §11 / decision 81 — the approval expired (7 days)
  | 'APPROVAL_HASH_MISMATCH' // §11 / decision 81 — the artifact changed after it was reviewed
  | 'REVISION_MISMATCH'      // §11 / decision 81 — targets.revision moved under the compare-and-swap
  | 'REVIEWER_IS_PREPARER'   // §11 / decision 5 — one principal may not review its own release
  | 'STAGED_SET_CHANGED'     // §17.7 decision 79a — the label's ids differ from the recorded set
  | 'ACTIVATION_DRIFT'       // §17.7 decision 79a — the activation moved a set we did not record
  | 'ATTRIBUTION_UNVERIFIED'// §6.2 — served model differs from requested
  | 'LAB_IO_FORBIDDEN';     // §7 — production IO attempted inside a lab context

/** The one error type the v2 surface throws. `code` is what the MCP client sees. */
export class LabError extends Error {
  readonly code: LabErrorCode;
  readonly detail?: unknown;
  constructor(code: LabErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'LabError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The three edges a lab run supplies in place of production IO. Everything the engine
 * would otherwise reach for directly arrives through one of these.
 */
export interface LabEdges {
  /** One model call at one named stage. The gateway reserves budget around it. */
  chat: (stage: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** Corpus retrieval. Captured OUTSIDE the context and run under exit() — see §8.1. */
  retrieve: (query: string, opts?: unknown) => Promise<unknown>;
  /** Structured observation on the current item (retrieval_read, stage timings, …). */
  event: (kind: string, body: Record<string, unknown>) => void;
}

const storage = new AsyncLocalStorage<LabEdges>();

/** The current lab edges, or undefined in production. The guards' whole vocabulary. */
export function labExecution(): LabEdges | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with production IO sealed off and `edges` in its place.
 * ⚠️ Importable ONLY from lib/lab-v2/** — enforced by the isolation test.
 */
export function withLabExecution<T>(edges: LabEdges, fn: () => Promise<T>): Promise<T> {
  return storage.run(edges, fn);
}

/**
 * Run `fn` OUTSIDE any lab context, then return to it. This is how the retrieve edge
 * reaches the real corpus: the production retrieval body must run against DATABASE_URL
 * through the normal read path, and it cannot do that while `sql` is throwing. It is
 * the one sanctioned hole in the fence, it is read-only, and it is logged as a
 * `retrieval_read` event on the item so a run's production reads are countable.
 */
export function exitLabExecution<T>(fn: () => T): T {
  return storage.exit(fn);
}
