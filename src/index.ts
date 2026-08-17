import type { Context } from '@deepseek-ai/cordis'
import { registerKnowledgeApi } from './api.js'
import { Config as ConfigSchema, resolveConfig, type Config as KnowledgeConfig } from './config.js'
import { ExtractionCoordinator } from './extraction.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import type { KnowledgeProvider } from './provider.js'
import { registerRecall } from './recall.js'
import { RemoteKnowledgeProvider } from './remote-provider.js'
import type { RuntimeContextLike } from './runtime.js'
import { registerKnowledgeWeb } from './web.js'

export const Config = ConfigSchema
export type Config = KnowledgeConfig
export * from './domain.js'
export * from './provider.js'
export { LocalKnowledgeProvider } from './local-provider.js'
export { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'

/** Human-readable Cordis plugin name. */
export const name = 'dsh-knowledge'

/** Extraction requires DSH's LLM runtime; WebServer remains optional unless exposeApi is enabled. */
export const inject = ['llm']

/** Mount storage, recall, extraction, and the optional authenticated HTTP API. */
export function apply(ctx: Context, config: KnowledgeConfig): void {
  const runtime = ctx as unknown as RuntimeContextLike
  const resolved = resolveConfig(config)
  const provider: KnowledgeProvider = resolved.backend === 'local'
    ? new LocalKnowledgeProvider(resolved.databasePath as string)
    : new RemoteKnowledgeProvider({
      url: resolved.remoteUrl as string,
      token: resolved.remoteToken as string,
      timeoutMs: resolved.remoteTimeoutMs,
    })

  const coordinator = new ExtractionCoordinator(runtime, provider, resolved)
  registerRecall(runtime, provider, resolved)

  if (resolved.extractionEnabled) {
    runtime.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const reason = event.data.reason
      const turn = event.data.turn
      if (!isRecord(reason) || reason.kind !== 'completed' || typeof turn !== 'number') return
      coordinator.enqueue(session, turn)
    })
  }

  if (resolved.exposeApi) {
    if (!(provider instanceof LocalKnowledgeProvider)) throw new Error('exposeApi is supported only by the local backend')
    provider.ensureBootstrapToken(resolved.apiToken as string)
    if (runtime.inject === undefined) throw new Error('exposeApi requires Cordis dynamic service injection')
    runtime.inject(['webServer'], (httpRuntime) => {
      const disposeApi = registerKnowledgeApi(httpRuntime, provider, resolved.apiPrefix)
      httpRuntime.effect(() => disposeApi, 'dsh-knowledge.api')
      if (resolved.exposeWeb) {
        const disposeWeb = registerKnowledgeWeb(httpRuntime, resolved.webPath, resolved.apiPrefix)
        httpRuntime.effect(() => disposeWeb, 'dsh-knowledge.web')
      }
    })
  }

  runtime.effect(() => async () => {
    await coordinator.close()
    await provider.close()
  }, 'dsh-knowledge.close')

  runtime.logger.info(`dsh-knowledge: ${provider.mode} provider ready`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
