import "server-only";
import { GoogleGenAI } from "@google/genai";
import { parseVertexConfig, safeVertexErrorMessage, type EnvSource, type VertexCredentials } from "./env";
import { sealHealthBody, vertexHealthBody, type VertexHealthBody } from "./health";

const PING = "Health check. Reply with the single word ok.";
const TIMEOUT_MS = 12_000;
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Server-only Vertex client for Sprint 3.1+.
 * The super-admin health probe and staff summary generation both use
 * createVertexClient. Summary prompts are built outside this module.
 * Pass httpTimeoutMs for long-running RCA/CAPA calls (default 12s for health).
 */
export function createVertexClient(
  credentials: VertexCredentials,
  httpTimeoutMs: number = TIMEOUT_MS,
): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    project: credentials.project,
    location: credentials.location,
    googleAuthOptions: {
      credentials: {
        client_email: credentials.clientEmail,
        private_key: credentials.privateKey,
      },
      scopes: [CLOUD_PLATFORM_SCOPE],
    },
    httpOptions: { timeout: httpTimeoutMs },
  });
}

async function probeVertexModel(credentials: VertexCredentials): Promise<void> {
  const ai = createVertexClient(credentials);
  await ai.models.generateContent({
    model: credentials.model,
    contents: PING,
    config: {
      temperature: 0,
      maxOutputTokens: 64,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    },
  });
}

/**
 * Proves the service account and model when configured.
 * Missing env returns not_configured and does not call Vertex.
 * A successful probe while FEATURE_VERTEX_SUMMARIES is off returns flag_off.
 */
export async function runVertexHealthCheck(env: EnvSource = process.env): Promise<VertexHealthBody> {
  const parsed = parseVertexConfig(env);
  if (!parsed.credentials) {
    return vertexHealthBody({ publicConfig: parsed.publicConfig, reachable: null });
  }
  const secrets = [parsed.credentials.privateKey, parsed.credentials.clientEmail];
  try {
    await probeVertexModel(parsed.credentials);
    return sealHealthBody(
      vertexHealthBody({ publicConfig: parsed.publicConfig, reachable: true }),
      secrets,
    );
  } catch (err) {
    console.error(JSON.stringify({ vertex_health: "error" }));
    return sealHealthBody(
      vertexHealthBody({
        publicConfig: parsed.publicConfig,
        reachable: false,
        errorMessage: safeVertexErrorMessage(err),
      }),
      secrets,
    );
  }
}
