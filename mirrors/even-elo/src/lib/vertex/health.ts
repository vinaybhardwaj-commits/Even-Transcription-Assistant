import type { VertexPublicConfig } from "./env";

export type VertexHealthState = "not_configured" | "flag_off" | "ok" | "error";

export interface VertexHealthBody {
  ok: boolean;
  state: VertexHealthState;
  feature_enabled: boolean;
  configured: boolean;
  reachable: boolean | null;
  project: string | null;
  location: string | null;
  model: string | null;
  missing: string[];
  message: string;
}

export function vertexHealthBody(input: {
  publicConfig: VertexPublicConfig;
  reachable: boolean | null;
  errorMessage?: string | null;
}): VertexHealthBody {
  const { publicConfig } = input;
  const base = {
    feature_enabled: publicConfig.featureEnabled,
    configured: publicConfig.configured,
    project: publicConfig.project,
    location: publicConfig.location,
    model: publicConfig.model,
    missing: publicConfig.configured ? [] : publicConfig.missing,
  };

  if (!publicConfig.configured) {
    return {
      ok: false,
      state: "not_configured",
      reachable: null,
      ...base,
      message:
        "Vertex is not configured in this environment. Production holds the service account; Preview and local often do not. No request was sent.",
    };
  }

  if (input.reachable !== true) {
    return {
      ok: false,
      state: "error",
      reachable: false,
      ...base,
      message: input.errorMessage?.trim() || "Vertex request failed",
    };
  }

  if (!publicConfig.featureEnabled) {
    return {
      ok: true,
      state: "flag_off",
      reachable: true,
      ...base,
      message:
        "Credentials accepted and the model responded. FEATURE_VERTEX_SUMMARIES is off, so staff summaries stay gated.",
    };
  }

  return {
    ok: true,
    state: "ok",
    reachable: true,
    ...base,
    message: "Credentials accepted and the model responded. FEATURE_VERTEX_SUMMARIES is on.",
  };
}

function secretNeedles(secret: string): string[] {
  const trimmed = secret.trim();
  if (trimmed.length < 16) return [];
  const needles = [trimmed];
  const escaped = trimmed.replace(/\r?\n/g, "\\n");
  if (escaped !== trimmed) needles.push(escaped);
  for (const line of trimmed.split(/\r?\n/)) {
    const piece = line.trim();
    if (piece.length >= 16 && !piece.includes("BEGIN") && !piece.includes("END")) {
      needles.push(piece);
    }
  }
  return needles;
}

/**
 * Last gate before JSON leaves the process. If a secret survived the error
 * scrubber, drop the message rather than return key material.
 */
export function sealHealthBody(body: VertexHealthBody, secrets: string[]): VertexHealthBody {
  const serialized = JSON.stringify(body);
  const leaked =
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(serialized) ||
    secrets.some((secret) => secretNeedles(secret).some((needle) => serialized.includes(needle)));
  if (!leaked) return body;
  return { ...body, message: "Vertex request failed" };
}
