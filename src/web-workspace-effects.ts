const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const GLASS_SURFACE_SELECTOR = [
  '.sidebar',
  '.topbar',
  '.note-tree-panel',
  '.notes-browser',
  '.notes-content-header',
  '.notes-document-toolbar',
  '.notes-document-statusbar',
  '.note-editor-toolbar',
].join(',')
const STRUCTURAL_GLASS_SURFACE_SELECTOR = [
  '.sidebar',
  '.topbar',
  '.note-tree-panel',
  '.notes-browser',
].join(',')
const CARD_SURFACE_SELECTOR = [
  '.login-card',
  '.metric',
  '.panel',
  '.library-detail-header',
  '.mount-manager',
  '.knowledge-card',
  '.candidate',
  '.api-access-card',
].join(',')
const BORDER_SURFACE_SELECTOR = [
  '.mount-table',
  '.note-workspace',
  '.notes-workspace',
  CARD_SURFACE_SELECTOR,
].join(',')
const GLARE_SURFACE_SELECTOR = [
  '.button',
  '.nav-button',
  '.tab',
  '.pane-toggle-button',
  '.note-tree-base',
  '.note-tree-document',
  '.note-tree-new',
  '.notes-tree-row',
  '.notes-search-row',
  '.notes-file-main',
].join(',')
const ANIMATED_LIST_SELECTOR = [
  '.note-tree',
  '.notes-tree',
  '.base-grid',
  '.mount-table',
].join(',')
const MOTION_ITEM_SELECTOR = '[data-knowledge-motion-key]'
const MOTION_REPLAY_COOLDOWN = 700
const EDGE_RESPONSE_RANGE = 38

interface WorkspaceEffectsApi {
  refresh(root?: ParentNode): void
  destroy(): void
}

interface GlassSurfaceRecord {
  filter: SVGFilterElement | undefined
  observer: ResizeObserver | undefined
  frame: number
}

declare global {
  interface Window {
    DshKnowledgeEffects?: WorkspaceEffectsApi
  }
}

const glassSurfaces = new Map<HTMLElement, GlassSurfaceRecord>()
const borderSurfaces = new Map<HTMLElement, () => void>()
const animatedLists = new Map<HTMLElement, () => void>()
const motionPlayedAt = new Map<string, number>()
let filterSequence = 0
let filterBank: SVGSVGElement | undefined

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)')

function queryIncludingRoot(root: ParentNode, selector: string): HTMLElement[] {
  const matches = Array.from(root.querySelectorAll<HTMLElement>(selector))
  if (root instanceof HTMLElement && root.matches(selector)) matches.unshift(root)
  return matches
}

function ensureFilterBank(): SVGSVGElement {
  if (filterBank?.isConnected) return filterBank
  filterBank = document.createElementNS(SVG_NAMESPACE, 'svg')
  filterBank.classList.add('knowledge-glass-filter-bank')
  filterBank.setAttribute('aria-hidden', 'true')
  filterBank.setAttribute('focusable', 'false')
  document.body.append(filterBank)
  return filterBank
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NAMESPACE, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  return node
}

function createGlassFilter(id: string): { filter: SVGFilterElement; image: SVGFEImageElement } {
  const filter = createSvgElement('filter', {
    id,
    x: '0%', y: '0%', width: '100%', height: '100%',
    'color-interpolation-filters': 'sRGB',
  })
  const image = createSvgElement('feImage', {
    x: '0', y: '0', width: '100%', height: '100%', preserveAspectRatio: 'none', result: 'map',
  })
  filter.append(
    image,
    createSvgElement('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '6', result: 'frosted' }),
  )

  filter.append(
    createSvgElement('feDisplacementMap', {
      in: 'frosted', in2: 'map', scale: '-16',
      xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted',
    }),
    createSvgElement('feGaussianBlur', { in: 'refracted', stdDeviation: '.12' }),
  )
  return { filter, image }
}

function supportsSvgBackdropFilters(): boolean {
  if (reducedTransparency.matches) return false
  const userAgent = navigator.userAgent
  if (/Firefox/i.test(userAgent) || (/Safari/i.test(userAgent) && !/(Chrome|Chromium|CriOS)/i.test(userAgent))) return false
  return CSS.supports?.('backdrop-filter', 'url(#knowledge-glass-support)')
    || CSS.supports?.('-webkit-backdrop-filter', 'url(#knowledge-glass-support)')
    || false
}

function resolvedRadius(surface: HTMLElement, width: number, height: number): number {
  const parsed = Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius)
  if (Number.isFinite(parsed)) return Math.max(0, Math.min(parsed, Math.min(width, height) / 2))
  return Math.min(width, height) * .16
}

function displacementMap(width: number, height: number, radius: number): string {
  const edge = Math.min(12, Math.max(4, Math.min(width, height) * .08))
  const map = `<svg viewBox="0 0 ${width} ${height}" xmlns="${SVG_NAMESPACE}">
    <defs>
      <clipPath id="shape"><rect width="${width}" height="${height}" rx="${radius}"/></clipPath>
      <linearGradient id="left" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="rgb(92 128 128)"/><stop offset="100%" stop-color="rgb(128 128 128)"/></linearGradient>
      <linearGradient id="right" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="rgb(128 128 128)"/><stop offset="100%" stop-color="rgb(164 128 128)"/></linearGradient>
      <linearGradient id="top" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="rgb(128 92 128)"/><stop offset="100%" stop-color="rgb(128 128 128)"/></linearGradient>
      <linearGradient id="bottom" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="rgb(128 128 128)"/><stop offset="100%" stop-color="rgb(128 164 128)"/></linearGradient>
    </defs>
    <g clip-path="url(#shape)">
      <rect width="${width}" height="${height}" fill="rgb(128 128 128)"/>
      <rect width="${edge}" height="${height}" fill="url(#left)"/>
      <rect x="${width - edge}" width="${edge}" height="${height}" fill="url(#right)"/>
      <rect width="${width}" height="${edge}" fill="url(#top)"/>
      <rect y="${height - edge}" width="${width}" height="${edge}" fill="url(#bottom)"/>
    </g>
  </svg>`
  return `data:image/svg+xml,${encodeURIComponent(map)}`
}

function installGlassSurface(surface: HTMLElement): void {
  if (glassSurfaces.has(surface)) return
  surface.classList.add('knowledge-glass-surface')
  // Fixed navigation and directory panes already own a single layout edge.
  // SVG displacement refracts that edge into visible top/left seams, so these
  // structural surfaces deliberately use the cheaper, stable CSS material.
  if (surface.matches(STRUCTURAL_GLASS_SURFACE_SELECTOR) || !supportsSvgBackdropFilters()) {
    surface.dataset.knowledgeGlass = 'fallback'
    glassSurfaces.set(surface, { filter: undefined, observer: undefined, frame: 0 })
    return
  }

  const id = `knowledge-glass-filter-${++filterSequence}`
  const { filter, image } = createGlassFilter(id)
  ensureFilterBank().append(filter)
  surface.dataset.knowledgeGlass = 'svg'
  surface.style.setProperty('--knowledge-glass-filter', `url(#${id})`)

  const record: GlassSurfaceRecord = { filter, observer: undefined, frame: 0 }
  const update = (): void => {
    record.frame = 0
    if (!surface.isConnected) return
    const rect = surface.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))
    image.setAttribute('href', displacementMap(width, height, resolvedRadius(surface, width, height)))
  }
  const scheduleUpdate = (): void => {
    if (record.frame === 0) record.frame = requestAnimationFrame(update)
  }
  record.observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleUpdate)
  record.observer?.observe(surface)
  record.frame = requestAnimationFrame(update)
  glassSurfaces.set(surface, record)
}

function installBorderSurface(surface: HTMLElement): void {
  if (borderSurfaces.has(surface)) return
  surface.classList.add('knowledge-border-surface')
  surface.style.setProperty('--knowledge-pointer-x', '50%')
  surface.style.setProperty('--knowledge-pointer-y', '50%')
  let frame = 0
  let pointer: { x: number; y: number } | undefined
  const paint = (): void => {
    frame = 0
    if (pointer === undefined || !surface.isConnected) return
    const rect = surface.getBoundingClientRect()
    const x = Math.min(rect.width, Math.max(0, pointer.x - rect.left))
    const y = Math.min(rect.height, Math.max(0, pointer.y - rect.top))
    const edgeDistance = Math.min(x, rect.width - x, y, rect.height - y)
    const proximity = Math.min(1, Math.max(0, 1 - edgeDistance / EDGE_RESPONSE_RANGE))
    const angle = Math.atan2(y - rect.height / 2, x - rect.width / 2) * (180 / Math.PI) + 90
    surface.style.setProperty('--knowledge-pointer-x', `${(x / Math.max(1, rect.width) * 100).toFixed(2)}%`)
    surface.style.setProperty('--knowledge-pointer-y', `${(y / Math.max(1, rect.height) * 100).toFixed(2)}%`)
    surface.style.setProperty('--knowledge-border-proximity', proximity.toFixed(3))
    surface.style.setProperty('--knowledge-border-angle', `${angle.toFixed(2)}deg`)
  }
  const move = (event: PointerEvent): void => {
    pointer = { x: event.clientX, y: event.clientY }
    if (frame === 0) frame = requestAnimationFrame(paint)
  }
  const leave = (): void => {
    pointer = undefined
    surface.style.setProperty('--knowledge-border-proximity', '0')
  }
  surface.addEventListener('pointermove', move, { passive: true })
  surface.addEventListener('pointerleave', leave, { passive: true })
  borderSurfaces.set(surface, () => {
    if (frame !== 0) cancelAnimationFrame(frame)
    surface.removeEventListener('pointermove', move)
    surface.removeEventListener('pointerleave', leave)
  })
}

function motionWasJustPlayed(item: HTMLElement, now: number): boolean {
  const key = item.dataset.knowledgeMotionKey
  if (key === undefined) return false
  const playedAt = motionPlayedAt.get(key)
  return playedAt !== undefined && now - playedAt < MOTION_REPLAY_COOLDOWN
}

function rememberMotionPlay(item: HTMLElement, now: number): void {
  const key = item.dataset.knowledgeMotionKey
  if (key === undefined) return
  motionPlayedAt.set(key, now)
  if (motionPlayedAt.size <= 4_000) return
  const oldestKey = motionPlayedAt.keys().next().value
  if (oldestKey !== undefined) motionPlayedAt.delete(oldestKey)
}

function updateScrollEdges(list: HTMLElement): void {
  const remaining = list.scrollHeight - list.clientHeight - list.scrollTop
  list.dataset.scrollTop = String(list.scrollTop <= 2)
  list.dataset.scrollBottom = String(remaining <= 2)
}

function installAnimatedList(list: HTMLElement): void {
  if (animatedLists.has(list)) return
  const isCardGrid = list.matches('.base-grid')
  list.classList.add('knowledge-animated-list')
  list.dataset.knowledgeListLayout = isCardGrid ? 'grid' : 'scroll'
  updateScrollEdges(list)
  const onScroll = (): void => updateScrollEdges(list)
  list.addEventListener('scroll', onScroll, { passive: true })

  const items = Array.from(list.querySelectorAll<HTMLElement>(MOTION_ITEM_SELECTOR))
  if (reducedMotion.matches || typeof IntersectionObserver === 'undefined') {
    for (const item of items) item.classList.add('knowledge-list-reveal', 'is-visible')
    animatedLists.set(list, () => list.removeEventListener('scroll', onScroll))
    return
  }

  const observerRoot = list.scrollHeight - list.clientHeight > 2 ? list : null
  const observer = new IntersectionObserver(entries => {
    const entering = entries
      .filter(entry => entry.isIntersecting)
      .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
    const now = performance.now()
    entering.forEach((entry, index) => {
      const item = entry.target as HTMLElement
      const stagger = isCardGrid ? 52 : 38
      item.style.setProperty('--knowledge-list-delay', `${Math.min(index, 7) * stagger}ms`)
      item.classList.add('is-visible')
      rememberMotionPlay(item, now)
    })
    for (const entry of entries) {
      if (entry.isIntersecting) continue
      const item = entry.target as HTMLElement
      item.classList.remove('is-visible')
      item.style.setProperty('--knowledge-list-delay', '0ms')
    }
  }, { root: observerRoot, threshold: .12, rootMargin: '-4px 0px' })

  const now = performance.now()
  for (const item of items) {
    item.classList.add('knowledge-list-reveal')
    if (!isCardGrid && motionWasJustPlayed(item, now)) item.classList.add('is-visible')
  }

  let prepareFrame = 0
  let settleFrame = 0
  prepareFrame = requestAnimationFrame(() => {
    prepareFrame = 0
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0
      for (const item of items) observer.observe(item)
    })
  })
  animatedLists.set(list, () => {
    if (prepareFrame !== 0) cancelAnimationFrame(prepareFrame)
    if (settleFrame !== 0) cancelAnimationFrame(settleFrame)
    observer.disconnect()
    list.removeEventListener('scroll', onScroll)
  })
}

function cleanupDisconnected(): void {
  for (const [surface, record] of glassSurfaces) {
    if (surface.isConnected) continue
    if (record.frame !== 0) cancelAnimationFrame(record.frame)
    record.observer?.disconnect()
    record.filter?.remove()
    glassSurfaces.delete(surface)
  }
  for (const [surface, cleanup] of borderSurfaces) {
    if (surface.isConnected) continue
    cleanup()
    borderSurfaces.delete(surface)
  }
  for (const [list, cleanup] of animatedLists) {
    if (list.isConnected) continue
    cleanup()
    animatedLists.delete(list)
  }
}

function refresh(root: ParentNode = document): void {
  cleanupDisconnected()
  for (const surface of queryIncludingRoot(root, GLASS_SURFACE_SELECTOR)) installGlassSurface(surface)
  for (const surface of queryIncludingRoot(root, CARD_SURFACE_SELECTOR)) surface.classList.add('knowledge-card-surface')
  for (const surface of queryIncludingRoot(root, BORDER_SURFACE_SELECTOR)) installBorderSurface(surface)
  for (const surface of queryIncludingRoot(root, GLARE_SURFACE_SELECTOR)) surface.classList.add('knowledge-glare-surface')
  for (const list of queryIncludingRoot(root, ANIMATED_LIST_SELECTOR)) installAnimatedList(list)
}

function destroy(): void {
  for (const [surface, record] of glassSurfaces) {
    if (record.frame !== 0) cancelAnimationFrame(record.frame)
    record.observer?.disconnect()
    record.filter?.remove()
    surface.classList.remove('knowledge-glass-surface')
    surface.removeAttribute('data-knowledge-glass')
    surface.style.removeProperty('--knowledge-glass-filter')
  }
  for (const [surface, cleanup] of borderSurfaces) {
    cleanup()
    surface.classList.remove('knowledge-border-surface')
    surface.classList.remove('knowledge-card-surface')
    surface.style.removeProperty('--knowledge-pointer-x')
    surface.style.removeProperty('--knowledge-pointer-y')
  }
  for (const [list, cleanup] of animatedLists) {
    cleanup()
    list.classList.remove('knowledge-animated-list')
  }
  glassSurfaces.clear()
  borderSurfaces.clear()
  animatedLists.clear()
  motionPlayedAt.clear()
  filterBank?.remove()
  filterBank = undefined
}

window.DshKnowledgeEffects?.destroy()
window.DshKnowledgeEffects = { refresh, destroy }

export { destroy, refresh }
