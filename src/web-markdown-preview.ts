import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.use({
  gfm: true,
  breaks: false,
})

/** Render knowledge Markdown for the management console without trusting document HTML. */
export function renderMarkdown(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false })
  const sanitized = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio'],
    FORBID_ATTR: ['style'],
    RETURN_TRUSTED_TYPE: false,
    USE_PROFILES: { html: true },
  })
  const template = document.createElement('template')
  template.innerHTML = sanitized
  for (const link of template.content.querySelectorAll('a')) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  return template.innerHTML
}
