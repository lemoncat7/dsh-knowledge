import type { KnowledgeEntry } from '../domain.js'

/** Stable, human-readable Markdown path shared by storage and retrieval output. */
export function knowledgeDocumentPath(entry: Pick<KnowledgeEntry, 'id' | 'title'>): string {
  const stem = entry.title.normalize('NFKC').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72) || 'untitled'
  const suffix = entry.id.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8) || 'document'
  return `${stem}--${suffix}.md`
}
