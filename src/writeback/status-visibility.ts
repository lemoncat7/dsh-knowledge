/** Only visible turn tails own status reads and live subscriptions. */
export function observeWritebackVisibility(
  element: HTMLElement,
  status: { setVisible(visible: boolean): void },
  subscribe: () => () => void,
): () => void {
  const doc = element.ownerDocument
  const win = doc.defaultView!
  let inView = typeof win.IntersectionObserver === 'undefined'
  let unsubscribe: (() => void) | undefined
  const refresh = (): void => {
    const visible = inView && !doc.hidden
    // Pause before subscribing: a subscription can synchronously invalidate.
    status.setVisible(visible)
    if (visible) unsubscribe ??= subscribe()
    else { unsubscribe?.(); unsubscribe = undefined }
  }
  const observer = typeof win.IntersectionObserver === 'undefined' ? undefined : new win.IntersectionObserver(entries => {
    inView = entries[0]?.isIntersecting ?? false
    refresh()
  }, { rootMargin: '100px' })
  refresh()
  observer?.observe(element)
  doc.addEventListener('visibilitychange', refresh)
  win.addEventListener('focus', refresh)
  win.addEventListener('online', refresh)
  return () => {
    observer?.disconnect()
    doc.removeEventListener('visibilitychange', refresh)
    win.removeEventListener('focus', refresh)
    win.removeEventListener('online', refresh)
    status.setVisible(false)
    unsubscribe?.()
  }
}
