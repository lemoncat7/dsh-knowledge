import { createHash } from 'node:crypto'
import { normalizeKnowledgeMountDraft, type KnowledgeMount, type KnowledgeMountDraft } from './domain.js'
import type { KnowledgeProvider } from './provider.js'

export const KNOWLEDGE_MOUNT_MANAGEMENT_SERVICE = 'dshKnowledgeMountManagement'
export interface MountTarget { kind: 'project' | 'session'; id: string }

/** Host-plugin integration only, not an Agent tool. Uses the active provider and
 * its remote read/write token permissions; never accesses a second data store. */
export function createKnowledgeMountManagement(provider: KnowledgeProvider, connectionRevision: () => number = () => 0) {
  const read = async (input: MountTarget[], signal?: AbortSignal) => {
    const targets = validateTargets(input)
    const connection = connectionRevision()
    const scopes: Array<{ target: MountTarget; mounts: KnowledgeMount[] }> = []
    for (let offset = 0; offset < targets.length; offset += 8) {
      signal?.throwIfAborted()
      scopes.push(...await Promise.all(targets.slice(offset, offset + 8).map(async target => ({ target, mounts: await provider.listMounts(target.kind, target.id, signal) }))))
      if (connectionRevision() !== connection) throw new Error('知识库连接已切换，请重新读取挂载后重试')
    }
    const revision = createHash('sha256').update(JSON.stringify({ connection, scopes: scopes.map(scope => ({ ...scope, mounts: [...scope.mounts].sort((a, b) => a.id.localeCompare(b.id)) })) })).digest('hex').slice(0, 24)
    return { backend: provider.mode, scopes, revision }
  }
  return {
    version: 1 as const,
    async catalog(signal?: AbortSignal) {
      return { backend: provider.mode, bases: (await provider.listKnowledgeBases(signal)).filter(base => base.status === 'active').map(base => ({ id: base.id, name: base.name, description: base.description })) }
    },
    read,
    async configure(targets: MountTarget[], expectedRevision: string, input: Omit<KnowledgeMountDraft, 'targetKind' | 'targetId'>, signal?: AbortSignal, beforeWrite?: () => void) {
      const connection = connectionRevision()
      const current = await read(targets, signal)
      if (!expectedRevision || current.revision !== expectedRevision) throw new Error('知识库挂载已变化，请重新读取后重试')
      if (typeof input.enabled !== 'boolean' || typeof input.recallEnabled !== 'boolean') throw new Error('enabled 和 recallEnabled 必须为布尔值')
      // Disable with an explicit row instead of deleting it: deletion would
      // unexpectedly re-enable an inherited project mount for a session.
      const upserts = current.scopes.map(({ target }) => normalizeKnowledgeMountDraft({ ...input, targetKind: target.kind, targetId: target.id }))
      signal?.throwIfAborted()
      beforeWrite?.()
      if (connectionRevision() !== connection) throw new Error('知识库连接已切换，请重新读取挂载后重试')
      const backend = provider.mode
      const result = await provider.applyMountBatch({ upserts, deleteIds: [] }, signal)
      return { applied: true, backend, mounts: result.mounts }
    },
  }
}

function validateTargets(targets: MountTarget[]): MountTarget[] {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 100) throw new Error('挂载目标数量必须在 1 到 100 之间')
  const seen = new Set<string>()
  return targets.map(target => {
    if (!target || (target.kind !== 'project' && target.kind !== 'session') || typeof target.id !== 'string' || !target.id.trim()) throw new Error('挂载目标无效')
    const value = { kind: target.kind, id: target.id.trim() }
    const key = JSON.stringify(value)
    if (seen.has(key)) throw new Error('挂载目标重复')
    seen.add(key)
    return value
  })
}
