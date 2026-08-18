import type { ResolvedConfig } from './config.js'
import type { KnowledgeProvider } from './provider.js'
import {
  formatMountCatalog,
  formatPrefetchedKnowledge,
  KnowledgeHandleCodec,
  resolveRecallMounts,
  searchMountedKnowledge,
} from './retrieval.js'
import { createRecallMessage, messageText, type PreStepDecision, type PreStepPayload, type RuntimeContextLike } from './runtime.js'

export function registerRecall(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  config: ResolvedConfig,
  codec: KnowledgeHandleCodec,
): () => void {
  return ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    // Writeback notices are durable UI feedback, not conversation input. DSH
    // stores them as surface messages so the client can render them beside the
    // completed answer; remove them again at the final model-request boundary.
    const messages = decision.messages.filter(message => !isWritebackNotice(message))
    const modelDecision: PreStepDecision = messages.length === decision.messages.length
      ? decision
      : { kind: 'enter', messages }
    if (config.autoRecallLimit === 0) return modelDecision
    const query = recallQuery(payload, modelDecision)
    if (query.length === 0) return modelDecision
    try {
      const mounts = await resolveRecallMounts(provider, payload.agent, payload.signal)
      if (mounts.length === 0) return modelDecision
      const hits = await searchMountedKnowledge(
        provider,
        payload.agent,
        mounts,
        query,
        config.autoRecallLimit,
        codec,
        payload.signal,
      )
      if (hits.length === 0) return modelDecision
      const text = formatPrefetchedKnowledge(hits, config.recallMaxChars)
      return { kind: 'enter', messages: [...messages, createRecallMessage(text)] }
    } catch (error) {
      if (!payload.signal.aborted) {
        ctx.logger.warn(`dsh-knowledge: recall failed open: ${error instanceof Error ? error.message : String(error)}`)
      }
      return modelDecision
    }
  })
}

/** Add mounted-base names and routing descriptions as a replaceable runtime-context snapshot. */
export function registerKnowledgeCatalog(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  config: ResolvedConfig,
): () => void {
  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const transformed = await next()
    if (context.agent === undefined) return transformed
    try {
      const mounts = await resolveRecallMounts(provider, context.agent, context.signal)
      const text = formatMountCatalog(mounts, Math.min(config.recallMaxChars, 6000))
      if (text.length === 0) return transformed
      return {
        ...transformed,
        contexts: [
          ...transformed.contexts.filter(item => item.name !== 'dsh-knowledge:mounts'),
          { name: 'dsh-knowledge:mounts', text },
        ],
      }
    } catch (error) {
      if (!context.signal?.aborted) {
        ctx.logger.warn(`dsh-knowledge: catalog failed open: ${error instanceof Error ? error.message : String(error)}`)
      }
      return transformed
    }
  })
}

function isWritebackNotice(message: { source: { kind: string; plugin?: string; form?: string } }): boolean {
  return message.source.kind === 'plugin'
    && message.source.plugin === 'dsh-knowledge'
    && message.source.form === 'notice'
}

function recallQuery(payload: PreStepPayload, decision: Extract<PreStepDecision, { kind: 'enter' }>): string {
  const direct = decision.messages.filter(message => message.source.kind === 'user')
  if (direct.length === 0 || payload.step !== 1) return ''
  return direct.map(messageText).filter(Boolean).join('\n').slice(0, 6000)
}
