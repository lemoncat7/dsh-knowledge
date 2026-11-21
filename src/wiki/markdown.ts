import { parseDocument, stringify } from 'yaml'
import type { KnowledgeScope } from '../domain.js'

function fail(code: string, detail?: string): never {
  throw Object.assign(new Error(code), detail === undefined ? { code } : { code, detail })
}
const known = new Set(['id', 'title', 'type', 'tags', 'keywords', 'author', 'created', 'updated', 'sources', 'scope', 'provenance', 'status'])
/** Deterministic record of the restricted front-matter salvage that made a legacy page readable. Never implies a file rewrite. */
export interface FrontMatterSalvage { kind: 'quoted-scalars'; fields: string[]; lines: number[] }
export interface SalvagedFrontMatter { yaml: string; salvage: FrontMatterSalvage }
export interface ParsedWikiMarkdown {
  original: Uint8Array; newline: '\n' | '\r\n'; bom: boolean; hasFrontMatter: boolean
  yaml: string; body: string; title: string; tags: string[]; type?: string; id?: string
  scope?: KnowledgeScope; provenance?: string
  /** Present only when strict YAML failed and restricted scalar quoting produced a valid document. */
  salvage?: FrontMatterSalvage
  frontMatter: { values: Record<string, unknown>; unknown: Record<string, unknown> }
}
// A value that already starts with a YAML indicator is never a plain scalar we may quote.
const indicators = new Set(['"', "'", '[', ']', '{', '}', '|', '>', '*', '&', '!', '%', '@', '`', '#', ',', '?'])
const windowsPath = /^[A-Za-z]:[\\/]/u
const nestedEntry = /^[^ \t#][^:]*?:[ \t]/u
/**
 * Restricted: only plain scalars whose text would otherwise carry YAML structure are quoted —
 * a drive-letter path (`key: C:\...`, `- C:\...`) or a value containing `: `.
 * Comments, quoted strings, flow collections, block scalars and list items that are nested mappings are left alone.
 */
function needsQuotes(value: string, sequenceItem: boolean): boolean {
  if (!value || indicators.has(value[0]!)) return false
  if (/[ \t]#/u.test(value)) return false
  if (sequenceItem && nestedEntry.test(value)) return false
  return windowsPath.test(value) || /:[ \t]/u.test(value)
}
function quote(value: string): string { return `'${value.replaceAll("'", "''")}'` }
export function salvageFrontMatterScalars(yaml: string): SalvagedFrontMatter | undefined {
  const output: string[] = [], fields: string[] = [], lines: number[] = []
  let blockIndent: number | undefined
  for (const [index, raw] of yaml.split('\n').entries()) {
    const carriage = raw.endsWith('\r') ? '\r' : ''
    const line = carriage ? raw.slice(0, -1) : raw
    const indent = /^[ \t]*/u.exec(line)![0].length
    if (blockIndent !== undefined) {
      if (!line.trim() || indent > blockIndent) { output.push(raw); continue }
      blockIndent = undefined
    }
    const entry = /^([ \t]*)([^ \t#:][^:]*?)[ \t]*:[ \t]+(\S.*?)[ \t]*$/u.exec(line)
    const item = entry ? undefined : /^([ \t]*)(-[ \t]+)(\S.*?)[ \t]*$/u.exec(line)
    const value = entry ? entry[3]! : item?.[3]
    if (value !== undefined && needsQuotes(value, entry === null)) {
      const quoted = quote(value)
      output.push(entry ? `${entry[1]}${entry[2]}: ${quoted}${carriage}` : `${item![1]}${item![2]}${quoted}${carriage}`)
      if (entry) fields.push(entry[2]!.trim())
      lines.push(index + 1)
      continue
    }
    if (/^[ \t]*[^ \t#][^:]*:[ \t]*[|>][+-]?[ \t]*$/u.test(line)) blockIndent = indent
    output.push(raw)
  }
  if (!lines.length) return undefined
  return { yaml: output.join('\n'), salvage: { kind: 'quoted-scalars', fields: [...new Set(fields)], lines } }
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
function frontMatterDocument(yaml: string): { document: ReturnType<typeof parseDocument>; salvage?: FrontMatterSalvage } {
  const document = parseDocument(yaml, { uniqueKeys: true })
  if (!document.errors.length) return { document }
  const repaired = salvageFrontMatterScalars(yaml)
  if (!repaired) return { document }
  const retry = parseDocument(repaired.yaml, { uniqueKeys: true })
  return retry.errors.length ? { document } : { document: retry, salvage: repaired.salvage }
}
export function parseWikiMarkdown(input: Uint8Array): ParsedWikiMarkdown {
  const original = Uint8Array.from(input)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input) } catch { return fail('INVALID_MARKDOWN', '文件不是 UTF-8 文本') }
  const bom = text.startsWith('\uFEFF')
  if (bom) text = text.slice(1)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let yaml = '', body = text, values: Record<string, unknown> = {}, hasFrontMatter = false, salvage: FrontMatterSalvage | undefined
  if (/^---\r?\n/.test(text)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    if (!match) fail('INVALID_MARKDOWN', 'front matter 缺少结束的 --- 行')
    yaml = match[1]!
    const parsed = frontMatterDocument(yaml)
    if (parsed.document.errors.length) fail('INVALID_MARKDOWN', `YAML 解析错误 ${[...new Set(parsed.document.errors.map(error => error.code))].join('、')}`)
    const value: unknown = parsed.document.toJS()
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_MARKDOWN', 'front matter 顶层不是键值映射')
    values = value as Record<string, unknown>
    if (parsed.salvage !== undefined) salvage = parsed.salvage
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
    ...(salvage === undefined ? {} : { salvage }),
    frontMatter: { values, unknown: Object.fromEntries(Object.entries(values).filter(([key]) => !known.has(key))) } }
}
export function serializeWikiMarkdown(parsed: ParsedWikiMarkdown): Uint8Array { return Uint8Array.from(parsed.original) }
export function updateWikiFrontMatter(parsed: ParsedWikiMarkdown, patch: Record<string, unknown>): Uint8Array {
  validateMetadata({ ...parsed.frontMatter.values, ...patch })
  let doc = parseDocument(parsed.yaml)
  if (doc.errors.length) {
    // Legacy front matter is only read through the same restricted salvage; a real edit must start from a valid document.
    const repaired = salvageFrontMatterScalars(parsed.yaml)
    if (repaired) doc = parseDocument(repaired.yaml)
    if (doc.errors.length) fail('INVALID_MARKDOWN', 'front matter 不是合法 YAML，无法更新元数据')
  }
  for (const [key, value] of Object.entries(patch)) doc.set(key, value)
  const yaml = doc.toString().replace(/\r?\n/g, parsed.newline)
  return Buffer.from(`${parsed.bom ? '\uFEFF' : ''}---${parsed.newline}${yaml}---${parsed.newline}${parsed.hasFrontMatter ? '' : parsed.newline}${parsed.body}`, 'utf8')
}
export function renderWikiPage(input: { title: string; body: string; frontMatter: Record<string, unknown> }): Uint8Array {
  if (!input.title.trim() || /[\r\n]/.test(input.title) || !input.body.trim()) fail('INVALID_ARGUMENT')
  validateMetadata(input.frontMatter)
  return Buffer.from(`---\n${stringify({ ...input.frontMatter, title: input.title })}---\n\n# ${input.title}\n\n${input.body}`)
}
