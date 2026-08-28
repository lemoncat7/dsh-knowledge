import type {
  CandidateProposal,
  ExtractionJobRecord,
  KnowledgeCandidate,
  KnowledgeBase,
  KnowledgeBaseDraft,
  KnowledgeBasePatch,
  KnowledgeDraft,
  KnowledgeEntry,
  KnowledgeDocument,
  KnowledgeStats,
  KnowledgeVersion,
  KnowledgeMount,
  KnowledgeMountBatch,
  KnowledgeMountBatchResult,
  KnowledgeMountDraft,
  KnowledgeMountTargetKind,
  KnowledgeSettings,
  KnowledgeSettingsPatch,
  ResolvedKnowledgeMount,
  DirectWriteResult,
  ListRequest,
  ListResult,
  ReviewDecision,
  SearchHit,
  SearchRequest,
} from './domain.js'
import type { KnowledgeProvider } from './provider.js'
import { normalizeRemoteKnowledgeUrl } from './remote-url.js'
import type { KnowledgeNoteReference, KnowledgeNoteReferenceSource, NoteNode } from './notes/domain.js'

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

export interface RemoteProviderOptions {
  url: string
  token: string
  timeoutMs: number
}

export class RemoteKnowledgeProvider implements KnowledgeProvider {
  readonly mode = 'remote' as const
  private readonly baseUrl: URL

  constructor(private readonly options: RemoteProviderOptions) {
    this.baseUrl = normalizeRemoteKnowledgeUrl(options.url)
  }

  async getSettings(signal?: AbortSignal): Promise<KnowledgeSettings> {
    return this.request<KnowledgeSettings>('settings', { signal })
  }

  async updateSettings(patch: KnowledgeSettingsPatch, signal?: AbortSignal): Promise<KnowledgeSettings> {
    return this.request<KnowledgeSettings>('settings', { method: 'PUT', body: { patch }, signal })
  }

  async listKnowledgeBases(signal?: AbortSignal): Promise<KnowledgeBase[]> {
    return this.request<KnowledgeBase[]>('knowledge-bases', { signal })
  }

  async getKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase | undefined> {
    try {
      return await this.request<KnowledgeBase>(`knowledge-bases/${encodeURIComponent(id)}`, { signal })
    } catch (error) {
      if (error instanceof RemoteProviderError && error.status === 404) return undefined
      throw error
    }
  }

  async createKnowledgeBase(draft: KnowledgeBaseDraft, signal?: AbortSignal): Promise<KnowledgeBase> {
    return this.request<KnowledgeBase>('knowledge-bases', { method: 'POST', body: { draft }, signal })
  }

  async updateKnowledgeBase(id: string, draft: KnowledgeBaseDraft, signal?: AbortSignal): Promise<KnowledgeBase> {
    return this.request<KnowledgeBase>(`knowledge-bases/${encodeURIComponent(id)}`, { method: 'PUT', body: { draft }, signal })
  }

  async patchKnowledgeBase(id: string, patch: KnowledgeBasePatch, signal?: AbortSignal): Promise<KnowledgeBase> {
    return this.request<KnowledgeBase>(`knowledge-bases/${encodeURIComponent(id)}`, { method: 'PATCH', body: { patch }, signal })
  }

  async archiveKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase> {
    return this.request<KnowledgeBase>(`knowledge-bases/${encodeURIComponent(id)}/archive`, { method: 'POST', signal })
  }

  async restoreKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase> {
    return this.request<KnowledgeBase>(`knowledge-bases/${encodeURIComponent(id)}/restore`, { method: 'POST', signal })
  }

  async deleteKnowledgeBase(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<void>(`knowledge-bases/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
  }

  async listDocuments(knowledgeBaseId?: string, query?: string, signal?: AbortSignal): Promise<KnowledgeDocument[]> {
    const params = new URLSearchParams()
    if (knowledgeBaseId !== undefined) params.set('knowledgeBaseId', knowledgeBaseId)
    if (query !== undefined && query.trim().length > 0) params.set('q', query.trim())
    return this.request<KnowledgeDocument[]>(`documents?${params}`, { signal })
  }

  async getDocument(id: string, signal?: AbortSignal): Promise<KnowledgeDocument | undefined> {
    try {
      return await this.request<KnowledgeDocument>(`documents/${encodeURIComponent(id)}`, { signal })
    } catch (error) {
      if (error instanceof RemoteProviderError && error.status === 404) return undefined
      throw error
    }
  }

  async listMounts(targetKind?: KnowledgeMountTargetKind, targetId?: string, signal?: AbortSignal): Promise<KnowledgeMount[]> {
    const params = new URLSearchParams()
    if (targetKind !== undefined) params.set('targetKind', targetKind)
    if (targetId !== undefined) params.set('targetId', targetId)
    return this.request<KnowledgeMount[]>(`mounts?${params}`, { signal })
  }

  async upsertMount(draft: KnowledgeMountDraft, signal?: AbortSignal): Promise<KnowledgeMount> {
    return this.request<KnowledgeMount>('mounts', { method: 'POST', body: { draft }, signal })
  }

  async applyMountBatch(batch: KnowledgeMountBatch, signal?: AbortSignal): Promise<KnowledgeMountBatchResult> {
    return this.request<KnowledgeMountBatchResult>('mounts/bulk', { method: 'POST', body: batch, signal })
  }

  async deleteMount(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`mounts/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
  }

  async resolveMounts(sessionId: string, projectId?: string, signal?: AbortSignal): Promise<ResolvedKnowledgeMount[]> {
    const params = new URLSearchParams({ sessionId })
    if (projectId !== undefined) params.set('projectId', projectId)
    return this.request<ResolvedKnowledgeMount[]>(`mounts/resolve?${params}`, { signal })
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q: request.text, limit: String(request.limit) })
    if (request.projectId !== undefined) params.set('projectId', request.projectId)
    for (const id of request.knowledgeBaseIds ?? []) params.append('knowledgeBaseId', id)
    for (const tag of request.includeTags ?? []) params.append('includeTag', tag)
    for (const tag of request.excludeTags ?? []) params.append('excludeTag', tag)
    for (const type of request.types ?? []) params.append('type', type)
    return this.request<SearchHit[]>(`search?${params}`, { signal })
  }

  async stats(signal?: AbortSignal): Promise<KnowledgeStats> {
    return this.request<KnowledgeStats>('stats', { signal })
  }

  async list(request: ListRequest, signal?: AbortSignal): Promise<ListResult<KnowledgeEntry>> {
    const params = new URLSearchParams({ limit: String(request.limit) })
    if (request.status !== undefined) params.set('status', request.status)
    if (request.projectId !== undefined) params.set('projectId', request.projectId)
    if (request.knowledgeBaseId !== undefined) params.set('knowledgeBaseId', request.knowledgeBaseId)
    if (request.type !== undefined) params.set('type', request.type)
    if (request.cursor !== undefined) params.set('cursor', request.cursor)
    return this.request<ListResult<KnowledgeEntry>>(`entries?${params}`, { signal })
  }

  async get(id: string, signal?: AbortSignal): Promise<KnowledgeEntry | undefined> {
    try {
      return await this.request<KnowledgeEntry>(`entries/${encodeURIComponent(id)}`, { signal })
    } catch (error) {
      if (error instanceof RemoteProviderError && error.status === 404) return undefined
      throw error
    }
  }

  async versions(id: string, signal?: AbortSignal): Promise<KnowledgeVersion[]> {
    return this.request<KnowledgeVersion[]>(`entries/${encodeURIComponent(id)}/versions`, { signal })
  }

  async create(draft: KnowledgeDraft, signal?: AbortSignal): Promise<KnowledgeEntry> {
    return this.request<KnowledgeEntry>('entries', { method: 'POST', body: { draft }, signal })
  }

  async update(id: string, draft: KnowledgeDraft, signal?: AbortSignal): Promise<KnowledgeEntry> {
    return this.request<KnowledgeEntry>(`entries/${encodeURIComponent(id)}`, { method: 'PUT', body: { draft }, signal })
  }

  async finalize(id: string, state: 'resolved' | 'complete', note?: string, signal?: AbortSignal): Promise<KnowledgeEntry> {
    return this.request<KnowledgeEntry>(`documents/${encodeURIComponent(id)}/finalize`, {
      method: 'POST', body: { state, ...note === undefined ? {} : { note } }, signal,
    })
  }

  async reopen(id: string, signal?: AbortSignal): Promise<KnowledgeEntry> {
    return this.request<KnowledgeEntry>(`documents/${encodeURIComponent(id)}/reopen`, { method: 'POST', signal })
  }

  async archive(id: string, signal?: AbortSignal): Promise<KnowledgeEntry> {
    return this.request<KnowledgeEntry>(`entries/${encodeURIComponent(id)}/archive`, { method: 'POST', signal })
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`entries/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
  }

  async searchNotes(query: string, limit: number, signal?: AbortSignal): Promise<NoteNode[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return this.request<NoteNode[]>(`notes?${params}`, { signal })
  }

  async listKnowledgeNoteReferences(knowledgeId: string, signal?: AbortSignal): Promise<KnowledgeNoteReference[]> {
    return this.request<KnowledgeNoteReference[]>(`entries/${encodeURIComponent(knowledgeId)}/note-references`, { signal })
  }

  async addKnowledgeNoteReference(
    knowledgeId: string,
    noteId: string,
    source: KnowledgeNoteReferenceSource,
    sourceSessionId?: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeNoteReference> {
    return this.request<KnowledgeNoteReference>(`entries/${encodeURIComponent(knowledgeId)}/note-references`, {
      method: 'POST', body: { noteId, source, sourceSessionId }, signal,
    })
  }

  async deleteKnowledgeNoteReference(knowledgeId: string, noteId: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`entries/${encodeURIComponent(knowledgeId)}/note-references/${encodeURIComponent(noteId)}`, {
      method: 'DELETE', signal,
    })
  }

  async propose(proposal: CandidateProposal, sourceKey?: string, signal?: AbortSignal): Promise<KnowledgeCandidate> {
    return this.request<KnowledgeCandidate>('candidates', { method: 'POST', body: { proposal, sourceKey }, signal })
  }

  async writeDirect(proposal: CandidateProposal, sourceKey?: string, signal?: AbortSignal): Promise<DirectWriteResult> {
    return this.request<DirectWriteResult>('candidates/direct', { method: 'POST', body: { proposal, sourceKey }, signal })
  }

  async listCandidates(status: 'pending' | 'approved' | 'rejected', limit: number, signal?: AbortSignal): Promise<KnowledgeCandidate[]> {
    return this.request<KnowledgeCandidate[]>(`candidates?${new URLSearchParams({ status, limit: String(limit) })}`, { signal })
  }

  async review(id: string, decision: ReviewDecision, signal?: AbortSignal): Promise<KnowledgeCandidate> {
    return this.request<KnowledgeCandidate>(`candidates/${encodeURIComponent(id)}/review`, { method: 'POST', body: decision, signal })
  }

  async claimExtraction(sourceKey: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.request<{ claimed: boolean }>(`extraction-jobs/${encodeURIComponent(sourceKey)}/claim`, { method: 'POST', signal })
    return result.claimed
  }

  async completeExtraction(sourceKey: string, candidateCount: number, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`extraction-jobs/${encodeURIComponent(sourceKey)}/complete`, { method: 'POST', body: { candidateCount }, signal })
  }

  async failExtraction(sourceKey: string, error: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`extraction-jobs/${encodeURIComponent(sourceKey)}/fail`, { method: 'POST', body: { error }, signal })
  }

  async resetExtraction(sourceKey: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`extraction-jobs/${encodeURIComponent(sourceKey)}/reset`, { method: 'POST', signal })
  }

  async extractionJob(sourceKey: string, signal?: AbortSignal): Promise<ExtractionJobRecord | undefined> {
    try {
      return await this.request<ExtractionJobRecord>(`extraction-jobs/${encodeURIComponent(sourceKey)}`, { signal })
    } catch (error) {
      if (error instanceof RemoteProviderError && error.status === 404) return undefined
      throw error
    }
  }

  async close(): Promise<void> {}

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    let response: Response
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.token}`,
          ...options.body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
        signal,
      })
    } catch (error) {
      throw new RemoteProviderError(`knowledge server request failed: ${error instanceof Error ? error.message : String(error)}`, 0)
    }
    const text = await readBoundedResponse(response, MAX_RESPONSE_BYTES)
    const payload = text.length === 0 ? undefined : safeJson(text)
    if (!response.ok) {
      const detail = remoteErrorDetail(payload, text)
      const message = detail === undefined
        ? `knowledge server returned HTTP ${response.status} for ${path}`
        : `knowledge server rejected ${path}: ${detail}`
      throw new RemoteProviderError(message, response.status)
    }
    return payload as T
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => {})
    throw new RemoteProviderError('knowledge server response is too large', 502)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximumBytes) {
        await reader.cancel().catch(() => {})
        throw new RemoteProviderError('knowledge server response is too large', 502)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export class RemoteProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RemoteProviderError'
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new RemoteProviderError('knowledge server returned invalid JSON', 502)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function remoteErrorDetail(payload: unknown, text: string): string | undefined {
  if (isRecord(payload)) {
    if (typeof payload.error === 'string') return payload.error
    if (isRecord(payload.error) && typeof payload.error.message === 'string') return payload.error.message
    if (typeof payload.message === 'string') return payload.message
  }
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length === 0 ? undefined : compact.slice(0, 500)
}
