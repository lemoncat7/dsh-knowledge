import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

type PanelProps = PropsRuntime<'details'>
type TabInfo = { tab: { id: string; visible: boolean; signal: AbortSignal; actions: { close(): void } } }
type TabProps = PanelProps & { useTabInfo(): TabInfo }
type Sidebar = { openTab(kind: string): void }
type Registry = { register(definition: { id: string; kind: string; title(): string }): () => void }

/** The new host owns session persistence, docking and tab closure. */
export function supportsDockedPanels(ctx: Context): boolean {
  return typeof (ctx.layout as unknown as { selectPanel?: unknown }).selectPanel === 'function'
}

export function createDockedPanel(
  ctx: Context,
  id: string,
  title: string,
  render: (props: PanelProps) => JSX.Element,
  notify: () => void,
) {
  const records = new Map<string, Map<string, { visible: boolean; close(): void }>>()
  let pending: string | undefined
  let frame: number | undefined
  let disposed = false
  let sidebar: Sidebar | undefined
  const cancel = (): void => {
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    frame = undefined
    pending = undefined
  }
  function Body(props: TabProps): JSX.Element | null {
    const { tab } = props.useTabInfo()
    const sessionId = String(props.sessionId)
    useEffect(() => {
      let entries = records.get(sessionId)
      if (entries === undefined) { entries = new Map(); records.set(sessionId, entries) }
      const entry = { visible: tab.visible, close: () => tab.actions.close() }
      entries.set(tab.id, entry)
      const remove = (): void => {
        if (entries?.get(tab.id) !== entry) return
        entries.delete(tab.id)
        if (entries.size === 0) records.delete(sessionId)
        notify()
      }
      tab.signal.addEventListener('abort', remove, { once: true })
      notify()
      return () => {
        tab.signal.removeEventListener('abort', remove)
        remove()
      }
    }, [sessionId, tab.id, tab.visible, tab.signal])
    // Hidden tabs must not keep terminal polling and document fetching alive.
    return tab.visible ? render(props) : null
  }
  const fiber = ctx.inject(['sidebarRight', 'sidebarRightTabs'], child => {
    sidebar = child.get('sidebarRight') as Sidebar
    const registry = child.get('sidebarRightTabs') as Registry
    const slots = child.slots as unknown as {
      inject(name: string, effect: () => () => void): () => void
      register(options: { name: string; key: string }, body: typeof Body): () => void
    }
    child.effect(() => registry.register({ id, kind: id, title: () => title }), id + ': tab type')
    child.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab', key: id,
    }, Body)), id + ': tab body')
    child.effect(() => () => { sidebar = undefined }, id + ': tab service')
  })
  return {
    open(sessionId: string): void {
      cancel()
      pending = sessionId
      // Closing a main panel remounts the conversation seat on the next commit.
      // Do not issue a right-tab command against a stale/unmounted seat.
      let attempts = 0
      const reveal = (): void => {
        frame = undefined
        if (disposed || pending !== sessionId) return
        const sessions = ctx.get('sessions') as unknown as { list: { getSnapshot(): { current?: string } } }
        if (String(sessions.list.getSnapshot().current) !== sessionId) { cancel(); notify(); return }
        try {
          if (sidebar === undefined) throw new Error('Right sidebar is not ready')
          sidebar.openTab(id)
          pending = undefined
          notify()
        } catch (error) {
          if (++attempts < 30) frame = window.requestAnimationFrame(reveal)
          else { cancel(); notify(); console.error(title + ': could not open sidebar', error) }
        }
      }
      frame = window.requestAnimationFrame(reveal)
      notify()
    },
    close(sessionId: string): void {
      if (pending === sessionId) cancel()
      for (const entry of [...(records.get(sessionId)?.values() ?? [])]) entry.close()
      records.delete(sessionId)
      notify()
    },
    isOpen(sessionId: string): boolean {
      return pending === sessionId || [...(records.get(sessionId)?.values() ?? [])].some(entry => entry.visible)
    },
    dispose(): void {
      disposed = true
      cancel()
      for (const entries of records.values()) for (const entry of [...entries.values()]) entry.close()
      records.clear()
      void fiber.dispose()
    },
  }
}
