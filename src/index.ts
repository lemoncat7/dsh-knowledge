import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { LOCAL_MANAGEMENT_API_PREFIX, registerKnowledgeApi } from './api.js'
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
import { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'
import type { RuntimeContextLike } from './runtime.js'
import { loadServiceSettings, serviceSettingsPath, storeServiceSettings } from './service-settings.js'
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
  try {
    const storedService = loadServiceSettings(persistedServicePath)
    if (storedService !== undefined) publicApiEnabled = storedService.publicApiEnabled
  } catch (error) {
    runtime.logger.warn(`dsh-knowledge: ignored invalid service settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (resolved.backend === 'remote') publicApiEnabled = false
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

  const coordinator = new ExtractionCoordinator(runtime, provider, resolved)
  const writebackStatuses = new Map<string, string>()
  const handleCodec = new KnowledgeHandleCodec(randomBytes(32))
  const managementEmbedToken = randomBytes(32).toString('base64url')
  registerKnowledgeRecall(runtime, provider, resolved, handleCodec)
  registerKnowledgeCatalog(runtime, provider, resolved)
  registerKnowledgeTools(runtime, provider, handleCodec)

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
      try {
        if (next.backend === 'remote') await candidate.stats()
        await storeConnection(resolved.connectionPath, next)
        persisted = true
        await providerRouter.replace(candidate)
        activeConnection = next
        refreshManagementApi()
        runtime.logger.info(`dsh-knowledge: verified and switched to ${next.backend} provider`)
        return activeConnection
      } catch (error) {
        await candidate.close().catch(() => {})
        if (persisted) {
          await storeConnection(resolved.connectionPath, activeConnection).catch(rollbackError => {
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
    const publicApiView = () => ({ publicApiEnabled, publicApiPrefix: resolved.apiPrefix })
    const applyPublicApiRoute = (enabled: boolean): void => {
      disposePublicApi?.()
      disposePublicApi = undefined
      if (enabled) {
        if (managementProvider === undefined) throw connectionError(409, '当前 DSH 没有可供远程访问的本地知识库。')
        disposePublicApi = registerKnowledgeApi(httpRuntime, managementProvider, resolved.apiPrefix)
      }
    }
    const updatePublicApi = async (enabled: boolean): Promise<ReturnType<typeof publicApiView>> => {
      if (enabled === publicApiEnabled) return publicApiView()
      if (enabled && activeConnection.backend !== 'local') throw connectionError(409, '请先把知识库来源切换为本地，再开启远程 API。')
      if (persistedServicePath === undefined) throw connectionError(409, '当前插件没有配置持久化路径，无法保存远程 API 状态。')
      const previous = publicApiEnabled
      applyPublicApiRoute(enabled)
      publicApiEnabled = enabled
      try {
        await storeServiceSettings(persistedServicePath, { publicApiEnabled })
      } catch (error) {
        publicApiEnabled = previous
        applyPublicApiRoute(previous)
        throw error
      }
      runtime.logger.info(`dsh-knowledge: public API ${enabled ? 'enabled' : 'disabled'} at ${resolved.apiPrefix}`)
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
        disposeManagementApi = registerRemoteManagementProxy(httpRuntime, LOCAL_MANAGEMENT_API_PREFIX, () => activeConnection)
      } else if (managementProvider !== undefined) {
        disposeManagementApi = registerKnowledgeApi(httpRuntime, managementProvider, LOCAL_MANAGEMENT_API_PREFIX, {
          authMode: 'same-origin',
          service: { current: publicApiView, update: updatePublicApi },
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
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' }).end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const key = `${url.searchParams.get('sessionId') ?? ''}:${url.searchParams.get('turn') ?? ''}`
        const summary = writebackStatuses.get(key)
        res.writeHead(summary === undefined ? 404 : 200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        }).end(JSON.stringify(summary === undefined ? { status: 'missing' } : { status: 'completed', summary }))
      },
    })
    if (disposeWritebackStatus !== undefined) httpRuntime.effect(() => disposeWritebackStatus, 'dsh-knowledge.writeback-status')
  }

  if (runtime.inject !== undefined) {
    runtime.inject(['webServer'], registerHttpSurfaces)
  } else if (runtime.webServer !== undefined) {
    registerHttpSurfaces(runtime)
  } else {
    runtime.logger.warn('dsh-knowledge: webServer is unavailable; management and connection settings are disabled')
  }

  if (resolved.extractionEnabled) {
    runtime.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
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
      writebackStatuses.set(`${agent.session.id}:${turn}`, summary)
      if (writebackStatuses.size > 1000) writebackStatuses.delete(writebackStatuses.keys().next().value as string)
      runtime.logger.info(`dsh-knowledge: ${summary}`)
    })
  }

  runtime.effect(() => async () => {
    await coordinator.close()
    await providerRouter.close()
    await managementProvider?.close()
  }, 'dsh-knowledge.close')

  runtime.logger.info(`dsh-knowledge: ${provider.mode} provider ready`)
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
