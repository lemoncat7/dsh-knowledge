import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { KnowledgeActivityController } from './knowledge-activity-controller.js'

/** Keep reader text at a stable width while the host animates its details column.
 * Only plugin-owned elements are written; host animations are observed, not changed.
 */
export function KnowledgeActivityPresentation({ controller, sessionId, onClosed, children }: {
  controller: KnowledgeActivityController
  sessionId: string
  onClosed(): void
  children: ReactNode
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const open = useSyncExternalStore(controller.subscribe, () => controller.isOpen(sessionId))
  useLayoutEffect(() => {
    const viewport = root.current
    const panel = viewport?.firstElementChild as HTMLElement | null
    if (!viewport || !panel) return
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const width = panel.getBoundingClientRect().width
    panel.style.width = `${width > 1 ? width : 360}px`
    viewport.toggleAttribute('inert', !open)
    const settle = (): void => {
      if (cancelled) return
      cancelled = true
      if (timeout !== undefined) clearTimeout(timeout)
      panel.style.removeProperty('width')
      if (!open) onClosed()
    }
    const frame = requestAnimationFrame(() => {
      const transitions: Animation[] = []
      for (let parent = viewport.parentElement; parent; parent = parent.parentElement) {
        for (const animation of parent.getAnimations()) {
          if ('transitionProperty' in animation && animation.transitionProperty === 'grid-template-columns') transitions.push(animation)
        }
      }
      // A bounded fallback covers detached/cancelled host transitions. It is not
      // a fixed delay: no-motion layouts settle in the first animation frame.
      timeout = setTimeout(settle, 1000)
      void Promise.allSettled(transitions.map(animation => animation.finished)).then(settle)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      if (timeout !== undefined) clearTimeout(timeout)
      panel.style.removeProperty('width')
    }
  }, [open, onClosed])
  return <div ref={root} className="dsh-knowledge-activity-viewport" aria-hidden={!open || undefined}>{children}</div>
}
