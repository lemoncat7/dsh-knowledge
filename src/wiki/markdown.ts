import { parseDocument, stringify } from 'yaml'
import type { KnowledgeScope } from '../domain.js'

function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
const known = new Set(['id', 'title', 'type', 'tags', 'keywords', 'author', 'created', 'updated', 'sources', 'scope', 'provenance', 'status'])
export interface ParsedWikiMarkdown {
  original: Uint8Array; newline: '\n' | '\r\n'; bom: boolean; hasFrontMatter: boolean
  yaml: string; body: string; title: string; tags: string[]; type?: string; id?: string
  scope?: KnowledgeScope; provenance?: string
  frontMatter: { values: Record<string, unknown>; unknown: Record<string, unknown> }
}
function validateMetadata(values: Record<string, unknown>): void {
  const scope = values.scope
  if (scope !== undefined) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('UNKNOWN_SCOPE')
    const s = scope as Record<string, unknown>
    if (!(s.kind === 'global' && s.id === undefined) && !(s.kind === 'project' && typeof s.id === 'string' && s.id.trim())) fail('UNKNOWN_SCOPE')
  }
  if (values.provenance !== undefined && !['file', 'import', 'manual', 'conversation', 'distill'].includes(String(values.provenance))) fail('UNKNOWN_PROVENANCE')
  if (values.status !== undefined && !['active', 'archived'].includes(String(values.status))) fail('INVALID_ARGUMENT')
}
export function parseWikiMarkdown(input: Uint8Array): ParsedWikiMarkdown {
  const original = Uint8Array.from(input)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input) } catch { return fail('INVALID_MARKDOWN') }
  const bom = text.startsWith('\uFEFF')
  if (bom) text = text.slice(1)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let yaml = '', body = text, values: Record<string, unknown> = {}, hasFrontMatter = false
  if (/^---\r?\n/.test(text)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    if (!match) fail('INVALID_MARKDOWN')
    yaml = match[1]!
    const doc = parseDocument(yaml, { uniqueKeys: true })
    if (doc.errors.length) fail('INVALID_MARKDOWN')
    const value: unknown = doc.toJS()
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_MARKDOWN')
    values = value as Record<string, unknown>
    body = text.slice(match[0].length); hasFrontMatter = true
  }
  validateMetadata(values)
  const title = typeof values.title === 'string' ? values.title : /^#\s+(.+)\r?$/m.exec(body)?.[1]?.trim() ?? ''
  return { original, newline, bom, hasFrontMatter, yaml, body, title,
    tags: Array.isArray(values.tags) ? values.tags.filter((v): v is string => typeof v === 'string') : [],
    ...(typeof values.type === 'string' ? { type: values.type } : {}),
    ...(typeof values.id === 'string' ? { id: values.id } : {}),
    ...(values.scope === undefined ? {} : { scope: values.scope as KnowledgeScope }),
    ...(values.provenance === undefined ? {} : { provenance: String(values.provenance) }),
    frontMatter: { values, unknown: Object.fromEntries(Object.entries(values).filter(([key]) => !known.has(key))) } }
}
export function serializeWikiMarkdown(parsed: ParsedWikiMarkdown): Uint8Array { return Uint8Array.from(parsed.original) }
export function updateWikiFrontMatter(parsed: ParsedWikiMarkdown, patch: Record<string, unknown>): Uint8Array {
  validateMetadata({ ...parsed.frontMatter.values, ...patch })
  const doc = parseDocument(parsed.yaml)
  for (const [key, value] of Object.entries(patch)) doc.set(key, value)
  const yaml = doc.toString().replace(/\r?\n/g, parsed.newline)
  return Buffer.from(`${parsed.bom ? '\uFEFF' : ''}---${parsed.newline}${yaml}---${parsed.newline}${parsed.hasFrontMatter ? '' : parsed.newline}${parsed.body}`, 'utf8')
}
export function renderWikiPage(input: { title: string; body: string; frontMatter: Record<string, unknown> }): Uint8Array {
  if (!input.title.trim() || /[\r\n]/.test(input.title) || !input.body.trim()) fail('INVALID_ARGUMENT')
  validateMetadata(input.frontMatter)
  return Buffer.from(`---\n${stringify({ ...input.frontMatter, title: input.title })}---\n\n# ${input.title}\n\n${input.body}`)
}
