import { createHash } from 'node:crypto'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  isKnowledgeType,
  normalizeTags,
  type KnowledgeScope,
  type KnowledgeStatus,
  type KnowledgeType,
} from '../domain.js'

const FRONT_MATTER_BOUNDARY = '---'

export interface MarkdownDocumentMetadata {
  id: string
  type: KnowledgeType
  tags: string[]
  scope: KnowledgeScope
  confidence: number
  status: KnowledgeStatus
}

export interface ParsedMarkdownDocument {
  metadata: MarkdownDocumentMetadata
  title: string
  body: string
  markdown: string
  contentHash: string
}

/** Parse the constrained, portable front matter used by managed knowledge files. */
export function parseKnowledgeMarkdown(markdown: string): ParsedMarkdownDocument {
  const normalized = normalizeLineEndings(markdown)
  if (!normalized.startsWith(`${FRONT_MATTER_BOUNDARY}\n`)) {
    throw new Error('knowledge document is missing YAML front matter')
  }
  const end = normalized.indexOf(`\n${FRONT_MATTER_BOUNDARY}\n`, FRONT_MATTER_BOUNDARY.length + 1)
  if (end < 0) throw new Error('knowledge document front matter is not closed')
  const raw = parseYaml(normalized.slice(FRONT_MATTER_BOUNDARY.length + 1, end)) as unknown
  if (!isRecord(raw)) throw new Error('knowledge document front matter must be an object')
  const id = requireString(raw.id, 'id', 200)
  if (!isKnowledgeType(raw.type)) throw new Error('knowledge document type is invalid')
  const tags = normalizeTags(Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [])
  const scope = parseScope(raw.scope)
  const confidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence
    : 0.8
  const status = raw.status === 'archived' ? 'archived' : 'active'
  const bodyWithHeading = normalized.slice(end + `\n${FRONT_MATTER_BOUNDARY}\n`.length).trim()
  const heading = bodyWithHeading.match(/^#\s+(.+)$/mu)
  if (heading === null) throw new Error('knowledge document must contain a level-one title')
  const title = heading[1]?.trim() ?? ''
  if (title.length === 0 || title.length > 200) throw new Error('knowledge document title must contain 1-200 characters')
  const headingEnd = bodyWithHeading.indexOf('\n', heading.index)
  const body = (headingEnd < 0 ? '' : bodyWithHeading.slice(headingEnd + 1)).trim()
  if (body.length === 0) throw new Error('knowledge document body cannot be empty')
  return {
    metadata: { id, type: raw.type, tags, scope, confidence, status },
    title,
    body,
    markdown: normalized.endsWith('\n') ? normalized : `${normalized}\n`,
    contentHash: markdownHash(normalized),
  }
}

/** Render deterministic Markdown so hashes and external diffs stay stable. */
export function renderKnowledgeMarkdown(input: {
  metadata: MarkdownDocumentMetadata
  title: string
  body: string
}): string {
  const frontMatter = stringifyYaml({
    id: input.metadata.id,
    type: input.metadata.type,
    tags: normalizeTags(input.metadata.tags),
    scope: input.metadata.scope,
    confidence: Number(input.metadata.confidence.toFixed(3)),
    status: input.metadata.status,
  }, { lineWidth: 0 }).trim()
  return `${FRONT_MATTER_BOUNDARY}\n${frontMatter}\n${FRONT_MATTER_BOUNDARY}\n\n# ${input.title.trim()}\n\n${input.body.trim()}\n`
}

export function renderKnowledgeBaseManifest(input: {
  id: string
  name: string
  description: string
  defaultTags: string[]
  extractionInstructions: string
}): string {
  return stringifyYaml({
    id: input.id,
    name: input.name,
    description: input.description,
    defaultTags: normalizeTags(input.defaultTags),
    extractionInstructions: input.extractionInstructions,
  }, { lineWidth: 0 })
}

export function markdownHash(value: string): string {
  return createHash('sha256').update(normalizeLineEndings(value)).digest('hex')
}

function parseScope(value: unknown): KnowledgeScope {
  if (!isRecord(value) || (value.kind !== 'global' && value.kind !== 'project')) {
    throw new Error('knowledge document scope is invalid')
  }
  if (value.kind === 'global') return { kind: 'global' }
  return { kind: 'project', id: requireString(value.id, 'scope.id', 2000) }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${name} must contain at most ${maxLength} characters`)
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
