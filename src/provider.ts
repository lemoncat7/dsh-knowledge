import type {
  CandidateProposal,
  CandidateBatchReviewResult,
  ExtractionJobCompletion,
  ExtractionJobRecord,
  KnowledgeCandidate,
  KnowledgeBase,
  KnowledgeBaseDraft,
  KnowledgeBasePatch,
  KnowledgeDraft,
  KnowledgeEntry,
  KnowledgeDocument,
  KnowledgeDocumentIndexRequest,
  KnowledgeDocumentIndexResult,
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
import type { KnowledgeNoteReference, KnowledgeNoteReferenceSource, NoteListRequest, NoteNode, NoteVersion } from './notes/domain.js'

/** Stable storage boundary shared by local SQLite and remote HTTP clients. */
export interface KnowledgeProvider {
  readonly mode: 'local' | 'remote'
  getSettings(signal?: AbortSignal): Promise<KnowledgeSettings>
  updateSettings(patch: KnowledgeSettingsPatch, signal?: AbortSignal): Promise<KnowledgeSettings>
  listKnowledgeBases(signal?: AbortSignal): Promise<KnowledgeBase[]>
  getKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase | undefined>
  createKnowledgeBase(draft: KnowledgeBaseDraft, signal?: AbortSignal): Promise<KnowledgeBase>
  updateKnowledgeBase(id: string, draft: KnowledgeBaseDraft, signal?: AbortSignal): Promise<KnowledgeBase>
  patchKnowledgeBase(id: string, patch: KnowledgeBasePatch, signal?: AbortSignal): Promise<KnowledgeBase>
  archiveKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase>
  restoreKnowledgeBase(id: string, signal?: AbortSignal): Promise<KnowledgeBase>
  deleteKnowledgeBase(id: string, signal?: AbortSignal): Promise<void>
  listDocuments(knowledgeBaseId?: string, query?: string, signal?: AbortSignal): Promise<KnowledgeDocument[]>
  listDocumentIndex(request: KnowledgeDocumentIndexRequest, signal?: AbortSignal): Promise<KnowledgeDocumentIndexResult>
  getDocument(id: string, signal?: AbortSignal): Promise<KnowledgeDocument | undefined>
  moveDocument(id: string, knowledgeBaseId: string, signal?: AbortSignal): Promise<KnowledgeEntry>
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
  finalize(id: string, state: 'resolved' | 'complete', note?: string, signal?: AbortSignal): Promise<KnowledgeEntry>
  reopen(id: string, signal?: AbortSignal): Promise<KnowledgeEntry>
  archive(id: string, signal?: AbortSignal): Promise<KnowledgeEntry>
  delete(id: string, signal?: AbortSignal): Promise<void>
  listNotes(request?: NoteListRequest, signal?: AbortSignal): Promise<NoteNode[]>
  getNote(id: string, signal?: AbortSignal): Promise<NoteNode | undefined>
  readNote(id: string, signal?: AbortSignal): Promise<{ node: NoteNode; content: Uint8Array }>
  listNoteVersions(id: string, limit?: number, signal?: AbortSignal): Promise<NoteVersion[]>
  readNoteVersion(id: string, version: number, signal?: AbortSignal): Promise<{ node: NoteNode; version: NoteVersion; content: Uint8Array }>
  restoreNoteVersion(id: string, version: number, expectedVersion?: number, signal?: AbortSignal): Promise<NoteNode>
  createNoteFolder(name: string, parentId?: string | null, signal?: AbortSignal): Promise<NoteNode>
  createNoteDocument(name: string, parentId?: string | null, content?: string, signal?: AbortSignal): Promise<NoteNode>
  updateNoteContent(id: string, content: Uint8Array, signal?: AbortSignal): Promise<NoteNode>
  renameNote(id: string, name: string, signal?: AbortSignal): Promise<NoteNode>
  moveNote(id: string, parentId: string | null, signal?: AbortSignal): Promise<NoteNode>
  deleteNote(id: string, signal?: AbortSignal): Promise<void>
  searchNotes(query: string, limit: number, signal?: AbortSignal): Promise<NoteNode[]>
  listKnowledgeNoteReferences(knowledgeId: string, signal?: AbortSignal): Promise<KnowledgeNoteReference[]>
  addKnowledgeNoteReference(
    knowledgeId: string,
    noteId: string,
    source: KnowledgeNoteReferenceSource,
    sourceSessionId?: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeNoteReference>
  deleteKnowledgeNoteReference(knowledgeId: string, noteId: string, signal?: AbortSignal): Promise<void>
  propose(proposal: CandidateProposal, sourceKey?: string, signal?: AbortSignal): Promise<KnowledgeCandidate>
  writeDirect(proposal: CandidateProposal, sourceKey?: string, signal?: AbortSignal): Promise<DirectWriteResult>
  listCandidates(status: 'pending' | 'approved' | 'rejected', limit: number, signal?: AbortSignal): Promise<KnowledgeCandidate[]>
  review(id: string, decision: ReviewDecision, signal?: AbortSignal): Promise<KnowledgeCandidate>
  approvePendingBatch(limit: number, excludeIds?: string[], signal?: AbortSignal): Promise<CandidateBatchReviewResult>
  claimExtraction(sourceKey: string, signal?: AbortSignal): Promise<boolean>
  completeExtraction(sourceKey: string, completion: ExtractionJobCompletion | number, signal?: AbortSignal): Promise<void>
  failExtraction(sourceKey: string, error: string, signal?: AbortSignal): Promise<void>
  resetExtraction(sourceKey: string, signal?: AbortSignal): Promise<void>
  extractionJob(sourceKey: string, signal?: AbortSignal): Promise<ExtractionJobRecord | undefined>
  close(): Promise<void>
}
