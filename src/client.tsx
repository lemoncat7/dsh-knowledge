import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { activatePluginWorkspace, observePluginWorkspace } from './workspace-ownership.js'
import {
  IconChevronLeftOutline14, IconDataOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { knowledgeDesignCss } from './design-tokens.js'
import { availableActivitySession } from './knowledge-activity-state.js'
import cssText from './client.css'
import activityCss from './knowledge-activity.css'
import { createKnowledgeActivityController, type KnowledgeActivityController } from './knowledge-activity-controller.js'
import { KNOWLEDGE_SETTINGS_NAMESPACE } from './constants.js'
import {
  createKnowledgeHostTheme,
  KNOWLEDGE_THEME_PROTOCOL_VERSION,
  KNOWLEDGE_THEME_READY_MESSAGE,
  type ThemeSnapshotLike,
} from './theme-bridge.js'

const PLUGIN_ID = '@lemoncat7/dsh-knowledge'
const STYLE_ID = `${PLUGIN_ID}/client`
const COMPACT_KNOWLEDGE_VIEWPORT = '(max-width: 1120px), (hover: none) and (pointer: coarse) and (max-width: 1400px)'

type SidebarActionProps = PropsRuntime<'sidebar.footer.action'>
type ConversationSlotProps = PropsRuntime<'conversation'>

interface KnowledgeConnectionView {
  backend: 'local' | 'remote'
  remoteUrl?: string
  remoteTimeoutMs: number
  tokenConfigured: boolean
  canSwitchRemote: boolean
  writable: boolean
  managementAvailable: boolean
  managementPath?: string
}

export interface KnowledgeWorkspaceController {
  isOpen(): boolean
  open(): void
  toggle(): void
  openDocument(target: KnowledgeDocumentTarget): void
  currentTarget(): KnowledgeDocumentTarget | undefined
  close(): void
  subscribe(listener: () => void): () => void
}

export type KnowledgeDocumentTarget =
  | { view?: 'entries'; knowledgeBaseId: string; documentId: string }
  | { view: 'notes'; noteId?: string }

interface WritebackDestinationView {
  knowledgeBaseId: string
  knowledgeBaseName: string
  documentId?: string
  documentTitle: string
  documentPath?: string
  disposition: 'written' | 'pending-review'
}

interface WritebackStatusView {
  status: 'running' | 'completed' | 'failed'
  summary: string
  error?: string
  retryable: boolean
  destinations?: WritebackDestinationView[]
}

const CONNECTION_CONTROL_PATH = '/knowledge-control/v1/connection'
let cachedConnectionView: KnowledgeConnectionView | undefined

/** Cordis services needed by the browser half. */
export const inject = ['slots', 'theme', 'layout', 'sessions']

/** Register the knowledge launcher in the sidebar's official extension slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-knowledge: client styles')
  let activity: KnowledgeActivityController | undefined
  const workspace = createKnowledgeWorkspaceController(ctx, () => activity?.close())
  activity = createKnowledgeActivityController(ctx, {
    beforeOpen: () => { workspace.close(); activatePluginWorkspace(PLUGIN_ID) },
    openWorkspace: target => { if (target === undefined) workspace.open(); else workspace.openDocument(target) },
  })
  ctx.effect(() => observePluginWorkspace(PLUGIN_ID, () => { workspace.close(); activity?.close() }), 'dsh-knowledge: exclusive workspace')
  ctx.effect(() => () => { workspace.close(); activity?.dispose() }, 'dsh-knowledge: workspace lifecycle')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'knowledge',
    order: -10,
  }, props => <KnowledgeLauncher {...props} workspace={workspace} activity={activity!} />))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: KNOWLEDGE_SETTINGS_NAMESPACE,
  }, KnowledgeConnectionCard))

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    select: owner => ({ turn: owner.turn.turn }),
  }, props => <KnowledgeWritebackStatus sessionId={String(props.sessionId)} turn={props.matched.turn} workspace={workspace} />))
}

function KnowledgeWritebackStatus({
  sessionId,
  turn,
  workspace,
}: { sessionId: string; turn: number; workspace: KnowledgeWorkspaceController }) {
  const [state, setState] = useState<WritebackStatusView>()
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let missingAttempts = 0
    const schedule = (delay: number): void => {
      if (!controller.signal.aborted) timer = setTimeout(() => { void load() }, delay)
    }
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/knowledge-control/v1/writeback-status?sessionId=${encodeURIComponent(sessionId)}&turn=${turn}`, {
          headers: { accept: 'application/json', 'x-dsh-knowledge-client': 'conversation-web' }, signal: controller.signal,
        })
        if (response.ok) {
          const value = await response.json() as WritebackStatusView
          if (value.summary) setState(value)
          if (value.status === 'running') schedule(1_500)
          return
        }
        if (response.status === 404 && missingAttempts < 3) {
          missingAttempts += 1
          schedule(1_500)
        }
      } catch {
        if (!controller.signal.aborted && missingAttempts < 3) {
          missingAttempts += 1
          schedule(2_000)
        }
      }
    }
    void load()
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [sessionId, turn])
  if (state === undefined) return null
  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      const response = await fetch(`/knowledge-control/v1/writeback-status?sessionId=${encodeURIComponent(sessionId)}&turn=${turn}`, {
        method: 'POST', headers: { accept: 'application/json', 'x-dsh-knowledge-client': 'conversation-web' },
      })
      const body = await response.json().catch(() => ({})) as WritebackStatusView & { error?: string }
      if (!response.ok) throw new Error(body.error ?? `retry failed with HTTP ${response.status}`)
      setState(body)
    } catch (error) {
      setState(previous => previous === undefined ? previous : {
        ...previous, error: error instanceof Error ? error.message : String(error), retryable: true,
      })
    } finally { setRetrying(false) }
  }
  const destinations = state.destinations ?? []
  const summary = state.summary.replace(/^知识库回写\s*·\s*/u, '')
  return <div className="dsh-knowledge-writeback-notice" data-status={state.status}>
    <div className="dsh-knowledge-writeback-summary" role={state.status === 'running' ? 'status' : undefined} aria-atomic="true">
      <span>知识库回写</span><strong>@lemoncat7/dsh-knowledge</strong><span title={state.error}>{summary}</span>
      {state.status === 'failed' && state.retryable && <button type="button" disabled={retrying} onClick={() => { void retry() }}>{retrying ? '重试中…' : '重试'}</button>}
    </div>
    {destinations.length > 0 && <ul className="dsh-knowledge-writeback-destinations" aria-label="回写目标">
      {destinations.map((destination, index) => <li key={`${destination.knowledgeBaseId}:${destination.documentId ?? destination.documentTitle}:${index}`}>
        <span className="dsh-knowledge-writeback-base">{destination.knowledgeBaseName}</span>
        <span className="dsh-knowledge-writeback-separator" aria-hidden="true">/</span>
        {destination.documentId
          ? <button
            type="button"
            className="dsh-knowledge-writeback-document"
            title={`打开 ${destination.documentPath ?? destination.documentTitle}`}
            aria-label={`在知识库中打开 ${destination.documentTitle}`}
            onClick={() => { workspace.openDocument({ knowledgeBaseId: destination.knowledgeBaseId, documentId: destination.documentId! }) }}
          ><strong>{destination.documentPath ?? destination.documentTitle}</strong></button>
          : <strong title={destination.documentTitle}>{`拟新建：${destination.documentTitle}`}</strong>}
        <small data-disposition={destination.disposition}>{destination.disposition === 'written' ? '已写入' : '待审核'}</small>
      </li>)}
    </ul>}
    {state.status === 'failed' && state.error && <p className="dsh-knowledge-writeback-error" role="alert">{state.error}</p>}
  </div>
}

function createKnowledgeWorkspaceController(client: ClientContext, beforeOpen: () => void): KnowledgeWorkspaceController {
  const listeners = new Set<() => void>()
  let disposeWorkspace: (() => void) | undefined
  let target: KnowledgeDocumentTarget | undefined
  const notify = (): void => { for (const listener of listeners) listener() }
  const close = (): void => {
    if (disposeWorkspace === undefined) return
    const dispose = disposeWorkspace
    disposeWorkspace = undefined
    dispose()
    notify()
  }
  let controller: KnowledgeWorkspaceController
  const open = (): void => {
    if (disposeWorkspace !== undefined) return
    beforeOpen()
    activatePluginWorkspace(PLUGIN_ID)
    disposeWorkspace = client.slots.register({ name: 'conversation', priority: -1 }, props => (
      <KnowledgeWorkspace {...props} client={client} workspace={controller} />
    ))
  }
  controller = {
    isOpen: () => disposeWorkspace !== undefined,
    open: () => { target = undefined; open(); notify() },
    toggle: () => {
      if (disposeWorkspace !== undefined) return close()
      target = undefined
      open()
      notify()
    },
    openDocument: nextTarget => {
      target = nextTarget
      open()
      notify()
    },
    currentTarget: () => target,
    close,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return controller
}

function KnowledgeConnectionCard() {
  const [current, setCurrent] = useState<KnowledgeConnectionView>()
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [open, setOpen] = useState(false)
  const [backend, setBackend] = useState<'local' | 'remote'>('local')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteToken, setRemoteToken] = useState('')
  const [timeout, setTimeoutValue] = useState('10000')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string }>()

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoadState('loading')
    setLoadError('')
    try {
      const value = await requestConnection('GET', undefined, signal)
      setCurrent(value)
      setLoadState('ready')
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(connectionErrorMessage(error))
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  useEffect(() => {
    if (dirty || current === undefined) return
    setBackend(current.backend)
    setRemoteUrl(current.remoteUrl ?? '')
    setTimeoutValue(String(current.remoteTimeoutMs ?? 10000))
  }, [current, dirty])

  const timeoutNumber = Number(timeout)
  const urlError = backend === 'remote' ? validateRemoteUrl(remoteUrl) : undefined
  const tokenError = backend === 'remote' && !current?.tokenConfigured && remoteToken.trim().length === 0
    ? '首次连接必须填写客户端令牌。'
    : remoteToken.length > 0 && remoteToken.trim().length < 24 ? '令牌至少需要 24 个字符。' : undefined
  const timeoutError = !Number.isInteger(timeoutNumber) || timeoutNumber < 100 || timeoutNumber > 120000
    ? '超时必须是 100 到 120000 毫秒之间的整数。'
    : undefined
  const invalid = urlError !== undefined || tokenError !== undefined || timeoutError !== undefined

  const edit = (action: () => void): void => {
    action()
    setDirty(true)
    setMessage(undefined)
  }
  const reset = (): void => {
    setBackend(current?.backend ?? 'local')
    setRemoteUrl(current?.remoteUrl ?? '')
    setRemoteToken('')
    setTimeoutValue(String(current?.remoteTimeoutMs ?? 10000))
    setDirty(false)
    setMessage(undefined)
  }
  const save = async (): Promise<void> => {
    if (!dirty || invalid || !current?.writable || saving) return
    setSaving(true)
    setMessage(undefined)
    try {
      const next = await requestConnection('PUT', {
        backend,
        remoteTimeoutMs: timeoutNumber,
        ...backend === 'remote' ? { remoteUrl: remoteUrl.trim() } : {},
        ...backend === 'remote' && remoteToken.trim().length > 0 ? { remoteToken: remoteToken.trim() } : {},
      })
      setCurrent(next)
      setRemoteToken('')
      setDirty(false)
      setMessage({
        kind: 'success',
        text: backend === 'remote' ? '已验证并切换至远程知识库。' : '已切换至本地知识库。',
      })
    } catch (error) {
      setMessage({ kind: 'error', text: connectionErrorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className={`dsh-knowledge-settings-card${open ? ' dsh-knowledge-settings-card--open' : ''}`}>
      <button type="button" className="dsh-knowledge-settings-header" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span><strong>知识库连接</strong><small>选择本机知识库，或连接一台中央 DSH 知识库</small></span>
        <span className="dsh-knowledge-settings-summary">{loadState === 'loading' ? '读取中' : loadState === 'error' ? '连接入口' : current?.backend === 'remote' ? '远程' : '本地'}<i aria-hidden="true" /></span>
      </button>
      {open && <div className="dsh-knowledge-settings-body">
        {loadState === 'loading' ? <p className="dsh-knowledge-settings-note" role="status">正在读取连接配置…</p>
          : loadState === 'error' ? <div className="dsh-knowledge-settings-load-error" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => { void load() }}>重新读取</button>
          </div> : <>
          <fieldset className="dsh-knowledge-source-picker">
            <legend>知识库来源</legend>
            <label className={backend === 'local' ? 'is-selected' : ''}>
              <input type="radio" name="dsh-knowledge-backend" checked={backend === 'local'} onChange={() => edit(() => { setBackend('local') })} />
              <span><strong>本地</strong><small>数据保存在当前 DSH 的 SQLite 中</small></span>
            </label>
            <label className={`${backend === 'remote' ? 'is-selected' : ''}${!current?.canSwitchRemote ? ' is-disabled' : ''}`}>
              <input type="radio" name="dsh-knowledge-backend" checked={backend === 'remote'} disabled={!current?.canSwitchRemote} onChange={() => edit(() => { setBackend('remote') })} />
              <span><strong>远程</strong><small>召回和回写统一使用中央知识库</small></span>
            </label>
          </fieldset>
          {!current?.canSwitchRemote && <p className="dsh-knowledge-settings-note">当前实例是中央知识库服务，不能再切换到另一台远程服务。</p>}
          {backend === 'remote' && <div className="dsh-knowledge-remote-fields">
            <label htmlFor="dsh-knowledge-remote-url">服务器地址
              <input id="dsh-knowledge-remote-url" type="url" value={remoteUrl} placeholder="https://example.com/knowledge-api/v1" autoComplete="url" onChange={event => edit(() => { setRemoteUrl(event.target.value) })} aria-invalid={urlError !== undefined} aria-describedby={urlError ? 'dsh-knowledge-url-error' : undefined} />
              {urlError && <small id="dsh-knowledge-url-error" className="dsh-knowledge-field-error">{urlError}</small>}
            </label>
            <label htmlFor="dsh-knowledge-remote-token">客户端令牌
              <input id="dsh-knowledge-remote-token" type="password" value={remoteToken} placeholder={current?.tokenConfigured ? '已保存；留空则保持不变' : '粘贴客户端令牌'} autoComplete="new-password" onChange={event => edit(() => { setRemoteToken(event.target.value) })} aria-invalid={tokenError !== undefined} aria-describedby="dsh-knowledge-token-help" />
              <small id="dsh-knowledge-token-help" className={tokenError ? 'dsh-knowledge-field-error' : undefined}>{tokenError ?? (current?.tokenConfigured ? '令牌已安全保存，页面无法读取；输入新令牌可覆盖。' : '令牌保存后不可读取，只能覆盖。')}</small>
            </label>
          </div>}
          <label className="dsh-knowledge-timeout-field" htmlFor="dsh-knowledge-timeout">请求超时（毫秒）
            <input id="dsh-knowledge-timeout" type="number" min="100" max="120000" step="100" value={timeout} onChange={event => edit(() => { setTimeoutValue(event.target.value) })} aria-invalid={timeoutError !== undefined} />
            {timeoutError && <small className="dsh-knowledge-field-error">{timeoutError}</small>}
          </label>
          {!current?.writable && <p className="dsh-knowledge-settings-note">当前插件没有配置持久化路径，无法保存连接。</p>}
          {message && <p className={`dsh-knowledge-settings-message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{message.text}</p>}
          <div className="dsh-knowledge-settings-actions">
            <button type="button" onClick={reset} disabled={!dirty || saving}>放弃更改</button>
            <button type="button" className="is-primary" onClick={() => { void save() }} disabled={!dirty || invalid || saving || !current?.writable}>{saving ? '正在验证…' : '验证并连接'}</button>
          </div>
        </>}
      </div>}
    </li>
  )
}

function validateRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return '远程知识库必须使用 HTTPS。'
    return undefined
  } catch { return '请输入完整的知识库 API 地址。' }
}

function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Failed to fetch')) return '无法访问插件连接接口，请确认插件服务已加载。'
  return message || '连接配置操作失败，请检查地址、令牌和 DSH 日志。'
}

async function requestConnection(
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<KnowledgeConnectionView> {
  const response = await fetch(CONNECTION_CONTROL_PATH, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    ...signal === undefined ? {} : { signal },
  })
  const payload = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const message = payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `连接接口返回 HTTP ${response.status}`
    throw new Error(message)
  }
  if (!isConnectionView(payload)) throw new Error('插件连接接口返回了无效数据。')
  cachedConnectionView = payload
  return payload
}

function isConnectionView(value: unknown): value is KnowledgeConnectionView {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<KnowledgeConnectionView>
  return (item.backend === 'local' || item.backend === 'remote')
    && Number.isInteger(item.remoteTimeoutMs)
    && typeof item.tokenConfigured === 'boolean'
    && typeof item.canSwitchRemote === 'boolean'
    && typeof item.writable === 'boolean'
    && typeof item.managementAvailable === 'boolean'
    && (!item.managementAvailable || isManagementPath(item.managementPath))
}

function isManagementPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

function KnowledgeLauncher({ wide, useSessions, workspace, activity }: SidebarActionProps & { workspace: KnowledgeWorkspaceController; activity: KnowledgeActivityController }) {
  const [open, setOpen] = useState(workspace.isOpen())
  const currentSessionId = useSessions(availableActivitySession)
  const [activityOpen, setActivityOpen] = useState(currentSessionId === undefined ? false : activity.isOpen(currentSessionId))
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia(COMPACT_KNOWLEDGE_VIEWPORT).matches)

  useEffect(() => workspace.subscribe(() => { setOpen(workspace.isOpen()) }), [workspace])
  useEffect(() => {
    const sync = (): void => {
      setActivityOpen(currentSessionId === undefined ? false : activity.isOpen(currentSessionId))
    }
    sync()
    return activity.subscribe(sync)
  }, [activity, currentSessionId])
  useEffect(() => {
    const query = window.matchMedia(COMPACT_KNOWLEDGE_VIEWPORT)
    const sync = (): void => { setCompactViewport(query.matches) }
    sync()
    query.addEventListener('change', sync)
    return () => { query.removeEventListener('change', sync) }
  }, [])

  const active = open || activityOpen
  const activate = (): void => {
    if (open) return workspace.close()
    if (compactViewport || currentSessionId === undefined) return workspace.open()
    if (currentSessionId !== undefined) activity.toggle(currentSessionId)
  }

  return (
    <button
      type="button"
      className={`dsh-knowledge-trigger${wide ? '' : ' dsh-knowledge-trigger--rail'}${active ? ' is-active' : ''}`}
      aria-label={active ? '返回对话' : compactViewport || currentSessionId === undefined ? '打开知识库工作区' : '展开会话知识库'}
      aria-pressed={active}
      title={wide ? undefined : active ? '返回对话' : '知识库'}
      onClick={activate}
    >
      <IconDataOutline16 size={wide ? 16 : 18} />
      {wide && <span>知识库</span>}
    </button>
  )
}

function KnowledgeWorkspace({
  sessionId,
  useSessions,
  client,
  workspace,
}: ConversationSlotProps & { client: ClientContext; workspace: KnowledgeWorkspaceController }) {
  const cachedManagementPath = cachedConnectionView?.managementAvailable ? cachedConnectionView.managementPath : undefined
  const [panelState, setPanelState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>(cachedConnectionView === undefined ? 'loading' : cachedManagementPath === undefined ? 'unavailable' : 'ready')
  const [managementPath, setManagementPath] = useState<string | undefined>(cachedManagementPath)
  const [panelError, setPanelError] = useState('')
  const [target, setTarget] = useState<KnowledgeDocumentTarget | undefined>(workspace.currentTarget())
  const projectId = useSessions((state: SessionListState) => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const knowledgeUrl = managementPath === undefined ? undefined : knowledgePanelUrl(managementPath, sessionId, projectId, target)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const themeFrame = useRef(0)

  const loadManagement = useCallback(async (background = false): Promise<void> => {
    if (!background) setPanelState('loading')
    setPanelError('')
    try {
      const connection = await requestConnection('GET')
      if (!connection.managementAvailable || connection.managementPath === undefined) {
        setManagementPath(undefined)
        setPanelState('unavailable')
        return
      }
      setManagementPath(connection.managementPath)
      setPanelState('ready')
    } catch (error) {
      setManagementPath(undefined)
      setPanelError(connectionErrorMessage(error))
      setPanelState('error')
    }
  }, [])

  useEffect(() => {
    void loadManagement(cachedConnectionView !== undefined)
  }, [loadManagement])

  useEffect(() => workspace.subscribe(() => { setTarget(workspace.currentTarget()) }), [workspace])

  const sendTheme = useCallback((): void => {
    const currentFrame = frame.current
    if (currentFrame === null) return
    const target = currentFrame.contentWindow
    if (target === null) return
    target.postMessage(
      createKnowledgeHostTheme(client.theme.getTheme()),
      frameOrigin(currentFrame) ?? '*',
    )
  }, [client])

  const scheduleTheme = useCallback((): void => {
    if (themeFrame.current !== 0) window.cancelAnimationFrame(themeFrame.current)
    themeFrame.current = window.requestAnimationFrame(() => {
      themeFrame.current = 0
      sendTheme()
    })
  }, [sendTheme])

  useEffect(() => {
    const off = client.on('theme/change', scheduleTheme)
    const onMessage = (event: MessageEvent): void => {
      const currentFrame = frame.current
      if (event.source !== currentFrame?.contentWindow) return
      const expectedOrigin = frameOrigin(currentFrame)
      if (expectedOrigin !== undefined && event.origin !== expectedOrigin) return
      const data = event.data as { type?: unknown; version?: unknown } | null
      if (data?.type === KNOWLEDGE_THEME_READY_MESSAGE && data.version === KNOWLEDGE_THEME_PROTOCOL_VERSION) sendTheme()
    }
    window.addEventListener('message', onMessage)
    scheduleTheme()
    return () => {
      off()
      window.removeEventListener('message', onMessage)
      if (themeFrame.current !== 0) window.cancelAnimationFrame(themeFrame.current)
    }
  }, [client, scheduleTheme, sendTheme])

  return (
    <section className="dsh-knowledge-workspace" data-knowledge-surface="workspace" aria-labelledby="dsh-knowledge-workspace-title">
      <header className="dsh-knowledge-workspace-header">
        <div>
          <button type="button" data-knowledge-workspace-close onClick={workspace.close} aria-label="返回会话" title="返回会话"><IconChevronLeftOutline14 size={15} /></button>
          <IconDataOutline16 size={18} />
          <span><h2 id="dsh-knowledge-workspace-title">知识库</h2><p>文档、审核、挂载与访问管理</p></span>
        </div>
      </header>
      {panelState === 'ready' && knowledgeUrl !== undefined
        ? <iframe ref={frame} className="dsh-knowledge-frame" src={knowledgeUrl} title="知识库管理台" onLoad={sendTheme} />
        : <div className="dsh-knowledge-panel-state" role={panelState === 'error' ? 'alert' : 'status'} aria-live="polite">
          <span className="dsh-knowledge-panel-state-icon" aria-hidden="true">{panelState === 'loading' ? '···' : panelState === 'error' ? '!' : '—'}</span>
          <div>
            <h3>{panelState === 'loading' ? '正在打开知识库…' : panelState === 'error' ? '暂时无法打开知识库' : '这台 DSH 未启用知识库管理台'}</h3>
            <p>{panelState === 'loading'
              ? '正在确认当前实例是否提供管理页面。'
              : panelState === 'error'
                ? panelError
                : '本地召回和回写仍可使用。当前 profile 已显式关闭 exposeWeb；重新启用后即可在这里管理。使用远程知识库时，请前往中央 DSH 的知识库管理台。'}</p>
            {panelState === 'error' && <button type="button" onClick={() => { void loadManagement() }}>重试</button>}
          </div>
        </div>}
    </section>
  )
}

function knowledgePanelUrl(managementPath: string, sessionId?: string, projectId?: string, target?: KnowledgeDocumentTarget): string {
  const params = new URLSearchParams()
  if (sessionId !== undefined) params.set('sessionId', sessionId)
  if (projectId !== undefined) params.set('projectId', projectId)
  if (target !== undefined) {
    if (target.view === 'notes') {
      params.set('view', 'notes')
      if (target.noteId !== undefined) params.set('noteId', target.noteId)
    } else {
      params.set('knowledgeBaseId', target.knowledgeBaseId)
      params.set('documentId', target.documentId)
    }
  }
  const query = params.toString()
  return query.length === 0 ? managementPath : `${managementPath}${managementPath.includes('?') ? '&' : '?'}${query}`
}

function frameOrigin(frame: HTMLIFrameElement): string | undefined {
  try {
    const origin = new URL(frame.src).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

function installStyles(): () => void {
  const previous = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  previous?.remove()
  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = STYLE_ID
  const scope = ':is(.dsh-knowledge-trigger, .dsh-knowledge-activity-panel, .dsh-knowledge-workspace, .dsh-knowledge-settings-card, .dsh-knowledge-writeback-notice)'
  style.textContent = knowledgeDesignCss(scope, 'body[data-ds-dark-theme] ' + scope, false) + cssText + activityCss
  document.head.appendChild(style)
  return () => { style.remove() }
}
