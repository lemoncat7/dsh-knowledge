import { useEffect, useId, useRef, useState } from 'react'

/** Shared read-only document body. Headings come from the sanitized rendered DOM,
 * so code fences, duplicate names and inline formatting match the actual page. */
export function KnowledgeActivityMarkdown({ html }: { html: string }): JSX.Element {
  const article = useRef<HTMLElement>(null)
  const outlineId = useId()
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [headings, setHeadings] = useState<{ text: string; level: number }[]>([])
  useEffect(() => {
    setHeadings(Array.from(article.current?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? []).map(node => ({
      text: node.textContent?.trim() || '未命名标题', level: Number(node.tagName.slice(1)),
    })))
  }, [html])
  const jump = (index: number): void => {
    const heading = article.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[index]
    const reader = article.current
    if (!heading || !reader) return
    reader.scrollTo({ top: reader.scrollTop + heading.getBoundingClientRect().top - reader.getBoundingClientRect().top - 12, behavior: 'auto' })
    heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
  }
  const firstLevel = Math.min(...headings.map(item => item.level), 6)
  return <div className="dsh-knowledge-activity-reading-layout" data-outline-open={outlineOpen}>
    <article ref={article} className="dsh-knowledge-activity-markdown" dangerouslySetInnerHTML={{ __html: html }} />
    <aside className="dsh-knowledge-activity-outline" aria-label="正文右侧大纲">
      <button type="button" className="dsh-knowledge-activity-outline-toggle" aria-label={outlineOpen ? '收起大纲' : '展开大纲'} title={outlineOpen ? '收起大纲' : '展开大纲'} aria-expanded={outlineOpen} aria-controls={outlineId} onClick={() => setOutlineOpen(value => !value)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 5h16v14H4zM14 5v14M17 9h1M17 12h1M17 15h1" /></svg>
        {outlineOpen && <><strong>大纲</strong><small>{headings.length}</small></>}
      </button>
      <nav id={outlineId} aria-label="文档大纲" hidden={!outlineOpen}>
        {headings.length ? headings.map((item, index) =>
          <button type="button" key={index} title={item.text} style={{ paddingInlineStart: 6 + (item.level - firstLevel) * 10 }} onClick={() => jump(index)}>{item.text}</button>)
          : <span className="dsh-knowledge-activity-outline-empty">暂无标题</span>}
      </nav>
    </aside>
  </div>
}
