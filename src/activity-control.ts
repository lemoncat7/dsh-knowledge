import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertKnowledgeBrowserRequest } from './api.js'
import type { KnowledgeProvider } from './provider.js'
import type { RuntimeContextLike } from './runtime.js'
import { isEditableNoteNode, isNoteId, noteReferenceMarkdown } from './notes/domain.js'
import type { KnowledgeNoteHandleCodec } from './note-reference-handle.js'

export interface NoteMentionOptions {
  codec: KnowledgeNoteHandleCodec
  sourceKey(): string
}

export const KNOWLEDGE_ACTIVITY_PATH = '/knowledge-control/v1/activity'
const MAX_ACTIVITY_NOTE_BYTES = 2 * 1024 * 1024

/** Same-origin, read-only surface for the conversation details panel. */
export function registerKnowledgeActivityControl(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  mentions?: NoteMentionOptions,
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('knowledge activity panel requires the DSH webServer service')
  return webServer.register({
    kind: 'prefix',
    path: KNOWLEDGE_ACTIVITY_PATH,
    handler: async (req, res) => {
      try { await dispatch(req, res, provider, mentions) } catch (error) { sendError(res, error) }
    },
  })
}

async function dispatch(req: IncomingMessage, res: ServerResponse, provider: KnowledgeProvider, mentions?: NoteMentionOptions): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    throw httpError(405, '会话知识侧栏只支持读取。')
  }
  assertKnowledgeBrowserRequest(req, 'conversation-web')
  const url = new URL(req.url ?? '/', 'http://knowledge.local')
  const relative = url.pathname.slice(KNOWLEDGE_ACTIVITY_PATH.length).replace(/^\/+|\/+$/g, '')
  let segments: string[]
  try { segments = relative ? relative.split('/').map(decodeURIComponent) : [] } catch { throw httpError(400, '知识侧栏路径格式无效。') }
  const sessionId = url.searchParams.get('sessionId')?.trim()
  if (!sessionId) throw httpError(400, 'sessionId is required')
  const projectId = url.searchParams.get('projectId')?.trim() || undefined

  if (segments[0] === 'note-mentions' && mentions) {
    const sourceKey = mentions.sourceKey()
    if (segments.length === 1) {
      const query = url.searchParams.get('q')?.trim() ?? ''
      if (query.length > 255) throw httpError(400, '笔记搜索词过长。')
      const notes = await provider.listNotes({ query, kind: 'document', recursive: true, limit: 20 })
      // Defense in depth for older remote services that ignore the new filter.
      const documents = notes.filter(node => node.kind === 'document').slice(0, 20)
      const parents = new Map<string, Promise<string>>()
      const pathFor = (id: string | null): Promise<string> => {
        if (id === null) return Promise.resolve('根目录')
        let pending = parents.get(id)
        if (!pending) {
          pending = provider.getNote(id).then(parent => parent?.name ?? '笔记目录')
          parents.set(id, pending)
        }
        return pending
      }
      const items = await Promise.all(documents.map(async node => ({
        id: node.id, name: node.name, parent: await pathFor(node.parentId), version: node.version,
      })))
      if (sourceKey !== mentions.sourceKey()) throw httpError(409, '知识库连接已切换，请重新搜索笔记。')
      return sendJson(res, 200, { sourceKey, items })
    }
    if (segments.length === 2) {
      const id = segments[1]!
      if (!isNoteId(id)) throw httpError(400, '笔记引用格式无效。')
      if (url.searchParams.get('sourceKey') !== sourceKey) throw httpError(409, '知识库连接已切换，请重新选择笔记引用。')
      const node = await provider.getNote(id)
      if (!node || node.kind !== 'document') throw httpError(404, '引用的笔记文档已不存在，请重新选择。')
      if (sourceKey !== mentions.sourceKey()) throw httpError(409, '知识库连接已切换，请重新选择笔记引用。')
      // Mint at submission, not search time: drafts survive server restarts and renames.
      const handle = mentions.codec.encode(sessionId, node.id)
      return sendJson(res, 200, { text: `${noteReferenceMarkdown(node)}\n（笔记文档引用；使用 knowledge_note_read 读取，noteHandle: ${handle}；此引用不授权修改或删除。）` })
    }
    throw httpError(404, '笔记引用接口不存在。')
  }

  if (segments[0] === 'notes' && segments.length === 1) {
    const query = url.searchParams.get('q')?.trim() || undefined
    const parentId = url.searchParams.get('parentId')?.trim() || null
    return sendJson(res, 200, await provider.listNotes({
      ...query === undefined ? { parentId } : { query },
      limit: integerParam(url, 'limit', 200, 1, 500),
    }))
  }
  if (segments[0] === 'notes' && segments[1] !== undefined && segments[2] === 'content' && segments.length === 3) {
    const node = await provider.getNote(segments[1])
    if (node === undefined) throw httpError(404, '这份笔记不存在。')
    if (!isEditableNoteNode(node)) throw httpError(415, '该文件暂不支持在会话侧栏中预览。')
    if (node.size > MAX_ACTIVITY_NOTE_BYTES) throw httpError(413, '这份笔记较大，请在完整工作区中打开。')
    const note = await provider.readNote(node.id)
    return sendJson(res, 200, { node: note.node, content: Buffer.from(note.content).toString('utf8') })
  }

  const mounts = await provider.resolveMounts(sessionId, projectId)

  if (segments[0] === 'mounts' && segments.length === 1) {
    return sendJson(res, 200, mounts)
  }
  if (segments[0] === 'documents' && segments.length === 1) {
    const mountedIds = new Set(mounts.map(mount => mount.knowledgeBaseId))
    if (mountedIds.size === 0) return sendJson(res, 200, { items: [], total: 0 })
    const requestedIds = url.searchParams.getAll('knowledgeBaseId').map(id => id.trim()).filter(id => mountedIds.has(id))
    const knowledgeBaseIds = requestedIds.length > 0 ? [...new Set(requestedIds)] : [...mountedIds]
    const query = url.searchParams.get('q')?.trim() || undefined
    const cursor = url.searchParams.get('cursor')?.trim() || undefined
    return sendJson(res, 200, await provider.listDocumentIndex({
      knowledgeBaseIds,
      activeKnowledgeBasesOnly: true,
      ...query === undefined ? {} : { query },
      ...cursor === undefined ? {} : { cursor },
      limit: integerParam(url, 'limit', 60, 1, 100),
    }))
  }
  if (segments[0] === 'documents' && segments[1] !== undefined && segments.length === 2) {
    const document = await provider.getDocument(segments[1])
    if (document === undefined || !mounts.some(mount => mount.knowledgeBaseId === document.knowledgeBaseId)) {
      throw httpError(404, '当前会话没有挂载这份知识文档。')
    }
    return sendJson(res, 200, document)
  }
  throw httpError(404, '知识侧栏接口不存在。')
}

function integerParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw httpError(400, `${name} must be an integer from ${min} to ${max}`)
  return value
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error !== null && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status : 500
  const message = status >= 500 ? '读取知识侧栏失败，请稍后重试。' : error instanceof Error ? error.message : '知识侧栏请求无效。'
  sendJson(res, status, { error: message, code: `HTTP_${status}` })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}
