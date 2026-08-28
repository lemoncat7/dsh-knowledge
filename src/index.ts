import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { assertKnowledgeBrowserRequest, LOCAL_MANAGEMENT_API_PREFIX, registerKnowledgeApi } from './api.js'
import {
  connectionSettingsBase,
  createConnectionProvider,
  loadStoredConnection,
  sameConnection,
  storeConnection,
  validateConnectionSettings,
  type KnowledgeConnectionSettings,
} from './connection.js'
import { Config as ConfigSchema, resolveConfig, type Config as KnowledgeConfig } from './config.js'
import { KNOWLEDGE_SETTINGS_NAMESPACE } from './constants.js'
import { registerKnowledgeControl, type KnowledgeConnectionUpdate } from './control.js'
import { ExtractionCoordinator } from './extraction.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import { registerRemoteManagementProxy } from './management-proxy.js'
import type { KnowledgeProvider } from './provider.js'
import { KnowledgeProviderRouter } from './provider-router.js'
import { registerKnowledgeCatalog, registerKnowledgeRecall } from './recall.js'
import { KnowledgeHandleCodec } from './retrieval.js'
import { KnowledgeNoteHandleCodec } from './note-reference-handle.js'
import { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'
import type { AgentLike, RuntimeContextLike } from './runtime.js'
import { loadServiceSettings, serviceSettingsPath, storeServiceSettings, type KnowledgeServiceSettings } from './service-settings.js'
import { registerKnowledgeTools } from './tools.js'
import { createKnowledgeTrackingService, KNOWLEDGE_TRACKING_SERVICE } from './tracking.js'
import { registerKnowledgeWeb } from './web.js'

export const Config = ConfigSchema
export type Config = KnowledgeConfig
export * from './domain.js'
export * from './provider.js'
export * from './notes/domain.js'
export { LocalKnowledgeProvider } from './local-provider.js'
export { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'

/** Human-readable Cordis plugin name. */
export const name = 'dsh-knowledge'

/** Extraction and native retrieval tools require the corresponding DSH host services. */
export const inject = ['llm', 'tools']

/** Mount storage, hybrid retrieval, extraction, and the optional authenticated HTTP API. */
export function apply(ctx: Context, config: KnowledgeConfig): void {
  const runtime = ctx as unknown as RuntimeContextLike
  const resolved = resolveConfig(config)
  runtime.inject?.(['settings'], settingsRuntime => {
    settingsRuntime.settings?.register(
      KNOWLEDGE_SETTINGS_NAMESPACE,
      Schema.object({}),
      { base: {} },
    )
  })
  const persistedServicePath = serviceSettingsPath(resolved.connectionPath)
  let publicApiEnabled = resolved.exposeApi
  let clientSettings: KnowledgeServiceSettings = { publicApiEnabled }
  try {
    const storedService = loadServiceSettings(persistedServicePath)
    if (storedService !== undefined) { clientSettings = storedService; publicApiEnabled = storedService.publicApiEnabled }
  } catch (error) {
    runtime.logger.warn(`dsh-knowledge: ignored invalid service settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (resolved.backend === 'remote') { publicApiEnabled = false; clientSettings = { ...clientSettings, publicApiEnabled: false } }
  const baseConnection = connectionSettingsBase(resolved)
  let initialConnection = baseConnection
  try {
    const stored = loadStoredConnection(resolved.connectionPath)
    if (stored !== undefined) {
      validateConnectionSettings(stored, publicApiEnabled, resolved.databasePath !== undefined && resolved.databasePath.trim().length > 0)
      initialConnection = stored
    }
  } catch (error) {
    runtime.logger.warn(`dsh-knowledge: ignored invalid stored connection: ${error instanceof Error ? error.message : String(error)}`)
  }
  const initialProvider = createConnectionProvider(resolved, initialConnection, publicApiEnabled)
  const managementProvider = resolved.databasePath === undefined || resolved.databasePath.trim().length === 0
    ? undefined
    : new LocalKnowledgeProvider(resolved.databasePath)
  const providerRouter = new KnowledgeProviderRouter(initialProvider)
  const provider: KnowledgeProvider = providerRouter.provider
  let activeConnection = initialConnection

  const coordinator = new ExtractionCoordinator(runtime, provider, resolved, () => (
    clientSettings.writebackProvider && clientSettings.writebackModel
      ? { provider: clientSettings.writebackProvider, model: clientSettings.writebackModel }
      : undefined
  ))
  type WritebackStatus = { status: 'running' | 'completed' | 'failed'; summary: string; error?: string; retryable: boolean }
  const writebackStatuses = new Map<string, WritebackStatus>()
  const writebackSources = new Map<string, { agent: AgentLike; turn: number }>()
  let runWriteback: (agent: AgentLike, turn: number, signal: AbortSignal) => Promise<WritebackStatus>
  const handleCodec = new KnowledgeHandleCodec(randomBytes(32))
  const noteHandleCodec = new KnowledgeNoteHandleCodec(randomBytes(32))
  const managementEmbedToken = randomBytes(32).toString('base64url')
  registerKnowledgeRecall(runtime, provider, resolved, handleCodec)
  registerKnowledgeCatalog(runtime, provider, resolved)
  registerKnowledgeTools(runtime, provider, handleCodec, noteHandleCodec)
  runtime.provide?.(KNOWLEDGE_TRACKING_SERVICE, createKnowledgeTrackingService(provider))

  let refreshManagementApi = (): void => {}
  let switching: Promise<unknown> = Promise.resolve()
  const updateConnection = (input: KnowledgeConnectionUpdate): Promise<KnowledgeConnectionSettings> => {
    const pending = switching.then(async () => {
      const next: KnowledgeConnectionSettings = {
        backend: input.backend,
        remoteTimeoutMs: input.remoteTimeoutMs,
        ...input.remoteUrl !== undefined ? { remoteUrl: input.remoteUrl } : activeConnection.remoteUrl !== undefined ? { remoteUrl: activeConnection.remoteUrl } : {},
        ...input.remoteToken !== undefined ? { remoteToken: input.remoteToken } : activeConnection.remoteToken !== undefined ? { remoteToken: activeConnection.remoteToken } : {},
      }
      validateConnectionSettings(next, publicApiEnabled, resolved.databasePath !== undefined && resolved.databasePath.trim().length > 0)
      if (sameConnection(next, activeConnection)) return activeConnection
      if (resolved.connectionPath === undefined) throw connectionError(409, '当前插件没有配置持久化路径，无法保存连接。')
      const candidate = createConnectionProvider(resolved, next, publicApiEnabled)
      let persisted = false
      let installed = false
      let managementRouteChanged = false
      const previous = activeConnection
      const restoreManagementApi = (): void => {
        activeConnection = previous
        try { refreshManagementApi() } catch (rollbackError) {
          runtime.logger.error(`dsh-knowledge: failed to restore management API route: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      try {
        if (next.backend === 'remote') await candidate.stats()
        await storeConnection(resolved.connectionPath, next)
        persisted = true
        activeConnection = next
        try {
          refreshManagementApi()
          managementRouteChanged = true
        } catch (error) {
          restoreManagementApi()
          throw error
        }
        await providerRouter.replace(candidate)
        installed = true
        runtime.logger.info(`dsh-knowledge: verified and switched to ${next.backend} provider`)
        return activeConnection
      } catch (error) {
        if (installed) return next
        await candidate.close().catch(() => {})
        activeConnection = previous
        if (managementRouteChanged) restoreManagementApi()
        if (persisted) {
          await storeConnection(resolved.connectionPath, previous).catch(rollbackError => {
            runtime.logger.error(`dsh-knowledge: failed to restore connection settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
          })
        }
        throw error
      }
    })
    const operation = pending.catch(error => {
      runtime.logger.warn(`dsh-knowledge: connection switch rejected: ${error instanceof Error ? error.message : String(error)}`)
      throw publicConnectionError(error)
    })
    switching = operation.catch(() => {})
    return operation
  }

  const registerHttpSurfaces = (httpRuntime: RuntimeContextLike): void => {
    let disposePublicApi: (() => void) | undefined
    const publicApiView = () => ({
      publicApiEnabled,
      publicApiPrefix: resolved.apiPrefix,
      ...clientSettings.writebackProvider && clientSettings.writebackModel
        ? { writebackProvider: clientSettings.writebackProvider, writebackModel: clientSettings.writebackModel }
        : {},
    })
    const applyPublicApiRoute = (enabled: boolean): void => {
      disposePublicApi?.()
      disposePublicApi = undefined
      if (enabled) {
        if (managementProvider === undefined) throw connectionError(409, '当前 DSH 没有可供远程访问的本地知识库。')
        disposePublicApi = registerKnowledgeApi(httpRuntime, managementProvider, resolved.apiPrefix)
      }
    }
    const updateClientSettings = async (patch: { publicApiEnabled?: boolean; writebackProvider?: string | null; writebackModel?: string | null }): Promise<ReturnType<typeof publicApiView>> => {
      const enabled = patch.publicApiEnabled ?? publicApiEnabled
      if (enabled && activeConnection.backend !== 'local') throw connectionError(409, '请先把知识库来源切换为本地，再开启远程 API。')
      if (persistedServicePath === undefined) throw connectionError(409, '当前插件没有配置持久化路径，无法保存远程 API 状态。')
      const clearRoute = patch.writebackProvider === null || patch.writebackModel === null
      const provider = typeof patch.writebackProvider === 'string' ? patch.writebackProvider.trim() : clientSettings.writebackProvider
      const model = typeof patch.writebackModel === 'string' ? patch.writebackModel.trim() : clientSettings.writebackModel
      if (!clearRoute && ((provider === undefined) !== (model === undefined))) throw connectionError(400, '本机回写模型需要同时选择提供方和模型。')
      if (!clearRoute && provider && model) {
        try { await runtime.llm.resolveModelInfo(provider, model) }
        catch (error) { throw connectionError(400, `当前客户端无法使用 ${provider} / ${model}：${error instanceof Error ? error.message : String(error)}`) }
      }
      const previous = clientSettings
      const next: KnowledgeServiceSettings = {
        publicApiEnabled: enabled,
        ...!clearRoute && provider && model ? { writebackProvider: provider, writebackModel: model } : {},
      }
      if (enabled !== publicApiEnabled) applyPublicApiRoute(enabled)
      publicApiEnabled = enabled
      clientSettings = next
      try {
        await storeServiceSettings(persistedServicePath, next)
      } catch (error) {
        clientSettings = previous
        if (publicApiEnabled !== previous.publicApiEnabled) applyPublicApiRoute(previous.publicApiEnabled)
        publicApiEnabled = previous.publicApiEnabled
        throw error
      }
      return publicApiView()
    }

    if (resolved.exposeApi && managementProvider !== undefined && resolved.apiToken !== undefined) {
      managementProvider.ensureBootstrapToken(resolved.apiToken)
    }

    let disposeManagementApi: (() => void) | undefined
    const applyManagementApiRoute = (): void => {
      disposeManagementApi?.()
      disposeManagementApi = undefined
      if (!resolved.exposeWeb) return
      if (activeConnection.backend === 'remote') {
        disposeManagementApi = registerRemoteManagementProxy(httpRuntime, LOCAL_MANAGEMENT_API_PREFIX, () => activeConnection, {
          current: publicApiView,
          update: updateClientSettings,
        })
      } else if (managementProvider !== undefined) {
        disposeManagementApi = registerKnowledgeApi(httpRuntime, managementProvider, LOCAL_MANAGEMENT_API_PREFIX, {
          authMode: 'same-origin',
          service: { current: publicApiView, update: updateClientSettings },
        })
      }
    }
    refreshManagementApi = applyManagementApiRoute
    applyManagementApiRoute()
    httpRuntime.effect(() => () => { disposeManagementApi?.() }, 'dsh-knowledge.management-api')

    if (resolved.exposeWeb) {
      const disposeWeb = registerKnowledgeWeb(
        httpRuntime,
        resolved.webPath,
        LOCAL_MANAGEMENT_API_PREFIX,
        'same-origin',
        managementEmbedToken,
      )
      httpRuntime.effect(() => disposeWeb, 'dsh-knowledge.web')
    }

    applyPublicApiRoute(publicApiEnabled)
    httpRuntime.effect(() => () => { disposePublicApi?.() }, 'dsh-knowledge.public-api')

    const disposeControl = registerKnowledgeControl(httpRuntime, {
      current: () => activeConnection,
      canSwitchRemote: () => !publicApiEnabled,
      writable: resolved.connectionPath !== undefined,
      managementAvailable: () => resolved.exposeWeb && (activeConnection.backend === 'remote' || managementProvider !== undefined),
      ...resolved.exposeWeb
        ? { managementPath: `${resolved.webPath}?embed=${encodeURIComponent(managementEmbedToken)}` }
        : {},
      update: updateConnection,
    })
    httpRuntime.effect(() => disposeControl, 'dsh-knowledge.connection-control')

    const disposeWritebackStatus = httpRuntime.webServer?.register({
      kind: 'exact',
      path: '/knowledge-control/v1/writeback-status',
      async handler(req, res) {
        try {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST' }).end()
            return
          }
          assertKnowledgeBrowserRequest(req, 'conversation-web')
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')?.trim()
          const turn = Number(url.searchParams.get('turn'))
          if (!sessionId || !Number.isInteger(turn) || turn < 0) throw connectionError(400, 'sessionId and a non-negative integer turn are required')
          const key = `${sessionId}:${turn}`
          let state = writebackStatuses.get(key)
          if (req.method === 'POST') {
            const source = writebackSources.get(key)
            if (state?.status !== 'failed' || !state.retryable || source === undefined) {
              throw connectionError(409, 'writeback is not retryable')
            }
            writebackStatuses.set(key, { status: 'running', summary: '知识库回写 · 正在重试', retryable: false })
            try {
              await provider.resetExtraction(key)
              state = await runWriteback(source.agent, source.turn, new AbortController().signal)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              state = { status: 'failed', summary: '知识库回写 · 重试失败', error: message, retryable: true }
              writebackStatuses.set(key, state)
            }
          }
          res.writeHead(state === undefined ? 404 : 200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          }).end(JSON.stringify(state === undefined ? { status: 'missing' } : state))
        } catch (error) {
          sendControlError(res, error)
        }
      },
    })
    if (disposeWritebackStatus !== undefined) httpRuntime.effect(() => disposeWritebackStatus, 'dsh-knowledge.writeback-status')
    const disposeModelCatalog = httpRuntime.webServer?.register({
      kind: 'exact', path: '/knowledge-control/v1/models',
      async handler(req, res) {
        try {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          assertKnowledgeBrowserRequest(req, 'management-web')
          const providers = await Promise.all(runtime.llm.listProviders().map(async provider => ({
            ...provider, models: await runtime.llm.listModels(provider.id).catch(() => []),
          })))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ providers }))
        } catch (error) {
          sendControlError(res, error)
        }
      },
    })
    if (disposeModelCatalog !== undefined) httpRuntime.effect(() => disposeModelCatalog, 'dsh-knowledge.model-catalog')
  }

  if (runtime.inject !== undefined) {
    runtime.inject(['webServer'], registerHttpSurfaces)
  } else if (runtime.webServer !== undefined) {
    registerHttpSurfaces(runtime)
  } else {
    runtime.logger.warn('dsh-knowledge: webServer is unavailable; management and connection settings are disabled')
  }

  if (resolved.extractionEnabled) {
    runWriteback = async (agent: AgentLike, turn: number, signal: AbortSignal): Promise<WritebackStatus> => {
      const key = `${agent.session.id}:${turn}`
      writebackStatuses.set(key, { status: 'running', summary: '知识库回写 · 正在重试', retryable: false })
      let state: WritebackStatus
      try {
        const result = await coordinator.run(agent.session, turn, signal)
        let summary: string
        if (result.status === 'duplicate') {
          const job = await provider.extractionJob(key, signal)
          if (job?.status === 'failed') throw new Error(job.lastError ?? '知识库回写失败')
          summary = '知识库回写 · 已处理'
        } else if (result.status === 'unmounted') summary = '知识库回写 · 未挂载可写知识库'
        else if (result.status === 'skipped') summary = '知识库回写 · 当前回答无可提取内容'
        else if (result.candidateCount === 0) summary = '知识库回写 · 无需收录'
        else summary = `知识库回写 · ${result.bases.map(base => {
          const parts = [base.directCount > 0 ? `直写 ${base.directCount}` : '', base.auditCount > 0 ? `待审 ${base.auditCount}` : ''].filter(Boolean)
          return `${base.name}：${parts.join('、')}`
        }).join('；')}`
        state = { status: 'completed', summary, retryable: false }
        writebackSources.delete(key)
      } catch (error) {
        if (signal.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        runtime.logger.warn(`dsh-knowledge: synchronous writeback failed: ${message}`)
        const job = await provider.extractionJob(key).catch(() => undefined)
        const retryable = job?.status === 'failed'
        const summary = message.includes('max-tokens')
          ? '知识库回写 · 失败：提取结果超过模型输出上限'
          : '知识库回写 · 失败'
        state = { status: 'failed', summary, error: message, retryable }
        if (retryable) writebackSources.set(key, { agent: snapshotAgent(agent), turn })
        else writebackSources.delete(key)
      }
      writebackStatuses.set(key, state)
      if (writebackStatuses.size > 1000) {
        const oldest = writebackStatuses.keys().next().value as string
        writebackStatuses.delete(oldest)
        writebackSources.delete(oldest)
      }
      runtime.logger.info(`dsh-knowledge: ${state.summary}`)
      return state
    }
    runtime.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      await runWriteback(agent, turn, signal).catch(() => {})
    })
  }

  runtime.effect(() => async () => {
    await coordinator.close()
    await providerRouter.close()
    await managementProvider?.close()
  }, 'dsh-knowledge.close')

  runtime.logger.info(`dsh-knowledge: ${provider.mode} provider ready`)
}

function snapshotAgent(agent: AgentLike): AgentLike {
  return {
    session: {
      id: agent.session.id,
      header: { ...agent.session.header },
      events: [...agent.session.events],
    },
  }
}

function publicConnectionError(error: unknown): Error {
  if (error instanceof RemoteProviderError) {
    if (error.status === 401) return connectionError(400, '客户端令牌无效或已被撤销。')
    if (error.status === 403) return connectionError(400, '客户端令牌没有读取该知识库的权限。')
    if (error.status === 404) return connectionError(400, '服务器地址不是有效的知识库 API 地址。')
    if (error.status === 0) return connectionError(400, '无法连接远程知识库，请检查地址、网络和证书。')
    return connectionError(400, `远程知识库验证失败（HTTP ${error.status}）。`)
  }
  if (error instanceof Error && typeof (error as Error & { status?: unknown }).status === 'number') return error
  if (error instanceof Error) {
    if (/server URL and client token|24 characters/i.test(error.message)) return connectionError(400, '首次连接需要填写至少 24 个字符的客户端令牌。')
    if (/HTTPS/i.test(error.message)) return connectionError(400, '远程知识库必须使用 HTTPS。')
    if (/timeout/i.test(error.message)) return connectionError(400, '请求超时时间不正确。')
    if (/databasePath/i.test(error.message)) return connectionError(409, '当前 DSH 没有可用的本地知识库。')
  }
  return error instanceof Error ? error : new Error(String(error))
}

function connectionError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

function sendControlError(res: { writeHead(status: number, headers?: Record<string, string>): { end(body?: string): void } }, error: unknown): void {
  const status = error instanceof Error && typeof (error as Error & { status?: unknown }).status === 'number'
    ? (error as Error & { status: number }).status
    : 500
  const message = status >= 500 ? 'internal knowledge control error' : error instanceof Error ? error.message : String(error)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }).end(JSON.stringify({ error: message }))
}
