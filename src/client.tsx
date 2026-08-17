import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconCloseOutline16,
  IconDataOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import cssText from './client.css'

const PLUGIN_ID = '@lemoncat7/dsh-knowledge'
const STYLE_ID = `${PLUGIN_ID}/client`

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
}

function KnowledgeLauncher({ wide, useSessions }: SidebarActionProps) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const sessionId = useSessions(state => state.current)
  const projectId = useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const knowledgeUrl = knowledgePanelUrl(sessionId, projectId)

  return (
    <>
      <button
        type="button"
        className={`dsh-knowledge-trigger${wide ? '' : ' dsh-knowledge-trigger--rail'}`}
        aria-label="知识库"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={wide ? undefined : '知识库'}
        onClick={() => { setOpen(true) }}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide && <span>知识库</span>}
      </button>
      {open && <KnowledgePanel src={knowledgeUrl} onClose={close} />}
    </>
  )
}

function KnowledgePanel({ src, onClose }: { src: string; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    closeButton.current?.focus()
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  return (
    <div className="dsh-knowledge-overlay" role="presentation">
      <div className="dsh-knowledge-mask" aria-hidden="true" onClick={onClose} />
      <section
        className="dsh-knowledge-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-knowledge-panel-title"
      >
        <header className="dsh-knowledge-header">
          <div>
            <h2 id="dsh-knowledge-panel-title">知识库</h2>
            <p>管理知识、AI 候选和客户端访问令牌</p>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="dsh-knowledge-close"
            aria-label="关闭知识库"
            onClick={onClose}
          >
            <IconCloseOutline16 size={16} />
          </button>
        </header>
        <iframe className="dsh-knowledge-frame" src={src} title="知识库管理台" />
      </section>
    </div>
  )
}

function knowledgePanelUrl(sessionId?: string, projectId?: string): string {
  const params = new URLSearchParams()
  if (sessionId !== undefined) params.set('sessionId', sessionId)
  if (projectId !== undefined) params.set('projectId', projectId)
  const query = params.toString()
  return query.length === 0 ? '/knowledge' : `/knowledge?${query}`
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
