import type { KnowledgeProvider } from './provider.js'
import type { AgentLike } from './runtime.js'
import { entryMatchesMount, resolveKnowledgeMounts } from './retrieval.js'

export interface TrackingSourcePage {
  id: string; name: string; revision: string; content: string
  offset: number; nextOffset: number | null; totalChars: number
}

/** Host-only grant. The caller must validate this exact persisted binding and
 * its lifetime. Never expose this argument on general model/search tools. */
export interface TrackingSourceBinding { sessionId: string; reference: string }

/** Resolve a selected document by identity, not ranked recall or shortened keywords. */
export async function readTrackingSource(provider: KnowledgeProvider, agent: AgentLike, reference: string, offset = 0, signal?: AbortSignal, binding?: TrackingSourceBinding): Promise<TrackingSourcePage> {
  if (typeof reference !== 'string' || reference.length > 500 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('[SOURCE_ARGUMENT_INVALID] reference 或 offset 无效')
  if (binding && (binding.sessionId !== agent.session.id || binding.reference !== reference)) throw new Error('[SOURCE_BINDING_INVALID] 定向只读授权与当前会话或绑定文档不一致')
  const slash = reference.indexOf('/')
  if (slash < 1 || !reference.slice(slash + 1).trim()) throw new Error('[SOURCE_DOCUMENT_REQUIRED] 请指定 知识库/完整文档名，不能把整个库当作文档')
  const base = reference.slice(0, slash).trim()
  const title = reference.slice(slash + 1).trim()
  const mounts = (await resolveKnowledgeMounts(provider, agent, signal)).filter(m => m.enabled && m.recallEnabled && (m.knowledgeBaseId === base || m.base.name === base))
  if (!mounts.length) throw new Error('[SOURCE_NOT_MOUNTED] 当前会话未挂载此可读知识库')
  if (mounts.length !== 1) throw new Error('[SOURCE_AMBIGUOUS] 知识库重名，请使用知识库 ID')
  const mount = mounts[0]!
  const matches = new Map<string, string>()
  let cursor: string | undefined
  const seen = new Set<string>()
  const byId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(title) ? await provider.getDocument(title, signal) : undefined
  if (byId?.knowledgeBaseId === mount.knowledgeBaseId) matches.set(byId.id, byId.title)
  for (let page = 0; !byId && page < 50; page++) {
    const result = await provider.listDocumentIndex({knowledgeBaseIds: [mount.knowledgeBaseId], query: title, limit: 100, ...(cursor ? {cursor} : {})}, signal)
    for (const doc of result.items) if (doc.knowledgeBaseId === mount.knowledgeBaseId && (doc.title === title || doc.id === title || doc.relPath === title)) matches.set(doc.id, doc.title)
    if (!result.nextCursor) { cursor = undefined; break }
    if (seen.has(result.nextCursor)) throw new Error('[SOURCE_INDEX_INCOMPLETE] 文档索引分页异常，不能断言文档不存在')
    seen.add(result.nextCursor); cursor = result.nextCursor
  }
  if (cursor) throw new Error('[SOURCE_INDEX_INCOMPLETE] 文档索引范围过大，请使用准确文档标识')
  if (!matches.size) throw new Error('[SOURCE_NOT_FOUND] 已挂载库中未找到完整文档名；请检查引用是否改名，不能用其他搜索结果代替')
  if (matches.size !== 1) throw new Error('[SOURCE_AMBIGUOUS] 同名文档不唯一，请改用准确文档标识')
  const id = [...matches.keys()][0]!
  const entry = await provider.get(id, signal)
  if (!entry || entry.status !== 'active' || entry.knowledgeBaseId !== mount.knowledgeBaseId) throw new Error('[SOURCE_UNAVAILABLE] 绑定文档已归档、移动或不存在')
  // A selected single document is an explicit read dependency, not broad recall.
  // Only its project-origin filter is relaxed; mount and tag restrictions remain.
  const projectId = binding && entry.scope.kind === 'project' ? entry.scope.id : agent.session.header.cwd
  if (!entryMatchesMount(entry, mount, projectId)) throw new Error('[SOURCE_OUTSIDE_SCOPE] 文档不在当前会话的标签或项目读取范围内')
  const document = await provider.getDocument(id, signal)
  if (!document || document.knowledgeBaseId !== mount.knowledgeBaseId) throw new Error('[SOURCE_CHANGED] 文档已移动或不可用，请重读')
  if (document.updatedAt !== entry.updatedAt || document.title !== entry.title) throw new Error('[SOURCE_CHANGED] 文档读取期间已更新，请重试读取')
  if (offset > document.content.length) throw new Error('[SOURCE_OFFSET_INVALID] 文档长度已变化，请从 offset=0 重读')
  return {id, name: document.title, revision: document.contentHash, content: document.content.slice(offset, offset + 6000), offset,
    nextOffset: offset + 6000 < document.content.length ? offset + 6000 : null, totalChars: document.content.length}
}
