import { createHash, randomUUID } from 'node:crypto'

export const KNOWLEDGE_TYPES = ['preference', 'fact', 'decision', 'procedure', 'lesson'] as const
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number]

export type KnowledgeScope =
  | { kind: 'global' }
  | { kind: 'project'; id: string }

export type KnowledgeStatus = 'active' | 'archived'
export type CandidateAction = 'create' | 'update' | 'conflict'
export type CandidateStatus = 'pending' | 'approved' | 'rejected'

export interface KnowledgeSource {
  sessionId?: string
  messageId?: string
  turn?: number
  clientId?: string
}

export interface KnowledgeDraft {
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
  version: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeVersion {
  id: string
  knowledgeId: string
  version: number
  snapshot: KnowledgeDraft & { status: KnowledgeStatus }
  changeKind: 'create' | 'update' | 'archive' | 'restore'
  createdAt: string
}

export interface CandidateProposal {
  action: CandidateAction
  targetId?: string
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

export interface SearchRequest {
  text: string
  projectId?: string
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
  note?: string
  draft?: KnowledgeDraft
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
  return {
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
    title: normalized.title.toLowerCase(),
    body: normalized.body.toLowerCase(),
    type: normalized.type,
    tags: normalized.tags,
    scope: normalized.scope,
  })).digest('hex')
}

export function isKnowledgeType(value: unknown): value is KnowledgeType {
  return typeof value === 'string' && TYPE_SET.has(value)
}
