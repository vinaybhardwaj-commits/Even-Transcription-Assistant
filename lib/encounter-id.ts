/**
 * Encounter IDs: enc_<10-char nanoid> (alphabet matches PRD §4.14 token
 * alphabet: 32 chars, no 0/1/i/l/o to avoid confusion in spoken IDs).
 */
import { customAlphabet } from "nanoid";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const nano = customAlphabet(ALPHABET, 10);

export function newEncounterId(): string {
  return `enc_${nano()}`;
}
