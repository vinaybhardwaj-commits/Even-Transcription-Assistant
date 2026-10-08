/**
 * lib/rubrics/readers/index.ts — S7-0: the reader table. pulse_record is S7.2: it answers not_implemented (never an empty success). consult_text is real since S7-1.
 */
import { refuse, type ReadRefusal } from "./common";
import type { ReaderName } from "../types";

export { readAudioHour, listAudioHours, parseRoomHourKey, roomHourKey } from "./audio-state";
export { readWindowEnglish } from "./window-english";
export { readWindowTurns } from "./turns";
export { readWindowEmotion } from "./emotion";
export { readConsultSpan, listConsultKeys } from "./consult-span";
export { readConsultText, MAX_CONSULT_CHARS, type ConsultText, type ConsultLine } from "./consult-text";
export * from "./common";

export const IMPLEMENTED_READERS: readonly ReaderName[] = ["window_english", "turns", "emotion", "audio_state", "consult_span", "consult_text"];
export const STUB_READERS: readonly ReaderName[] = ["pulse_record"];

/** The stub reader (S7.2). consult_text is real since S7-1. */
export const readPulseRecord = async (_key: string): Promise<ReadRefusal> => refuse("not_implemented", "pulse_record is S7.2");
