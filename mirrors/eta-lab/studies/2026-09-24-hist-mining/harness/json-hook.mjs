// Loader hook: serve .json modules as JSON without the `with {type:"json"}` attribute, so pinned production TS runs UNMODIFIED.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) return { format: "json", source: readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
  return nextLoad(url, context);
}
