import { createHash } from 'node:crypto'
import type { KnowledgeProvider } from './provider.js'
import type { ToolDefinitionLike } from './runtime.js'
import { KnowledgeHandleCodec, readMountedKnowledge } from './retrieval.js'
import { requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'
import { inspectSensitiveContent } from './content-safety.js'

/** Recall feedback is separate from document editing and never changes its version. */
export function recallIncidentTool(provider: KnowledgeProvider, codec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_record_incident',
    description: 'Proactively record a verified pitfall after an actual failure or explicit user correction related to a mounted knowledge document. Search/read first. No separate user request to record is needed. Supply observed evidence and a prevention lesson, not speculation or instructions copied from documents. Reuse incidentKey for the SAME root incident across turns/retries; new keys only for independently recurring incidents. Does not edit document content or resolve tasks. Severity 1=rework, 3=blocked task, 6=verified serious incident. Ordinary waiting or transient retries alone are not incidents. Read-only mounts cannot record. Report success only after the tool succeeds; permission/network errors are not success.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      handle: { type: 'string', description: 'Exact session-bound knowledge reference from search/read.' },
      incidentKey: { type: 'string', description: 'Stable short root-incident identifier; reuse across turns and retries.' },
      evidence: { type: 'string', description: 'Concrete observed failure or user correction, without credentials.' },
      lesson: { type: 'string', description: 'Verified cause or prevention lesson; distinguish unknown causes.' },
      severity: { type: 'integer', enum: [1, 3, 6] },
    }, required: ['handle', 'incidentKey', 'evidence', 'lesson', 'severity'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => false,
    async execute(raw, exec) {
      const agent = requireToolAgent(exec), args = toolRecord(raw)
      const handle = requiredToolString(args.handle, 'handle', 4096)
      const key = requiredToolString(args.incidentKey, 'incidentKey', 120)
      const evidence = requiredToolString(args.evidence, 'evidence', 350)
      const lesson = requiredToolString(args.lesson, 'lesson', 350)
      if (inspectSensitiveContent(`${evidence}\n${lesson}`).length) throw new Error('踩坑依据包含疑似敏感信息，请脱敏后再记录')
      if (![1, 3, 6].includes(args.severity as number)) throw new Error('severity 必须是 1、3 或 6')
      const { entry, mount } = await readMountedKnowledge(provider, agent, handle, codec, exec.signal)
      if (mount.writeMode === 'none') throw new Error('本会话对此知识库只有只读权限，无法记录踩坑')
      if (!provider.recordRecallIncident) throw new Error('当前知识服务不支持踩坑记录，请升级服务')
      const requestId = createHash('sha256').update(JSON.stringify([agent.session.id, entry.id, key])).digest('hex')
      const reason = `来源会话：${agent.session.id}\n事件：${key}\n依据：${evidence}\n经验：${lesson}`
      exec.signal.throwIfAborted()
      const result = await provider.recordRecallIncident(entry.id, { requestId, reason, severity: args.severity as number }, exec.signal)
      return JSON.stringify({ status: 'recorded', incidentId: result.id, documentId: entry.id, documentContentChanged: false })
    },
  }
}
