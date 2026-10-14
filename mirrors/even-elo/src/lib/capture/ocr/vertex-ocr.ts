import "server-only";
import { createVertexClient } from "@/lib/vertex/client";
import { safeVertexErrorMessage, type VertexCredentials } from "@/lib/vertex/env";

const TIMEOUT_MS = 35_000;

export class VertexOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VertexOcrError";
  }
}

export async function vertexOcrText(input: {
  credentials: VertexCredentials;
  system: string;
  user: string;
  image?: { mimeType: string; base64: string } | null;
  maxOutputTokens: number;
}): Promise<string> {
  const ai = createVertexClient(input.credentials, TIMEOUT_MS);
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (input.image) {
    parts.push({ inlineData: { mimeType: input.image.mimeType, data: input.image.base64 } });
  }
  parts.push({ text: input.user });
  try {
    const response = await ai.models.generateContent({
      model: input.credentials.model,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: input.system,
        temperature: 0,
        maxOutputTokens: input.maxOutputTokens,
        responseMimeType: "application/json",
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    return typeof response.text === "string" ? response.text : "";
  } catch (error) {
    throw new VertexOcrError(safeVertexErrorMessage(error));
  }
}
