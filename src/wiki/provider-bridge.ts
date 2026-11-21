import { WikiProposals } from './proposals.js'
import { WikiIngest, type WikiIngestSettings, type WikiIngestJob } from './ingest.js'
import { join } from 'node:path'
import { readFile, mkdir, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { KnowledgeDraft, KnowledgeEntry, KnowledgeScope } from '../domain.js'
import { normalizeDraft } from '../domain.js'
import { WikiStore, type WikiImportReport } from './store.js'

export interface WikiConnectionReport {
  state: 'unconfigured' | 'configured' | 'ready' | 'partial' | 'failed'
  layout?: WikiLayout
  report?: WikiImportReport
  error?: string
  updatedAt?: string
  scope?: KnowledgeScope
}
type WikiConnectInput = { kbId: string; sourceDir: string; workspaceRoot: string; rawDir?: string; conversationEnabled?: boolean; scope: KnowledgeScope }
import { resolveWikiLayout, type WikiLayout } from './paths.js'
import { wikiHash, WikiCommitter } from './commit.js'
import { createWikiPage, wikiStorageKey, type WikiPage } from './identity.js'
import { parseWikiMarkdown, renderWikiPage } from './markdown.js'

export class WikiProviderBridge {
  readonly ingest: WikiIngest
  readonly proposals: WikiProposals
  /** Prepared once: this is consulted on every entry sync, so it must stay cheap. */
  private readonly hasStmt
  private readonly connections = new Map<string, Promise<WikiConnectionReport>>()
  private readonly updates = new Map<string, Promise<{ connection: WikiConnectionReport; job: WikiIngestJob; reused: boolean }>>()
  constructor(private readonly db: DatabaseSync, private readonly index: (page: WikiPage, draft: KnowledgeDraft) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS wiki_local_bases (kb_id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, conversation_enabled INTEGER NOT NULL DEFAULT 0);`)
    db.exec('CREATE TABLE IF NOT EXISTS wiki_connection_status(kb_id TEXT PRIMARY KEY, body TEXT NOT NULL)')
    this.hasStmt = db.prepare('SELECT 1 FROM wiki_local_bases WHERE kb_id=?')
    this.ingest = new WikiIngest(db, this)
    this.proposals = new WikiProposals(db, this)
  }
  /** Installed by host wiring; absent when the host cannot enumerate models. */
  host?: { models(): Promise<Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }>>; defaultModel(): { provider: string; model: string } | undefined }
  has(kbId: string): boolean { return this.hasStmt.get(kbId) !== undefined }
  list(): { kbId: string; layout: WikiLayout; conversationEnabled: boolean }[] {
    return (this.db.prepare('SELECT * FROM wiki_local_bases').all() as {kb_id: string;layout_json: string;conversation_enabled: number}[])
      .map(r => ({ kbId: r.kb_id, layout: JSON.parse(r.layout_json) as WikiLayout, conversationEnabled: !!r.conversation_enabled }))
  }
  async configure(input: { kbId: string; sourceDir: string; workspaceRoot: string; rawDir?: string; conversationEnabled?: boolean }): Promise<WikiLayout> {
    let layout = resolveWikiLayout(input)
    // Only existing, user-selected source/workspace roots are accepted. Do not create arbitrary configured roots.
    layout = resolveWikiLayout({...input,sourceDir:await realpath(input.sourceDir),workspaceRoot:await realpath(input.workspaceRoot)})
    const base = this.db.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(input.kbId)
    if (!base) throw new Error('WIKI_BASE_NOT_FOUND')
    if (!this.has(input.kbId) && this.db.prepare('SELECT 1 FROM knowledge_entries WHERE knowledge_base_id=? LIMIT 1').get(input.kbId)) throw new Error('WIKI_USE_EMPTY_BASE')
    for (const other of this.list()) {
      if (other.kbId === input.kbId) continue
      const { isPathInside } = await import('./paths.js')
      const a = [layout.workspaceRoot, layout.rawDir, layout.sourceDir], b = [other.layout.workspaceRoot, other.layout.rawDir, other.layout.sourceDir]
      if (a.some(p => b.some(q => isPathInside(p, q) || isPathInside(q, p)))) throw new Error('WIKI_CROSS_BASE_OVERLAP')
    }
    const old = this.list().find(b => b.kbId === input.kbId)
    if (old && JSON.stringify(old.layout) !== JSON.stringify(layout)) throw new Error('WIKI_RELOCATION_REQUIRES_DETACH')
    await mkdir(layout.pageDir, { recursive: true }); await mkdir(layout.rawDir, { recursive: true })
    this.db.prepare('INSERT INTO wiki_local_bases VALUES(?,?,?) ON CONFLICT(kb_id) DO UPDATE SET conversation_enabled=excluded.conversation_enabled')
      .run(input.kbId, JSON.stringify(layout), input.conversationEnabled ? 1 : 0)
    return layout
  }
  connectionStatus(kbId: string): WikiConnectionReport {
    const config = this.list().find(item => item.kbId === kbId)
    if (!config) return { state: 'unconfigured' }
    const row = this.db.prepare('SELECT body FROM wiki_connection_status WHERE kb_id=?').get(kbId) as { body: string } | undefined
    return row ? { ...JSON.parse(row.body) as WikiConnectionReport, layout: config.layout } : { state: 'configured', layout: config.layout }
  }
  connect(input: WikiConnectInput): Promise<WikiConnectionReport> {
    const queued = this.connections.get(input.kbId) ?? Promise.resolve({ state: 'configured' } as WikiConnectionReport)
    const next = queued.catch(() => ({ state: 'failed' } as WikiConnectionReport)).then(async () => {
      if (!input.scope || !['global', 'project'].includes(input.scope.kind) || input.scope.kind === 'project' && !input.scope.id.trim()) throw new Error('WIKI_SCOPE_REQUIRED')
      const save = (value: WikiConnectionReport) => {
        this.db.prepare('INSERT INTO wiki_connection_status VALUES(?,?) ON CONFLICT(kb_id) DO UPDATE SET body=excluded.body')
          .run(input.kbId, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }))
        return this.connectionStatus(input.kbId)
      }
      try {
        const layout = await this.configure(input), store = this.store(input.kbId)
        await store.committer.recover()
        await store.committer.assertSettled()
        const registrationStore = new WikiStore(layout)
        const report = await registrationStore.importValid(input.scope, `connect:${randomUUID()}`)
        const excludedPaths = report.items.filter(item => item.status === 'invalid' || item.status === 'too_long').map(item => 'wiki/' + item.relPath)
        await this.rebuild(input.kbId, { acceptExternal: true, excludedPaths })
        return save({ state: report.rejected ? 'partial' : 'ready', layout, report, scope: input.scope })
      } catch (error) {
        save({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    })
    this.connections.set(input.kbId, next)
    void next.finally(() => { if (this.connections.get(input.kbId) === next) this.connections.delete(input.kbId) }).catch(() => {})
    return next
  }

  update(kbId: string, settings: WikiIngestSettings): Promise<{ connection: WikiConnectionReport; job: WikiIngestJob; reused: boolean }> {
    const pending = this.updates.get(kbId)
    if (pending) return pending.then(result => ({ ...result, reused: true }))
    const work = this.performUpdate(kbId, settings)
    this.updates.set(kbId, work)
    void work.finally(() => { if (this.updates.get(kbId) === work) this.updates.delete(kbId) }).catch(() => {})
    return work
  }
  private async performUpdate(kbId: string, settings: WikiIngestSettings): Promise<{ connection: WikiConnectionReport; job: WikiIngestJob; reused: boolean }> {
    const active = this.ingest.running(kbId)
    if (active) return { connection: this.connectionStatus(kbId), job: active, reused: true }
    const config = this.list().find(item => item.kbId === kbId)
    if (!config) throw new Error('WIKI_BASE_NOT_FOUND')
    if (!settings.allowModel || !settings.python.trim() || !settings.provider || !settings.model) throw new Error('WIKI_INGEST_SETTINGS_REQUIRED')
    const connection = await this.connect({ kbId, sourceDir: config.layout.sourceDir, workspaceRoot: config.layout.workspaceRoot,
      rawDir: config.layout.rawDir, conversationEnabled: config.conversationEnabled, scope: settings.scope })
    const other = this.ingest.running(kbId)
    if (other) return { connection, job: other, reused: true }
    const job = await this.ingest.start(kbId, settings)
    return { connection, job, reused: false }
  }

  store(kbId: string): WikiStore {
    const config = this.list().find(b => b.kbId === kbId)
    if (!config) throw new Error('WIKI_BASE_NOT_FOUND')
    return new WikiStore(config.layout, async () => { await this.rebuild(kbId, { acceptExternal: false }) })
  }
  async initialize(kbId: string): Promise<void> {
    const result = await this.store(kbId).committer.recover()
    if (result.some(r => r.state === 'conflict')) throw new Error('WIKI_RECOVERY_CONFLICT')
    await this.rebuild(kbId)
  }
  async rebuild(kbId: string, options: { acceptExternal: boolean; excludedPaths?: string[] } = { acceptExternal: true }): Promise<void> {
    const store = this.store(kbId), manifest = await store.manifest()
    const connection = this.connectionStatus(kbId)
    const quarantined = options.excludedPaths ?? (connection.state === 'partial'
      ? connection.report?.items.filter(item => item.status === 'invalid' || item.status === 'too_long').map(item => 'wiki/' + item.relPath) ?? [] : [])
    const indexed = new Set<string>()
    // Read and validate all before changing derived rows.
    const prepared: { page: WikiPage; draft: KnowledgeDraft }[] = []
    let metadataChanged = false
    for (const page of manifest.pages) {
      if (page.status !== 'active' || quarantined.includes(page.relPath)) continue
      let bytes: Buffer
      try { bytes = (await store.page(page.pageId)).bytes } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
      const parsed = parseWikiMarkdown(bytes)
      const observedHash = wikiHash(bytes)
      if (page.fileSha256 !== observedHash) {
        if (!options.acceptExternal) throw new Error('WIKI_EXTERNAL_EDIT_DURING_INDEX_FINALIZATION')
        page.fileSha256 = observedHash; page.version++; metadataChanged = true
      }
      if (!parsed.title || !parsed.body.trim() || parsed.body.length > 50_000) throw new Error('WIKI_PAGE_NOT_INDEXABLE')
      prepared.push({ page, draft: normalizeDraft({ knowledgeBaseId: kbId, title: parsed.title, body: parsed.body,
        type: page.relPath.includes('/howtos/') ? 'procedure' : 'fact', tags: parsed.tags, scope: page.scope,
        confidence: 0.9, group: page.relPath.split('/').slice(1, -1).join('/') || 'Wiki',
        ...(page.provenance.kind === 'conversation' ? { source: { sessionId: page.provenance.sessionId, turn: page.provenance.turn, evidence: 'explicit' as const } } : {}) }) })
    }
    if (metadataChanged) {
      // Accept current external bytes into metadata; never project index content onto disk.
      await new WikiCommitter(store.layout.workspaceRoot).commit({ operationId: `external:${randomUUID()}`, targets: [await store.manifestTarget(manifest)] })
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of prepared) { this.index(item.page, item.draft); indexed.add(item.page.entryId) }
      const rows = this.db.prepare('SELECT id FROM knowledge_entries WHERE knowledge_base_id=?').all(kbId) as {id: string}[]
      for (const row of rows) if (!indexed.has(row.id)) {
        this.db.prepare("UPDATE knowledge_entries SET status='archived' WHERE id=?").run(row.id)
        this.db.prepare('DELETE FROM knowledge_fts WHERE knowledge_id=?').run(row.id)
        this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(row.id)
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  async import(kbId: string, scope: KnowledgeScope, dryRun: boolean): Promise<unknown> {
    const store = this.store(kbId)
    if (dryRun) return store.inspect()
    const result = await store.import(scope, `import:${randomUUID()}`)
    await this.rebuild(kbId)
    return result
  }
  async write(draft: KnowledgeDraft, target: KnowledgeEntry | undefined, operationId: string): Promise<string> {
    const normalized = normalizeDraft(draft), config = this.list().find(b => b.kbId === normalized.knowledgeBaseId)
    if (!config) throw new Error('WIKI_BASE_NOT_FOUND')
    if (draft.source && !config.conversationEnabled) throw new Error('WIKI_CONVERSATION_STANDARD_NOT_ENABLED')
    if (target && (target.knowledgeBaseId !== draft.knowledgeBaseId || JSON.stringify(target.scope) !== JSON.stringify(draft.scope))) throw new Error('WIKI_SCOPE_OR_BASE_CHANGE_FORBIDDEN')
    const store = this.store(draft.knowledgeBaseId)
    await store.committer.recover()
    await store.committer.assertSettled()
    if (draft.source && (!draft.source.sessionId || !Number.isSafeInteger(draft.source.turn))) throw new Error('WIKI_CONVERSATION_SOURCE_INCOMPLETE')
    const provenance = draft.source ? { kind: 'conversation' as const, sessionId: draft.source.sessionId!, turn: draft.source.turn! } : { kind: 'manual' as const, actor: 'management' }
    if (target) {
      const previousOperation = (await store.manifest()).pages.find(p => p.entryId === target.id)
      if (previousOperation?.lastOperation === operationId) { await this.rebuild(draft.knowledgeBaseId); return target.id }
      const { page, bytes } = await store.page(target.id), parsed = parseWikiMarkdown(bytes)
      if (page.fileSha256 !== wikiHash(bytes)) throw new Error('WIKI_EXTERNAL_EDIT_REQUIRES_REINDEX')
      const body = draft.body.replace(/^\s*#\s+[^\r\n]+\r?\n(?:\r?\n)?/, '')
      const output = renderWikiPage({ title: draft.title, body, frontMatter: { ...parsed.frontMatter.values, tags: draft.tags, updated: new Date().toISOString() } })
      await store.save(target.id, output, wikiHash(bytes), provenance, operationId)
      return target.id
    }
    const manifest = await store.manifest()
    const pathId = wikiHash(Buffer.from(operationId))
    const previous = manifest.pages.find(p => p.relPath === `wiki/notes/${pathId}.md`)
    if (previous) { await this.rebuild(draft.knowledgeBaseId); return previous.entryId }
    const page = createWikiPage(draft.knowledgeBaseId, `wiki/notes/${pathId}.md`, draft.scope, provenance)
    const now = new Date().toISOString()
    const bytes = renderWikiPage({ title: draft.title, body: draft.body, frontMatter: {
      tags: draft.tags, keywords: draft.tags, author: 'Knowledge', created: now, updated: now,
      sources: [], scope: draft.scope, provenance: draft.source ? 'conversation' : 'manual',
    } })
    page.fileSha256 = wikiHash(bytes); manifest.pages.push(page)
    await store.committer.commit({ operationId, targets: [{ relPath: page.relPath, expectedHash: null, bytes }, await store.manifestTarget(manifest)] })
    return page.entryId
  }
}
