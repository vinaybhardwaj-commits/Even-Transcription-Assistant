import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildOpenApi } from '../src/api/openapi.js'

const dir = path.resolve('openapi')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'v1.json'), `${JSON.stringify(buildOpenApi(), null, 2)}\n`)
process.stdout.write('wrote openapi/v1.json\n')
