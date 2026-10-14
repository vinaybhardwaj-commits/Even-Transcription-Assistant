import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { sha256 } from '../hash.js'

/** Compare strings without leaking length. Both sides are hashed to a fixed width first. */
export function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

export function hashSecret(value: string): string {
  return sha256(value)
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${mac}`
}

export function verifyWebhook(secret: string, header: string, body: string, nowMs: number, toleranceMs = 5 * 60 * 1000): boolean {
  const timestamp = /(?:^|,)t=(\d+)/.exec(header)?.[1]
  const mac = /(?:^|,)v1=([a-f0-9]+)/.exec(header)?.[1]
  if (!timestamp || !mac) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > toleranceMs) return false
  const expected = signWebhook(secret, timestamp, body)
  return safeEqual(expected, header)
}
