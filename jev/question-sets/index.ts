/**
 * jev/question-sets/index.ts — every question-set file the deploy carries. A file is reachable only if it is imported here
 * (a bundled build cannot read a directory); a drift test asserts every *.json under this folder is listed.
 *
 * `smoke/v0` is SYNTHETIC and a DRAFT: it exists so the worker can be exercised end to end in bench mode. CAA owns the
 * wording of every real set (PRD §§ CAA); none ships in P1.
 */
import smokeV0 from "./smoke/v0.json";

export const QUESTION_SET_FILES: unknown[] = [smokeV0];
