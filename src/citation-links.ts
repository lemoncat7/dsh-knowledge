import { citationFromFilePath, citationFromHref, type KnowledgeCitation } from './knowledge-citations.js'

/** Intercept only our same-origin inline citations; leave ordinary/file links alone. */
export function installCitationLinks(open: (citation: KnowledgeCitation) => void, root: Document = document): () => void {
  let anchor: Element | null = null, tooltip: HTMLDivElement | undefined, controller: AbortController | undefined
  let showTimer: ReturnType<typeof setTimeout> | undefined, hideTimer: ReturnType<typeof setTimeout> | undefined
  const titles = new Map<Element, string>()
  const style = root.createElement('style')
  style.textContent = `.dsh-knowledge-citation-tooltip { position:fixed; z-index:2147483000; width:340px; max-width:calc(100vw - 24px); max-height:min(280px, calc(100dvh - 24px)); overflow:auto; box-sizing:border-box; padding:14px 16px; border:1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius:12px; background:Canvas; color:CanvasText; box-shadow:0 8px 32px #0002; font:13px/1.65 system-ui,sans-serif; overflow-wrap:anywhere; text-align:left; } .dsh-knowledge-citation-tooltip strong { display:block; font-size:13px; margin-bottom:5px; } .dsh-knowledge-citation-tooltip p { margin:0; white-space:pre-wrap; } .dsh-knowledge-citation-tooltip small { display:block; margin-top:8px; font-size:11px; }`
  root.head.append(style)
  const identify = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest('a[href], button[title], button[data-knowledge-citation]') : null
    if (!el) return
    const ref = el.tagName === 'BUTTON'
      ? citationFromFilePath(el.getAttribute('title') || el.getAttribute('data-knowledge-citation') || '')
      : citationFromHref(el.getAttribute('href') || '', root.location.href)
    if (!ref) return
    if (el.tagName === 'BUTTON' && el.hasAttribute('title')) {
      titles.set(el, el.getAttribute('title') || '')
      el.setAttribute('data-knowledge-citation', el.getAttribute('title') || '')
      el.removeAttribute('title')
    }
    return { el, ref }
  }
  const hide = () => {
    clearTimeout(showTimer); clearTimeout(hideTimer); controller?.abort()
    if (anchor && tooltip) {
      const ids = (anchor.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== tooltip!.id)
      if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' ')); else anchor.removeAttribute('aria-describedby')
    }
    tooltip?.remove(); tooltip = undefined; anchor = null
  }
  const position = () => {
    if (!tooltip || !anchor?.isConnected) return hide()
    const rect = anchor.getBoundingClientRect(), width = root.documentElement.clientWidth, height = root.documentElement.clientHeight
    const box = tooltip.getBoundingClientRect()
    tooltip.style.left = `${Math.max(12, Math.min(rect.left, width - box.width - 12))}px`
    tooltip.style.top = `${Math.max(12, rect.bottom + box.height + 8 < height ? rect.bottom + 8 : rect.top - box.height - 8)}px`
  }
  const enter = (event: Event) => {
    if (tooltip?.contains(event.target as Node)) { clearTimeout(hideTimer); return }
    const found = identify(event.target)
    if (!found) return
    if (anchor === found.el) { clearTimeout(hideTimer); return }
    hide(); anchor = found.el
    showTimer = setTimeout(async () => {
      if (!anchor?.isConnected) return hide()
      const request = new AbortController(); controller = request
      tooltip = root.createElement('div'); tooltip.className = 'dsh-knowledge-citation-tooltip'
      tooltip.style.colorScheme = getComputedStyle(found.el).colorScheme
      tooltip.id = 'dsh-knowledge-citation-preview'; tooltip.role = 'tooltip'
      const title = root.createElement('strong'), text = root.createElement('p'), hint = root.createElement('small')
      title.textContent = found.ref.title; text.textContent = '正在读取引用片段…'
      hint.textContent = `第 ${found.ref.startLine}–${found.ref.endLine} 行 · 点击定位原文`
      tooltip.append(title, text, hint); root.body.append(tooltip)
      anchor.setAttribute('aria-describedby', [anchor.getAttribute('aria-describedby'), tooltip.id].filter(Boolean).join(' '))
      position()
      try {
        const query = new URLSearchParams({ sessionId: found.ref.sessionId, citation: JSON.stringify(found.ref) })
        const response = await fetch(`/knowledge-control/v1/activity/citation?${query}`, { signal: request.signal, headers: { 'x-dsh-knowledge-client': 'conversation-web' } })
        const data = await response.json()
        if (request.signal.aborted || !tooltip) return
        if (!response.ok) throw Error(data.error || '暂时无法读取来源')
        const excerpt = data.lines.filter((line: { number: number }) => line.number >= found.ref.startLine && line.number <= found.ref.endLine).map((line: { text: string }) => line.text).join('\n').trim()
        text.textContent = excerpt.slice(0, 420) + (excerpt.length > 420 ? '…' : '')
      } catch (error) {
        if (request.signal.aborted || !tooltip) return
        text.textContent = error instanceof Error ? error.message : '暂时无法读取来源'
      }
      position()
    }, event.type === 'focusin' ? 0 : 250)
  }
  const leave = (event: Event) => {
    const next = (event as MouseEvent).relatedTarget
    if (next instanceof Node && (anchor?.contains(next) || tooltip?.contains(next))) return
    clearTimeout(hideTimer); hideTimer = setTimeout(hide, 120)
  }
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') hide() }
  const scroll = (event: Event) => { if (!tooltip?.contains(event.target as Node)) hide() }
  const click = (event: MouseEvent) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const found = identify(event.target)
    if (!found) return
    event.preventDefault()
    event.stopImmediatePropagation()
    hide()
    open(found.ref)
  }
  root.addEventListener('click', click, true)
  root.addEventListener('pointerover', enter, true)
  root.addEventListener('pointerout', leave, true)
  root.addEventListener('focusin', enter, true)
  root.addEventListener('focusout', leave, true)
  root.addEventListener('keydown', escape, true)
  root.addEventListener('scroll', scroll, true)
  root.defaultView?.addEventListener('resize', hide)
  return () => {
    hide(); style.remove()
    root.removeEventListener('click', click, true)
    root.removeEventListener('pointerover', enter, true); root.removeEventListener('pointerout', leave, true)
    root.removeEventListener('focusin', enter, true); root.removeEventListener('focusout', leave, true)
    root.removeEventListener('keydown', escape, true); root.removeEventListener('scroll', scroll, true)
    root.defaultView?.removeEventListener('resize', hide)
    for (const [el, title] of titles) { el.setAttribute('title', title); el.removeAttribute('data-knowledge-citation') }
  }
}
