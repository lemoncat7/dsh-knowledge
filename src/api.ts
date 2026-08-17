import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DEFAULT_KNOWLEDGE_BASE_ID, isKnowledgeType, normalizeDraft, normalizeKnowledgeBaseDraft,
  normalizeKnowledgeMountDraft, type CandidateProposal, type KnowledgeBaseDraft, type KnowledgeDraft,
  type KnowledgeMountDraft, type ReviewDecision, type TokenPermission,
} from './domain.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import type { RuntimeContextLike } from './runtime.js'

const MAX_BODY_BYTES = 1_048_576

export function registerKnowledgeApi(
  ctx: RuntimeContextLike,
  provider: LocalKnowledgeProvider,
  prefix: string,
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('exposeApi requires the DSH webServer service')
  return webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      try {
        await dispatch(provider, prefix, req, res)
      } catch (error) {
        sendError(res, error)
      }
    },
  })
}

async function dispatch(
  provider: LocalKnowledgeProvider,
  prefix: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://knowledge.local')
  const relative = url.pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
  const segments = relative.length === 0 ? [] : relative.split('/').map(decodeURIComponent)
  const method = req.method ?? 'GET'

  if (method === 'GET' && segments[0] === 'health') {
    return sendJson(res, 200, { ok: true, service: 'dsh-knowledge', schemaVersion: 2 })
  }

  const actor = authenticate(provider, req)

  if (method === 'GET' && segments[0] === 'search' && segments.length === 1) {
    requirePermission(actor.permissions, 'read')
    const types = url.searchParams.getAll('type').filter(isKnowledgeType)
    const projectId = url.searchParams.get('projectId') ?? undefined
    const knowledgeBaseIds = url.searchParams.getAll('knowledgeBaseId').filter(Boolean)
    const includeTags = url.searchParams.getAll('includeTag').filter(Boolean)
    const excludeTags = url.searchParams.getAll('excludeTag').filter(Boolean)
    const result = await provider.search({
      text: url.searchParams.get('q') ?? '',
      ...projectId === undefined ? {} : { projectId },
      ...knowledgeBaseIds.length === 0 ? {} : { knowledgeBaseIds },
      ...includeTags.length === 0 ? {} : { includeTags },
      ...excludeTags.length === 0 ? {} : { excludeTags },
      ...types.length === 0 ? {} : { types },
      limit: integerParam(url, 'limit', 10, 1, 100),
    })
    return sendJson(res, 200, result)
  }

  if (method === 'GET' && segments[0] === 'stats' && segments.length === 1) {
    requirePermission(actor.permissions, 'read')
    return sendJson(res, 200, await provider.stats())
  }

  if (segments[0] === 'knowledge-bases') {
    if (method === 'GET' && segments.length === 1) {
      requirePermission(actor.permissions, 'read')
      return sendJson(res, 200, await provider.listKnowledgeBases())
    }
    if (method === 'POST' && segments.length === 1) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 201, await provider.createKnowledgeBase(parseKnowledgeBaseDraft(body.draft)))
    }
    const id = segments[1]
    if (id !== undefined && method === 'GET' && segments.length === 2) {
      requirePermission(actor.permissions, 'read')
      const base = await provider.getKnowledgeBase(id)
      if (base === undefined) throw httpError(404, `knowledge base "${id}" was not found`)
      return sendJson(res, 200, base)
    }
    if (id !== undefined && method === 'PUT' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 200, await provider.updateKnowledgeBase(id, parseKnowledgeBaseDraft(body.draft)))
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'archive' && segments.length === 3) {
      requirePermission(actor.permissions, 'admin')
      return sendJson(res, 200, await provider.archiveKnowledgeBase(id))
    }
  }

  if (segments[0] === 'mounts') {
    if (method === 'GET' && segments[1] === 'resolve' && segments.length === 2) {
      requirePermission(actor.permissions, 'read')
      const sessionId = url.searchParams.get('sessionId')?.trim()
      if (!sessionId) throw httpError(400, 'sessionId is required')
      return sendJson(res, 200, await provider.resolveMounts(sessionId, url.searchParams.get('projectId') ?? undefined))
    }
    if (method === 'GET' && segments.length === 1) {
      requirePermission(actor.permissions, 'read')
      const targetKind = url.searchParams.get('targetKind')
      if (targetKind !== null && targetKind !== 'project' && targetKind !== 'session') throw httpError(400, 'invalid mount targetKind')
      return sendJson(res, 200, await provider.listMounts(targetKind ?? undefined, url.searchParams.get('targetId') ?? undefined))
    }
    if (method === 'POST' && segments.length === 1) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 200, await provider.upsertMount(parseMountDraft(body.draft)))
    }
    if (method === 'DELETE' && segments[1] !== undefined && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      await provider.deleteMount(segments[1])
      return sendJson(res, 204, undefined)
    }
  }

  if (segments[0] === 'entries') {
    if (method === 'GET' && segments.length === 1) {
      requirePermission(actor.permissions, 'read')
      const status = url.searchParams.get('status')
      const type = url.searchParams.get('type')
      const projectId = url.searchParams.get('projectId') ?? undefined
      const knowledgeBaseId = url.searchParams.get('knowledgeBaseId') ?? undefined
      const cursor = url.searchParams.get('cursor') ?? undefined
      const result = await provider.list({
        ...status === 'active' || status === 'archived' ? { status } : {},
        ...type !== null && isKnowledgeType(type) ? { type } : {},
        ...projectId === undefined ? {} : { projectId },
        ...knowledgeBaseId === undefined ? {} : { knowledgeBaseId },
        ...cursor === undefined ? {} : { cursor },
        limit: integerParam(url, 'limit', 50, 1, 100),
      })
      return sendJson(res, 200, result)
    }
    if (method === 'POST' && segments.length === 1) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 201, await provider.create(parseDraft(body.draft)))
    }
    const id = segments[1]
    if (id !== undefined && method === 'GET' && segments.length === 2) {
      requirePermission(actor.permissions, 'read')
      const entry = await provider.get(id)
      if (entry === undefined) throw httpError(404, `knowledge entry "${id}" was not found`)
      return sendJson(res, 200, entry)
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'versions' && segments.length === 3) {
      requirePermission(actor.permissions, 'read')
      return sendJson(res, 200, await provider.versions(id))
    }
    if (id !== undefined && method === 'PUT' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 200, await provider.update(id, parseDraft(body.draft)))
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'archive' && segments.length === 3) {
      requirePermission(actor.permissions, 'write')
      return sendJson(res, 200, await provider.archive(id))
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      requirePermission(actor.permissions, 'admin')
      await provider.delete(id)
      return sendJson(res, 204, undefined)
    }
  }

  if (segments[0] === 'candidates') {
    if (method === 'GET' && segments.length === 1) {
      requirePermission(actor.permissions, 'read')
      const status = url.searchParams.get('status')
      if (status !== 'pending' && status !== 'approved' && status !== 'rejected') throw httpError(400, 'invalid candidate status')
      return sendJson(res, 200, await provider.listCandidates(status, integerParam(url, 'limit', 50, 1, 100)))
    }
    if (method === 'POST' && segments.length === 1) {
      requirePermission(actor.permissions, 'propose')
      const body = await readObject(req)
      return sendJson(res, 201, await provider.propose(parseProposal(body.proposal), optionalString(body.sourceKey)))
    }
    if (method === 'POST' && segments[1] !== undefined && segments[2] === 'review' && segments.length === 3) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 200, await provider.review(segments[1], parseReview(body)))
    }
  }

  if (segments[0] === 'extraction-jobs' && segments[1] !== undefined) {
    const sourceKey = segments[1]
    if (method === 'GET' && segments.length === 2) {
      requirePermission(actor.permissions, 'read')
      const job = await provider.extractionJob(sourceKey)
      if (job === undefined) throw httpError(404, 'extraction job was not found')
      return sendJson(res, 200, job)
    }
    requirePermission(actor.permissions, 'propose')
    if (method === 'POST' && segments[2] === 'claim') {
      return sendJson(res, 200, { claimed: await provider.claimExtraction(sourceKey) })
    }
    if (method === 'POST' && segments[2] === 'complete') {
      const body = await readObject(req)
      const count = typeof body.candidateCount === 'number' && Number.isInteger(body.candidateCount) ? body.candidateCount : 0
      await provider.completeExtraction(sourceKey, Math.max(0, count))
      return sendJson(res, 204, undefined)
    }
    if (method === 'POST' && segments[2] === 'fail') {
      const body = await readObject(req)
      await provider.failExtraction(sourceKey, typeof body.error === 'string' ? body.error : 'remote extraction failed')
      return sendJson(res, 204, undefined)
    }
  }

  if (segments[0] === 'tokens') {
    requirePermission(actor.permissions, 'admin')
    if (method === 'GET' && segments.length === 1) return sendJson(res, 200, provider.listApiTokens())
    if (method === 'POST' && segments.length === 1) {
      const body = await readObject(req)
      const name = typeof body.name === 'string' ? body.name : ''
      const permissions = Array.isArray(body.permissions)
        ? body.permissions.filter((permission): permission is TokenPermission => permission === 'read' || permission === 'propose' || permission === 'write' || permission === 'admin')
        : []
      return sendJson(res, 201, provider.createApiToken(name, permissions))
    }
    if (method === 'DELETE' && segments[1] !== undefined && segments.length === 2) {
      if (segments[1] === actor.id) throw httpError(409, 'the current token cannot revoke itself')
      provider.revokeApiToken(segments[1])
      return sendJson(res, 204, undefined)
    }
  }

  throw httpError(404, 'knowledge API route was not found')
}

function parseKnowledgeBaseDraft(value: unknown): KnowledgeBaseDraft {
  if (!isRecord(value)) throw httpError(400, 'knowledge base draft is invalid')
  try {
    return normalizeKnowledgeBaseDraft({
      name: typeof value.name === 'string' ? value.name : '',
      description: typeof value.description === 'string' ? value.description : '',
      defaultTags: Array.isArray(value.defaultTags) ? value.defaultTags.filter((tag): tag is string => typeof tag === 'string') : [],
      extractionInstructions: typeof value.extractionInstructions === 'string' ? value.extractionInstructions : '',
    })
  } catch (error) {
    throw httpError(400, error instanceof Error ? error.message : 'knowledge base draft is invalid')
  }
}

function parseMountDraft(value: unknown): KnowledgeMountDraft {
  if (!isRecord(value)) throw httpError(400, 'knowledge mount draft is invalid')
  if (value.targetKind !== 'project' && value.targetKind !== 'session') {
    throw httpError(400, 'knowledge mount targetKind must be project or session')
  }
  try {
    return normalizeKnowledgeMountDraft({
      targetKind: value.targetKind,
      targetId: typeof value.targetId === 'string' ? value.targetId : '',
      knowledgeBaseId: typeof value.knowledgeBaseId === 'string' ? value.knowledgeBaseId : '',
      enabled: value.enabled !== false,
      recallEnabled: value.recallEnabled !== false,
      writeMode: value.writeMode === 'direct' || value.writeMode === 'none' ? value.writeMode : 'audit',
      includeTags: Array.isArray(value.includeTags) ? value.includeTags.filter((tag): tag is string => typeof tag === 'string') : [],
      excludeTags: Array.isArray(value.excludeTags) ? value.excludeTags.filter((tag): tag is string => typeof tag === 'string') : [],
      extractionInstructions: typeof value.extractionInstructions === 'string' ? value.extractionInstructions : '',
    })
  } catch (error) {
    throw httpError(400, error instanceof Error ? error.message : 'knowledge mount draft is invalid')
  }
}

function authenticate(provider: LocalKnowledgeProvider, req: IncomingMessage) {
  const authorization = req.headers.authorization
  if (authorization === undefined || !authorization.startsWith('Bearer ')) throw httpError(401, 'bearer token is required')
  const actor = provider.authenticate(authorization.slice(7).trim())
  if (actor === undefined) throw httpError(401, 'bearer token is invalid or revoked')
  return actor
}

function requirePermission(permissions: TokenPermission[], required: TokenPermission): void {
  if (permissions.includes('admin')) return
  if (required === 'read' && (permissions.includes('write') || permissions.includes('propose'))) return
  if (required === 'propose' && permissions.includes('write')) return
  if (!permissions.includes(required)) throw httpError(403, `token lacks ${required} permission`)
}

async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw httpError(413, 'request body is too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'request body is too large')
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!isRecord(value)) throw new Error()
    return value
  } catch {
    throw httpError(400, 'request body must be a JSON object')
  }
}

function parseDraft(value: unknown): KnowledgeDraft {
  if (!isRecord(value) || !isRecord(value.scope)) throw httpError(400, 'draft is invalid')
  if (!isKnowledgeType(value.type)) throw httpError(400, 'draft type is invalid')
  const scope = value.scope.kind === 'global'
    ? { kind: 'global' as const }
    : { kind: 'project' as const, id: typeof value.scope.id === 'string' ? value.scope.id : '' }
  try {
    const source = isRecord(value.source) ? parseSource(value.source) : undefined
    return normalizeDraft({
      knowledgeBaseId: optionalString(value.knowledgeBaseId) ?? DEFAULT_KNOWLEDGE_BASE_ID,
      title: typeof value.title === 'string' ? value.title : '',
      body: typeof value.body === 'string' ? value.body : '',
      type: value.type,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      scope,
      confidence: typeof value.confidence === 'number' ? value.confidence : 0.5,
      ...source === undefined ? {} : { source },
    })
  } catch (error) {
    throw httpError(400, error instanceof Error ? error.message : 'draft is invalid')
  }
}

function parseProposal(value: unknown): CandidateProposal {
  if (!isRecord(value) || (value.action !== 'create' && value.action !== 'update' && value.action !== 'conflict')) {
    throw httpError(400, 'proposal is invalid')
  }
  const targetId = optionalString(value.targetId)
  if (value.action !== 'create' && targetId === undefined) throw httpError(400, `${value.action} proposal requires targetId`)
  return {
    action: value.action,
    ...targetId === undefined ? {} : { targetId },
    draft: parseDraft(value.draft),
    reason: typeof value.reason === 'string' ? value.reason : '',
  }
}

function parseReview(value: Record<string, unknown>): ReviewDecision {
  if (value.decision !== 'approve' && value.decision !== 'reject') throw httpError(400, 'review decision is invalid')
  const note = optionalString(value.note)
  return {
    decision: value.decision,
    ...note === undefined ? {} : { note },
    ...value.draft === undefined ? {} : { draft: parseDraft(value.draft) },
  }
}

function parseSource(value: Record<string, unknown>): NonNullable<KnowledgeDraft['source']> {
  const sessionId = optionalString(value.sessionId)
  const messageId = optionalString(value.messageId)
  const clientId = optionalString(value.clientId)
  return {
    ...sessionId === undefined ? {} : { sessionId },
    ...messageId === undefined ? {} : { messageId },
    ...typeof value.turn === 'number' && Number.isInteger(value.turn) ? { turn: value.turn } : {},
    ...clientId === undefined ? {} : { clientId },
  }
}

function integerParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw httpError(400, `${name} must be an integer from ${min} to ${max}`)
  return value
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    res.writeHead(status, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = statusOf(error)
  const message = error instanceof Error ? error.message : 'internal knowledge API error'
  sendJson(res, status, { error: status >= 500 ? 'internal knowledge API error' : message, code: codeOf(error) })
}

function statusOf(error: unknown): number {
  if (isRecord(error) && typeof error.status === 'number') return error.status
  if (isRecord(error) && error.code === 'NOT_FOUND') return 404
  if (isRecord(error) && error.code === 'CONFLICT') return 409
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return 409
  return 500
}

function codeOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code
  return 'INTERNAL'
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status, code: status === 400 ? 'BAD_REQUEST' : `HTTP_${status}` })
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
