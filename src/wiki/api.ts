import { listRaw, readRaw } from './raw.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { LocalKnowledgeProvider } from '../local-provider.js'
import type { KnowledgeScope } from '../domain.js'
import { wikiHash } from './commit.js'
import { browseDirectory } from './browse.js'
import { pickDirectoryNative } from './native-picker.js'
import { detectPython, installHint, installModules } from './python.js'

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 2_000_000) throw new Error('WIKI_REQUEST_TOO_LARGE'); chunks.push(bytes) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WIKI_REQUEST_INVALID')
  return value as Record<string, unknown>
}
function required(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new Error('WIKI_FIELD_REQUIRED'); return value }
function scopeOf(value: unknown): KnowledgeScope {
  if (value && typeof value === 'object' && 'kind' in value) {
    if (value.kind === 'global') return { kind: 'global' }
    if (value.kind === 'project' && 'id' in value) return { kind: 'project', id: required(value.id) }
  }
  throw new Error('WIKI_SCOPE_REQUIRED')
}
/** Only call after same-origin local management authentication; never public API. */
export async function handleWikiApi(provider: LocalKnowledgeProvider, segments: string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (value: unknown) => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)) }
  const kbId = segments[1], action = segments[2]
  if (req.method === 'GET' && segments.length === 1) { send(provider.wiki.list()); return }
  if (!kbId) throw new Error('WIKI_BASE_REQUIRED')
  if (req.method === 'GET' && action === 'connection') { send(provider.wiki.connectionStatus(kbId)); return }
  if (req.method === 'POST' && action === 'connect') {
    const body = await bodyOf(req)
    send(await provider.wiki.connect({ kbId, sourceDir: required(body.sourceDir),
      ...(body.wikiDir === undefined ? { workspaceRoot: required(body.workspaceRoot) } : { wikiDir: required(body.wikiDir) }),
      ...(body.rawDir === undefined ? {} : { rawDir: required(body.rawDir) }), conversationEnabled: body.conversationEnabled === true,
      ...(body.scope === undefined ? {} : { scope: scopeOf(body.scope) }) })); return
  }
  if (req.method === 'PUT' && segments.length === 2) {
    const body = await bodyOf(req)
    send(await provider.wiki.configure({ kbId, sourceDir: required(body.sourceDir), workspaceRoot: required(body.workspaceRoot),
      ...(body.rawDir === undefined ? {} : { rawDir: required(body.rawDir) }), conversationEnabled: body.conversationEnabled === true })); return
  }
  if (req.method === 'POST' && action === 'pick') {
    const body = await bodyOf(req)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300_000)
    try {
      const initial = typeof body.initial === 'string' && body.initial.trim() ? body.initial.trim() : undefined
      send(await pickDirectoryNative(initial, controller.signal))
    } catch (error) {
      if (controller.signal.aborted) throw new Error('PICK_CANCELLED：选择框已关闭')
      throw error
    } finally { clearTimeout(timer) }
    return
  }
  if (req.method === 'GET' && action === 'browse') {
    const query = new URL(req.url ?? '/', 'http://local').searchParams
    send(await browseDirectory(query.get('path') ?? undefined)); return
  }
  if (req.method === 'GET' && action === 'python') {
    const candidates = await detectPython()
    send({ candidates: candidates.slice(0, 8), hint: candidates[0] ? installHint(candidates[0].missing) : '未检测到 Python，请在下方手动填写解释器路径。' }); return
  }
  if (req.method === 'POST' && action === 'python-install') {
    const body = await bodyOf(req)
    const executable = required(body.path)
    const candidates = await detectPython()
    if (!candidates.some(candidate => candidate.path.toLowerCase() === executable.toLowerCase())) throw new Error('PYTHON_NOT_DETECTED：请先重新检测再安装')
    const missing = candidates.find(candidate => candidate.path.toLowerCase() === executable.toLowerCase())?.missing ?? []
    const result = await installModules(executable, missing)
    if (!result.ok) throw new Error(`PYTHON_INSTALL_FAILED：${result.output.slice(-600)}`)
    send({ ok: true, output: result.output.slice(-600) }); return
  }
  if (req.method === 'GET' && action === 'models') {
    if (!provider.wiki.host) { send({ providers: [] }); return }
    send({ providers: await provider.wiki.host.models(), default: provider.wiki.host.defaultModel() }); return
  }
  const store = provider.wiki.store(kbId)
  // Deprecated: distillation writes accepted updates directly, so no new proposals are produced.
  // Both routes stay for backward compatibility and for reading historical rows.
  if (req.method === 'GET' && action === 'proposals') { send(provider.wiki.proposals.list(kbId).map(p => ({...p,content:Buffer.from(p.bytes,'base64').toString('utf8')}))); return }
  if (req.method === 'POST' && action === 'proposal' && segments[3]) { const body=await bodyOf(req); await provider.wiki.proposals.review(kbId,segments[3],body.approve===true); send({ok:true}); return }
  if (req.method === 'GET' && action === 'discover') { send(await provider.wiki.ingest.discover(kbId)); return }
  // Change detection is read-only toward source files; POST refreshes and persists the report.
  if (req.method === 'GET' && action === 'changes') { send(provider.wiki.ingest.changeReport(kbId) ?? null); return }
  if (req.method === 'POST' && action === 'changes') { send(await provider.wiki.ingest.changes(kbId)); return }
  if (req.method === 'GET' && action === 'jobs') {
    const includeHidden = new URL(req.url ?? '/', 'http://local').searchParams.get('includeHidden') === 'true'
    // Audit reads every record; the default list keeps its display cap.
    send(provider.wiki.ingest.jobs(kbId, includeHidden, includeHidden ? 0 : 50)); return
  }
  // Scan is read-only toward source files: it reports candidates and registers page files only.
  if (req.method === 'POST' && action === 'scan') {
    const body = await bodyOf(req)
    const config = provider.wiki.list().find(item => item.kbId === kbId)
    if (!config) throw new Error('WIKI_BASE_NOT_FOUND')
    const connection = await provider.wiki.connect({ kbId, sourceDir: config.layout.sourceDir, wikiDir: config.layout.pageDir,
      rawDir: config.layout.rawDir, conversationEnabled: config.conversationEnabled })
    const discovery = await provider.wiki.ingest.scanSources(kbId)
    // Folder deliveries are reported per file (folder + path inside it) so the preview can group them.
    const folders = new Map<string, number>()
    const entries = discovery.files.map(file => {
      if (file.delivery) folders.set(file.delivery, (folders.get(file.delivery) ?? 0) + 1)
      return { name: basename(file.source), size: file.size, duplicate: file.duplicate, ...(file.delivery ? { folder: file.delivery } : {}), ...(file.relPath ? { relPath: file.relPath } : {}) }
    })
    const skipped = discovery.skipped.map(item => ({ name: item.name, size: item.size, reason: item.reason, ...(item.delivery ? { folder: item.delivery } : {}), ...(item.relPath ? { relPath: item.relPath } : {}) }))
    send({ connection, files: entries, folders: [...folders].map(([name, count]) => ({ name, count })), skipped }); return
  }
  if (req.method === 'POST' && action === 'process') {
    const body = await bodyOf(req)
    send(await provider.wiki.ingest.start(kbId, { python: required(body.python), provider: required(body.provider), model: required(body.model), allowModel: body.allowModel === true,
      scope: body.scope === undefined ? provider.wiki.connectionStatus(kbId).scope ?? { kind: 'global' } : scopeOf(body.scope) })); return
  }
  if (req.method === 'POST' && action === 'update') {
    const body = await bodyOf(req)
    send(await provider.wiki.update(kbId, { python: required(body.python), provider: required(body.provider), model: required(body.model), allowModel: body.allowModel === true,
      scope: body.scope === undefined ? provider.wiki.connectionStatus(kbId).scope ?? { kind: 'global' } : scopeOf(body.scope) })); return
  }
  if (req.method === 'POST' && action === 'ingest') {
    const body = await bodyOf(req)
    send(await provider.wiki.ingest.start(kbId, { python: required(body.python), provider: required(body.provider), model: required(body.model), allowModel: body.allowModel === true, scope: scopeOf(body.scope) })); return
  }
  if (req.method === 'POST' && action === 'job') {
    const body = await bodyOf(req), id = segments[3]
    if (body.action === 'dismiss-finished') { send({ hidden: provider.wiki.ingest.dismissFinished(kbId) }); return }
    if (!id) throw new Error('WIKI_JOB_NOT_FOUND')
    if (body.action === 'dismiss') { send(provider.wiki.ingest.dismiss(kbId,id)); return }
    if (body.action === 'cancel') { provider.wiki.ingest.cancel(kbId,id); send({ok:true}); return }
    if (body.action === 'classify') { send(provider.wiki.ingest.classify(kbId,id,required(body.itemId),required(body.category))); return }
    send(provider.wiki.ingest.resume(kbId,id)); return
  }
  if (req.method === 'GET' && action === 'inspect') { send(await store.inspect()); return }
  if (req.method === 'POST' && action === 'import') {
    const body = await bodyOf(req)
    send(await provider.wiki.import(kbId, scopeOf(body.scope), body.dryRun !== false)); return
  }
  if (req.method === 'POST' && action === 'rebuild') { await provider.wiki.rebuild(kbId); send({ ok: true }); return }
  if (req.method === 'POST' && action === 'recover') { send(await store.committer.recover()); return }
  if (req.method === 'GET' && action === 'raw') { send(await listRaw(store.layout)); return }
  if (req.method === 'GET' && action === 'raw-content') { const query=new URL(req.url??'/','http://local').searchParams; send(await readRaw(store.layout,required(query.get('path')),Number(query.get('offset')??0))); return }
  if (req.method === 'GET' && action === 'pages') { send((await store.manifest()).pages); return }
  if (action === 'page' && segments[3]) {
    if (req.method === 'GET') { const result = await store.page(segments[3]); send({ ...result.page, content: result.bytes.toString('utf8'), sha256: wikiHash(result.bytes) }); return }
    if (req.method === 'PUT') {
      const body = await bodyOf(req)
      await store.save(segments[3], Buffer.from(required(body.content)), required(body.expectedHash), { kind: 'manual', actor: 'management' }, `edit:${randomUUID()}`)
      send({ ok: true }); return
    }
  }
  if (action === 'standard') {
    const path = join(store.layout.workspaceRoot, 'schema.md')
    let bytes: Buffer | null = null
    try { bytes = await readFile(path) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (req.method === 'GET') { send({ content: bytes?.toString('utf8') ?? '', sha256: bytes ? wikiHash(bytes) : null }); return }
    if (req.method === 'PUT') {
      const body = await bodyOf(req)
      const expectedHash = body.expectedHash === null ? null : required(body.expectedHash)
      await store.committer.commit({ operationId: `standard:${randomUUID()}`, targets: [{ relPath: 'schema.md', expectedHash, bytes: Buffer.from(required(body.content)) }] })
      send({ ok: true }); return
    }
  }
  res.statusCode = 404; send({ error: 'WIKI_ROUTE_NOT_FOUND' })
}
