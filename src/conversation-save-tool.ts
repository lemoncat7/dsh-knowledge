import type { KnowledgeProvider } from './provider.js'
import type { SessionLike, ToolDefinitionLike } from './runtime.js'
import { requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'

/** The current turn is the last turn/start event: stable within a turn, so a repeated command stays idempotent. */
function currentTurn(session: SessionLike): number {
  let last = 0
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'turn/start') continue
    const turn = event.data.turn
    last = typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : last + 1
  }
  return last
}

/** First paragraph of the saved body, bounded, so the answer can quote back what was actually written. */
function firstParagraph(body: string, limit = 200): string {
  const paragraph = body.split(/\r?\n[ \t]*\r?\n/u).map(part => part.trim()).find(part => part.length > 0) ?? body.trim()
  return paragraph.length > limit ? `${paragraph.slice(0, limit)}…` : paragraph
}

/**
 * Explicit command write. The write itself is owned by the provider: it resolves the session-selected
 * Wiki library, enforces conversation write + direct permission, and always creates a new page.
 */
export function conversationSaveTool(provider: KnowledgeProvider): ToolDefinitionLike {
  return {
    name: 'conversation_save',
    description: 'Explicit command write. Save a finished piece of THIS conversation as exactly ONE new knowledge page in the knowledge base the session selected. Use it only when the current user explicitly asks to save or record this content. It always creates a new page (wiki/notes/<hash>.md): there is no target page, no update, no overwrite and no review candidate. It requires the selected knowledge base to accept conversation writes and to grant this session direct write permission, otherwise it fails with a reason code. Report the returned knowledgeBaseId/entryId/pageId/relPath and excerpt exactly; never claim a save without this tool result.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'The current DSH session id. The host verifies it equals the calling session and refuses a mismatch, so content cannot be written under another session.' },
        title: { type: 'string', description: 'Page title, 1-200 characters.' },
        body: { type: 'string', description: 'Markdown body without YAML front matter, 1-50000 characters.' },
        projectId: { type: 'string', description: 'Optional project scope for the page, e.g. the session project id. Omit for a global page.' },
        sourcePath: { type: 'string', description: 'Optional document path this conversation piece refers to; recorded in provenance for later traceability.' },
      },
      required: ['sessionId', 'title', 'body'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => false,
    async execute(raw, exec) {
      const agent = requireToolAgent(exec)
      const args = toolRecord(raw)
      const sessionId = requiredToolString(args.sessionId, 'sessionId', 200)
      if (sessionId !== agent.session.id) throw new Error('WIKI_CONVERSATION_SAVE_SESSION_MISMATCH：sessionId 与当前会话不一致，未写入')
      const title = requiredToolString(args.title, 'title', 200)
      const body = requiredToolString(args.body, 'body', 50_000)
      const projectId = args.projectId === undefined ? undefined : requiredToolString(args.projectId, 'projectId', 500)
      const sourcePath = args.sourcePath === undefined ? undefined : requiredToolString(args.sourcePath, 'sourcePath', 1000)
      if (typeof provider.saveConversation !== 'function') {
        throw new Error('WIKI_CONVERSATION_SAVE_UNSUPPORTED：当前知识存储后端不支持命令式写入（仅本地后端支持）')
      }
      const turn = currentTurn(agent.session)
      exec.signal.throwIfAborted()
      const result = await provider.saveConversation({ sessionId, turn, title, body,
        ...(projectId === undefined ? {} : { projectId }),
        ...(sourcePath === undefined ? {} : { sourcePath }) }, exec.signal)
      exec.signal.throwIfAborted()
      const entry = await provider.get(result.entryId, exec.signal)
      return JSON.stringify({
        status: result.duplicate ? 'already-saved' : 'created',
        duplicate: result.duplicate,
        knowledgeBaseId: result.knowledgeBaseId,
        knowledgeBaseName: result.knowledgeBaseName,
        entryId: result.entryId,
        pageId: result.pageId,
        relPath: result.relPath,
        title: entry?.title ?? title,
        scope: result.scope,
        excerpt: firstParagraph(body),
        provenance: { sessionId, turn, ...(sourcePath === undefined ? {} : { sourcePath }) },
        note: result.duplicate ? '相同会话、轮次与内容的写入此前已完成，本次未重复建页' : '已新建一页；未修改或覆盖任何既有页',
      })
    },
  }
}
