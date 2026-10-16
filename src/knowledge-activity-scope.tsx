import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { IconChevronDownOutlineRegular, IconDatabaseOutlineRegular, IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResolvedKnowledgeMount } from './domain.js'

/** Controlled selection, with the same focus/keyboard contract as the web select. */
export function KnowledgeActivityScope({ mounts, selectedId, onSelect }: {
  mounts: ResolvedKnowledgeMount[]
  selectedId: string | undefined
  onSelect(id: string): void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  function dismiss(restore = false): void {
    setOpen(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!open) return
    const selected = root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?? root.current?.querySelector<HTMLButtonElement>('[role="option"]')
    selected?.focus({ preventScroll: true })
    selected?.scrollIntoView({ block: 'nearest' })
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  function navigate(event: KeyboardEvent<HTMLDivElement>): void {
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: HTMLButtonElement | undefined
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(true); return }
    if (event.key === 'Tab') { dismiss(true); return }
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length]
    if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length]
    if (event.key === 'Home') next = items[0]
    if (event.key === 'End') next = items.at(-1)
    if (next) { event.preventDefault(); event.stopPropagation(); next.focus() }
  }
  const selected = mounts.find(mount => mount.knowledgeBaseId === selectedId)?.base.name || '选择知识库'
  return <div ref={root} className="dsh-knowledge-activity-scope" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className="dsh-knowledge-activity-scope-trigger" aria-haspopup="listbox" aria-controls={id} aria-expanded={open}
      title={selected} onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
        if (event.key === 'Escape') dismiss()
      }}>
      <span className="dsh-knowledge-activity-scope-icon"><IconDatabaseOutlineRegular size={15} /></span>
      <span><small>当前知识库</small><strong>{selected}</strong></span>
      <IconChevronDownOutlineRegular size={14} className={open ? 'is-open' : ''} />
    </button>
    {open && <div id={id} className="dsh-knowledge-activity-scope-menu" role="listbox" aria-label="切换知识库" onKeyDown={navigate}>
      {mounts.map(mount => <button key={mount.knowledgeBaseId} type="button" role="option" tabIndex={-1}
        aria-selected={selectedId === mount.knowledgeBaseId} title={mount.base.name}
        className={selectedId === mount.knowledgeBaseId ? 'is-active' : ''}
        onClick={() => { dismiss(true); onSelect(mount.knowledgeBaseId) }}>
        <IconDataOutlineRegular size={15} /><span><strong>{mount.base.name}</strong><small>{mount.inheritedFrom === 'project' ? '项目挂载' : '会话挂载'}</small></span>
      </button>)}
    </div>}
  </div>
}
