import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KnowledgeBase, KnowledgeMountDraft } from './domain.js'
import type { LocalKnowledgeProvider } from './local-provider.js'
import type { RuntimeContextLike } from './runtime.js'
import { assertKnowledgeBrowserRequest } from './api.js'

export const MOUNT_SELECTION_PATH = '/knowledge-control/v1/mount-selection'

/** One library the in-conversation selector may mount; only active and actually readable libraries qualify. */
export interface MountCandidate {
  knowledgeBaseId: string
  name: string
  /** Local libraries are listed only after they connected (ready/partial). */
  conversationEnabled?: boolean
}

export interface SessionSelectionView {
  sessionId: string
  /** The session-level library that currently applies to recall; null means "no library selected". */
  selected: MountCandidate | null
  candidates: MountCandidate[]
}

function selectionError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status })
}

function normalizeSessionId(value: string): string {
  const sessionId = value.trim()
  if (sessionId.length === 0 || sessionId.length > 500) throw selectionError('需要一个有效的会话标识（sessionId）')
  return sessionId
}

function sortCandidates(candidates: MountCandidate[]): MountCandidate[] {
  return candidates.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
}

/**
 * Libraries offered by the selector: every active, readable library. A library with local
 * storage is offered only after it finished connecting; an unconnected one stays out until
 * it is readable, and archived libraries are never selectable.
 */
export async function mountCandidates(provider: LocalKnowledgeProvider): Promise<MountCandidate[]> {
  const wiki = new Map(provider.wiki.list().map(entry => [entry.kbId, entry]))
  const bases: KnowledgeBase[] = (await provider.listKnowledgeBases()).filter(base => base.status === 'active')
  const candidates: MountCandidate[] = []
  for (const base of bases) {
    const config = wiki.get(base.id)
    if (config === undefined) {
      candidates.push({ knowledgeBaseId: base.id, name: base.name })
      continue
    }
    const state = provider.wiki.connectionStatus(base.id).state
    if (state !== 'ready' && state !== 'partial') continue
    candidates.push({ knowledgeBaseId: base.id, name: base.name, ...(config.conversationEnabled ? { conversationEnabled: true } : {}) })
  }
  return sortCandidates(candidates)
}

/** The session selection as recall sees it: an enabled session-level mount, never a project mount. */
export async function sessionSelectionView(provider: LocalKnowledgeProvider, rawSessionId: string): Promise<SessionSelectionView> {
  const sessionId = normalizeSessionId(rawSessionId)
  const [candidates, mounts] = await Promise.all([mountCandidates(provider), provider.resolveMounts(sessionId)])
  const sessionMounts = mounts.filter(mount => mount.targetKind === 'session' && mount.targetId === sessionId && mount.enabled)
  const effective = sessionMounts.sort((left, right) => left.base.name.localeCompare(right.base.name, 'zh-Hans-CN'))[0]
  return {
    sessionId,
    selected: effective === undefined
      ? null
      : { knowledgeBaseId: effective.knowledgeBaseId, name: effective.base.name },
    candidates,
  }
}

/**
 * Apply one session selection. Exactly one library is enabled per session afterwards:
 * selecting a library disables every other session-level mount, and `null` clears the
 * selection without touching project-level mounts. Selecting is the user's explicit
 * authorization for this session, so the mount gets `writeMode: 'direct'`; clearing only
 * disables mounts and keeps their records for later re-selection.
 */
export async function selectSessionKnowledgeBase(
  provider: LocalKnowledgeProvider,
  rawSessionId: string,
  knowledgeBaseId: string | null,
): Promise<SessionSelectionView> {
  const sessionId = normalizeSessionId(rawSessionId)
  const mounts = await provider.listMounts('session', sessionId)
  if (knowledgeBaseId === null) {
    for (const mount of mounts) {
      if (!mount.enabled && !mount.recallEnabled) continue
      await provider.upsertMount({ ...mount, enabled: false, recallEnabled: false })
    }
    return sessionSelectionView(provider, sessionId)
  }
  const target = (await mountCandidates(provider)).find(candidate => candidate.knowledgeBaseId === knowledgeBaseId)
  if (target === undefined) {
    throw selectionError('只能选择可用的知识库（已启用且已完成接入）')
  }
  for (const mount of mounts) {
    if (mount.knowledgeBaseId === knowledgeBaseId) continue
    if (!mount.enabled && !mount.recallEnabled) continue
    await provider.upsertMount({ ...mount, enabled: false, recallEnabled: false })
  }
  const existing = mounts.find(mount => mount.knowledgeBaseId === knowledgeBaseId)
  const draft: KnowledgeMountDraft = existing === undefined
    ? { targetKind: 'session', targetId: sessionId, knowledgeBaseId, enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '' }
    : { ...existing, enabled: true, recallEnabled: true, writeMode: 'direct' }
  await provider.upsertMount(draft)
  return sessionSelectionView(provider, sessionId)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    size += buffer.length
    if (size > 16_384) throw selectionError('请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw selectionError('请求体必须是 JSON')
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value))
}

/** Same-origin conversation surface for the composer selector; local backend only. */
export function registerMountSelectionControl(
  ctx: RuntimeContextLike,
  provider: LocalKnowledgeProvider,
  options: { available?: () => boolean } = {},
): (() => void) | undefined {
  return ctx.webServer?.register({
    kind: 'exact',
    path: MOUNT_SELECTION_PATH,
    handler(req, res) {
      void (async () => {
        try {
          assertKnowledgeBrowserRequest(req, 'conversation-web')
          if (options.available !== undefined && !options.available()) throw selectionError('知识库选择仅在本地后端可用', 409)
          const url = new URL(req.url ?? '/', 'http://localhost')
          let view: SessionSelectionView
          if (req.method === 'GET') {
            view = await sessionSelectionView(provider, url.searchParams.get('sessionId') ?? '')
          } else if (req.method === 'POST') {
            const body = await readJsonBody(req)
            if (body === undefined) throw selectionError('请求体必须是 JSON 对象')
            const selected = body.knowledgeBaseId
            if (selected !== null && typeof selected !== 'string') throw selectionError('knowledgeBaseId 必须是知识库 id 或 null')
            view = await selectSessionKnowledgeBase(provider, typeof body.sessionId === 'string' ? body.sessionId : '', selected)
          } else {
            res.writeHead(405, { allow: 'GET, POST' }).end()
            return
          }
          sendJson(res, 200, view)
        } catch (error) {
          const status = (error as { status?: number }).status ?? 500
          sendJson(res, status, { error: status < 500 && error instanceof Error ? error.message : '知识库选择操作失败，请稍后重试' })
        }
      })()
    },
  })
}
