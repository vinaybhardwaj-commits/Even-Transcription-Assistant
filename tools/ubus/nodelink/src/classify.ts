/**
 * Pane-tail error classifier. Runs on the node; only the rule id leaves it.
 * Lesson from the old fleetboard classifier: prose that merely mentions "503" or
 * "Permission required" is not an error. A line only counts when it is shaped
 * like a real error line (starts with an error marker), and then matches a rule.
 */
const BOX = /^[\s]*[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼║═╔╗╚╝▌▐█▀▄]/;
const BOX_ANY = /[╭╮╰╯│┃]/;

/** Footer/status chrome that may follow an error line without meaning the agent recovered. */
const CHROME = /^\s*[>❯]\s*$|(?:\? for shortcuts|esc to interrupt|bypass permissions|auto-accept|shift\+tab|accept edits|plan mode|context (?:left|low)|\/ide for|ctrl\+[a-z] to)/i;

/**
 * Real runtime error forms only. No generic "Error:" and no bullet / quote / tool-output
 * prefixes: only the Claude result glyphs (⎿ ●) are tolerated, and only before "API Error".
 */
const DECOR = "(?:[⎿●]\\s*)*";
const ANCHORS: RegExp[] = [
  new RegExp(`^\\s*${DECOR}API Error(?:\\s*\\(\\d{3}\\)|:)`),
  new RegExp(`^\\s*${DECOR}\\{"type":"error"`),
  new RegExp(`^\\s*${DECOR}(?:Weekly limit reached|5-hour limit reached|Claude (?:AI )?usage limit reached|You(?:'ve| have) (?:hit|reached) your (?:weekly |usage |org(?:anization)? )?limit)`, "i"),
  /^\s*(?:ProviderError|AI_APICallError|AI_RetryError|APICallError)\b[:\s]/,
  /^\s*(?:Error:\s*)?Failed to execute statement/,
];
const RETRY = /retrying|retry in|attempt \d+\/\d+/i;

const RULES: Array<[string, RegExp]> = [
  ["stmt_failed", /Failed to execute statement/i],
  ["weekly_limit", /weekly (usage )?limit|usage limit (reached|exceeded)|5-hour limit/i],
  ["rate_limit", /rate.?limit|too many requests|throttl|\b429\b/i],
  ["model_unavailable", /model.{0,30}(unavailable|not available|overloaded)|overloaded_error|\b529\b/i],
  ["http_503", /\b503\b|service unavailable/i],
  ["auth", /\b40[13]\b|unauthori[sz]ed|authentication|invalid (api )?key|expired token|credentials/i],
];

export function stripUi(text: string, lines = 40): string[] {
  return text
    .split("\n")
    .slice(-lines)
    .filter((l) => l.trim() !== "" && !BOX.test(l) && !BOX_ANY.test(l));
}

/**
 * Returns a rule id, or null. Only the last content line (ignoring footer chrome) can be an
 * error: anything printed after it means the agent recovered. "Retrying" lines are not terminal.
 */
export function classifyTail(text: string): string | null {
  const content = stripUi(text, 40);
  let i = content.length - 1;
  while (i >= 0 && CHROME.test(content[i])) i--;
  if (i < 0) return null;
  const line = content[i];
  if (RETRY.test(line) || !ANCHORS.some((re) => re.test(line))) return null;
  for (const [id, re] of RULES) if (re.test(line)) return id;
  return "api_error";
}

const SPINNER = /^\s*(?:[✻✶✢✳✽⏺·*]\s*\S+(?:…|\.\.\.)|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S+)/;
const STATUS = /esc to interrupt|\btokens?\b|[↑↓]\s*[\d.]+k?\b|\(\d+m?\s*\d*s\b|\b\d+m \d+s\b/i;

/** Pane tail with ticking spinner / timer / token-counter lines removed, so only real output changes the hash. */
export function normaliseTail(text: string): string {
  return text
    .split("\n")
    .filter((l) => !SPINNER.test(l))
    .map((l) => (STATUS.test(l) ? l.replace(/\d+/g, "#") : l))
    .join("\n");
}

export function inferRuntime(args: string[], bedrockEnv: boolean, comm: string, laneModel: string | null): { runtime: import("./types.js").Runtime; model: string | null } {
  if (comm.startsWith("opencode")) {
    const i = args.findIndex((a) => a === "-m" || a === "--model");
    const m = i >= 0 ? args[i + 1] ?? "" : (args.find((a) => a.startsWith("--model="))?.slice(8) ?? "");
    if (m.startsWith("bharatcode2/")) return { runtime: "bc2", model: m };
    if (m.startsWith("bharatcode/")) return { runtime: "bc1", model: m };
    if (m.startsWith("amazon-bedrock/")) return { runtime: "opencode-bedrock", model: m };
    return { runtime: "unknown", model: m || laneModel };
  }
  if (comm.startsWith("claude")) {
    const lm = laneModel ?? "";
    if (bedrockEnv || /^(cc)?bedrock:/.test(lm)) return { runtime: "bedrock", model: laneModel?.replace(/^[a-z]+:/, "") ?? null };
    return { runtime: "max", model: laneModel?.replace(/^[a-z]+:/, "") ?? null };
  }
  return { runtime: "unknown", model: laneModel };
}

/** Pure helper over a /proc/<pid>/environ buffer: keys only, values are dropped immediately. */
export function parseEnvironKeys(buf: Buffer): Set<string> {
  const keys = new Set<string>();
  for (const entry of buf.toString("latin1").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) keys.add(entry.slice(0, eq));
  }
  return keys;
}
