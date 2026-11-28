import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, link, unlink, readdir, realpath, lstat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isPathInside } from './paths.js'

export const wikiHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export interface WikiTarget { relPath: string; expectedHash: string | null; bytes: Uint8Array }
export interface WikiCommitRequest { operationId: string; targets: WikiTarget[] }
interface TargetRecord { relPath: string; oldHash: string | null; newHash: string; oldBytes: string | null; newBytes: string }
interface Journal { format: 1; operationId: string; requestHash: string; state: 'prepared' | 'publishing' | 'published' | 'abandoned' | 'conflict'; targets: TargetRecord[]; error?: string }
const queues = new Map<string, Promise<unknown>>()
function error(message: string): Error { return Object.assign(new Error(message), { code: message }) }
async function bytesAt(path: string): Promise<Buffer | null> {
  try { return await readFile(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
async function durable(path: string, bytes: Uint8Array, replace: boolean): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const h = await open(temporary, 'wx')
  try { await h.writeFile(bytes); await h.sync() } finally { await h.close() }
  try {
    if (replace) await rename(temporary, path)
    else { await link(temporary, path); await unlink(temporary) }
  } catch (e) { await unlink(temporary).catch(() => {}); throw e }
}
/** Recoverable multi-file commit, not an externally atomic filesystem transaction. */
export class WikiCommitter {
  constructor(readonly root: string, private readonly finalize: (operationId: string) => Promise<void> = async () => {}) {}
  private async target(rel: string): Promise<string> {
    if (!rel || rel.includes('\\') || rel.includes(':') || rel.includes('\0') || rel.split('/').some(s => !s || s === '.' || s === '..')) throw error('WIKI_PATH_UNSAFE')
    if (!(rel.startsWith('wiki/') && rel.endsWith('.md')) && !['index.md', 'log.md', 'schema.md', '_meta/knowledge/manifest.json'].includes(rel)) throw error('WIKI_TARGET_NOT_ALLOWED')
    const root = await realpath(this.root)
    let current = root
    for (const part of rel.split('/')) {
      current = join(current, part)
      try {
        const stat = await lstat(current)
        if (stat.isSymbolicLink() || !isPathInside(root, await realpath(current))) throw error('WIKI_PATH_ESCAPE')
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e }
    }
    return join(root, rel)
  }
  private journalDir(): string { return join(this.root, '_meta', 'knowledge', 'commits') }
  private async journalPath(operationId: string): Promise<string> {
    // Validate metadata parents even when the directory has not been created yet.
    await this.target('_meta/knowledge/manifest.json')
    await mkdir(this.journalDir(), { recursive: true })
    const actual = await realpath(this.journalDir())
    if (!isPathInside(await realpath(this.root), actual)) throw error('WIKI_PATH_ESCAPE')
    return join(actual, `${wikiHash(Buffer.from(operationId))}.json`)
  }
  private async save(path: string, journal: Journal): Promise<void> { await durable(path, Buffer.from(JSON.stringify(journal)), true) }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const key = this.root.toLowerCase()
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    queues.set(key, next)
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
    return next
  }
  async commit(request: WikiCommitRequest, authorize: () => void | Promise<void> = () => {}): Promise<void> {
    return this.serialize(async () => {
      await this.assertSettled(request.operationId)
      if (!request.operationId || !request.targets.length) throw error('WIKI_COMMIT_EMPTY')
      await authorize()
      const requestHash = wikiHash(Buffer.from(JSON.stringify(request.targets.map(t => [t.relPath, t.expectedHash, wikiHash(t.bytes)]))))
      const path = await this.journalPath(request.operationId)
      const prior = await bytesAt(path)
      if (prior) {
        const journal = this.parse(prior)
        if (journal.operationId !== request.operationId || journal.requestHash !== requestHash) throw error('WIKI_OPERATION_REUSED')
        if (journal.state === 'published') return
        if (journal.state === 'abandoned' || journal.state === 'conflict') throw error('WIKI_COMMIT_REQUIRES_RESOLUTION')
        await this.finish(path, journal, authorize); return
      }
      const targets: TargetRecord[] = [], seen = new Set<string>()
      for (const t of request.targets) {
        if (seen.has(t.relPath.toLowerCase())) throw error('WIKI_DUPLICATE_TARGET')
        seen.add(t.relPath.toLowerCase())
        const old = await bytesAt(await this.target(t.relPath))
        if ((old === null ? null : wikiHash(old)) !== t.expectedHash) throw error('WIKI_FILE_CONFLICT')
        targets.push({ relPath: t.relPath, oldHash: t.expectedHash, newHash: wikiHash(t.bytes), oldBytes: old?.toString('base64') ?? null, newBytes: Buffer.from(t.bytes).toString('base64') })
      }
      const journal: Journal = { format: 1, operationId: request.operationId, requestHash, state: 'prepared', targets }
      await durable(path, Buffer.from(JSON.stringify(journal)), false)
      await this.finish(path, journal, authorize)
    })
  }
  async assertSettled(exceptOperation?: string): Promise<void> {
    let names: string[]
    try { names = await readdir(this.journalDir()) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const j = this.parse(await readFile(join(this.journalDir(), name)))
      if (j.operationId !== exceptOperation && !['published', 'abandoned'].includes(j.state)) throw error('WIKI_RECOVERY_REQUIRED')
    }
  }
  private parse(bytes: Buffer): Journal {
    const j = JSON.parse(bytes.toString()) as Journal
    if (j.format !== 1 || !Array.isArray(j.targets) || !j.targets.length || typeof j.operationId !== 'string' || !['prepared','publishing','published','abandoned','conflict'].includes(j.state)) throw error('WIKI_JOURNAL_CORRUPT')
    const paths = new Set<string>()
    for (const t of j.targets) {
      if (typeof t.relPath !== 'string' || paths.has(t.relPath.toLowerCase()) || typeof t.newBytes !== 'string' || (t.oldHash === null) !== (t.oldBytes === null)) throw error('WIKI_JOURNAL_CORRUPT')
      paths.add(t.relPath.toLowerCase())
      if (wikiHash(Buffer.from(t.newBytes, 'base64')) !== t.newHash || (t.oldBytes !== null && wikiHash(Buffer.from(t.oldBytes, 'base64')) !== t.oldHash)) throw error('WIKI_JOURNAL_CORRUPT')
    }
    return j
  }
  private async finish(path: string, journal: Journal, authorize: () => void | Promise<void>): Promise<void> {
    await authorize()
    // Preflight the whole set before resuming any write. Preserve third-party bytes.
    for (const t of journal.targets) {
      const current = await bytesAt(await this.target(t.relPath)), hash = current === null ? null : wikiHash(current)
      if (hash !== t.oldHash && hash !== t.newHash) {
        journal.state = 'conflict'; journal.error = `Externally modified: ${t.relPath}`; await this.save(path, journal); throw error('WIKI_RECOVERY_CONFLICT')
      }
    }
    journal.state = 'publishing'; await this.save(path, journal)
    for (const t of journal.targets) {
      await authorize()
      const target = await this.target(t.relPath)
      const old = await bytesAt(target), hash = old === null ? null : wikiHash(old)
      if (hash === t.newHash) continue
      if (hash !== t.oldHash) { journal.state = 'conflict'; await this.save(path, journal); throw error('WIKI_FILE_CONFLICT') }
      await mkdir(dirname(target), { recursive: true })
      await this.target(t.relPath)
      await durable(target, Buffer.from(t.newBytes, 'base64'), t.oldHash !== null)
    }
    for (const t of journal.targets) {
      const current = await bytesAt(await this.target(t.relPath))
      if (!current || wikiHash(current) !== t.newHash) throw error('WIKI_POST_WRITE_CONFLICT')
    }
    await this.finalize(journal.operationId)
    journal.state = 'published'; delete journal.error; await this.save(path, journal)
  }
  async recover(): Promise<{ operationId: string; state: string }[]> {
    return this.serialize(async () => {
      const results: { operationId: string; state: string }[] = []
      let names: string[]
      try { names = await readdir(this.journalDir()) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return results; throw e }
      for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
        const path = join(this.journalDir(), name), journal = this.parse(await readFile(path))
        if (journal.state === 'published' || journal.state === 'abandoned' || journal.state === 'conflict') { results.push({ operationId: journal.operationId, state: journal.state }); continue }
        let allOld = true
        for (const t of journal.targets) {
          const current = await bytesAt(await this.target(t.relPath))
          if ((current === null ? null : wikiHash(current)) !== t.oldHash) allOld = false
        }
        if (allOld && journal.state === 'prepared') { journal.state = 'abandoned'; await this.save(path, journal) }
        else {
          try { await this.finish(path, journal, () => {}) }
          catch (e) {
            // A conflict is a durable outcome, not a reason to stop recovering other journals.
            if (!(e instanceof Error) || !['WIKI_RECOVERY_CONFLICT', 'WIKI_FILE_CONFLICT'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
            const persisted = this.parse(await readFile(path))
            results.push({ operationId: persisted.operationId, state: persisted.state })
            continue
          }
        }
        results.push({ operationId: journal.operationId, state: journal.state })
      }
      return results
    })
  }
}
