import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DEFAULT_KNOWLEDGE_BASE_ID, isKnowledgeType, normalizeDraft, normalizeKnowledgeBaseDraft,
  normalizeKnowledgeMountDraft, type CandidateProposal, type KnowledgeBaseDraft, type KnowledgeDraft,
  type ApiTokenRecord, type KnowledgeBasePatch, type KnowledgeMountDraft, type ReviewDecision, type TokenPermission,
} from './domain.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import type { RuntimeContextLike } from './runtime.js'
import type { NoteReference } from './notes/domain.js'

const MAX_BODY_BYTES = 1_048_576
const MAX_NOTE_BODY_BYTES = 64 * 1024 * 1024
export const LOCAL_MANAGEMENT_API_PREFIX = '/knowledge-local/v1'

export interface KnowledgeApiOptions {
  authMode?: 'bearer' | 'same-origin'
  service?: {
    current(): { publicApiEnabled: boolean; publicApiPrefix: string; writebackProvider?: string; writebackModel?: string }
    update(patch: { publicApiEnabled?: boolean; writebackProvider?: string | null; writebackModel?: string | null }): Promise<{ publicApiEnabled: boolean; publicApiPrefix: string; writebackProvider?: string; writebackModel?: string }>
  }
}

export function registerKnowledgeApi(
  ctx: RuntimeContextLike,
  provider: LocalKnowledgeProvider,
  prefix: string,
  options: KnowledgeApiOptions = {},
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('exposeApi requires the DSH webServer service')
  return webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      try {
        await dispatch(provider, prefix, options, req, res)
      } catch (error) {
        sendError(res, error)
      }
    },
  })
}

async function dispatch(
  provider: LocalKnowledgeProvider,
  prefix: string,
  options: KnowledgeApiOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://knowledge.local')
  const relative = url.pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
  let segments: string[]
  try {
    segments = relative.length === 0 ? [] : relative.split('/').map(decodeURIComponent)
  } catch {
    throw httpError(400, 'knowledge API path contains invalid encoding')
  }
  const method = req.method ?? 'GET'

  if (method === 'GET' && segments[0] === 'health') {
    return sendJson(res, 200, { ok: true, service: 'dsh-knowledge', schemaVersion: 10 })
  }

  const actor = options.authMode === 'same-origin' ? authenticateSameOrigin(req) : authenticateBearer(provider, req)

  if (segments[0] === 'notes') {
    if (method === 'GET' && segments.length === 1) {
      requirePermission(actor.permissions, 'read')
      const query = url.searchParams.get('q')
      const parentId = url.searchParams.get('parentId')
      return sendJson(res, 200, provider.notes.list({
        ...query === null ? {} : { query },
        ...query === null ? { parentId } : {},
        limit: integerParam(url, 'limit', 200, 1, 500),
      }))
    }
    if (method === 'POST' && segments[1] === 'folders' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 201, await provider.notes.createFolder(requiredString(body.name, 'name'), nullableString(body.parentId, 'parentId')))
    }
    if (method === 'POST' && segments[1] === 'documents' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 201, await provider.notes.createDocument(
        requiredString(body.name, 'name'),
        nullableString(body.parentId, 'parentId'),
        typeof body.content === 'string' ? body.content : '',
      ))
    }
    if (method === 'POST' && segments[1] === 'files' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const name = url.searchParams.get('name') ?? ''
      const parentId = url.searchParams.get('parentId')
      const mediaType = firstHeader(req.headers['content-type']) ?? 'application/octet-stream'
      const content = await readBinary(req, MAX_NOTE_BODY_BYTES)
      return sendJson(res, 201, await provider.notes.upload({ name, parentId, mediaType, content }))
    }
    const id = segments[1]
    if (id !== undefined && method === 'GET' && segments.length === 2) {
      requirePermission(actor.permissions, 'read')
      const node = provider.notes.get(id)
      if (node === undefined) throw httpError(404, `note node "${id}" was not found`)
      return sendJson(res, 200, node)
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'content' && segments.length === 3) {
      requirePermission(actor.permissions, 'read')
      const note = await provider.notes.read(id)
      return sendOpaqueFile(res, note.node.name, note.node.mediaType ?? 'application/octet-stream', note.content, url.searchParams.get('download') === '1')
    }
    if (id !== undefined && method === 'PUT' && segments[2] === 'content' && segments.length === 3) {
      requirePermission(actor.permissions, 'write')
      return sendJson(res, 200, await provider.notes.updateContent(id, await readBinary(req, MAX_NOTE_BODY_BYTES)))
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'references' && segments.length === 3) {
      requirePermission(actor.permissions, 'read')
      return sendJson(res, 200, await noteReferencesForSubtree(provider, id))
    }
    if (id !== undefined && method === 'PATCH' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      let node = provider.notes.get(id)
      if (node === undefined) throw httpError(404, `note node "${id}" was not found`)
      if (Object.hasOwn(body, 'name')) node = provider.notes.rename(id, requiredString(body.name, 'name'))
      if (Object.hasOwn(body, 'parentId')) node = provider.notes.move(id, nullableString(body.parentId, 'parentId'))
      return sendJson(res, 200, node)
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'copy' && segments.length === 3) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 201, await provider.notes.copy(
        id,
        Object.hasOwn(body, 'parentId') ? nullableString(body.parentId, 'parentId') : undefined,
        Object.hasOwn(body, 'name') ? requiredString(body.name, 'name') : undefined,
      ))
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      requirePermission(actor.permissions, 'admin')
      const noteIds = provider.notes.subtree(id).filter(node => node.kind !== 'folder').map(node => node.id)
      const references = await noteReferencesForSubtree(provider, id)
      if (references.length > 0 && url.searchParams.get('force') !== 'true') {
        throw httpError(409, `note content is referenced by ${references.length} knowledge document(s)`)
      }
      await provider.notes.delete(id)
      provider.deleteNoteReferences(noteIds)
      return sendJson(res, 204, undefined)
    }
  }

  if (segments[0] === 'settings' && segments.length === 1) {
    requirePermission(actor.permissions, 'read')
    if (method === 'GET') return sendJson(res, 200, await provider.getSettings())
    if (method === 'PUT') {
      requirePermission(actor.permissions, 'admin')
      const body = await readObject(req)
      if (!isRecord(body.patch)) throw httpError(400, 'knowledge settings patch is invalid')
      const writebackPolicy = body.patch.writebackPolicy
      if (writebackPolicy !== undefined && writebackPolicy !== 'conservative' && writebackPolicy !== 'proactive') throw httpError(400, 'writebackPolicy must be conservative or proactive')
      return sendJson(res, 200, await provider.updateSettings({
        ...writebackPolicy === undefined ? {} : { writebackPolicy },
      }))
    }
  }

  if (segments[0] === 'service' && segments.length === 1 && options.service !== undefined) {
    requirePermission(actor.permissions, 'admin')
    if (method === 'GET') return sendJson(res, 200, options.service.current())
    if (method === 'PUT') {
      const body = await readObject(req)
      if (body.publicApiEnabled !== undefined && typeof body.publicApiEnabled !== 'boolean') throw httpError(400, 'publicApiEnabled must be a boolean')
      const writebackProvider = body.writebackProvider
      const writebackModel = body.writebackModel
      if (writebackProvider !== undefined && writebackProvider !== null && typeof writebackProvider !== 'string') throw httpError(400, 'writebackProvider must be a string or null')
      if (writebackModel !== undefined && writebackModel !== null && typeof writebackModel !== 'string') throw httpError(400, 'writebackModel must be a string or null')
      return sendJson(res, 200, await options.service.update({
        ...body.publicApiEnabled === undefined ? {} : { publicApiEnabled: body.publicApiEnabled },
        ...writebackProvider === undefined ? {} : { writebackProvider },
        ...writebackModel === undefined ? {} : { writebackModel },
      }))
    }
  }

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

  if (method === 'GET' && segments[0] === 'document-index' && segments.length === 1) {
    requirePermission(actor.permissions, 'read')
    const query = url.searchParams.get('q') ?? undefined
    const cursor = url.searchParams.get('cursor') ?? undefined
    const requestedBaseIds = url.searchParams.getAll('knowledgeBaseId').map(id => id.trim()).filter(Boolean)
    const sessionId = url.searchParams.get('sessionId')?.trim()
    const knowledgeBaseIds = sessionId
      ? (await provider.resolveMounts(sessionId, url.searchParams.get('projectId') ?? undefined)).map(mount => mount.knowledgeBaseId)
      : requestedBaseIds.length > 0 ? requestedBaseIds : undefined
    return sendJson(res, 200, await provider.listDocumentIndex({
      ...knowledgeBaseIds === undefined ? {} : { knowledgeBaseIds },
      activeKnowledgeBasesOnly: url.searchParams.get('active') === '1',
      ...query === undefined ? {} : { query },
      ...cursor === undefined ? {} : { cursor },
      limit: integerParam(url, 'limit', 60, 1, 100),
    }))
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
    if (id !== undefined && method === 'PATCH' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 200, await provider.patchKnowledgeBase(id, parseKnowledgeBasePatch(body.patch)))
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'archive' && segments.length === 3) {
      requirePermission(actor.permissions, 'admin')
      return sendJson(res, 200, await provider.archiveKnowledgeBase(id))
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'restore' && segments.length === 3) {
      requirePermission(actor.permissions, 'admin')
      return sendJson(res, 200, await provider.restoreKnowledgeBase(id))
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      requirePermission(actor.permissions, 'admin')
      await provider.deleteKnowledgeBase(id)
      return sendJson(res, 204, undefined)
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
    if (method === 'POST' && segments[1] === 'bulk' && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      const upserts = Array.isArray(body.upserts) ? body.upserts.map(parseMountDraft) : []
      const deleteIds = Array.isArray(body.deleteIds)
        ? body.deleteIds.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean)
        : []
      if (upserts.length + deleteIds.length === 0) throw httpError(400, 'mount batch must contain at least one operation')
      if (upserts.length + deleteIds.length > 500) throw httpError(400, 'mount batch must contain at most 500 operations')
      return sendJson(res, 200, await provider.applyMountBatch({ upserts, deleteIds }))
    }
    if (method === 'DELETE' && segments[1] !== undefined && segments.length === 2) {
      requirePermission(actor.permissions, 'write')
      await provider.deleteMount(segments[1])
      return sendJson(res, 204, undefined)
    }
  }

  if (segments[0] === 'documents') {
    if (method === 'GET' && segments.length === 1) {
      requirePermission(actor.permissions, 'read')
      return sendJson(res, 200, await provider.listDocuments(
        url.searchParams.get('knowledgeBaseId') ?? undefined,
        url.searchParams.get('q') ?? undefined,
      ))
    }
    if (method === 'GET' && segments[1] !== undefined && segments.length === 2) {
      requirePermission(actor.permissions, 'read')
      const document = await provider.getDocument(segments[1])
      if (document === undefined) throw httpError(404, `knowledge document "${segments[1]}" was not found`)
      return sendJson(res, 200, document)
    }
    if (method === 'POST' && segments[1] !== undefined && segments[2] === 'finalize' && segments.length === 3) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      if (body.state !== 'resolved' && body.state !== 'complete') {
        throw httpError(400, 'document finalization state must be resolved or complete')
      }
      const note = optionalString(body.note)
      return sendJson(res, 200, await provider.finalize(segments[1], body.state, note))
    }
    if (method === 'POST' && segments[1] !== undefined && segments[2] === 'reopen' && segments.length === 3) {
      requirePermission(actor.permissions, 'write')
      return sendJson(res, 200, await provider.reopen(segments[1]))
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
    if (id !== undefined && method === 'GET' && segments[2] === 'note-references' && segments.length === 3) {
      requirePermission(actor.permissions, 'read')
      return sendJson(res, 200, await provider.listKnowledgeNoteReferences(id))
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'note-references' && segments.length === 3) {
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      const source = body.source === 'agent' ? 'agent' : 'user'
      const sourceSessionId = source === 'agent' ? optionalString(body.sourceSessionId) : undefined
      return sendJson(res, 201, await provider.addKnowledgeNoteReference(
        id,
        requiredString(body.noteId, 'noteId'),
        source,
        sourceSessionId,
      ))
    }
    if (id !== undefined && method === 'DELETE' && segments[2] === 'note-references' && segments[3] !== undefined && segments.length === 4) {
      requirePermission(actor.permissions, 'write')
      await provider.deleteKnowledgeNoteReference(id, segments[3])
      return sendJson(res, 204, undefined)
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
    if (method === 'POST' && segments[1] === 'direct' && segments.length === 2) {
      requirePermission(actor.permissions, 'propose')
      requirePermission(actor.permissions, 'write')
      const body = await readObject(req)
      return sendJson(res, 200, await provider.writeDirect(parseProposal(body.proposal), optionalString(body.sourceKey)))
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
    if (method === 'POST' && segments[2] === 'reset') {
      await provider.resetExtraction(sourceKey)
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
      const token = provider.listApiTokens().find(item => item.id === segments[1])
      if (token === undefined) throw httpError(404, 'API token was not found')
      if (token.revokedAt === undefined) provider.revokeApiToken(segments[1])
      else provider.deleteApiToken(segments[1])
      return sendJson(res, 204, undefined)
    }
  }

  throw httpError(404, 'knowledge API route was not found')
}

function parseKnowledgeBaseDraft(value: unknown): KnowledgeBaseDraft {
  if (!isRecord(value)) throw httpError(400, 'knowledge base draft is invalid')
  try {
    const writebackProvider = optionalNullableStringProperty(value, 'writebackProvider')
    const writebackModel = optionalNullableStringProperty(value, 'writebackModel')
    return normalizeKnowledgeBaseDraft({
      name: typeof value.name === 'string' ? value.name : '',
      description: typeof value.description === 'string' ? value.description : '',
      defaultTags: Array.isArray(value.defaultTags) ? value.defaultTags.filter((tag): tag is string => typeof tag === 'string') : [],
      extractionInstructions: typeof value.extractionInstructions === 'string' ? value.extractionInstructions : '',
      writebackPolicy: value.writebackPolicy === 'proactive' ? 'proactive' : 'conservative',
      ...writebackProvider === undefined || writebackProvider === null ? {} : { writebackProvider },
      ...writebackModel === undefined || writebackModel === null ? {} : { writebackModel },
    })
  } catch (error) {
    throw httpError(400, error instanceof Error ? error.message : 'knowledge base draft is invalid')
  }
}

function parseKnowledgeBasePatch(value: unknown): KnowledgeBasePatch {
  if (!isRecord(value)) throw httpError(400, 'knowledge base patch is invalid')
  const patch: KnowledgeBasePatch = {}
  if (Object.hasOwn(value, 'name')) {
    if (typeof value.name !== 'string') throw httpError(400, 'knowledge base patch name must be a string')
    patch.name = value.name
  }
  if (Object.hasOwn(value, 'description')) {
    if (typeof value.description !== 'string') throw httpError(400, 'knowledge base patch description must be a string')
    patch.description = value.description
  }
  if (Object.hasOwn(value, 'defaultTags')) {
    if (!Array.isArray(value.defaultTags) || value.defaultTags.some(tag => typeof tag !== 'string')) {
      throw httpError(400, 'knowledge base patch defaultTags must be a string array')
    }
    patch.defaultTags = value.defaultTags as string[]
  }
  if (Object.hasOwn(value, 'extractionInstructions')) {
    if (typeof value.extractionInstructions !== 'string') throw httpError(400, 'knowledge base patch extractionInstructions must be a string')
    patch.extractionInstructions = value.extractionInstructions
  }
  if (Object.hasOwn(value, 'writebackPolicy')) {
    if (value.writebackPolicy !== 'conservative' && value.writebackPolicy !== 'proactive') throw httpError(400, 'knowledge base patch writebackPolicy is invalid')
    patch.writebackPolicy = value.writebackPolicy
  }
  if (Object.hasOwn(value, 'writebackProvider')) {
    patch.writebackProvider = optionalNullableStringProperty(value, 'writebackProvider') as string | null
  }
  if (Object.hasOwn(value, 'writebackModel')) {
    patch.writebackModel = optionalNullableStringProperty(value, 'writebackModel') as string | null
  }
  if (Object.keys(patch).length === 0) throw httpError(400, 'knowledge base patch must contain at least one editable field')
  return patch
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

function authenticateBearer(provider: LocalKnowledgeProvider, req: IncomingMessage): ApiTokenRecord {
  const authorization = req.headers.authorization
  if (authorization === undefined || !authorization.startsWith('Bearer ')) throw httpError(401, 'bearer token is required')
  const actor = provider.authenticate(authorization.slice(7).trim())
  if (actor === undefined) throw httpError(401, 'bearer token is invalid or revoked')
  return actor
}

function authenticateSameOrigin(req: IncomingMessage): ApiTokenRecord {
  assertKnowledgeBrowserRequest(req, 'management-web')
  return {
    id: 'same-origin-management',
    name: 'DSH management console',
    permissions: ['admin'],
    createdAt: new Date(0).toISOString(),
  }
}

export function assertKnowledgeBrowserRequest(req: IncomingMessage, client: 'management-web' | 'conversation-web'): void {
  if (req.headers['x-dsh-knowledge-client'] !== client) {
    throw httpError(401, 'knowledge client header is required')
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw httpError(403, 'cross-site knowledge request was rejected')
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost: string
    try { originHost = new URL(origin).host } catch { throw httpError(403, 'knowledge request origin is invalid') }
    const expectedHost = firstHeader(req.headers['x-forwarded-host']) ?? req.headers.host
    if (expectedHost === undefined || originHost.toLowerCase() !== expectedHost.toLowerCase()) {
      throw httpError(403, 'cross-origin knowledge request was rejected')
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim()
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

async function readBinary(req: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) throw httpError(413, 'request body is too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maximumBytes) throw httpError(413, 'request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function noteReferences(provider: LocalKnowledgeProvider, noteId: string): Promise<NoteReference[]> {
  const node = provider.notes.get(noteId)
  if (node === undefined) throw httpError(404, `note node "${noteId}" was not found`)
  if (node.kind === 'folder') return []
  const structured = provider.noteReferencesForNotes([noteId])
  const marker = `note://${noteId}`
  const legacy = (await provider.listDocuments())
    .filter(document => document.content.includes(marker))
    .map(document => ({
      noteId,
      knowledgeBaseId: document.knowledgeBaseId,
      documentId: document.id,
      documentTitle: document.title,
    }))
  return deduplicateNoteReferences([...structured, ...legacy])
}

async function noteReferencesForSubtree(provider: LocalKnowledgeProvider, noteId: string): Promise<NoteReference[]> {
  const noteIds = provider.notes.subtree(noteId).filter(node => node.kind !== 'folder').map(node => node.id)
  if (noteIds.length === 0) return []
  const structured = provider.noteReferencesForNotes(noteIds)
  const noteIdSet = new Set(noteIds)
  const legacy = (await provider.listDocuments()).flatMap(document => {
    const references = document.content.match(/note:\/\/(note_[a-f0-9]{32})/giu) ?? []
    return [...new Set(references.map(value => value.slice('note://'.length).toLocaleLowerCase()))]
      .filter(id => noteIdSet.has(id))
      .map(id => ({
        noteId: id,
        knowledgeBaseId: document.knowledgeBaseId,
        documentId: document.id,
        documentTitle: document.title,
      }))
  })
  return deduplicateNoteReferences([...structured, ...legacy])
}

function deduplicateNoteReferences(references: NoteReference[]): NoteReference[] {
  return [...new Map(references.map(reference => [`${reference.documentId}\u0000${reference.noteId}`, reference])).values()]
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
  if (value.resolution !== undefined && value.resolution !== 'merge') throw httpError(400, 'review resolution is invalid')
  const note = optionalString(value.note)
  return {
    decision: value.decision,
    ...value.resolution === 'merge' ? { resolution: value.resolution } : {},
    ...note === undefined ? {} : { note },
    ...value.draft === undefined ? {} : { draft: parseDraft(value.draft) },
  }
}

function parseSource(value: Record<string, unknown>): NonNullable<KnowledgeDraft['source']> {
  const sessionId = optionalString(value.sessionId)
  const messageId = optionalString(value.messageId)
  const clientId = optionalString(value.clientId)
  const evidence = value.evidence === 'explicit' || value.evidence === 'verified' || value.evidence === 'inferred'
    ? value.evidence
    : undefined
  return {
    ...sessionId === undefined ? {} : { sessionId },
    ...messageId === undefined ? {} : { messageId },
    ...typeof value.turn === 'number' && Number.isInteger(value.turn) ? { turn: value.turn } : {},
    ...clientId === undefined ? {} : { clientId },
    ...evidence === undefined ? {} : { evidence },
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

function sendOpaqueFile(
  res: ServerResponse,
  originalName: string,
  mediaType: string,
  content: Buffer,
  download: boolean,
): void {
  const asciiName = originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'document'
  const encodedName = encodeURIComponent(originalName).replaceAll("'", '%27')
  res.writeHead(200, {
    'content-type': mediaType,
    'content-length': content.byteLength,
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'content-security-policy': "sandbox; default-src 'none'",
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(content)
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

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw httpError(400, `${name} must be a non-empty string`)
  return value
}

function nullableString(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw httpError(400, `${name} must be a string or null`)
  return value
}

function optionalNullableStringProperty(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const member = value[key]
  if (member === null) return null
  if (typeof member !== 'string') throw httpError(400, `${key} must be a string or null`)
  return member
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
