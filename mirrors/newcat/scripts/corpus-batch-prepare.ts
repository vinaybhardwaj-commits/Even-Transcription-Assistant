import { writeTitanBatchDir, readCorpusFile, BATCH_RECORDS_PER_FILE, TITAN_BATCH_MODEL_ID } from '../src/evidence/batch.js'

const file = process.argv[2]
const dir = process.argv[3]
if (!file || !dir || file.startsWith('--') || dir.startsWith('--')) {
  process.stderr.write('usage: npm run corpus:batch-prepare -- <file.jsonl> <out-dir>\n')
  process.exit(1)
}

let lines
try {
  lines = readCorpusFile(file)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'The corpus file could not be read.'}\n`)
  process.exit(1)
}

const written = writeTitanBatchDir(dir, lines, BATCH_RECORDS_PER_FILE)
process.stdout.write(
  `${JSON.stringify({ model: TITAN_BATCH_MODEL_ID, records: written.records, files: written.files.length, records_per_file: BATCH_RECORDS_PER_FILE })}\n`,
)
