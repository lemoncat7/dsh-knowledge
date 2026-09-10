import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { assertKnowledgeBrowserRequest, LOCAL_MANAGEMENT_API_PREFIX, registerKnowledgeApi } from './api.js'
import { registerKnowledgeActivityControl } from './activity-control.js'
import { registerWritebackControl } from './writeback/control.js'
import { registerWritebackLive } from './writeback/live-control.js'
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
import type { ExtractionJobRecord } from './domain.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import { registerRemoteManagementProxy } from './management-proxy.js'
import type { KnowledgeProvider } from './provider.js'
import { KnowledgeProviderRouter } from './provider-router.js'
import { registerKnowledgeCatalog, registerKnowledgeRecall } from './recall.js'
import { KnowledgeHandleCodec } from './retrieval.js'
import { KnowledgeNoteHandleCodec } from './note-reference-handle.js'
import { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'
import type { RuntimeContextLike } from './runtime.js'
import { loadServiceSettings, serviceSettingsPath, storeServiceSettings, type KnowledgeServiceSettings } from './service-settings.js'
import { registerKnowledgeTools } from './tools.js'
import { createKnowledgeTrackingService, KNOWLEDGE_TRACKING_SERVICE } from './tracking.js'
import { createKnowledgeMountManagement, KNOWLEDGE_MOUNT_MANAGEMENT_SERVICE } from './mount-management.js'
import { createNoteRecording } from './note-recording.js'
import { registerKnowledgeWeb } from './web.js'
import { WritebackQueue, WritebackDeferred, type WritebackStatus, type WritebackWork } from './writeback/queue.js'

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
  const trustedShareOrigins = [...resolved.trustedShareOrigins]
  const trust = runtime.get('remoteSettingsTrust') as { origins?: readonly string[]; subscribe?(listener: () => void): () => void } | undefined
  if (trust !== undefined) {
    const sync = (): void => {
      const merged = new Set([...resolved.trustedShareOrigins, ...(trust.origins ?? [])])
      trustedShareOrigins.splice(0, trustedShareOrigins.length, ...merged)
    }
    sync()
    if (typeof trust.subscribe === 'function') runtime.effect(() => trust.subscribe!(sync), 'dsh-knowledge: trusted share origin synchronization')
  }
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
  const managementProvider = resolved.databasePath === undefined || resolved.databasePath.trim().length === 0
    ? undefined
    : new LocalKnowledgeProvider(resolved.databasePath)
  const connectionProvider = (settings: KnowledgeConnectionSettings): { provider: KnowledgeProvider; owned: boolean } => {
    if (settings.backend === 'local' && managementProvider !== undefined) {
      return { provider: managementProvider, owned: false }
    }
    return { provider: createConnectionProvider(resolved, settings, publicApiEnabled), owned: true }
  }
  const initial = connectionProvider(initialConnection)
  const providerRouter = new KnowledgeProviderRouter(initial.provider, { owned: initial.owned })
  const provider: KnowledgeProvider = providerRouter.provider
  let activeConnection = initialConnection
  let connectionChanging = false

  const coordinator = new ExtractionCoordinator(runtime, provider, resolved, () => (
    clientSettings.writebackProvider && clientSettings.writebackModel
      ? { provider: clientSettings.writebackProvider, model: clientSettings.writebackModel }
      : undefined
  ))
  const writebackStatuses = new Map<string, WritebackStatus>()
  const writebackSources = new Map<string, WritebackWork>()
  const destination = (): string => activeConnection.backend === 'local' ? `local:${resolved.databasePath}` : `remote:${activeConnection.remoteUrl}`
  const writebackQueue = resolved.extractionEnabled ? new WritebackQueue(resolved.writebackQueuePath!, async (work, checkpoint, signal) => {
    if (connectionChanging) throw new WritebackDeferred('知识库连接正在切换，等待稳定后回写')
    if (work.destination !== destination()) throw new Error('知识库连接已切换，旧回写仍绑定原目标；请恢复原连接后重试')
    const existing = await provider.extractionJob(work.snapshot.sourceKey, signal)
    if (existing?.status === 'completed') return statusFromExtractionJob(existing, false)
    if (existing?.status === 'failed' && existing.attempts >= 3) await provider.resetExtraction(work.snapshot.sourceKey, signal)
    const result = await coordinator.runSnapshot(work.snapshot, signal, checkpoint)
    if (result.status !== 'duplicate') return statusFromExtractionResult(result)
    const job = await provider.extractionJob(work.snapshot.sourceKey, signal)
    if (job?.status === 'completed') return statusFromExtractionJob(job, false)
    if (job?.status === 'running') throw new WritebackDeferred('上一次远端回写租约尚未释放，等待恢复')
    throw new Error(job?.lastError ?? '未能确认远端回写状态，请重试')
  }, message => runtime.logger.warn(message)) : undefined
  const handleCodec = new KnowledgeHandleCodec(randomBytes(32))
  const noteHandleCodec = new KnowledgeNoteHandleCodec(randomBytes(32))
  const managementEmbedToken = randomBytes(32).toString('base64url')
  registerKnowledgeRecall(runtime, provider, resolved, handleCodec)
  registerKnowledgeCatalog(runtime, provider, resolved)
  registerKnowledgeTools(runtime, provider, handleCodec, noteHandleCodec)
  runtime.provide?.(KNOWLEDGE_TRACKING_SERVICE, createKnowledgeTrackingService(provider))
  runtime.provide?.(KNOWLEDGE_MOUNT_MANAGEMENT_SERVICE, createKnowledgeMountManagement(provider, () => providerRouter.revision))
  runtime.provide?.('dshKnowledgeNoteRecording', createNoteRecording(provider))

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
      if (writebackQueue?.isRunning) throw connectionError(409, '回写正在执行，请完成后再切换知识库连接')
      if (resolved.connectionPath === undefined) throw connectionError(409, '当前插件没有配置持久化路径，无法保存连接。')
      const candidate = connectionProvider(next)
      connectionChanging = true
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
        if (next.backend === 'remote') await candidate.provider.stats()
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
        await providerRouter.replace(candidate.provider, { owned: candidate.owned })
        installed = true
        runtime.logger.info(`dsh-knowledge: verified and switched to ${next.backend} provider`)
        return activeConnection
      } catch (error) {
        if (installed) return next
        if (candidate.owned) await candidate.provider.close().catch(() => {})
        activeConnection = previous
        if (managementRouteChanged) restoreManagementApi()
        if (persisted) {
          await storeConnection(resolved.connectionPath, previous).catch(rollbackError => {
            runtime.logger.error(`dsh-knowledge: failed to restore connection settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
          })
        }
        throw error
      } finally { connectionChanging = false }
    })
    const operation = pending.catch(error => {
      runtime.logger.warn(`dsh-knowledge: connection switch rejected: ${error instanceof Error ? error.message : String(error)}`)
      throw publicConnectionError(error)
    })
    switching = operation.catch(() => {})
    return operation
  }

  const registerHttpSurfaces = (httpRuntime: RuntimeContextLike): void => {
    const disposeActivityControl = registerKnowledgeActivityControl(httpRuntime, provider)
    httpRuntime.effect(() => disposeActivityControl, 'dsh-knowledge.activity-control')
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
        disposePublicApi = registerKnowledgeApi(httpRuntime, managementProvider, resolved.apiPrefix, {
          shareRequestPolicy: () => ({ trustedPrivateOrigins: trustedShareOrigins }),
        })
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
          shareRequestPolicy: () => ({ trustedPrivateOrigins: trustedShareOrigins }),
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

    const disposeWritebackControl = registerWritebackControl(httpRuntime, writebackQueue)
    const disposeWritebackLive = registerWritebackLive(httpRuntime, writebackQueue)
    if (disposeWritebackLive) httpRuntime.effect(() => disposeWritebackLive, 'dsh-knowledge.writeback-live')
    if (disposeWritebackControl) httpRuntime.effect(() => disposeWritebackControl, 'dsh-knowledge.writeback-control')
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
          let state = writebackQueue?.status(key) ?? writebackStatuses.get(key)
          if (state === undefined) {
            // Transport failure is not authoritative absence. Return an error so
            // clients retain their last known state with a disconnected warning.
            const job = await provider.extractionJob(key)
            state = job === undefined ? undefined : statusFromExtractionJob(job, false)
            if (state && job?.status !== 'completed') {
              state = { ...state, summary: `${state.summary}（历史服务端记录；本客户端无恢复快照，请到发起回写的客户端核对）` }
            }
          }
          if (req.method === 'POST') {
            if (!writebackQueue) throw connectionError(409, '知识库回写已停用')
            const source = writebackSources.get(key)
            state = source ? writebackQueue.enqueue(source) : writebackQueue.retry(key)
            writebackSources.delete(key)
            writebackStatuses.delete(key)
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
    runtime.on('agent/turn-stopping', ({ agent, turn }) => {
      const key = `${agent.session.id}:${turn}`
      let work: WritebackWork | undefined
      try {
        const snapshot = coordinator.capture(agent.session, turn)
        if (snapshot) work = { snapshot, destination: destination() }
        if (work) writebackQueue!.enqueue(work)
        else writebackQueue!.completeEmpty(key, agent.session.id)
        writebackStatuses.delete(key)
        writebackSources.delete(key)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Disk/queue failures are explicit; never pretend an unsaved job succeeded.
        rememberWritebackStatus(writebackStatuses, writebackSources, key, {
          status: 'failed', summary: '知识库回写 · 未能可靠入队', error: message, retryable: work !== undefined,
        })
        if (work) writebackSources.set(key, work)
        runtime.logger.warn(`dsh-knowledge: writeback enqueue failed: ${message}`)
      }
    })
    writebackQueue?.start()
  }

  runtime.effect(() => async () => {
    await writebackQueue?.close()
    await coordinator.close()
    await providerRouter.close()
    await managementProvider?.close()
  }, 'dsh-knowledge.close')

  runtime.logger.info(`dsh-knowledge: ${provider.mode} provider ready`)
}

function statusFromExtractionResult(result: Awaited<ReturnType<ExtractionCoordinator['run']>>): WritebackStatus {
  if (result.status === 'unmounted') return { status: 'completed', summary: '知识库回写 · 未挂载可写知识库', retryable: false }
  if (result.status === 'skipped') return { status: 'completed', summary: '知识库回写 · 当前回答无可提取内容', retryable: false }
  if (result.status === 'duplicate') return { status: 'completed', summary: '知识库回写 · 已处理', retryable: false }
  if (result.candidateCount === 0) return { status: 'completed', summary: '知识库回写 · 无需收录', retryable: false }
  return {
    status: 'completed',
    summary: summarizeWritebackCounts(result.bases),
    retryable: false,
    destinations: result.destinations,
  }
}

function statusFromExtractionJob(job: ExtractionJobRecord, retryable: boolean): WritebackStatus {
  if (job.status === 'running') return { status: 'running', summary: '知识库回写 · 正在处理', retryable: false }
  if (job.status === 'failed') return {
    status: 'failed', summary: '知识库回写 · 失败', error: job.lastError ?? '知识库回写失败', retryable,
  }
  const completion = job.completion
  if (completion === undefined) return {
    status: 'completed', summary: job.candidateCount > 0 ? `知识库回写 · 已处理 ${job.candidateCount} 项` : '知识库回写 · 无需收录', retryable: false,
  }
  if (completion.outcome === 'unmounted') return { status: 'completed', summary: '知识库回写 · 未挂载可写知识库', retryable: false }
  if (completion.outcome === 'skipped') return { status: 'completed', summary: '知识库回写 · 当前回答无可提取内容', retryable: false }
  if (completion.candidateCount === 0) return { status: 'completed', summary: '知识库回写 · 无需收录', retryable: false }
  const grouped = new Map<string, { name: string; directCount: number; auditCount: number }>()
  for (const destination of completion.destinations) {
    const current = grouped.get(destination.knowledgeBaseId) ?? {
      name: destination.knowledgeBaseName, directCount: 0, auditCount: 0,
    }
    if (destination.disposition === 'written') current.directCount += 1
    else current.auditCount += 1
    grouped.set(destination.knowledgeBaseId, current)
  }
  return {
    status: 'completed',
    summary: grouped.size === 0
      ? `知识库回写 · 已处理 ${completion.candidateCount} 项`
      : summarizeWritebackCounts([...grouped.values()]),
    retryable: false,
    destinations: completion.destinations,
  }
}

function summarizeWritebackCounts(bases: Array<{ name: string; directCount: number; auditCount: number }>): string {
  return `知识库回写 · ${bases.map(base => {
    const parts = [base.directCount > 0 ? `直写 ${base.directCount}` : '', base.auditCount > 0 ? `待审 ${base.auditCount}` : ''].filter(Boolean)
    return `${base.name}：${parts.join('、')}`
  }).join('；')}`
}

function rememberWritebackStatus(
  statuses: Map<string, WritebackStatus>,
  sources: Map<string, WritebackWork>,
  key: string,
  state: WritebackStatus,
): void {
  statuses.set(key, state)
  while (statuses.size > 1000) {
    const oldest = statuses.keys().next().value as string | undefined
    if (oldest === undefined) break
    statuses.delete(oldest)
    sources.delete(oldest)
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
