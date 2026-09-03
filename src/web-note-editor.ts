import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Image from '@tiptap/extension-image'
import Paragraph from '@tiptap/extension-paragraph'
import { TableKit } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Text from '@tiptap/extension-text'
import { Placeholder, UndoRedo } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { createNoteEditorChrome, type NoteEditorChrome } from './web-note-editor-chrome.js'
import { NoteSearch } from './web-note-editor-search.js'

export interface MarkdownEditorOptions {
  host: HTMLElement
  frame?: HTMLElement
  scrollHost?: HTMLElement
  outlineHost?: HTMLElement
  findButton?: HTMLButtonElement | null
  outlineButton?: HTMLButtonElement | null
  markdown: string
  label: string
  onChange(markdown: string): void
  onSave(): void
}

export interface MarkdownEditorHandle {
  getMarkdown(): string
  focus(): void
  insertMarkdown(markdown: string): void
  openFind(): void
  toggleOutline(): void
  destroy(): void
}

export interface PlainTextEditorOptions {
  host: HTMLElement
  text: string
  label: string
  onChange(text: string): void
  onSave(): void
}

export interface PlainTextEditorHandle {
  focus(): void
  destroy(): void
}

/**
 * Mount a Markdown-native rich text editor into the notes workspace.
 *
 * The management application owns loading and persistence. This module owns
 * only Markdown parsing, editing and serialization so its lifecycle remains
 * independent from the surrounding vanilla DOM renderer.
 */
export function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditorHandle {
  let chrome: NoteEditorChrome | undefined
  const editor = new Editor({
    element: options.host,
    content: options.markdown,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({
        link: {
          autolink: true,
          openOnClick: false,
          HTMLAttributes: { rel: 'noopener noreferrer' },
        },
      }),
      Markdown,
      NoteSearch,
      Placeholder.configure({ placeholder: '输入正文，或使用 Markdown 快捷语法…' }),
      Image.configure({ allowBase64: false, inline: false }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    editorProps: {
      attributes: {
        class: 'notes-live-editor-surface',
        role: 'textbox',
        'aria-label': options.label,
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      handleKeyDown: (_view, event) => {
        if (!(event.metaKey || event.ctrlKey)) return false
        const key = event.key.toLocaleLowerCase()
        if (key === 's') {
          event.preventDefault()
          options.onSave()
          return true
        }
        if (key === 'f') {
          event.preventDefault()
          chrome?.openFind()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: current }) => options.onChange(current.getMarkdown()),
  })

  if (options.frame && options.scrollHost && options.outlineHost) {
    chrome = createNoteEditorChrome({
      editor,
      frame: options.frame,
      scrollHost: options.scrollHost,
      outlineHost: options.outlineHost,
      ...(options.findButton !== undefined ? { findButton: options.findButton } : {}),
      ...(options.outlineButton !== undefined ? { outlineButton: options.outlineButton } : {}),
    })
  }

  return {
    getMarkdown: () => editor.getMarkdown(),
    focus: () => editor.commands.focus(),
    insertMarkdown: markdown => {
      editor.commands.insertContent(markdown, { contentType: 'markdown' })
      editor.commands.focus()
    },
    openFind: () => chrome?.openFind(),
    toggleOutline: () => chrome?.toggleOutline(),
    destroy: () => {
      chrome?.destroy()
      chrome = undefined
      editor.destroy()
    },
  }
}

/**
 * Mount a document-shaped plain-text editor.
 *
 * Each stored line is represented by one paragraph node. Visual wrapping stays
 * inside that paragraph, so the UI can number logical lines without measuring
 * rendered text or interfering with the browser selection.
 */
export function createPlainTextEditor(options: PlainTextEditorOptions): PlainTextEditorHandle {
  const editor = new Editor({
    element: options.host,
    content: plainTextToDocument(options.text),
    extensions: [
      Document.extend({ content: 'paragraph*' }),
      Paragraph,
      Text,
      UndoRedo,
    ],
    editorProps: {
      attributes: {
        class: 'notes-plain-editor-surface',
        role: 'textbox',
        'aria-label': options.label,
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      handleKeyDown: (_view, event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 's') return false
        event.preventDefault()
        options.onSave()
        return true
      },
    },
    onUpdate: ({ editor: current }) => options.onChange(plainTextFromDocument(current.getJSON())),
  })

  return {
    focus: () => editor.commands.focus(),
    destroy: () => editor.destroy(),
  }
}

export function plainTextToDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.replace(/\r\n?/g, '\n').split('\n').map(line => ({
      type: 'paragraph',
      ...line ? { content: [{ type: 'text', text: line }] } : {},
    })),
  }
}

export function plainTextFromDocument(document: JSONContent): string {
  return (document.content ?? []).map(paragraph =>
    (paragraph.content ?? []).map(node => node.text ?? '').join(''),
  ).join('\n')
}
