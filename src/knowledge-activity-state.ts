/** DSH 0.1.7 removed `current` from SessionListState; both generations share this shape. */
export interface SessionListSnapshotLike<K extends string = string> {
  readonly byId: Readonly<Partial<Record<K, { readonly retainedBy?: { readonly mainView?: number } | undefined }>>>
  readonly current?: string | undefined
}

/**
 * Derive the session the main view shows: 0.1.7 keeps it as main-view
 * retention (`retainedBy.mainView`), older hosts keep the plain `current` field.
 */
export function deriveCurrentSession<K extends string>(state: SessionListSnapshotLike<K>): K | undefined {
  const rows = Object.entries(
    (state.byId ?? {}) as Readonly<Record<string, { readonly retainedBy?: { readonly mainView?: number } | undefined } | undefined>>,
  )
  const retained = rows.find(([, row]) => (row?.retainedBy?.mainView ?? 0) > 0)?.[0]
  return (retained ?? state.current) as K | undefined
}

/** Legacy details requires content; new docked tabs support a loaded blank session. */
export function availableActivitySession<K extends string>(state: {
  readonly byId: Readonly<Partial<Record<K, { readonly blank?: boolean | undefined; readonly retainedBy?: { readonly mainView?: number } | undefined }>>>
  readonly current?: string | undefined
}, docked = false): string | undefined {
  const current = deriveCurrentSession(state)
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
