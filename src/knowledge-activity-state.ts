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
