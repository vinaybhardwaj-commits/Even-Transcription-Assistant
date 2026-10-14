import type { EmrAdapter } from './types.js'

/** Stub: `unavailable` until the IP EMR API exists. No inbound, nothing stored. */
export function createIpEmrAdapter(): EmrAdapter {
  return {
    id: 'ipemr',
    outbound: { mode: 'store_only', deliver: async () => ({ status: 'unavailable' }) },
  }
}
