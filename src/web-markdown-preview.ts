import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.use({
  gfm: true,
  breaks: false,
})

const SAFE_LINK_PATTERN = /^(?:(?:https?|mailto|tel):|note:\/\/note_[a-f0-9]{32}$|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i
const NOTE_LINK_PATTERN = /^note:\/\/(note_[a-f0-9]{32})$/

/** Render knowledge Markdown for the management console without trusting document HTML. */
export function renderMarkdown(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false })
  const sanitized = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio'],
    FORBID_ATTR: ['style'],
    RETURN_TRUSTED_TYPE: false,
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: SAFE_LINK_PATTERN,
  })
  const template = document.createElement('template')
  template.innerHTML = sanitized
  for (const link of template.content.querySelectorAll('a')) {
    const note = NOTE_LINK_PATTERN.exec(link.getAttribute('href') ?? '')
    if (note?.[1]) {
      link.removeAttribute('href')
      link.dataset.noteId = note[1]
      link.classList.add('note-reference')
      continue
    }
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  return template.innerHTML
}
