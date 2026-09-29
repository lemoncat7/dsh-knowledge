import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export function Markdown({ text, onEvidence }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text.replace(/\[依据:([^\]]+)\]/g, (_, id) => `[查看依据](#worklog-source-${encodeURIComponent(id)})`), { async: false }), {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'style', 'input', 'form'],
    FORBID_ATTR: ['style'],
  }), [text])
  return <div className="wl-markdown" dangerouslySetInnerHTML={{ __html: html }} onClick={e => {
    const link = e.target.closest('a')
    if (link) {
      e.preventDefault()
      if (link.hash.startsWith('#worklog-source-')) {
        let source
        try { source = decodeURIComponent(link.hash.slice(16)) } catch { return /* Invalid user-authored fragment is not a source ID. */ }
        onEvidence?.(source); return
      }
      if (/^https?:\/\//i.test(link.href)) window.open(link.href, '_blank', 'noopener,noreferrer')
    }
  }} />
}

