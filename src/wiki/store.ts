import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { KnowledgeScope } from '../domain.js'
import { WikiCommitter, wikiHash, type WikiTarget } from './commit.js'
import { createWikiPage, validateWikiManifest, type WikiManifest, type WikiPage, type WikiProvenance } from './identity.js'
import { parseWikiMarkdown } from './markdown.js'
import { assertPageTargetSafe, type WikiLayout } from './paths.js'

// Snapshot CAS belongs to the read, never to a later target-construction read.
const manifestHashes = new WeakMap<WikiManifest, string | null>()

export interface WikiImportItem { relPath: string; title: string; sha256: string; chars: number; status: 'existing' | 'new' | 'too_long' | 'invalid'; error?: string }
export interface WikiImportReport { items: WikiImportItem[]; registered: number; existing: number; rejected: number }
export class WikiStore {
  readonly committer: WikiCommitter
  constructor(readonly layout: WikiLayout, finalize?: (operationId: string) => Promise<void>) {
    this.committer = new WikiCommitter(layout.workspaceRoot, finalize)
  }
  private manifestPath(): string { return join(this.layout.metaDir, 'manifest.json') }
  async manifest(): Promise<WikiManifest> {
    try {
      const bytes = await readFile(this.manifestPath())
      const manifest = validateWikiManifest(JSON.parse(bytes.toString('utf8')) as unknown)
      if (manifest.kbId !== this.layout.kbId) throw new Error('WIKI_BASE_ID_MISMATCH')
      manifestHashes.set(manifest, wikiHash(bytes))
      return manifest
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty: WikiManifest = { format: 1, kbId: this.layout.kbId, pages: [] }
        manifestHashes.set(empty, null)
        return empty
      }
      throw e
    }
  }
  async manifestTarget(manifest: WikiManifest): Promise<WikiTarget> {
    validateWikiManifest(manifest)
    if (!manifestHashes.has(manifest)) throw new Error('WIKI_MANIFEST_SNAPSHOT_REQUIRED')
    const expectedHash = manifestHashes.get(manifest)!
    return { relPath: '_meta/knowledge/manifest.json', expectedHash, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }
  }
  async inspect(): Promise<WikiImportItem[]> {
    const manifest = await this.manifest(), results: WikiImportItem[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const relPath = relative(this.layout.pageDir, path).replaceAll('\\', '/')
          try {
            await assertPageTargetSafe(this.layout, relPath)
            const bytes = await readFile(path), parsed = parseWikiMarkdown(bytes)
            results.push({ relPath, title: parsed.title, sha256: wikiHash(bytes), chars: parsed.body.length,
              status: parsed.body.length > 50_000 ? 'too_long' : manifest.pages.some(p => p.relPath === `wiki/${relPath}`) ? 'existing' : 'new' })
          } catch (e) { results.push({ relPath, title: '', sha256: '', chars: 0, status: 'invalid', error: String(e) }) }
        }
      }
    }
    await walk(this.layout.pageDir)
    return results
  }
  async import(scope: KnowledgeScope, operationId: string): Promise<WikiImportItem[]> {
    const report = await this.inspect()
    if (report.some(r => r.status === 'invalid' || r.status === 'too_long')) throw new Error('WIKI_IMPORT_REQUIRES_RESOLUTION')
    const manifest = await this.manifest()
    for (const item of report.filter(r => r.status === 'new')) {
      const parsed = parseWikiMarkdown(await readFile(await assertPageTargetSafe(this.layout, item.relPath)))
      const page = createWikiPage(this.layout.kbId, `wiki/${item.relPath}`, parsed.scope ?? scope, { kind: 'import', originalPath: item.relPath })
      page.fileSha256 = item.sha256
      manifest.pages.push(page)
    }
    if (report.some(r => r.status === 'new')) await this.committer.commit({ operationId, targets: [await this.manifestTarget(manifest)] })
    return report
  }
  /** Register valid old pages without rewriting them; malformed pages remain visible in the report. */
  async importValid(scope: KnowledgeScope, operationId: string): Promise<WikiImportReport> {
    const items = await this.inspect(), manifest = await this.manifest()
    const pending = items.filter(item => item.status === 'new')
    const checks: { path: string; hash: string }[] = []
    for (const item of pending) {
      const path = await assertPageTargetSafe(this.layout, item.relPath)
      const bytes = await readFile(path)
      if (wikiHash(bytes) !== item.sha256) throw new Error('WIKI_IMPORT_FILE_CHANGED: ' + item.relPath)
      const parsed = parseWikiMarkdown(bytes)
      if (!parsed.body.trim()) { item.status = 'invalid'; item.error = '页面正文为空'; continue }
      const page = createWikiPage(this.layout.kbId, `wiki/${item.relPath}`, parsed.scope ?? scope, { kind: 'import', originalPath: item.relPath })
      page.fileSha256 = item.sha256
      manifest.pages.push(page); checks.push({ path, hash: item.sha256 })
    }
    if (checks.length) await this.committer.commit({ operationId, targets: [await this.manifestTarget(manifest)] }, async () => {
      for (const item of checks) if (wikiHash(await readFile(item.path)) !== item.hash) throw new Error('WIKI_IMPORT_FILE_CHANGED: ' + item.path)
    })
    return { items, registered: checks.length, existing: items.filter(item => item.status === 'existing').length,
      rejected: items.filter(item => item.status === 'invalid' || item.status === 'too_long').length }
  }

  async page(pageId: string): Promise<{ page: WikiPage; bytes: Buffer }> {
    const page = (await this.manifest()).pages.find(p => p.pageId === pageId || p.entryId === pageId)
    if (!page) throw new Error('WIKI_PAGE_NOT_FOUND')
    const rel = page.relPath.replace(/^wiki\//, '')
    return { page, bytes: await readFile(await assertPageTargetSafe(this.layout, rel)) }
  }
  async save(pageId: string, bytes: Uint8Array, expectedHash: string, provenance: WikiProvenance, operationId: string, extra: WikiTarget[] = []): Promise<void> {
    const manifest = await this.manifest(), page = manifest.pages.find(p => p.pageId === pageId || p.entryId === pageId)
    if (!page || page.status !== 'active') throw new Error('WIKI_PAGE_NOT_FOUND')
    const parsed = parseWikiMarkdown(bytes)
    if (!parsed.body.trim() || parsed.body.length > 50_000) throw new Error('WIKI_PAGE_BODY_LIMIT')
    if (page.lastOperation === operationId && page.fileSha256 === wikiHash(bytes)) return
    if (page.fileSha256 !== expectedHash) throw new Error('WIKI_INDEX_VERSION_CONFLICT')
    page.fileSha256 = wikiHash(bytes); page.version++; page.provenance = provenance; page.lastOperation = operationId
    await this.committer.commit({ operationId, targets: [{ relPath: page.relPath, expectedHash, bytes }, await this.manifestTarget(manifest), ...extra] })
  }
}
