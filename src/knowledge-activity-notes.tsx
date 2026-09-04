import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconDataOutline16,
  IconFolderOpenOutline16,
  IconRefreshOutline14,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { NoteNode } from './notes/domain.js'
import { loadNoteContent, loadNoteIndex, type KnowledgeActivityNoteContent } from './knowledge-activity-api.js'
import type { KnowledgeActivityController } from './knowledge-activity-controller.js'
import { renderMarkdown } from './web-markdown-preview.js'

interface NotesPaneProps {
  sessionId: string
  projectId?: string
  controller: KnowledgeActivityController
}

interface FolderCrumb { id: string | null; name: string }

export function KnowledgeActivityNotes({ sessionId, projectId, controller }: NotesPaneProps): JSX.Element {
  const initial = controller.selection(sessionId)
  const [folderId, setFolderId] = useState<string | null>(initial.noteFolderId ?? null)
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([{ id: null, name: '全部笔记' }])
  const [selectedId, setSelectedId] = useState(initial.noteDocumentId)
  const [nodes, setNodes] = useState<NoteNode[]>([])
  const [content, setContent] = useState<KnowledgeActivityNoteContent>()
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [contentState, setContentState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  const loadNodes = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setListState('loading')
    setError('')
    try {
      const value = await loadNoteIndex({
        sessionId,
        ...projectId === undefined ? {} : { projectId },
        parentId: folderId,
        query,
        ...signal === undefined ? {} : { signal },
      })
      setNodes(value)
      setListState('ready')
    } catch (reason) {
      if (signal?.aborted) return
      setListState('error')
      setError(message(reason))
    }
  }, [folderId, projectId, query, sessionId])

  useEffect(() => {
    const abort = new AbortController()
    void loadNodes(abort.signal)
    return () => { abort.abort() }
  }, [loadNodes, refresh])

  useEffect(() => {
    if (selectedId === undefined) {
      setContent(undefined)
      setContentState('idle')
      return
    }
    const abort = new AbortController()
    setContentState('loading')
    setError('')
    void loadNoteContent({
      id: selectedId,
      sessionId,
      ...projectId === undefined ? {} : { projectId },
      signal: abort.signal,
    }).then(value => {
      setContent(value)
      setContentState('ready')
    }).catch(reason => {
      if (abort.signal.aborted) return
      setContentState('error')
      setError(message(reason))
    })
    return () => { abort.abort() }
  }, [projectId, refresh, selectedId, sessionId])

  const openFolder = (node: NoteNode): void => {
    setFolderId(node.id)
    setCrumbs(current => [...current, { id: node.id, name: node.name }])
    setQuery('')
    setQueryInput('')
    controller.select(sessionId, { ...controller.selection(sessionId), mode: 'notes', noteFolderId: node.id, noteDocumentId: undefined })
  }
  const openCrumb = (crumb: FolderCrumb, index: number): void => {
    setFolderId(crumb.id)
    setCrumbs(current => current.slice(0, index + 1))
    setSelectedId(undefined)
    controller.select(sessionId, { ...controller.selection(sessionId), mode: 'notes', noteFolderId: crumb.id, noteDocumentId: undefined })
  }
  const openNode = (node: NoteNode): void => {
    if (node.kind === 'folder') return openFolder(node)
    if (!node.editable) return
    setSelectedId(node.id)
    controller.select(sessionId, { ...controller.selection(sessionId), mode: 'notes', noteFolderId: folderId, noteDocumentId: node.id })
  }
  const closeDocument = (): void => {
    setSelectedId(undefined)
    setContent(undefined)
    controller.select(sessionId, { ...controller.selection(sessionId), mode: 'notes', noteFolderId: folderId, noteDocumentId: undefined })
  }
  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    setSelectedId(undefined)
    setContent(undefined)
    setQuery(queryInput.trim())
  }

  if (selectedId !== undefined) return <NoteReader
    value={content}
    state={contentState}
    error={error}
    onBack={closeDocument}
    onRetry={() => setRefresh(value => value + 1)}
  />

  return <div className="dsh-knowledge-activity-browser">
    <form className="dsh-knowledge-activity-search" role="search" onSubmit={submitSearch}>
      <IconSearchOutline16 size={16} aria-hidden="true" />
      <input aria-label="搜索笔记文档" value={queryInput} placeholder="搜索笔记和目录…" onChange={event => setQueryInput(event.target.value)} />
      {queryInput && <button type="button" onClick={() => { setQueryInput(''); setQuery('') }} aria-label="清除搜索"><IconCloseOutline16 size={14} /></button>}
    </form>

    {!query && <nav className="dsh-knowledge-activity-breadcrumbs" aria-label="笔记目录路径">
      {crumbs.map((crumb, index) => <span key={`${crumb.id ?? 'root'}-${index}`}>
        {index > 0 && <IconChevronRightOutline14 size={12} />}
        <button type="button" aria-current={index === crumbs.length - 1 ? 'location' : undefined} onClick={() => openCrumb(crumb, index)}>{crumb.name}</button>
      </span>)}
    </nav>}

    <div className="dsh-knowledge-activity-list-heading">
      <span><strong>{query ? `“${query}” 的结果` : crumbs.at(-1)?.name ?? '笔记文档'}</strong><small>{query ? '搜索全部笔记' : `当前显示 ${nodes.length} 项`}</small></span>
      <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="刷新笔记" title="刷新" onClick={() => setRefresh(value => value + 1)}><IconRefreshOutline14 size={14} /></button>
    </div>
    <div className="dsh-knowledge-activity-list" aria-busy={listState === 'loading'}>
      {listState === 'loading' && nodes.length === 0 ? <ActivityState label="正在读取笔记…" />
        : listState === 'error' ? <ActivityError error={error} onRetry={() => setRefresh(value => value + 1)} />
          : nodes.length === 0 ? <ActivityEmpty query={query} />
            : nodes.map(node => <button type="button" key={node.id} className="dsh-knowledge-activity-row" disabled={node.kind !== 'folder' && !node.editable} onClick={() => openNode(node)}>
              <span className="dsh-knowledge-activity-row-icon">{node.kind === 'folder' ? <IconFolderOpenOutline16 size={16} /> : <IconDataOutline16 size={16} />}</span>
              <span className="dsh-knowledge-activity-row-copy"><strong>{node.name}</strong><small>{node.kind === 'folder' ? '目录' : node.editable ? formatSize(node.size) : '暂不支持侧栏预览'}</small></span>
              <span className="dsh-knowledge-activity-row-meta"><time dateTime={node.updatedAt}>{formatDate(node.updatedAt)}</time>{node.kind === 'folder' && <IconChevronRightOutline14 size={13} />}</span>
            </button>)}
    </div>
  </div>
}

function NoteReader({ value, state, error, onBack, onRetry }: {
  value: KnowledgeActivityNoteContent | undefined
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  onBack(): void
  onRetry(): void
}): JSX.Element {
  const html = useMemo(() => value === undefined ? '' : renderMarkdown(value.content), [value])
  return <div className="dsh-knowledge-activity-reader">
    <div className="dsh-knowledge-activity-reader-bar">
      <button type="button" className="dsh-knowledge-activity-back" onClick={onBack}><IconChevronLeftOutline14 size={14} />笔记目录</button>
      {value && <span>{formatDate(value.node.updatedAt)} 更新</span>}
    </div>
    {state === 'loading' ? <ActivityState label="正在打开笔记…" />
      : state === 'error' ? <ActivityError error={error} onRetry={onRetry} />
        : value === undefined ? <ActivityState label="正在准备笔记…" />
          : <><div className="dsh-knowledge-activity-document-heading">
            <span className="dsh-knowledge-activity-document-icon"><IconDataOutline16 size={18} /></span>
            <div><h2>{value.node.name}</h2><p>笔记文档 · {formatSize(value.node.size)}</p></div>
          </div>
          <article className="dsh-knowledge-activity-markdown" dangerouslySetInnerHTML={{ __html: html }} /></>}
  </div>
}

function ActivityState({ label }: { label: string }): JSX.Element {
  return <p className="dsh-knowledge-activity-state" role="status"><span aria-hidden="true" />{label}</p>
}

function ActivityError({ error, onRetry }: { error: string; onRetry(): void }): JSX.Element {
  return <div className="dsh-knowledge-activity-error" role="alert"><strong>暂时无法读取</strong><p>{error}</p><button type="button" onClick={onRetry}>重试</button></div>
}

function ActivityEmpty({ query }: { query: string }): JSX.Element {
  return <div className="dsh-knowledge-activity-empty"><span><IconDataOutline16 size={20} /></span><strong>{query ? '没有找到相关笔记' : '这个目录还是空的'}</strong><p>{query ? '换个关键词，或清除搜索后浏览目录。' : '可以在完整工作区中新建或导入笔记。'}</p></div>
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

function formatSize(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
