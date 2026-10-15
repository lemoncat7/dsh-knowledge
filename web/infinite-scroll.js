/** Observe only mounted lists. Scrolling opts into automatic loading; buttons also work without IO. */
export function connectInfiniteScroll(root) {
  if (typeof IntersectionObserver !== 'function') return () => {}
  let scrolled = false, frame = 0, disposed = false
  const visible = new Set()
  const observed = new Set()
  const trigger = () => {
    frame = 0
    if (!scrolled || disposed) return
    for (const button of visible) {
      if (!button.isConnected || button.disabled || button.dataset.loadMore !== 'auto') continue
      // One page per scroll/visibility event. Request handlers own in-flight deduplication.
      scrolled = false
      button.click()
      break
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(trigger) }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target)
      else visible.delete(entry.target)
    }
    schedule()
  }, { rootMargin: '0px 0px 160px 0px' })
  const watch = () => {
    for (const node of observed) if (!root.contains(node)) { observer.unobserve(node); observed.delete(node); visible.delete(node) }
    root.querySelectorAll('[data-load-more]').forEach(node => {
      if (!observed.has(node)) { observed.add(node); observer.observe(node) }
    })
  }
  const mutations = new MutationObserver(watch)
  mutations.observe(root, { childList: true, subtree: true })
  watch()
  const onScroll = () => { scrolled = true; schedule() }
  root.addEventListener('scroll', onScroll, true)
  window.addEventListener('scroll', onScroll, { passive: true })
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    observer.disconnect(); mutations.disconnect(); visible.clear(); observed.clear()
    root.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('scroll', onScroll)
  }
}
