import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Same-origin conversation control; the host owns the actual session mount. */
const MOUNT_SELECTION_PATH = '/knowledge-control/v1/mount-selection'
/** Same-origin control surfaces require this marker; without it the host answers 401. */
const CLIENT_HEADER = { 'x-dsh-knowledge-client': 'conversation-web' } as const
const NO_SELECTION = ''

export interface MountCandidate {
  knowledgeBaseId: string
  name: string
  conversationEnabled?: boolean
}

export interface SessionSelectionView {
  sessionId: string
  selected: MountCandidate | null
  candidates: MountCandidate[]
}

type MountSelectorSlotProps = PropsRuntime<'conversation.input.left'>

function isCandidate(value: unknown): value is MountCandidate {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<MountCandidate>
  return typeof item.knowledgeBaseId === 'string' && item.knowledgeBaseId.length > 0
    && typeof item.name === 'string'
}

function isSelectionView(value: unknown): value is SessionSelectionView {
  if (value === null || typeof value !== 'object') return false
  const view = value as Partial<SessionSelectionView>
  return typeof view.sessionId === 'string'
    && (view.selected === null || isCandidate(view.selected))
    && Array.isArray(view.candidates) && view.candidates.every(isCandidate)
}

const ENGLISH_LEAK = /knowledge client header is required|requires an explicit request|connection is being switched/iu
function errorMessage(value: unknown, fallback: string): string {
  const text = value !== null && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
    ? (value as { error: string }).error
    : fallback
  // Never surface the host's English protocol strings in the composer.
  return ENGLISH_LEAK.test(text) ? '知识库选择暂不可用，请刷新页面后重试' : text
}

async function readSelection(sessionId: string, signal: AbortSignal): Promise<SessionSelectionView> {
  const response = await fetch(`${MOUNT_SELECTION_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
    cache: 'no-store', headers: { ...CLIENT_HEADER, accept: 'application/json' }, signal,
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(errorMessage(payload, `读取知识库选择失败（HTTP ${response.status}）`))
  if (!isSelectionView(payload)) throw new Error('知识库选择接口返回了无效数据。')
  return payload
}

async function writeSelection(sessionId: string, knowledgeBaseId: string | null, signal: AbortSignal): Promise<SessionSelectionView> {
  const response = await fetch(MOUNT_SELECTION_PATH, {
    method: 'POST', cache: 'no-store',
    headers: { ...CLIENT_HEADER, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, knowledgeBaseId }), signal,
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(errorMessage(payload, `切换知识库失败（HTTP ${response.status}）`))
  if (!isSelectionView(payload)) throw new Error('知识库选择接口返回了无效数据。')
  return payload
}

/**
 * Compact composer chip that opens a small list. A native <select> is not used because the
 * composer swallows the first click on form controls, which left the menu unopenable.
 * The default stays "no library": nothing is recalled until the user picks one.
 */
export function KnowledgeMountSelector({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<SessionSelectionView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const revision = useRef(0)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    const token = ++revision.current
    setView(undefined)
    setError(undefined)
    void readSelection(sessionId, controller.signal).then(
      value => { if (token === revision.current) setView(value) },
      (reason: unknown) => {
        if (token !== revision.current || controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => { revision.current++; controller.abort() }
  }, [sessionId])
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const selectedId = view?.selected?.knowledgeBaseId ?? NO_SELECTION
  const selectedName = view?.selected?.name ?? '不使用'
  const candidates = view?.candidates ?? []
  const selectedMissing = view?.selected !== null && view?.selected !== undefined
    && !candidates.some(candidate => candidate.knowledgeBaseId === view.selected!.knowledgeBaseId)
  const choose = useCallback(async (next: string): Promise<void> => {
    if (busy || view === undefined) return
    setOpen(false)
    setBusy(true)
    setError(undefined)
    try {
      const controller = new AbortController()
      setView(await writeSelection(sessionId, next === NO_SELECTION ? null : next, controller.signal))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, sessionId, view])
  const options: { id: string; label: string }[] = [
    { id: NO_SELECTION, label: '不使用知识库' },
    ...(selectedMissing && view?.selected ? [{ id: view.selected.knowledgeBaseId, label: `${view.selected.name}（当前）` }] : []),
    ...candidates.map(candidate => ({ id: candidate.knowledgeBaseId, label: candidate.name })),
  ]
  return <span className="dsh-knowledge-mount-selector" ref={root}>
    <button
      type="button"
      className="dsh-knowledge-mount-chip"
      aria-haspopup="listbox"
      aria-expanded={open}
      title={view?.selected ? `当前会话使用：${selectedName}（切换后下一次回答生效）` : '当前会话未使用知识库'}
      disabled={busy || view === undefined}
      onMouseDown={event => { event.stopPropagation(); event.preventDefault(); setOpen(value => !value) }}
    >
      <span className="dsh-knowledge-mount-caption">知识库</span>
      <span className="dsh-knowledge-mount-value">{busy ? '切换中…' : selectedName}</span>
      <span className="dsh-knowledge-mount-caret" aria-hidden="true">▾</span>
    </button>
    {open && <span className="dsh-knowledge-mount-menu" role="listbox" aria-label="选择知识库">
      {options.map(option => <button
        key={option.id === NO_SELECTION ? '__none' : option.id}
        type="button"
        role="option"
        aria-selected={option.id === selectedId}
        className={`dsh-knowledge-mount-option${option.id === selectedId ? ' is-selected' : ''}`}
        onMouseDown={event => event.stopPropagation()}
        onClick={() => { void choose(option.id) }}
      >{option.label}</button>)}
    </span>}
    {error !== undefined && <span className="dsh-knowledge-mount-error" role="alert" title={error}>{error}</span>}
  </span>
}

function KnowledgeMountSlot(props: MountSelectorSlotProps) {
  return <KnowledgeMountSelector sessionId={String(props.sessionId)} />
}

/** Register the selector at the left of the composer tool row. */
export function registerKnowledgeMountSelector(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'knowledge-mount-selector',
    order: 12,
  }, KnowledgeMountSlot))
}
