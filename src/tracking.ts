import { createHash } from 'node:crypto'
import { containsSensitiveContent } from './content-safety.js'
import { normalizeTags, type CandidateProposal, type KnowledgeEntry, type ResolvedKnowledgeMount } from './domain.js'
import type { KnowledgeProvider } from './provider.js'
import { resolveKnowledgeMounts } from './retrieval.js'
import type { AgentLike } from './runtime.js'

export const KNOWLEDGE_TRACKING_SERVICE = 'dshKnowledgeTracking'

export interface KnowledgeTrackingInput {
  id: string
  subject: string
  event: string
  evidence: string
  source: string
  reference?: string
  at: number
}

export interface KnowledgeTrackingResult {
  storage: 'knowledge' | 'local'
  outcome: 'written' | 'pending-review' | 'not-mounted' | 'not-writable' | 'ambiguous'
  knowledgeBaseId?: string
}

export interface KnowledgeTrackingSource {
  kind: 'knowledge'
  label: string
  detail: string
  token: string
}

export interface KnowledgeTrackingService {
  record(agent: AgentLike, input: KnowledgeTrackingInput, signal?: AbortSignal): Promise<KnowledgeTrackingResult>
  list(agent: AgentLike, query?: string, limit?: number, signal?: AbortSignal): Promise<KnowledgeTrackingSource[]>
}

export function createKnowledgeTrackingService(provider: KnowledgeProvider): KnowledgeTrackingService {
  return {
    async record(agent, input, signal) {
      const mounts = await resolveKnowledgeMounts(provider, agent, signal)
      const selected = selectMount(mounts, input.reference)
      if (selected.outcome !== undefined) return { storage: 'local', outcome: selected.outcome }
      const mount = selected.mount
      if (mount === undefined) return { storage: 'local', outcome: 'not-mounted' }
      if (mount.writeMode === 'none') return { storage: 'local', outcome: 'not-writable', knowledgeBaseId: mount.knowledgeBaseId }
      const requestedTitle = referenceTitle(input.reference)
      const existing = await findEntry(provider, agent, mount, requestedTitle ?? input.subject, signal)
      const title = existing?.title ?? requestedTitle ?? compact(`伙伴关注 · ${input.subject}`, 200)
      const content = observationMarkdown(input)
      const proposal: CandidateProposal = {
        action: existing === undefined ? 'create' : 'update',
        ...(existing === undefined ? {} : { targetId: existing.id }),
        draft: {
          knowledgeBaseId: mount.knowledgeBaseId,
          title,
          body: content,
          type: existing?.type ?? 'fact',
          tags: normalizeTags([
            ...existing?.tags ?? [], ...mount.base.defaultTags, ...mount.includeTags, 'partner-observation',
          ]).filter(tag => !mount.excludeTags.includes(tag)),
          scope: existing?.scope ?? (agent.session.header.cwd ? { kind: 'project', id: agent.session.header.cwd } : { kind: 'global' }),
          confidence: existing?.confidence ?? .9,
          source: { sessionId: agent.session.id, evidence: 'verified' },
        },
        reason: `伙伴挂念出现了经过校验的新变化：${compact(input.event, 240)}`,
      }
      const sourceKey = `partner-observation:${input.id}:${createHash('sha256').update(content).digest('hex').slice(0, 24)}`
      if (mount.writeMode === 'audit' || containsSensitiveContent(`${title}\n${content}`)) {
        await provider.propose(proposal, sourceKey, signal)
        return { storage: 'knowledge', outcome: 'pending-review', knowledgeBaseId: mount.knowledgeBaseId }
      }
      await provider.writeDirect(proposal, sourceKey, signal)
      return { storage: 'knowledge', outcome: 'written', knowledgeBaseId: mount.knowledgeBaseId }
    },
    async list(agent, query = '', limit = 20, signal) {
      const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 40))
      const mounts = (await resolveKnowledgeMounts(provider, agent, signal)).filter(item => item.enabled && item.recallEnabled)
      if (mounts.length === 0) return []
      const foldedQuery = query.trim().replace(/^@(?:知识库\[)?/u, '').toLocaleLowerCase('zh-CN')
      const batches = await Promise.all(mounts.map(async mount => {
        const documents = await provider.listDocuments(mount.knowledgeBaseId, foldedQuery || undefined, signal)
        return documents.flatMap(document => {
          const baseReference = referenceBase(mount)
          const documentReference = document.title.trim()
          if (!baseReference || !documentReference || baseReference.includes(']') || documentReference.includes(']')) return []
          const label = `${mount.base.name} / ${document.title}`
          const score = sourceMatchScore(`${mount.base.name} ${mount.knowledgeBaseId} ${document.title} ${document.relPath}`, foldedQuery)
          if (score < 0) return []
          return [{
            kind: 'knowledge' as const,
            label,
            detail: `已挂载知识文档 · ${document.entryCount} 条知识`,
            token: `@知识库[${baseReference}/${documentReference}]`,
            score,
          }]
        })
      }))
      return batches.flat()
        .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label, 'zh-CN'))
        .slice(0, boundedLimit)
        .map(({ score: _score, ...source }) => source)
    },
  }
}

function referenceBase(mount: ResolvedKnowledgeMount): string {
  const name = mount.base.name.trim()
  return name && !name.includes('/') ? name : mount.knowledgeBaseId
}

function sourceMatchScore(value: string, query: string): number {
  if (!query) return 0
  const folded = value.toLocaleLowerCase('zh-CN')
  const index = folded.indexOf(query)
  return index < 0 ? -1 : (index === 0 ? 40 : 20) - index * .01
}

function selectMount(mounts: ResolvedKnowledgeMount[], reference?: string): { mount?: ResolvedKnowledgeMount; outcome?: KnowledgeTrackingResult['outcome'] } {
  const writable = mounts.filter(item => item.enabled)
  if (reference) {
    const base = reference.split('/')[0]?.trim().toLocaleLowerCase('zh-CN')
    const matches = writable.filter(item => item.knowledgeBaseId.toLocaleLowerCase('zh-CN') === base || item.base.name.toLocaleLowerCase('zh-CN') === base)
    if (matches.length === 0) return { outcome: 'not-mounted' }
    if (matches.length > 1) return { outcome: 'ambiguous' }
    return { mount: matches[0]! }
  }
  const candidates = writable.filter(item => item.writeMode !== 'none')
  if (candidates.length === 0) return { outcome: writable.length > 0 ? 'not-writable' : 'not-mounted' }
  if (candidates.length > 1) return { outcome: 'ambiguous' }
  return { mount: candidates[0]! }
}

async function findEntry(provider: KnowledgeProvider, agent: AgentLike, mount: ResolvedKnowledgeMount, title: string, signal?: AbortSignal): Promise<KnowledgeEntry | undefined> {
  const hits = await provider.search({
    text: title,
    ...(agent.session.header.cwd ? { projectId: agent.session.header.cwd } : {}),
    knowledgeBaseIds: [mount.knowledgeBaseId],
    ...mount.includeTags.length > 0 ? { includeTags: mount.includeTags } : {},
    ...mount.excludeTags.length > 0 ? { excludeTags: mount.excludeTags } : {},
    limit: 12,
  }, signal)
  const folded = title.trim().toLocaleLowerCase('zh-CN')
  return hits.map(item => item.entry).find(item => item.status === 'active' && item.documentState === 'open' && item.title.trim().toLocaleLowerCase('zh-CN') === folded)
}

function referenceTitle(reference?: string): string | undefined {
  const index = reference?.indexOf('/') ?? -1
  const value = index < 0 ? '' : reference?.slice(index + 1).trim() ?? ''
  return value || undefined
}

function observationMarkdown(input: KnowledgeTrackingInput): string {
  const date = new Date(input.at).toISOString()
  return [
    `## 伙伴观察 · ${date}`,
    '',
    `- 挂念：${compact(input.subject, 300)}`,
    `- 新变化：${compact(input.event, 800)}`,
    input.evidence ? `- 依据：${compact(input.evidence, 2_000)}` : '',
    input.source ? `- 来源：${compact(input.source, 500)}` : '',
  ].filter(Boolean).join('\n')
}

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
