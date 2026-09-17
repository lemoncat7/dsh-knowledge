import type { KnowledgeProvider } from './provider.js'
import type { ToolDefinitionLike } from './runtime.js'
import { entryMatchesMount, KnowledgeHandleCodec, readMountedKnowledge, resolveRecallMounts } from './retrieval.js'
import { normalizeDocumentGroup } from './document-groups.js'
import { optionalToolInteger, requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'

const output = { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] } as const

/** Common session tools. No companion-specific permission or dependency. */
export function documentGroupTools(provider: KnowledgeProvider, codec: KnowledgeHandleCodec): ToolDefinitionLike[] {
  return [{
    name: 'knowledge_document_groups',
    description: 'Browse knowledge-document groups and document metadata in one knowledge base mounted for recall in THIS session. Returns session-bound handles and versions for knowledge_document_group_assign. Results and group counts are for this page only; follow nextCursor until absent to discover all accessible groups, including when a filtered page is empty. Reuse a suitable existing group before creating another. This is not note folders, tags or knowledge-base grouping.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      knowledgeBaseId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, required: ['knowledgeBaseId'] },
    output, isConcurrencySafe: () => true,
    async execute(raw, exec) {
      const agent = requireToolAgent(exec), args = toolRecord(raw)
      const baseId = requiredToolString(args.knowledgeBaseId, 'knowledgeBaseId', 200)
      const mount = (await resolveRecallMounts(provider, agent, exec.signal)).find(item => item.knowledgeBaseId === baseId)
      if (!mount) throw new Error('知识库不在当前会话的可读取挂载范围内')
      const page = await provider.list({ knowledgeBaseId: baseId, status: 'active', limit: optionalToolInteger(args.limit, 'limit', 1, 100) ?? 100,
        ...args.cursor === undefined ? {} : { cursor: requiredToolString(args.cursor, 'cursor', 4096) },
      }, exec.signal)
      const current = (await resolveRecallMounts(provider, agent, exec.signal)).find(item => item.knowledgeBaseId === baseId)
      if (!current) throw new Error('知识库读取权限已撤回')
      const entries = page.items.filter(entry => entryMatchesMount(entry, current, agent.session.header.cwd))
      const counts = new Map<string, number>()
      for (const entry of entries) counts.set(entry.group ?? '', (counts.get(entry.group ?? '') ?? 0) + 1)
      return JSON.stringify({ knowledgeBaseId: baseId, writeMode: current.writeMode, groupCountsScope: 'current-page',
        groups: [...counts].map(([name, count]) => ({ name, count })), nextCursor: page.nextCursor,
        documents: entries.map(entry => ({ handle: codec.encode(agent.session.id, entry), title: entry.title, group: entry.group ?? '', version: entry.version, state: entry.documentState })),
      })
    },
  }, {
    name: 'knowledge_document_group_assign',
    description: 'Assign 1-50 knowledge documents to a group when organizing documents for the user. First browse knowledge_document_groups or search/read documents; use exact handles and versions. Prefer an existing suitable group. Modifies only group metadata, never body, tags, paths or completion state. Read-only mounts reject changes; audit mounts create pending review; direct mounts apply immediately. Batch is per-document, not atomic: inspect every result, retry only failed documents after re-reading. Never claim pending-review as applied. Available to ordinary and companion sessions alike.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      group: { type: 'string', minLength: 1, maxLength: 64 },
      documents: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, properties: {
        handle: { type: 'string' }, expectedVersion: { type: 'integer', minimum: 1 },
      }, required: ['handle', 'expectedVersion'] } },
    }, required: ['group', 'documents'] },
    output, isConcurrencySafe: () => false,
    async execute(raw, exec) {
      const agent = requireToolAgent(exec), args = toolRecord(raw)
      const group = normalizeDocumentGroup(args.group, true)
      if (!Array.isArray(args.documents) || args.documents.length < 1 || args.documents.length > 50) throw new Error('documents 必须包含 1-50 篇文档')
      const requests = args.documents.map(value => {
        const item = toolRecord(value)
        const version = optionalToolInteger(item.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (version === undefined) throw new Error('请先读取文档并提供 expectedVersion')
        return { handle: requiredToolString(item.handle, 'handle', 4096), version }
      })
      const results = []
      for (const request of requests) {
        exec.signal.throwIfAborted()
        try {
          const { entry, mount } = await readMountedKnowledge(provider, agent, request.handle, codec, exec.signal)
          if (mount.writeMode === 'none') throw new Error('本会话对此知识库只有只读权限')
          if (entry.version !== request.version) throw new Error('文档版本已变化，请重新读取后重试')
          if ((entry.group ?? '') === group) { results.push({ handle: request.handle, status: 'unchanged', group }); continue }
          const proposal = { action: 'update' as const, targetId: entry.id, draft: { ...entry, group }, reason: `调整文档分组：${entry.group || '未分组'} → ${group}`,
            change: { kind: 'group' as const, baseVersion: entry.version, group } }
          const current = await readMountedKnowledge(provider, agent, request.handle, codec, exec.signal)
          if (current.mount.writeMode === 'none') throw new Error('知识库写权限已撤回')
          if (current.entry.version !== request.version) throw new Error('文档版本已变化，请重新读取后重试')
          const sourceKey = `${agent.session.id}:group:${entry.id}:${entry.version}`
          exec.signal.throwIfAborted()
          const result = mount.writeMode === 'audit' || current.mount.writeMode === 'audit'
            ? { candidate: await provider.propose(proposal, sourceKey, exec.signal) }
            : await provider.writeDirect(proposal, sourceKey, exec.signal)
          results.push({ handle: request.handle, title: entry.title, group,
            status: result.candidate?.status === 'pending' ? 'pending-review' : result.candidate?.status === 'rejected' ? 'rejected' : 'applied',
            candidateId: result.candidate?.id,
          })
        } catch (error) {
          exec.signal.throwIfAborted()
          results.push({ handle: request.handle, status: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
      }
      return JSON.stringify({ results })
    },
  }]
}
