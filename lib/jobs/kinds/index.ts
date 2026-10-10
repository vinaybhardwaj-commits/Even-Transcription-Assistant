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
import { nemotronIdentityKind } from "./nemotron-identity";
import { nemotronLabRunKind } from "./nemotron-lab-run";
import { pulseDoctorVoiceKind } from "./pulse-doctor-voice";
import { emotionWindowKind } from "./emotion-window";
import { jevEnglishKind } from "./jev-english";
import { jevWindowKind } from "./jev-window";
import { jevRoleKind } from "./jev-role";
import { jevAskKind } from "./jev-ask";
import { jevDriftKind } from "./jev-drift";
import { sarvamTranscribeKind } from "./sarvam-transcribe";
import { sarvamTranslateKind } from "./sarvam-translate";
import { sarvamConsultBatchKind } from "./sarvam-consult-batch";
import { rubricRunKind } from "./rubric-run";
import { rubricBenchKind } from "./rubric-bench";
import { STUB_KINDS } from "./stubs";

export const JOB_KINDS: JobKind[] = [transcribeRangeKind, stitchKind, routeTranscribeKind, roomWindowKind, diarizeWindowKind, nemotronIdentityKind, nemotronLabRunKind, pulseDoctorVoiceKind, emotionWindowKind, jevEnglishKind, jevWindowKind, jevRoleKind, jevAskKind, jevDriftKind, sarvamTranscribeKind, sarvamTranslateKind, sarvamConsultBatchKind, rubricRunKind, rubricBenchKind, ...STUB_KINDS];
/**
 * K3-2: the registry REFUSES a kind that has not answered "does it read room data?", and one that does but has no held-out guard. Pure, exported so a test can feed it a bad kind. Thrown at load.
 */
export function assertHeldOutDeclared(kinds: readonly JobKind[]): void {
  for (const k of kinds) {
    if (typeof k.roomData !== "boolean") throw new Error(`job kind "${k.name}" must declare roomData (true or false)`);
    if (k.roomData && typeof k.heldOut !== "function") throw new Error(`job kind "${k.name}" reads room data and declares no heldOut guard`);
    if (!k.roomData && !k.roomDataNote && !STUB_KINDS.includes(k)) throw new Error(`job kind "${k.name}" says it reads no room data: roomDataNote must say why`);
  }
}
assertHeldOutDeclared(JOB_KINDS);
export const KIND_BY_NAME = new Map(JOB_KINDS.map((k) => [k.name, k]));
export const JOB_KIND_NAMES = JOB_KINDS.map((k) => k.name);
/** The kinds that are registered but still fail not_implemented. Derived, so prose cannot drift. */
export const STUB_KIND_NAMES = STUB_KINDS.map((k) => k.name);
