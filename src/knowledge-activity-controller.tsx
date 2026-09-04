import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { KnowledgeActivityPanel } from './knowledge-activity-panel.js'
import type { KnowledgeDocumentTarget } from './client.js'

export interface KnowledgeActivitySelection {
  mode?: 'knowledge' | 'notes'
  knowledgeBaseId?: string | undefined
  documentId?: string | undefined
  noteFolderId?: string | null | undefined
  noteDocumentId?: string | undefined
}

export interface KnowledgeActivityController {
  open(sessionId: string, selection?: KnowledgeActivitySelection): void
  toggle(sessionId: string): void
  close(sessionId?: string): void
  isOpen(sessionId: string): boolean
  selection(sessionId: string): KnowledgeActivitySelection
  select(sessionId: string, selection: KnowledgeActivitySelection): void
  openWorkspace(target?: KnowledgeDocumentTarget): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function createKnowledgeActivityController(
  ctx: ClientContext,
  options: {
    beforeOpen(): void
    openWorkspace(target?: KnowledgeDocumentTarget): void
  },
): KnowledgeActivityController {
  const runtime = ctx as unknown as { sessions: ISessions }
  const listeners = new Set<() => void>()
  const states = new Map<string, KnowledgeActivitySelection & { open: boolean }>()
  let currentSessionId = normalizeSessionId(runtime.sessions.list.getSnapshot().current)
  let mountedSessionId: string | undefined
  let restoreFrame: number | undefined
  let disposePanel: (() => void) | undefined

  const notify = (): void => { for (const listener of listeners) listener() }
  const cancelRestore = (): void => {
    if (restoreFrame === undefined) return
    window.cancelAnimationFrame(restoreFrame)
    restoreFrame = undefined
  }
  const unmount = (): boolean => {
    if (disposePanel === undefined) return false
    const dispose = disposePanel
    disposePanel = undefined
    mountedSessionId = undefined
    dispose()
    return true
  }
  const mount = (sessionId: string, openDetails = true): void => {
    if (mountedSessionId === sessionId && disposePanel !== undefined) return
    unmount()
    mountedSessionId = sessionId
    disposePanel = ctx.slots.register({ name: 'details', priority: -3 }, props => (
      <KnowledgeActivityPanel {...props} controller={controller} />
    ))
    if (openDetails) ctx.layout.openDetails()
  }
  const syncCurrentSession = (): void => {
    const nextSessionId = normalizeSessionId(runtime.sessions.list.getSnapshot().current)
    if (nextSessionId === currentSessionId) return
    cancelRestore()
    const wasMounted = unmount()
    currentSessionId = nextSessionId
    if (nextSessionId !== undefined && states.get(nextSessionId)?.open === true) {
      mount(nextSessionId, false)
      restoreFrame = window.requestAnimationFrame(() => {
        restoreFrame = undefined
        if (currentSessionId === nextSessionId && mountedSessionId === nextSessionId && states.get(nextSessionId)?.open === true) {
          ctx.layout.openDetails()
        }
      })
    } else if (wasMounted) {
      ctx.layout.closeDetails()
    }
    notify()
  }

  const controller: KnowledgeActivityController = {
    open(sessionId, selection) {
      const previous = states.get(sessionId)
      states.set(sessionId, { ...previous, ...selection, open: true })
      options.beforeOpen()
      if (sessionId === currentSessionId) {
        cancelRestore()
        mount(sessionId)
      }
      notify()
    },
    toggle(sessionId) {
      if (states.get(sessionId)?.open === true) controller.close(sessionId)
      else controller.open(sessionId)
    },
    close(sessionId) {
      const target = sessionId ?? currentSessionId
      if (target === undefined) return
      const previous = states.get(target) ?? { open: false }
      states.set(target, { ...previous, open: false })
      if (target === currentSessionId) {
        cancelRestore()
        if (unmount()) ctx.layout.closeDetails()
      }
      notify()
    },
    isOpen: sessionId => states.get(sessionId)?.open === true,
    selection(sessionId) {
      const state = states.get(sessionId)
      return {
        ...state?.mode === undefined ? {} : { mode: state.mode },
        ...state?.knowledgeBaseId === undefined ? {} : { knowledgeBaseId: state.knowledgeBaseId },
        ...state?.documentId === undefined ? {} : { documentId: state.documentId },
        ...state?.noteFolderId === undefined ? {} : { noteFolderId: state.noteFolderId },
        ...state?.noteDocumentId === undefined ? {} : { noteDocumentId: state.noteDocumentId },
      }
    },
    select(sessionId, selection) {
      const previous = states.get(sessionId) ?? { open: true }
      states.set(sessionId, { ...previous, ...selection, open: previous.open })
      notify()
    },
    openWorkspace(target) {
      controller.close()
      options.openWorkspace(target)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposeSelection()
      cancelRestore()
      unmount()
      states.clear()
      listeners.clear()
    },
  }
  const disposeSelection = runtime.sessions.list.subscribe(syncCurrentSession)
  return controller
}

function normalizeSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
