import { createServer } from 'node:http'
import { bootApp } from './boot.js'
import { writeNodeResponse } from './http/node-adapter.js'
import { log } from './log.js'

const started = await bootApp({ role: 'all' })
const server = createServer((req, res) => {
  void writeNodeResponse(started.app, req, res)
})

server.listen(started.env.PORT, '0.0.0.0', () => {
  log('info', 'listen', { path: '/health', http_status: 200 })
  process.stdout.write(`NewCat listening on http://127.0.0.1:${started.env.PORT}/health\n`)
})
