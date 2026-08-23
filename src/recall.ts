import type { ResolvedConfig } from './config.js'
import type { KnowledgeProvider } from './provider.js'
import {
  formatAutomaticRecall,
  formatMountCatalog,
  KnowledgeHandleCodec,
  resolveKnowledgeMounts,
  resolveRecallMounts,
  searchMountedKnowledge,
  selectAutomaticRecallHits,
} from './retrieval.js'
import {
  createRecallMessage,
  messageText,
  type PreStepDecision,
  type PreStepPayload,
  type RuntimeContextLike,
} from './runtime.js'

/**
 * Sanitize prior plugin surface messages, then perform bounded first-step
 * retrieval for the current direct user request. The injected recall snapshot
 * is discarded from later model steps and never becomes write-back evidence.
 */
export function registerKnowledgeRecall(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  config: ResolvedConfig,
  codec: KnowledgeHandleCodec,
): () => void {
  return ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages.filter(message => !isKnowledgeSurfaceMessage(message))
    const sanitized: PreStepDecision = messages.length === decision.messages.length
      ? decision
      : { kind: 'enter', messages }
    if (config.autoRecallLimit === 0) return sanitized
    const query = automaticRecallQuery(payload, sanitized)
    if (!shouldRecall(query)) return sanitized
    try {
      const mounts = await resolveRecallMounts(provider, payload.agent, payload.signal)
      if (mounts.length === 0) return sanitized
      const searched = await searchMountedKnowledge(
        provider,
        payload.agent,
        mounts,
        query,
        Math.min(config.autoRecallLimit * 3, 20),
        codec,
        payload.signal,
      )
      const hits = selectAutomaticRecallHits(searched, config.autoRecallLimit, config.autoRecallMinScore)
      const text = formatAutomaticRecall(hits, config.recallMaxChars)
      if (text.length === 0) return sanitized
      return { kind: 'enter', messages: [...messages, createRecallMessage(text)] }
    } catch (error) {
      if (!payload.signal.aborted) {
        ctx.logger.warn(`dsh-knowledge: automatic recall failed open: ${error instanceof Error ? error.message : String(error)}`)
      }
      return sanitized
    }
  })
}

/** Add a bounded, per-agent knowledge map through DSH's official prompt assembly waterfall. */
export function registerKnowledgeCatalog(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  config: ResolvedConfig,
): () => void {
  return ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const transformed = await next()
    if (context.agent === undefined) return transformed
    try {
      const [mounts, settings] = await Promise.all([
        resolveKnowledgeMounts(provider, context.agent, context.signal),
        provider.getSettings(context.signal),
      ])
      const text = formatMountCatalog(mounts, Math.min(config.recallMaxChars, 6000), settings.writebackPolicy)
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
        ctx.logger.warn(`dsh-knowledge: mounted-base catalog failed open: ${error instanceof Error ? error.message : String(error)}`)
      }
      return transformed
    }
  })
}

function isKnowledgeSurfaceMessage(message: { source: { kind: string; plugin?: string; form?: string } }): boolean {
  return message.source.kind === 'plugin'
    && message.source.plugin === 'dsh-knowledge'
    && (message.source.form === 'notice' || message.source.form === 'recall')
}

function automaticRecallQuery(
  payload: PreStepPayload,
  decision: Extract<PreStepDecision, { kind: 'enter' }>,
): string {
  if (payload.step !== 1) return ''
  return decision.messages
    .filter(message => message.source.kind === 'user')
    .map(messageText)
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000)
}

function shouldRecall(query: string): boolean {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
  if (normalized.length < 2) return false
  return !/^(?:你好|您好|嗨|哈喽|hello|hi|hey|谢谢|感谢|ok|okay|好的|在吗)[!！,.，。?？\s]*$/iu.test(normalized)
}
