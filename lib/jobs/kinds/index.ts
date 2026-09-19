/**
 * lib/jobs/kinds/index.ts — the registry. A kind is reachable only if it is listed here.
 *
 * Slice B implements `transcribe_range` and `stitch`. The other five are REGISTERED AS STUBS that
 * fail `not_implemented` rather than being absent: the tool surface, the arg schemas and the
 * submit-time scope check are then the same in every slice, and Slices C and D replace a body
 * instead of adding a kind. A caller that submits one today gets a named refusal on the job row,
 * not "unknown kind" — the difference between "not yet" and "never".
 */

import type { JobKind } from "../types";
import { transcribeRangeKind } from "./transcribe-range";
import { stitchKind } from "./stitch";
import { routeTranscribeKind } from "./route-transcribe";
import { roomWindowKind } from "./room-window";
import { diarizeWindowKind } from "./diarize-window";
import { emotionWindowKind } from "./emotion-window";
import { jevEnglishKind } from "./jev-english";
import { jevWindowKind } from "./jev-window";
import { jevRoleKind } from "./jev-role";
import { STUB_KINDS } from "./stubs";

export const JOB_KINDS: JobKind[] = [transcribeRangeKind, stitchKind, routeTranscribeKind, roomWindowKind, diarizeWindowKind, emotionWindowKind, jevEnglishKind, jevWindowKind, jevRoleKind, ...STUB_KINDS];
export const KIND_BY_NAME = new Map(JOB_KINDS.map((k) => [k.name, k]));
export const JOB_KIND_NAMES = JOB_KINDS.map((k) => k.name);
/** The kinds that are registered but still fail not_implemented. Derived, so prose cannot drift. */
export const STUB_KIND_NAMES = STUB_KINDS.map((k) => k.name);
