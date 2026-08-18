import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconCloseOutline16,
  IconDataOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import cssText from './client.css'

const PLUGIN_ID = '@lemoncat7/dsh-knowledge'
const STYLE_ID = `${PLUGIN_ID}/client`
const PANEL_SIZE_KEY = `${PLUGIN_ID}/panel-size`

interface SidebarActionProps {
  wide: boolean
  useSessions<T>(selector: (state: {
    current?: string
    byId: Record<string, { cwd?: string }>
  }) => T): T
}

interface SlotService {
  inject(name: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, component: (props: SidebarActionProps) => JSX.Element): unknown
}

interface ClientContext {
  slots: SlotService
  effect(setup: () => void | (() => void), label?: string): unknown
}

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

const CONNECTION_CONTROL_PATH = '/knowledge-control/v1/connection'

/** Cordis services needed by the browser half. */
export const inject = ['slots']

/** Register the knowledge launcher in the sidebar's official extension slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-knowledge: client styles')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'knowledge',
    order: -10,
  }, KnowledgeLauncher))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'dsh-knowledge-connection',
    order: 25,
  }, KnowledgeConnectionCard))
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
        <span>
          <strong>知识库连接</strong>
          <small>选择本机知识库，或连接一台中央 DSH 知识库</small>
        </span>
        <span className="dsh-knowledge-settings-summary">{loadState === 'loading' ? '读取中' : loadState === 'error' ? '连接入口' : current?.backend === 'remote' ? '远程' : '本地'} · {open ? '收起' : '设置'}</span>
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

function KnowledgeLauncher({ wide, useSessions }: SidebarActionProps) {
  const [open, setOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [panelState, setPanelState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [managementPath, setManagementPath] = useState<string>()
  const [panelError, setPanelError] = useState('')
  const close = useCallback(() => { setOpen(false) }, [])
  const sessionId = useSessions(state => state.current)
  const projectId = useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const knowledgeUrl = managementPath === undefined ? undefined : knowledgePanelUrl(managementPath, sessionId, projectId)

  const loadManagement = useCallback(async (): Promise<void> => {
    setPanelState('loading')
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

  const show = (): void => {
    setOpen(true)
    void loadManagement()
  }

  return (
    <>
      <button
        type="button"
        className={`dsh-knowledge-trigger${wide ? '' : ' dsh-knowledge-trigger--rail'}`}
        aria-label="知识库"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={wide ? undefined : '知识库'}
        onClick={show}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide && <span>知识库</span>}
      </button>
      {open && <KnowledgePanel
        src={knowledgeUrl}
        state={panelState}
        error={panelError}
        onRetry={() => { void loadManagement() }}
        maximized={maximized}
        onToggleMaximized={() => { setMaximized(value => !value) }}
        onClose={close}
      />}
    </>
  )
}

function KnowledgePanel({
  src,
  state,
  error,
  onRetry,
  maximized,
  onToggleMaximized,
  onClose,
}: {
  src?: string
  state: 'loading' | 'ready' | 'unavailable' | 'error'
  error: string
  onRetry: () => void
  maximized: boolean
  onToggleMaximized: () => void
  onClose: () => void
}) {
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  const panelSize = useRef(readPanelSize())

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    closeButton.current?.focus()
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  useEffect(() => {
    const target = panel.current
    if (target === null || typeof ResizeObserver === 'undefined') return
    const minimumWidth = desktopPanelMinimumWidth()
    const observer = new ResizeObserver(entries => {
      if (target.classList.contains('dsh-knowledge-panel--maximized') || window.innerWidth <= 760) return
      const rect = entries[0]?.contentRect
      if (rect === undefined || rect.width < minimumWidth || rect.height < 460) return
      panelSize.current = { width: Math.round(rect.width), height: Math.round(rect.height) }
      try { localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSize.current)) } catch {}
    })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [])

  const restoredSize = !maximized && window.innerWidth > 760 ? panelSize.current : undefined

  return (
    <div className="dsh-knowledge-overlay" role="presentation">
      <div className="dsh-knowledge-mask" aria-hidden="true" onClick={onClose} />
      <section
        ref={panel}
        className={`dsh-knowledge-panel${maximized ? ' dsh-knowledge-panel--maximized' : ''}`}
        style={restoredSize}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-knowledge-panel-title"
      >
        <header className="dsh-knowledge-header" onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button')) onToggleMaximized()
        }}>
          <div>
            <h2 id="dsh-knowledge-panel-title">知识库</h2>
            <p>管理知识、AI 候选和客户端访问令牌</p>
          </div>
          <div className="dsh-knowledge-window-actions">
            <button
              type="button"
              className="dsh-knowledge-window-button"
              aria-label={maximized ? '还原知识库窗口' : '最大化知识库窗口'}
              title={maximized ? '还原' : '最大化'}
              onClick={(event) => { event.stopPropagation(); onToggleMaximized() }}
            >
              <span aria-hidden="true">{maximized ? '↙' : '↗'}</span>
            </button>
            <button
              ref={closeButton}
              type="button"
              className="dsh-knowledge-window-button"
              aria-label="关闭知识库"
              onClick={onClose}
            >
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>
        {state === 'ready' && src !== undefined
          ? <iframe className="dsh-knowledge-frame" src={src} title="知识库管理台" />
          : <div className="dsh-knowledge-panel-state" role={state === 'error' ? 'alert' : 'status'} aria-live="polite">
            <span className="dsh-knowledge-panel-state-icon" aria-hidden="true">{state === 'loading' ? '···' : state === 'error' ? '!' : '—'}</span>
            <div>
              <h3>{state === 'loading' ? '正在打开知识库…' : state === 'error' ? '暂时无法打开知识库' : '这台 DSH 未启用知识库管理台'}</h3>
              <p>{state === 'loading'
                ? '正在确认当前实例是否提供管理页面。'
                : state === 'error'
                  ? error
                  : '本地召回和回写仍可使用。若要在这里管理知识，请在插件配置中同时启用 exposeApi 和 exposeWeb；使用远程知识库时，请前往中央 DSH 的知识库管理台。'}</p>
              {state === 'error' && <button type="button" onClick={onRetry}>重试</button>}
            </div>
          </div>}
        {!maximized && <span className="dsh-knowledge-resize-grip" aria-hidden="true" />}
      </section>
    </div>
  )
}

function readPanelSize(): { width: number; height: number } {
  const minimumWidth = desktopPanelMinimumWidth()
  const fallback = {
    width: Math.min(1180, Math.max(minimumWidth, window.innerWidth - 48)),
    height: Math.min(860, Math.max(460, window.innerHeight - 48)),
  }
  try {
    const value = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || '{}') as { width?: unknown; height?: unknown }
    const width = Number(value.width)
    const height = Number(value.height)
    return {
      width: Number.isFinite(width) ? Math.min(window.innerWidth - 32, Math.max(minimumWidth, width)) : fallback.width,
      height: Number.isFinite(height) ? Math.min(window.innerHeight - 32, Math.max(460, height)) : fallback.height,
    }
  } catch { return fallback }
}

function desktopPanelMinimumWidth(): number {
  return Math.min(1040, Math.max(320, window.innerWidth - 32))
}

function knowledgePanelUrl(managementPath: string, sessionId?: string, projectId?: string): string {
  const params = new URLSearchParams()
  if (sessionId !== undefined) params.set('sessionId', sessionId)
  if (projectId !== undefined) params.set('projectId', projectId)
  const query = params.toString()
  return query.length === 0 ? managementPath : `${managementPath}?${query}`
}

function installStyles(): () => void {
  const previous = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  previous?.remove()
  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = STYLE_ID
  style.textContent = cssText
  document.head.appendChild(style)
  return () => { style.remove() }
}
