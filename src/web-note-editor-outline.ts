import type { Editor } from '@tiptap/core'

interface HeadingItem {
  level: number
  position: number
  text: string
  element: HTMLElement | null
}

interface NoteOutlineOptions {
  editor: Editor
  frame: HTMLElement
  host: HTMLElement
  toggleButton?: HTMLButtonElement | null
}

export interface NoteOutlineController {
  toggle(): void
  close(): void
  destroy(): void
}

const REBUILD_DELAY = 140

function collectHeadings(editor: Editor): HeadingItem[] {
  const headings: HeadingItem[] = []
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== 'heading') return true
    const text = node.textContent.trim()
    if (!text) return false
    headings.push({
      level: Number(node.attrs.level) || 1,
      position,
      text: text.slice(0, 160),
      element: editor.view.nodeDOM(position) as HTMLElement | null,
    })
    return false
  })
  return headings
}

export function createNoteOutlineController(options: NoteOutlineOptions): NoteOutlineController {
  const { editor, frame, host, toggleButton } = options
  host.replaceChildren()

  const header = document.createElement('header')
  header.className = 'notes-editor-outline-header'
  const title = document.createElement('strong')
  title.textContent = '文档大纲'
  const count = document.createElement('span')
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'notes-editor-outline-close'
  closeButton.textContent = '关闭'
  closeButton.setAttribute('aria-label', '关闭文档大纲')
  header.append(title, count, closeButton)

  const list = document.createElement('nav')
  list.className = 'notes-editor-outline-list'
  list.setAttribute('aria-label', '笔记标题导航')
  host.append(header, list)

  let headings: HeadingItem[] = []
  let open = false
  let manuallyToggled = false
  let rebuildTimer: number | undefined
  let observer: IntersectionObserver | undefined

  function syncOpenState(): void {
    frame.dataset.outlineOpen = String(open)
    host.setAttribute('aria-hidden', String(!open))
    host.inert = !open
    toggleButton?.setAttribute('aria-pressed', String(open))
    toggleButton?.setAttribute('aria-expanded', String(open))
    if (open) observeHeadings()
    else observer?.disconnect()
  }

  function setActive(position: number): void {
    for (const button of list.querySelectorAll<HTMLButtonElement>('[data-heading-position]')) {
      const active = Number(button.dataset.headingPosition) === position
      if (active) button.setAttribute('aria-current', 'location')
      else button.removeAttribute('aria-current')
    }
  }

  function jumpToHeading(item: HeadingItem): void {
    editor.commands.setTextSelection(item.position + 1)
    editor.view.dom.focus({ preventScroll: true })
    item.element?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    })
    setActive(item.position)
    if (window.matchMedia('(max-width: 760px)').matches) {
      open = false
      syncOpenState()
    }
  }

  function renderHeadings(): void {
    count.textContent = headings.length ? `${headings.length} 个标题` : ''
    list.replaceChildren()
    if (!headings.length) {
      const empty = document.createElement('p')
      empty.className = 'notes-editor-outline-empty'
      empty.textContent = '使用标题 1–3 后，会在这里生成可定位的大纲。'
      list.append(empty)
      return
    }
    const fragment = document.createDocumentFragment()
    for (const item of headings) {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'notes-editor-outline-link'
      link.textContent = item.text
      link.dataset.headingPosition = String(item.position)
      link.style.setProperty('--outline-depth', String(Math.max(0, Math.min(4, item.level - 1))))
      link.addEventListener('click', () => jumpToHeading(item))
      fragment.append(link)
    }
    list.append(fragment)
  }

  function observeHeadings(): void {
    observer?.disconnect()
    if (!open || !('IntersectionObserver' in window)) return
    observer = new IntersectionObserver(entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
      const target = visible[0]?.target
      const item = headings.find(heading => heading.element === target)
      if (item) setActive(item.position)
    }, {
      root: frame.querySelector('.notes-document-scroll'),
      rootMargin: '-12px 0px -78% 0px',
      threshold: 0,
    })
    for (const item of headings) if (item.element) observer.observe(item.element)
  }

  function rebuild(): void {
    rebuildTimer = undefined
    if (editor.isDestroyed) return
    const next = collectHeadings(editor)
    const changed = next.length !== headings.length || next.some((item, index) => {
      const previous = headings[index]
      return !previous || previous.position !== item.position || previous.level !== item.level || previous.text !== item.text
    })
    headings = next
    if (changed) renderHeadings()
    if (!manuallyToggled && headings.length && !window.matchMedia('(max-width: 980px)').matches) open = true
    if (!headings.length && !manuallyToggled) open = false
    syncOpenState()
  }

  function scheduleRebuild(): void {
    if (rebuildTimer !== undefined) window.clearTimeout(rebuildTimer)
    rebuildTimer = window.setTimeout(rebuild, REBUILD_DELAY)
  }

  function toggle(): void {
    manuallyToggled = true
    open = !open
    syncOpenState()
  }

  function close(): void {
    manuallyToggled = true
    open = false
    syncOpenState()
  }

  closeButton.addEventListener('click', close)
  editor.on('update', scheduleRebuild)
  rebuild()

  return {
    toggle,
    close,
    destroy: () => {
      editor.off('update', scheduleRebuild)
      if (rebuildTimer !== undefined) window.clearTimeout(rebuildTimer)
      observer?.disconnect()
      host.replaceChildren()
      delete frame.dataset.outlineOpen
    },
  }
}
