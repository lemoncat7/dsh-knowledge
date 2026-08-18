import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import { registerKnowledgeApi } from './api.js'
import { Config as ConfigSchema, resolveConfig, type Config as KnowledgeConfig } from './config.js'
import { ExtractionCoordinator } from './extraction.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import type { KnowledgeProvider } from './provider.js'
import { registerKnowledgeCatalog, registerRecall } from './recall.js'
import { KnowledgeHandleCodec } from './retrieval.js'
import { RemoteKnowledgeProvider } from './remote-provider.js'
import { createWritebackMessage, type RuntimeContextLike } from './runtime.js'
import { registerKnowledgeTools } from './tools.js'
import { registerKnowledgeWeb } from './web.js'

export const Config = ConfigSchema
export type Config = KnowledgeConfig
export * from './domain.js'
export * from './provider.js'
export { LocalKnowledgeProvider } from './local-provider.js'
export { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'

/** Human-readable Cordis plugin name. */
export const name = 'dsh-knowledge'

/** Extraction, native retrieval tools, and mounted-base context require the corresponding DSH host services. */
export const inject = ['llm', 'tools', 'systemPrompt']

/** Mount storage, hybrid retrieval, extraction, and the optional authenticated HTTP API. */
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
  const handleCodec = new KnowledgeHandleCodec(randomBytes(32))
  registerKnowledgeCatalog(runtime, provider, resolved)
  registerRecall(runtime, provider, resolved, handleCodec)
  registerKnowledgeTools(runtime, provider, handleCodec)

  if (resolved.extractionEnabled) {
    runtime.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      if (agent.session.append === undefined) throw new Error('synchronous knowledge writeback requires Session.append')
      let summary: string
      try {
        const result = await coordinator.run(agent.session, turn, signal)
        if (result.status === 'duplicate') return
        if (result.status === 'unmounted') summary = '知识库回写 · 未挂载可写知识库'
        else if (result.status === 'skipped') summary = '知识库回写 · 当前回答无可提取内容'
        else if (result.candidateCount === 0) summary = '知识库回写 · 无需收录'
        else summary = `知识库回写 · ${result.bases.map(base => {
          const parts = [base.directCount > 0 ? `直写 ${base.directCount}` : '', base.auditCount > 0 ? `待审 ${base.auditCount}` : ''].filter(Boolean)
          return `${base.name}：${parts.join('、')}`
        }).join('；')}`
      } catch (error) {
        if (signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        runtime.logger.warn(`dsh-knowledge: synchronous writeback failed: ${message}`)
        summary = message.includes('max-tokens')
          ? '知识库回写 · 失败：提取结果超过模型输出上限'
          : '知识库回写 · 失败，可稍后重试'
      }
      agent.session.append('user/message', createWritebackMessage(summary), { surfaceOp: 'append' })
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
