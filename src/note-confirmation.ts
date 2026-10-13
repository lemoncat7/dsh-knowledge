import { randomUUID } from 'node:crypto'
import type { RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'
import { currentDirectUserText } from './tool-authorization.js'

const approved = new WeakMap<ToolRunContextLike, string>()
class Proposal extends Error {}
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
export function requestNoteConfirmation(exec: ToolRunContextLike, reason: string): void {
  exec.signal.throwIfAborted()
  if (!approved.has(exec)) throw new Proposal(reason)
  if (approved.get(exec) !== reason) throw new Error('待确认目标已变化，请重新读取并提出方案；尚未修改笔记')
}

/** Pending plans are server-owned, session-bound, bounded and deliberately not
 * restored after restart. Confirmation never accepts replacement tool args. */
export function noteConfirmationTools(ctx: RuntimeContextLike): (tool: ToolDefinitionLike) => ToolDefinitionLike {
  const pending = new Map<string, { id: string; turn: number; users: number; expires: number; tool: ToolDefinitionLike; args: unknown; reason: string }>()
  const turnOf = (exec: ToolRunContextLike) => exec.agent!.session.snapshotEvents().filter(e => e.type === 'turn/start').at(-1)?.seq ?? -1
  const usersOf = (exec: ToolRunContextLike) => exec.agent!.session.snapshotEvents().filter(e => e.type === 'user/message' && (e.data as unknown as { source?: { kind?: string } }).source?.kind === 'user').length
  const prune = () => { for (const [key, item] of pending) if (item.expires < Date.now()) pending.delete(key) }
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
      if (!isNoteConfirmation(text) || (/合并/u.test(text) && !plan.reason.startsWith('局部替换'))) {
        pending.delete(agent.session.id)
        throw new Error('用户未确认或改变了要求，原方案已取消；请按新要求重新提出方案')
      }
      pending.delete(agent.session.id)
      const confirmedExec = { ...exec }
      approved.set(confirmedExec, plan.reason)
      try { return await plan.tool.execute(plan.args, confirmedExec) }
      finally { approved.delete(confirmedExec) }
    },
  })
  return tool => ({ ...tool, description: tool.description + ' Confirmation is conversational, NOT a popup: the first call returns pending_confirmation without writing. Summarize its plan to the user and end the turn; after their next-turn agreement call knowledge_note_confirm with confirmationId, not this tool again.', async execute(raw, exec) {
    const args = structuredClone(raw)
    try { return await tool.execute(args, exec) }
    catch (error) {
      if (!(error instanceof Proposal) || !exec.agent) throw error
      prune()
      if (pending.size >= 100 && !pending.has(exec.agent.session.id)) throw new Error('待确认操作过多，请稍后重试')
      const id = randomUUID()
      pending.set(exec.agent.session.id, { id, turn: turnOf(exec), users: usersOf(exec), expires: Date.now() + 15 * 60_000, tool, args, reason: error.message })
      return JSON.stringify({ status: 'pending_confirmation', modified: false, confirmationId: id, summary: error.message, instructions: '向用户总结本次目标和变更，明确尚未执行，然后结束本轮。用户下一轮回复确认、可以或按这个改后，调用 knowledge_note_confirm；不要重新生成内容，不要声称已完成。15 分钟内有效。' })
    }
  } })
}
