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
  ResolvedKnowledgeMount,
  ListRequest,
  ListResult,
  ReviewDecision,
  SearchHit,
  SearchRequest,
} from './domain.js'

/** Stable storage boundary shared by local SQLite and remote HTTP clients. */
export interface KnowledgeProvider {
  readonly mode: 'local' | 'remote'
  listKnowledgeBases(signal?: AbortSignal): Promise<KnowledgeBase[]>
  getKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase | undefined>
  createKnowledgeBase(draft: KnowledgeBaseDraft, signal?: AbortSignal): Promise<KnowledgeBase>
  updateKnowledgeBase(id: string, draft: KnowledgeBaseDraft, signal?: AbortSignal): Promise<KnowledgeBase>
  patchKnowledgeBase(id: string, patch: KnowledgeBasePatch, signal?: AbortSignal): Promise<KnowledgeBase>
  archiveKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase>
  restoreKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase>
  listDocuments(knowledgeBaseId?: string, query?: string, signal?: AbortSignal): Promise<KnowledgeDocument[]>
  getDocument(id: string, signal?: AbortSignal): Promise<KnowledgeDocument | undefined>
  listMounts(targetKind?: KnowledgeMountTargetKind, targetId?: string, signal?: AbortSignal): Promise<KnowledgeMount[]>
  upsertMount(draft: KnowledgeMountDraft, signal?: AbortSignal): Promise<KnowledgeMount>
  applyMountBatch(batch: KnowledgeMountBatch, signal?: AbortSignal): Promise<KnowledgeMountBatchResult>
  deleteMount(id: string, signal?: AbortSignal): Promise<void>
  resolveMounts(sessionId: string, projectId?: string, signal?: AbortSignal): Promise<ResolvedKnowledgeMount[]>
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
