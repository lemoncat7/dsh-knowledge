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

/** Stable storage boundary shared by local SQLite and remote HTTP clients. */
export interface KnowledgeProvider {
  readonly mode: 'local' | 'remote'
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]>
  stats(signal?: AbortSignal): Promise<KnowledgeStats>
  list(request: ListRequest, signal?: AbortSignal): Promise<ListResult<KnowledgeEntry>>
  get(id: string, signal?: AbortSignal): Promise<KnowledgeEntry | undefined>
  versions(id: string, signal?: AbortSignal): Promise<KnowledgeVersion[]>
  create(draft: KnowledgeDraft, signal?: AbortSignal): Promise<KnowledgeEntry>
  update(id: string, draft: KnowledgeDraft, signal?: AbortSignal): Promise<KnowledgeEntry>
  archive(id: string, signal?: AbortSignal): Promise<KnowledgeEntry>
  delete(id: string, signal?: AbortSignal): Promise<void>
  propose(proposal: CandidateProposal, sourceKey?: string, signal?: AbortSignal): Promise<KnowledgeCandidate>
  listCandidates(status: 'pending' | 'approved' | 'rejected', limit: number, signal?: AbortSignal): Promise<KnowledgeCandidate[]>
  review(id: string, decision: ReviewDecision, signal?: AbortSignal): Promise<KnowledgeCandidate>
  claimExtraction(sourceKey: string, signal?: AbortSignal): Promise<boolean>
  completeExtraction(sourceKey: string, candidateCount: number, signal?: AbortSignal): Promise<void>
  failExtraction(sourceKey: string, error: string, signal?: AbortSignal): Promise<void>
  extractionJob(sourceKey: string, signal?: AbortSignal): Promise<ExtractionJobRecord | undefined>
  close(): Promise<void>
}
