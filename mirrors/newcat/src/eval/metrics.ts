export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[index] ?? Number.NaN
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function bootstrapMeanCi(values: number[], iterations = 1000, seed = 1): { point: number; low: number; high: number } | null {
  if (values.length === 0) return null
  const point = mean(values)
  const random = mulberry32(seed)
  const stats: number[] = []
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < values.length; j++) {
      const index = Math.floor(random() * values.length)
      sum += values[index] ?? 0
    }
    stats.push(sum / values.length)
  }
  stats.sort((left, right) => left - right)
  return { point, low: percentile(stats, 0.025), high: percentile(stats, 0.975) }
}

export function jaccard(left: string[], right: string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  const union = a.size + b.size - intersection
  if (union === 0) return 1
  return intersection / union
}

export function meanPairwiseJaccard(runs: string[][]): number | null {
  if (runs.length < 2) return null
  const scores: number[] = []
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const left = runs[i]
      const right = runs[j]
      if (!left || !right) continue
      scores.push(jaccard(left, right))
    }
  }
  return mean(scores)
}

/** Null when there are no samples. A missing ECE is vacuous, not zero. */
export function expectedCalibrationError(rows: { p: number; y: 0 | 1 }[], bins = 10): number | null {
  if (rows.length === 0) return null
  const buckets = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }))
  for (const row of rows) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(row.p * bins)))
    const bucket = buckets[index]
    if (!bucket) continue
    bucket.n += 1
    bucket.p += row.p
    bucket.y += row.y
  }
  let error = 0
  for (const bucket of buckets) {
    if (bucket.n === 0) continue
    error += (bucket.n / rows.length) * Math.abs(bucket.y / bucket.n - bucket.p / bucket.n)
  }
  return error
}

export function latencyPercentiles(samples: number[]): { p50: number | null; p95: number | null } {
  if (samples.length === 0) return { p50: null, p95: null }
  const sorted = [...samples].sort((left, right) => left - right)
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
}
