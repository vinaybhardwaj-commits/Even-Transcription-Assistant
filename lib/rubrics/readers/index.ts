/**
 * lib/rubrics/readers/index.ts — S7-0: the reader table. consult_text is real since S7-1, pulse_record since S7-2 (every reader in the table is implemented).
 */
import type { ReaderName } from "../types";

export { readAudioHour, listAudioHours, parseRoomHourKey, roomHourKey } from "./audio-state";
export { readWindowEnglish } from "./window-english";
export { readWindowTurns } from "./turns";
export { readWindowEmotion } from "./emotion";
export { readConsultSpan, listConsultKeys } from "./consult-span";
export { readPulseRecord, type PulseRecord } from "./pulse-record";
export { readConsultText, MAX_CONSULT_CHARS, type ConsultText, type ConsultLine } from "./consult-text";
export * from "./common";

export const IMPLEMENTED_READERS: readonly ReaderName[] = ["window_english", "turns", "emotion", "audio_state", "consult_span", "consult_text", "pulse_record"];
export const STUB_READERS: readonly ReaderName[] = [];
