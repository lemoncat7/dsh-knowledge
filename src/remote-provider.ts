import type {
  CandidateProposal,
  ExtractionJobRecord,
  KnowledgeCandidate,
  KnowledgeDraft,
  KnowledgeEntry,
  KnowledgeStats,
  KnowledgeVersion,
  ListRequest,
  ListResult,
  ReviewDecision,
  SearchHit,
  SearchRequest,
} from './domain.js'
import type { KnowledgeProvider } from './provider.js'

export interface RemoteProviderOptions {
  url: string
  token: string
  timeoutMs: number
}

export class RemoteKnowledgeProvider implements KnowledgeProvider {
  readonly mode = 'remote' as const
  private readonly baseUrl: URL

  constructor(private readonly options: RemoteProviderOptions) {
    this.baseUrl = new URL(options.url.endsWith('/') ? options.url : `${options.url}/`)
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q: request.text, limit: String(request.limit) })
    if (request.projectId !== undefined) params.set('projectId', request.projectId)
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

  async archive(id: string, signal?: AbortSignal): Promise<KnowledgeEntry> {
    return this.request<KnowledgeEntry>(`entries/${encodeURIComponent(id)}/archive`, { method: 'POST', signal })
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`entries/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
  }

  async propose(proposal: CandidateProposal, sourceKey?: string, signal?: AbortSignal): Promise<KnowledgeCandidate> {
    return this.request<KnowledgeCandidate>('candidates', { method: 'POST', body: { proposal, sourceKey }, signal })
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
    const text = await response.text()
    const payload = text.length === 0 ? undefined : safeJson(text)
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `knowledge server returned HTTP ${response.status}`
      throw new RemoteProviderError(message, response.status)
    }
    return payload as T
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
