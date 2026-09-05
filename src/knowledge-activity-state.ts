import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'

/** DSH reserves the details column only for a loaded, non-blank session. */
export function availableActivitySession(state: Pick<SessionListState, 'current' | 'byId'>): string | undefined {
  const current = state.current
  return current !== undefined && state.byId[current]?.blank === false ? String(current) : undefined
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
