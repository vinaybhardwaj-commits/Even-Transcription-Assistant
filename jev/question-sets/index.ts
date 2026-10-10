/**
 * jev/question-sets/index.ts — every question-set file the deploy carries. A file is reachable only if it is imported here
 * (a bundled build cannot read a directory); a drift test asserts every *.json under this folder is listed.
 *
 * `smoke/v0` is SYNTHETIC and a DRAFT: it exercises the worker end to end. The rest are Jev P2's first-draft sets, written from the PRD's option
 * lists and rules (CAA owns the final wording and will replace them through the §6 change control). EVERY one is status `draft` after sync: none
 * is ratified in P2, so none can run in shadow or live, only in bench. They hold question wording only: no transcript, name or id.
 */
import smokeV0 from "./smoke/v0.json";
import u10TimelineV2 from "./u10-timeline/v2.json";
import encounterEndV0 from "./encounter-end/v0.json";
import sttQualityV0 from "./stt-quality/v0.json";
import sttPickV0 from "./stt-pick/v0.json";
import pitchDetectV0 from "./pitch-detect/v0.json";
import pitchUptakeV0 from "./pitch-uptake/v0.json";
import chairAffectV0 from "./chair-affect/v0.json";
import doubtV0 from "./doubt/v0.json";

export const QUESTION_SET_FILES: unknown[] = [smokeV0, u10TimelineV2, encounterEndV0, sttQualityV0, sttPickV0, pitchDetectV0, pitchUptakeV0, chairAffectV0, doubtV0];
