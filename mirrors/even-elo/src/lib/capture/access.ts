// Stage 1 OT sheet capture — flag and host gates.
// Dynamic env lookup so Next does not bake FEATURE_OT_CAPTURE at build time
// the way a direct process.env.FEATURE_OT_CAPTURE read can.

export const OT_CAPTURE_FLAG = "FEATURE_OT_CAPTURE";
export const OT_CAPTURE_OCR_FLAG = "FEATURE_OT_CAPTURE_OCR";

export const DEFAULT_UPLOAD_HOST = "upload.governance.evenos.app";

export type EnvSource = Record<string, string | undefined>;

function readRaw(env: EnvSource, name: string): string {
  const raw = env[name];
  return typeof raw === "string" ? raw : "";
}

/**
 * Capture stays off unless FEATURE_OT_CAPTURE is exactly "true"
 * (surrounding whitespace ignored). "false", "1", "TRUE", and unset are off.
 */
export function isOtCaptureEnabled(env: EnvSource = process.env): boolean {
  return readRaw(env, OT_CAPTURE_FLAG).trim() === "true";
}

/**
 * Vertex classify + extract stays off unless FEATURE_OT_CAPTURE_OCR is exactly
 * "true". Unset, "false", "1", and "TRUE" do not call Vertex.
 */
export function isOtCaptureOcrEnabled(env: EnvSource = process.env): boolean {
  return readRaw(env, OT_CAPTURE_OCR_FLAG).trim() === "true";
}

export function uploadCaptureHosts(env: EnvSource = process.env): string[] {
  const extra = readRaw(env, "OT_CAPTURE_UPLOAD_HOSTS")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return [DEFAULT_UPLOAD_HOST, ...extra];
}

/** Host header may include a port. Match the hostname only. */
export function isUploadCaptureHost(hostHeader: string, env: EnvSource = process.env): boolean {
  const bare = hostHeader.trim().toLowerCase().split(":")[0] ?? "";
  if (!bare) return false;
  return uploadCaptureHosts(env).includes(bare);
}

export function isPublicCapturePage(pathname: string): boolean {
  return pathname === "/capture" || pathname.startsWith("/capture/");
}

/** Upload only. Staff queue, image proxy, and void stay on the session gate. */
export function isPublicCaptureApi(pathname: string): boolean {
  return pathname === "/api/capture/upload";
}
