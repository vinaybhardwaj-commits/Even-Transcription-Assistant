/**
 * lib/overnight-translate/door.ts — the driver's only way into the app: the Scribe MCP door.
 *
 * TWO CALLS, THREE SCOPES. `scribe_job_submit` (scope `invoke`) queues a `room_window` job; `scribe_job_status`
 * (scope `read`) reads it back. A window in a Transcript-OFF room is submitted with `switch_override:true`, and
 * `room_window` requires `write` for that one argument (V's ruling of 21 Sep 2026, enforced in `submitJob`, so the
 * caller cannot skip it). So the token this driver needs is one `SCRIBE_MCP_TOKENS` entry for its own actor with
 * scopes ["read","invoke","write"] — NOT the night-drain's read-only one. A token with only read+invoke works for
 * every Transcript-ON window and is refused (403, FATAL `mcp_scope_refused`, the run stops) at the first
 * Transcript-OFF one. The scopes are coarse (`invoke` and `write` also cover the door's other tools); the driver
 * only ever calls the two tools above, and the token sits in a 0600 file, sent in one header and never logged.
 *
 * FAILURE IS CLASSIFIED, because the three kinds call for three different actions:
 *   fatal     401/403 (refused credential, or scope missing: JSON-RPC -32001). Every window would fail the same
 *             way, so the run STOPS. Never retried, never "tried once more".
 *   refused   the door answered but declined THIS request (bad_args, unknown_kind, unknown_job). A fact about
 *             one window: it is recorded and the run moves on.
 *   deferred  network trouble, a timeout, a 5xx or non-JSON. Nothing is known about the window; retry later.
 *
 * The token is a constructor argument held in a closure. It is not on any returned object, not in any error
 * string, and not in any log line (the driver logs codes only; a test greps every log line for it).
 * Modelled on the night-drain's fetchChunkLink (lib/night-drain/audio.ts).
 */
export type DoorConfig = { baseUrl: string; token: string; timeoutMs?: number };
type FetchFn = typeof fetch;

export type DoorFailure =
  | { ok: false; kind: "fatal"; code: "mcp_not_configured" | "mcp_auth_refused" | "mcp_scope_refused" }
  | { ok: false; kind: "refused"; code: string }
  | { ok: false; kind: "deferred"; code: string };

export type SubmitResult = { ok: true; job_id: string } | DoorFailure;

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
export type StatusResult =
  | { ok: true; status: JobState | "unknown"; step: string | null; error_code: string | null; attempts: number | null; failures: number | null }
  | DoorFailure;

/** The args of one `room_window` job as this driver submits it. Two booleans beyond the usual four. */
export type RoomWindowSubmit = {
  window_id: string;
  origin: string;
  actor: string;
  via: "mcp";
  translate: true;
  /** Present (true) ONLY for a window in a room whose own Transcript switch is off. Needs `write` scope. */
  switch_override?: true;
};

const STATES = new Set(["queued", "running", "done", "failed", "cancelled"]);
const isAbort = (e: unknown): boolean => (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError";

export type Door = {
  submitRoomWindow(args: RoomWindowSubmit, signal?: AbortSignal): Promise<SubmitResult>;
  jobStatus(jobId: string, signal?: AbortSignal): Promise<StatusResult>;
};

export function makeDoor(cfg: DoorConfig, f: FetchFn = fetch): Door {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/api/mcp`;
  const token = cfg.token; // closed over; never placed on a returned value

  /** One tools/call. Returns the structuredContent, or a classified failure. */
  async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: true; sc: Record<string, unknown> } | DoorFailure> {
    if (!cfg.baseUrl || !token) return { ok: false, kind: "fatal", code: "mcp_not_configured" };
    const timeout = AbortSignal.timeout(cfg.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: "no-store",
      });
    } catch (e) {
      return { ok: false, kind: "deferred", code: isAbort(e) ? "mcp_timeout" : "mcp_unreachable" };
    }
    if (res.status === 401) return { ok: false, kind: "fatal", code: "mcp_auth_refused" };
    // 403 is the door's own answer for "this token lacks the scope for this tool/kind" (-32001).
    if (res.status === 403) return { ok: false, kind: "fatal", code: "mcp_scope_refused" };
    if (!res.ok) return { ok: false, kind: "deferred", code: "mcp_http_error" };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, kind: "deferred", code: "mcp_http_error" };
    }
    const r = (body ?? {}) as { result?: { structuredContent?: unknown }; error?: unknown };
    if (r.error) return { ok: false, kind: "deferred", code: "mcp_rpc_error" };
    const sc = r.result?.structuredContent;
    if (!sc || typeof sc !== "object" || Array.isArray(sc)) return { ok: false, kind: "deferred", code: "mcp_http_error" };
    return { ok: true, sc: sc as Record<string, unknown> };
  }

  return {
    async submitRoomWindow(args, signal) {
      const c = await call("scribe_job_submit", { kind: "room_window", args }, signal);
      if (!c.ok) return c;
      const sc = c.sc;
      if (sc.ok === true && typeof sc.job_id === "string" && sc.job_id) return { ok: true, job_id: sc.job_id };
      // A closed code from the tool ("bad_args", "unknown_kind"), never free text.
      const code = typeof sc.error === "string" && /^[a-z_]{1,40}$/.test(sc.error) ? sc.error : "submit_refused";
      return { ok: false, kind: "refused", code };
    },

    async jobStatus(jobId, signal) {
      const c = await call("scribe_job_status", { job_id: jobId }, signal);
      if (!c.ok) return c;
      const sc = c.sc;
      if (sc.ok !== true) {
        const code = typeof sc.error === "string" && /^[a-z_]{1,40}$/.test(sc.error) ? sc.error : "status_refused";
        return { ok: false, kind: "refused", code };
      }
      const st = typeof sc.status === "string" && STATES.has(sc.status) ? (sc.status as JobState) : "unknown";
      return {
        ok: true,
        status: st,
        step: typeof sc.step === "string" ? sc.step : null,
        // `error_code` is the published code (jobView maps the raw column through errorCodeOf), never prose.
        error_code: typeof sc.error_code === "string" && /^[a-z_]{1,60}$/.test(sc.error_code) ? sc.error_code : null,
        attempts: typeof sc.attempts === "number" ? sc.attempts : null,
        failures: typeof sc.failures === "number" ? sc.failures : null,
      };
    },
  };
}
