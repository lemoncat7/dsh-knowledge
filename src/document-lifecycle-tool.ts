import type { KnowledgeProvider } from './provider.js'
import type { ToolDefinitionLike } from './runtime.js'
import { KnowledgeHandleCodec, readMountedKnowledge } from './retrieval.js'
import { currentDirectUserText } from './tool-authorization.js'
import { optionalToolInteger, requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'
import { lifecycleProposal } from './document-lifecycle.js'
import { inspectSensitiveContent } from './content-safety.js'
import { knowledgeDocumentPath } from './documents/path.js'

export function documentLifecycleTool(provider: KnowledgeProvider, codec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_document_status',
    description: 'When the current user explicitly confirms a problem resolved or collection complete, update the corresponding mounted knowledge document. First search/read the exact document and version. wholeDocument=true freezes the ENTIRE document without changing its body; use only when its whole subject is closed. For one issue in a broader document use wholeDocument=false with a unique exact oldText/newText replacement containing status and conclusion, leaving the document open. Never infer closure from an assistant claim, a question or a casual acknowledgement. Obeys read-only/audit/direct mount policy. Report pending review honestly; never claim pending status is applied.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        handle: { type: 'string' }, expectedVersion: { type: 'integer', minimum: 1 },
        state: { type: 'string', enum: ['resolved', 'complete'] },
        confirmation: { type: 'string', description: 'Exact complete clause from the current direct user confirmation; do not omit negations or question suffixes.' },
        note: { type: 'string', description: 'Verified resolution or completion conclusion, up to 2000 characters.' },
        wholeDocument: { type: 'boolean', description: 'Explicitly distinguish whole-document closure from a local section update.' },
        oldText: { type: 'string' }, newText: { type: 'string' },
      },
      required: ['handle', 'expectedVersion', 'state', 'confirmation', 'note', 'wholeDocument'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => false,
    async execute(raw, exec) {
      const agent = requireToolAgent(exec)
      const args = toolRecord(raw)
      const handle = requiredToolString(args.handle, 'handle', 4096)
      const expectedVersion = optionalToolInteger(args.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
      if (expectedVersion === undefined) throw new Error('请先读取文档并提供 expectedVersion')
      if (args.state !== 'resolved' && args.state !== 'complete') throw new Error('state 必须是 resolved 或 complete')
      if (typeof args.wholeDocument !== 'boolean') throw new Error('必须明确 wholeDocument')
      const { entry, mount } = await readMountedKnowledge(provider, agent, handle, codec, exec.signal)
      if (mount.writeMode === 'none') throw new Error('本会话对此知识库只有只读权限')
      if (entry.version !== expectedVersion) throw new Error('文档版本已变化，请重新读取并确认范围')
      const proposal = lifecycleProposal(entry, {
        state: args.state, wholeDocument: args.wholeDocument,
        confirmation: requiredToolString(args.confirmation, 'confirmation', 2000),
        note: requiredToolString(args.note, 'note', 2000),
        ...args.oldText === undefined ? {} : { oldText: args.oldText as string },
        ...args.newText === undefined ? {} : { newText: args.newText as string },
      }, currentDirectUserText(agent), { sessionId: agent.session.id })
      // Resolve again after asynchronous reads so a revoked mount cannot be
      // reused from a cached search handle. The provider checks version/hash.
      const current = await readMountedKnowledge(provider, agent, handle, codec, exec.signal)
      if (current.mount.writeMode === 'none') throw new Error('知识库写权限已撤回')
      if (current.entry.version !== expectedVersion) throw new Error('文档版本已变化，请重新读取')
      exec.signal.throwIfAborted()
      const reviewRequired = mount.writeMode === 'audit' || current.mount.writeMode === 'audit'
        || inspectSensitiveContent(`${proposal.draft.body}\n${proposal.reason}`).length > 0
      const sourceKey = `${agent.session.id}:status:${entry.id}:${expectedVersion}`
      const result = reviewRequired
        ? { candidate: await provider.propose(proposal, sourceKey, exec.signal) }
        : await provider.writeDirect(proposal, sourceKey, exec.signal)
      const appliedEntry = 'entry' in result ? result.entry : undefined
      return JSON.stringify({
        documentId: entry.id, title: entry.title, path: knowledgeDocumentPath(entry),
        status: result.candidate?.status === 'pending' ? 'pending-review'
          : 'outcome' in result && result.outcome === 'finalized' ? 'already-finalized'
          : result.candidate?.status === 'rejected' ? 'rejected' : 'applied', candidateId: result.candidate?.id,
        documentState: appliedEntry?.documentState ?? current.entry.documentState,
        requestedState: args.state, wholeDocument: args.wholeDocument,
        note: args.note,
      })
    },
  }
}
