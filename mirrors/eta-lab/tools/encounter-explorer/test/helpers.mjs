import { readFileSync } from "node:fs";
import { ensureMockup } from "../scripts/ensure-fixtures.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const readJson = p => JSON.parse(readFileSync(join(root, p), "utf8"));
export const payloads = () => ({ reb: readJson("fixtures/synthetic/tools/reb_index.json"), fs: readJson("fixtures/synthetic/tools/freescript.json"), rub: readJson("fixtures/synthetic/tools/rubric.json"), jev: readJson("fixtures/synthetic/tools/jev_decisions.json") });
export const mockupData = () => { ensureMockup(); return readJson("fixtures/synthetic/mockup.json"); };
