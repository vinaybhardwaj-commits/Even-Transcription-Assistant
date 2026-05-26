// PRD §16.4 — strip citations to chunk_ids not in the actually-retrieved set.
// Returns the cleaned section + a list of hallucinated citation_ids for trace logging.

export function stripHallucinatedCitations<T extends { citations?: Array<{ chunk_id: number }> | undefined; text?: string }>(
  section: T,
  retrievedIds: Set<number>,
): { section: T; hallucinated: Array<{ chunk_id: number }> } {
  const hallucinated: Array<{ chunk_id: number }> = [];
  const validCites = (section.citations ?? []).filter((c) => {
    if (!retrievedIds.has(c.chunk_id)) {
      hallucinated.push(c);
      return false;
    }
    return true;
  });
  const cleaned = { ...section, citations: validCites } as T;
  return { section: cleaned, hallucinated };
}
