import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronLeftOutline14,
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconDatabaseOutline16,
  IconDataOutline16,
  IconRefreshOutline14,
  IconSearchOutline16,
  IconFullscreenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeDocument, KnowledgeDocumentSummary, ResolvedKnowledgeMount } from './domain.js'
import {
  loadKnowledgeDocument,
  loadKnowledgeDocumentIndex,
  loadMountedKnowledge,
} from './knowledge-activity-api.js'
import type { KnowledgeActivityController } from './knowledge-activity-controller.js'
import { KnowledgeActivityNotes } from './knowledge-activity-notes.js'
import { renderMarkdown } from './web-markdown-preview.js'

type DetailsProps = PropsRuntime<'details'>

export function KnowledgeActivityPanel(
  props: DetailsProps & { controller: KnowledgeActivityController },
): JSX.Element {
  const sessionId = String(props.sessionId)
  const projectId = props.useSessions((state: SessionListState) => state.byId[sessionId]?.cwd)
  const initial = props.controller.selection(sessionId)
  const [mode, setMode] = useState<'knowledge' | 'notes'>(initial.mode ?? 'knowledge')
  const [mounts, setMounts] = useState<ResolvedKnowledgeMount[]>([])
  const [selectedBaseId, setSelectedBaseId] = useState(initial.knowledgeBaseId)
  const [selectedDocumentId, setSelectedDocumentId] = useState(initial.documentId)
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([])
  const [documentValue, setDocumentValue] = useState<KnowledgeDocument>()
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [mountState, setMountState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listState, setListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [documentState, setDocumentState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [documentRefresh, setDocumentRefresh] = useState(0)
  const [error, setError] = useState('')
  const [nextCursor, setNextCursor] = useState<string>()
  const [baseMenuOpen, setBaseMenuOpen] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!baseMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (!scopeRef.current?.contains(event.target as Node)) setBaseMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBaseMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [baseMenuOpen])

  const refreshMounts = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setMountState('loading')
    setError('')
    try {
      const next = await loadMountedKnowledge(sessionId, projectId, signal)
      setMounts(next)
      const current = props.controller.selection(sessionId)
      const selected = next.some(item => item.knowledgeBaseId === current.knowledgeBaseId)
        ? current.knowledgeBaseId
        : next[0]?.knowledgeBaseId
      props.controller.select(sessionId, {
        ...selected === undefined ? {} : { knowledgeBaseId: selected },
        ...selected === current.knowledgeBaseId && current.documentId !== undefined
          ? { documentId: current.documentId }
          : {},
      })
      setSelectedBaseId(selected)
      if (selected !== current.knowledgeBaseId) {
        setSelectedDocumentId(undefined)
        setDocumentValue(undefined)
      }
      setMountState('ready')
    } catch (reason) {
      if (signal?.aborted) return
      setMountState('error')
      setError(message(reason))
    }
  }, [projectId, props.controller, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void refreshMounts(controller.signal)
    return () => { controller.abort() }
  }, [refreshMounts])

  const loadIndex = useCallback(async (cursor?: string, append = false, signal?: AbortSignal): Promise<void> => {
    if (mounts.length === 0 || (query.length === 0 && selectedBaseId === undefined)) {
      setDocuments([])
      setNextCursor(undefined)
      setListState('ready')
      return
    }
    setListState('loading')
    setError('')
    try {
      const result = await loadKnowledgeDocumentIndex({
        sessionId,
        ...projectId === undefined ? {} : { projectId },
        knowledgeBaseIds: query ? mounts.map(item => item.knowledgeBaseId) : [selectedBaseId!],
        ...query ? { query } : {},
        ...cursor === undefined ? {} : { cursor },
        ...signal === undefined ? {} : { signal },
      })
      setDocuments(current => append ? [...current, ...result.items] : result.items)
      setNextCursor(result.nextCursor)
      setListState('ready')
    } catch (reason) {
      if (signal?.aborted) return
      setListState('error')
      setError(message(reason))
    }
  }, [mounts, projectId, query, selectedBaseId, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void loadIndex(undefined, false, controller.signal)
    return () => { controller.abort() }
  }, [loadIndex])

  useEffect(() => {
    if (selectedDocumentId === undefined) {
      setDocumentValue(undefined)
      setDocumentState('idle')
      return
    }
    const controller = new AbortController()
    setDocumentState('loading')
    setError('')
    void loadKnowledgeDocument({
      id: selectedDocumentId,
      sessionId,
      ...projectId === undefined ? {} : { projectId },
      signal: controller.signal,
    }).then(value => {
      setDocumentValue(value)
      setDocumentState('ready')
    }).catch(reason => {
      if (controller.signal.aborted) return
      setDocumentState('error')
      setError(message(reason))
    })
    return () => { controller.abort() }
  }, [documentRefresh, projectId, selectedDocumentId, sessionId])

  const selectBase = (knowledgeBaseId: string): void => {
    setBaseMenuOpen(false)
    setSelectedBaseId(knowledgeBaseId)
    setSelectedDocumentId(undefined)
    setDocumentValue(undefined)
    setQueryInput('')
    setQuery('')
    props.controller.select(sessionId, { mode: 'knowledge', knowledgeBaseId })
  }
  const selectDocument = (document: KnowledgeDocumentSummary): void => {
    setSelectedBaseId(document.knowledgeBaseId)
    setSelectedDocumentId(document.id)
    props.controller.select(sessionId, {
      mode: 'knowledge',
      knowledgeBaseId: document.knowledgeBaseId,
      documentId: document.id,
    })
  }
  const closeDocument = (): void => {
    setSelectedDocumentId(undefined)
    setDocumentValue(undefined)
    props.controller.select(sessionId, {
      mode: 'knowledge',
      ...selectedBaseId === undefined ? {} : { knowledgeBaseId: selectedBaseId },
    })
  }
  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    setSelectedDocumentId(undefined)
    setDocumentValue(undefined)
    setQuery(queryInput.trim())
  }
  const clearSearch = (): void => {
    setQueryInput('')
    setQuery('')
  }

  const workspaceTarget = mode === 'notes'
    ? { view: 'notes' as const }
    : documentValue === undefined ? undefined : {
      knowledgeBaseId: documentValue.knowledgeBaseId,
      documentId: documentValue.id,
    }

  const selectMode = (nextMode: 'knowledge' | 'notes'): void => {
    setMode(nextMode)
    setBaseMenuOpen(false)
    props.controller.select(sessionId, { ...props.controller.selection(sessionId), mode: nextMode })
  }

  return <section className="dsh-knowledge-activity-panel" data-xiaohei-surface="plugin-workspace" aria-label="会话知识库">
    <header className="dsh-knowledge-activity-header">
      <div className="dsh-knowledge-activity-title">
        <span className="dsh-knowledge-activity-mark"><IconDatabaseOutline16 size={17} /></span>
        <span><strong>知识库</strong><small>当前会话 · {shortId(sessionId)}</small></span>
      </div>
      <div className="dsh-knowledge-activity-header-actions">
        <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="在完整工作区中打开" title="完整工作区" onClick={() => props.controller.openWorkspace(workspaceTarget)}><IconFullscreenOutline16 size={16} /></button>
        <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="关闭会话知识库" title="关闭" onClick={() => props.controller.close(sessionId)}><IconCloseOutline16 size={16} /></button>
      </div>
    </header>

    <nav className="dsh-knowledge-activity-tabs" aria-label="知识库内容类型">
      <button type="button" className={mode === 'knowledge' ? 'is-active' : ''} aria-pressed={mode === 'knowledge'} onClick={() => selectMode('knowledge')}><IconDatabaseOutline16 size={15} />知识文档</button>
      <button type="button" className={mode === 'notes' ? 'is-active' : ''} aria-pressed={mode === 'notes'} onClick={() => selectMode('notes')}><IconDataOutline16 size={15} />笔记文档</button>
    </nav>

    {mode === 'notes'
      ? <KnowledgeActivityNotes sessionId={sessionId} projectId={projectId} controller={props.controller} />
      : selectedDocumentId === undefined
      ? <div className="dsh-knowledge-activity-browser">
        <form className="dsh-knowledge-activity-search" role="search" onSubmit={submitSearch}>
          <IconSearchOutline16 size={16} aria-hidden="true" />
          <input aria-label="搜索当前会话知识文档" value={queryInput} placeholder="搜索已挂载知识…" onChange={event => setQueryInput(event.target.value)} />
          {queryInput && <button type="button" onClick={clearSearch} aria-label="清除搜索"><IconCloseOutline16 size={14} /></button>}
        </form>

        {mountState === 'loading' ? <ActivityState label="正在读取会话挂载…" />
          : mountState === 'error' ? <ActivityError message={error} onRetry={() => { void refreshMounts() }} />
            : mounts.length === 0 ? <ActivityEmpty title="当前会话没有挂载知识库" description="在完整工作区中挂载后，就能在这里随手查阅文档。" />
              : <>
                <div ref={scopeRef} className="dsh-knowledge-activity-scope">
                  <button type="button" className="dsh-knowledge-activity-scope-trigger" aria-haspopup="listbox" aria-expanded={baseMenuOpen} onClick={() => setBaseMenuOpen(value => !value)}>
                    <span className="dsh-knowledge-activity-scope-icon"><IconDatabaseOutline16 size={15} /></span>
                    <span><small>当前知识库</small><strong>{mounts.find(item => item.knowledgeBaseId === selectedBaseId)?.base.name}</strong></span>
                    <IconChevronDownOutline14 size={14} className={baseMenuOpen ? 'is-open' : ''} />
                  </button>
                  {baseMenuOpen && <div className="dsh-knowledge-activity-scope-menu" role="listbox" aria-label="切换知识库">
                    {mounts.map(mount => <button
                      type="button"
                      role="option"
                      aria-selected={selectedBaseId === mount.knowledgeBaseId}
                      key={mount.knowledgeBaseId}
                      className={selectedBaseId === mount.knowledgeBaseId ? 'is-active' : ''}
                      onClick={() => selectBase(mount.knowledgeBaseId)}
                    ><IconDataOutline16 size={15} /><span><strong>{mount.base.name}</strong><small>{mount.inheritedFrom === 'project' ? '项目挂载' : '会话挂载'}</small></span></button>)}
                  </div>}
                </div>
                <div className="dsh-knowledge-activity-list-heading">
                  <span><strong>{query ? `“${query}” 的结果` : '知识文档'}</strong><small>{query ? '搜索全部已挂载知识库' : `当前显示 ${documents.length} 项`}</small></span>
                  <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="刷新文档" title="刷新" onClick={() => { void loadIndex() }}><IconRefreshOutline14 size={14} /></button>
                </div>
                <div className="dsh-knowledge-activity-list" aria-busy={listState === 'loading'}>
                  {listState === 'loading' && documents.length === 0 ? <ActivityState label="正在读取文档…" />
                    : listState === 'error' ? <ActivityError message={error} onRetry={() => { void loadIndex() }} />
                      : documents.length === 0 ? <ActivityEmpty title={query ? '没有找到相关文档' : '这里还没有知识文档'} description={query ? '换个关键词，或清除搜索后浏览目录。' : '审核通过或直接回写的知识会出现在这里。'} />
                        : <>{documents.map(document => <DocumentRow
                          key={document.id}
                          document={document}
                          baseName={query ? mounts.find(item => item.knowledgeBaseId === document.knowledgeBaseId)?.base.name : undefined}
                          onClick={() => selectDocument(document)}
                        />)}
                        {nextCursor && <button type="button" className="dsh-knowledge-activity-load-more" disabled={listState === 'loading'} onClick={() => { void loadIndex(nextCursor, true) }}>{listState === 'loading' ? '正在加载…' : '加载更多'}</button>}</>}
                </div>
              </>}
      </div>
      : <DocumentReader
        value={documentValue}
        state={documentState}
        error={error}
        onBack={closeDocument}
        onRetry={() => setDocumentRefresh(value => value + 1)}
      />}
  </section>
}

function DocumentRow({ document, baseName, onClick }: { document: KnowledgeDocumentSummary; baseName: string | undefined; onClick(): void }): JSX.Element {
  const stateLabel = document.documentState === 'resolved' ? '已解决' : document.documentState === 'complete' ? '已完成' : undefined
  return <button type="button" className="dsh-knowledge-activity-row" onClick={onClick}>
    <span className="dsh-knowledge-activity-row-icon"><IconDataOutline16 size={16} /></span>
    <span className="dsh-knowledge-activity-row-copy"><strong>{document.title}</strong><small>{baseName ? `${baseName} · ${document.relPath}` : document.relPath}</small></span>
    <span className="dsh-knowledge-activity-row-meta">{stateLabel && <em>{stateLabel}</em>}<time dateTime={document.updatedAt}>{formatDate(document.updatedAt)}</time></span>
  </button>
}

function DocumentReader({ value, state, error, onBack, onRetry }: {
  value: KnowledgeDocument | undefined
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  onBack(): void
  onRetry(): void
}): JSX.Element {
  const html = useMemo(() => value === undefined ? '' : renderMarkdown(readableMarkdown(value.content)), [value])
  return <div className="dsh-knowledge-activity-reader">
    <div className="dsh-knowledge-activity-reader-bar">
      <button type="button" className="dsh-knowledge-activity-back" onClick={onBack}><IconChevronLeftOutline14 size={14} />文档目录</button>
      {value && <span>{formatDate(value.updatedAt)} 更新</span>}
    </div>
    {state === 'loading' ? <ActivityState label="正在打开文档…" />
      : state === 'error' ? <ActivityError message={error} onRetry={onRetry} />
        : value === undefined ? <ActivityState label="正在准备文档…" />
          : <><div className="dsh-knowledge-activity-document-heading">
            <span className="dsh-knowledge-activity-document-icon"><IconDataOutline16 size={18} /></span>
            <div><h2>{value.title}</h2><p>{value.relPath}</p></div>
          </div>
          <article className="dsh-knowledge-activity-markdown" dangerouslySetInnerHTML={{ __html: html }} /></>}
  </div>
}

function ActivityState({ label }: { label: string }): JSX.Element {
  return <p className="dsh-knowledge-activity-state" role="status"><span aria-hidden="true" />{label}</p>
}

function ActivityError({ message, onRetry }: { message: string; onRetry(): void }): JSX.Element {
  return <div className="dsh-knowledge-activity-error" role="alert"><strong>暂时无法读取</strong><p>{message}</p><button type="button" onClick={onRetry}>重试</button></div>
}

function ActivityEmpty({ title, description }: { title: string; description: string }): JSX.Element {
  return <div className="dsh-knowledge-activity-empty"><span><IconDatabaseOutline16 size={20} /></span><strong>{title}</strong><p>{description}</p></div>
}

function readableMarkdown(value: string): string {
  return value.replace(/^---\s*\n[\s\S]*?\n---\s*\n*/u, '').replace(/^#\s+[^\n]+\n*/u, '')
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
