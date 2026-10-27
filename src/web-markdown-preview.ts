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
  return sanitizeMarkdown(marked.parse(markdown, { async: false }))
}

/** Block-level source locations, assigned after sanitization; never trust HTML attributes. */
export function renderMarkdownSource(markdown: string): string {
  const body = markdown.replace(/\r\n?/g, '\n')
  const tokens = marked.lexer(body)
  const container = document.createElement('div')
  let offset = 0, line = 1
  for (const token of tokens) {
    const start = body.indexOf(token.raw, offset)
    if (start < 0) continue
    line += (body.slice(offset, start).match(/\n/g) || []).length
    const block = document.createElement('section')
    block.dataset.sourceStart = String(line)
    block.dataset.sourceEnd = String(line + (token.raw.replace(/\n+$/, '').match(/\n/g) || []).length)
    block.innerHTML = sanitizeMarkdown(marked.parser(Object.assign([token], { links: tokens.links })))
    if (block.childNodes.length) container.append(block)
    line += (token.raw.match(/\n/g) || []).length
    offset = start + token.raw.length
  }
  return container.innerHTML
}

function sanitizeMarkdown(rendered: string): string {
  const sanitized = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio'],
    FORBID_ATTR: ['style', 'data-source-start', 'data-source-end'],
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
