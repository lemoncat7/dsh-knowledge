import { randomUUID } from 'node:crypto'
import type { KnowledgeScope } from '../domain.js'
import type { FrontMatterSalvage } from './markdown.js'

export type WikiProvenance =
  | { kind: 'import'; originalPath: string }
  | { kind: 'manual'; actor: string }
  | { kind: 'conversation'; sessionId: string; turn: number; messageId?: string; /** Document referenced by the saved conversation piece, kept for traceability. */ sourcePath?: string }
  | { kind: 'distill'; sourceId: string; sourceSha256: string }

export interface WikiPage {
  kbId: string
  pageId: string
  entryId: string
  relPath: string
  scope: KnowledgeScope
  provenance: WikiProvenance
  version: number
  status: 'active' | 'archived'
  fileSha256: string | null
  lastOperation?: string
  /** Set when the original bytes are only readable through the restricted front-matter salvage. The file itself is never rewritten. */
  metadataRepair?: FrontMatterSalvage
}
export interface WikiManifest { format: 1; kbId: string; pages: WikiPage[] }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WIKI_METADATA_INVALID')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('WIKI_METADATA_INVALID')
  return value
}
export function validateWikiRelativePath(value: unknown): string {
  const path = text(value)
  if (path.includes('\\') || path.startsWith('/') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('WIKI_PATH_UNSAFE')
  }
  return path
}
function metadataRepairOf(value: unknown): FrontMatterSalvage | undefined {
  if (value === undefined) return undefined
  const repair = record(value)
  if (repair.kind !== 'quoted-scalars' || !Array.isArray(repair.fields) || !Array.isArray(repair.lines)) throw new Error('WIKI_METADATA_INVALID')
  return { kind: 'quoted-scalars', fields: repair.fields.map(field => text(field)),
    lines: repair.lines.map(line => { if (!Number.isSafeInteger(line) || Number(line) < 1) throw new Error('WIKI_METADATA_INVALID'); return Number(line) }) }
}
function scopeOf(value: unknown): KnowledgeScope {
  const scope = record(value)
  if (scope.kind === 'global' && scope.id === undefined) return { kind: 'global' }
  if (scope.kind === 'project') return { kind: 'project', id: text(scope.id) }
  throw new Error('WIKI_SCOPE_UNKNOWN')
}
function provenanceOf(value: unknown): WikiProvenance {
  const p = record(value)
  switch (p.kind) {
    case 'import': return { kind: 'import', originalPath: text(p.originalPath) }
    case 'manual': return { kind: 'manual', actor: text(p.actor) }
    case 'distill': {
      const hash = text(p.sourceSha256)
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('WIKI_SOURCE_HASH_INVALID')
      return { kind: 'distill', sourceId: text(p.sourceId), sourceSha256: hash }
    }
    case 'conversation': {
      if (!Number.isSafeInteger(p.turn) || Number(p.turn) < 0) throw new Error('WIKI_PROVENANCE_INVALID')
      return { kind: 'conversation', sessionId: text(p.sessionId), turn: Number(p.turn),
        ...(p.messageId === undefined ? {} : { messageId: text(p.messageId) }),
        ...(p.sourcePath === undefined ? {} : { sourcePath: text(p.sourcePath) }) }
    }
    default: throw new Error('WIKI_PROVENANCE_UNKNOWN')
  }
}
export function createWikiPage(kbId: string, relPath: string, scope: KnowledgeScope, provenance: WikiProvenance): WikiPage {
  return {
    kbId: text(kbId), pageId: randomUUID(), entryId: randomUUID(),
    relPath: validateWikiRelativePath(relPath), scope: scopeOf(scope), provenance: provenanceOf(provenance),
    version: 1, status: 'active', fileSha256: null,
  }
}
export function validateWikiManifest(value: unknown): WikiManifest {
  const manifest = record(value)
  if (manifest.format !== 1 || !Array.isArray(manifest.pages)) throw new Error('WIKI_MANIFEST_INVALID')
  const kbId = text(manifest.kbId)
  const pageIds = new Set<string>(), entryIds = new Set<string>(), paths = new Set<string>()
  const pages = manifest.pages.map((value: unknown): WikiPage => {
    const p = record(value)
    const pageId = text(p.pageId), entryId = text(p.entryId), relPath = validateWikiRelativePath(p.relPath)
    if (p.kbId !== kbId || !/^[a-f0-9-]{36}$/.test(pageId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entryId)
      || pageIds.has(pageId) || entryIds.has(entryId) || paths.has(relPath.toLowerCase())
      || !Number.isSafeInteger(p.version) || Number(p.version) < 1
      || !['active', 'archived'].includes(String(p.status))
      || (p.fileSha256 !== null && (typeof p.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.fileSha256)))) {
      throw new Error('WIKI_MANIFEST_INVALID_OR_DUPLICATE')
    }
    pageIds.add(pageId); entryIds.add(entryId); paths.add(relPath.toLowerCase())
    return { kbId, pageId, entryId, relPath, scope: scopeOf(p.scope), provenance: provenanceOf(p.provenance),
      version: Number(p.version), status: p.status as WikiPage['status'], fileSha256: p.fileSha256 as string | null,
      ...(p.lastOperation === undefined ? {} : { lastOperation: text(p.lastOperation) }),
      ...(p.metadataRepair === undefined ? {} : { metadataRepair: metadataRepairOf(p.metadataRepair)! }) }
  })
  return { format: 1, kbId, pages }
}
export function wikiStorageKey(page: Pick<WikiPage, 'kbId' | 'pageId'>): string {
  return `wiki:${page.kbId}:${page.pageId}`
}
