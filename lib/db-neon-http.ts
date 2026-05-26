import { neon, neonConfig } from '@neondatabase/serverless';

neonConfig.fetchConnectionCache = true;

export const sql = neon(process.env.DATABASE_URL!);

export type Chunk = {
  id: number;
  source: string;
  book: string;
  chapter: string | null;
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  item_number: string | null;
  chunk_type: 'narrative' | 'explanation' | string;
  text: string;
  token_count: number | null;
};

export type ChunkHit = Chunk & { similarity: number };
