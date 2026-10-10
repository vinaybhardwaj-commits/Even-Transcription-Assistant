/**
 * lib/diarize-nemotron/lab-keys.ts — PURE: the R2 keys the SERVER makes for a worker's probability / embedding uploads. The worker never
 * chooses a key; ingest accepts a pointer only if it equals the key made here. (Own file so validate.ts and lab.ts do not import each other.)
 */
export const LAB_KEY_PREFIX = "lab/nemotron/";
export const PROBS_KEY_PREFIX = "lab/nemotron-probs/";

export const labProbsKey = (runId: string, idx: number): string => `${LAB_KEY_PREFIX}${runId}/${idx}/probs.nlp`;
export const labEmbeddingsKey = (runId: string, idx: number): string => `${LAB_KEY_PREFIX}${runId}/${idx}/emb.nlp`;
/** Production windows: one probabilities file per window, replaced if the window is run again. */
export const windowProbsKey = (windowId: string): string => `${PROBS_KEY_PREFIX}${windowId}.nlp`;
