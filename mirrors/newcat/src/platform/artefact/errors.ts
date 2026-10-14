/** Code-only errors: the message is the code, never a path, uid or text. */
export class ArtefactError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'ArtefactError'
    this.code = code
  }
}

export class ArtefactChanged extends ArtefactError {
  constructor() {
    super('artefact_changed')
    this.name = 'ArtefactChanged'
  }
}

/** Artefact bodies hold transcript text; Vercel functions never read them. Only the worker on eta-lab-t4 does. */
export function assertWorkerContext(env: Record<string, string | undefined> | undefined): void {
  if (process.env.VERCEL === '1' || env?.VERCEL === '1') throw new ArtefactError('vercel_forbidden')
}

/** Resolves a store-relative path under root; null when it would leave root. */
export function safeJoin(root: string, rel: string, join: (...p: string[]) => string, resolve: (...p: string[]) => string, sep: string): string | null {
  if (rel === '' || rel.includes('\0')) return null
  const full = resolve(join(root, rel))
  const base = resolve(root)
  return full.startsWith(base.endsWith(sep) ? base : base + sep) ? full : null
}
