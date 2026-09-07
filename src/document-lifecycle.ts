import { contentHash, type CandidateChange, type CandidateProposal, type KnowledgeEntry, type KnowledgeSource } from './domain.js'
import { applyKnowledgeTextEdits } from './knowledge-merge.js'

export interface LifecycleRequest {
  state: 'resolved' | 'complete'
  confirmation: string
  note: string
  wholeDocument: boolean
  oldText?: string
  newText?: string
}

export function normalizeFinalizationChange(value: unknown): Extract<CandidateChange, { kind: 'finalize' }> {
  const input = value as Record<string, unknown> | null
  if (!input || input.kind !== 'finalize' || (input.state !== 'resolved' && input.state !== 'complete')
    || !Number.isSafeInteger(input.baseVersion) || (input.baseVersion as number) < 1
    || typeof input.baseHash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.baseHash)
    || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000
    || typeof input.confirmation !== 'string' || !input.confirmation.trim() || input.confirmation.length > 2000) throw new Error('文档结束候选缺少有效状态、版本或确认依据')
  return { kind: 'finalize', state: input.state, baseVersion: input.baseVersion as number, baseHash: input.baseHash, note: input.note.trim(), confirmation: input.confirmation.trim() }
}

/** Ground status changes in a current direct user confirmation, not an Agent claim. */
export function assertLifecycleConfirmation(text: string, quote: string, state: string): void {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const evidence = typeof quote === 'string' ? quote.normalize('NFKC').replace(/\s+/gu, ' ').trim() : ''
  if (!evidence || evidence.length > 2000 || !normalized.includes(evidence)) throw new Error('请引用本轮用户明确确认解决或结束的原话')
  const clause = normalized.split(/[。！!；;\n]/u).find(value => value.includes(evidence)) ?? evidence
  if (/[?？]/u.test(clause) || /(?:是否|能否|是不是|好像|似乎|可能|也许|应该|大概|要是)/u.test(clause)
    || /(?:解决|完成|结束)(?:了)?(?:吗|么|嘛)/u.test(clause)) throw new Error('疑问或不确定表述不能作为结束确认')
  if (/(?:不代表|不表示|不意味着|不能算|不确定|不知道|未确认|没有确认|一旦|等到|假设|如果|假如|要是).{0,80}(?:解决|修复|完成|结束)|\b(?:wasn't|wasn’t|isn’t|isn't|hasn't|hasn’t|if|unless)\b.{0,80}\b(?:resolved|fixed|completed|finished)\b/iu.test(normalized)) throw new Error('尚未确认或假设性的说明不能作为结束确认')
  // A later negation or refusal must defeat an earlier affirmative quotation.
  if (/(?:没有|还没|尚未|未能|并未|不算|没|未).{0,8}(?:解决|完成|结束)|(?:不要|别|不必|暂不).{0,14}(?:标记|封存|关闭|结束)|(?:如果|假如|假设|若是).{0,20}(?:解决|完成|结束)|\b(?:not|never|isn't|isn’t|hasn't|hasn’t|don't|don’t)\b.{0,20}\b(?:resolved|fixed|complete|completed|close|mark)\b/iu.test(normalized)) {
    throw new Error('本轮包含未解决、假设或拒绝标记的说明，不能自动结束文档')
  }
  if (/[?？]/u.test(evidence) || /(?:是否|能否|是不是|好像|似乎|可能|也许|应该|大概|要是)/u.test(evidence)) throw new Error('疑问或不确定表述不能作为结束确认')
  const confirmed = state === 'resolved'
    ? /(?:已(?:经)?解决|解决了|解决好|已(?:经)?修复|修好了|问题好了|标记.{0,6}(?:解决|修复)|\b(?:resolved|fixed)\b)/iu.test(evidence)
    : state === 'complete' && /(?:已(?:经)?完成|完成了|收集完成|已(?:经)?结束|结束了|可以结束|就此结束|不再补充|标记.{0,6}(?:完成|结束)|\b(?:completed|finished)\b)/iu.test(evidence)
  if (!confirmed) throw new Error('需要用户明确确认“已解决”或“收集完成／结束”，普通“好了”不自动封存知识')
}

export function lifecycleProposal(entry: KnowledgeEntry, request: LifecycleRequest, userText: string, source: KnowledgeSource): CandidateProposal {
  assertLifecycleConfirmation(userText, request.confirmation, request.state)
  if (entry.documentState !== 'open') throw new Error('文档已经结束；如需继续修改，请先在知识库中重新打开')
  if (typeof request.wholeDocument !== 'boolean') throw new Error('必须明确区分整篇结束与局部问题解决')
  if (typeof request.note !== 'string' || !request.note.trim() || request.note.length > 2000) throw new Error('请提供最多 2000 字符的解决结论')
  const note = request.note.trim()
  const base = { baseVersion: entry.version, baseHash: contentHash(entry) }
  const draft = { knowledgeBaseId: entry.knowledgeBaseId, title: entry.title, body: entry.body, type: entry.type, tags: entry.tags, scope: entry.scope, confidence: 1, source: { ...source, evidence: 'explicit' as const } }
  if (request.wholeDocument) {
    if (request.oldText !== undefined || request.newText !== undefined) throw new Error('整篇结束仅修改状态和结论，不接受正文替换；局部修改请指定 wholeDocument=false')
    return { action: 'update', targetId: entry.id, draft, reason: `用户确认：${request.confirmation}\n结论：${note}`, change: { kind: 'finalize', ...base, state: request.state, note, confirmation: request.confirmation } }
  }
  if (typeof request.oldText !== 'string' || !request.oldText || request.oldText.length > 12000 || typeof request.newText !== 'string' || !request.newText.trim() || request.newText.length > 12000) throw new Error('局部状态更新需要唯一的 oldText 和包含状态、结论的 newText（各最多 12000 字符）')
  if (request.oldText.trim() === entry.body.trim()) throw new Error('局部更新不能替换整篇文档，请定位对应的问题段落')
  const edits = [{ oldText: request.oldText, newText: request.newText }]
  const applied = applyKnowledgeTextEdits(entry.body, edits)
  if (!applied.ok) throw new Error(applied.reason)
  return { action: 'update', targetId: entry.id, draft: { ...draft, body: applied.body }, reason: `局部问题${request.state === 'resolved' ? '已解决' : '已完成'}，整篇保持开放。用户确认：${request.confirmation}\n结论：${note}`, change: { kind: 'revise', ...base, edits } }
}
