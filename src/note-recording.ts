import { createHash } from 'node:crypto'
import type { KnowledgeProvider } from './provider.js'

/** Host-only integration. Callers must bind operations to an explicit user-selected note. */
export function createNoteRecording(provider: KnowledgeProvider) {
  const read = async (id: string, signal?: AbortSignal) => {
    const { node, content } = await provider.readNote(id, signal)
    if (!node?.editable || node.kind === 'folder') throw new Error('记录笔记不存在或不是可编辑文本')
    if (content.byteLength > 200_000) throw new Error('记录笔记过大，请先整理后继续')
    return { id, name: node.name, version: node.version, content: new TextDecoder('utf-8', { fatal: true }).decode(content), revision: createHash('sha256').update(content).digest('hex') }
  }
  return {
    version: 1,
    async list(query: string, signal?: AbortSignal) {
      return (await provider.listNotes({ query: query.trim(), limit: 40 }, signal))
        .filter(node => node.editable && node.kind !== 'folder').map(node => ({ id: node.id, name: node.name }))
    },
    read,
    async update(id: string, value: string, expectedRevision: string, signal?: AbortSignal) {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 200_000) throw new Error('记录内容超过上限')
      const current = await read(id, signal)
      if (current.revision !== expectedRevision) throw new Error('笔记已变化，请重新读取后再更新')
      if (current.content === value) return { id, changed: false }
      await provider.updateNoteContent(id, new TextEncoder().encode(value), signal, current.version)
      return { id, changed: true }
    },
  }
}
