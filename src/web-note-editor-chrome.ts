import type { Editor } from '@tiptap/core'
import { createNoteFindController } from './web-note-editor-find.js'
import { createNoteOutlineController } from './web-note-editor-outline.js'
import { createNoteSelectionMenu } from './web-note-editor-selection.js'

interface NoteEditorChromeOptions {
  editor: Editor
  frame: HTMLElement
  scrollHost: HTMLElement
  outlineHost: HTMLElement
  findButton?: HTMLButtonElement | null
  outlineButton?: HTMLButtonElement | null
}

export interface NoteEditorChrome {
  openFind(): void
  toggleOutline(): void
  destroy(): void
}

export function createNoteEditorChrome(options: NoteEditorChromeOptions): NoteEditorChrome {
  let selectionMenu: ReturnType<typeof createNoteSelectionMenu> | undefined
  const find = createNoteFindController({
    editor: options.editor,
    frame: options.frame,
    onVisibilityChange: open => {
      options.findButton?.setAttribute('aria-pressed', String(open))
      if (open) selectionMenu?.hide()
    },
  })
  const outline = createNoteOutlineController({
    editor: options.editor,
    frame: options.frame,
    host: options.outlineHost,
    ...(options.outlineButton !== undefined ? { toggleButton: options.outlineButton } : {}),
  })
  selectionMenu = createNoteSelectionMenu({
    editor: options.editor,
    frame: options.frame,
    scrollHost: options.scrollHost,
    findIsOpen: find.isOpen,
  })

  options.findButton?.setAttribute('aria-pressed', 'false')

  return {
    openFind: () => find.open(),
    toggleOutline: () => outline.toggle(),
    destroy: () => {
      selectionMenu?.destroy()
      outline.destroy()
      find.destroy()
    },
  }
}
