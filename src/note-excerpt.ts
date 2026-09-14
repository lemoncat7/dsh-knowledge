export interface NoteExcerptRequest {
  requestId: string
  noteId: string
  text: string
  knowledgeBaseId: string
  documentId?: string
  expectedVersion?: number
  title?: string
}

/** Plain selected text must not introduce Markdown/HTML or a second link. */
export function noteExcerptMarkdown(noteId: string, text: string): string {
  if (!/^note_[a-f0-9]{32}$/.test(noteId)) throw new Error('无效的来源笔记')
  return text.trim().split(/\r?\n/).map(line => line.trim()
    ? `[${line.replace(/[\\`*_[\]<>!#|~]/g, '\\$&')}](note://${noteId})`
    : '').join('\n\n')
}
