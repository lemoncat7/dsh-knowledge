import { randomUUID } from 'node:crypto'
import type { RuntimeContextLike } from '../runtime.js'
export type WikiModel = (system: string, input: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>

/** No tools or agent preset are provided. All output is untrusted candidate data. */
export function createWikiModel(ctx: RuntimeContextLike, route: () => { provider: string; model: string } | undefined): WikiModel {
  return async (system, input, signal) => {
    const selection = route()
    if (!selection) throw new Error('WIKI_MODEL_NOT_CONFIGURED')
    const timeout = AbortSignal.timeout(180_000)
    const combined = AbortSignal.any([signal, timeout])
    let deltas = '', completed = ''
    for await (const chunk of ctx.llm.stream({ ...selection, sessionId: `wiki-internal:${randomUUID()}`, system,
      messages: [{ id: randomUUID(), role: 'user', source: { kind: 'plugin:dsh-knowledge-wiki' }, content: [{ type: 'text', text: JSON.stringify(input) }] }],
      temperature: 0, maxTokens: 8192, signal: combined })) {
      if (chunk.type === 'text-delta' && 'text' in chunk && typeof chunk.text === 'string') deltas += chunk.text
      if (chunk.type === 'block-end' && 'block' in chunk && chunk.block.type === 'text') completed += chunk.block.text ?? ''
      if (chunk.type === 'finish' && 'reason' in chunk && chunk.reason.kind !== 'stop') throw new Error(`WIKI_MODEL_INCOMPLETE:${chunk.reason.kind}`)
    }
    const text = (deltas || completed).trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const result: unknown = JSON.parse(text)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('WIKI_MODEL_RESULT_INVALID')
    return result as Record<string, unknown>
  }
}
