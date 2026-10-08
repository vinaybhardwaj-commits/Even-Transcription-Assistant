/**
 * lib/rubrics/readers/index.ts — S7-0: the reader table. consult_text and pulse_record are S7.2: they answer not_implemented (never an empty success).
 */
import { refuse, type ReadRefusal } from "./common";
import type { ReaderName } from "../types";

export { readAudioHour, listAudioHours, parseRoomHourKey, roomHourKey } from "./audio-state";
export { readWindowEnglish } from "./window-english";
export { readWindowTurns } from "./turns";
export { readWindowEmotion } from "./emotion";
export { readConsultSpan, listConsultKeys } from "./consult-span";
export * from "./common";

export const IMPLEMENTED_READERS: readonly ReaderName[] = ["window_english", "turns", "emotion", "audio_state", "consult_span"];
export const STUB_READERS: readonly ReaderName[] = ["consult_text", "pulse_record"];

/** The stub readers (S7.2). */
export const readConsultText = async (_key: string): Promise<ReadRefusal> => refuse("not_implemented", "consult_text is S7.2");
export const readPulseRecord = async (_key: string): Promise<ReadRefusal> => refuse("not_implemented", "pulse_record is S7.2");
