import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { isNoteId, noteReferenceMarkdown } from './notes/domain.js'

export const NOTE_MENTION_SOURCE = 'knowledge-notes'
const PATH = '/knowledge-control/v1/activity/note-mentions'

interface NoteMention {
  id: string
  name: string
  sessionId: string
  sourceKey: string
}

/** An independent @ source: the host owns keyboard navigation, focus and cancellation. */
export function createNoteMentionSource(openNote: (id: string) => void, request: typeof fetch = fetch): InputTriggerSource {
  async function read(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await request(path, {
      signal, headers: { accept: 'application/json', 'x-dsh-knowledge-client': 'conversation-web' },
    })
    const body: unknown = await response.json()
    if (!response.ok) throw new Error(isObject(body) && typeof body.error === 'string' ? body.error : `笔记引用请求失败（HTTP ${response.status}）`)
    signal.throwIfAborted()
    return body
  }
  return {
    trigger: '@', name: NOTE_MENTION_SOURCE, order: 20, showGroupTitle: false,
    async candidates(session, { query, quoted, drilled, signal }) {
      if (quoted || drilled || query.length > 255) return []
      // The host aborts superseded queries; debounce without retaining session data.
      await pause(120, signal)
      const params = new URLSearchParams({ sessionId: session.sessionId, q: query.trim() })
      const body = await read(`${PATH}?${params}`, signal)
      if (!isObject(body) || typeof body.sourceKey !== 'string' || !Array.isArray(body.items)) throw new Error('笔记搜索返回了无效数据。')
      const sourceKey = body.sourceKey
      return body.items.slice(0, 20).map((item: unknown) => {
        if (!isObject(item) || typeof item.id !== 'string' || !isNoteId(item.id) || typeof item.name !== 'string' || typeof item.parent !== 'string') throw new Error('笔记搜索返回了无效文档。')
        return {
          name: item.name, icon: 'file' as const, section: '笔记文档', description: item.parent,
          value: JSON.stringify({ id: item.id, name: item.name, sessionId: session.sessionId, sourceKey } satisfies NoteMention),
        }
      })
    },
    onPick({ candidate, session, action }) {
      if (action !== 'pick') return undefined
      const note = parseReference(candidate.value)
      if (!note || note.sessionId !== session.sessionId) return undefined
      return { insert: {
        source: NOTE_MENTION_SOURCE, ref: candidate.value!, label: note.name, appearance: 'file',
        clipboardText: noteReferenceMarkdown(note),
      } }
    },
    openReference(session, { ref }) {
      const note = parseReference(ref)
      if (!note || note.sessionId !== session.sessionId) return false
      openNote(note.id)
      return true
    },
    codec: {
      clipboardText(ref) {
        const note = parseReference(ref)
        if (!note) throw new Error('笔记引用无效，请重新选择。')
        return noteReferenceMarkdown(note)
      },
      async serialize(ref, signal) {
        const note = parseReference(ref)
        if (!note) throw new Error('笔记引用无效，请重新选择。')
        const params = new URLSearchParams({ sessionId: note.sessionId, sourceKey: note.sourceKey })
        const body = await read(`${PATH}/${encodeURIComponent(note.id)}?${params}`, signal)
        if (!isObject(body) || typeof body.text !== 'string') throw new Error('笔记引用返回了无效数据。')
        return body.text
      },
    },
  }
}

function parseReference(raw: string | undefined): NoteMention | undefined {
  if (!raw || raw.length > 4096) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (isObject(value) && typeof value.id === 'string' && isNoteId(value.id)
      && typeof value.name === 'string' && value.name.length <= 255
      && typeof value.sessionId === 'string' && value.sessionId.length > 0
      && typeof value.sourceKey === 'string' && /^[a-f0-9]{64}$/.test(value.sourceKey)) return value as unknown as NoteMention
  } catch { /* Invalid clipboard or stale draft payload: never guess another note. */ }
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
