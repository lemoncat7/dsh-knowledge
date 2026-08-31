import { createHash, randomUUID } from 'node:crypto'

export const KNOWLEDGE_TYPES = ['preference', 'fact', 'decision', 'procedure', 'lesson'] as const
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number]
export const DEFAULT_KNOWLEDGE_BASE_ID = 'default'

export type KnowledgeScope =
  | { kind: 'global' }
  | { kind: 'project'; id: string }

export type KnowledgeStatus = 'active' | 'archived'
export const KNOWLEDGE_DOCUMENT_STATES = ['open', 'resolved', 'complete'] as const
export type KnowledgeDocumentState = typeof KNOWLEDGE_DOCUMENT_STATES[number]
export type CandidateAction = 'create' | 'update' | 'conflict'
export type CandidateStatus = 'pending' | 'approved' | 'rejected'
export type KnowledgeBaseStatus = 'active' | 'archived'
export type KnowledgeMountTargetKind = 'project' | 'session'
export type KnowledgeWriteMode = 'none' | 'audit' | 'direct'
export type KnowledgeWritebackPolicy = 'conservative' | 'proactive'
export type KnowledgeEvidence = 'explicit' | 'verified' | 'inferred'

export interface KnowledgeTextEdit {
  /** Exact text from the target document. It must occur exactly once. */
  oldText: string
  /** Replacement text. An empty value removes oldText. */
  newText: string
}

export type CandidateChange =
  | { kind: 'append' }
  | {
    kind: 'revise'
    baseVersion: number
    baseHash: string
    edits: KnowledgeTextEdit[]
    append?: string
  }

export interface KnowledgeSettings {
  writebackPolicy: KnowledgeWritebackPolicy
  writebackProvider?: string
  writebackModel?: string
  updatedAt: string
}

export interface KnowledgeSettingsPatch {
  writebackPolicy?: KnowledgeWritebackPolicy
  writebackProvider?: string | null
  writebackModel?: string | null
}

export interface KnowledgeBaseDraft {
  name: string
  description: string
  defaultTags: string[]
  extractionInstructions: string
  writebackPolicy: KnowledgeWritebackPolicy
  /** Empty means use the model route from the current assistant turn. */
  writebackProvider?: string
  writebackModel?: string
}

export interface KnowledgeBasePatch {
  name?: string
  description?: string
  defaultTags?: string[]
  extractionInstructions?: string
  writebackPolicy?: KnowledgeWritebackPolicy
  writebackProvider?: string | null
  writebackModel?: string | null
}

export interface KnowledgeBase extends KnowledgeBaseDraft {
  id: string
  status: KnowledgeBaseStatus
  createdAt: string
  updatedAt: string
}

/** User-facing Markdown projection of approved knowledge entries. */
export interface KnowledgeDocument {
  id: string
  knowledgeBaseId: string
  relPath: string
  title: string
  content: string
  entryCount: number
  contentHash: string
  documentState: KnowledgeDocumentState
  finalizedAt?: string
  finalizationNote?: string
  createdAt: string
  updatedAt: string
}

export type KnowledgeDocumentSummary = Omit<KnowledgeDocument, 'content'>

export interface KnowledgeDocumentIndexRequest {
  knowledgeBaseIds?: string[]
  activeKnowledgeBasesOnly?: boolean
  query?: string
  cursor?: string
  limit: number
}

export interface KnowledgeDocumentIndexResult {
  items: KnowledgeDocumentSummary[]
  total: number
  nextCursor?: string
}

export interface KnowledgeMountDraft {
  targetKind: KnowledgeMountTargetKind
  targetId: string
  knowledgeBaseId: string
  enabled: boolean
  recallEnabled: boolean
  writeMode: KnowledgeWriteMode
  includeTags: string[]
  excludeTags: string[]
  extractionInstructions: string
}

export interface KnowledgeMount extends KnowledgeMountDraft {
  id: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeMountBatch {
  upserts: KnowledgeMountDraft[]
  deleteIds: string[]
}

export interface KnowledgeMountBatchResult {
  mounts: KnowledgeMount[]
  deletedIds: string[]
}

export interface ResolvedKnowledgeMount extends KnowledgeMount {
  base: KnowledgeBase
  inheritedFrom?: 'project'
}

export interface KnowledgeSource {
  sessionId?: string
  messageId?: string
  turn?: number
  clientId?: string
  evidence?: KnowledgeEvidence
}

export interface KnowledgeDraft {
  knowledgeBaseId: string
  title: string
  body: string
  type: KnowledgeType
  tags: string[]
  scope: KnowledgeScope
  confidence: number
  source?: KnowledgeSource
}

export interface KnowledgeEntry extends KnowledgeDraft {
  id: string
  status: KnowledgeStatus
  documentState: KnowledgeDocumentState
  finalizedAt?: string
  finalizationNote?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeVersion {
  id: string
  knowledgeId: string
  version: number
  snapshot: KnowledgeDraft & {
    status: KnowledgeStatus
    documentState: KnowledgeDocumentState
    finalizedAt?: string
    finalizationNote?: string
  }
  changeKind: 'create' | 'update' | 'archive' | 'restore'
  createdAt: string
}

export interface CandidateProposal {
  action: CandidateAction
  targetId?: string
  /** Missing on legacy candidates and treated as an append. */
  change?: CandidateChange
  draft: KnowledgeDraft
  reason: string
}

export interface KnowledgeCandidate extends CandidateProposal {
  id: string
  status: CandidateStatus
  sourceKey?: string
  createdAt: string
  reviewedAt?: string
  reviewNote?: string
}

export type DirectWriteOutcome = 'created' | 'merged' | 'duplicate' | 'conflict' | 'finalized'

export interface DirectWriteResult {
  outcome: DirectWriteOutcome
  candidate?: KnowledgeCandidate
  entry?: KnowledgeEntry
}

export interface SearchRequest {
  text: string
  projectId?: string
  knowledgeBaseIds?: string[]
  includeTags?: string[]
  excludeTags?: string[]
  types?: KnowledgeType[]
  limit: number
}

export interface SearchHit {
  entry: KnowledgeEntry
  score: number
}

export interface ListRequest {
  status?: KnowledgeStatus
  projectId?: string
  knowledgeBaseId?: string
  type?: KnowledgeType
  limit: number
  cursor?: string
}

export interface ListResult<T> {
  items: T[]
  nextCursor?: string
}

export interface ReviewDecision {
  decision: 'approve' | 'reject'
  resolution?: 'merge'
  note?: string
  draft?: KnowledgeDraft
  /** Version shown to the reviewer when an edited full document is submitted. */
  expectedVersion?: number
}

export interface ExtractionJobRecord {
  sourceKey: string
  status: 'running' | 'completed' | 'failed'
  attempts: number
  candidateCount: number
  lastError?: string
  updatedAt: string
}

export interface KnowledgeStats {
  knowledgeBases: {
    total: number
    active: number
    archived: number
  }
  entries: {
    total: number
    active: number
    archived: number
    byType: Record<KnowledgeType, number>
  }
  candidates: {
    total: number
    pending: number
    approved: number
    rejected: number
  }
  extractionJobs: {
    total: number
    running: number
    completed: number
    failed: number
  }
}

export const TOKEN_PERMISSIONS = ['read', 'propose', 'write', 'admin'] as const
export type TokenPermission = typeof TOKEN_PERMISSIONS[number]

export interface ApiTokenRecord {
  id: string
  name: string
  permissions: TokenPermission[]
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

const TYPE_SET = new Set<string>(KNOWLEDGE_TYPES)

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .slice(0, 32)
}

export function normalizeDraft(input: KnowledgeDraft): KnowledgeDraft {
  const knowledgeBaseId = input.knowledgeBaseId?.trim() || DEFAULT_KNOWLEDGE_BASE_ID
  const title = input.title.trim()
  const body = input.body.trim()
  if (title.length === 0 || title.length > 200) throw new Error('knowledge title must contain 1-200 characters')
  if (body.length === 0 || body.length > 50_000) throw new Error('knowledge body must contain 1-50000 characters')
  if (!TYPE_SET.has(input.type)) throw new Error(`unsupported knowledge type "${String(input.type)}"`)
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('knowledge confidence must be between 0 and 1')
  }
  if (input.scope.kind === 'project' && input.scope.id.trim().length === 0) {
    throw new Error('project scope requires a non-empty id')
  }
  if (input.source?.evidence !== undefined
    && input.source.evidence !== 'explicit'
    && input.source.evidence !== 'verified'
    && input.source.evidence !== 'inferred') {
    throw new Error('knowledge source evidence is unsupported')
  }
  return {
    knowledgeBaseId,
    title,
    body,
    type: input.type,
    tags: normalizeTags(input.tags),
    scope: input.scope.kind === 'global'
      ? { kind: 'global' }
      : { kind: 'project', id: input.scope.id.trim() },
    confidence: input.confidence,
    ...input.source === undefined ? {} : { source: { ...input.source } },
  }
}

export function contentHash(draft: KnowledgeDraft): string {
  const normalized = normalizeDraft(draft)
  return createHash('sha256').update(JSON.stringify({
    knowledgeBaseId: normalized.knowledgeBaseId,
    title: normalized.title.toLowerCase(),
    body: normalized.body.toLowerCase(),
    type: normalized.type,
    tags: normalized.tags,
    scope: normalized.scope,
  })).digest('hex')
}

export function normalizeKnowledgeBaseDraft(input: KnowledgeBaseDraft): KnowledgeBaseDraft {
  const name = input.name.trim()
  const description = input.description.trim()
  const extractionInstructions = input.extractionInstructions.trim()
  const writebackPolicy = input.writebackPolicy ?? 'conservative'
  if (writebackPolicy !== 'conservative' && writebackPolicy !== 'proactive') {
    throw new Error('knowledge base writeback policy must be conservative or proactive')
  }
  if (name.length === 0 || name.length > 100) throw new Error('knowledge base name must contain 1-100 characters')
  if (description.length > 2000) throw new Error('knowledge base description must contain at most 2000 characters')
  if (extractionInstructions.length > 4000) throw new Error('knowledge base extraction instructions must contain at most 4000 characters')
  const writebackProvider = input.writebackProvider?.trim() || undefined
  const writebackModel = input.writebackModel?.trim() || undefined
  if ((writebackProvider === undefined) !== (writebackModel === undefined)) {
    throw new Error('knowledge base writebackProvider and writebackModel must be configured together')
  }
  if (writebackProvider !== undefined && writebackProvider.length > 100) {
    throw new Error('knowledge base writebackProvider must contain at most 100 characters')
  }
  if (writebackModel !== undefined && writebackModel.length > 200) {
    throw new Error('knowledge base writebackModel must contain at most 200 characters')
  }
  return {
    name,
    description,
    defaultTags: normalizeTags(input.defaultTags),
    extractionInstructions,
    writebackPolicy,
    ...writebackProvider === undefined || writebackModel === undefined
      ? {}
      : { writebackProvider, writebackModel },
  }
}

export function normalizeKnowledgeMountDraft(input: KnowledgeMountDraft): KnowledgeMountDraft {
  const targetId = input.targetId.trim()
  const knowledgeBaseId = input.knowledgeBaseId.trim()
  if (targetId.length === 0) throw new Error('knowledge mount targetId must not be empty')
  if (knowledgeBaseId.length === 0) throw new Error('knowledge mount knowledgeBaseId must not be empty')
  if (input.targetKind !== 'project' && input.targetKind !== 'session') throw new Error('unsupported knowledge mount target kind')
  if (input.writeMode !== 'none' && input.writeMode !== 'audit' && input.writeMode !== 'direct') {
    throw new Error('unsupported knowledge write mode')
  }
  const extractionInstructions = input.extractionInstructions.trim()
  if (extractionInstructions.length > 4000) throw new Error('mount extraction instructions must contain at most 4000 characters')
  const includeTags = normalizeTags(input.includeTags)
  const excludeTags = normalizeTags(input.excludeTags)
  if (includeTags.some(tag => excludeTags.includes(tag))) throw new Error('a mount tag cannot be both included and excluded')
  return {
    targetKind: input.targetKind,
    targetId,
    knowledgeBaseId,
    enabled: input.enabled,
    recallEnabled: input.recallEnabled,
    writeMode: input.writeMode,
    includeTags,
    excludeTags,
    extractionInstructions,
  }
}

export function isKnowledgeType(value: unknown): value is KnowledgeType {
  return typeof value === 'string' && TYPE_SET.has(value)
}

export function normalizeKnowledgeSettings(input: KnowledgeSettingsPatch): KnowledgeSettingsPatch {
  if (input.writebackPolicy !== undefined && input.writebackPolicy !== 'conservative' && input.writebackPolicy !== 'proactive') {
    throw new Error('knowledge writeback policy must be conservative or proactive')
  }
  const clearRoute = input.writebackProvider === null || input.writebackModel === null
  const provider = typeof input.writebackProvider === 'string' ? input.writebackProvider.trim() : undefined
  const model = typeof input.writebackModel === 'string' ? input.writebackModel.trim() : undefined
  if (!clearRoute && (provider === undefined) !== (model === undefined)) throw new Error('global writeback provider and model must be configured together')
  return {
    ...input.writebackPolicy === undefined ? {} : { writebackPolicy: input.writebackPolicy },
    ...clearRoute ? { writebackProvider: null, writebackModel: null } : provider && model ? { writebackProvider: provider, writebackModel: model } : {},
  }
}
