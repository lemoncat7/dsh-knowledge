import type { AgentLike, MessageLike } from './runtime.js'

export type KnowledgeBaseManagementOperation = 'create' | 'update'
export type KnowledgeNoteReferenceOperation = 'inspect' | 'add' | 'remove'

/**
 * Knowledge-base management is a persistent control-plane mutation. Tool
 * descriptions help model routing, but the execution boundary independently
 * verifies that the current direct user turn requested this exact operation.
 */
export function assertExplicitKnowledgeBaseManagementRequest(
  agent: AgentLike,
  operation: KnowledgeBaseManagementOperation,
): void {
  const text = currentDirectUserText(agent)
  if (!explicitlyRequestsKnowledgeBaseManagement(text, operation)) {
    throw new Error(`knowledge_base_${operation} requires an explicit request in the current direct user message`)
  }
}

export function explicitlyRequestsKnowledgeBaseManagement(
  input: string,
  operation: KnowledgeBaseManagementOperation,
): boolean {
  const text = input.normalize('NFKC').toLocaleLowerCase('zh-CN').trim()
  if (text.length === 0) return false
  const clauses = text.split(/[。！？!?；;\n，,]+/u).map(clause => clause.trim()).filter(Boolean)
  return clauses.some(clause => !deniesKnowledgeBaseMutation(clause, operation)
    && clauseRequestsKnowledgeBaseManagement(clause, operation))
}

export function assertExplicitKnowledgeNoteReferenceRequest(
  agent: AgentLike,
  operation: KnowledgeNoteReferenceOperation,
): void {
  const text = currentDirectUserText(agent).normalize('NFKC').toLocaleLowerCase('zh-CN').trim()
  const clauses = text.split(/[。！？!?；;\n，,]+/u).map(clause => clause.trim()).filter(Boolean)
  if (!clauses.some(clause => clauseRequestsKnowledgeNoteReference(clause, operation))) {
    throw new Error(`knowledge note reference ${operation} requires an explicit request in the current direct user message`)
  }
}

function clauseRequestsKnowledgeBaseManagement(
  text: string,
  operation: KnowledgeBaseManagementOperation,
): boolean {
  if (operation === 'create') {
    return /(?:创建|新建|建立|新增|加一个|建一个|开一个|創建).{0,16}(?:知识库|知識庫)/iu.test(text)
      || /(?:知识库|知識庫).{0,16}(?:创建|新建|建立|新增|創建)/iu.test(text)
      || /(?:create|make|set\s*up)\s+(?:(?:a|an|the|new)\s+){0,2}(?:knowledge\s*(?:base|store)|memory\s*(?:base|store))/iu.test(text)
      || /add\s+(?:(?:a|an|the|new)\s+){0,2}(?:knowledge\s*(?:base|store)|memory\s*(?:base|store))/iu.test(text)
  }
  return /(?:修改|更新|编辑|调整|更改|改成|改为|重命名|换名|设置|切换|清除|移除|删除|添加).{0,24}(?:知识库|知識庫)/iu.test(text)
    || /(?:知识库|知識庫).{0,28}(?:修改|更新|编辑|调整|更改|改成|改为|重命名|换名|设置|切换|清除|移除|删除|添加|改一下|改下|編輯|調整)/iu.test(text)
    || /(?:update|edit|modify|rename|change|configure|clear)\s+(?:(?:a|an|the|this|that)\s+){0,2}(?:knowledge\s*(?:base|store)|memory\s*(?:base|store))/iu.test(text)
    || /(?:knowledge\s*(?:base|store)|memory\s*(?:base|store)).{0,40}(?:update|edit|modify|rename|change|configure|clear|remove|set)/iu.test(text)
}

function currentDirectUserText(agent: AgentLike): string {
  let turnStart = -1
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    if (agent.session.events[index]?.type === 'turn/start') {
      turnStart = index
      break
    }
  }
  return agent.session.events.slice(turnStart + 1)
    .filter(event => event.type === 'user/message')
    .map(event => event.data as unknown as MessageLike)
    .filter(message => message.source?.kind === 'user')
    .flatMap(message => message.content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function clauseRequestsKnowledgeNoteReference(text: string, operation: KnowledgeNoteReferenceOperation): boolean {
  const subject = /(?:知识|知識|knowledge).{0,28}(?:笔记|筆記|note)|(?:笔记|筆記|note).{0,28}(?:知识|知識|knowledge)/iu.test(text)
  if (!subject) return false
  if (operation === 'inspect') return /(?:引用|关联|關聯|连接|連接|link|reference|associate|attach)/iu.test(text)
  if (operation === 'add') {
    if (/(?:不要|别|取消|移除|删除|解除|do\s+not|don't|remove|delete|detach|unlink).{0,20}(?:引用|关联|link|reference|attach)/iu.test(text)) return false
    return /(?:引用|关联|關聯|连接|連接|绑定|綁定|加上|添加|link|reference|associate|attach)/iu.test(text)
  }
  return /(?:取消|移除|删除|解除|不再).{0,20}(?:引用|关联|關聯|连接|連接|绑定|link|reference|associate|attach)|(?:remove|delete|detach|unlink).{0,24}(?:note|reference|link)/iu.test(text)
}

function deniesKnowledgeBaseMutation(text: string, operation: KnowledgeBaseManagementOperation): boolean {
  const verb = operation === 'create'
    ? '(?:创建|新建|建立|新增|創建|create|add|make|set\\s*up)'
    : '(?:修改|更新|编辑|调整|更改|改名|重命名|设置|切换|清除|移除|删除|添加|update|edit|modify|rename|change|configure|clear|remove|set)'
  const base = '(?:知识库|知識庫|knowledge\\s*(?:base|store)|memory\\s*(?:base|store))'
  const denial = '(?:不要|别|无需|不需要|禁止|取消|别再|暫停|停止|do\\s+not|don\'t|never|no\\s+need\\s+to|stop)'
  return new RegExp(`${denial}.{0,24}${verb}.{0,24}${base}`, 'iu').test(text)
    || new RegExp(`${denial}.{0,24}${base}.{0,24}${verb}`, 'iu').test(text)
    || new RegExp(`${base}.{0,24}${denial}.{0,24}${verb}`, 'iu').test(text)
    || new RegExp(`${verb}.{0,24}${denial}.{0,24}${base}`, 'iu').test(text)
}
