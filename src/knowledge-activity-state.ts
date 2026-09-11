import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'

/** Legacy details requires content; new docked tabs support a loaded blank session. */
export function availableActivitySession(state: Pick<SessionListState, 'current' | 'byId'>, docked = false): string | undefined {
  const current = state.current
  if (current === undefined || state.byId[current] === undefined) return undefined
  return docked || state.byId[current]?.blank === false ? String(current) : undefined
}

export interface KnowledgeActivitySelection {
  mode?: 'knowledge' | 'notes'
  knowledgeBaseId?: string | undefined
  documentId?: string | undefined
  noteFolderId?: string | null | undefined
  noteDocumentId?: string | undefined
  noteCrumbs?: { id: string | null; name: string }[]
}

/** A base change cannot carry the previous base's document into the next view. */
export function mergeActivitySelection(previous: KnowledgeActivitySelection, next: KnowledgeActivitySelection): KnowledgeActivitySelection {
  const merged = { ...previous, ...next }
  if ('knowledgeBaseId' in next && next.knowledgeBaseId !== previous.knowledgeBaseId && !('documentId' in next)) {
    merged.documentId = undefined
  }
  return merged
}
