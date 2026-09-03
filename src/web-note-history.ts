export interface NoteHistoryItem {
  noteId: string
  version: number
  name: string
  mediaType: string | null
  size: number
  sha256: string
  createdAt: string
}

interface NoteHistoryViewOptions {
  versions: NoteHistoryItem[]
  currentVersion: number
  currentContent: string
  loadContent(version: NoteHistoryItem, signal: AbortSignal): Promise<string>
  renderPreview(content: string): HTMLElement
  renderDiff(historical: string, current: string): HTMLElement
  formatDate(value: string): string
  formatBytes(value: number): string
  onRestore(version: NoteHistoryItem, content: string): Promise<void>
  onError(error: unknown): void
}

export interface NoteHistoryView {
  element: HTMLElement
  destroy(): void
}

const CONTENT_CACHE_LIMIT = 4

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}

export function createNoteHistoryView(options: NoteHistoryViewOptions): NoteHistoryView {
  const root = node('div', 'note-history-workspace')
  let mode: 'preview' | 'diff' = 'preview'
  let selected = options.versions[0]
  let selectedContent = ''
  let contentLoaded = false
  let request = 0
  let controller: AbortController | undefined
  let destroyed = false
  const cache = new Map<number, string>()
  const timeline = node('nav', 'note-history-timeline')
  timeline.setAttribute('aria-label', '页面历史版本')
  const timelineHeading = node('div', 'note-history-timeline-heading')
  timelineHeading.append(node('strong', '', '保存记录'), node('span', '', `最近 ${options.versions.length} 个版本`))
  const versionList = node('div', 'note-history-version-list')
  timeline.append(timelineHeading, versionList)

  const detail = node('section', 'note-history-detail')
  detail.setAttribute('aria-live', 'polite')
  const detailHeader = node('header', 'note-history-detail-header')
  const detailCopy = node('div', 'note-history-detail-copy')
  const detailTitle = node('strong')
  const detailMeta = node('span')
  detailCopy.append(detailTitle, detailMeta)
  const detailActions = node('div', 'note-history-detail-actions')
  const previewButton = modeButton('内容预览', 'preview')
  const diffButton = modeButton('与当前比较', 'diff')
  const restoreButton = node('button', 'button primary small', '恢复为新版本')
  restoreButton.type = 'button'
  detailActions.append(previewButton, diffButton, restoreButton)
  detailHeader.append(detailCopy, detailActions)
  const content = node('div', 'note-history-content')
  detail.append(detailHeader, content)
  root.append(timeline, detail)

  function modeButton(label: string, value: 'preview' | 'diff'): HTMLButtonElement {
    const button = node('button', 'note-history-mode', label)
    button.type = 'button'
    button.dataset.mode = value
    button.setAttribute('aria-pressed', String(mode === value))
    button.addEventListener('click', () => {
      mode = value
      syncMode()
      renderSelectedContent()
    })
    return button
  }

  function syncMode(): void {
    previewButton.setAttribute('aria-pressed', String(mode === 'preview'))
    diffButton.setAttribute('aria-pressed', String(mode === 'diff'))
  }

  function putCache(version: number, value: string): void {
    cache.delete(version)
    cache.set(version, value)
    while (cache.size > CONTENT_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as number | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  function syncVersionButtons(): void {
    for (const button of versionList.querySelectorAll<HTMLButtonElement>('[data-note-version]')) {
      const active = Number(button.dataset.noteVersion) === selected?.version
      button.setAttribute('aria-current', active ? 'true' : 'false')
    }
  }

  function syncDetailHeader(): void {
    if (!selected) return
    const current = selected.version === options.currentVersion
    detailTitle.textContent = `版本 ${selected.version}${current ? ' · 当前' : ''}`
    detailMeta.textContent = `${options.formatDate(selected.createdAt)} · ${options.formatBytes(selected.size)}`
    const sameContent = contentLoaded && selectedContent === options.currentContent
    restoreButton.disabled = current || !contentLoaded || sameContent
    restoreButton.textContent = current ? '当前版本' : sameContent ? '内容相同' : '恢复为新版本'
  }

  function renderSelectedContent(): void {
    if (!contentLoaded) {
      content.replaceChildren(node('div', 'note-history-loading', '正在读取版本内容…'))
      return
    }
    content.replaceChildren(mode === 'preview'
      ? options.renderPreview(selectedContent)
      : options.renderDiff(selectedContent, options.currentContent))
  }

  async function selectVersion(version: NoteHistoryItem): Promise<void> {
    selected = version
    selectedContent = ''
    contentLoaded = false
    syncVersionButtons()
    syncDetailHeader()
    renderSelectedContent()
    const currentRequest = ++request
    controller?.abort()
    controller = new AbortController()
    try {
      const cached = cache.get(version.version)
      const loaded = cached ?? await options.loadContent(version, controller.signal)
      if (destroyed || currentRequest !== request) return
      selectedContent = loaded
      contentLoaded = true
      putCache(version.version, loaded)
      syncDetailHeader()
      renderSelectedContent()
    } catch (error) {
      if (destroyed || currentRequest !== request || (error instanceof DOMException && error.name === 'AbortError')) return
      content.replaceChildren(node('div', 'note-history-error', '无法读取这个历史版本。'))
      options.onError(error)
    }
  }

  for (const version of options.versions) {
    const current = version.version === options.currentVersion
    const button = node('button', 'note-history-version')
    button.type = 'button'
    button.dataset.noteVersion = String(version.version)
    button.append(
      node('strong', '', `版本 ${version.version}${current ? ' · 当前' : ''}`),
      node('span', '', options.formatDate(version.createdAt)),
      node('small', '', options.formatBytes(version.size)),
    )
    button.addEventListener('click', () => { void selectVersion(version) })
    versionList.append(button)
  }

  restoreButton.addEventListener('click', async () => {
    if (!selected || !contentLoaded || restoreButton.disabled) return
    restoreButton.disabled = true
    restoreButton.setAttribute('aria-busy', 'true')
    restoreButton.textContent = '正在恢复…'
    try {
      await options.onRestore(selected, selectedContent)
    } catch (error) {
      if (!destroyed) {
        restoreButton.disabled = false
        restoreButton.removeAttribute('aria-busy')
        syncDetailHeader()
        options.onError(error)
      }
    }
  })

  if (selected) void selectVersion(selected)
  else content.replaceChildren(node('div', 'note-history-error', '还没有可查看的保存记录。'))

  return {
    element: root,
    destroy: () => {
      destroyed = true
      request += 1
      controller?.abort()
      cache.clear()
    },
  }
}
