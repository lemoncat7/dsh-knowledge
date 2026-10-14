import { randomUUID } from 'node:crypto'
import type { RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'
import { currentDirectUserText } from './tool-authorization.js'
import type { NoteMutationPreview } from './note-edit-plan.js'
import { optionalToolInteger, requiredToolString, toolRecord } from './tool-input.js'

const approved = new WeakMap<ToolRunContextLike, { reason: string; preview: string | undefined }>()
class Proposal extends Error {
  constructor(reason: string, readonly preview?: NoteMutationPreview) { super(reason) }
}
const PREVIEW_PAGE_CHARS = 12_000

export function renderNoteToolOutput(value: unknown): Array<{ type: 'text'; text: string }> {
  const raw = String(value)
  try {
    const item = JSON.parse(raw)
    if (item.status === 'pending_confirmation' || item.status === 'note_change_preview') {
      const more = item.nextPreviewOffset !== null ? `\n\n预览未展示完：已到第 ${item.previewOffset + item.preview.length} / ${item.previewTotalChars} 字符。须调用 knowledge_note_preview，offset=${item.nextPreviewOffset} 继续查看。` : '\n\n本次变更预览已读取完整，尚未保存。'
      return [{ type: 'text', text: `待确认：${item.summary}\n\n${item.preview}${more}\n\n确认编号：${item.confirmationId}\n${item.instructions ?? ''}` }]
    }
  } catch { /* Non-JSON outputs retain their original representation. */ }
  return [{ type: 'text', text: raw }]
}
export function isNoteConfirmation(text: string): boolean {
  // Ignore only an explicit dismissal of the obsolete whitespace proposal;
  // substantive changes or negation still require a new plan.
  const clauses = text.split(/[，,。！!；;\n]+/u).map(s => s.trim()).filter(Boolean)
    .filter(s => /^(?:空行|空白)(?:那个|的|提案|操作|那个提案|那个操作|那个不)?(?:不需要|不要|不用了|取消)(?:了)?$/u.test(s) === false)
  const rest = clauses.join('，')
  if (/(?:不|别|取消|等等|等一下|先别|但是|不过|改成|改为|增加|另外|再加|假设|如果|是否|吗|你说|他说|她说|引用|[“”「」"']|？|\?|don't|not|cancel|instead|but)/iu.test(rest)) return false
  return /^(?:确认|可以|可以的|好|好的|好呀|同意|按这个改|按这个修改|按这个执行|就这样改|执行吧|改吧|没问题|yes|ok|okay|go ahead|confirm)$/iu.test(rest)
    || /(?:我(?:已经|已)?确认(?:了)?|我同意(?:了)?|确认(?:修改|执行)|同意(?:修改|执行)|按(?:这个|刚才的|上述)方案(?:修改|执行))$/u.test(rest)
}
export function requestNoteConfirmation(exec: ToolRunContextLike, reason: string, preview?: NoteMutationPreview): void {
  exec.signal.throwIfAborted()
  if (!approved.has(exec)) throw new Proposal(reason, preview)
  if (approved.get(exec)?.reason !== reason || approved.get(exec)?.preview !== preview?.text) throw new Error('待确认目标已变化，请重新读取并提出方案；尚未修改笔记')
}

/** Pending plans are server-owned, session-bound, bounded and deliberately not
 * restored after restart. Confirmation never accepts replacement tool args. */
export function noteConfirmationTools(ctx: RuntimeContextLike): (tool: ToolDefinitionLike) => ToolDefinitionLike {
  const pending = new Map<string, { id: string; turn: number; users: number; expires: number; tool: ToolDefinitionLike; args: unknown; reason: string; preview: NoteMutationPreview | undefined; previewReadUntil: number }>()
  const turnOf = (exec: ToolRunContextLike) => exec.agent!.session.snapshotEvents().filter(e => e.type === 'turn/start').at(-1)?.seq ?? -1
  const usersOf = (exec: ToolRunContextLike) => exec.agent!.session.snapshotEvents().filter(e => e.type === 'user/message' && (e.data as unknown as { source?: { kind?: string } }).source?.kind === 'user').length
  const prune = () => { for (const [key, item] of pending) if (item.expires < Date.now()) pending.delete(key) }
  ctx.tools.register({
    name: 'knowledge_note_preview',
    description: 'Read the server-saved before/after preview of the current pending note change. If nextPreviewOffset is not null, continue with that offset BEFORE asking the user for one confirmation. This never writes or changes the proposal. Show every affected section and concrete before/after differences; do not merely ask for confirmation.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      confirmationId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 40000 },
    }, required: ['confirmationId'] },
    output: { schema: { type: 'string' }, render: (_args, value) => renderNoteToolOutput(value) },
    async execute(raw, exec) {
      exec.signal.throwIfAborted(); prune()
      const args = toolRecord(raw), id = requiredToolString(args.confirmationId, 'confirmationId', 100)
      const plan = exec.agent && pending.get(exec.agent.session.id)
      if (!plan || plan.id !== id) throw new Error('待确认操作已失效，请重新提出方案；尚未修改笔记')
      const text = plan.preview?.text ?? plan.reason
      const offset = optionalToolInteger(args.offset, 'offset', 0, text.length) ?? 0
      if (offset > plan.previewReadUntil) throw new Error(`预览中间仍有未读取内容，请从 offset=${plan.previewReadUntil} 继续，不可跳过修改内容`)
      const maxChars = optionalToolInteger(args.maxChars, 'maxChars', 1, 40000) ?? PREVIEW_PAGE_CHARS
      const preview = text.slice(offset, offset + maxChars), end = offset + preview.length
      if (offset <= plan.previewReadUntil) plan.previewReadUntil = Math.max(plan.previewReadUntil, end)
      return JSON.stringify({ status: 'note_change_preview', modified: false, confirmationId: id, summary: plan.reason,
        changeCount: plan.preview?.changeCount ?? 1, locations: plan.preview?.locations ?? [], preview,
        previewOffset: offset, previewTotalChars: text.length, nextPreviewOffset: end < text.length ? end : null,
      })
    },
  })
  ctx.tools.register({
    name: 'knowledge_note_confirm',
    description: 'Execute the exact pending note change only after the user replies in a later turn confirming the previously summarized plan (for example 确认、可以、按这个改). Never call in the proposing turn. Do not regenerate or alter the proposed content. A changed request needs a new proposal. Restart or expiry requires proposing again.',
    parameters: { type: 'object', additionalProperties: false, properties: { confirmationId: { type: 'string' } }, required: ['confirmationId'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(raw, exec) {
      exec.signal.throwIfAborted(); prune()
      const agent = exec.agent
      if (!agent) throw new Error('note confirmation requires a session')
      const plan = pending.get(agent.session.id)
      const id = (raw as { confirmationId?: unknown })?.confirmationId
      if (!plan || plan.id !== id) throw new Error('待确认操作已失效，请重新提出方案；尚未修改笔记')
      if (turnOf(exec) <= plan.turn) throw new Error('请先回复修改摘要，等待用户下一轮确认；尚未修改笔记')
      if (usersOf(exec) !== plan.users + 1) {
        pending.delete(agent.session.id)
        throw new Error('确认期间已有其他对话，旧方案已取消，请重新提出方案')
      }
      const text = currentDirectUserText(agent).trim().replace(/[。！!，,\s]+$/u, '')
      if (!isNoteConfirmation(text)) {
        pending.delete(agent.session.id)
        throw new Error('用户未确认或改变了要求，原方案已取消；请按新要求重新提出方案')
      }
      if (plan.previewReadUntil < (plan.preview?.text ?? plan.reason).length) {
        // Agreement obtained before the remaining changes were disclosed is
        // not permission to reveal them and write in that same turn.
        plan.turn = turnOf(exec); plan.users = usersOf(exec)
        throw new Error(`变更预览尚未读取完整；请 knowledge_note_preview confirmationId=${plan.id} offset=${plan.previewReadUntil}，补全展示后等待用户下一轮确认，尚未保存`)
      }
      pending.delete(agent.session.id)
      const confirmedExec = { ...exec }
      approved.set(confirmedExec, { reason: plan.reason, preview: plan.preview?.text })
      try { return await plan.tool.execute(plan.args, confirmedExec) }
      finally { approved.delete(confirmedExec) }
    },
  })
  return tool => ({ ...tool, description: tool.description + ' Confirmation is conversational, NOT a popup. Collect ALL edits requested for this note into ONE proposal, not one proposal per paragraph/chapter. The first call returns pending_confirmation without writing. Read all preview pages, show affected sections and concrete before/after changes (clearly label any abbreviated excerpts), then ask for ONE confirmation and end the turn. Never just say "please confirm". After next-turn agreement call knowledge_note_confirm with confirmationId, not this tool again.', async execute(raw, exec) {
    const args = structuredClone(raw)
    try { return await tool.execute(args, exec) }
    catch (error) {
      if (!(error instanceof Proposal) || !exec.agent) throw error
      prune()
      if (pending.size >= 100 && !pending.has(exec.agent.session.id)) throw new Error('待确认操作过多，请稍后重试')
      const id = randomUUID()
      const fullPreview = error.preview?.text ?? error.message
      const preview = fullPreview.slice(0, PREVIEW_PAGE_CHARS)
      pending.set(exec.agent.session.id, { id, turn: turnOf(exec), users: usersOf(exec), expires: Date.now() + 15 * 60_000, tool, args, reason: error.message, preview: error.preview, previewReadUntil: preview.length })
      return JSON.stringify({ status: 'pending_confirmation', modified: false, confirmationId: id, summary: error.message,
        changeCount: error.preview?.changeCount ?? 1, locations: error.preview?.locations ?? [], preview,
        previewOffset: 0, previewTotalChars: fullPreview.length, nextPreviewOffset: preview.length < fullPreview.length ? preview.length : null,
        instructions: '这是本次完整请求的一份修改提案，不要逐章重复申请确认。若 nextPreviewOffset 非空，先用 knowledge_note_preview 继续读取；向用户展示修改章节/行号及具体前后差异，不能只问是否确认。摘录须明确省略了哪些修改，说明尚未保存，再统一确认一次。用户下一轮同意后调用 knowledge_note_confirm；不要重新生成或拆分提交。15 分钟内有效。',
      })
    }
  } })
}
