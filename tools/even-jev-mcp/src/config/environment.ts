import { JevApiError } from "../jev/client.js";

export function getJevApiKey(environment: NodeJS.ProcessEnv = process.env): string {
  const apiKey = (environment.JEV_API_KEY?.trim() || environment.TYPESAFE_API_KEY?.trim());
  if (!apiKey) {
    throw new JevApiError(
      "JEV_API_KEY is not set. Export it (or TYPESAFE_API_KEY) before starting your coding agent."
    );
  }
  return apiKey;
}

const DEFAULT_MAX_INPUT_BYTES = 262_144;

export function getMaxInputBytes(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.JEV_MAX_INPUT_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_INPUT_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_INPUT_BYTES;
  return Math.floor(parsed);
}

export function isSecretScreeningDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const raw = environment.JEV_ALLOW_SECRETS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
