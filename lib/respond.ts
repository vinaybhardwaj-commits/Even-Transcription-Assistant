/**
 * lib/respond.ts — standardized API response envelope per PRD §7.5.
 *
 * Every API route MUST funnel error responses through respondError()
 * so the shape is consistent across the app:
 *   { error: { code, message, retry_after_seconds?, trace_id? } }
 */

import { NextResponse } from "next/server";

export type ErrorCode =
  | "PIN_INVALID"
  | "PIN_LOCKED"
  | "PIN_NOT_SET"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION_FAILED"
  | "PIPELINE_FAILED"
  | "SEND_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "RATE_LIMITED";

const HTTP_STATUS: Record<ErrorCode, number> = {
  PIN_INVALID: 401,
  PIN_LOCKED: 423,
  PIN_NOT_SET: 401,
  AUTH_REQUIRED: 401,
  AUTH_EXPIRED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  PIPELINE_FAILED: 500,
  SEND_FAILED: 500,
  UPSTREAM_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
};

export function respondError(
  code: ErrorCode,
  message: string,
  opts?: { retry_after_seconds?: number; trace_id?: string }
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(opts?.retry_after_seconds !== undefined && {
          retry_after_seconds: opts.retry_after_seconds,
        }),
        ...(opts?.trace_id && { trace_id: opts.trace_id }),
      },
    },
    { status: HTTP_STATUS[code] }
  );
}

export function respondOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}
