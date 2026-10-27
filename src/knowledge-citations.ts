/** Durable navigation metadata, never a credential or a grant of read access. */
export interface KnowledgeCitation {
  documentId: string; knowledgeBaseId: string; sessionId: string; sourceKey: string
  projectId?: string
  title: string; version: number; startLine: number; endLine: number
}
// A query-free local destination is rendered as a clickable file reference by
// DSH 0.2.1. The plugin owns this reserved path and never invokes file access.
export const CITATION_PREFIX = '/knowledge/cite/'

export function encodeCitation(value: KnowledgeCitation): string {
  // encodeURIComponent leaves parentheses untouched, which breaks Markdown URLs.
  return encodeURIComponent(JSON.stringify(value)).replace(/[()']/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function parseCitation(raw: string): KnowledgeCitation | undefined {
  if (raw.length > 8000) return undefined
  try {
    const v = JSON.parse(raw) as KnowledgeCitation
    if (!v || typeof v !== 'object') return undefined
    for (const key of ['documentId', 'knowledgeBaseId', 'sessionId', 'title'] as const) {
      if (typeof v[key] !== 'string' || !v[key].trim() || v[key].length > 256) return undefined
    }
    if (typeof v.sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceKey)) return undefined
    if (v.projectId !== undefined && (typeof v.projectId !== 'string' || v.projectId.length > 4096)) return undefined
    if (!Number.isSafeInteger(v.version) || v.version < 1 || !Number.isSafeInteger(v.startLine) || v.startLine < 1
      || !Number.isSafeInteger(v.endLine) || v.endLine < v.startLine || v.endLine > 1_000_000) return undefined
    return { documentId: v.documentId, knowledgeBaseId: v.knowledgeBaseId, sessionId: v.sessionId,
      sourceKey: v.sourceKey, title: v.title, version: v.version, startLine: v.startLine, endLine: v.endLine,
      ...(v.projectId === undefined ? {} : { projectId: v.projectId }) }
  } catch { return undefined }
}

export function citationFromHref(href: string, origin: string): KnowledgeCitation | undefined {
  try {
    const url = new URL(href, origin)
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith(CITATION_PREFIX) || url.search || url.hash) return undefined
    return parseCitation(decodeURIComponent(url.pathname.slice(CITATION_PREFIX.length)))
  } catch { return undefined }
}

/** The official Markdown file-link button exposes its already-decoded path. */
export function citationFromFilePath(path: string): KnowledgeCitation | undefined {
  return path.startsWith(CITATION_PREFIX) ? parseCitation(path.slice(CITATION_PREFIX.length)) : undefined
}

export function citationMarkdown(value: KnowledgeCitation): string {
  const label = `${value.title} · 第 ${value.startLine}–${value.endLine} 行`.replace(/[\\\[\]`<>\r\n]/g, ' ')
  return `[${label}](${CITATION_PREFIX}${encodeCitation(value)})`
}
